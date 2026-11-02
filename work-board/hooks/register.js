import { STEP, hideEventTag } from './event-tags.js'

// 저장소의 작업 현황을 창과 상태 줄에 보여 준다.
// 두 곳에서 읽는다.
//   1. 수동 항목: 저장소의 board.json(BOARD_PATHS 순서로 찾는다). 갱신은 플러그인의 bin/board.ts 가 한다.
//      형식: { updatedAt: ISO 문자열, items: [{ id, title, status, owner?, pr?, worktree?, next?: {text, done}[], details?: {text, done}[], stepAt? }] }
//      stepAt 은 board.ts 가 그 항목의 status, details, next 를 마지막으로 바꾼 시각이다. worker 없이 남은 단계의 경과 시간을 이 값으로 잰다.
//      worktree 는 그 항목을 맡은 worker 의 워크트리 이름이다. 창이 그 worker 상태를 항목 아래에 붙인다.
//      status: goal(목표), decide(결정 필요), doing(진행 중), wait(대기), done(완료)
//      진행 표시줄은 번호로 시작하는 단계 줄(「1 …」, 「1. …」, done 값이 true 면 완료)을 세어 그린다.
//      details 에 단계 줄이 있으면 그것을, 없으면 next 의 줄을 센다. 참고 줄은 세지 않는다.
//      progress(「끝낸 단계/전체 단계」, 예: 7/10)가 있으면 그 값을 우선한다.
//      창 맨 위에 진행 중(doing) 항목들의 끝낸 단계 합 / 전체 단계 합을 전체 진행률로 그린다.
//      항목은 접혀 「표시 제목 막대」 와 「▶ 지금 단계」, worker 줄만 보인다. d 로 펼치면 끝낸 줄을 취소선으로 보인다.
//   2. 실제 상태: orca orchestration(이 세션이 묶인 run 의 worker 와 답을 기다리는 질문)과 gh(열린 PR, CI).
//      결정 필요 상자에는 worker 의 question 과 worker 가 직접 보낸 escalation 만 넣는다. Orca 자동 알림(autoAlertKind)은 빼고,
//      그 worker 의 줄에 상태로 붙인다(docs/features/board-decision-box/spec.md).
//   3. 업무 알림: 같은 플러그인의 inbox/scripts/inbox.ts board 출력. 받기와 저장소 필터는 inbox 가 하고 창은 그리기만 한다.
//      inbox 설정이 없으면 출력이 {"enabled": false} 라 알림 상자와 단축키를 그리지 않는다.
//   4. 플러그인 버전: 이 mod 가 실린 설치본($.plugin.root)과 원격 main 의 커밋, plugin.json version 을 비교한다.
// 파일은 FILE_MS, 명령은 LIVE_MS, 알림은 INBOX_MS, 최신 버전은 VERSION_MS 마다 다시 읽는다. 창을 열 때도 명령, 알림, 최신 버전을 한 번 읽는다.

const PANE = 'work-board'

// PR 번호를 링크로 그릴 때 쓰는 저장소 주소. 실제 상태를 읽을 때마다 비어 있으면 `gh repo view` 로 읽는다
let repoUrl = ''

let repoUrlLoading = false

// 저장소 주소를 기다리지 않고 읽는다. 실제 상태 읽기를 늦추지 않으려는 것이다. 읽으면 창을 다시 그린다
function loadRepoUrl($) {
  if (repoUrl || repoUrlLoading) return
  repoUrlLoading = true
  run($, ['gh', 'repo', 'view', '--json', 'url', '--jq', '.url'])
    .then((stdout) => {
      repoUrl = stdout.trim()
      if (repoUrl) $.ui.invalidate('ui.render')
    })
    .catch(() => {})
    .finally(() => { repoUrlLoading = false })
}

// 업무 주소 앞에 붙일 머리말. 두레이 주소면 「두레이」, 그 밖은 「업무」 다
export function taskTag(url) {
  return /(^|\.)dooray\.com$/.test(hostOf(url)) ? '두레이' : '업무'
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// 항목의 pr 칸(숫자 하나나 「492, 495」 문자열)에서 PR 번호를 모두 뽑는다
export function prNumbers(value) {
  if (typeof value === 'number') return [value]
  return String(value || '').match(/\d+/g)?.map(Number) || []
}

// 제목을 첫 업무 번호(「#342」) 앞, 번호, 뒤로 나눈다. 번호가 없으면 null
export function splitTaskNumber(title) {
  const match = /#\d+/.exec(String(title || ''))
  if (!match) return null
  return [title.slice(0, match.index), match[0], title.slice(match.index + match[0].length)]
}
const BOARD_PATHS = ['.omc/board.json', '.omc/handoffs/board.json']
const FILE_MS = 5000
const LIVE_MS = 45000
const COMMAND_TIMEOUT_MS = 20000
// bin/worker-marks.ts 는 worker 목록을 다시 읽고 워크트리마다 파일을 훑는다
const MARKS_TIMEOUT_MS = 30000
// inbox.ts 는 1분마다 부르고, 두레이에서 받기는 inbox 설정의 주기(기본 5분)가 지났을 때만 한다(D15)
const INBOX_MS = 60000
// 받는 주기에는 두레이 호출이 수십 번 들 수 있어 다른 명령보다 길게 기다린다
const INBOX_TIMEOUT_MS = 90000
// main 의 최신 커밋은 세션 시작, /board 열 때, 이 주기, 갱신 직후에 읽는다(D2). 네트워크 호출이 시간당 두세 번이다
const VERSION_MS = 30 * 60 * 1000
const VERSION_TIMEOUT_MS = 10000
// claude plugin update 는 저장소를 받아 캐시에 복사한다
const UPDATE_TIMEOUT_MS = 180000
// 알림 상자에 번호를 붙여 보이는 항목 수. 숫자 단축키 1~9 와 맞춘다
const INBOX_ROWS = 9
const QUESTION_HISTORY_LIMIT = 100 // Orca check --all/--peek 의 고정 상한
const REPLY_LIMIT = 200
const SECTIONS = [
  { status: 'goal', label: '목표', color: 'magenta', mark: '★' },
  { status: 'decide', label: '결정 필요', color: 'red', mark: '◆' },
  { status: 'doing', label: '진행 중', color: 'yellow', mark: '▶' },
  { status: 'wait', label: '대기', color: 'cyan', mark: '◇' },
  { status: 'done', label: '완료', color: 'green', mark: '✓' },
]

let board = null
let boardPath = ''
let raw = ''
let now = 0
let expanded = false // d: 항목의 모든 단계와 완료 칸을 펼친다
let authorFilter = '' // a: 열린 PR 을 이 작성자의 것만 보인다. 빈 값은 전체다

// 실제 상태. 읽지 못한 원천은 error 에 이유를 남기고 나머지는 그린다.
// marks 는 bin/worker-marks.ts 의 판정(dispatch 에서 WorkerMark 로), movement 는 그 settings, alertNotes 는 worker 마다의 최근 자동 알림 글이다
let live = { at: 0, runId: '', workers: null, questions: null, prs: null, marks: null, movement: null, alertNotes: [], errors: {} }
let liveBusy = false

// 업무 알림. inbox.ts board --json 의 출력이다. 읽지 못하면 inboxError 에 이유를 두고 직전 값을 그린다
let inbox = null
let inboxError = ''
let inboxBusy = false
// 이 세션에서 알림함이 켜진 것을 본 적이 있는지. 설정이 없는 사용자에게 node 실패를 오류 상자로 보이지 않으려는 것이다(R6)
let inboxSeen = false
// x: 켜져 있으면 숫자 단축키가 답변 요청문 대신 그 알림을 넘긴다. 넘기거나 다시 x 를 누르면 꺼진다
let dismissMode = false
let dismissBusy = false
// z 로 되돌릴 알림 id. 이 세션에서 창이 넘긴 것만 쌓는다
const dismissUndo = []
// 넘김과 되돌리기마다 올린다. 그 전에 시작한 알림 읽기의 결과는 넘긴 항목을 되살리므로 버린다
let inboxGeneration = 0

// 플러그인 버전. install 은 설치본(installOf), latest 는 main 의 { commit, version } 이나 { error }, 아직 읽지 않았으면 undefined
let plugin = { name: '', repository: '', install: null, error: '', latest: undefined }
let versionBusy = false
let updating = false

// ---- 외부 명령 출력을 그릴 값으로 바꾸는 순수 함수(테스트가 직접 부른다) ----

const LIVE_DISPATCH = new Set(['pending', 'dispatched', 'running'])

// 끝난 dispatch. 새 모양은 outcome 이 succeeded·failed 이거나 state 가 abandoned 다
const ENDED_OUTCOME = new Set(['succeeded', 'failed'])

// 일하는 dispatch 인가. 옛 모양은 dispatchStatus, structured 모드의 새 모양은 outcome 과 state 로 본다.
function isLiveWorker(w) {
  if (!w || typeof w !== 'object') return false
  if (w.dispatchStatus !== undefined) return LIVE_DISPATCH.has(w.dispatchStatus)
  if (w.outcome === undefined && w.state === undefined) return false
  return !ENDED_OUTCOME.has(w.outcome) && w.state !== 'abandoned'
}

// worker-list --json 의 결과에서 아직 일하는 worker 만 고른다. 옛 모양(dispatchStatus, resource.worktreeId, agentTerminalHandle, workerState)과
// 새 모양(outcome, state, workspace, terminal)을 모두 읽는다.
export function parseWorkers(stdout) {
  const data = JSON.parse(stdout)
  if (data?.ok === false) throw new Error('worker 목록 조회 실패')
  const workers = (data && data.result && (data.result.workers || data.result.dispatches)) || []
  if (!Array.isArray(workers)) throw new Error('worker 목록을 읽지 못했어요')
  return workers
    .filter(isLiveWorker)
    .map((w) => {
      const tree = (w.resource && w.resource.worktreeId) || w.workspace || ''
      const path = tree.includes('::') ? tree.split('::').pop() : tree
      return {
        id: w.dispatchId,
        terminal: w.agentTerminalHandle || w.terminal || '',
        state: w.workerState || (w.dispatchStatus === undefined ? w.state : '') || '',
        worktree: path.split('/').filter(Boolean).pop() || '',
      }
    })
}

// worker-list 는 페이지를 나눌 수 있다. 한 페이지만 읽어 살아 있는 dispatch 를 빠뜨리면 닫힌 질문이 보드에 남는다.
export async function queryWorkers($, runId) {
  const workers = []
  const cursors = new Set()
  let cursor = ''
  for (;;) {
    const args = ['orca', 'orchestration', 'worker-list', '--run', runId, '--full', '--json']
    if (cursor) args.splice(-1, 0, '--cursor', cursor)
    const data = JSON.parse(await run($, args))
    if (data?.ok === false) throw new Error('worker 목록 조회 실패')
    const result = data?.result || data
    const rows = result.workers || result.dispatches
    if (!Array.isArray(rows)) throw new Error('worker 목록을 읽지 못했어요')
    workers.push(...rows)
    cursor = result.page?.nextCursor || ''
    if (!cursor) break
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('worker 목록의 다음 페이지가 앞 페이지와 같아요')
    cursors.add(cursor)
  }
  return parseWorkers(JSON.stringify({ result: { workers } }))
}

// inbox 의 양방향 thread 기록으로 미답변 질문을 센다. read/ack 는 답변 여부가 아니다.
export function countQuestions(stdout, runId) {
  return parseQuestions(stdout, runId).length
}

// 깨진 JSON 이나 잘린 기록은 조회 오류로 보인다. 임의의 질문 수로 바꾸지 않는다.
// 질문의 thread 에 worker 쪽으로 간 메시지(받는 쪽이 있고 Run 이 아닌 것)가 있으면 답한 질문이다. 보낸 사람은 Run 이든 코디네이터 터미널이든 보지 않는다(ADR-015).
// ask 는 답을 받을 때까지 막혀 worker 하나에 열린 질문은 하나다. 그래서 같은 worker 의 질문은 가장 늦은 미답변 하나로 묶고 repeats 에 나머지 수를 둔다.
// worker 열쇠는 keyOf(m), 없으면 질문의 dispatch(payload.dispatchId, 없으면 `dispatch:` 를 뗀 발신자), 그것도 없으면 그 메시지 id(묶지 않음)다.
// 늦고 이른 것은 created_at 문자열로 비교하고, 같으면 입력 순서가 뒤인 것을 늦은 것으로 본다.
// shown(원본 메시지 → 참거짓)을 주면 보이는 미답변을 그것이 참인 것으로 줄인다. 답 기준선(가장 늦게 답한 질문)은 모든 질문에서 정한다.
// 코디네이터가 더 늦은 자동 알림에 답했으면 그 worker 의 앞선 막힘도 푼 것이다(orch lib/questions.ts 의 unanswered 와 같다).
export function parseQuestions(stdout, runId, keyOf = null, shown = null) {
  const data = JSON.parse(String(stdout).replace(/[\u0000-\u001f]/g, ' '))
  if (data.ok === false) throw new Error('질문 기록 조회 실패')
  const rows = (data.result || data).messages
  if (!Array.isArray(rows) || rows.some((m) => !m || typeof m !== 'object')) throw new Error('질문 기록을 읽지 못했어요')
  const messages = rows.filter((m) => !runId || m.run_id === runId)
  const answered = new Set(messages.filter((m) => m.thread_id && m.id !== m.thread_id
    && m.to_handle && m.to_handle !== 'run:' + (runId || m.run_id)).map((m) => m.thread_id))
  const asked = [...new Map(messages
    .filter((m) => (m.type === 'question' || m.type === 'escalation') && m.id
      && m.to_handle === 'run:' + (runId || m.run_id))
    .map((m) => [m.id, m])).values()]
    .map((m, order) => {
      const payload = payloadOf(m)
      let dispatch = String(payload?.dispatchId || m.from_handle || '').replace(/^dispatch:/, '')
      let text = String(payload?.question || m.body || '')
      const key = (keyOf && keyOf(m)) || dispatch || 'id:' + m.id
      return { id: m.id, type: m.type, dispatch, text: text.trim(), at: m.created_at || '', key, order, answered: answered.has(m.id), message: m }
    })
  const later = (a, b) => (a.at === b.at ? a.order > b.order : a.at > b.at)
  const groups = new Map()
  for (const q of asked) groups.set(q.key, [...(groups.get(q.key) || []), q])
  const pending = []
  for (const group of groups.values()) {
    const last = group.filter((q) => q.answered).reduce((a, b) => (!a || later(b, a) ? b : a), null)
    const open = group.filter((q) => !q.answered && (!last || later(q, last)) && (!shown || shown(q.message)))
    if (open.length === 0) continue
    const newest = open.reduce((a, b) => (later(b, a) ? b : a))
    pending.push({ ...newest, repeats: open.length - 1 })
  }
  return pending.sort((a, b) => a.order - b.order)
    .map(({ id, type, dispatch, text, at, repeats }) => ({ id, type, dispatch, text, at, repeats }))
}

// Orca 가 worker 대신 만드는 자동 알림의 종류. id 접두로 가린다(스펙 D10, 2026-11-02 inbox 실측).
//   msg_stop_<hex>     worker 가 worker_done 없이 턴을 끝냈다(「Worker stopped without reporting」 등)
//   msg_chaterr_<hex>  에이전트 오류(「Agent hit an error: …」)
// worker 가 직접 보낸 메시지는 제목이 같아도 id 가 msg_<hex> 라 자동 알림이 아니다. 아니면 null 이다
export function autoAlertKind(m) {
  const id = String((m && m.id) || '')
  if (id.startsWith('msg_stop_')) return 'stop'
  if (id.startsWith('msg_chaterr_')) return 'error'
  return null
}

const notAutoAlert = (m) => !autoAlertKind(m)

// 턴만 끝낸 멈춤 보고인가. orch/scripts/lib/stop-reports.ts 의 stopReason 과 같은 규칙이다(mod 는 그 파일을 import 하지 못한다).
// payload 의 stopReason 이 있으면 그 값, 없으면 제목으로 정한 값이 finished 면 참이다
const STOP_SUBJECTS = {
  'Worker stopped without reporting': 'finished',
  'Worker stopped on an error without reporting': 'errored',
  'Worker is waiting on a prompt': 'needs-input',
  'Worker exited without reporting': 'exited',
}
function stopReasonOf(m) {
  if (!m || m.type !== 'escalation') return null
  const reason = payloadOf(m)?.stopReason
  return (typeof reason === 'string' && reason ? reason : STOP_SUBJECTS[String(m.subject || '')]) || null
}
export function isQuietStop(m) {
  return stopReasonOf(m) === 'finished'
}

// 멈춤 보고(msg_stop_)의 worker 줄 글. 턴만 끝낸 것(finished)과 모르는 이유는 글이 없다
const STOP_NOTES = { errored: '오류로 멈춤', 'needs-input': '입력 대기', exited: '종료 보고' }

// 자동 알림 하나를 worker 줄 글로. 오류는 「오류: <요약>」, 멈춤 보고는 STOP_NOTES 다. 글이 없으면 ''
export function alertNoteText(m) {
  const kind = autoAlertKind(m)
  if (kind === 'error') return '오류: ' + errorSummary(m)
  if (kind === 'stop') return STOP_NOTES[stopReasonOf(m)] || ''
  return ''
}

// 계정 한도 문구. orch/scripts/lib/sessions.ts 의 LIMIT_LINE 과 같다
const LIMIT_LINE = /usage limit reached|you['’]ve hit your\b.*\blimit|out of credits/iu

// 오류 알림의 요약. 분류어(계정 한도, 모델 용량 부족)나, 분류하지 못하면 오류 첫 줄이다(스펙 D14)
export function errorSummary(m) {
  const payload = payloadOf(m) || {}
  const body = String(m.body || '')
  const errorLine = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('Error:'))
  // 분류는 오류 글에만 한다. 본문 첫 줄의 task 제목에 든 낱말로 잘못 분류하지 않는다
  const said = [payload.error, payload.detail, errorLine].map((v) => String(v || '')).join('\n')
  if (payload.failureKind === 'usageLimitReached' || LIMIT_LINE.test(said)) return '계정 한도'
  if (/at capacity|overloaded/i.test(said)) return '모델 용량 부족'
  const first = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  return questionText(first(payload.error) || (errorLine ? errorLine.slice('Error:'.length).trim() : '') || first(body), 80)
}

function payloadOf(m) {
  if (m.payload && typeof m.payload === 'object' && !Array.isArray(m.payload)) return m.payload
  if (typeof m.payload !== 'string') return null
  try {
    const parsed = JSON.parse(m.payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

function messageRows(stdout) {
  const data = JSON.parse(stdout)
  if (data.ok === false) throw new Error('질문 기록 조회 실패')
  const rows = (data.result || data).messages
  if (!Array.isArray(rows) || rows.some((m) => !m || typeof m !== 'object')) throw new Error('질문 기록을 읽지 못했어요')
  return rows
}

// 질문이 속한 dispatch id 는 payload.dispatchId, 없으면 from_handle 의 `dispatch:` 접두사다. 둘 다 없으면 null 이다.
function dispatchOf(m) {
  const payload = payloadOf(m)
  if (payload && payload.dispatchId) return String(payload.dispatchId)
  const from = String(m.from_handle || '')
  return from.startsWith('dispatch:') ? from.slice('dispatch:'.length) : null
}

// 끝난 dispatch(worker-list 에서 dispatched 가 아닌 것)가 보낸 질문은 다른 경로로 처리됐으므로 세지 않는다.
// 닫힌 dispatch 는 inbox 에 답변이 남지 않아 답해도 줄지 않는다. active 는 살아 있는 worker 의 {id, terminal} 목록이고, null 이면 거르지 않는다.
// dispatch id 를 알 수 없는 질문은 발신 터미널 handle 이 살아 있는 worker 의 것일 때만 센다.
// 전체 inbox 대신 Run 의 질문 후보와 그 질문의 worker handle 만 읽는다.
// Orca 자동 알림(autoAlertKind)은 questions 에 넣지 않고 alerts 로 따로 낸다. 답 기준선에는 넣는다(parseQuestions 의 shown).
// 회신은 `dispatch:<그 worker 터미널의 지금 dispatch>` 로 가서 발신 터미널의 inbox 에 나오지 않는다(ADR-015).
// 그래서 질문마다 발신자, payload 의 dispatch, 그 질문이 붙은 살아 있는 worker 의 dispatch 를 읽는다.
export async function queryQuestions($, runId, active = null) {
  const history = messageRows(await run($, ['orca', 'orchestration', 'check', '--run', runId,
    '--all', '--types', 'question,escalation', '--full', '--json']))
  const unread = messageRows(await run($, ['orca', 'orchestration', 'check', '--run', runId,
    '--peek', '--types', 'question,escalation', '--full', '--json']))
  const ids = active && new Set(active.map((w) => w.id))
  const terminals = active && new Set(active.map((w) => w.terminal).filter(Boolean))
  const alive = (m) => {
    if (!active) return true
    const dispatch = dispatchOf(m)
    return dispatch ? ids.has(dispatch) : terminals.has(m.from_handle)
  }
  // 질문이 붙은 살아 있는 worker 의 id. 질문의 dispatch 가 살아 있으면 그것, 아니면 발신 터미널이 같은 worker 다
  const workerOf = (m) => {
    if (!active) return null
    const dispatch = dispatchOf(m)
    if (dispatch && ids.has(dispatch)) return dispatch
    const worker = active.find((w) => w.terminal && w.terminal === m.from_handle)
    return worker ? worker.id : null
  }
  const candidates = [...new Map([...history, ...unread]
    .filter((m) => m.id && m.run_id === runId && m.to_handle === 'run:' + runId
      && (m.type === 'question' || m.type === 'escalation')
      && alive(m))
    .map((m) => [m.id, m])).values()]
  const handlesOf = (m) => [...new Set([m.from_handle,
    dispatchOf(m) && 'dispatch:' + dispatchOf(m),
    workerOf(m) && 'dispatch:' + workerOf(m)].filter(Boolean))]
  const threads = new Set(candidates.map((m) => m.id))
  const replies = []
  const full = []
  // 같은 handle 은 한 번만 읽는다. 네 개씩 조회해 프로세스 수를 제한한다.
  const handles = [...new Set(candidates.flatMap((m) => {
    const own = handlesOf(m)
    if (own.length === 0) throw new Error('질문 발신자가 없어요')
    return own
  }))]
  for (let i = 0; i < handles.length; i += 4) {
    const batches = await Promise.all(handles.slice(i, i + 4).map(async (handle) => {
      const rows = messageRows(await run($, ['orca', 'orchestration', 'inbox',
        '--terminal', handle, '--limit', String(REPLY_LIMIT), '--full', '--json']))
      if (rows.length >= REPLY_LIMIT) full.push(handle)
      return rows.filter((m) => threads.has(m.thread_id))
    }))
    replies.push(...batches.flat())
  }
  // 한도에 닿은 handle 의 질문이라도 다른 handle 에서 온 회신으로 답한 것이 확인되면 오류가 아니다.
  // 모든 회신을 합쳐도 미답변으로 남는 질문이 있을 때만 잘린 기록에 회신이 있을 수 있다고 본다.
  const unsure = candidates.filter((m) => handlesOf(m).some((handle) => full.includes(handle)))
  if (unsure.length && parseQuestions(JSON.stringify({ messages: [...unsure, ...replies] }), runId, workerOf, notAutoAlert).length) {
    throw new Error('답변 기록 한도에 닿아 답변 여부를 확인할 수 없어요')
  }
  const alerts = candidates.filter((m) => autoAlertKind(m))
  // 답을 기다리는 worker. orch 루프의 askers(snapshot().pending) 와 같은 뜻이다. 턴만 끝낸 멈춤 보고는 세지 않는다.
  // 루프와 다른 점: 살아 있는 worker 의 질문(alive)만 본다. 끝난 dispatch 의 미답변 질문이 남은 터미널에 새 dispatch 가 붙으면
  // 루프는 그 새 worker 를 기다리는 것으로 보고 보드는 멈춤으로 볼 수 있다. 끝난 dispatch 의 답은 읽지 않으므로 맞출 수 없다
  const byId = new Map(candidates.map((m) => [m.id, m]))
  const asking = [...new Set(parseQuestions(JSON.stringify({ messages: [...candidates.filter((m) => !isQuietStop(m)), ...replies] }), runId, workerOf)
    .map((q) => byId.get(q.id))
    .flatMap((m) => (m ? [dispatchOf(m), m.from_handle, workerOf(m)] : []))
    .filter(Boolean))]
  // worker 와 종류(오류, 멈춤 보고)마다 가장 늦은 자동 알림 하나. 같은 알림이 여러 번 와도 한 줄이다
  const notes = new Map()
  for (const m of alerts) {
    const text = alertNoteText(m)
    if (!text) continue
    const worker = workerOf(m) || dispatchOf(m) || m.from_handle
    const kind = autoAlertKind(m)
    const at = Date.parse(m.created_at || '') || 0
    const before = notes.get(worker + '\n' + kind)
    if (!before || at >= before.at) notes.set(worker + '\n' + kind, { worker, kind, at, text, reason: stopReasonOf(m) })
  }
  return {
    questions: parseQuestions(JSON.stringify({ messages: [...candidates, ...replies] }), runId, workerOf, notAutoAlert),
    alerts,
    asking,
    notes: [...notes.values()],
    limited: history.length >= QUESTION_HISTORY_LIMIT || unread.length >= QUESTION_HISTORY_LIMIT,
  }
}

// 질문 본문을 창에 맞게 줄인다
export function questionText(text, limit = 400) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return '본문을 읽지 못했어요'
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
}

// 사용자 결정 질문 형식(첫 줄 `결정:`, 줄 머리 `권장:`)이면 제목과 권장안을 꺼낸다. 아니면 null 이다.
// `결정:` 줄이 여럿이면(spec 인터뷰의 결정 블록 묶음) 첫 결정의 제목 뒤에 「외 N개」 를 붙이고 첫 권장안을 보인다.
export function decisionOf(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim())
  if (!lines[0] || !lines[0].startsWith('결정:')) return null
  const recommend = lines.find((line) => line.startsWith('권장:'))
  const first = lines[0].slice('결정:'.length).trim()
  if (!first) return null
  const more = lines.filter((line) => line.startsWith('결정:')).length - 1
  const title = more > 0 ? `${first} 외 ${more}개` : first
  return { title, recommend: recommend ? recommend.slice('권장:'.length).trim() : null }
}

// 열린 PR 의 작성자 목록(가나다순, 중복 없음)
export function prAuthors(prs) {
  return [...new Set((prs || []).map((pr) => pr.author).filter(Boolean))].sort()
}

// 작성자 거르기의 다음 값. 전체(빈 값) → 작성자 가나다순 → 전체 로 돈다. 지금 값이 목록에 없으면 첫 작성자다
export function nextAuthor(prs, current) {
  const names = prAuthors(prs)
  return names[names.indexOf(current) + 1] || ''
}

// gh pr list --json 의 결과를 PR 한 줄씩으로 바꾼다.
export function parsePullRequests(stdout) {
  const rows = JSON.parse(stdout)
  return rows.map((pr) => {
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []
    let pass = 0
    let fail = 0
    let pending = 0
    const failed = []
    for (const check of checks) {
      const result = String(check.conclusion || check.state || '').toUpperCase()
      if (result === 'SUCCESS' || result === 'SKIPPED' || result === 'NEUTRAL') pass += 1
      else if (result === 'FAILURE' || result === 'ERROR' || result === 'CANCELLED' || result === 'TIMED_OUT') {
        fail += 1
        failed.push(String(check.name || check.context || ''))
      } else pending += 1
    }
    return {
      number: pr.number,
      author: (pr.author && pr.author.login) || '',
      title: pr.title || '',
      branch: pr.headRefName || '',
      draft: Boolean(pr.isDraft),
      merge: pr.mergeStateStatus || '',
      pass,
      fail,
      pending,
      failed,
    }
  })
}

// 워크트리 이름이 브랜치 이름이거나 그 끝(<owner>/<워크트리>)인 PR 을 worker 에 붙인다.
export function prFor(worker, prs) {
  if (!worker.worktree || !Array.isArray(prs)) return null
  return prs.find((pr) => pr.branch === worker.worktree || pr.branch.endsWith('/' + worker.worktree)) || null
}

// 항목의 worktree 와 이름이 같은 worker 를 찾는다.
export function workerFor(item, workers) {
  if (!item || !item.worktree || !Array.isArray(workers)) return null
  return workers.find((worker) => worker.worktree === item.worktree) || null
}

// 어느 항목(완료 제외)에도 붙지 않은 worker 만 고른다.
export function unmappedWorkers(items, workers) {
  if (!Array.isArray(workers)) return workers
  const claimed = new Set(items.filter((item) => item.status !== 'done' && item.worktree).map((item) => item.worktree))
  return workers.filter((worker) => !claimed.has(worker.worktree))
}

// worker 한 줄: 워크트리, 붙은 PR 과 CI, ready 가 아닌 상태.
export function workerLine(worker, prs) {
  const pr = prFor(worker, prs)
  return (worker.worktree || worker.id) + (pr ? '  PR #' + pr.number + ' ' + checkSummary(pr) : '')
    + (worker.state && worker.state !== 'ready' ? '  ' + worker.state : '')
}

const DONE_MARKS = ['✓', '[x]', '[X]']
const LEAD_MARK = /^\s*(✓|\[[xX ]\]|▶|◇)\s*/

// 옛 문자열의 앞 표시를 떼고 객체의 done 값은 그대로 쓴다.
function normalizeLine(line) {
  const object = line && typeof line === 'object'
  const text = object ? String(line.text || '') : String(line)
  const mark = LEAD_MARK.exec(text)
  return { text: text.replace(LEAD_MARK, ''),
    done: object ? line.done === true : Boolean(mark && DONE_MARKS.includes(mark[1])) }
}

function normalizeLines(value) {
  return (Array.isArray(value) ? value : String(value || '').split('\n')).map(normalizeLine)
}

// 단계 줄이면 { number, done } 을, 아니면 null 을 돌려준다.
export function parseStep(line) {
  const normalized = normalizeLine(line)
  const match = STEP.exec(normalized.text)
  return match ? { number: Number(match[2]), done: normalized.done } : null
}

// 항목의 details 와 next 를 줄마다 나눠 상태를 붙인다. 빈 줄은 뺀다
// state: done(끝낸 줄), now(지금 단계), todo(남은 단계), note(번호 없는 참고 줄)
// step 은 단계 줄인지, counted 는 진행률을 세는 쪽(details 에 단계가 있으면 details, 아니면 next)의 줄인지다
// 지금 단계는 세는 쪽의 끝나지 않은 첫 단계다
// 거기 없으면 다른 쪽의 끝나지 않은 첫 단계, 단계 줄이 하나도 없으면 첫 참고 줄을 지금 단계로 둔다
// 단계가 모두 끝났으면 지금 단계는 없다
export function stepRows(item) {
  const details = normalizeLines(item.details)
  const counted = stepProgress(details) ? 'details' : 'next'
  const rows = [
    ...details.map((line) => ({ ...line, from: 'details' })),
    ...normalizeLines(item.next).map((line) => ({ ...line, from: 'next' })),
  ]
    .filter((row) => row.text.trim())
    .map((row) => {
      const text = row.text.trim()
      const step = Boolean(parseStep(text))
      return { text: hideEventTag(text), state: row.done ? 'done' : step ? 'todo' : 'note', step, counted: row.from === counted }
    })
  let current = rows.findIndex((row) => row.state === 'todo' && row.counted)
  if (current < 0) current = rows.findIndex((row) => row.state === 'todo')
  if (current < 0 && !rows.some((row) => row.step)) current = rows.findIndex((row) => row.state === 'note')
  return rows.map((row, i) => (i === current ? { ...row, state: 'now' } : row))
}

// 접힌 보기에 쓸 요약: 지금 단계 줄, 끝낸 단계 수, 지금 단계 뒤에 남은 단계 수
// 막대와 수가 맞도록 진행률을 세는 쪽의 단계 줄만 센다. 지금 단계가 다른 쪽에서 왔으면 남은 단계는 그쪽에서 센다
// progress(「N/M」, 항목의 progress 필드)를 주면 막대가 그 값을 쓰므로 수도 그 값에서 낸다
export function stepSummary(rows, progress) {
  const current = rows.find((row) => row.state === 'now') || null
  const match = PROGRESS.exec(String(progress || ''))
  if (match && Number(match[2]) > 0) {
    const total = Number(match[2])
    const done = Math.min(Number(match[1]), total)
    return { now: current, done, todo: Math.max(0, total - done - (current && current.step ? 1 : 0)) }
  }
  const side = current ? current.counted : true
  return {
    now: current,
    done: rows.filter((row) => row.counted && row.step && row.state === 'done').length,
    todo: rows.filter((row) => row.counted === side && row.state === 'todo').length,
  }
}

// 단계 줄의 표시 칸 폭과 그 칸에 그릴 표시. 본문의 앞 표시(✓ [x] [ ] ▶ ◇)는 이 칸으로 옮긴다
export const STEP_MARK_WIDTH = 2
export function stepMark(row) {
  return row.state === 'done' ? '✓' : row.state === 'now' ? '▶' : ' '
}
export function stepBody(text) {
  return String(text).replace(LEAD_MARK, '')
}

// 줄 가운데 단계 줄을 세어 「끝낸/전체」 문자열로 돌려준다. 단계가 없으면 null
export function stepProgress(lines) {
  if (!Array.isArray(lines)) return null
  const steps = lines.map(parseStep).filter(Boolean)
  if (steps.length === 0) return null
  return steps.filter((step) => step.done).length + '/' + steps.length
}

const PROGRESS = /^\s*(\d+)\s*\/\s*(\d+)\s*$/

// progress 가 「N/M」 이면 그 값을, 아니면 details 의 단계, 그것도 없으면 next 의 줄을 센다. 없으면 null
export function itemProgress(item) {
  const match = PROGRESS.exec(String(item.progress || ''))
  if (match && Number(match[2]) > 0) return Math.min(Number(match[1]), Number(match[2])) + '/' + Number(match[2])
  return stepProgress(item.details) || stepProgress(normalizeLines(item.next))
}

// 진행 중 항목들의 끝낸 단계 합과 전체 단계 합. missing 은 진행률이 없는 진행 중 항목 수다
export function overallProgress(items) {
  let done = 0
  let total = 0
  let missing = 0
  for (const item of items.filter((row) => row.status === 'doing')) {
    const match = PROGRESS.exec(itemProgress(item) || '')
    if (!match) missing += 1
    else {
      done += Number(match[1])
      total += Number(match[2])
    }
  }
  return { done, total, missing }
}

// 「7/10」 을 진행 표시줄 한 줄로 바꾼다. 형식이 틀리면 null.
export function progressBar(progress, width = 20) {
  const match = PROGRESS.exec(String(progress || ''))
  if (!match) return null
  const total = Number(match[2])
  const done = Math.min(Number(match[1]), total)
  if (total <= 0) return null
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled) + ' ' + done + '/' + total + ' (' + Math.round((done / total) * 100) + '%)'
}

// PR 한 줄의 CI 요약.
// 머지에 필요 없는 검사. 이것만 실패한 UNSTABLE 은 머지 가능으로 본다(pr-merge 스킬의 규칙)
const OPTIONAL_CHECKS = ['claude-review']

// PR 하나의 머지 판정. rank 는 정렬 순서다(작을수록 위)
export function mergeVerdict(pr) {
  const blocking = (pr.failed || []).filter((name) => !OPTIONAL_CHECKS.includes(name))
  if (pr.merge === 'DIRTY') return { label: '충돌', color: 'red', rank: pr.draft ? 4 : 2 }
  if (blocking.length > 0) return { label: 'CI 실패', color: 'red', rank: pr.draft ? 4 : 2 }
  if (pr.pending > 0) return { label: '검사 중', color: 'yellow', rank: pr.draft ? 4 : 1 }
  if (pr.merge === 'BEHIND') return { label: 'main 뒤처짐', color: 'yellow', rank: pr.draft ? 4 : 1 }
  const clean = pr.merge === 'CLEAN' || pr.merge === 'UNSTABLE' || pr.merge === 'HAS_HOOKS'
  if (pr.draft) return { label: clean ? 'CI 통과, Ready 전' : pr.merge || '상태 모름', color: undefined, rank: 3 }
  return clean
    ? { label: '머지 가능', color: 'green', rank: 0 }
    : { label: pr.merge || '상태 모름', color: 'yellow', rank: 1 }
}

// CI 를 통과했는가. orch 루프의 ciState(orch/scripts/lib/gh.ts)처럼 선택 검사를 포함해 실패가 하나라도 있으면 통과가 아니다
export function ciPassed(pr) {
  return pr.pass + pr.fail + pr.pending > 0 && pr.fail === 0 && pr.pending === 0
}

// CI 를 통과해 머지를 기다리는 worker 의 id
export function mergingIds(workers, prs) {
  return (workers || []).filter((worker) => {
    const pr = prFor(worker, prs)
    return Boolean(pr && ciPassed(pr))
  }).map((worker) => worker.id)
}

// bin/worker-marks.ts 를 부르는 명령
export function marksArgv(script, repo, runId, asking, merging, questionsUnknown) {
  return ['node', '--disable-warning=ExperimentalWarning', script, '--repo', repo,
    ...(runId ? ['--run', runId] : []),
    ...asking.flatMap((id) => ['--asking', id]),
    ...merging.flatMap((id) => ['--merging', id]),
    ...(questionsUnknown ? ['--questions-unknown'] : [])]
}

// bin/worker-marks.ts 의 출력. 형식이 다르면 던진다
export function parseMarks(stdout) {
  const value = JSON.parse(stdout)
  const settings = value && value.settings
  if (!settings || typeof settings !== 'object' || typeof settings.idleMin !== 'number' || !Array.isArray(value.workers)) {
    throw new Error('판정 출력 형식이 달라요')
  }
  const marks = {}
  for (const mark of value.workers) if (mark && mark.dispatch) marks[mark.dispatch] = mark
  return { settings, marks, error: value.error || null }
}

// 경과 분을 「N분」, 「N시간」, 「N일」 로
export function spanText(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0))
  if (m < 60) return m + '분'
  if (m < 24 * 60) return Math.floor(m / 60) + '시간'
  return Math.floor(m / (24 * 60)) + '일'
}

// worker 줄 끝에 붙일 글. 멈춤(R4)과 최근 자동 알림(R5 의 오류, 그 밖의 멈춤 보고)이다.
// 자동 알림은 그 뒤 워크트리 파일이나 커밋이 바뀌었으면(workedAt) 빼고, 판정을 모르면 남긴다.
// 터미널 종료로 이미 멈춤인 worker 에는 같은 뜻의 「종료 보고」 를 붙이지 않는다
export function workerNotes(worker, marks, alertNotes) {
  const notes = []
  const mark = marks ? marks[worker.id] : null
  if (mark && mark.reason === 'idle') notes.push('멈춤 ' + spanText(mark.idleMin))
  else if (mark && mark.reason === 'exited') notes.push('멈춤 · 터미널 종료')
  const own = (alertNotes || []).filter((note) => note.worker === worker.id)
    .filter((note) => !(note.reason === 'exited' && mark && mark.reason === 'exited'))
    .filter((note) => !mark || typeof mark.workedAt !== 'number' || mark.workedAt <= note.at)
  // 오류를 멈춤 보고보다 앞에 둔다
  for (const kind of ['error', 'stop']) for (const note of own.filter((n) => n.kind === kind)) notes.push(note.text)
  return notes
}

// doing 항목에 끝나지 않은 단계가 있고 stepAt 부터 idleMin 분 넘게 지났으면 그 분을, 아니면 null 을 낸다(R6).
// rows 는 stepRows(item) 이다. stepAt 이 없는 옛 항목과 idleMin 0(보지 않는다)은 null 이다
export function idleStepMinutes(item, rows, at, idleMin) {
  if (!item || item.status !== 'doing' || !(idleMin > 0)) return null
  if (!rows.some((row) => row.step && row.state !== 'done')) return null
  const since = Date.parse(item.stepAt || '')
  if (!Number.isFinite(since) || at - since < idleMin * 60000) return null
  return Math.floor((at - since) / 60000)
}

// 맡은 worker 가 없는 항목의 worker 줄 글
export function workerNoneText(item, rows, at, idleMin) {
  const minutes = idleStepMinutes(item, rows, at, idleMin)
  return '⚙ worker 없음' + (minutes === null ? '' : ' · ' + spanText(minutes)) + ' (' + item.worktree + ')'
}

export function sortPullRequests(prs) {
  return [...prs].sort((a, b) => mergeVerdict(a).rank - mergeVerdict(b).rank || a.number - b.number)
}

export function checkSummary(pr) {
  const total = pr.pass + pr.fail + pr.pending
  if (total === 0) return 'CI 없음'
  const parts = ['CI ' + pr.pass + '/' + total]
  if (pr.fail > 0) parts.push('실패 ' + pr.fail)
  if (pr.pending > 0) parts.push('진행 ' + pr.pending)
  return parts.join(' · ')
}

// decide 항목의 남은 결정 수. 항목마다 details 와 next 의 끝나지 않은 줄을 세고, 줄이 없는 항목은 1 로 센다(ADR-015)
export function decideCount(items) {
  return items.filter((item) => item.status === 'decide').reduce((sum, item) => {
    const lines = [...normalizeLines(item.details), ...normalizeLines(item.next)].filter((line) => line.text.trim())
    return sum + (lines.length === 0 ? 1 : lines.filter((line) => !line.done).length)
  }, 0)
}

// ---- 업무 알림 ----

export const INBOX_KIND_LABELS = { mention: '멘션', assigned: '담당', cc: '참조' }
const INBOX_SOURCE_LABELS = { 'dooray:task': '두레이 업무', 'dooray:messenger': '두레이 메신저', 'dooray:auth': '두레이 인증', inbox: '알림함', filter: '알림 필터' }

// inbox.ts board --json 출력을 읽는다. 형식이 다르면 던진다
export function parseInbox(stdout) {
  const value = JSON.parse(stdout)
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('inbox.ts 출력에 enabled 가 없어요')
  if (value.enabled && !Array.isArray(value.items)) throw new Error('inbox.ts 출력에 items 가 없어요')
  return value
}

// 오류 출처(「dooray:messenger」)를 사람이 읽는 이름으로
export function inboxSourceLabel(source) {
  return INBOX_SOURCE_LABELS[source] || source
}

// 항목 앞 머리말. 두레이 메신저는 「메신저」, 두레이 업무는 「두레이」, 다른 adapter 는 그 이름이다
export function inboxTag(item) {
  if (item.adapter === 'dooray') return item.source === 'messenger' ? '메신저' : '두레이'
  return item.adapter
}

// 알림 상자를 그릴지. 켜진 출력이 있거나, 켜진 것을 본 뒤 명령이 실패했을 때만 그린다
export function inboxBoxVisible(state, error, seen) {
  return inboxSummary(state).show || Boolean(error && seen)
}

// 상자 머리 「알림 n」 과 그릴지. 설정이 없으면(enabled false) 그리지 않는다
export function inboxSummary(state) {
  if (!state || !state.enabled) return { show: false, newCount: 0 }
  return { show: true, newCount: Number(state.newCount) || 0 }
}

// 알림 상자에 그릴 항목과 숨긴 「답함」 수. 답한 알림은 목록에서 빼고 수만 보인다
export function inboxRows(items) {
  const rows = Array.isArray(items) ? items : []
  return { shown: rows.filter((item) => item.state !== 'answered'), answered: rows.filter((item) => item.state === 'answered').length }
}

// 항목 하나에 답하는 요청문. 숫자 단축키가 입력란에 채운다
export function replyPrompt(item) {
  const who = (item.from && (item.from.name || item.from.id)) || '보낸 사람'
  return [
    '업무 알림 ' + item.id + ' 에 답변을 준비해 줘. (' + item.title + ', ' + who + '의 ' + (INBOX_KIND_LABELS[item.kind] || item.kind) + ')',
    '1. fos-skills 플러그인의 inbox 스킬 절차를 따라 inbox.ts context ' + item.id + ' 로 본문과 앞 대화를 읽어 줘. 사람은 이름으로 풀린 값만 써.',
    '2. 묻는 것과 내가 답할 것을 한 줄로 정리하고 답변 초안을 써 줘. 받는 사람 멘션과 AI 작성 표기는 inbox.ts 가 붙이니 본문에 넣지 마.',
    '3. inbox.ts reply ' + item.id + ' --body-file <초안> (--yes 없이) 로 합성한 본문을 미리보기로 보여 주고 내 확인을 받아 줘. 확인 전에는 등록하지 마.',
    '4. 내가 확인하면 같은 명령에 --yes 를 붙여 등록하고 주소를 알려 줘. 답할 필요가 없다고 하면 inbox.ts dismiss ' + item.id + ' 로 넘겨 줘.',
  ].join('\n')
}

// 넘긴 항목을 뺀 알림 상태. 다음 읽기를 기다리지 않고 상자에서 바로 지운다
export function withoutItems(state, ids) {
  if (!state || !Array.isArray(state.items)) return state
  const gone = new Set(ids)
  const removedNew = state.items.filter((item) => gone.has(item.id) && item.state === 'new').length
  return { ...state, items: state.items.filter((item) => !gone.has(item.id)), newCount: Math.max(0, (Number(state.newCount) || 0) - removedNew) }
}

// inbox.ts dismiss 명령. 보드는 inbox 와 같은 넘김 기록(dismissed.json)을 쓴다
export function dismissArgv(script, id, undo = false) {
  return ['node', '--disable-warning=ExperimentalWarning', script, 'dismiss', id, ...(undo ? ['--undo'] : [])]
}

// 새 알림을 모두 훑는 요청문. i 가 입력란에 채운다
export const INBOX_PROMPT = [
  '업무 알림함의 새 항목을 훑어 줘.',
  '1. fos-skills 플러그인의 inbox 스킬 절차를 따라 이 저장소의 보드 기준으로 inbox.ts board --repo <이 저장소의 주 checkout> 를 읽어 줘.',
  '2. 새 항목마다 묻는 것을 한 줄로 정리하고, 답할 것과 넘길 것(답할 필요 없음)을 나눠 보여 줘.',
  '3. 넘길 것은 내 확인을 받아 inbox.ts dismiss 로 넘기고, 답할 것은 하나씩 초안, 미리보기, 내 확인 순서로 진행해 줘. 확인 전에는 등록하지 마.',
].join('\n')

// ---- 플러그인 버전 ----
// 지금 세션이 읽은 설치본($.plugin.root)과 main 의 최신 커밋을 비교해 머리 줄에 보인다.
// 설치본이 마켓플레이스 캐시면 같은 설정 폴더의 installed_plugins.json 에서 scope 와 커밋을 읽고, 그 scope 로 갱신한다.

// 마켓플레이스 캐시 폴더 <설정 폴더>/plugins/cache/<마켓>/<플러그인>/<버전> 에서 설정 폴더를 뽑는다. 캐시가 아니면 ''
export function configDirOf(root) {
  const marker = '/plugins/cache/'
  const at = String(root || '').lastIndexOf(marker)
  return at > 0 ? root.slice(0, at) : ''
}

// installed_plugins.json 과 설치본 plugin.json 으로 설치본을 정한다.
// kind 는 cache(마켓플레이스 설치본)나 tree(--plugin-dir 로 읽은 작업 트리)다. 캐시인데 기록에 없으면 null
export function installOf(root, installed, manifest, name) {
  const version = manifest && typeof manifest.version === 'string' ? manifest.version : ''
  if (!configDirOf(root)) return { kind: 'tree', version, commit: '', scope: '', projectPath: '', key: '' }
  const plugins = (installed && installed.plugins) || {}
  const candidates = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!key.startsWith(name + '@') || !Array.isArray(entries)) continue
    for (const entry of entries) if (entry) candidates.push({ key, entry })
  }
  // Orca 계정 프로필의 plugins 는 같은 캐시를 가리킬 수 있다. 정확한 경로를 먼저 찾는다.
  const tail = (value) => typeof value === 'string' && configDirOf(value)
    ? value.slice(configDirOf(value).length) : ''
  const aliases = candidates.filter(({ entry }) => tail(entry.installPath) === tail(root))
  // 프로필 경로만 다르면 user 설치를 우선하고, 그 밖에는 설치 기록 순서를 유지한다.
  const found = candidates.find(({ entry }) => entry.installPath === root)
    || aliases.find(({ entry }) => entry.scope === 'user') || aliases[0]
  if (!found) return null
  const { key, entry } = found
  return { kind: 'cache', version, commit: String(entry.gitCommitSha || ''), scope: String(entry.scope || ''),
    projectPath: String(entry.projectPath || ''), key }
}

// git ls-remote <저장소> refs/heads/main 출력의 커밋. 없으면 던진다
export function parseLsRemote(stdout) {
  const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(String(stdout || ''))
  if (!match) throw new Error('main 커밋을 읽지 못했어요')
  return match[1]
}

// GitHub 저장소 주소면 그 커밋의 plugin.json 원문 주소. 아니면 ''
export function rawManifestUrl(repository, commit) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/.]+?)(\.git)?\/?$/.exec(String(repository || ''))
  return match && commit ? 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + commit + '/.claude-plugin/plugin.json' : ''
}

// 최신 여부. 둘 다 version 이 있으면 version 으로, 아니면 커밋으로 비교한다.
// version 을 올리지 않은 커밋은 update 가 받지 않으므로 커밋만 다를 때 뒤처졌다고 하지 않는다(docs/features/board-plugin-version/spec.md)
export function versionState(install, latest) {
  if (!install) return 'unknown'
  if (!latest || latest.error || !latest.commit) return 'unknown'
  if (install.version && latest.version) return install.version === latest.version ? 'latest' : 'behind'
  if (!install.commit) return 'unknown'
  return install.commit === latest.commit ? 'latest' : 'behind'
}

// 「1.4.0 (b1e2c09)」. version 이 없으면 커밋만, 둘 다 없으면 ''
export function versionText(version, commit) {
  const short = String(commit || '').slice(0, 7)
  if (version && short) return version + ' (' + short + ')'
  return version || short
}

// 머리 줄에 붙일 버전 글과 색. latest 가 undefined 면 아직 확인하지 않은 것이다
export function versionLabel(name, install, latest, error = '') {
  if (!install) return { text: name + ' 설치본 확인 불가' + (error ? ': ' + error : ''), color: undefined, dim: true }
  const own = install.kind === 'tree' ? name + ' 작업 트리 ' + versionText(install.version, install.commit) : name + ' ' + versionText(install.version, install.commit)
  if (latest === undefined) return { text: own.trim() + ' · 최신 확인 중', color: undefined, dim: true }
  const state = versionState(install, latest)
  if (state === 'latest') return { text: own.trim() + ' 최신', color: undefined, dim: true }
  if (state === 'behind') {
    return { text: own.trim() + ' → 최신 ' + versionText(latest.version, latest.commit) + (install.kind === 'cache' ? ' · p 로 갱신' : ''), color: 'yellow', dim: false }
  }
  return { text: own.trim() + ' · 최신 확인 불가', color: undefined, dim: true }
}

// 갱신 명령과 그 명령을 돌릴 폴더. project·local scope 는 그 프로젝트 폴더에서 돌린다. 작업 트리는 갱신하지 않는다(null)
export function updateCommand(install) {
  if (!install || install.kind !== 'cache' || !install.key || !install.scope) return null
  return {
    argv: ['claude', 'plugin', 'update', install.key, '--scope', install.scope],
    cwd: install.scope === 'user' ? '' : install.projectPath,
  }
}

// p 단축키를 보일지. 갱신할 수 있는 설치본이고 최신으로 확인되지 않았을 때만 보인다
export function updateVisible(install, latest) {
  return Boolean(updateCommand(install)) && versionState(install, latest) !== 'latest'
}

// 상태 줄 한 줄. 실제 상태와 수동 항목을 함께 센다. 새 업무 알림이 있으면 맨 앞에 「알림 n」 을 붙인다
export function statusLine(items, state, inboxState = null) {
  const count = (status) => items.filter((item) => item.status === status).length
  const parts = []
  const alerts = inboxSummary(inboxState).newCount
  if (alerts > 0) parts.push('알림 ' + alerts)
  const decide = decideCount(items) + (Array.isArray(state.questions) ? state.questions.length : state.questions || 0)
  if (state.errors && state.errors.questions) parts.push('결정 필요 확인 불가')
  else if (decide > 0 || state.questionsLimited) parts.push('결정 필요 ' + decide + (state.questionsLimited ? '(최근 질문 기준)' : ''))
  if (Array.isArray(state.workers)) parts.push('worker ' + state.workers.length)
  if (Array.isArray(state.prs)) {
    const failing = state.prs.filter((pr) => pr.fail > 0).length
    parts.push('PR ' + state.prs.length + (failing > 0 ? '(CI 실패 ' + failing + ')' : ''))
  }
  if (count('doing') > 0) parts.push('진행 ' + count('doing'))
  if (count('wait') > 0) parts.push('대기 ' + count('wait'))
  return parts.length === 0 ? '' : parts.join(' · ') + '   /board'
}

// ---- 읽기 ----

async function run($, argv, timeoutMs = COMMAND_TIMEOUT_MS) {
  const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(argv, { timeoutMs })
  if (exitCode !== 0) throw new Error((stderr || stdout || '종료 코드 ' + exitCode).trim().split('\n')[0])
  if (isStdoutTruncated) throw new Error('명령 출력이 4 MiB 한도에서 잘렸어요')
  return stdout
}

// 상태 줄은 글이 바뀔 때만 보낸다. SDK(stream-json)로 실린 세션은 $.ui.status 마다 ui_status 메시지를 host 에 보내고,
// 그 메시지를 그리지 못하는 host(Orca 의 채팅 view 등)에서는 같은 원문 JSON 줄이 5초마다 쌓인다
let sentStatus
function refreshStatus($) {
  const items = board && Array.isArray(board.items) ? board.items : []
  const text = statusLine(items, live, inbox)
  if (sentStatus !== text) {
    sentStatus = text
    $.ui.status(text)
  }
  $.ui.invalidate('ui.render')
}

// 세션 cwd 가 워크트리로 옮겨 가도 같은 board.json 을 읽도록, 주 checkout 의 root 를 찾는다
let rootCwd = null
let rootDir = ''
export function mainRoot(commonDir) {
  const dir = String(commonDir || '').trim().replace(/\/+$/, '')
  return dir.endsWith('/.git') ? dir.slice(0, -5) : ''
}
async function boardRoot($) {
  const cwd = await $.session.cwd()
  if (cwd !== rootCwd) {
    rootCwd = cwd
    try {
      rootDir = mainRoot(await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']))
    } catch {
      rootDir = ''
    }
  }
  return rootDir
}

async function loadFile($) {
  now = await $.clock.now()
  let found = ''
  let text = ''
  const root = await boardRoot($)
  for (const relative of BOARD_PATHS) {
    const candidate = root ? root + '/' + relative : relative
    if (await $.fs.exists(candidate)) {
      found = candidate
      text = await $.fs.read(candidate)
      break
    }
  }
  if (!found) {
    board = null
    boardPath = ''
    raw = ''
  } else if (found !== boardPath || text !== raw) {
    boardPath = found
    raw = text
    try {
      board = JSON.parse(text)
    } catch (failure) {
      board = { items: [], error: String(failure && failure.message ? failure.message : failure) }
    }
  }
  refreshStatus($)
}

async function loadLive($) {
  if (liveBusy) return
  liveBusy = true
  const next = { at: 0, runId: '', workers: null, questions: null, prs: null, marks: null, movement: null, alertNotes: [], errors: {} }
  let asking = []
  try {
    try {
      const current = JSON.parse(await run($, ['orca', 'orchestration', 'run-current', '--full', '--json']))
      const runInfo = current && current.result && current.result.run
      next.runId = runInfo && runInfo.id ? runInfo.id : ''
    } catch (failure) {
      next.errors.workers = String(failure.message || failure)
    }
    if (next.runId) {
      try {
        next.workers = await queryWorkers($, next.runId)
      } catch (failure) {
        next.errors.workers = String(failure.message || failure)
      }
      try {
        // 끝난 dispatch 의 질문을 거르려면 살아 있는 dispatch 목록이 있어야 한다
        if (!next.workers) throw new Error('worker 목록을 읽지 못해 질문을 가릴 수 없어요')
        const result = await queryQuestions($, next.runId, next.workers)
        next.questions = result.questions
        next.questionsLimited = result.limited
        next.alertNotes = result.notes
        asking = result.asking
      } catch (failure) {
        next.errors.questions = String(failure.message || failure)
      }
    }
    loadRepoUrl($)
    try {
      next.prs = parsePullRequests(await run($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '30',
        '--json', 'number,title,isDraft,mergeStateStatus,headRefName,statusCheckRollup,author']))
    } catch (failure) {
      next.errors.prs = String(failure.message || failure)
    }
    // worker 줄의 멈춤 판정. orch 상주 루프와 같은 함수와 같은 입력이다(bin/worker-marks.ts 머리 주석)
    try {
      const root = await boardRoot($)
      if (root) {
        const argv = marksArgv($.plugin.root + '/work-board/bin/worker-marks.ts', root, next.workers ? next.runId : '', asking,
          mergingIds(next.workers || [], next.prs), Boolean(next.errors.questions))
        const marks = parseMarks(await run($, argv, MARKS_TIMEOUT_MS))
        next.marks = marks.marks
        next.movement = marks.settings
        if (marks.error) next.errors.marks = marks.error
      }
    } catch (failure) {
      next.errors.marks = String(failure.message || failure)
    }
    try {
      next.at = await $.clock.now()
    } catch {
      // 세션이 끝난 뒤 늦게 끝난 읽기다. host 가 호출을 거절하므로 앞 상태를 그대로 둔다
      return
    }
    live = next
  } finally {
    liveBusy = false
  }
  refreshStatus($)
}

// 업무 알림을 읽는다. 받기와 필터는 inbox.ts 가 하고, 여기서는 주 checkout 경로만 넘긴다
async function loadInbox($) {
  if (inboxBusy) return
  inboxBusy = true
  const generation = inboxGeneration
  let stale = false
  try {
    const root = (await boardRoot($)) || (await $.session.cwd())
    const script = $.plugin.root + '/inbox/scripts/inbox.ts'
    const value = parseInbox(await run($, ['node', '--disable-warning=ExperimentalWarning', script, 'board', '--repo', root, '--json'], INBOX_TIMEOUT_MS))
    stale = generation !== inboxGeneration
    if (!stale) {
      inbox = value
      if (inbox.enabled) inboxSeen = true
      inboxError = ''
    }
  } catch (failure) {
    stale = generation !== inboxGeneration
    if (!stale) inboxError = String(failure.message || failure)
  } finally {
    inboxBusy = false
  }
  if (stale) return loadInbox($)
  refreshStatus($)
}

// x 다음 숫자: 알림을 넘긴다. inbox.ts dismiss 를 불러 같은 넘김 기록에 적고, 상자에서 바로 뺀 뒤 z 로 되돌릴 수 있게 쌓는다
export async function dismissInbox($, id) {
  dismissMode = false
  if (dismissBusy) return $.ui.invalidate('ui.render')
  dismissBusy = true
  try {
    await run($, dismissArgv($.plugin.root + '/inbox/scripts/inbox.ts', id))
    inboxGeneration++
    inbox = withoutItems(inbox, [id])
    dismissUndo.push(id)
    $.ui.toast('알림을 넘겼어요. z 를 누르면 되돌려요')
  } catch (failure) {
    $.ui.toast('알림 넘기기 실패: ' + String(failure.message || failure))
  } finally {
    dismissBusy = false
  }
  refreshStatus($)
}

// z: 이 세션에서 마지막으로 넘긴 알림을 되돌린다. 되돌린 항목은 다시 읽어 상자에 그린다
export async function undoDismiss($) {
  const id = dismissUndo[dismissUndo.length - 1]
  if (dismissBusy || !id) return
  dismissBusy = true
  try {
    await run($, dismissArgv($.plugin.root + '/inbox/scripts/inbox.ts', id, true))
    inboxGeneration++
    dismissUndo.pop()
    $.ui.toast('넘김을 되돌렸어요')
  } catch (failure) {
    $.ui.toast('넘김 되돌리기 실패: ' + String(failure.message || failure))
  } finally {
    dismissBusy = false
  }
  await loadInbox($)
}

// 설치본을 읽는다. 설치본은 세션 동안 바뀌지 않는다(갱신해도 /reload-plugins 전까지는 앞 설치본이 실려 있다)
async function loadInstall($) {
  const root = $.plugin.root
  try {
    const manifest = JSON.parse(await $.fs.read(root + '/.claude-plugin/plugin.json'))
    plugin.name = String(manifest.name || $.plugin.name || '')
    plugin.repository = String(manifest.repository || '')
    const config = configDirOf(root)
    const installed = config ? JSON.parse(await $.fs.read(config + '/plugins/installed_plugins.json')) : null
    const install = installOf(root, installed, manifest, plugin.name)
    if (!install) throw new Error('installed_plugins.json 에 이 설치본이 없어요')
    if (install.kind === 'tree') {
      try {
        install.commit = (await run($, ['git', '-C', root, 'rev-parse', 'HEAD'])).trim()
      } catch {}
    }
    plugin.install = install
    plugin.error = ''
  } catch (failure) {
    plugin.install = null
    plugin.error = String(failure.message || failure)
  }
}

// main 의 최신 커밋과 그 커밋의 plugin.json version 을 읽는다. 실패하면 { error } 를 두고 다음 주기에 다시 읽는다
async function loadLatest($) {
  if (versionBusy || !plugin.repository) return
  versionBusy = true
  try {
    const commit = parseLsRemote(await run($, ['git', 'ls-remote', plugin.repository, 'refs/heads/main'], VERSION_TIMEOUT_MS))
    let version = ''
    const url = rawManifestUrl(plugin.repository, commit)
    if (url) {
      try {
        const manifest = JSON.parse(await run($, ['curl', '-fsSL', '--max-time', String(VERSION_TIMEOUT_MS / 1000), url], VERSION_TIMEOUT_MS + 2000))
        version = typeof manifest.version === 'string' ? manifest.version : ''
      } catch {}
    }
    plugin.latest = { commit, version }
  } catch (failure) {
    plugin.latest = { error: String(failure.message || failure) }
  } finally {
    versionBusy = false
  }
  $.ui.invalidate('ui.render')
}

// p: 이 세션이 읽은 설치본의 scope 로 갱신하고, 성공하면 입력란에 /reload-plugins 를 채운다. 실패하면 toast 에 이유를 보이고 입력란은 그대로다
export async function updatePlugin($, install = plugin.install) {
  const command = updateCommand(install)
  if (!command || updating) return
  updating = true
  $.ui.toast((plugin.name || $.plugin.name) + ' 플러그인을 갱신하는 중이에요')
  $.ui.invalidate('ui.render')
  try {
    const { exitCode, stdout, stderr } = await $.process.run(command.argv,
      { timeoutMs: UPDATE_TIMEOUT_MS, ...(command.cwd ? { cwd: command.cwd } : {}) })
    if (exitCode !== 0) throw new Error((stderr || stdout || '종료 코드 ' + exitCode).trim().split('\n').pop())
    void $.prompt.fill({ text: '/reload-plugins' })
    $.ui.toast('갱신했어요. Enter 를 누르면 /reload-plugins 로 새 설치본을 읽어요')
  } catch (failure) {
    $.ui.toast('플러그인 갱신 실패: ' + String(failure.message || failure))
  } finally {
    updating = false
  }
  await loadLatest($)
}

function ago(at) {
  const time = typeof at === 'number' ? at : Date.parse(at || '')
  if (!time) return '-'
  const minutes = Math.max(0, Math.round((now - time) / 60000))
  if (minutes < 1) return '방금'
  if (minutes < 60) return minutes + '분 전'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + '시간 전'
  return Math.floor(hours / 24) + '일 전'
}

// ---- 훅 ----

// 「오늘 시작」, 「정할 것 묻기」 버튼이 입력란에 채우는 요청문. 사용자가 Enter 를 눌러 보낸다.
// 훅이 직접 보내는 prompt.submit 은 모델에 닿지 않아 쓰지 않는다
export const START_PROMPT = [
  '오늘 작업을 시작하자.',
  '1. .omc/board.json 을 오늘 기준으로 갱신하고 done 항목은 비워 줘.',
  '2. 남은 워크트리, 세션, 머지된 브랜치 정리는 상주 루프의 cleanup-sweep 이 맡는다. 루프가 정리하지 못하고 남긴 것만 알려 줘.',
  '3. orch 상주 루프와 대기(wait-important)가 꺼져 있으면 다시 띄우고, 쌓인 worker 보고를 처리해 줘.',
  '4. 열린 PR 의 CI 와 리뷰, 막힌 것, 내가 정할 것을 짧게 보고하고 정할 것은 바로 물어봐 줘.',
].join('\n')

export const REFRESH_PROMPT = [
  '보드를 현재 상태로 갱신해 줘.',
  '1. PR 상태와 CI, 배포 결과, 두레이 업무 상태, orch worker 보고를 대조해 줘. 확인하지 못한 상태는 추측하지 말고 남겨 줘.',
  '2. 확인한 근거에 따라 work-board/bin/board.ts 로 항목 상태와 단계, 목표 진행률을 고쳐 줘. 직접 작성한 사건 단계에는 PR 번호와 사건 꼬리표를 붙여 줘.',
  '3. 바뀐 것과 내가 정할 것만 짧게 보고해 줘.',
].join('\n')

export const DECIDE_PROMPT = [
  '지금 정할 것을 모아 물어봐 줘.',
  '1. 보드의 결정 필요(decide) 항목과 그 줄, 답하지 않은 worker 질문, 이번 대화에서 미룬 결정을 모아 줘.',
  '2. 이미 정했거나 외부 답을 기다리는 것은 빼고, 뺀 이유를 한 줄씩 적어 줘.',
  '3. 항목마다 배경, 선택지, 권장안과 이유를 먼저 보여 준 뒤 AskUserQuestion 으로 4개씩 물어봐 줘. 권장안은 첫 선택지에 (Recommended) 를 붙여 줘.',
  '4. 답한 보드 줄은 fos-skills 플러그인의 work-board/bin/board.ts mark <id> <n> 으로 끝내고, 답을 기다리는 worker 에게는 fos-skills 플러그인의 orch/scripts/send-to-worker.ts 로 전해 줘.',
  '5. worker 가 직접 올린 막힘은 먼저 확인해서 네가 처리할 수 있으면 처리하고, 사람이 정할 것만 결정으로 물어봐 줘.',
  '6. Orca 자동 알림(「Worker stopped without reporting」 같은 멈춤, 「Agent hit an error」 같은 오류)은 나에게 묻지 말고 처리한 결과만 한 줄로 알려 줘.',
  '7. 자동 알림 가운데 계정 한도에 걸렸거나 터미널이 종료된 worker 는 묻지 말고 같은 워크트리에서 다시 띄우고, 멈춘 worker 는 상태를 확인해 필요하면 깨워 줘.',
  '8. 처리한 막힘은 이어갈 일이 있는 worker 면 send-to-worker.ts 답장으로 깨우고, 일이 끝난 worker 는 답장 대신 orca orchestration worker-release 해제로 닫아 줘. 답장은 끝난 worker 를 다시 깨운다.',
].join('\n')

function fillPrompt($, text) {
  void $.prompt.fill({ text })
  $.ui.toast('입력란에 요청문을 채웠어요. Enter 를 누르면 보내요')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await loadFile($)
    $.clock.every(FILE_MS, () => loadFile($))
    $.clock.every(LIVE_MS, () => loadLive($))
    $.clock.every(INBOX_MS, () => loadInbox($))
    $.clock.every(VERSION_MS, () => loadLatest($))
    loadLive($)
    loadInbox($)
    void loadInstall($).then(() => loadLatest($))
    await $.command.register({ name: 'board', description: '작업 현황 창 열기', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($) => {
    dismissMode = false
    await loadFile($)
    loadLive($)
    loadInbox($)
    loadLatest($)
    await $.ui.open({ id: PANE, title: '작업 현황', closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // 머리말(「두레이」나 「업무」, 「PR」)과 번호를 대괄호로 감싸 제목과 가르고, 밑줄 친 링크와 색으로도 가린다. 주소가 없으면 글자만 그린다
    const TAG_COLORS = { PR: 'magenta' }
    const tagged = (key, tag, href, label) => {
      const look = { underline: Boolean(href), color: TAG_COLORS[tag] || 'cyan' }
      const text = '[' + tag + (label ? ' ' + label : '') + ']'
      return href
        ? Link({ key, href, children: [Text({ ...look, children: [text] })] })
        : Text({ key, color: look.color, children: [text] })
    }
    const prLink = (n) => tagged('pr-' + n, 'PR', repoUrl ? repoUrl + '/pull/' + n : '', '#' + n)
    // 제목 안의 업무 번호(「#342」)에만 머리말과 업무 링크를 건다. 항목에 업무 주소(task)가 없으면 제목 그대로다
    const titleChildren = (item) => {
      const title = item.title || item.id
      const parts = typeof item.task === 'string' && /^https?:\/\//.test(item.task) ? splitTaskNumber(title) : null
      return parts ? [parts[0], tagged('task', taskTag(item.task), item.task, parts[1]), parts[2]] : [title]
    }
    const items = board && Array.isArray(board.items) ? board.items : []
    // 맡은 worker 가 없는 줄. 단계가 idle_min 넘게 worker 없이 남았으면 경과 시간을 붙이고 노란색으로 그린다
    // 판정 명령을 읽지 못했으면 orch 기본값(30분)으로 잰다
    const idleView = (item, rows) => {
      // worker 목록을 읽지 못했으면 정말 worker 가 없는지 몰라 경과 시간을 붙이지 않는다
      const idleMin = live.workers === null ? 0 : live.movement ? live.movement.idleMin : 30
      const stalled = idleStepMinutes(item, rows, now, idleMin) !== null
      return Text({ dimColor: !stalled, color: stalled ? 'yellow' : undefined, wrap: 'wrap', children: [workerNoneText(item, rows, now, idleMin)] })
    }
    // worker 줄 끝의 멈춤·오류 글. 빨간색으로 붙인다
    const noteTexts = (worker) => workerNotes(worker, live.marks, live.alertNotes)
      .map((note, i) => Text({ key: 'note-' + i, color: 'red', children: ['  ' + note] }))

    const box = (key, color, label, children) => Box({
      key,
      flexDirection: 'column',
      borderStyle: 'round',
      padding: 1,
      gap: 1,
      children: [Text({ bold: true, color, children: [label] }), ...children],
    })
    const dim = (key, text) => Text({ key, dimColor: true, wrap: 'wrap', children: [text] })

    // 들여 쓴 한 줄. 공백 대신 Box 의 왼쪽 여백으로 들여 써서 줄바꿈된 뒷줄도 같은 자리에서 시작한다
    const indent = (key, left, child) => Box({ key, paddingLeft: left, children: [child] })

    // 단계 한 줄: 표시 칸(끝냄 ✓, 지금 ▶, 남음과 참고 줄은 빈칸)과 본문. 모든 줄의 번호와 본문이 같은 열에서 시작하고,
    // 본문이 줄바꿈되면 뒷줄도 본문 열에서 시작한다. 끝낸 줄은 취소선과 흐림, 지금 단계는 굵게, 참고 줄은 흐리게 그린다
    // extra 는 본문 뒤에 흐리게 붙일 글이다(접힌 보기의 단계 수)
    const stepLine = (key, row, extra) => {
      const look = row.state === 'done' ? { dimColor: true, strikethrough: true }
        : row.state === 'now' ? { bold: true }
          : row.state === 'note' ? { dimColor: true } : {}
      return Box({
        key,
        flexDirection: 'row',
        paddingLeft: 2,
        children: [
          Box({ width: STEP_MARK_WIDTH, flexShrink: 0, children: [Text({ ...look, children: [stepMark(row)] })] }),
          Text({ wrap: 'wrap', children: [
            Text({ ...look, children: [stepBody(row.text)] }),
            ...(extra ? [Text({ dimColor: true, children: ['  ' + extra] })] : []),
          ] }),
        ],
      })
    }

    // 접힌 보기의 단계 한 줄: 지금 단계 뒤에 끝낸 단계와 남은 단계의 수를 붙인다
    // 수 하나(「✓ 2개」)가 두 줄로 갈리지 않도록 그 안의 띄어쓰기는 줄바꿈하지 않는 공백(U+00A0)으로 쓴다
    const foldedSteps = (rows, progress) => {
      const summary = stepSummary(rows, progress)
      const counts = [
        ...(summary.done ? ['✓ ' + summary.done + '개'] : []),
        ...(summary.todo ? ['남은 단계 ' + summary.todo + '개'] : []),
      ].map((part) => part.replace(/ /g, '\u00a0')).join('  ·  ')
      if (summary.now) return [stepLine('steps', summary.now, counts)]
      return counts ? [indent('steps', 2 + STEP_MARK_WIDTH, dim('counts', counts))] : []
    }

    // 접힌 보기는 「표시 제목」, 제목 아래 막대, 「▶ 지금 단계」, worker 줄만 그린다
    // 펼친 보기(d)는 「표시 제목」, 막대, 담당·PR, 모든 단계 줄을 적힌 순서대로 그린다
    // 완료 항목은 막대 줄이 없다
    const itemView = (item, section) => {
      // board.ts 는 PR 번호 하나를 숫자로 저장한다. 옛 값(「#9」)과 같게 # 를 붙여 그린다
      const meta = [item.owner, typeof item.pr === 'number' ? '#' + item.pr : item.pr].filter(Boolean)
      const done = section.status === 'done'
      const bar = progressBar(itemProgress(item), 10)
      const rows = done ? [] : stepRows(item)
      const worker = workerFor(item, live.workers)
      return Box({
        key: 'item-' + item.id,
        flexDirection: 'column',
        children: [
          Box({
            key: 'head',
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ key: 'mark', color: section.color, children: [section.mark] }),
              done
                ? Text({ key: 'title', dimColor: true, strikethrough: true, wrap: 'wrap', children: titleChildren(item) })
                : Text({ key: 'title', bold: true, wrap: 'wrap', children: titleChildren(item) }),
            ],
          }),
          ...(done ? [] : [indent('bar', 2, bar
            ? Text({ color: section.color, wrap: 'truncate', children: [bar] })
            : Text({ dimColor: true, children: ['진행률 없음'] }))]),
          ...(expanded && meta.length ? [indent('meta', 2, Text({ key: 'meta', dimColor: true, wrap: 'wrap', children: [
            ...(item.owner ? [item.owner] : []),
            ...prNumbers(item.pr).flatMap((n, i) => [...(item.owner || i > 0 ? ['  ·  '] : []), prLink(n)]),
          ] }))] : []),
          ...(expanded ? rows.map((row, i) => stepLine('s-' + i, row)) : foldedSteps(rows, item.progress)),
          ...(!done && item.worktree ? [indent('w', 2, worker
            ? Text({ color: 'yellow', wrap: 'wrap', children: ['⚙ worker ' + workerLine(worker, live.prs), ...noteTexts(worker)] })
            : idleView(item, rows))] : []),
        ],
      })
    }

    // 결정 필요: worker 질문 수와 수동 decide 항목의 남은 줄
    const decideRows = items.filter((item) => item.status === 'decide')
    const asked = Array.isArray(live.questions) ? live.questions : []
    const questionView = (q) => {
      const worker = Array.isArray(live.workers) ? live.workers.find((w) => w.id === q.dispatch) : null
      const who = worker && worker.worktree ? worker.worktree : q.dispatch || 'worker'
      const decision = decisionOf(q.text)
      return Box({
        key: 'q-' + q.id,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: 'red', children: ['◆'] }),
              Text({ bold: true, wrap: 'wrap', children: [(q.type === 'escalation' ? '막힘 · ' : '질문 · ') + who
                + (q.repeats > 0 ? ' · 다시 보냄 ' + q.repeats : '')] }),
            ],
          }),
          ...(decision ? [
            Text({ bold: true, wrap: 'wrap', children: ['  ' + questionText(decision.title)] }),
            ...(decision.recommend ? [Text({ wrap: 'wrap', children: ['  권장: ' + questionText(decision.recommend)] })] : []),
          ] : [Text({ wrap: 'wrap', children: ['  ' + questionText(q.text)] })]),
        ],
      })
    }
    const questionError = live.errors.questions
    const decideView = decideCount(decideRows) + asked.length === 0 && !questionError && !live.questionsLimited ? [] : [box('live-decide', 'red',
      questionError ? '결정 필요  확인 불가' : '결정 필요  ' + (decideCount(decideRows) + asked.length), [
        ...(questionError ? [dim('qe', '읽지 못했어요: ' + questionError)] : []),
        ...(live.questionsLimited ? [dim('ql', '최근 질문 100건과 읽지 않은 질문 최대 100건 기준이에요. 더 오래된 미답변은 빠질 수 있어요.')] : []),
        ...asked.map(questionView),
        ...decideRows.map((item) => itemView(item, SECTIONS[1])),
      ])]

    // 업무 알림: inbox 설정이 있을 때만 그린다. 새 항목 먼저, 앞 INBOX_ROWS 개에 숫자 단축키를 붙인다
    const alerts = inboxSummary(inbox)
    const { shown: inboxItems, answered: answeredCount } = inboxRows(alerts.show ? inbox.items : [])
    const clock = (at) => {
      const time = Date.parse(at || '')
      if (!time) return ''
      const date = new Date(time)
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }
    const inboxRow = (item, index) => {
      const answered = item.state === 'answered'
      const meta = [item.from && (item.from.name || item.from.id), INBOX_KIND_LABELS[item.kind] || item.kind, answered ? '답함' : ago(item.at)]
        .filter(Boolean).join(' · ')
      const label = (answered ? '✓ ' : '● ') + (item.title || item.id)
      return Box({
        key: 'inbox-' + item.id,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            flexWrap: 'wrap',
            children: [
              index < INBOX_ROWS
                ? Button({ key: 'inbox-reply-' + item.id, hotkey: String(index + 1), plain: true, dimColor: answered,
                  onPress: () => { if (dismissMode) void dismissInbox($, item.id); else fillPrompt($, replyPrompt(item)) },
                  children: [Text({ bold: !answered, dimColor: answered, color: dismissMode ? 'red' : undefined, children: [label] })] })
                : Text({ bold: !answered, dimColor: answered, children: ['   ' + label] }),
              tagged('tag', inboxTag(item), item.url || '', ''),
              Text({ dimColor: true, children: [meta] }),
            ],
          }),
          ...(!answered && item.excerpt ? [indent('excerpt', 5, Text({ dimColor: true, wrap: 'truncate', children: ['「' + item.excerpt + '」'] }))] : []),
        ],
      })
    }
    const inboxErrors = [...Object.entries((alerts.show && inbox.errors) || {}), ...(inboxError ? [['inbox', inboxError]] : [])]
    const inboxView = !inboxBoxVisible(inbox, inboxError, inboxSeen) ? [] : [box('inbox', 'green',
      '알림  ' + alerts.newCount + (inbox && inbox.fetchedAt ? '  ·  ' + clock(inbox.fetchedAt) + ' 확인' : ''), [
        ...inboxErrors.map(([source, message]) => Text({ key: 'ie-' + source, color: 'red', wrap: 'wrap',
          children: [inboxSourceLabel(source) + ' 확인 불가: ' + message] })),
        ...(alerts.show && inbox.unclassified > 0 ? [dim('iu', '미분류 알림 ' + inbox.unclassified + ' · 기본 보드에서 봐요')] : []),
        ...(alerts.show && dismissMode ? [Text({ key: 'idm', color: 'red', wrap: 'wrap',
          children: ['넘길 알림의 번호를 누르세요. 넘긴 알림은 답하지 않음으로 남고 z 로 되돌려요. 그만두려면 x'] })] : []),
        ...(alerts.show && inboxItems.length === 0 ? [dim('i0', answeredCount > 0 ? '이 보드의 새 알림이 없어요' : '이 보드의 알림이 없어요')] : []),
        ...inboxItems.map(inboxRow),
        ...(answeredCount > 0 ? [dim('ia', '답함 ' + answeredCount)] : []),
      ])]

    // worker: 이 세션이 묶인 run 에서 일하는 worker 중 어느 항목에도 붙지 않은 것
    const loose = unmappedWorkers(items, live.workers)
    const mapped = Array.isArray(live.workers) && Array.isArray(loose) ? live.workers.length - loose.length : 0
    const workerView = (live.workers === null || (mapped > 0 && loose && loose.length === 0)) && !live.errors.workers ? [] : [box('live-workers', 'yellow',
      (mapped > 0 ? '항목에 안 붙은 worker  ' : 'worker  ') + (loose ? loose.length : '-'),
      live.errors.workers
        ? [dim('we', '읽지 못했어요: ' + live.errors.workers)]
        : loose.length === 0
          ? [dim('w0', mapped > 0 ? '모든 worker 가 항목에 붙어 있어요' : '일하는 worker 가 없어요')]
          : loose.map((worker) => Text({ key: 'w-' + worker.id, wrap: 'wrap', children: ['▶ ' + workerLine(worker, live.prs), ...noteTexts(worker)] })))]

    // 열린 PR: Draft/Ready, CI 요약, 머지 상태
    // 작성자 거르기: 지금 열린 PR 에 없는 작성자로 걸러 있으면 전체로 본다
    if (authorFilter && !prAuthors(live.prs).includes(authorFilter)) authorFilter = ''
    const shownPrs = live.prs ? live.prs.filter((pr) => !authorFilter || pr.author === authorFilter) : null
    const prView = live.prs === null && !live.errors.prs ? [] : [box('live-prs', 'cyan',
      '열린 PR  ' + (shownPrs ? shownPrs.length + '  ·  머지 가능 ' + shownPrs.filter((pr) => mergeVerdict(pr).rank === 0).length
        + (authorFilter ? '  ·  작성자 @' + authorFilter : '') : '-'),
      live.errors.prs
        ? [dim('pe', '읽지 못했어요: ' + live.errors.prs)]
        : shownPrs.length === 0
          ? [dim('p0', '열린 PR 이 없어요')]
          : sortPullRequests(shownPrs).map((pr) => {
            const verdict = mergeVerdict(pr)
            return Box({
              key: 'pr-' + pr.number,
              flexDirection: 'column',
              children: [
                Box({
                  flexDirection: 'row',
                  columnGap: 1,
                  children: [
                    Text({ color: verdict.color, bold: verdict.rank === 0, children: [verdict.rank === 0 ? '●' : pr.draft ? '○' : '◐'] }),
                    Text({ bold: true, dimColor: pr.draft, wrap: 'wrap', children: [prLink(pr.number), ' ' + pr.title, ...(pr.author ? [Text({ dimColor: true, children: ['  @' + pr.author] })] : [])] }),
                  ],
                }),
                Box({
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  children: [
                    Text({ key: 'stage', color: pr.draft ? undefined : 'cyan', dimColor: pr.draft, children: ['  ' + (pr.draft ? 'Draft' : 'Ready')] }),
                    Text({ key: 'sep1', dimColor: true, children: ['  ·  '] }),
                    Text({ key: 'verdict', color: verdict.color, bold: verdict.rank === 0, children: [verdict.label] }),
                    Text({ key: 'ci', dimColor: true, children: ['  ·  ' + checkSummary(pr)] }),
                  ],
                }),
              ],
            })
          }))]

    // 수동 항목: 진행, 대기, 완료
    const manualView = (section) => {
      const rows = items.filter((item) => item.status === section.status)
      if (rows.length === 0) return []
      const collapsed = section.status === 'done' && !expanded
      return [box('section-' + section.status, section.color, section.label + '  ' + rows.length,
        collapsed ? [dim('fold', 'd 를 누르면 펼쳐요')] : rows.map((item) => itemView(item, section)))]
    }

    // 전체 진행률: 진행 중 항목들의 끝낸 단계 합 / 전체 단계 합
    const overall = overallProgress(items)
    const overallView = Box({
      key: 'overall',
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ bold: true, children: ['전체 진행률'] }),
        overall.total > 0
          ? Text({ color: 'yellow', children: [progressBar(overall.done + '/' + overall.total, 30)] })
          : Text({ dimColor: true, children: ['진행률 없음'] }),
        ...(overall.missing > 0 ? [Text({ dimColor: true, children: ['· 진행률 없는 항목 ' + overall.missing] })] : []),
      ],
    })

    const nothing = !board && live.workers === null && live.prs === null
    const updatedAt = Math.max(live.at || 0, Date.parse(board?.updatedAt) || 0)
    const updated = updatedAt ? new Date(updatedAt) : null
    const updateLabel = updated
      ? String(updated.getHours()).padStart(2, '0') + ':' + String(updated.getMinutes()).padStart(2, '0') + ' 업데이트'
      : '읽는 중'
    // 머리 줄: 업데이트 시각 뒤에 플러그인 버전. 좁은 창에서는 버전이 다음 줄로 넘어간다
    const version = versionLabel(plugin.name || $.plugin.name, plugin.install, plugin.latest, plugin.error)
    const headView = Box({
      key: 'updated-at',
      flexDirection: 'row',
      flexWrap: 'wrap',
      children: [
        Text({ key: 'time', dimColor: true, children: [updateLabel + '  ·  '] }),
        Text({ key: 'version', dimColor: version.dim, color: version.color, wrap: 'wrap',
          children: [updating ? version.text + ' · 갱신 중' : version.text] }),
      ],
    })
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        overallView,
        headView,
        Box({
          key: 'shortcuts',
          borderStyle: 'round',
          padding: 1,
          flexDirection: 'column',
          children: [
            Text({ bold: true, children: ['단축키'] }),
            // 버튼 폭의 합이 상자보다 넓으면 다음 줄로 넘긴다. flexWrap 이 없으면 오른쪽 버튼이 잘린다(R4)
            Box({ key: 'shortcut-row', flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: [
              Button({
                key: 'start-today',
                label: '오늘 시작',
                hotkey: 's',
                plain: true,
                onPress: () => { fillPrompt($, START_PROMPT) },
              }),
              Button({
                key: 'refresh-board',
                label: '보드 갱신',
                hotkey: 'u',
                plain: true,
                onPress: () => { fillPrompt($, REFRESH_PROMPT) },
              }),
              Button({
                key: 'ask-decisions',
                label: '정할 것 묻기',
                hotkey: 'q',
                plain: true,
                onPress: () => { fillPrompt($, DECIDE_PROMPT) },
              }),
              ...(alerts.show ? [Button({
                key: 'inbox-all',
                label: '알림 답변',
                hotkey: 'i',
                plain: true,
                onPress: () => { fillPrompt($, INBOX_PROMPT) },
              })] : []),
              ...(alerts.show && (inboxItems.length > 0 || dismissMode) ? [Button({
                key: 'inbox-dismiss',
                label: dismissMode ? '넘기기 그만' : '알림 넘기기',
                hotkey: 'x',
                plain: true,
                onPress: () => {
                  dismissMode = !dismissMode
                  $.ui.invalidate('ui.render')
                },
              })] : []),
              ...(alerts.show && dismissUndo.length > 0 ? [Button({
                key: 'inbox-undo',
                label: '넘김 되돌리기',
                hotkey: 'z',
                plain: true,
                onPress: () => { void undoDismiss($) },
              })] : []),
              Button({
                key: 'pr-author',
                label: 'PR 작성자: ' + (authorFilter ? '@' + authorFilter : '전체'),
                hotkey: 'a',
                plain: true,
                onPress: () => {
                  authorFilter = nextAuthor(live.prs, authorFilter)
                  $.ui.invalidate('ui.render')
                },
              }),
              Button({
                key: 'toggle-done',
                label: expanded ? '접기' : '단계와 완료 펼치기',
                hotkey: 'd',
                plain: true,
                onPress: () => {
                  expanded = !expanded
                  $.ui.invalidate('ui.render')
                },
              }),
              ...(updateVisible(plugin.install, plugin.latest) ? [Button({
                key: 'update-plugin',
                label: updating ? '플러그인 갱신 중' : '플러그인 갱신',
                hotkey: 'p',
                plain: true,
                onPress: () => { void updatePlugin($) },
              })] : []),
            ] }),
          ],
        }),
        ...(board && board.error ? [Text({ color: 'red', wrap: 'wrap', children: ['board.json 을 읽지 못했어요: ' + board.error] })] : []),
        ...(nothing ? [dim('none', '보여 줄 작업이 없어요. orca run 이나 열린 PR, ' + BOARD_PATHS[0] + ' 중 하나가 있어야 해요.')] : []),
        ...manualView(SECTIONS[0]),
        ...decideView,
        ...inboxView,
        ...workerView,
        ...prView,
        ...SECTIONS.slice(2).flatMap(manualView),
      ],
    })
  })
}
