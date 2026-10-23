import { test, expect } from 'claude-code/testing'
import { parseWorkers, countQuestions, parsePullRequests, prFor, checkSummary, statusLine, workerFor, unmappedWorkers, workerLine, progressBar, stepProgress, itemProgress, stepRows, stepSummary, stepMark, stepBody, parseStep, overallProgress, mainRoot, mergeVerdict, sortPullRequests, parseQuestions, questionText, START_PROMPT } from '../hooks/register.js'

test('일하는 worker 만 고르고 워크트리 이름을 꺼낸다', () => {
  const stdout = JSON.stringify({ result: { workers: [
    { dispatchId: 'a', dispatchStatus: 'dispatched', workerState: 'ready',
      resource: { worktreeId: 'x::/repo/worktrees/repo/ci-path-filter' } },
    { dispatchId: 'b', dispatchStatus: 'completed', workerState: 'succeeded', resource: { worktreeId: 'x::/repo/w/old' } },
  ] } })
  expect(parseWorkers(stdout)).toEqual([{ id: 'a', state: 'ready', worktree: 'ci-path-filter' }])
})

test('질문과 escalation 만 세고 heartbeat 는 세지 않는다', () => {
  const stdout = '{"messages":[{"type": "question"},{"type":"heartbeat"},{"type":"escalation"},{"type":"status"}]}'
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

test('상태 줄은 질문과 수동 decide 를 합쳐 결정 필요로 센다', () => {
  const line = statusLine([{ status: 'decide' }, { status: 'doing' }],
    { questions: 2, workers: [{}, {}], prs: [{ fail: 1 }, { fail: 0 }] })
  expect(line).toBe('결정 필요 3 · worker 2 · PR 2(CI 실패 1) · 진행 1   /board')
  expect(statusLine([], { questions: null, workers: null, prs: null })).toBe('')
})

test('항목의 worktree 로 worker 를 붙이고, 안 붙은 worker 만 따로 고른다', () => {
  const workers = [{ id: 'a', state: 'ready', worktree: 'ci-path-filter' }, { id: 'b', state: 'busy', worktree: 'other' }]
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
  const stdout = '{"ok":true,"result":{"messages":[{"id":"m1","type":"question","from_handle":"dispatch:ctx_a","body":"둘 중\n무엇으로 할까요?","payload":"{\\"dispatchId\\":\\"ctx_a\\",\\"question\\":\\"A 와 B 중 무엇으로 할까요?\\"}","created_at":"2026-10-12T10:00:00Z"},{"id":"m2","type":"status","body":"x"}]}}'
  const questions = parseQuestions(stdout)
  expect(questions.length).toBe(1)
  expect(questions[0].dispatch).toBe('ctx_a')
  expect(questions[0].text).toBe('A 와 B 중 무엇으로 할까요?')
  expect(questionText('가'.repeat(10), 5)).toBe('가가가가…')
  expect(parseQuestions('깨진 {"type": "question"').length).toBe(1)
})

test('오늘 시작 요청은 board 갱신, 완료 비우기, 정리, 감시, 보고를 모두 담는다', () => {
  expect(START_PROMPT).toContain('완료(done) 항목은 비운다')
  expect(START_PROMPT).toContain('현재 저장소의 남은 워크트리')
  expect(START_PROMPT).toContain('.claude/orch-overlay.md 의 정리 규칙')
  expect(START_PROMPT).not.toMatch(/fos-|세 저장소/)
  expect(START_PROMPT).toContain('orch-watch')
  expect(START_PROMPT).toContain('정할 것은 바로 물어본다')
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
