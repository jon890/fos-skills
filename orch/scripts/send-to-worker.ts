// worker 에게 답이나 후속 지시를 보낸다. dispatch 의 상태에 따라 전달 경로를 고른다.
//
// 코디네이터가 worker 터미널에 `orca terminal send` 로 직접 쓰면, 그 worker 가 작업 중일 때 입력이 섞이고
// 끝난 dispatch 의 터미널에 쓴 지시는 Task 기록 없이 사라진다. 닫힌 dispatch 에 `reply` 해도 전달되지 않는다.
// 이 명령이 경로를 고른다.
//
//     dispatch 가 살아 있다   그 worker 의 마지막 메시지(없으면 --reply-to)에 `reply` 하고 `nudge-worker` 로 깨운다.
//                             이미 답이 달린 question 은 건너뛴다. orca 가 「already has a different answer」 로 거부하면
//                             다음 후보 메시지로 한 번 더 시도한다. reply 할 후보가 없거나 시도한 후보가 모두 그 문구로 거부되면
//                             `send --to dispatch:<id> --subject <본문 첫 줄> --body <본문>` 으로 새 메시지를 보내고
//                             `sent: ...` 한 줄을 찍은 뒤 `nudge-worker --msg-id <새 메시지>` 로 깨운다
//     끝났고 답할 메시지가 있다  `--reply-to`(없으면 그 worker 의 미답변 question 과 escalation 중 마지막)에 `reply` 한다.
//                             worker 가 없어 깨우지는 않는다. `--spec` 이 없으면 답만 달고 0 으로 끝나고, 있으면 아래처럼 이어 띄운다
//     끝났고 터미널이 남았다  `--spec` 의 지시서로 `launch-worker --worktree <그 워크트리> -- --terminal <그 터미널>` 을 부른다.
//                             agent_unconfigured(종료 코드 3)이면 그 터미널을 닫고 같은 워크트리에 새 worker 를 띄운다
//     끝났는데 아직 일한다    `--spec` 이 없고 그 터미널 화면이 작업 중이면 `nudge-worker --text` 로 본문을 넣고,
//                             Task 기록에 묶이지 않는다고 경고한다. worker 가 중간에 worker_done 을 보내 dispatch 가
//                             닫혔는데 계속 일하는 일이 있었다. 작업 중이 아니면 종료 코드 3 으로 --spec 을 요구한다
//     터미널도 없다           새로 띄우라고 안내하고 종료 코드 3 이다
//
// reply 와 새 메시지는 `--run <run> --from run:<run>` 과 함께 보낸다. Run 을 모르면(--run 도 dispatch 의 runId 도 없으면) 붙이지 않는다.
// Orca 터미널에서 돌면 터미널 증명 때문에 `--from run:<run>` 이 `consumer_fenced` 로 거부된다. 그러면 `--from` 만 빼고 한 번 다시 보낸다.
// 그 답의 보낸 쪽은 코디네이터 터미널(term_*)이지만 lib/questions.ts 의 unanswered() 는 worker 쪽으로 간 답을 모두 센다(ADR-015)
//
// agent_unconfigured 로 새 worker 를 띄울 때 실행 설정은 원래 dispatch 의 `startOptions.launch` 에서 읽는다.
// effective 를 우선하고 없는 값은 requested 에서 읽으며, --agent, --model, --effort 로 바꿀 수 있다.
// 에이전트나 모델을 모르면 터미널을 남기고 그 인자를 요구한다. 터미널이 사용자 보유나 해제 상태이거나
// 소유 dispatch 가 바뀌었거나 활성 dispatch 가 붙었으면 닫지 않는다. 닫기 실패나 다른 실행 오류는 자동 재시도하지 않는다.
// 워크트리 파일은 보존되지만 새 worker 는 앞 대화를 모르므로 후속 지시서에 이어받을 상태를 적는다.
//
// 사용법:
//     send-to-worker.ts --dispatch ID (--body TEXT | --body-file FILE) [--reply-to MSG_ID] [--spec FILE] [--run RUN]
//     send-to-worker.ts --dispatch ENDED_ID --spec FILE [--run RUN] [--agent A --model M --effort E]
//
//     --dispatch   worker 의 dispatch id
//     --body       보낼 글. --body-file 로 파일에서 읽을 수 있다. 끝난 dispatch 를 --spec 으로 이어 쓸 때는 필요 없다
//     --reply-to   답을 달 메시지 id. 없으면 inbox 에서 그 worker 가 보낸 마지막 메시지(heartbeat 는 뒤로 미룬다)를 쓴다.
//                  끝난 dispatch 는 question 과 escalation 만 후보로 보고, 이미 답한 것은 뺀다
//     --spec       dispatch 가 끝났을 때 이어 쓸 후속 지시서. `허락:` 줄이 있어야 한다.
//                  끝난 dispatch 에는 --body 가 가지 않는다. 후속 지시는 이 지시서에 적는다. 그래서 --spec 만 주면 된다
//                  (--body 를 함께 주면 무시한다고 알린다). 살아 있는 dispatch 에 --spec 만 주면 보낼 글이 없어 거부한다
//     --run        reply 와 다시 띄우기에 줄 Run id
//     --agent, --model, --effort  새 worker 실행 설정. 생략하면 원래 dispatch 설정을 쓴다
//
// ORCA, NUDGE_WORKER, LAUNCH_WORKER 환경 변수로 실행 파일과 스크립트 경로를 바꾼다.
// 스크립트는 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
// 깨우기와 다시 띄우기의 nudge-worker, launch-worker 출력은 모으지 않고 그대로 흘린다(lib/proc.ts 의 runInherit).
// 옵션은 고유 접두로 줄여 쓸 수 있고 값이 - 로 시작해도 받는다(lib/args.ts).
//
// 종료 코드:
//     0  보냈다(reply 나 새 메시지). 살아 있는 worker 면 깨웠거나 작업 중이다. 닫힌 dispatch 의 일하는 터미널이면 입력을 넣었다.
//        닫힌 dispatch 에 답만 달았으면(--spec 없음) `replied: ... 끝난 dispatch 라 깨우지 않았다` 한 줄을 찍고 0 이다
//     1  보냈지만 턴 시작을 보지 못했거나, 다시 띄우기가 실패했다. nudge-worker 가 제한 시간(5분)에 끊겨도 1 이다
//     3  dispatch 가 끝나 보낼 수 없다. 표준 출력이 다음에 할 일을 말한다
//     4  보냈지만 입력란에 글이 있거나 권한 확인 창이라 깨우지 않았다(nudge-worker 의 4)
//     5  orca 가 오류를 냈다
//     2  사용법 오류

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { orca } from './lib/orca.ts'
import { runAsync, runInherit, scriptCommand } from './lib/proc.ts'
import { pyStr, shQuote } from './lib/py.ts'

const USAGE = [
  '사용법: send-to-worker.ts --dispatch ID (--body TEXT | --body-file FILE) [--reply-to MSG_ID] [--spec FILE] [--run RUN]',
  '        send-to-worker.ts --dispatch ENDED_ID --spec FILE [--run RUN] [--agent A --model M --effort E]',
].join('\n')
const HERE = dirname(fileURLToPath(import.meta.url))
const NUDGE_WORKER = process.env.NUDGE_WORKER || `${HERE}/nudge-worker.ts`
const LAUNCH_WORKER = process.env.LAUNCH_WORKER || `${HERE}/launch-worker.ts`
// 이 상태의 dispatch 는 reply 를 받는다. 나머지(completed, failed 같은 것)는 끝난 것이다
const ACTIVE = new Set(['pending', 'dispatched', 'running'])
// 이미 답한 question 에 다시 reply 하면 orca 가 이 문구로 거부한다
const ANSWERED = 'already has a different answer'
// Orca 터미널 안에서 `--from run:<run>` 을 붙이면 orca 가 이 코드로 거부한다
const FENCED = 'consumer_fenced'
// 끝난 dispatch 에서 답할 후보로 보는 메시지 종류
const ASKS = new Set(['question', 'escalation'])
// 새 메시지 제목에 쓰는 본문 첫 줄의 최대 글자 수
const SUBJECT_MAX = 120
// nudge-worker 는 턴 시작을 기본 15초씩 두 번 기다린다. ORCH_NUDGE_TIMEOUT_MS 는 이 한도를 바꾼다. 테스트만 쓴다
const NUDGE_MS = Number(process.env.ORCH_NUDGE_TIMEOUT_MS) || 300_000
// launch-worker 는 make-worktree 와 worker-start 를 각각 10분까지 기다리고, 멈춘 dispatch 를 한 번 다시 띄운다
const LAUNCH_MS = 3_600_000
const SETTING_KEYS = ['agent', 'model', 'effort'] as const
// 사람에게 다시 띄우라고 안내하는 명령. 실행 규칙의 꼴(node 와 경고 끄기, 절대경로)로 낸다
const LAUNCH_HINT = `node --disable-warning=ExperimentalWarning ${shQuote(`${HERE}/launch-worker.ts`)}`

type Json = Record<string, unknown>
type Settings = Record<string, unknown>

class OrcaFailed extends Error {}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
}

function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : []
}

// 실패 판정에 stdout 과 stderr 를 함께 본다. 「already has a different answer」 가 어느 쪽에 오든 다음 후보로 넘어가게 한다
function orcaJson(args: string[]): Json {
  const done = orca([...args, '--json'])
  let data: unknown
  try {
    data = JSON.parse(done.stdout)
  } catch {
    data = null
  }
  const body = obj(data)
  if (done.code !== 0 || data !== body || !body.ok) {
    const detail = Array.from((done.stdout + done.stderr).trim()).slice(0, 300).join('')
    throw new OrcaFailed(`orca ${args.slice(0, 2).join(' ')} 실패: ${detail}`)
  }
  return obj(body.result)
}

type Described = { status: unknown; handle: string; worktree: string; runId: string; settings: Settings }

function describe(dispatchId: string): Described {
  const shown = orcaJson(['orchestration', 'worker-show', '--dispatch', dispatchId])
  const dispatch = obj(shown.dispatch)
  const worker = obj(shown.worker)
  const worktreeId = String(worker.worktreeId || '')
  const worktree = worktreeId.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : worktreeId
  const handle = String(worker.agentTerminalHandle || dispatch.assigneeHandle || '')
  const options = obj(worker.startOptions)
  const launch = obj(options.launch)
  const settings: Settings = {}
  Object.assign(settings, obj(launch.requested))
  for (const [key, value] of Object.entries(obj(launch.effective))) if (value) settings[key] = value
  if (!settings.agent) settings.agent = options.agent
  return { status: dispatch.status, handle, worktree, runId: String(dispatch.runId || ''), settings }
}

// reply 할 후보 메시지 id. 앞이 우선이다. heartbeat 는 뒤로 미루고, 답이 보이는 question 은 뺀다.
function candidates(dispatchId: string, handle: string, kinds?: Set<string>): string[] {
  const messages = rows(orcaJson(['orchestration', 'inbox', '--limit', '200']).messages)
  const fromWorker = (row: Json) => row.from_handle === `dispatch:${dispatchId}` || (!!handle && row.from_handle === handle)
  // 같은 thread 에 worker 가 아닌 쪽이 쓴 글이 있으면 그 question 은 이미 답했다
  const answered = new Set(messages.filter((r) => r.thread_id && !fromWorker(r) && r.thread_id !== r.id).map((r) => r.thread_id))
  const mine = messages.filter((row) => {
    let payload: unknown
    try {
      payload = JSON.parse(String(row.payload || '{}'))
    } catch {
      payload = {}
    }
    if (!fromWorker(row) && obj(payload).dispatchId !== dispatchId) return false
    if (String(row.from_handle ?? '').startsWith('run:')) return false
    if (kinds && !kinds.has(String(row.type))) return false
    return !((kinds || row.type === 'question') && answered.has(row.id))
  })
  // heartbeat 를 앞에, 같은 종류 안에서는 sequence 순으로 놓고 뒤집는다. 가장 최근의 heartbeat 아닌 메시지가 맨 앞이 된다
  const rank = (row: Json) => [row.type !== 'heartbeat' ? 1 : 0, Number(row.sequence) || 0]
  mine.sort((a, b) => {
    const [ka, sa] = rank(a)
    const [kb, sb] = rank(b)
    return ka - kb || sa - sb
  })
  return mine.reverse().map((row) => String(row.id))
}

function liveHandles(): Set<string> {
  return new Set(rows(orcaJson(['terminal', 'list']).terminals).map((t) => String(t.handle || '')).filter(Boolean))
}

// `--from run:<run>` 을 붙여 보내고, consumer_fenced 로 거부되면 빼고 한 번 다시 보낸다. 보낸 메시지 id 를 낸다
function sendAs(base: string[], run: string): string {
  let result: Json
  try {
    result = orcaJson([...base, ...(run ? ['--from', `run:${run}`] : [])])
  } catch (e) {
    if (!run || !(e instanceof OrcaFailed) || !e.message.includes(FENCED)) throw e
    out(`retry: --from run:${run} 이 ${FENCED} 로 거부돼 --from 없이 다시 보낸다`)
    result = orcaJson(base)
  }
  return String(obj(result.message).id || result.messageId || result.id || '')
}

function reply(msgId: string, body: string, run: string): string {
  return sendAs(['orchestration', 'reply', '--id', msgId, '--body', body, ...(run ? ['--run', run] : [])], run)
}

// reply 할 곳이 없을 때 그 dispatch 에 새 메시지로 보낸다. 제목은 본문 첫 줄이다
function sendNew(dispatchId: string, body: string, run: string): string {
  const subject = Array.from(body.split('\n')[0].trim()).slice(0, SUBJECT_MAX).join('') || '코디네이터 후속 지시'
  const base = ['orchestration', 'send', ...(run ? ['--run', run] : []), '--to', `dispatch:${dispatchId}`, '--subject', subject, '--body', body]
  return sendAs(base, run)
}

// 이미 답한 question 이면 다음 후보로 한 번만 더 시도한다. 답을 단 메시지 id 와 새 답의 id 를 낸다.
// 시도한 후보가 모두 이미 답한 question 이면 null 이다
function replyFirst(targets: string[], body: string, run: string): { target: string; sent: string } | null {
  for (const [attempt, candidate] of targets.slice(0, 2).entries()) {
    try {
      return { target: candidate, sent: reply(candidate, body, run) }
    } catch (e) {
      if (!(e instanceof OrcaFailed) || !e.message.includes(ANSWERED)) throw e
      if (attempt === 1 || targets.length < 2) {
        out(`skipped: ${candidate} 는 이미 답한 question 이다`)
        return null
      }
      out(`skipped: ${candidate} 는 이미 답한 question 이라 다음 메시지에 답한다`)
    }
  }
  return null
}

// 자식의 출력을 그대로 흘리고 종료 코드를 낸다
async function passThrough(argv: string[], timeoutMs: number): Promise<number> {
  return (await runInherit(argv, { timeoutMs })).code
}

// nudge-worker 로 깨운다. 제한 시간에 끊기면 124 대신 1 이다. 종료 코드 계약에 124 가 없고, 보냈지만 턴 시작을 보지 못한 경우다
async function nudge(args: string[]): Promise<number> {
  const done = await runInherit(scriptCommand(NUDGE_WORKER, args), { timeoutMs: NUDGE_MS })
  if (done.timedOut) {
    out(`send-to-worker: nudge-worker 가 ${NUDGE_MS / 1000}초 안에 끝나지 않아 끊었다`)
    return 1
  }
  return done.code
}

async function screenState(handle: string): Promise<string> {
  const done = await runAsync(scriptCommand(NUDGE_WORKER, ['--terminal', handle, '--state']), { timeoutMs: NUDGE_MS })
  return done.code === 0 ? done.stdout.trim() : 'unknown'
}

type Args = {
  dispatch: string
  body?: string
  bodyFile?: string
  replyTo?: string
  spec?: string
  run?: string
  agent?: string
  model?: string
  effort?: string
}

function parse(argv: string[]): Args | 'help' | null {
  const names = ['dispatch', 'body', 'body-file', 'reply-to', 'spec', 'run', ...SETTING_KEYS]
  const options = { ...Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])), help: { type: 'boolean' as const, short: 'h' } }
  let values
  try {
    // `--body "-x"` 처럼 값이 - 로 시작해도 값으로 받는다
    values = parseArgs({ args: expandArgs(argv, options, names), options }).values as Record<string, string | boolean | undefined>
  } catch (e) {
    err(`${USAGE}\nsend-to-worker: ${(e as Error).message}`)
    return null
  }
  if (values.help) return 'help'
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
      const targets = a.replyTo ? [a.replyTo] : []
      targets.push(...candidates(a.dispatch, handle).filter((t) => !targets.includes(t)))
      const replied = targets.length > 0 ? replyFirst(targets, body, run) : null
      let wake: string
      if (replied) {
        out(`replied: ${replied.target} 에 답했다 (${replied.sent || 'None'})`)
        wake = replied.sent || replied.target
      } else {
        // 답할 곳이 없다. worker 의 질문이 모두 이미 답해졌거나 worker 가 아직 아무것도 보내지 않았다
        const sent = sendNew(a.dispatch, body, run)
        const why = targets.length === 0 ? '보낸 메시지가 없어' : '후보가 모두 이미 답한 question 이라'
        out(`sent: ${why} reply 대신 dispatch:${a.dispatch} 에 새 메시지로 보냈다 (${sent || 'None'})`)
        if (!sent) {
          out('send-to-worker: 새 메시지 id 를 받지 못해 깨우지 못했다')
          return 1
        }
        wake = sent
      }
      if (!handle) {
        out('send-to-worker: 터미널 handle 을 몰라 깨우지 못했다')
        return 1
      }
      return await nudge(['--terminal', handle, '--msg-id', wake])
    }
    // 끝난 dispatch 라도 worker 가 보낸 question 과 escalation 이 남았으면 답을 단다. 깨울 worker 는 없다
    if (body) {
      const targets = a.replyTo ? [a.replyTo] : candidates(a.dispatch, handle, ASKS)
      const replied = targets.length > 0 ? replyFirst(targets, body, run) : null
      if (replied) {
        out(`replied: ${replied.target} 에 답했다 (${replied.sent || 'None'}). 끝난 dispatch 라 깨우지 않았다`)
        if (!a.spec) return 0
        body = ''
      }
    }
    alive = handle ? liveHandles().has(handle) : false
  } catch (e) {
    if (!(e instanceof OrcaFailed)) throw e
    out(`send-to-worker: ${e.message}`)
    return 5
  }

  const { status, handle, worktree, settings } = described
  if (!alive) {
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
    if ((await screenState(handle)) === 'working') {
      out(`warning: ${a.dispatch} 가 닫혀(${pyStr(status)}) 이 지시는 Task 기록에 묶이지 않는다. 작업 중인 터미널 ${handle} 에 직접 넣는다`)
      const text = `코디네이터(닫힌 dispatch ${a.dispatch}): ${body}`
      return await nudge(['--terminal', handle, '--text', text])
    }
    out(
      `ended: ${a.dispatch} 가 끝났다(${pyStr(status)}). 닫힌 dispatch 에는 reply 가 가지 않는다. ` +
        `후속 지시를 지시서로 써서 --spec 으로 다시 부르면 터미널 ${handle} 을 이어 쓴다`,
    )
    return 3
  }
  if (body) out('note: 끝난 dispatch 에는 --body 가 가지 않는다. 후속 지시는 --spec 지시서에 적어야 한다')
  if (!worktree) {
    out(`send-to-worker: ${a.dispatch} 의 워크트리를 몰라 이어 띄우지 못한다`)
    return 1
  }
  const runArgs = run ? ['--run', run] : []
  out(`relaunch: 끝난 ${a.dispatch} 의 터미널 ${handle} 에 새 Task 로 띄운다`)
  const code = await passThrough(
    scriptCommand(LAUNCH_WORKER, ['--spec', a.spec, '--worktree', worktree, ...runArgs, '--', '--terminal', handle]),
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
    const current = orcaJson(['orchestration', 'worker-show', '--dispatch', a.dispatch])
    const resource = obj(current.terminalResource)
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
      const fleet = orcaJson(['orchestration', 'worker-list', ...runArgs, ...(cursor ? ['--cursor', cursor] : [])])
      if (rows(fleet.workers).some((row) => row.agentTerminalHandle === handle && ACTIVE.has(String(row.dispatchStatus)))) {
        out('send-to-worker: 터미널에 활성 dispatch 가 있어 닫지 않는다')
        return 1
      }
      const page = obj(fleet.page)
      if (!page.hasMore) break
      cursor = String(page.nextCursor || '')
      if (!cursor || seen.has(cursor)) throw new OrcaFailed('worker-list 의 다음 페이지를 확인하지 못했다')
      seen.add(cursor)
    }
    orcaJson(['terminal', 'close', '--terminal', handle])
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
