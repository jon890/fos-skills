import { test, expect } from 'claude-code/testing'
import { parseWorkers, countQuestions, parsePullRequests, prFor, checkSummary, statusLine, decideCount, workerFor, unmappedWorkers, workerLine, progressBar, stepProgress, itemProgress, stepRows, stepSummary, stepMark, stepBody, parseStep, overallProgress, mainRoot, mergeVerdict, sortPullRequests, parseQuestions, queryWorkers, questionText, decisionOf } from '../hooks/register.js'
import { queryQuestions } from '../hooks/register.js'

test('수만 건의 전체 inbox 대신 Run 질문과 worker 답변만 조회한다', async () => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', thread_id: 'q', read: 1 }
  const old = { ...q, id: 'old', thread_id: 'old', read: 0 }
  const reply = { ...q, id: 'reply', type: 'status', from_handle: 'run:r', to_handle: 'dispatch:d' }
  const globalInbox = JSON.stringify({ messages: Array.from({ length: 30000 }, (_, i) => ({ ...q, id: String(i), body: 'x'.repeat(1500) })) })
  expect(globalInbox.length).toBeGreaterThan(40_000_000)
  const calls: string[][] = []
  const $ = { process: { run: async (argv) => {
    calls.push(argv)
    const messages = argv.includes('check') ? (argv.includes('--peek') ? [old] : [q])
      : argv.includes('--terminal') ? [reply] : null
    return { exitCode: 0, stdout: messages ? JSON.stringify({ messages }) : globalInbox, stderr: '' }
  } } }
  const result = await queryQuestions($, 'r')
  expect(result.questions.map((m) => m.id)).toEqual(['old'])
  expect(result.limited).toBe(false)
  expect(calls).toEqual([
    ['orca', 'orchestration', 'check', '--run', 'r', '--all', '--types', 'question,escalation', '--json'],
    ['orca', 'orchestration', 'check', '--run', 'r', '--peek', '--types', 'question,escalation', '--json'],
    ['orca', 'orchestration', 'inbox', '--terminal', 'dispatch:d', '--limit', '200', '--json'],
  ])
})

test('끝난 dispatch 의 질문은 세지 않고 그 발신자의 inbox 도 읽지 않는다', async () => {
  const ask = (id, from, type = 'question') => ({ id, type, run_id: 'r', to_handle: 'run:r', from_handle: from })
  const rows = [ask('old-q', 'dispatch:closed'), ask('old-e', 'dispatch:closed', 'escalation'), ask('live-q', 'dispatch:open')]
  const calls: string[][] = []
  const $ = { process: { run: async (argv) => {
    calls.push(argv)
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ messages: argv.includes('check') ? rows : [] }) }
  } } }
  const result = await queryQuestions($, 'r', [{ id: 'open', terminal: '' }])
  expect(result.questions.map((m) => m.id)).toEqual(['live-q'])
  const inboxed = calls.filter((argv) => argv.includes('inbox')).map((argv) => argv[argv.indexOf('--terminal') + 1])
  expect(inboxed).toEqual(['dispatch:open'])
  // 살아 있는 dispatch 가 없으면 모두 닫힌 것이다
  expect((await queryQuestions($, 'r', [])).questions).toEqual([])
  // 목록을 주지 않으면 거르지 않는다. 같은 dispatch(closed)의 질문과 escalation 은 하나로 묶인다
  expect((await queryQuestions($, 'r')).questions.map((m) => [m.id, m.repeats])).toEqual([['old-e', 1], ['live-q', 0]])
})

test('터미널 handle 로 온 질문은 payload 의 dispatch 나 살아 있는 worker 의 터미널로 판정한다', async () => {
  const ask = (id, from, dispatchId?) => ({ id, type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: from,
    ...(dispatchId ? { payload: JSON.stringify({ dispatchId }) } : {}) })
  const rows = [
    ask('payload-closed', 'term_x', 'closed'),
    ask('term-live', 'term_live'),
    ask('term-closed', 'term_closed'),
  ]
  const $ = { process: { run: async (argv) => ({ exitCode: 0, stderr: '',
    stdout: JSON.stringify({ messages: argv.includes('check') ? rows : [] }) }) } }
  const result = await queryQuestions($, 'r', [{ id: 'open', terminal: 'term_live' }])
  expect(result.questions.map((m) => m.id)).toEqual(['term-live'])
})

test('끝난 dispatch 를 적은 질문은 같은 터미널이 새 worker 에 재사용돼도 세지 않는다', async () => {
  const closed = { id: 'old', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_reused', payload: { dispatchId: 'closed', question: '옛 질문' } }
  const current = { id: 'new', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_reused', payload: { dispatchId: 'open', question: '새 질문' } }
  const $ = { process: { run: async (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ messages: argv.includes('check') ? [closed, current] : [] }) }) } }
  expect((await queryQuestions($, 'r', [{ id: 'open', terminal: 'term_reused' }])).questions).toEqual([
    { id: 'new', type: 'question', dispatch: 'open', text: '새 질문', at: '', repeats: 0 },
  ])
})

test('코디네이터 터미널이 worker 의 dispatch 로 보낸 회신은 답이고, 그 dispatch 의 inbox 를 읽는다', async () => {
  // 실측: 회신은 type status, thread_id 가 질문 id, to_handle 이 dispatch:<그 터미널의 지금 dispatch>, 보낸 사람은 term_* 다
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w', thread_id: 'q' }
  const reply = { id: 'ans', type: 'status', run_id: 'r', thread_id: 'q', from_handle: 'term_c', to_handle: 'dispatch:open' }
  const unrelated = { id: 'x', type: 'status', run_id: 'r', thread_id: 'other', from_handle: 'term_c', to_handle: 'dispatch:open' }
  const inboxes = { 'dispatch:open': [reply, unrelated], term_w: [] }
  const calls: string[][] = []
  const $ = { process: { run: async (argv) => {
    calls.push(argv)
    const handle = argv[argv.indexOf('--terminal') + 1]
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ messages: argv.includes('check') ? [q] : inboxes[handle] }) }
  } } }
  const active = [{ id: 'open', terminal: 'term_w' }]
  expect((await queryQuestions($, 'r', active)).questions).toEqual([])
  const inboxed = calls.filter((argv) => argv.includes('inbox')).map((argv) => argv[argv.indexOf('--terminal') + 1])
  expect(inboxed.sort()).toEqual(['dispatch:open', 'term_w'])
  // 그 회신이 없으면 질문이 남는다
  inboxes['dispatch:open'] = [unrelated]
  expect((await queryQuestions($, 'r', active)).questions.map((m) => m.id)).toEqual(['q'])
})

test('worker 의 후속 status 는 Run 으로 가므로 답이 아니다', () => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w', thread_id: 'q' }
  const follow = { id: 'f', type: 'status', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w', thread_id: 'q' }
  expect(parseQuestions(JSON.stringify({ messages: [q, follow] }), 'r').map((m) => m.id)).toEqual(['q'])
  const reply = { ...follow, id: 'a', from_handle: 'term_c', to_handle: 'dispatch:d' }
  expect(parseQuestions(JSON.stringify({ messages: [q, follow, reply] }), 'r')).toEqual([])
  // 받는 쪽이 없는 thread 메시지도 답이 아니다
  const { to_handle: _, ...nowhere } = reply
  expect(parseQuestions(JSON.stringify({ messages: [q, nowhere] }), 'r').map((m) => m.id)).toEqual(['q'])
})

test('같은 worker 의 미답변 질문은 가장 늦은 하나로 묶고, 답한 질문보다 이른 미답변은 뺀다', () => {
  const ask = (id, at, dispatchId = 'd') => ({ id, type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w',
    thread_id: id, payload: JSON.stringify({ dispatchId, question: id }), ...(at === null ? {} : { created_at: at }) })
  const answer = (id) => ({ id: 'a-' + id, type: 'status', run_id: 'r', thread_id: id, from_handle: 'term_c', to_handle: 'dispatch:d' })
  const parse = (messages, keyOf?) => parseQuestions(JSON.stringify({ messages }), 'r', keyOf)
    .map((m) => ({ id: m.id, repeats: m.repeats }))
  // 미답변 둘은 늦은 하나로 나오고 repeats 가 1 이다
  expect(parse([ask('q2', '2026-10-26T10:05:00Z'), ask('q1', '2026-10-26T10:00:00Z')])).toEqual([{ id: 'q2', repeats: 1 }])
  // 앞 질문이 미답변이고 뒤 질문이 답했으면 둘 다 빠진다
  expect(parse([ask('q1', '2026-10-26T10:00:00Z'), ask('q2', '2026-10-26T10:05:00Z'), answer('q2')])).toEqual([])
  // 답한 질문보다 늦게 다시 보낸 미답변은 남는다
  expect(parse([ask('q1', '2026-10-26T10:00:00Z'), answer('q1'), ask('q2', '2026-10-26T10:05:00Z')])).toEqual([{ id: 'q2', repeats: 0 }])
  // created_at 이 같으면 입력 순서가 뒤인 것이, 없는 행은 있는 행보다 이른 것으로 본다
  expect(parse([ask('q1', '2026-10-26T10:00:00Z'), ask('q2', '2026-10-26T10:00:00Z')])).toEqual([{ id: 'q2', repeats: 1 }])
  expect(parse([ask('q2', '2026-10-26T10:00:00Z'), ask('q1', null)])).toEqual([{ id: 'q2', repeats: 1 }])
  // dispatch 가 다르면 따로 센다. keyOf 가 같은 worker 로 보면 묶는다
  const split = [ask('q1', '2026-10-26T10:00:00Z', 'old'), ask('q2', '2026-10-26T10:05:00Z', 'd')]
  expect(parse(split)).toEqual([{ id: 'q1', repeats: 0 }, { id: 'q2', repeats: 0 }])
  expect(parse(split, () => 'w')).toEqual([{ id: 'q2', repeats: 1 }])
})

test('객체 payload도 문자열 payload와 같이 dispatch와 질문 본문을 읽는다', () => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w', created_at: '2026-10-26T10:00:00Z',
    payload: { dispatchId: 'd', question: '결정: 저장 형식\n권장: JSON' } }
  expect(parseQuestions(JSON.stringify({ messages: [q] }), 'r')).toEqual([
    { id: 'q', type: 'question', dispatch: 'd', text: '결정: 저장 형식\n권장: JSON', at: '2026-10-26T10:00:00Z', repeats: 0 },
  ])
})

test('질문 100건 상한은 조회 범위를 표시하고 답변 기록 상한은 오류로 표시한다', async () => {
  const q = { id: 'q', type: 'escalation', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d' }
  let replies = []
  const $ = { process: { run: async (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({
    messages: argv.includes('check') ? Array(100).fill(q) : replies,
  }) }) } }
  expect((await queryQuestions($, 'r')).limited).toBe(true)
  replies = Array(200).fill({ id: 'follow', type: 'status', from_handle: 'dispatch:other', run_id: 'r' })
  let failure = ''
  try { await queryQuestions($, 'r') } catch (error) { failure = error.message }
  expect(failure).toContain('답변 기록 한도')
  replies[0] = { id: 'answer', thread_id: 'q', from_handle: 'run:r', to_handle: 'dispatch:d', run_id: 'r' }
  expect((await queryQuestions($, 'r')).questions).toEqual([])
})

test('한도에 닿은 handle 이 있어도 다른 handle 의 회신으로 답한 질문은 오류 없이 빠진다', async () => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'term_w', thread_id: 'q' }
  const reply = { id: 'ans', type: 'status', run_id: 'r', thread_id: 'q', from_handle: 'term_c', to_handle: 'dispatch:open' }
  const noise = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, type: 'status', run_id: 'r', from_handle: 'term_x', to_handle: 'term_w' }))
  const inboxes = { term_w: noise, 'dispatch:open': [reply] }
  const $ = { process: { run: async (argv) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({
    messages: argv.includes('check') ? [q] : inboxes[argv[argv.indexOf('--terminal') + 1]],
  }) }) } }
  const active = [{ id: 'open', terminal: 'term_w' }]
  expect((await queryQuestions($, 'r', active)).questions).toEqual([])
  // 회신이 어느 handle 에도 없으면 잘린 term_w 기록에 있을 수 있어 오류다
  inboxes['dispatch:open'] = []
  let failure = ''
  try { await queryQuestions($, 'r', active) } catch (error) { failure = error.message }
  expect(failure).toContain('답변 기록 한도')
})

test('프로세스 출력이 잘렸으면 JSON 파싱 전에 한도 오류로 표시한다', async () => {
  const $ = { process: { run: async () => ({ exitCode: 0, stdout: '{"messages":[', stderr: '', isStdoutTruncated: true }) } }
  let failure = ''
  try { await queryQuestions($, 'r') } catch (error) { failure = error.message }
  expect(failure).toContain('4 MiB')
})

test('일하는 worker 만 고르고 워크트리 이름을 꺼낸다', () => {
  const stdout = JSON.stringify({ result: { workers: [
    { dispatchId: 'a', agentTerminalHandle: 'term_a', dispatchStatus: 'dispatched', workerState: 'ready',
      resource: { worktreeId: 'x::/repo/worktrees/repo/ci-path-filter' } },
    { dispatchId: 'b', dispatchStatus: 'pending', workerState: 'ready', resource: { worktreeId: 'x::/repo/w/pending' } },
    { dispatchId: 'c', dispatchStatus: 'running', workerState: 'working', resource: { worktreeId: 'x::/repo/w/running' } },
    { dispatchId: 'd', dispatchStatus: 'completed', workerState: 'succeeded', resource: { worktreeId: 'x::/repo/w/old' } },
  ] } })
  expect(parseWorkers(stdout)).toEqual([
    { id: 'a', terminal: 'term_a', state: 'ready', worktree: 'ci-path-filter' },
    { id: 'b', terminal: '', state: 'ready', worktree: 'pending' },
    { id: 'c', terminal: '', state: 'working', worktree: 'running' },
  ])
})

test('worker 목록은 모든 페이지를 읽고 반복 cursor는 오류로 만든다', async () => {
  const calls = []
  const $ = { process: { run: async (argv) => {
    calls.push(argv)
    const cursor = argv.includes('--cursor') ? argv[argv.indexOf('--cursor') + 1] : ''
    const result = cursor ? { workers: [{ dispatchId: 'b', dispatchStatus: 'running' }], page: {} }
      : { workers: [{ dispatchId: 'a', dispatchStatus: 'dispatched' }], page: { nextCursor: 'next' } }
    return { exitCode: 0, stdout: JSON.stringify({ result }), stderr: '' }
  } } }
  expect(await queryWorkers($, 'r')).toEqual([
    { id: 'a', terminal: '', state: '', worktree: '' }, { id: 'b', terminal: '', state: '', worktree: '' },
  ])
  expect(calls).toHaveLength(2)
  const looping = { process: { run: async () => ({ exitCode: 0, stdout: JSON.stringify({ result: { workers: [], page: { nextCursor: 'again' } } }), stderr: '' }) } }
  await expect(queryWorkers(looping, 'r')).rejects.toThrow('다음 페이지')
})

test('질문과 escalation 만 세고 heartbeat 는 세지 않는다', () => {
  const stdout = JSON.stringify({ messages: ['question', 'heartbeat', 'escalation', 'status'].map((type, i) => ({ id: 'm' + i, type, run_id: 'r', to_handle: 'run:r' })) })
  expect(countQuestions(stdout)).toBe(2)
})

test('PR 의 CI 결과를 통과, 실패, 진행으로 나누고 worker 에 붙인다', () => {
  const prs = parsePullRequests(JSON.stringify([{
    number: 503, title: 'CI 필터', headRefName: 'jon890/ci-path-filter', isDraft: false, mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { state: 'PENDING' }, { conclusion: 'SKIPPED' }],
  }]))
  expect(prs[0]).toMatchObject({ number: 503, pass: 2, fail: 1, pending: 1, draft: false })
  expect(checkSummary(prs[0])).toBe('CI 2/4 · 실패 1 · 진행 1')
  expect(prFor({ id: 'a', state: '', worktree: 'ci-path-filter' }, prs)?.number).toBe(503)
  expect(prFor({ id: 'b', state: '', worktree: 'path-filter' }, prs)).toBe(null)
})

test('decide 항목은 끝나지 않은 줄을 세고 줄이 없는 항목은 1 로 센다', () => {
  const items = [
    { status: 'decide', details: [{ text: '저장 형식', done: true }, { text: '배포 시점', done: false }], next: [{ text: '이름', done: false }] },
    { status: 'decide', title: '줄 없음' },
    { status: 'decide', details: ['✓ 끝낸 결정'] },
    { status: 'doing', details: [{ text: '1 a', done: false }] },
  ]
  expect(decideCount(items)).toBe(3)
  expect(decideCount([])).toBe(0)
  expect(statusLine(items, { questions: [{}] })).toBe('결정 필요 4 · 진행 1   /board')
})

test('상태 줄은 질문과 수동 decide 를 합쳐 결정 필요로 센다', () => {
  const line = statusLine([{ status: 'decide' }, { status: 'doing' }],
    { questions: 2, workers: [{}, {}], prs: [{ fail: 1 }, { fail: 0 }] })
  expect(line).toBe('결정 필요 3 · worker 2 · PR 2(CI 실패 1) · 진행 1   /board')
  expect(statusLine([], { questions: null, workers: null, prs: null })).toBe('')
  expect(statusLine([], { questions: null, errors: { questions: 'offline' } })).toContain('결정 필요 확인 불가')
  expect(statusLine([], { questions: [], questionsLimited: true })).toContain('결정 필요 0(최근 질문 기준)')
})

test('항목의 worktree 로 worker 를 붙이고, 안 붙은 worker 만 따로 고른다', () => {
  const workers = [{ id: 'a', terminal: 'term_a', state: 'ready', worktree: 'ci-path-filter' }, { id: 'b', state: 'busy', worktree: 'other' }]
  const items = [{ id: 'x', status: 'doing', worktree: 'ci-path-filter' }, { id: 'y', status: 'done', worktree: 'other' }]
  expect(workerFor(items[0], workers)?.id).toBe('a')
  expect(unmappedWorkers(items, workers).map((w) => w.id)).toEqual(['b'])
  const prs = [{ number: 503, branch: 'jon890/ci-path-filter', pass: 9, fail: 0, pending: 0 }]
  expect(workerLine(workers[0], prs)).toBe('ci-path-filter  #503 CI 9/9')
  expect(workerLine(workers[1], prs)).toBe('other  busy')
})

test('진행 표시줄은 끝낸 단계 비율로 칸을 채운다', () => {
  expect(progressBar('7/10', 10)).toBe('███████░░░ 7/10 (70%)')
  expect(progressBar('3 / 4', 4)).toBe('███░ 3/4 (75%)')
  expect(progressBar('abc')).toBe(null)
  expect(progressBar('1/0')).toBe(null)
})

test('진행률은 숫자로 시작하는 단계 줄에서 센다', () => {
  expect(stepProgress(['✓ 1 a', '✓ 2 b', '3 c', '4 d'])).toBe('2/4')
  expect(stepProgress(['1 a', '2 b'])).toBe('0/2')
  expect(stepProgress(['참고: x', '✓ 메모', '✓ 1 a', '2 b'])).toBe('1/2')
  expect(stepProgress(['참고만 있다'])).toBe(null)
  expect(stepProgress(undefined)).toBe(null)
})

test('번호 점, 괄호, ✓, [x] 를 단계 줄로 알아본다', () => {
  expect(parseStep('1. 구현')).toEqual({ number: 1, done: false })
  expect(parseStep('✓ 2. 리뷰')).toEqual({ number: 2, done: true })
  expect(parseStep('[x] 3) 머지')).toEqual({ number: 3, done: true })
  expect(parseStep('[ ] 4 검증')).toEqual({ number: 4, done: false })
  expect(parseStep('▶ 5 진행')).toEqual({ number: 5, done: false })
  expect(parseStep('2026-10-16 결정')).toBe(null)
  expect(parseStep('참고: 1. x')).toBe(null)
  expect(stepProgress(['✓ 1. a', '[x] 2. b', '[ ] 3. c', '4) d'])).toBe('2/4')
})

test('details 에 단계가 없으면 next 의 번호 줄을 센다', () => {
  expect(itemProgress({ next: '✓ 1. 구현\n2. 리뷰\n3. 머지' })).toBe('1/3')
  expect(itemProgress({ next: '1. 할 일', details: ['✓ 1 a', '2 b'] })).toBe('1/2')
  expect(itemProgress({ next: '다음은 머지' })).toBe(null)
})

test('progress 가 있으면 단계 수보다 우선한다', () => {
  expect(itemProgress({ progress: '7/10', details: ['✓ 1 a', '2 b'] })).toBe('7/10')
  expect(itemProgress({ progress: '거의 완료', details: ['✓ 1 a', '2 b'] })).toBe('1/2')
  expect(itemProgress({ progress: '거의 완료' })).toBe(null)
  expect(itemProgress({ details: ['✓ 1 a', '2 b'] })).toBe('1/2')
  expect(itemProgress({ title: 'x' })).toBe(null)
})

test('details 와 next 를 줄마다 나눠 끝낸 줄, 지금 단계, 남은 단계, 참고 줄로 가른다', () => {
  const rows = stepRows({ details: ['✓ 1 a', '[x] 2 b', '▶ 3 c', '◇ 4 d', '참고: x'], next: '머지 뒤 갱신' })
  expect(rows).toEqual([
    { text: '1 a', state: 'done', step: true, counted: true },
    { text: '2 b', state: 'done', step: true, counted: true },
    { text: '3 c', state: 'now', step: true, counted: true },
    { text: '4 d', state: 'todo', step: true, counted: true },
    { text: '참고: x', state: 'note', step: false, counted: true },
    { text: '머지 뒤 갱신', state: 'note', step: false, counted: false },
  ])
  expect(stepSummary(rows)).toEqual({ now: rows[2], done: 2, todo: 1 })
})

test('지금 단계는 진행률을 세는 쪽에서 고르고, 단계가 없으면 첫 참고 줄을 쓴다', () => {
  const states = (item) => stepRows(item).map((row) => row.state)
  // details 에 단계가 없으면 next 의 단계를 센다
  expect(states({ details: ['메모'], next: '✓ 1. 구현\n2. 리뷰\n\n3. 머지' })).toEqual(['note', 'done', 'now', 'todo'])
  expect(states({ details: ['✓ 1 a'], next: '2 b' })).toEqual(['done', 'now'])
  expect(states({ next: 'PR 리뷰 기다림' })).toEqual(['now'])
  expect(states({ next: '✓ 1 a' })).toEqual(['done'])
  // 단계가 모두 끝났으면 참고 줄을 지금 단계로 올리지 않는다
  expect(states({ next: '✓ 1 a\n머지 뒤 갱신' })).toEqual(['done', 'note'])
  expect(stepRows({})).toEqual([])
})

test('접힌 보기의 수는 막대와 같은 쪽의 단계 줄만 센다', () => {
  // 막대는 details 의 단계로 1/3 이다. next 의 단계와 「✓」 참고 줄은 수에 넣지 않는다
  const item = { details: ['✓ 1 a', '2 b', '3 c', '✓ 메모'], next: '✓ 1. x\n2. y\n3. z' }
  expect(itemProgress(item)).toBe('1/3')
  expect(stepSummary(stepRows(item))).toMatchObject({ now: { text: '2 b' }, done: 1, todo: 1 })
  // progress 필드가 있으면 막대가 그 값을 쓰므로 수도 그 값에서 낸다
  const fixed = { progress: '7/10', next: '✓ 1 a\n2 b\n3 c' }
  expect(itemProgress(fixed)).toBe('7/10')
  expect(stepSummary(stepRows(fixed), fixed.progress)).toMatchObject({ now: { text: '2 b' }, done: 7, todo: 2 })
  expect(stepSummary(stepRows({ next: '메모' }), '3/3')).toMatchObject({ done: 3, todo: 0 })
  // 세는 쪽이 다 끝나 다른 쪽에서 지금 단계를 고르면 남은 단계도 그쪽에서 센다
  expect(stepSummary(stepRows({ details: ['✓ 1 a'], next: '2 b\n3 c\n4 d' }))).toMatchObject({ now: { text: '2 b' }, done: 1, todo: 2 })
})

test('단계 줄의 앞 표시는 표시 칸으로 옮기고 본문은 번호부터 시작한다', () => {
  expect(['✓ 1. a', '[x] 2 b', '[ ] 3 c', '▶ 4 d', '◇ 5 e', '6) f', '✓ 메모'].map(stepBody))
    .toEqual(['1. a', '2 b', '3 c', '4 d', '5 e', '6) f', '메모'])
  expect(['done', 'now', 'todo', 'note'].map((state) => stepMark({ state }))).toEqual(['✓', '▶', ' ', ' '])
})

test('git 공통 디렉터리에서 주 checkout 의 root 를 꺼낸다', () => {
  expect(mainRoot('/repo/.git\n')).toBe('/repo')
  expect(mainRoot('/repo/.git/')).toBe('/repo')
  expect(mainRoot('/bare.git')).toBe('')
})

test('Ready 이고 필수 검사가 통과한 PR 을 머지 가능으로 보고 맨 위에 둔다', () => {
  const pr = (number, draft, merge, extra = {}) => ({ number, title: '', draft, merge, pass: 9, fail: 0, pending: 0, failed: [], ...extra })
  const prs = [
    pr(1, true, 'CLEAN'),
    pr(2, false, 'BLOCKED', { pending: 3 }),
    pr(3, false, 'UNSTABLE', { fail: 1, failed: ['claude-review'] }),
    pr(4, false, 'BLOCKED', { fail: 1, failed: ['backend'] }),
    pr(5, false, 'DIRTY'),
  ]
  expect(mergeVerdict(prs[2]).label).toBe('머지 가능')
  expect(mergeVerdict(prs[3]).label).toBe('CI 실패')
  expect(mergeVerdict(prs[0]).label).toBe('CI 통과, Ready 전')
  expect(sortPullRequests(prs).map((p) => p.number)).toEqual([3, 2, 4, 5, 1])
})

test('답을 기다리는 질문의 본문과 보낸 worker 를 꺼낸다', () => {
  const stdout = JSON.stringify({ result: { messages: [{ id: 'm1', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:ctx_a', body: '둘 중 무엇으로 할까요?', payload: JSON.stringify({ dispatchId: 'ctx_a', question: 'A 와 B 중 무엇으로 할까요?' }), created_at: '2026-10-12T10:00:00Z' }] } })
  const questions = parseQuestions(stdout)
  expect(questions.length).toBe(1)
  expect(questions[0].dispatch).toBe('ctx_a')
  expect(questions[0].text).toBe('A 와 B 중 무엇으로 할까요?')
  expect(questionText('가'.repeat(10), 5)).toBe('가가가가…')
  expect(() => parseQuestions('깨진 {"type": "question"')).toThrow()
})

test('결정 질문 형식이면 제목과 권장안을 꺼내고 형식이 없으면 null 이다', () => {
  const body = '결정: 저장 형식을 바꿀까요\n배경: 마이그레이션이 필요해요\n선택지:\n- 바꾼다: 빠르다\n- 둔다: 안전하다\n권장: 둔다. 사용자 데이터가 있다'
  expect(decisionOf(body)).toEqual({ title: '저장 형식을 바꿀까요', recommend: '둔다. 사용자 데이터가 있다' })
  expect(decisionOf('결정: 제목만\n- a\n- b')).toEqual({ title: '제목만', recommend: null })
  expect(decisionOf('A 와 B 중 무엇으로 할까요?')).toBeNull()
  expect(decisionOf('배경: 첫 줄이 결정이 아니다\n결정: x\n권장: y')).toBeNull()
  expect(decisionOf('')).toBeNull()
  expect(decisionOf('결정:  \n- a\n- b\n권장: a')).toBeNull()
})

test('전체 진행률은 진행 중 항목의 끝낸 단계 합과 전체 단계 합이다', () => {
  const items = [
    { status: 'doing', next: '✓ 1. a\n2. b' },
    { status: 'doing', details: ['[x] 1 a', '[x] 2 b', '3 c'] },
    { status: 'doing', progress: '1/5' },
    { status: 'doing', title: '옛 항목' },
    { status: 'wait', details: ['1 a', '2 b'] },
    { status: 'done', progress: '3/3' },
  ]
  expect(overallProgress(items)).toEqual({ done: 4, total: 10, missing: 1 })
  expect(progressBar('4/10', 10)).toBe('████░░░░░░ 4/10 (40%)')
  expect(overallProgress([{ status: 'wait' }])).toEqual({ done: 0, total: 0, missing: 0 })
})


test('객체의 done 으로 진행률과 지금 단계, 표시를 정하고 혼합 형식도 읽는다', () => {
  const item = { details: [{ text: '1 a', done: true }, { text: '2 b', done: false }, '✓ 3 c',
    { text: '참고', done: false }], next: [{ text: '4 d', done: false }] }
  expect(itemProgress(item)).toBe('2/3')
  expect(parseStep({ text: '✓ 1 a', done: false })).toEqual({ number: 1, done: false })
  const rows = stepRows(item)
  expect(rows.map((row) => [row.text, row.state, stepMark(row)])).toEqual([
    ['1 a', 'done', '✓'], ['2 b', 'now', '▶'], ['3 c', 'done', '✓'],
    ['참고', 'note', ' '], ['4 d', 'todo', ' '],
  ])
  expect(itemProgress({ next: [{ text: '1 a', done: true }, { text: '2 b', done: false }] })).toBe('1/2')
  expect(stepSummary(rows)).toMatchObject({ done: 2, todo: 0 })
})


test('답변은 ack 전에 질문을 지우고 worker 후속 글은 답변으로 세지 않는다', () => {
  const q = { id: 'q', type: 'question', run_id: 'r', to_handle: 'run:r', from_handle: 'dispatch:d', thread_id: 'q', read: 1 }
  const follow = { ...q, id: 'follow', type: 'status' }
  const other = { ...q, id: 'other', run_id: 'other', to_handle: 'run:other' }
  expect(countQuestions(JSON.stringify({ messages: [q, follow, other] }), 'r')).toBe(1)
  const reply = { ...follow, id: 'answer', from_handle: 'run:r', to_handle: 'dispatch:d' }
  expect(countQuestions(JSON.stringify({ messages: [q, reply] }), 'r')).toBe(0)
  expect(countQuestions(JSON.stringify({ messages: [{ ...q, type: 'escalation' }, reply] }), 'r')).toBe(0)
  expect(() => parseQuestions('broken')).toThrow()
  expect(() => parseQuestions('{"ok":false}')).toThrow()
})
