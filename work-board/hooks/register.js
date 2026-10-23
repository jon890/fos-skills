// 저장소의 작업 현황을 창과 상태 줄에 보여 준다.
// 두 곳에서 읽는다.
//   1. 수동 항목: 저장소의 board.json(BOARD_PATHS 순서로 찾는다). 갱신은 플러그인의 bin/board.py 가 한다.
//      형식: { updatedAt: ISO 문자열, items: [{ id, title, status, owner?, pr?, worktree?, next?, details?: string[] }] }
//      worktree 는 그 항목을 맡은 worker 의 워크트리 이름이다. 창이 그 worker 상태를 항목 아래에 붙인다.
//      status: goal(목표), decide(결정 필요), doing(진행 중), wait(대기), done(완료)
//      진행 표시줄은 번호로 시작하는 단계 줄(「1 …」, 「1. …」, 끝나면 「✓ 1 …」 나 「[x] 1. …」)을 세어 그린다.
//      details 에 단계 줄이 있으면 그것을, 없으면 next 의 줄을 센다. 참고 줄은 세지 않는다.
//      progress(「끝낸 단계/전체 단계」, 예: 7/10)가 있으면 그 값을 우선한다.
//      창 맨 위에 진행 중(doing) 항목들의 끝낸 단계 합 / 전체 단계 합을 전체 진행률로 그린다.
//      항목은 접혀 「표시 제목 막대」 와 「▶ 지금 단계」, worker 줄만 보인다. d 로 펼치면 끝낸 줄을 취소선으로 보인다.
//   2. 실제 상태: orca orchestration(이 세션이 묶인 run 의 worker 와 답을 기다리는 질문)과 gh(열린 PR, CI).
// 파일은 FILE_MS, 명령은 LIVE_MS 마다 다시 읽는다. 창에서 r 을 누르면 명령을 바로 다시 읽는다.

const PANE = 'work-board'
const BOARD_PATHS = ['.omc/board.json', '.omc/handoffs/board.json']
const FILE_MS = 5000
const LIVE_MS = 45000
const COMMAND_TIMEOUT_MS = 20000
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

// 실제 상태. 읽지 못한 원천은 error 에 이유를 남기고 나머지는 그린다.
let live = { at: 0, runId: '', workers: null, questions: null, prs: null, errors: {} }
let liveBusy = false

// ---- 외부 명령 출력을 그릴 값으로 바꾸는 순수 함수(테스트가 직접 부른다) ----

// worker-list --json 의 결과에서 아직 일하는 worker 만 고른다.
export function parseWorkers(stdout) {
  const data = JSON.parse(stdout)
  const workers = (data && data.result && (data.result.workers || data.result.dispatches)) || []
  return workers
    .filter((w) => w.dispatchStatus === 'dispatched')
    .map((w) => {
      const tree = (w.resource && w.resource.worktreeId) || ''
      const path = tree.includes('::') ? tree.split('::').pop() : tree
      return { id: w.dispatchId, state: w.workerState || '', worktree: path.split('/').filter(Boolean).pop() || '' }
    })
}

// check --peek 의 출력에서 답을 기다리는 질문과 escalation 의 수를 센다.
// 본문에 제어 문자가 섞이면 JSON 으로 읽히지 않으므로 type 칸만 센다.
export function countQuestions(stdout) {
  const found = stdout.match(/"type"\s*:\s*"(question|escalation)"/g)
  return found ? found.length : 0
}

// check --peek 의 출력에서 답을 기다리는 질문과 escalation 을 꺼낸다.
// 본문의 줄바꿈 같은 제어 문자는 JSON 문자열 밖에서는 공백과 같으므로 공백으로 바꿔 읽는다.
// 그래도 읽히지 않으면 type 칸 수만큼 본문 없는 질문을 돌려준다.
export function parseQuestions(stdout) {
  try {
    const data = JSON.parse(String(stdout).replace(/[\u0000-\u001f]/g, ' '))
    const messages = (data && data.result && data.result.messages) || []
    return messages
      .filter((m) => m.type === 'question' || m.type === 'escalation')
      .map((m) => {
        let dispatch = String(m.from_handle || '').replace(/^dispatch:/, '')
        let text = String(m.body || '')
        try {
          const payload = JSON.parse(m.payload || '{}')
          dispatch = payload.dispatchId || dispatch
          text = payload.question || text
        } catch {}
        return { id: m.id, type: m.type, dispatch, text: text.trim(), at: m.created_at || '' }
      })
  } catch {
    return Array.from({ length: countQuestions(stdout) }, (_, i) => ({ id: 'q' + i, type: 'question', dispatch: '', text: '', at: '' }))
  }
}

// 질문 본문을 창에 맞게 줄인다
export function questionText(text, limit = 400) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!flat) return '본문을 읽지 못했어요'
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
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
  return (worker.worktree || worker.id) + (pr ? '  #' + pr.number + ' ' + checkSummary(pr) : '')
    + (worker.state && worker.state !== 'ready' ? '  ' + worker.state : '')
}

// 단계 줄: 앞 표시(끝냄 ✓ [x], 안 끝냄 [ ] ▶ ◇)와 번호. bin/board.py 의 STEP 과 같은 규칙이다
const STEP = /^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s/
const DONE_MARKS = ['✓', '[x]', '[X]']

// 단계 줄이면 { number, done } 을, 아니면 null 을 돌려준다
export function parseStep(line) {
  const match = STEP.exec(String(line))
  return match ? { number: Number(match[2]), done: DONE_MARKS.includes(match[1]) } : null
}

// 끝난 줄인지. 단계 줄이 아닌 참고 줄도 「✓」 로 시작하면 끝난 줄로 본다
function finishedLine(text) {
  const step = parseStep(text)
  return step ? step.done : text.startsWith('✓')
}

// 항목의 details 와 next 를 줄마다 나눠 상태를 붙인다. 빈 줄은 뺀다
// state: done(끝낸 줄), now(지금 단계), todo(남은 단계), note(번호 없는 참고 줄)
// step 은 단계 줄인지, counted 는 진행률을 세는 쪽(details 에 단계가 있으면 details, 아니면 next)의 줄인지다
// 지금 단계는 세는 쪽의 끝나지 않은 첫 단계다
// 거기 없으면 다른 쪽의 끝나지 않은 첫 단계, 단계 줄이 하나도 없으면 첫 참고 줄을 지금 단계로 둔다
// 단계가 모두 끝났으면 지금 단계는 없다
export function stepRows(item) {
  const details = Array.isArray(item.details) ? item.details.map(String) : []
  const counted = stepProgress(details) ? 'details' : 'next'
  const rows = [
    ...details.map((text) => ({ text, from: 'details' })),
    ...String(item.next || '').split('\n').map((text) => ({ text, from: 'next' })),
  ]
    .filter((row) => row.text.trim())
    .map((row) => {
      const text = row.text.trim()
      const step = Boolean(parseStep(text))
      return { text, state: finishedLine(text) ? 'done' : step ? 'todo' : 'note', step, counted: row.from === counted }
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
const LEAD_MARK = /^(?:✓|\[[xX ]\]|▶|◇)\s*/
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
  return stepProgress(item.details) || stepProgress(String(item.next || '').split('\n'))
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

// 상태 줄 한 줄. 실제 상태와 수동 항목을 함께 센다.
export function statusLine(items, state) {
  const count = (status) => items.filter((item) => item.status === status).length
  const parts = []
  const decide = count('decide') + (Array.isArray(state.questions) ? state.questions.length : state.questions || 0)
  if (decide > 0) parts.push('결정 필요 ' + decide)
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

async function run($, argv) {
  const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: COMMAND_TIMEOUT_MS })
  if (exitCode !== 0) throw new Error((stderr || stdout || '종료 코드 ' + exitCode).trim().split('\n')[0])
  return stdout
}

function refreshStatus($) {
  const items = board && Array.isArray(board.items) ? board.items : []
  $.ui.status(statusLine(items, live))
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
  const next = { at: 0, runId: '', workers: null, questions: null, prs: null, errors: {} }
  try {
    try {
      const current = JSON.parse(await run($, ['orca', 'orchestration', 'run-current', '--json']))
      const runInfo = current && current.result && current.result.run
      next.runId = runInfo && runInfo.id ? runInfo.id : ''
    } catch (failure) {
      next.errors.workers = String(failure.message || failure)
    }
    if (next.runId) {
      try {
        next.workers = parseWorkers(await run($, ['orca', 'orchestration', 'worker-list', '--run', next.runId, '--json']))
      } catch (failure) {
        next.errors.workers = String(failure.message || failure)
      }
      try {
        next.questions = parseQuestions(await run($, ['orca', 'orchestration', 'check', '--run', next.runId,
          '--peek', '--types', 'question,escalation', '--json']))
      } catch (failure) {
        next.errors.questions = String(failure.message || failure)
      }
    }
    try {
      next.prs = parsePullRequests(await run($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '30',
        '--json', 'number,title,isDraft,mergeStateStatus,headRefName,statusCheckRollup']))
    } catch (failure) {
      next.errors.prs = String(failure.message || failure)
    }
    next.at = await $.clock.now()
    live = next
  } finally {
    liveBusy = false
  }
  refreshStatus($)
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

// 「오늘 시작」 이 코디네이터에게 보내는 요청. 하루 작업을 시작할 때 쓴다.
export const START_PROMPT = [
  '오늘 작업을 시작하자.',
  '1. .omc/board.json 을 오늘 기준으로 갱신하고 완료(done) 항목은 비운다.',
  '2. 현재 저장소의 남은 워크트리, 세션, 머지된 브랜치를 그 저장소 .claude/orch-overlay.md 의 정리 규칙대로 정리한다.',
  '3. orchestration 감시(orch-watch)가 꺼져 있으면 다시 띄우고, 쌓인 worker 보고를 처리한다.',
  '4. 열린 PR 의 CI 와 리뷰 상태, 막힌 것, 내가 정해야 할 것을 짧게 정리해 보고하고, 정할 것은 바로 물어본다.',
].join('\n')

function startToday($) {
  void $.prompt.submit({ text: START_PROMPT })
  $.ui.toast('오늘 시작 요청을 보냈어요')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await loadFile($)
    $.clock.every(FILE_MS, () => loadFile($))
    $.clock.every(LIVE_MS, () => loadLive($))
    loadLive($)
    await $.command.register({ name: 'board', description: '작업 현황 창 열기', immediate: true })
    await $.command.register({ name: 'board-start', description: '오늘 작업 시작 요청 보내기(board 갱신, 정리, 보고)', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($) => {
    await loadFile($)
    loadLive($)
    await $.ui.open({ id: PANE, title: '작업 현황', closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'board-start' }, async ($) => {
    startToday($)
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const items = board && Array.isArray(board.items) ? board.items : []

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

    // 접힌 보기는 「표시 제목 막대」, 「▶ 지금 단계」, worker 줄만 그린다
    // 펼친 보기(d)는 담당·PR 과 모든 줄을 적힌 순서대로 그린다
    const itemView = (item, section) => {
      const meta = [item.owner, item.pr].filter(Boolean)
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
            flexWrap: 'wrap',
            columnGap: 1,
            children: [
              Text({ key: 'mark', color: section.color, children: [section.mark] }),
              done
                ? Text({ key: 'title', dimColor: true, strikethrough: true, wrap: 'wrap', children: [item.title || item.id] })
                : Text({ key: 'title', bold: true, wrap: 'wrap', children: [item.title || item.id] }),
              ...(done ? [] : [bar
                ? Text({ key: 'bar', color: section.color, wrap: 'truncate', children: [bar] })
                : Text({ key: 'bar', dimColor: true, children: ['진행률 없음'] })]),
            ],
          }),
          ...(expanded && meta.length ? [indent('meta', 2, dim('meta', meta.join('  ·  ')))] : []),
          ...(expanded ? rows.map((row, i) => stepLine('s-' + i, row)) : foldedSteps(rows, item.progress)),
          ...(!done && item.worktree ? [indent('w', 2, worker
            ? Text({ color: 'yellow', wrap: 'wrap', children: ['⚙ worker ' + workerLine(worker, live.prs)] })
            : Text({ dimColor: true, wrap: 'wrap', children: ['⚙ worker 없음 (' + item.worktree + ')'] }))] : []),
        ],
      })
    }

    // 결정 필요: worker 질문 수와 수동 decide 항목
    const decideRows = items.filter((item) => item.status === 'decide')
    const asked = Array.isArray(live.questions) ? live.questions : []
    const questionView = (q) => {
      const worker = Array.isArray(live.workers) ? live.workers.find((w) => w.id === q.dispatch) : null
      const who = worker && worker.worktree ? worker.worktree : q.dispatch || 'worker'
      return Box({
        key: 'q-' + q.id,
        flexDirection: 'column',
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: 'red', children: ['◆'] }),
              Text({ bold: true, wrap: 'wrap', children: [(q.type === 'escalation' ? '막힘 · ' : '질문 · ') + who] }),
            ],
          }),
          Text({ wrap: 'wrap', children: ['  ' + questionText(q.text)] }),
        ],
      })
    }
    const decideView = decideRows.length + asked.length === 0 ? [] : [box('live-decide', 'red',
      '결정 필요  ' + (decideRows.length + asked.length), [
        ...asked.map(questionView),
        ...decideRows.map((item) => itemView(item, SECTIONS[1])),
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
          : loose.map((worker) => Text({ key: 'w-' + worker.id, wrap: 'wrap', children: ['▶ ' + workerLine(worker, live.prs)] })))]

    // 열린 PR: Draft/Ready, CI 요약, 머지 상태
    const prView = live.prs === null && !live.errors.prs ? [] : [box('live-prs', 'cyan',
      '열린 PR  ' + (live.prs ? live.prs.length + '  ·  머지 가능 ' + live.prs.filter((pr) => mergeVerdict(pr).rank === 0).length : '-'),
      live.errors.prs
        ? [dim('pe', '읽지 못했어요: ' + live.errors.prs)]
        : live.prs.length === 0
          ? [dim('p0', '열린 PR 이 없어요')]
          : sortPullRequests(live.prs).map((pr) => {
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
                    Text({ bold: true, dimColor: pr.draft, wrap: 'wrap', children: ['#' + pr.number + ' ' + pr.title] }),
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
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        overallView,
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ dimColor: true, children: [
              '실제 상태 ' + (live.at ? ago(live.at) : '읽는 중') + (live.runId ? '  ·  ' + live.runId : '')
                + (board ? '  ·  수동 ' + ago(board.updatedAt) : ''),
            ] }),
            Button({
              key: 'refresh',
              label: liveBusy ? '읽는 중' : '새로 읽기',
              hotkey: 'r',
              plain: true,
              onPress: () => { loadLive($) },
            }),
            Button({
              key: 'start-today',
              label: '오늘 시작',
              hotkey: 's',
              plain: true,
              onPress: () => { startToday($) },
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
          ],
        }),
        ...(board && board.error ? [Text({ color: 'red', wrap: 'wrap', children: ['board.json 을 읽지 못했어요: ' + board.error] })] : []),
        ...(nothing ? [dim('none', '보여 줄 작업이 없어요. orca run 이나 열린 PR, ' + BOARD_PATHS[0] + ' 중 하나가 있어야 해요.')] : []),
        ...manualView(SECTIONS[0]),
        ...decideView,
        ...workerView,
        ...prView,
        ...SECTIONS.slice(2).flatMap(manualView),
      ],
    })
  })
}
