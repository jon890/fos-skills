// worker 에게 답이나 후속 지시를 보낸다. Orca 가 메시지마다 worker 를 깨우므로 터미널에 입력하지 않는다.
// 활성 dispatch 는 미답변 질문에 reply 하고, 답할 후보가 없거나 --no-reply 면 send 한다.
// answer_conflict/dispatch_inactive 는 닫은 질문으로 기록한다. consumer_fenced 는 --from 없이 재시도한다.
// stable_pane_required 는 plain reply, question 의 status answer 차례로 시도한다.
// 끝난 dispatch 의 질문에 답만 달면 0 이다. --spec 이 있으면 허락/worker 선택을 검사한 한 줄 지시를 send 한다.
// follow_up/reopened 영수증은 새 Task/dispatch 와 새 worker-show 의 터미널로 띄우기 기록을 남긴다.
// 실행 설정은 새 dispatch 의 실제 값, 앞 기록 순으로 물려받고 보드와 worker-launched 이벤트도 갱신한다.
// delivered 영수증은 새 Task 없이 전달된 것으로 0 이다. 다른 불완전 영수증은 전송 사실과 값을 알리고 5 다.
// 새 터미널 조회나 기록 쓰기 실패는 경고만 내며 이미 전달된 일을 다시 띄우지 않는다.
// send 거절 때만 launch-worker 로 내려간다. 재사용 터미널의 agent_unconfigured 는 소유 확인 뒤 새 터미널로 복구한다.
// --spec 없이 끝난 dispatch 에 보내는 본문은 질문 답이 아니면 작업 중인 화면에만 send 한다.
// 이 경로는 후속 Task 가 되지만 지시서가 없어 띄우기 기록을 남기지 못한다는 경고를 stderr 에 낸다.
//
// 사용법: send-to-worker.ts --dispatch ID (--body TEXT | --body-file FILE) [--reply-to MSG | --no-reply] [--spec FILE] [--run RUN]
//         send-to-worker.ts --dispatch ENDED_ID --spec FILE [--run RUN] [--agent A --model M --effort E]
// --spec 은 끝난 dispatch 의 후속 지시서다. 본문이 함께 있으면 질문 답으로 먼저 쓰고 나머지는 무시한다.
// --agent/--model/--effort 는 send 거절 뒤 새로 띄우는 복구 경로에서만 실행 설정을 바꾼다.
// ORCA, LAUNCH_WORKER 환경 변수로 실행 파일을 바꾼다. --full 조회는 lib/orca.ts 가 붙인다.
// 짧은 출력은 REPLIED, SENT, DELIVERED, FOLLOW-UP <앞 dispatch> <새 dispatch> <새 Task>,
// RESUMED, RESTARTED, ENDED, NOTE, FAIL 이다. 복구 자식에는 짧은 출력 신호를 넘긴다.
// 종료 코드: 0 전달됨, 1 다시 띄우기 실패, 2 사용법/지시서 오류, 3 끝나서 보낼 수 없음, 5 Orca/영수증 오류.

import { orcaJsonOrThrow, closeTerminal } from '../lib/orca.ts'
import { objectOr } from '../core/json.ts'
import { readFileSync } from 'node:fs'
import { real } from '../lib/fs.ts'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { context } from '../lib/completion.ts'
import { emit, oneLine, shortEnv } from '../lib/output.ts'
import type { Rule } from '../lib/output.ts'
import { runInherit, scriptCommand } from '../lib/proc.ts'
import { pyStr, shQuote } from '../lib/py.ts'
import { dismissQuestion } from '../lib/questions.ts'
import { scriptPath } from '../lib/commands.ts'
import { classify, screenLines } from '../lib/screen.ts'
import { branchesOf, permissionsOf, selectionsOf } from '../lib/spec.ts'
import { selectionVerdict } from '../lib/selection.ts'
import { readLaunch, recordLaunch } from '../lib/launched.ts'
import type { Effective } from '../lib/launched.ts'
import { recordHistory } from '../lib/launch-history.ts'
import { registerBoard } from '../lib/board.ts'
import { fire } from '../lib/events.ts'
import { defaultBase } from '../lib/git.ts'
import { senderOf, threadOf } from '../core/message-fields.ts'

const USAGE = [
  '사용법: send-to-worker.ts --dispatch ID (--body TEXT | --body-file FILE) [--reply-to MSG_ID | --no-reply] [--spec FILE] [--run RUN]',
  '        send-to-worker.ts --dispatch ENDED_ID --spec FILE [--run RUN] [--agent A --model M --effort E]',
].join('\n')
const LAUNCH_WORKER = process.env.LAUNCH_WORKER || scriptPath('launch-worker')
// 이 상태의 dispatch 는 reply 를 받는다. 나머지(completed, failed 같은 것)는 끝난 것이다
const ACTIVE = new Set(['pending', 'dispatched', 'running'])
// 이미 답한 question 에 다시 reply 하면 orca 가 이 문구로 거부한다
const ANSWERED = 'already has a different answer'
// 답할 수 없는 질문의 거절 코드. 이 코드로 거절된 메시지는 닫은 질문으로 적는다(lib/questions.ts 의 「닫은 질문」)
const ANSWER_CONFLICT = 'answer_conflict'
const INACTIVE = 'dispatch_inactive'
// Orca 터미널 안에서 `--from run:<run>` 을 붙이면 orca 가 이 코드로 거부한다
const FENCED = 'consumer_fenced'
// 코디네이터 터미널의 pane 신원이 없을 때 reply 가 이 코드나 문구로 거부된다
const NO_PANE = ['stable_pane_required', 'no stable pane identity']
// 끝난 dispatch 에서 답할 후보로 보는 메시지 종류
const ASKS = new Set(['question', 'escalation'])
// 새 메시지 제목에 쓰는 본문 첫 줄의 최대 글자 수
const SUBJECT_MAX = 120
// launch-worker 는 make-worktree 와 worker-start 를 각각 10분까지 기다린다. 시작 확인 시간 초과는 STALLED-START 와 1 로 알리고 재시도하지 않는다
const LAUNCH_MS = 3_600_000
const SETTING_KEYS = ['agent', 'model', 'effort'] as const
// 사람에게 다시 띄우라고 안내하는 명령. 실행 규칙의 꼴(node 와 경고 끄기, 절대경로)로 낸다
const LAUNCH_HINT = `node --disable-warning=ExperimentalWarning ${shQuote(scriptPath('launch-worker'))}`

type Json = Record<string, unknown>
type Settings = Record<string, unknown>

class OrcaFailed extends Error {
  rejected: boolean
  constructor(message: string, rejected = false) {
    super(message)
    this.rejected = rejected
  }
}

// 짧은 출력(진입점의 orch worker send)의 줄 규칙. docs/features/orch-cli/design.md 「짧은 출력 (PR2)」 의 worker send 행이다
const SHORT_RULES: Rule[] = [
  [/^replied: (\S+) 에 답했다 \((\S+)\)\. 끝난 dispatch 라 깨우지 않았다/, (m) => `REPLIED ${m[1]} ${m[2] === 'None' ? '-' : m[2]} no-wake`],
  [/^replied: (\S+) 에 답했다 \((\S+)\)/, (m) => `REPLIED ${m[1]} ${m[2] === 'None' ? '-' : m[2]}`],
  [/^sent: .* dispatch:(\S+) 에 새 메시지로 보냈다 \((\S+)\)/, (m) => `SENT ${m[1]} ${m[2] === 'None' ? '-' : m[2]}`],
  [/^delivered: .*Orca 가 (\S+) 로 깨운다/, (m) => `DELIVERED ${m[1]}`],
  [/^relaunch: 끝난 (\S+) 의 터미널 (\S+) 에/, (m) => `RESUMED ${m[1]} ${m[2]}`],
  [/^restart: (\S+) 을 닫고/, (m) => `RESTARTED ${m[1]}`],
  [/^ended: (\S+) 가 끝났(고|다)\(([^)]*)\)/, (m) => `ENDED ${m[1]} ${m[3]}${m[2] === '고' ? ' no-terminal' : ''}`],
  [/^(?:closed|retry|fallback|skipped|warning|note): (.*)/, (m) => `NOTE ${oneLine(m[1])}`],
  [/^send-to-worker: (.*)/, (m) => `FAIL ${oneLine(m[1])}`],
]

function out(line: string): void {
  emit(line, SHORT_RULES)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(value => objectOr(value)) : []
}
function workerOrcaJson(args: string[]): Json {
  return orcaJsonOrThrow(args, { failure: (message, structured) => new OrcaFailed(message, structured) })
}

type Described = { status: unknown; handle: string; worktree: string; runId: string; settings: Settings }

function describe(dispatchId: string): Described {
  const shown = workerOrcaJson(['orchestration', 'worker-show', '--dispatch', dispatchId])
  const dispatch = objectOr(shown.dispatch)
  const worker = objectOr(shown.worker)
  const worktreeId = String(worker.worktreeId || '')
  const worktree = worktreeId.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : worktreeId
  const handle = String(worker.agentTerminalHandle || dispatch.assigneeHandle || '')
  const options = objectOr(worker.startOptions)
  const launch = objectOr(options.launch)
  const settings: Settings = {}
  Object.assign(settings, objectOr(launch.requested))
  for (const [key, value] of Object.entries(objectOr(launch.effective))) if (value) settings[key] = value
  if (!settings.agent) settings.agent = options.agent
  return { status: dispatch.status, handle, worktree, runId: String(dispatch.runId || ''), settings }
}

// reply 할 후보 메시지 id. 앞이 우선이다. heartbeat 는 뒤로 미루고, 답이 보이는 question 은 뺀다.
function candidates(dispatchId: string, handle: string, kinds?: Set<string>, run?: string): string[] {
  // 질문은 status/heartbeat 에 밀리지 않게 따로 읽는다. 전역 inbox 를 읽지 않는다.
  const history = run ? [
    ...rows(workerOrcaJson(['orchestration', 'check', '--run', run, '--all']).messages),
    ...rows(workerOrcaJson(['orchestration', 'check', '--run', run, '--all', '--types', 'question,escalation']).messages),
    ...rows(workerOrcaJson(['orchestration', 'check', '--run', run, '--peek', '--types', 'question,escalation']).messages),
  ] : rows(workerOrcaJson(['orchestration', 'inbox', '--limit', '200']).messages)
  const replies = [...new Set([`dispatch:${dispatchId}`, handle].filter(Boolean))].flatMap((terminal) =>
    rows(workerOrcaJson(['orchestration', 'inbox', '--terminal', terminal, '--limit', '200']).messages))
  const messages = [...new Map([...history, ...replies].filter((m) => !run || !m.run_id || m.run_id === run).map((m) => [m.id, m])).values()]
  const fromWorker = (row: Json) => senderOf(row) === `dispatch:${dispatchId}` || (!!handle && senderOf(row) === handle)
  // 같은 thread 에 worker 가 아닌 쪽이 쓴 글이 있으면 그 question 은 이미 답했다
  const answered = new Set(messages.filter((r) => threadOf(r) && !fromWorker(r) && threadOf(r) !== r.id).map((r) => threadOf(r)))
  const mine = messages.filter((row) => {
    const owner = context(row)[1]
    // 터미널은 새 dispatch 가 이어 쓸 수 있다. 명시된 이전 dispatch 의 질문에는 답하지 않는다.
    if (owner && owner !== dispatchId) return false
    if (!fromWorker(row) && owner !== dispatchId) return false
    if (senderOf(row).startsWith('run:')) return false
    if (kinds && !kinds.has(String(row.type))) return false
    return true
  })
  // 미답변 질문을 먼저, 그다음 status, 마지막 heartbeat 순서다.
  const rank = (row: Json) => [ASKS.has(String(row.type)) ? 2 : row.type !== 'heartbeat' ? 1 : 0, Number(row.sequence) || 0]
  mine.sort((a, b) => {
    const [ka, sa] = rank(a)
    const [kb, sb] = rank(b)
    return ka - kb || String(a.created_at || '').localeCompare(String(b.created_at || '')) || sa - sb
  })
  const latestAnswer = mine.findLastIndex((row) => ASKS.has(String(row.type)) && answered.has(row.id))
  return mine.filter((row, index) => !ASKS.has(String(row.type)) || (!answered.has(row.id) && index > latestAnswer))
    .reverse().map((row) => String(row.id))
}

function liveHandles(): Set<string> {
  return new Set(rows(workerOrcaJson(['terminal', 'list']).terminals).map((t) => String(t.handle || '')).filter(Boolean))
}

// `--from run:<run>` 을 붙여 보내고, consumer_fenced 로 거부되면 빼고 한 번 다시 보낸다. 보낸 메시지 id 를 낸다
function sendAsResult(base: string[], run: string): Json {
  let result: Json
  try {
    result = workerOrcaJson([...base, ...(run ? ['--from', `run:${run}`] : [])])
  } catch (e) {
    if (!run || !(e instanceof OrcaFailed) || !e.message.includes(FENCED)) throw e
    out(`retry: --from run:${run} 이 ${FENCED} 로 거부돼 --from 없이 다시 보낸다`)
    result = workerOrcaJson(base)
  }
  return result
}

function sendAs(base: string[], run: string): string {
  const result = sendAsResult(base, run)
  return String(objectOr(result.message).id || result.messageId || result.id || '')
}

// inbox 에서 본 그 메시지의 종류. 못 찾으면 빈 문자열이다
function typeOf(msgId: string, run: string): string {
  const args = run ? ['orchestration', 'check', '--run', run, '--all', '--types', 'question,escalation'] : ['orchestration', 'inbox', '--limit', '200']
  const row = rows(workerOrcaJson(args).messages).find((m) => m.id === msgId)
  return String(row?.type ?? '')
}

// 제목은 `answer: ` 와 본문 첫 줄이다. worker-ask 는 제목이 아니라 본문을 답으로 읽는다
function answerSubject(body: string): string {
  const first = Array.from(body.split('\n')[0].trim()).slice(0, SUBJECT_MAX).join('')
  return `answer: ${first}`
}

function reply(msgId: string, body: string, run: string, dispatchId: string): string {
  try {
    return sendAs(['orchestration', 'reply', '--id', msgId, '--body', body, ...(run ? ['--run', run] : [])], run)
  } catch (e) {
    const noPane = (failure: unknown) => failure instanceof OrcaFailed && NO_PANE.some((text) => failure.message.includes(text))
    if (!noPane(e)) throw e
    // `--run` 과 `--from` 을 뺀 plain reply 는 같은 터미널에서도 받아들여진다(2026-11-02 실측). 질문이 바로 닫힌다
    if (run) {
      try {
        const result = workerOrcaJson(['orchestration', 'reply', '--id', msgId, '--body', body])
        out(`retry: reply 가 ${NO_PANE[0]} 로 거부돼 --run 과 --from 없이 다시 보냈다`)
        return String(objectOr(result.message).id || result.messageId || result.id || '')
      } catch (plain) {
        if (!noPane(plain)) throw plain
      }
    }
    if (typeOf(msgId, run) !== 'question') throw e
    const base = [
      'orchestration',
      'send',
      ...(run ? ['--run', run] : []),
      '--type',
      'status',
      '--thread-id',
      msgId,
      '--to',
      `dispatch:${dispatchId}`,
      '--subject',
      answerSubject(body),
      '--body',
      body,
    ]
    const sent = sendAs(base, run)
    out(`fallback: reply 가 ${NO_PANE[0]} 로 거부돼 ${msgId} 스레드에 status answer 로 보냈다 (${sent || 'None'})`)
    return sent
  }
}

// reply 할 곳이 없을 때 그 dispatch 에 새 메시지로 보낸다. 제목은 본문 첫 줄이다
function sendNew(dispatchId: string, body: string, run: string): string {
  const subject = Array.from(body.split('\n')[0].trim()).slice(0, SUBJECT_MAX).join('') || '코디네이터 후속 지시'
  const base = ['orchestration', 'send', ...(run ? ['--run', run] : []), '--to', `dispatch:${dispatchId}`, '--subject', subject, '--body', body]
  return sendAs(base, run)
}

// 이미 답한 question 이면 다음 후보로 한 번만 더 시도한다. 답을 단 메시지 id 와 새 답의 id 를 낸다.
// 시도한 후보가 모두 이미 답한 question 이면 null 이다
// dispatch_inactive 로 거절되면 그 메시지를 닫은 질문으로 적고 null 이다. 같은 dispatch 의 다른 후보도 같은 이유로 거절된다
function replyFirst(targets: string[], body: string, run: string, dispatchId: string): { target: string; sent: string } | null {
  for (const [attempt, candidate] of targets.slice(0, 2).entries()) {
    try {
      return { target: candidate, sent: reply(candidate, body, run, dispatchId) }
    } catch (e) {
      if (!(e instanceof OrcaFailed)) throw e
      if (e.message.includes(INACTIVE)) {
        dismiss(candidate, INACTIVE)
        return null
      }
      if (!e.message.includes(ANSWERED) && !e.message.includes(ANSWER_CONFLICT)) throw e
      dismiss(candidate, ANSWER_CONFLICT)
      if (attempt === 1 || targets.length < 2) {
        out(`skipped: ${candidate} 는 이미 답한 question 이다`)
        return null
      }
      out(`skipped: ${candidate} 는 이미 답한 question 이라 다음 메시지에 답한다`)
    }
  }
  return null
}

// 답할 수 없는 메시지를 닫은 질문으로 적는다. 루프와 doctor 가 다시 알리지 않는다. 적지 못해도 보내기는 이어 간다
function dismiss(msgId: string, reason: string): void {
  try {
    dismissQuestion(msgId, reason)
    out(`closed: ${msgId} 는 ${reason} 로 답할 수 없어 닫은 질문으로 적었다. 루프가 다시 알리지 않는다`)
  } catch (e) {
    out(`send-to-worker: ${msgId} 를 닫은 질문으로 적지 못했다: ${(e as Error).message}`)
  }
}

// 자식의 출력을 그대로 흘리고 종료 코드를 낸다. 짧은 출력이면 자식도 짧은 출력이다(lib/output.ts 의 shortEnv)
async function passThrough(argv: string[], timeoutMs: number): Promise<number> {
  return (await runInherit(argv, { timeoutMs, env: shortEnv() })).code
}

// 후속 지시서는 새 Task 가 생기기 전에 검사한다. spec-line 과 같은 한 줄을 만든다.
function followUpSpec(file: string, repo: string): { text: string; line: string; title: string } {
  const text = readFileSync(file, 'utf8')
  const permissions = permissionsOf(text)
  const errors = selectionVerdict(text, repo, { launch: true, retry: true, continuation: false })
  if (!permissions.length) errors.unshift('지시서에 `허락:` 줄이 없다')
  if (errors.length) throw new Error(errors.join('; '))
  return {
    text,
    line: [`지시서 ${real(file)} 를 끝까지 읽고 수행한다.`, ...permissions, '못 읽으면 escalation 으로 알린다.'].join(' '),
    title: /^#\s+(.+)$/m.exec(text)?.[1] ?? '코디네이터 후속 지시',
  }
}

async function recordFollowUp(a: Args, prior: Described, run: string, receipt: Json, spec: ReturnType<typeof followUpSpec>): Promise<number> {
  if (receipt.delivery === 'delivered') {
    const sent = String(objectOr(receipt.message).id || receipt.messageId || receipt.id || '')
    out(`sent: 후속 Task 대신 dispatch:${a.dispatch} 에 새 메시지로 보냈다 (${sent || 'None'})`)
    out(`delivered: Orca 가 ${sent || a.dispatch} 로 깨운다. delivery=delivered 이므로 새 Task 기록은 남기지 않는다`)
    return 0
  }
  const dispatch = String(receipt.dispatchId || '')
  const task = String(receipt.taskId || '')
  if (!['follow_up', 'reopened'].includes(String(receipt.delivery)) || !dispatch || !task) {
    out(`note: 전송은 성공했지만 후속 Task 영수증을 확인하지 못했다: ${JSON.stringify({ delivery: receipt.delivery ?? null, dispatchId: dispatch, taskId: task })}. 중복 전송하지 말고 worker-show 로 확인한다`)
    return 5
  }
  const repo = prior.worktree || process.cwd()
  const inherited = readLaunch(repo, a.dispatch)
  const actual: Effective = { agent: null, model: null, effort: null }
  const apply = (settings: Json) => {
    for (const key of SETTING_KEYS) if (typeof settings[key] === 'string' && settings[key]) actual[key] = settings[key] as string
  }
  apply(prior.settings)
  apply(inherited ?? {})
  apply(objectOr(inherited?.effective))
  let terminal: string | null = null
  try {
    const shown = workerOrcaJson(['orchestration', 'worker-show', '--dispatch', dispatch])
    apply(objectOr(objectOr(objectOr(objectOr(shown.worker).startOptions).launch).effective))
    terminal = String(objectOr(shown.worker).agentTerminalHandle || objectOr(shown.resource).terminalHandle || objectOr(objectOr(shown.worker).resource).terminalHandle || '') || null
    if (!terminal) throw new Error('새 터미널 handle 이 없다')
  } catch (e) {
    err(`send-to-worker: 새 dispatch ${dispatch} 의 터미널을 읽지 못해 빈 값으로 기록한다: ${(e as Error).message}`)
  }
  const choice = selectionsOf(spec.text)[0]
  if (SETTING_KEYS.some((key) => actual[key] && actual[key] !== (key === 'effort' && choice[key] === '기본' ? null : choice[key]))) {
    out(`note: 지시서의 worker 선택과 실제 실행 설정이 달라 실제 값으로 기록한다: ${JSON.stringify(actual)}`)
  }
  const launch = {
    dispatch, task, terminal, worktree: prior.worktree, run: run || null, spec: real(a.spec!),
    branch: branchesOf(spec.text)[0] ?? null,
    ...actual, effective: actual,
  }
  try { recordLaunch(repo, launch) }
  catch (e) { err(`send-to-worker: 후속 worker 기록을 쓰지 못했다: ${(e as Error).message}`) }
  try { recordHistory(repo, { ...launch, at: new Date().toISOString(), title: spec.title, row: choice.row, retry_of: a.dispatch }) }
  catch (e) { err(`send-to-worker: 후속 worker 이력을 쓰지 못했다: ${(e as Error).message}`) }
  try { registerBoard(repo, a.spec!, prior.worktree, '', launch.branch || '') }
  catch (e) { err(`send-to-worker: 보드를 갱신하지 못했다: ${(e as Error).message}`) }
  try {
    await fire('worker-launched', {
      worker: { task, dispatch, terminal, worktree: prior.worktree, spec: launch.spec },
      branch: launch.branch, ...actual,
    }, { repo, base: (defaultBase(repo) || '').replace(/^origin\//, ''), run: run || null, out })
  } catch (e) { err(`send-to-worker: worker-launched 를 내지 못했다: ${(e as Error).message}`) }
  out(`FOLLOW-UP ${a.dispatch} ${dispatch} ${task}`)
  return 0
}

type Args = {
  dispatch: string
  body?: string
  bodyFile?: string
  replyTo?: string
  noReply?: boolean
  spec?: string
  run?: string
  agent?: string
  model?: string
  effort?: string
}

function parse(argv: string[]): Args | 'help' | null {
  const names = ['dispatch', 'body', 'body-file', 'reply-to', 'spec', 'run', ...SETTING_KEYS]
  const options = { ...Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])), 'no-reply': { type: 'boolean' as const }, help: { type: 'boolean' as const, short: 'h' } }
  let values
  try {
    // `--body "-x"` 처럼 값이 - 로 시작해도 값으로 받는다
    values = parseArgs({ args: expandArgs(argv, options, names), options }).values as Record<string, string | boolean | undefined>
  } catch (e) {
    err(`${USAGE}\nsend-to-worker: ${(e as Error).message}`)
    return null
  }
  if (values.help) return 'help'
  if (values['no-reply'] && values['reply-to']) {
    err('send-to-worker: --no-reply 와 --reply-to 는 함께 주지 않는다')
    return null
  }
  if (!values.dispatch) {
    err(`${USAGE}\nsend-to-worker: --dispatch 가 필요하다`)
    return null
  }
  const text = (name: string) => values[name] as string | undefined
  return {
    dispatch: text('dispatch') as string,
    body: text('body'),
    bodyFile: text('body-file'),
    replyTo: text('reply-to'),
    noReply: values['no-reply'] === true,
    spec: text('spec'),
    run: text('run'),
    agent: text('agent'),
    model: text('model'),
    effort: text('effort'),
  }
}

async function main(argv: string[]): Promise<number> {
  const a = parse(argv)
  if (a === null) return 2
  if (a === 'help') {
    out(USAGE)
    return 0
  }
  if (a.body && a.bodyFile) {
    err('send-to-worker: --body 와 --body-file 은 함께 주지 않는다')
    return 2
  }
  if (!(a.body || a.bodyFile || a.spec)) {
    err('send-to-worker: --body 나 --body-file 을 준다. 끝난 dispatch 를 이어 쓸 때만 --spec 으로 대신한다')
    return 2
  }
  let body = a.body ?? ''
  if (a.bodyFile) {
    try {
      body = readFileSync(a.bodyFile, 'utf8').trim()
    } catch (e) {
      err(`send-to-worker: 본문 파일을 읽지 못했다: ${(e as Error).message}`)
      return 2
    }
  }

  let described: Described
  let run: string
  let alive: boolean
  let spec: ReturnType<typeof followUpSpec> | undefined
  try {
    described = describe(a.dispatch)
    const { status, handle } = described
    run = a.run || described.runId
    if (ACTIVE.has(String(status))) {
      if (!body) {
        err(
          `send-to-worker: ${a.dispatch} 는 아직 살아 있어(${pyStr(status)}) --spec 만으로는 보낼 글이 없다. ` +
            '--body 나 --body-file 을 준다. --spec 은 끝난 dispatch 를 이어 쓸 때만 쓴다',
        )
        return 2
      }
      if (a.spec) out('note: 살아 있는 dispatch 에는 본문만 보낸다. --spec 은 끝난 dispatch 의 후속 지시에만 쓰므로 무시했다')
      const targets = a.noReply ? [] : a.replyTo ? [a.replyTo] : candidates(a.dispatch, handle, undefined, run)
      const replied = targets.length > 0 ? replyFirst(targets, body, run, a.dispatch) : null
      let wake: string
      if (replied) {
        out(`replied: ${replied.target} 에 답했다 (${replied.sent || 'None'})`)
        wake = replied.sent || replied.target
      } else {
        // 답할 곳이 없다. worker 의 질문이 모두 이미 답해졌거나 worker 가 아직 아무것도 보내지 않았다
        const sent = sendNew(a.dispatch, body, run)
        const why = a.noReply ? '--no-reply 로' : targets.length === 0 ? '보낸 메시지가 없어' : '후보가 모두 이미 답한 question 이라'
        out(`sent: ${why} reply 대신 dispatch:${a.dispatch} 에 새 메시지로 보냈다 (${sent || 'None'})`)
        if (!sent) {
          out('send-to-worker: 새 메시지 id 를 받지 못해 깨우지 못했다')
          return 5
        }
        wake = sent
      }
      out(`delivered: Orca 가 ${wake} 로 깨운다. 터미널에 입력하지 않았다`)
      return 0
    }
    if (a.spec) {
      try { spec = followUpSpec(a.spec, described.worktree || process.cwd()) }
      catch (e) { err(`send-to-worker: ${(e as Error).message}`); return 2 }
    }
    // 끝난 dispatch 라도 worker 가 보낸 question 과 escalation 이 남았으면 답을 단다. 깨울 worker 는 없다
    if (body) {
      const targets = a.noReply ? [] : a.replyTo ? [a.replyTo] : candidates(a.dispatch, handle, ASKS, run)
      const replied = targets.length > 0 ? replyFirst(targets, body, run, a.dispatch) : null
      if (replied) {
        out(`replied: ${replied.target} 에 답했다 (${replied.sent || 'None'}). 끝난 dispatch 라 깨우지 않았다`)
        if (!a.spec) return 0
        body = ''
      }
    }
    // --spec 경로는 터미널이 닫혀 있어도 Orca 가 새 터미널로 다시 연다.
    if (a.spec && spec) {
      if (body) out('note: 끝난 dispatch 에는 --body 가 가지 않는다. 후속 지시는 --spec 지시서에 적어야 한다')
      let receipt: Json | null = null
      try {
        receipt = sendAsResult(['orchestration', 'send', ...(run ? ['--run', run] : []), '--to', `dispatch:${a.dispatch}`, '--subject', spec.title, '--body', spec.line], run)
      } catch (e) {
        if (!(e instanceof OrcaFailed) || !e.rejected) throw e
        err(`send-to-worker: 후속 지시 전송이 거절돼 launch-worker 로 다시 띄운다: ${e.message}`)
      }
      if (receipt) return recordFollowUp(a, described, run, receipt, spec)
    }
    alive = handle ? liveHandles().has(handle) : false
  } catch (e) {
    if (!(e instanceof OrcaFailed)) throw e
    out(`send-to-worker: ${e.message}`)
    return 5
  }

  const { status, handle, worktree, settings } = described
  if (!alive && !a.spec) {
    out(
      `ended: ${a.dispatch} 가 끝났고(${pyStr(status)}) 터미널도 없다. ` +
        `후속 지시서를 써서 ${LAUNCH_HINT} --spec <지시서> --worktree ${worktree ? shQuote(worktree) : '<워크트리>'} 로 새로 띄운다`,
    )
    return 3
  }
  if (!a.spec && !body) {
    err('send-to-worker: 끝난 dispatch 에 보낼 글이 없다. --body 나 --body-file 을 주거나, 이어 쓸 후속 지시서를 --spec 으로 준다')
    return 2
  }
  if (!a.spec) {
    try {
      const screen = workerOrcaJson(['terminal', 'read', '--terminal', handle, '--screen'])
      if (classify(screenLines(screen)) === 'working') {
        const sent = sendNew(a.dispatch, body, run)
        err(`send-to-worker: 지시서 없이 후속 Task 로 보냈으므로 띄우기 기록에 남지 않는다: ${a.dispatch}`)
        out(`sent: 닫힌 dispatch:${a.dispatch} 에 새 메시지로 보냈다 (${sent || 'None'})`)
        return 0
      }
    } catch (e) {
      if (!(e instanceof OrcaFailed)) throw e
      out(`send-to-worker: ${e.message}`)
      return 5
    }
    out(
      `ended: ${a.dispatch} 가 끝났다(${pyStr(status)}). 닫힌 dispatch 에는 reply 가 가지 않는다. ` +
        `후속 지시를 지시서로 써서 --spec 으로 다시 부르면 터미널 ${handle} 을 이어 쓴다`,
    )
    return 3
  }
  if (!worktree) {
    out(`send-to-worker: ${a.dispatch} 의 워크트리를 몰라 이어 띄우지 못한다`)
    return 1
  }
  const runArgs = run ? ['--run', run] : []
  out(`relaunch: 끝난 ${a.dispatch} 의 터미널 ${handle} 에 새 Task 로 띄운다`)
  const code = await passThrough(
    scriptCommand(LAUNCH_WORKER, ['--spec', a.spec, '--worktree', worktree, ...runArgs, '--', ...(alive ? ['--terminal', handle] : SETTING_KEYS.flatMap(key => a[key] || settings[key] ? [`--${key}`, String(a[key] || settings[key])] : []))]),
    LAUNCH_MS,
  )
  if (code !== 3) return code === 0 ? 0 : 1
  // launch-worker 의 3 은 재사용 터미널의 agent_unconfigured 에만 쓴다.
  // 설정을 모르면 기존 터미널을 보존한다. 기본 모델로 바뀌는 일을 막는다.
  for (const key of SETTING_KEYS) if (a[key]) settings[key] = a[key]
  if (!settings.agent || !settings.model) {
    out('send-to-worker: 원래 실행 설정이 없다. --agent 와 --model 을 주면 새로 띄운다')
    return 1
  }
  try {
    // 그 사이 같은 터미널에 다른 dispatch 가 붙었으면 닫지 않는다.
    const current = workerOrcaJson(['orchestration', 'worker-show', '--dispatch', a.dispatch])
    const resource = objectOr(current.terminalResource)
    if (resource.ownershipState === 'user_owned' || resource.ownershipState === 'released') {
      out(
        `send-to-worker: 사용자가 보유하거나 해제한 터미널(${resource.ownershipState})은 닫지 않는다. ` +
          '이 세션이 띄운 worker 의 터미널이 맞으면 화면을 확인한 뒤 코디네이터가 직접 닫고 새로 띄운다: ' +
          `orca terminal read --terminal ${handle} 로 확인, orca terminal close --terminal ${handle} 로 닫기, ` +
          `${LAUNCH_HINT} --spec ${shQuote(a.spec)} --worktree ${shQuote(worktree)} (--terminal 없이) 로 띄우기`,
      )
      return 1
    }
    const owner = resource.ownerDispatchId
    if (owner && owner !== a.dispatch) {
      out('send-to-worker: 터미널 소유 dispatch 가 바뀌어 닫지 않는다')
      return 1
    }
    let cursor = ''
    const seen = new Set<string>()
    for (;;) {
      const fleet = workerOrcaJson(['orchestration', 'worker-list', ...runArgs, ...(cursor ? ['--cursor', cursor] : [])])
      if (rows(fleet.workers).some((row) => row.agentTerminalHandle === handle && ACTIVE.has(String(row.dispatchStatus)))) {
        out('send-to-worker: 터미널에 활성 dispatch 가 있어 닫지 않는다')
        return 1
      }
      const page = objectOr(fleet.page)
      if (!page.hasMore) break
      cursor = String(page.nextCursor || '')
      if (!cursor || seen.has(cursor)) throw new OrcaFailed('worker-list 의 다음 페이지를 확인하지 못했다')
      seen.add(cursor)
    }
    closeTerminal(handle, { mode: 'throw', failure: (message, structured) => new OrcaFailed(message, structured) })
  } catch (e) {
    if (!(e instanceof OrcaFailed)) throw e
    out(`send-to-worker: ${e.message}`)
    return 5
  }
  const fresh = ['--spec', a.spec, '--worktree', worktree, ...runArgs, '--']
  for (const key of SETTING_KEYS) if (settings[key]) fresh.push(`--${key}`, String(settings[key]))
  out(`restart: ${handle} 을 닫고 같은 워크트리에 새 worker 를 띄운다`)
  return (await passThrough(scriptCommand(LAUNCH_WORKER, fresh), LAUNCH_MS)) === 0 ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    err(`send-to-worker: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  },
)
