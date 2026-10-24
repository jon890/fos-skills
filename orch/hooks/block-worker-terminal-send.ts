// PreToolUse(Bash) hook: worker 터미널에 직접 `orca terminal send` 하는 Bash 호출을 거부한다.
// 대상이 worker 인지 확인하지 못하면 거부한다(fail-closed).
//
// worker 가 일하는 중에 터미널에 직접 쓰면 입력이 섞이고, dispatch 가 끝났으면 그 지시는 어느 Task 에도 묶이지 않는다.
// `send-to-worker` 가 dispatch 상태를 보고 reply 와 `nudge-worker`, 또는 후속 지시서로 나눠 보낸다.
//
// 판정(`orca terminal send` 조각마다):
//     - `--environment` 나 `--pairing-code` 가 있으면 거부한다. 원격 서버의 터미널은 이 hook 이 확인할 수 없다
//     - `--terminal` 이 없으면 거부한다. 대상을 모른다
//     - `--terminal` 값이 `term_` 로 시작하는 낱말이 아니면(`"$T"`, `$(...)`) 거부한다. 첫 화면 승인이어도 거부한다
//     - 값이 모든 Run 의 active worker 터미널이면 거부한다. 첫 화면 승인은 아래 예외다
//     - 어느 Run 의 worker 도 아니면 통과한다
//
// worker 판정 범위(앞 단계에서 정해지면 뒤 단계로 가지 않는다):
//     1. `worker-list --terminal-state active --limit 100` 을 page.nextCursor 끝까지 읽는다. 행의 agentTerminalHandle 이
//        대상이면 worker 이고, 그 행의 dispatchId 로 첫 화면을 본다
//     2. 없고 첫 응답의 scope.source 가 all 이면 worker 가 아니다
//     3. 없고 all 이 아니면(묶인 Run 만 봤다) `orca terminal show --terminal <대상>` 의 agentIdentity 를 본다.
//        비어 있으면(에이전트가 돌지 않는 셸) worker 가 아니다
//     4. agentIdentity 가 있으면 `run-list --limit 100` 을 result.nextCursor 끝까지 읽어 updated_at 이 최근인 순서로 놓고,
//        Run 마다 `worker-list --run <id> --terminal-state active --limit 100` 을 page.nextCursor 끝까지 읽는다.
//        동시 16개까지 부르고, 대상을 모두 찾으면 남은 호출을 기다리지 않는다. 모두 읽고도 없으면 worker 가 아니다
//     Run 이 수백 개 쌓인 머신에서 모든 Run 을 늘 읽으면 시간 한도에 자주 닿는다(2026-10-24 실측 251개, 한 번 약 0.11초).
//     그래서 전체 조회는 다른 Run 의 worker 일 수 있는 에이전트 터미널로 보낼 때만 한다.
//
// 조회 실패와 시간 한도:
//     - 종료 코드가 0 이 아니거나, JSON 이 아니거나, result.workers(run-list 는 result.runs, terminal show 는 result.terminal)
//       꼴이 아니면 조회 실패로 거부한다
//     - orca 호출은 모두 합쳐 hook 시작부터 7초 안에 끝낸다. 호출마다 남은 시간을 넘기고, 남은 시간이 없으면 부르지 않고 거부한다.
//       hooks.json 의 timeout 이 10초이고, hook 이 시간을 넘겨 죽으면 Claude Code 는 막지 않고 명령을 실행하기 때문이다.
//       Run 이 늘어 4단계가 한도를 넘으면 거부된다. fail-closed 의 의도된 비용이다
//     - 조회는 runAsync 로만 한다. 동기 실행은 TERM 을 무시하는 자식이 끝날 때까지 돌아오지 않는다.
//       판정을 낸 뒤 process.exit 로 끝내 아직 도는 조회가 hook 을 붙잡지 않게 한다
//     - ORCH_SEND_HOOK_BUDGET_MS 는 7초 한도를 바꾼다. 테스트만 쓴다
//     - ORCA_TERMINAL_HANDLE 은 빼지 않는다. 빼도 worker-list 의 범위가 넓어지지 않는다(lib/orca.ts 머리 주석)
//
// 오탐을 피하는 기준:
//     - 따옴표 안, heredoc 본문, 주석에 든 `orca terminal send` 문구는 보지 않는다. 그런 명령에는 orca 를 조회하지 않는다
//     - `--terminal` 은 `orca terminal send` 와 같은 명령 조각에 있는 것만 본다(`terminal read --terminal` 은 아니다)
//     - 첫 화면 승인은 통과한다. 본문 없이 `--enter` 만 보내는 명령이고, 그 worker 의 `worker-show --dispatch` 가
//       `agent-trust-workspace` 같은 첫 화면 대기(`observation.agentWait`, `projection.stage.detail`)를 보이면 거부하지 않는다.
//       `launch.md` 「첫 화면에서 멈춤」 이 사용자 승인 뒤 이 명령으로 첫 선택지를 고르라고 한다.
//       단계를 읽지 못하면 거부한다
//     - `send-to-worker`, `nudge-worker` 는 스크립트 안에서 orca 를 부르므로 이 hook 을 거치지 않는다
//
// 판정 중의 예상 밖 예외(조회 실패로 분류하지 못한 것)도 거부한다. hook 이 예외로 죽으면 Claude Code 는 막지 않고 명령을 실행한다.
//
// 입력은 stdin 의 hook JSON 이다. 거부할 때만 deny 결정을 stdout 으로 낸다. 읽지 못한 입력은 통과시킨다.
// hooks.json 은 이 파일을 PATH 의 `node` 로 부른다. node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다.

import { orcaBin } from '../scripts/lib/orca.ts'
import { runAsync } from '../scripts/lib/proc.ts'
import type { RunResult } from '../scripts/lib/proc.ts'
import { hookCommand, mask, pieces, stripHeredocs } from './shell-text.ts'

const SEND = /\borca\s+terminal\s+send\b/
const TARGET_FLAG = /--terminal(?:\s+|=)/g
// sticky: 원문의 --terminal 바로 뒤에서만 맞춘다. 값 전체가 handle 이어야 한다(`term_a$X` 는 아니다)
const TARGET_VALUE = /(['"]?)(term_[\w-]+)\1(?=$|[\s;&|()<>])/y
const REMOTE_FLAG = /--(?:environment|pairing-code)(?:\s|=|$)/
const BODY_FLAG = /--(?:text|interrupt)\b/
const ENTER_FLAG = /--enter\b/
// Orca 가 첫 화면에서 사람을 기다린다고 알리는 이름. 사용자가 답할 화면이라 키 입력만 허용한다
const FIRST_SCREEN = /agent-(?:trust-workspace|update-prompt|cwd-prompt|hooks-review-prompt)/

const DEFAULT_BUDGET_MS = 7_000
const PAGE_LIMIT = '100'
const RUN_CONCURRENCY = 16

const SEND_TO_WORKER = '`node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/send-to-worker.ts" --dispatch <id> --body ...` 로 보낸다.'
const RESEND = 'worker 가 아니면 `--terminal term_...` 처럼 handle 을 그대로 적어 다시 부른다.'
const REASON = {
  worker: (handle: string) =>
    `orch: worker 터미널(${handle})에 \`orca terminal send\` 로 직접 쓰지 않는다. ` +
    '작업 중이면 입력이 섞이고, 끝난 dispatch 면 지시가 어느 Task 에도 묶이지 않는다. ' +
    `${SEND_TO_WORKER} 깨우기만 하려면 \`nudge-worker\` 를 쓴다.`,
  firstScreen: (handle: string, why: string) =>
    `orch: worker 터미널(${handle})이 첫 화면 대기가 아니라 \`--enter\` 를 보내지 않는다(${why}). ` +
    `${SEND_TO_WORKER} 첫 화면 승인이면 handle 을 그대로 적어 다시 부른다.`,
  variable:
    'orch: `orca terminal send` 의 `--terminal` 값이 `term_` 로 시작하는 handle 글자가 아니라(변수나 명령 치환) ' +
    `worker 터미널인지 확인할 수 없다. worker 면 ${SEND_TO_WORKER} ` +
    'worker 가 아니거나 첫 화면 승인이면 `--terminal term_...` 처럼 handle 을 그대로 적어 다시 부른다.',
  noTarget:
    'orch: `--terminal` 이 없는 `orca terminal send` 는 대상을 알 수 없다. `--terminal term_...` 처럼 handle 을 그대로 적는다.',
  remote:
    'orch: `--environment` 나 `--pairing-code` 로 원격 서버의 터미널에 보내는 `orca terminal send` 는 ' +
    `이 hook 이 worker 터미널인지 확인할 수 없다. worker 면 ${SEND_TO_WORKER} 아니면 그 서버의 셸에서 보낸다.`,
  failed: (why: string) => `orch: worker 터미널인지 확인하는 orca 조회가 실패했다: ${why}. ${RESEND}`,
  timeout: (ms: number) => `orch: worker 터미널인지 확인하는 orca 조회가 ${ms}ms 안에 끝나지 않았다(시간 초과). ${RESEND}`,
  unexpected: (why: string) => `orch: worker 터미널인지 판정하다 예상 밖 오류가 났다: ${why}. ${RESEND}`,
}

type Target = { handle: string; keyOnly: boolean }
type Static = { targets: Map<string, boolean> } | { deny: string }
type Worker = { dispatchId: string | null }

class LookupFailure extends Error {
  readonly timeout: boolean
  constructor(message: string, timeout = false) {
    super(message)
    this.timeout = timeout
  }
}

// 명령을 읽기만 해서 정할 수 있는 판정. 거부 이유가 있으면 orca 를 조회하지 않는다.
// targets 는 {handle: 키만 보내는가}. 같은 handle 이 여러 조각이면 본문을 보내는 쪽이 이긴다.
function staticTargets(command: string): Static {
  const text = stripHeredocs(command)
  const masked = mask(text)
  const targets = new Map<string, boolean>()
  for (const { start, end } of pieces(masked)) {
    const piece = masked.slice(start, end)
    if (!SEND.test(piece)) continue
    if (REMOTE_FLAG.test(piece)) return { deny: REASON.remote }
    const keyOnly = ENTER_FLAG.test(piece) && !BODY_FLAG.test(piece)
    const found: Target[] = []
    for (const flag of piece.matchAll(TARGET_FLAG)) {
      TARGET_VALUE.lastIndex = start + flag.index + flag[0].length
      const m = TARGET_VALUE.exec(text)
      if (!m) return { deny: REASON.variable }
      found.push({ handle: m[2], keyOnly })
    }
    if (found.length === 0) return { deny: REASON.noTarget }
    for (const t of found) targets.set(t.handle, (targets.get(t.handle) ?? true) && t.keyOnly)
  }
  return { targets }
}

function budgetMs(): number {
  const raw = process.env.ORCH_SEND_HOOK_BUDGET_MS
  const value = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BUDGET_MS
}

const budget = budgetMs()
const deadline = Date.now() + budget
const TIMEOUT = Symbol('timeout')

// orca 를 한 번 부르고 봉투의 result 객체를 낸다. 남은 시간이 없거나 넘기면 시간 초과, 그 밖의 문제는 조회 실패다.
async function orcaResult(args: string[]): Promise<Record<string, unknown>> {
  const left = deadline - Date.now()
  if (left <= 0) throw new LookupFailure('시간 초과', true)
  const label = `orca ${args.join(' ')}`
  let timer: NodeJS.Timeout | undefined
  // runAsync 는 시간을 넘긴 자식이 TERM 을 무시하면 KILL 까지 10초를 더 기다린다. 마감 시각에 따로 끊는다.
  const limit = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), left)
  })
  let done: RunResult | typeof TIMEOUT
  try {
    done = await Promise.race([runAsync([orcaBin(), ...args, '--json'], { timeoutMs: left }), limit])
  } finally {
    clearTimeout(timer)
  }
  if (done === TIMEOUT || done.timedOut) throw new LookupFailure('시간 초과', true)
  if (done.code !== 0) throw new LookupFailure(`${label} 가 종료 코드 ${done.code} 로 끝났다`)
  let envelope: unknown
  try {
    envelope = JSON.parse(done.stdout)
  } catch {
    throw new LookupFailure(`${label} 의 출력이 JSON 이 아니다`)
  }
  const result = (envelope as { result?: unknown } | null)?.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new LookupFailure(`${label} 의 응답에 result 객체가 없다`)
  }
  return result as Record<string, unknown>
}

function nextCursor(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

type WorkerPage = { workers: Record<string, unknown>[]; scope: unknown; next: string | null }

async function workerPage(args: string[]): Promise<WorkerPage> {
  const result = await orcaResult(['orchestration', 'worker-list', ...args])
  if (!Array.isArray(result.workers)) throw new LookupFailure('worker-list 응답의 result.workers 가 배열이 아니다')
  const page = result.page as { nextCursor?: unknown } | undefined
  return {
    workers: result.workers.filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null),
    scope: (result.scope as { source?: unknown } | undefined)?.source,
    next: nextCursor(page?.nextCursor),
  }
}

// worker-list 를 page.nextCursor 끝까지 읽는다. 대상을 찾으면 found 에 넣고, 모두 찾았거나 stop() 이 참이면 멈춘다.
async function scanWorkers(
  base: string[],
  wanted: Set<string>,
  found: Map<string, Worker>,
  stop: () => boolean = () => false,
): Promise<unknown> {
  let cursor: string | null = null
  let scope: unknown
  let first = true
  do {
    if (stop()) return scope
    const page = await workerPage([...base, '--terminal-state', 'active', '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])])
    if (first) scope = page.scope
    first = false
    for (const w of page.workers) {
      const handle = w.agentTerminalHandle
      if (typeof handle === 'string' && wanted.has(handle) && !found.has(handle)) {
        found.set(handle, { dispatchId: typeof w.dispatchId === 'string' ? w.dispatchId : null })
      }
    }
    if ([...wanted].every((h) => found.has(h))) return scope
    cursor = page.next
  } while (cursor)
  return scope
}

async function hasAgent(handle: string): Promise<boolean> {
  const result = await orcaResult(['terminal', 'show', '--terminal', handle])
  const terminal = result.terminal
  if (typeof terminal !== 'object' || terminal === null) throw new LookupFailure('terminal show 응답에 result.terminal 이 없다')
  const identity = (terminal as { agentIdentity?: unknown }).agentIdentity
  return identity !== undefined && identity !== null && identity !== ''
}

// run-list 를 result.nextCursor 끝까지 읽고 updated_at 이 최근인 순서로 Run id 를 낸다.
async function runIds(): Promise<string[]> {
  const runs: { id: string; updated: string }[] = []
  let cursor: string | null = null
  do {
    const result = await orcaResult(['orchestration', 'run-list', '--limit', PAGE_LIMIT, ...(cursor ? ['--cursor', cursor] : [])])
    if (!Array.isArray(result.runs)) throw new LookupFailure('run-list 응답의 result.runs 가 배열이 아니다')
    for (const r of result.runs as { id?: unknown; updated_at?: unknown }[]) {
      if (typeof r?.id === 'string') runs.push({ id: r.id, updated: typeof r.updated_at === 'string' ? r.updated_at : '' })
    }
    cursor = nextCursor(result.nextCursor)
  } while (cursor)
  return runs.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)).map((r) => r.id)
}

// Run 마다 worker-list --run 을 동시 RUN_CONCURRENCY 개까지 부른다. 대상을 모두 찾거나 하나라도 실패하면 바로 돌아온다.
function scanRuns(ids: string[], wanted: Set<string>, found: Map<string, Worker>): Promise<void> {
  return new Promise((resolve, reject) => {
    let next = 0
    let running = 0
    let settled = false
    const allFound = () => [...wanted].every((h) => found.has(h))
    const launch = () => {
      if (settled) return
      if (allFound() || (next >= ids.length && running === 0)) {
        settled = true
        resolve()
        return
      }
      while (running < RUN_CONCURRENCY && next < ids.length) {
        const id = ids[next++]
        running++
        scanWorkers(['--run', id], wanted, found, () => settled || allFound()).then(
          () => {
            running--
            launch()
          },
          (err: unknown) => {
            if (settled) return
            settled = true
            reject(err)
          },
        )
      }
    }
    launch()
  })
}

// 대상 가운데 worker 터미널인 것. {handle: 그 행}
async function lookupWorkers(handles: string[]): Promise<Map<string, Worker>> {
  const found = new Map<string, Worker>()
  const scope = await scanWorkers([], new Set(handles), found)
  const left = handles.filter((h) => !found.has(h))
  if (left.length === 0 || scope === 'all') return found
  const agents: string[] = []
  for (const handle of left) if (await hasAgent(handle)) agents.push(handle)
  if (agents.length === 0) return found
  await scanRuns(await runIds(), new Set(agents), found)
  return found
}

// 그 dispatch 가 첫 화면(신뢰, 업데이트 안내 같은)에서 사람을 기다리는가. 아니면 그 이유를 낸다.
async function firstScreenProblem(dispatchId: string | null): Promise<string | null> {
  if (!dispatchId) return 'worker-list 행에 dispatchId 가 없다'
  let shown: Record<string, unknown>
  try {
    shown = await orcaResult(['orchestration', 'worker-show', '--dispatch', dispatchId])
  } catch (err) {
    if (err instanceof LookupFailure && err.timeout) throw err
    return err instanceof Error ? err.message : String(err)
  }
  const wait = (shown.observation as { agentWait?: unknown } | undefined)?.agentWait
  const detail = ((shown.projection as { stage?: { detail?: unknown } } | undefined)?.stage)?.detail
  return FIRST_SCREEN.test(JSON.stringify([wait ?? null, detail ?? null])) ? null : '일하는 단계다'
}

async function decide(command: string): Promise<string | null> {
  const parsed = staticTargets(command)
  if ('deny' in parsed) return parsed.deny
  if (parsed.targets.size === 0) return null
  try {
    const workers = await lookupWorkers([...parsed.targets.keys()])
    for (const handle of [...workers.keys()].sort()) {
      if (!parsed.targets.get(handle)) return REASON.worker(handle)
      const problem = await firstScreenProblem(workers.get(handle)?.dispatchId ?? null)
      if (problem) return REASON.firstScreen(handle, problem)
    }
    return null
  } catch (err) {
    if (err instanceof LookupFailure) return err.timeout ? REASON.timeout(budget) : REASON.failed(err.message)
    throw err
  }
}

// decide 가 던지면 hook 이 죽어 명령이 그대로 실행된다(fail-open). 무엇이 던져지든 거부로 바꾼다
async function decideClosed(command: string): Promise<string | null> {
  try {
    return await decide(command)
  } catch (err) {
    return REASON.unexpected(err instanceof Error ? err.message : String(err))
  }
}

const command = hookCommand()
const reason = command === null ? null : await decideClosed(command)
const decision = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }
// 아직 도는 조회(마감 시각에 끊고 기다리지 않은 자식)가 이벤트 루프를 붙잡지 않게 출력을 비운 뒤 바로 끝낸다
process.stdout.write(reason === null ? '' : JSON.stringify({ hookSpecificOutput: decision }) + '\n', () => process.exit(0))
