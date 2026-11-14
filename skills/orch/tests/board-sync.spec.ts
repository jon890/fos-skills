// board-sync.ts 를 임시 보드, 가짜 gh, 저장소의 실제 extensions/work-board/bin/board.ts 로 돌려 본다. GitHub 에는 닿지 않는다.
//
// 가짜 gh 는 --repo 로 준 폴더의 state.json 에서 PR 번호의 상태를 읽는다. 없는 번호는 조회 실패다.
// BOARD_BIN 을 주지 않으므로 기본 보드 명령(extensions/work-board/bin/board.ts)이 항목을 고친다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/board/board-sync.ts', import.meta.url))

// 배포 확인의 조회: \`pr view N --json mergeCommit\` 은 state['merge:N'], \`run list\` 는 state.runs 를 낸다.
// 마지막 PR 판정의 조회: \`pr view N --json title,headRefName\` 은 state['info:N'], 열린 PR 목록(\`--json number,title\`)은 state.open,
// \`--head B\` 목록은 state.list 에서 그 브랜치의 행만 낸다
const FAKE_GH = `const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'))
const args = process.argv.slice(2)
const say = (value) => fs.writeSync(1, (typeof value === 'string' ? value : JSON.stringify(value)) + '\\n')
const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : null
if (args[0] === 'run' && args[1] === 'list') say(state.runs || [])
else if (args[1] === 'view' && args.includes('body,headRefOid,headRefName')) {
  if (state.evidenceFails) process.exit(1)
  say(state['evidence:' + args[2]] || {})
}
else if (args[1] === 'view' && args.includes('mergeCommit')) {
  if (!state['merge:' + args[2]]) process.exit(1)
  say(state['merge:' + args[2]])
} else if (args[1] === 'view' && args.includes('title,headRefName')) {
  if (!state['info:' + args[2]]) process.exit(1)
  say(state['info:' + args[2]])
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] in state) say(state[args[2]])
else if (args[1] === 'list' && args.includes('number,title')) say(state.open || [])
else if (args[1] === 'list' && head !== null) say((state.list || []).filter((pr) => pr.headRefName === head))
else if (args[1] === 'list') say(state.list || [])
else process.exit(1)
`

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let bindir: string
before(() => {
  bindir = realpathSync(mkdtempSync(join(tmpdir(), 'board-sync-bin-')))
  writeNodeBin(bindir, 'gh', FAKE_GH)
})
after(() => rmSync(bindir, { recursive: true, force: true }))

let tmp: string
let board: string
let states: Record<string, unknown>
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'board-sync-')))
  board = join(tmp, 'board.json')
  states = {}
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function run(args: string[], opts: { env?: Record<string, string> } = {}): Result {
  // shim 은 PATH 의 node 를 부른다. 이 테스트를 도는 node 를 앞에 둔다
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), GH: join(bindir, 'gh'), ...opts.env }
  if (!opts.env?.BOARD_BIN) delete env.BOARD_BIN
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]
  const done = spawnSync(argv[0], [...argv.slice(1), ...args], { env, cwd: tmp, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

// 보드를 쓰고 동기화한 뒤 종료 코드와 id 별 항목을 낸다
function sync(items: Json[], extra: string[] = [], opts: { boardBin?: string; env?: Record<string, string> } = {}): { code: number | null; board: Record<string, Json>; result: Result } {
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
  writeFileSync(board, JSON.stringify({ items }))
  const result = run(['--board', board, '--repo', tmp, ...extra, ...(opts.boardBin ? ['--board-bin', opts.boardBin] : [])], { env: opts.env })
  return { code: result.code, board: load(), result }
}

function load(): Record<string, Json> {
  const items = (JSON.parse(readFileSync(board, 'utf8')) as { items: Json[] }).items
  return Object.fromEntries(items.map((item) => [String(item.id), item]))
}

const step = (text: string, done: boolean): Json => ({ text, done })

const worker = (role: string, worktree: string, dispatch: string, extra = {}) => ({ role, worktree, dispatch, branch: 'feat/a', pr: null, at: '2026-01-01', status: 'working', endedAt: null, ...extra })

test('대표가 빈 구현 항목의 리뷰가 끝나도 열린 구현 PR 의 항목을 닫지 않는다', () => {
  states = { '7': 'OPEN' }
  const orch = join(tmp, 'orch')
  mkdirSync(join(orch, 'state'), { recursive: true })
  const impl = join(tmp, 'impl.md'), review = join(tmp, 'review.md')
  writeFileSync(impl, '# 구현\n보드 항목 id: implementation')
  writeFileSync(review, '# 리뷰\n보드 항목 id: implementation\n리뷰 PR: #7')
  writeFileSync(join(orch, 'state/launch-history.jsonl'), [
    { at: '2026-01-01T00:00:00Z', dispatch: 'd0', worktree: join(tmp, 'old'), spec: impl },
    { at: '2026-01-02T00:00:00Z', dispatch: 'd1', worktree: join(tmp, 'review'), spec: review },
  ].map((row) => JSON.stringify(row)).join('\n'))
  for (const pr of [7, null]) {
    const r = sync([{ id: 'implementation', status: 'doing', worktree: '', pr, stages: 'pr=1,merge=2',
      details: ['1. PR', '2. 머지'], workers: [worker('review', 'review', 'd1', { pr: 7 })] }],
    ['--worker-ends', '{"d1":"done"}', '--completed-items', '["implementation"]'], { env: { ORCH_DIR: orch } })
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.implementation.status, 'doing')
    assert.equal((r.board.implementation.details as any[])[1].done, false)
  }
})

test('루프 끝남은 해당 줄만 끝내고 done 항목의 줄도 끝낸다', () => {
  const r = sync([
    { id: 'a', status: 'doing', details: ['1. 남음'], workers: [worker('impl', 'w1', 'd1'), worker('review', 'r1', 'd2')] },
    { id: 'b', status: 'done', workers: [worker('review', 'r2', 'd3')] },
  ], ['--worker-ends', '{"d1":"done","d3":"done"}'])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal((r.board.a.workers as any[])[0].status, 'done')
  assert.equal((r.board.a.workers as any[])[1].status, 'working')
  assert.equal((r.board.b.workers as any[])[0].status, 'done')
  for (const value of ['[]', 'null', '{"d":"other"}', '{broken']) assert.equal(run(['--board', board, '--repo', tmp, '--worker-ends', value]).code, 2)
})

test('사라진 대표 줄을 끝낸 뒤 남은 후속 줄로 대표를 바꾼다', () => {
  // 실제 git 워크트리 목록을 사용한다.
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init')
  const name = basename(tmp)
  for (const follow of [true, false]) {
    const r = sync([{ id: 'a', status: 'doing', worktree: 'missing', details: ['1. 남음'], workers: [
      worker('impl', 'missing', 'd1'), ...(follow ? [worker('follow', name, 'd2', { at: '2026-02-01' })] : []),
    ] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal((r.board.a.workers as any[])[0].status, 'lost')
    assert.equal(r.board.a.worktree, follow ? name : undefined)
  }
})

test('리뷰 줄의 보고는 리뷰만 하는 항목만 닫고 구현 항목을 닫지 않는다', () => {
  states = { '7': 'OPEN' }
  const r = sync([
    { id: 'review-pr-7-a', status: 'doing', details: ['1. 리뷰'], workers: [worker('review', 'r', 'd1', { pr: 7 })] },
    { id: 'impl-a', status: 'doing', details: ['1. 구현'], workers: [worker('impl', 'w', 'd0'), worker('review', 'r2', 'd2', { pr: 7 })] },
  ], ['--worker-ends', '{"d1":"done","d2":"done"}'])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board['review-pr-7-a'].status, 'done')
  assert.equal(r.board['impl-a'].status, 'doing')
})

test('마지막 PR 을 판정하지 못하면 작업 중 리뷰 worker 가 있어도 항목을 닫지 않는다', () => {
  states = { '7': 'MERGED' }
  const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2', details: ['1. PR', '2. 머지'], workers: [
    worker('impl', 'w', 'd0'), worker('review', 'r', 'd1', { pr: 7 }),
  ] }])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board.a.status, 'doing')
  assert.deepEqual(r.board.a.details, ['1. PR', '2. 머지'])
  assert.equal((r.board.a.workers as any[])[1].status, 'working')
})

test('리뷰만 있는 항목은 마지막 줄이 끊겨도 닫고 상태 변경 뒤 끝난 줄만 복구한다', () => {
  states = { '7': 'OPEN' }
  for (const first of ['done', 'lost']) {
    const r = sync([{ id: 'review-pr-7-a', status: 'doing', details: ['1. 리뷰'], workers: [
      worker('review', 'r1', 'd1', { pr: 7, status: first }),
      worker('review', 'r2', 'd2', { pr: 7 }),
    ] }], ['--worker-ends', '{"d2":"lost"}'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board['review-pr-7-a'].status, 'done')
    assert.equal((r.board['review-pr-7-a'].workers as any[])[1].status, 'lost')
  }
  const r = sync([{ id: 'review-pr-7-a', status: 'doing', stepAt: '2026-01-01T00:00:00Z', details: ['1. 리뷰'], workers: [
    worker('review', 'r1', 'd1', { pr: 7, status: 'lost', endedAt: '2026-01-02T00:00:00Z' }),
  ] }])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board['review-pr-7-a'].status, 'done')
})

test('다시 연 리뷰 항목은 지난 끝남과 지난 완료 보고로 닫지 않는다', () => {
  states = { '7': 'OPEN' }
  const r = sync([{ id: 'review-pr-7', status: 'doing', stepAt: '2026-01-03T00:00:00Z', details: [{ text: '1. 후속 확인', done: false }], workers: [
    worker('review', 'r1', 'd1', { pr: 7, status: 'done', endedAt: '2026-01-02T00:00:00Z' }),
  ] }], ['--worker-ends', '{"d1":"done"}', '--completed-items', '["review-pr-7"]', '--completed-reviews', '[7]'])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board['review-pr-7'].status, 'doing')
  assert.equal((r.board['review-pr-7'].details as any[])[0].done, false)
})

test('시각 wait 는 첫 단계가 아니어도 지난 줄만 끝내며 항목 상태는 유지한다', () => {
  const details = ['참고: 설명', '1. 아직 앞 단계', '2. [wait: 2020-01-01 00:00] 지난 시각',
    '3. [wait: 2099-01-01 00:00] 미래', '4. [wait: 2026-02-30 00:00] 잘못된 날짜', '5. [wait: 내일 아침] 글', '6. [wait] 조건']
  const result = sync(['doing', 'wait', 'todo', 'goal', 'done'].map(status => ({ id: status, status, details })))
  assert.equal(result.code, 0, result.result.stderr)
  for (const status of ['doing', 'wait', 'todo', 'goal', 'done']) {
    const item = result.board[status]
    assert.equal(item.status, status)
    const rows = item.details as Array<Json | string>
    const marked = rows.filter(row => typeof row === 'object' && row.done === true).map(row => (row as Json).text)
    assert.deepEqual(marked, status === 'done' ? [] : [details[2]])
  }
})

describe('board-sync', () => {
  test('리뷰 완료 보고는 PR 이 열려 있어도 리뷰 항목의 남은 단계를 끝낸다', () => {
    states['7'] = 'OPEN'
    const result = sync([{ id: 'review-pr-7', status: 'doing', details: ['1. 리뷰', '2. 결과 보고'], worktree: 'review' }], ['--completed-reviews', '[7]'])
    assert.equal(result.code, 0, result.result.stderr)
    assert.equal(result.board['review-pr-7'].status, 'done')
    assert.ok((result.board['review-pr-7'].details as Json[]).every((detail) => detail.done))
  })

  test('대상 PR 이 머지되면 PR 칸이 빈 리뷰 항목도 끝내고 열린 리뷰는 남긴다', () => {
    states['7'] = 'MERGED'
    states['8'] = 'OPEN'
    const result = sync([
      { id: 'review-pr-7', status: 'doing', details: ['1. 리뷰', '2. 결과 보고'] },
      { id: 'review-pr-8', status: 'doing', details: ['1. 리뷰'] },
    ])
    assert.equal(result.code, 0, result.result.stderr)
    assert.equal(result.board['review-pr-7'].status, 'done')
    assert.equal(result.board['review-pr-8'].status, 'doing')
  })

  test('재리뷰, 다시 띄운 리뷰, 인수 검증 항목도 worker_done 이나 대상 PR 머지 뒤 끝낸다', () => {
    states['477'] = 'OPEN'
    states['486'] = 'MERGED'
    states['9'] = 'OPEN'
    const result = sync([
      { id: 'review-pr-477-r2', status: 'doing', details: ['1. 리뷰'] },
      { id: 'review-pr-486-b', status: 'doing', details: ['1. 리뷰'] },
      { id: 'verify-pr-486', status: 'doing', details: ['1. 검증'] },
      { id: 'review-pr-9-r2', status: 'doing', details: ['1. 리뷰'] },
    ], ['--completed-items', '["review-pr-477-r2"]', '--completed-reviews', '[9]'])
    assert.equal(result.code, 0, result.result.stderr)
    assert.equal(result.board['review-pr-477-r2'].status, 'done')
    assert.equal(result.board['review-pr-486-b'].status, 'done')
    assert.equal(result.board['verify-pr-486'].status, 'done')
    assert.equal(result.board['review-pr-9-r2'].status, 'doing')
  })

  test('review-pr-12abc 같은 다른 꼴의 id 는 리뷰 항목으로 보지 않는다', () => {
    states['12'] = 'MERGED'
    const result = sync([{ id: 'review-pr-12abc', status: 'doing', details: ['1. 리뷰'] }], ['--completed-reviews', '[12]'])
    assert.equal(result.code, 0, result.result.stderr)
    assert.equal(result.board['review-pr-12abc'].status, 'doing')
  })

  test('BOARD_BIN 이 없으면 저장소의 extensions/work-board/bin/board.ts 가 보드 항목을 done 으로 바꾼다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
  })

  test('짧은 출력은 BOARD <id> 와 BOARD-SYNC 판정 줄이고 설명 줄이 없다', () => {
    states['7'] = 'MERGED'
    writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
    writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현 #7'] }] }))
    const r = run(['--board', board, '--repo', tmp], { env: { ORCH_OUTPUT: 'short' } })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), ['BOARD a done', 'BOARD-SYNC 1'])
    assert.equal(load().a.status, 'done')
  })

  test('PR 번호가 없는 남은 단계는 머지로 끝내지 않는다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. PR 리뷰 반영', '✓ 3. 머지'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, undefined)
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. PR 리뷰 반영', false), step('3. 머지', true)])
    assert.match(r.result.stdout, /BOARD-UNMATCHED a PR #7/)
  })

  test('끝나지 않은 단계가 둘이면 그 PR 번호의 단계만 끝내고 pr 칸을 비운다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. PR #7 머지', '2. dev 테스트', '3. 후속 PR #70'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal('pr' in r.board.a, false)
    assert.deepEqual(r.board.a.details, [step('1. PR #7 머지', true), step('2. dev 테스트', false), step('3. 후속 PR #70', false)])
  })

  test('끝나지 않은 단계가 하나면 항목을 끝낸다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. 머지 #7'] }])
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true)])
  })

  test('체크박스 단계는 보드 명령이 done 값으로 끝내고 본문에 표시를 저장하지 않는다', () => {
    states['7'] = 'MERGED'
    const r = sync([
      { id: 'a', status: 'doing', pr: '#7', details: ['[x] 1. 구현', '[ ] 2. 머지 #7', '[ ] 3. 배포'] },
      { id: 'b', status: 'doing', pr: '#7', next: '[x] 1. 구현\n[ ] 2. 머지 #7' },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true), step('3. 배포', false)])
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.b.next, [step('1. 구현', true), step('2. 머지 #7', true)])
    assert.equal(r.board.b.status, 'done')
  })

  test('참고 줄은 끝나지 않은 단계로 세지 않는다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. 머지 #7', '참고: 후속 검토'] }])
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true), step('참고: 후속 검토', false)])
  })

  test('열린 PR 은 단계를 건드리지 않고 상태 줄도 쓰지 않는다', () => {
    states['8'] = 'OPEN'
    const items = [{ id: 'a', status: 'doing', pr: '8', details: ['1. 구현', '2. 리뷰'] }]
    const before = JSON.stringify({ items })
    const r = sync(items)
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(readFileSync(board, 'utf8'), before)
  })

  test('옛 자동 줄은 지운다', () => {
    states['8'] = 'OPEN'
    const r = sync([{ id: 'a', status: 'doing', pr: '8', details: ['1. 구현', '자동: PR #8 OPEN CLEAN'] }])
    assert.deepEqual(r.board.a.details, [step('1. 구현', false)])
    assert.equal(r.board.a.status, 'doing')
  })

  test('객체 단계는 옛 줄을 지우고 다시 돌려도 같다', () => {
    states['7'] = 'MERGED'
    const r = sync([
      { id: 'a', status: 'doing', pr: '7', details: [step('1. 구현', true), step('2. 머지 #7', false), step('3. 배포', false), step('자동: PR #7 OPEN', false)] },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true), step('3. 배포', false)])
    const again = sync(Object.values(r.board))
    assert.equal(again.code, 0, again.result.stderr)
    assert.deepEqual(again.board, r.board)
  })

  test('done 과 goal 항목, 조회에 실패한 PR 은 건너뛴다', () => {
    states['7'] = 'MERGED'
    const items = [{ id: 'g', status: 'goal' }, { id: 'd', status: 'done', pr: '7' }, { id: 'x', status: 'doing', pr: '99', details: ['1. 구현'] }]
    const before = JSON.stringify({ items })
    const r = sync(items)
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(readFileSync(board, 'utf8'), before)
    assert.match(r.result.stdout, /board-sync: 바뀐 항목 없음/)
  })

  test('--dry-run 은 보드를 고치지 않고 바뀔 항목과 부를 명령을 낸다', () => {
    states['7'] = 'MERGED'
    const items = [{ id: 'a', status: 'doing', pr: '7', details: ['1. 구현 #7'] }]
    const before = JSON.stringify({ items })
    const r = sync(items, ['--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(readFileSync(board, 'utf8'), before)
    assert.equal(r.result.stdout, 'a -> done\n  step a 1\n  set a done --worktree \nboard-sync: a\n')
  })

  test('단계 목록을 모르는 보드 명령이면 고치지 않고 1 로 멈춘다', () => {
    const oldBin = join(tmp, 'old-board.py')
    writeFileSync(oldBin, 'import sys\nsys.exit(2)\n')
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '7', details: ['1. 구현'] }], [], { boardBin: oldBin })
    assert.equal(r.code, 1)
    assert.equal(r.board.a.status, 'doing')
    assert.match(r.result.stderr, /단계 목록을 읽지 못했다: a/)
  })

  test('--goal 은 동기화 뒤 목표 진행률을 추적 항목으로 센다', () => {
    writeFileSync(join(tmp, 'items.txt'), 'a\n')
    states['7'] = 'MERGED'
    const r = sync([{ id: 'goal', status: 'goal' }, { id: 'a', status: 'doing', pr: '7', next: '1. 구현 #7' }], ['--goal', 'goal', '--goal-items', join(tmp, 'items.txt')])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.goal.progress, '1/1')
  })

  test('--goal 만 주면 목표 항목의 단계 줄을 센다', () => {
    states['7'] = 'MERGED'
    const r = sync(
      [{ id: 'g', status: 'goal', details: ['✓ 1. a', '2. b'] }, { id: 'a', status: 'doing', pr: '7', details: ['1. 구현'] }],
      ['--goal', 'g'],
    )
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.g.progress, '1/2')
  })

  test('--goal-items 는 --goal 과 함께 줘야 한다', () => {
    const r = run(['--board', board, '--goal-items', 'x'])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--goal-items 는 --goal 과 함께 준다/)
  })

  test('보드를 읽지 못하면 1 이다', () => {
    assert.equal(run(['--board', join(tmp, 'none.json')]).code, 1)
  })

})


test('같은 브랜치의 열린 PR 만 연결하고 다음 틱에도 보존한다', () => {
  states['9'] = 'OPEN'
  const r = sync([{ id: 'a', status: 'doing', branch: 'feat/a', details: ['1. 구현'] }], ['--open-prs', JSON.stringify([{ number: 8, headRefName: 'feat/ab' }, { number: 9, headRefName: 'feat/a' }])])
  assert.equal(r.code, 0, r.result.stderr)
  // board.ts 가 PR 번호 하나를 숫자로 저장한다
  assert.equal(r.board.a.pr, 9)
  assert.equal(r.board.a.status, 'doing')
  assert.equal(run(['--board', board, '--repo', tmp]).code, 0)
  assert.equal(load().a.pr, 9)
})

test('pr 칸이 비어도 같은 브랜치의 머지 PR 로 남은 단계를 끝낸다', () => {
  const merged = [{ number: 9, headRefName: 'feat/a', state: 'MERGED' }]
  const r = sync([{ id: 'a', status: 'doing', branch: 'feat/a', details: ['✓ 1. 구현', '2. 머지 #9'] }], ['--open-prs', '[]'])
  writeFileSync(join(tmp, 'state.json'), JSON.stringify({ list: merged }))
  const result = run(['--board', board, '--repo', tmp, '--open-prs', '[]'])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(load().a.status, 'done')
  assert.deepEqual(load().a.details, [step('1. 구현', true), step('2. 머지 #9', true)])
})

test('후속 단계가 여럿 남아 비운 PR 은 다음 틱에 다시 연결하지 않는다', () => {
  sync([{ id: 'a', status: 'doing', branch: 'feat/a', details: ['1. PR #9', '2. 검증'] }])
  writeFileSync(join(tmp, 'state.json'), JSON.stringify({ list: [{ number: 9, headRefName: 'feat/a', state: 'MERGED' }, { number: 8, headRefName: 'feat/a', state: 'MERGED' }] }))
  for (let n = 0; n < 3; n++) {
    const r = run(['--board', board, '--repo', tmp, '--open-prs', '[]'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(load().a.status, 'doing')
    assert.equal(load().a.pr, undefined)
    assert.deepEqual(load().a.details, [step('1. PR #9', true), step('2. 검증', false)])
  }
})


test('저장한 branch 가 없어도 실제 worktree 브랜치로 PR 을 연결한다', () => {
  const init = spawnSync('git', ['init', '-b', 'feat/a', tmp], { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  states['9'] = 'OPEN'
  const r = sync([{ id: 'a', status: 'doing', worktree: basename(tmp), details: ['1. 구현'] }], ['--open-prs', JSON.stringify([{ number: 9, headRefName: 'feat/a' }])])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board.a.pr, 9)
  assert.equal(r.board.a.branch, 'feat/a')
})

describe('board-sync 마지막 PR 판정', () => {
  // finish 절의 판정 규칙을 둔다. 지시서 폴더는 tmp/specs 다
  function rules(): void {
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    mkdirSync(join(tmp, 'specs'), { recursive: true })
    writeFileSync(
      join(tmp, '.orch', 'config.json'),
      JSON.stringify({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]', spec_task_pattern: '^업무: (PROJ-[0-9]+)', specs_dir: 'specs' } }),
    )
  }

  test('마지막 PR 이어도 수동 단계는 보존한다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 마무리', headRefName: 'feat/b' }
    states.open = [{ number: 8, title: '[PROJ-2] 다른 업무' }]
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. PR #7', '2. dev 확인', '3. 문서'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.a.details, [step('1. PR #7', true), step('2. dev 확인', false), step('3. 문서', false)])
    assert.match(r.result.stdout, /a 마지막 PR 판정: 마지막\(업무 PROJ-1, 남은 PR 없음, 남은 지시서 없음\)/)
  })

  test('같은 업무의 열린 PR 이나 지시서가 남으면 그 PR 단계만 끝내고 남은 일을 적는다', () => {
    rules()
    writeFileSync(join(tmp, 'specs', 'spec-c.md'), '# c\n업무: PROJ-1\n브랜치: `feat/c`\n')
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 앞부분', headRefName: 'feat/b' }
    states.open = [{ number: 9, title: '[PROJ-1] 뒷부분' }]
    const r = sync([{ id: 'a', status: 'doing', pr: '7', details: ['1. PR #7', '2. 마무리', '남은 일: 옛 줄'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, undefined)
    assert.equal(r.board.a['merged-pr'], 7)
    assert.deepEqual(r.board.a.details, [step('1. PR #7', true), step('2. 마무리', false), step('남은 일: PR #9, 지시서 spec-c.md', false)])
  })

  test('남은 단계가 하나여도 중간 PR 이면 done 으로 바꾸지 않는다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 앞부분', headRefName: 'feat/b' }
    states.open = [{ number: 9, title: '[PROJ-1] 뒷부분' }]
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.a.details, [step('1. 구현', false), step('남은 일: PR #9', false)])
  })

  test('그 PR 의 마무리가 돌고 있으면 항목을 고치지 않고 마무리에 맡긴다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 마무리', headRefName: 'feat/b' }
    mkdirSync(join(tmp, '.orch', 'queue'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'queue', 'finish-7.pid'), String(process.pid))
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, '#7')
    assert.match(r.result.stdout, /a 는 PR 7 의 마무리\(finish-pr\)가 돌고 있어 그쪽에 맡긴다/)
  })

  test('gh 조회가 실패해 판정하지 못하면 고치지 않고 다음 틱에 다시 판정한다', () => {
    rules()
    states['7'] = 'MERGED'
    // 제목과 브랜치 조회(info:7)가 없어 실패한다
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, '#7')
    assert.match(r.result.stdout, /다음 틱에 다시 판정\(PR 7 의 제목과 브랜치를 읽지 못했다\)/)
  })

  test('마지막 PR 로 done 이 되면 남은 일 줄을 지운다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 마무리', headRefName: 'feat/b' }
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '남은 일: PR #6', '2. 머지 #7'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true)])
  })

  test('판정하지 못해도 PR 번호 없는 한 단계는 남긴다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '업무 번호 없는 제목', headRefName: 'feat/b' }
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.match(r.result.stdout, /BOARD-UNMATCHED a PR #7/)
    assert.match(r.result.stdout, /PR 번호의 단계만 끝냄\(판정하지 못했다: PR 제목에서 업무 번호를 찾지 못했다/)
  })

  test('done 과 goal 이 아닌 항목이면 wait 이어도 같은 브랜치의 열린 PR 을 연결한다', () => {
    states['9'] = 'OPEN'
    const r = sync([{ id: 'a', status: 'wait', branch: 'feat/a' }], ['--open-prs', JSON.stringify([{ number: 9, headRefName: 'feat/a' }])])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.pr, 9)
  })
})

describe('board-sync 마일스톤 항목', () => {
  const four = [step('1. PR', false), step('2. 머지', false), step('3. 배포', false), step('4. 릴리스', false)]
  const config = (body: unknown) => {
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify(body))
  }
  // tmp 를 커밋 하나가 있는 git 저장소로 만들고 그 커밋을 낸다
  const gitRepo = (): string => {
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
      assert.equal(done.status, 0, done.stderr)
      return done.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'merge')
    return git('rev-parse', 'HEAD')
  }

  test('PR 이 열려 있으면 [pr] 단계만 끝낸다', () => {
    states['7'] = 'OPEN'
    const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', false)])
  })

  test('pr 칸이 비면 branch 로 머지된 PR 을 찾고, 판정 규칙이 없으면 마지막 PR 로 보고 기본 done 지점(merge)에서 done 으로 바꾼다', () => {
    states.list = [{ number: 7, headRefName: 'feat/a', state: 'MERGED' }]
    const r = sync([{ id: 'a', status: 'doing', branch: 'feat/a', stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)] }], [
      '--open-prs',
      '[]',
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true)])
    assert.equal(r.board.a.pr, 7)
    assert.equal(r.board.a['merged-pr'], 7)
  })

  test('done 지점이 release 면 머지 뒤에도 doing 으로 두고 pr 칸을 남기며 다시 판정하지 않는다', () => {
    config({ board: { done_after: 'release' }, finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } })
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 작업', headRefName: 'feat/a' }
    const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2,deploy=3,release=4', details: four }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, 7)
    assert.equal(r.board.a['merged-pr'], 7)
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true), step('3. 배포', false), step('4. 릴리스', false)])
    const again = run(['--board', board, '--repo', tmp])
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /바뀐 항목 없음/)
  })

  test('마지막 PR 을 판정하지 못해도 모든 단계와 작업이 끝났으면 done 으로 바꾼다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true)])
    assert.match(r.result.stdout, /마지막 PR 을 판정하지 못했지만 모든 단계가 끝났고 열린 PR, 작업 중 worker, 남은 일 줄이 없어 done 으로 바꾼다/)
  })

  test('마지막 PR 판정 규칙을 읽지 못하면 모든 단계가 끝나도 done 으로 바꾸지 않는다', () => {
    config({ finish: { task_pattern: '[' } })
    states['7'] = 'MERGED'
    const details = [step('1. PR', false), step('2. 머지', false)]
    const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2', details }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.a.details, details)
    assert.match(r.result.stderr, /마지막 PR 판정 규칙을 읽지 못해 PR 번호의 단계만 끝낸다/)
    assert.match(r.result.stdout, /마지막 PR 판정 규칙을 읽지 못해 done 으로 바꾸지 않는다/)
  })

  test('마지막 PR 을 판정하지 못했을 때 작업 중 worker, 열린 PR, 남은 단계가 있으면 그대로 둔다', () => {
    states['7'] = 'MERGED'
    states['8'] = 'OPEN'
    const cases = [
      { id: 'worker', pr: 7, stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)], workers: [worker('review', 'r', 'd1')] },
      { id: 'open', pr: '7, 8', stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)] },
      { id: 'step', pr: 7, stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false), step('3. 추가 확인', false)] },
    ].map((item) => ({ status: 'doing', ...item }))
    const r = sync(cases)
    assert.equal(r.code, 0, r.result.stderr)
    for (const id of ['worker', 'step']) {
      assert.equal(r.board[id].status, 'doing')
      assert.deepEqual(r.board[id].details, cases.find((item) => item.id === id)?.details)
    }
    assert.equal(r.board.open.status, 'doing')
    assert.deepEqual(r.board.open.details, [step('1. PR', true), step('2. 머지', true)])
    assert.equal(String(r.board.open.pr), '8')
    assert.equal(String(r.board.open['merged-pr']), '7')
  })

  test('배포 워크플로가 머지 커밋을 성공으로 배포했으면 [deploy] 단계까지 끝낸다', () => {
    const sha = gitRepo()
    config({ board: { done_after: 'release' }, finish: { deploy_workflow: 'deploy.yml', deploy_branch: 'main' } })
    states['7'] = 'MERGED'
    states['merge:7'] = sha
    states.runs = [{ headSha: sha, status: 'completed', conclusion: 'success' }]
    const r = sync([{ id: 'a', status: 'doing', pr: 7, 'merged-pr': 7, stages: 'pr=1,merge=2,deploy=3,release=4', details: four.map((d, i) => (i < 2 ? { ...d, done: true } : d)) }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true), step('3. 배포', true), step('4. 릴리스', false)])
  })

  test('배포가 끝나지 않았으면 [deploy] 단계를 그대로 둔다', () => {
    const sha = gitRepo()
    config({ board: { done_after: 'release' }, finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]', deploy_workflow: 'deploy.yml', deploy_branch: 'main' } })
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 작업', headRefName: 'feat/a' }
    states['merge:7'] = sha
    states.runs = [{ headSha: sha, status: 'in_progress', conclusion: null }]
    const r = sync([{ id: 'a', status: 'doing', pr: 7, stages: 'pr=1,merge=2,deploy=3,release=4', details: four }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true), step('3. 배포', false), step('4. 릴리스', false)])
  })

  test('중간 PR 은 pr 칸을 비우고 merged-pr 에 쌓고 남은 일 줄을 둔다', () => {
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } }))
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 앞 PR', headRefName: 'feat/a' }
    states.open = [{ number: 8, title: '[PROJ-1] 뒤 PR' }]
    const r = sync([{ id: 'a', status: 'doing', pr: 7, 'merged-pr': 5, stages: 'pr=1,merge=2', details: [step('1. PR', false), step('2. 머지', false)] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal('pr' in r.board.a, false)
    assert.equal(r.board.a['merged-pr'], '5, 7')
    assert.deepEqual(r.board.a.details, [step('1. PR', true), step('2. 머지', true), step('남은 일: PR #8', false)])
  })

  test('git 워크트리 목록에 없는 worktree 칸은 done 항목도 비운다', () => {
    gitRepo()
    const r = sync([
      { id: 'gone', status: 'done', worktree: 'removed-wt' },
      { id: 'here', status: 'wait', worktree: basename(tmp) },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal('worktree' in r.board.gone, false)
    assert.equal(r.board.here.worktree, basename(tmp))
  })
})

describe('단계를 모두 끝낸 doing 항목', () => {
  test('열린 PR, 워크트리, 남은 일 줄이 없고 단계가 모두 끝났으면 done 으로 바꾼다', () => {
    states['5'] = 'CLOSED'
    const r = sync([
      { id: 'a', status: 'doing', details: [step('1. 구현', true), '✓ 2. dev 화면 확인', '참고: 배경'] },
      { id: 'closed', status: 'doing', pr: '5', details: [step('1. 정리', true)] },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.equal(r.board.closed.status, 'done')
    assert.match(r.result.stdout, /board-sync: a 는 단계를 모두 끝냈고 열린 PR, 워크트리, 남은 일 줄이 없어 done 으로 바꾼다/)
  })

  test('남은 단계, 열린 PR, 남은 일 줄, 단계 없음이면 그대로 둔다', () => {
    states['8'] = 'OPEN'
    const items = [
      { id: 'left', status: 'doing', details: [step('1. 구현', true), step('2. 확인', false)] },
      { id: 'open', status: 'doing', pr: '8', details: [step('1. 구현', true)] },
      { id: 'noted', status: 'doing', details: [step('1. PR', true), step('남은 일: PR #9', false)] },
      { id: 'empty', status: 'doing', details: ['참고: 배경만 있다'] },
      { id: 'unknown', status: 'doing', pr: '99', details: [step('1. 구현', true)] },
    ]
    const before = JSON.stringify({ items })
    const r = sync(items)
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(readFileSync(board, 'utf8'), before)
  })

  test('worker 의 워크트리가 남아 있으면 그대로 둔다', () => {
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
      assert.equal(done.status, 0, done.stderr)
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const r = sync([
      { id: 'here', status: 'doing', worktree: basename(tmp), details: [step('1. 구현', true)] },
      { id: 'branch', status: 'doing', branch: 'main', details: [step('1. 구현', true)] },
      { id: 'gone', status: 'doing', worktree: 'removed-wt', details: [step('1. 구현', true)] },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.here.status, 'doing')
    assert.equal(r.board.branch.status, 'doing')
    assert.equal(r.board.gone.status, 'done')
  })
})

describe('손으로 쓴 사건 단계', () => {
  const details = () => ['1. PR (#7 pr)', '2. 머지 (#7 merge)', '3. 배포 (#7 deploy)', '4. 반영 (#7 release)', '5. 사람이 확인'].map((text) => step(text, false))
  test('항목의 PR 과 무관하게 꼬리표의 PR 을 읽고 goal 과 next 도 처리한다', () => {
    states['7'] = 'MERGED'
    states['8'] = 'OPEN'
    const r = sync([
      { id: 'a', status: 'doing', pr: 8, details: details() },
      { id: 'g', status: 'goal', next: details() },
      { id: 'other', status: 'doing', details: [step('1. 머지 (#8 merge)', false)] },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    for (const [id, key] of [['a', 'details'], ['g', 'next']]) {
      assert.deepEqual(r.board[id][key], details().map((d, i) => ({ ...d, done: i < 2 })))
    }
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.g.status, 'goal')
    assert.deepEqual(r.board.other.details, [step('1. 머지 (#8 merge)', false)])
  })
  test('조회 실패와 dry-run 은 완료 값을 바꾸지 않는다', () => {
    let r = sync([{ id: 'g', status: 'goal', details: details() }])
    assert.deepEqual(r.board.g.details, details())
    states['7'] = 'MERGED'
    r = sync([{ id: 'g', status: 'goal', details: details() }], ['--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.g.details, details())
    assert.match(r.result.stdout, /step g 2/)
  })
  test('머지 커밋이 포함된 배포 성공만 deploy 단계를 끝낸다', () => {
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'deploy')
    const sha = git('rev-parse', 'HEAD')
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify({ finish: { deploy_workflow: 'deploy.yml', deploy_branch: 'main' } }))
    states['7'] = 'MERGED'
    states['merge:7'] = sha
    for (const conclusion of ['failure', 'success']) {
      states.runs = [{ headSha: sha, status: 'completed', conclusion }]
      const r = sync([{ id: 'g', status: 'goal', details: details() }])
      assert.equal(r.code, 0, r.result.stderr)
      assert.deepEqual(r.board.g.details, details().map((d, i) => ({ ...d, done: i < (conclusion === 'success' ? 3 : 2) })))
    }
  })
})

test('마무리 PID 가 없어도 후속 검증이 남은 기능 항목은 done 으로 바꾸지 않는다', () => {
  states['7'] = 'MERGED'
  const head = 'a'.repeat(40)
  const evidence = { headRefOid: head, headRefName: 'feat/domain', body: `<!-- fos-feature-evidence -->
검증 커밋: ${head}
인수 검증: 통과 | REQ1 실제 실행 결과
문서 대조: 통과 | 설계 대조와 후보 없음 근거
독립 리뷰: 통과 | 독립 검토 결과
후속 검증: 대기 | 배포 후 smoke, 코디네이터, CI 실행기
<!-- /fos-feature-evidence -->` }
  states['evidence:7'] = evidence
  const items = [{ id: 'a', status: 'doing', pr: '#7', branch: 'feat/domain', details: ['1. PR #7 머지와 검증'] }]
  const pending = sync(items)
  assert.equal(pending.code, 0, pending.result.stderr)
  assert.equal(pending.board.a.status, 'doing')
  evidence.body = evidence.body.replace('후속 검증: 대기', '후속 검증: 통과')
  const complete = sync(items)
  assert.equal(complete.board.a.status, 'done')
})

test('MERGED 조회 뒤 근거 조회가 실패해도 기능 여부를 추측해 완료하지 않는다', () => {
  states['7'] = 'MERGED'
  states.evidenceFails = true
  const result = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. PR #7 머지와 검증'] }])
  assert.equal(result.code, 0, result.result.stderr)
  assert.equal(result.board.a.status, 'doing')
  assert.match(result.result.stdout, /근거 조회 실패/)
})

test('이미 끝난 사건 단계가 있는 둘째 PR 은 수동 단계가 남아도 못 맞춘 머지가 아니다', () => {
  states['8'] = 'MERGED'
  const r = sync([{ id: 'm', status: 'doing', pr: '8', 'merged-pr': '7', stages: 'pr=1,merge=2', details: [step('1. PR', true), step('2. 머지', true), '3. 수동 확인'] }])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board.m.status, 'doing')
  assert.doesNotMatch(r.result.stdout, /BOARD-UNMATCHED/)
})

test('앞 사건 근거의 PR 이 머지되어도 다음 자동 단계는 남긴다', () => {
  states['665'] = 'MERGED'
  const r = sync([{ id: 'a', status: 'doing', pr: '665', details: ['1. PR #665 구현', '2. [auto] PR4 (앞 사건: #665 merge)'] }])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(r.board.a.status, 'doing')
  assert.equal(r.board.a.details[0].done, true)
  assert.equal(r.board.a.details[1].done, false)
})

test('못 맞춘 머지는 기록하고 다른 PR 은 따로 남기며 꼬리표로 풀면 지운다', () => {
  states['7'] = 'MERGED'
  states['8'] = 'MERGED'
  const first = sync([{ id: 'a', status: 'doing', pr: '7', details: ['1. 확인 (앞 사건: #7 merge)'] }])
  assert.match(first.result.stdout, /BOARD-UNMATCHED a PR #7/)
  const file = join(tmp, '.orch/state/board-unmatched.json')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).items.a['7'].notified, null)
  const second = sync([{ ...first.board.a, pr: '8' }])
  assert.match(second.result.stdout, /BOARD-UNMATCHED a PR #8/)
  const fixed = sync([{ ...second.board.a, details: ['1. 머지 (#7 merge)', '2. 수동 확인'] }])
  assert.equal(fixed.code, 0, fixed.result.stderr)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).items.a), ['8'])
})

describe('갱신 필요 알림', () => {
  test('머지된 PR 번호가 든 끝나지 않은 단계를 항목 id, 단계 번호, PR 번호로 알리고 끝내지 않는다', () => {
    states['481'] = 'MERGED'
    states['9'] = 'MERGED'
    const r = sync([{ id: 'm', status: 'doing', pr: '9', 'merged-pr': '9', stages: 'pr=1,merge=2', details: [step('1. PR', true), step('2. 머지', true), '3. 릴리스 #481 반영 확인', '4. 배포 뒤 확인'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.match(r.result.stdout, /m 갱신 필요: 3 번 단계가 머지된 PR #481 를 가리키지만 끝나지 않았다/)
    assert.notEqual((r.board.m.details as Json[])[2].done, true)
    assert.doesNotMatch(r.result.stdout, /4 번 단계/)
  })

  test('짧은 출력은 update-needed 한 줄이고 바뀐 항목 수에 세지 않는다', () => {
    states['481'] = 'MERGED'
    writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
    writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', details: ['1. 릴리스 #481 반영'] }] }))
    const r = run(['--board', board, '--repo', tmp], { env: { ORCH_OUTPUT: 'short' } })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), ['BOARD a update-needed 1 PR #481', 'BOARD-SYNC 0'])
  })

  test('열린 PR 이나 사건 꼬리표, 자동 진행 표시, 이 틱이 끝내는 단계, done 항목은 알리지 않는다', () => {
    states['481'] = 'OPEN'
    states['7'] = 'MERGED'
    states['8'] = 'MERGED'
    const r = sync([
      { id: 'open', status: 'doing', details: ['1. 릴리스 #481 반영'] },
      { id: 'tag', status: 'doing', details: ['1. 릴리스 #8 반영 (#8 release)'] },
      { id: 'auto', status: 'doing', details: ['1. [auto] 릴리스 #8 반영'] },
      { id: 'legacy', status: 'doing', pr: '7', details: ['1. 구현 #7', '2. 남은 일'] },
      { id: 'closed', status: 'done', details: ['1. 릴리스 #8 반영'] },
      { id: 'evidence', status: 'doing', details: ['1. 다음 (앞 사건: #8 merge)'] },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.doesNotMatch(r.result.stdout, /갱신 필요/)
  })

  test('merged-pr 에 든 PR 은 조회하지 않고 머지된 것으로 본다', () => {
    const r = sync([{ id: 'a', status: 'doing', 'merged-pr': '31', details: ['1. 릴리스 #31 반영'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.match(r.result.stdout, /a 갱신 필요: 1 번 단계가 머지된 PR #31/)
  })
})

describe('갱신 필요 알림의 반복', () => {
  const shortRun = () => run(['--board', board, '--repo', tmp], { env: { ORCH_OUTPUT: 'short' } })
  const prepare = (details: string[]) => {
    writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
    writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', 'merged-pr': '481', details }] }))
  }

  test('같은 항목·단계·PR·글은 한 번만 알리고 dry-run 은 기록하지 않는다', () => {
    prepare(['1. 릴리스 #481 반영'])
    const dry = run(['--board', board, '--repo', tmp, '--dry-run'], { env: { ORCH_OUTPUT: 'short' } })
    assert.match(dry.stdout, /update-needed 1 PR #481/)
    assert.match(shortRun().stdout, /BOARD a update-needed 1 PR #481/)
    assert.deepEqual(shortRun().stdout.trim().split('\n'), ['BOARD-SYNC 0'])
    assert.deepEqual(shortRun().stdout.trim().split('\n'), ['BOARD-SYNC 0'])
  })

  test('단계 글이 바뀌거나 해결됐다가 다시 생기면 다시 알린다', () => {
    prepare(['1. 릴리스 #481 반영'])
    assert.match(shortRun().stdout, /update-needed 1 PR #481/)
    prepare(['1. 릴리스 #481 반영 다시'])
    assert.match(shortRun().stdout, /update-needed 1 PR #481/)
    prepare(['1. 릴리스 반영'])
    assert.doesNotMatch(shortRun().stdout, /update-needed/)
    prepare(['1. 릴리스 #481 반영 다시'])
    assert.match(shortRun().stdout, /update-needed 1 PR #481/)
  })
})
test('PR 제목의 번호는 PR 을 새로 연결할 때 빈 업무 칸에만 저장한다', () => {
  mkdirSync(join(tmp, '.orch'), { recursive: true })
  writeFileSync(join(tmp, '.orch/config.json'), JSON.stringify({ finish: { task_pattern: String.raw`\[([^\]]+)\]` } }))
  for (const supplied of [false, true]) {
    const prs = ['empty', 'kept', 'linked', 'url'].map((headRefName, i) => ({ number: i + 7, headRefName, title: '[AI-스마트홈-AI/458] 고침' }))
    states.list = prs
    const got = sync([{ id: 'empty', status: 'wait', branch: 'empty' }, { id: 'kept', status: 'wait', branch: 'kept', 'task-ref': 'P/1' }, { id: 'linked', status: 'wait', branch: 'linked', pr: 9 }, { id: 'url', status: 'wait', branch: 'url', task: 'https://x/1' }], supplied ? ['--open-prs', JSON.stringify(prs)] : [])
    assert.equal(got.code, 0, got.result.stderr)
    assert.equal(got.board.empty['task-ref'], 'AI-스마트홈-AI/458'); assert.equal(got.board.kept['task-ref'], 'P/1'); assert.equal(got.board.linked['task-ref'], undefined); assert.equal(got.board.url['task-ref'], undefined)
  }
})

test('하이픈으로 시작하는 PR 업무 번호를 옵션과 구분한다', () => {
  mkdirSync(join(tmp, '.orch'), { recursive: true })
  writeFileSync(join(tmp, '.orch/config.json'), JSON.stringify({ finish: { task_pattern: String.raw`\[([^\]]+)\]` } }))
  const got = sync([{ id: 'dash', status: 'wait', branch: 'feat/dash' }], ['--open-prs', JSON.stringify([{ number: 99, headRefName: 'feat/dash', title: '[-x] 고침' }])])
  assert.equal(got.code, 0, got.result.stderr)
  assert.equal(got.board.dash['task-ref'], '-x'); assert.equal(String(got.board.dash.pr), '99')
})

describe('board-sync 동시에 열린 PR', () => {
  const four = [step('1. PR', false), step('2. 머지', false), step('3. PR (wb)', false), step('4. 머지 (wb)', false)]
  const rows = (extra = {}) => [
    worker('impl', 'wa', 'd1', { pr: 7, status: 'done', endedAt: '2026-01-02' }),
    worker('follow', 'wb', 'd2', { branch: 'feat/b', pr: 9, stages: 'pr=3,merge=4', at: '2026-01-03', ...extra }),
  ]
  const item = (extra: Json = {}): Json => ({ id: 'a', status: 'doing', stages: 'pr=1,merge=2', pr: '7, 9', worktree: 'wb', branch: 'feat/b', details: four, workers: rows(), ...extra })
  const done = (...numbers: number[]) => four.map((d, i) => (numbers.includes(i + 1) ? { ...d, done: true } : d))
  const config = (body: unknown) => {
    mkdirSync(join(tmp, '.orch'), { recursive: true })
    writeFileSync(join(tmp, '.orch', 'config.json'), JSON.stringify(body))
  }

  test('열린 PR 마다 자기 묶음의 [pr] 단계를 끝내고 pr 칸에 두 번호를 둔다', () => {
    states = { '7': 'OPEN', '9': 'OPEN' }
    const r = sync([item()])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.pr, '7, 9')
    assert.deepEqual(r.board.a.details, done(1, 3))
  })

  test('뒤 PR 만 머지되면 뒤 묶음만 끝내고 판정 함수를 부르지 않으며 pr 칸에는 앞 PR 이 남는다', () => {
    // task_pattern 이 있고 info:9 가 없으면 판정 함수를 부를 때 조회 실패로 다시 판정하게 된다. 부르지 않으면 반영된다
    config({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } })
    states = { '7': 'OPEN', '9': 'MERGED' }
    const r = sync([item()])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, 7)
    assert.equal(r.board.a['merged-pr'], 9)
    assert.deepEqual(r.board.a.details, done(1, 3, 4))
  })

  test('앞 PR 이 머지되면 마지막 PR 이라 done 이 되고 뒤 묶음도 끝난 채 남는다', () => {
    config({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } })
    states = { '7': 'MERGED', 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' } }
    const r = sync([item({ pr: 7, 'merged-pr': 9, details: done(3, 4) })])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, done(1, 2, 3, 4))
    assert.equal(r.board.a['merged-pr'], '9, 7')
  })

  test('두 PR 이 같은 틱에 머지되면 번호가 작은 PR 만 반영하고 마지막 PR 로 보지 않는다', () => {
    config({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } })
    states = { '7': 'MERGED', '9': 'MERGED', 'info:9': { title: '[PROJ-1] 작업', headRefName: 'feat/b' }, 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' } }
    const r = sync([item()])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.equal(r.board.a.pr, 9)
    assert.equal(r.board.a['merged-pr'], 7)
    assert.deepEqual(r.board.a.details, done(1, 2))
    states = { '7': 'MERGED', '9': 'MERGED', 'info:9': { title: '[PROJ-1] 작업', headRefName: 'feat/b' } }
    const next = run(['--board', board, '--repo', tmp])
    assert.equal(next.code, 0, next.stderr)
    assert.equal(load().a.status, 'done')
    assert.deepEqual(load().a.details, done(1, 2, 3, 4))
  })

  test('남은 PR 의 상태를 읽지 못하면 항목을 고치지 않는다', () => {
    states = { '9': 'MERGED' }
    const r = sync([item()])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, four)
    assert.equal(r.board.a.pr, '7, 9')
    assert.equal('merged-pr' in r.board.a, false)
  })

  test('done_after 가 deploy 면 마지막으로 머지된 PR 의 배포 성공 뒤에 done 이다', () => {
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
      assert.equal(done.status, 0, done.stderr)
      return done.stdout.trim()
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'merge')
    const sha = git('rev-parse', 'HEAD')
    config({ board: { done_after: 'deploy' }, finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]', deploy_workflow: 'deploy.yml', deploy_branch: 'main' } })
    const five = [step('1. PR', false), step('2. 머지', false), step('3. 배포', false), step('4. PR (wb)', false), step('5. 머지 (wb)', false)]
    const base = (extra: Json = {}): Json => item({ stages: 'pr=1,merge=2,deploy=3', details: five, workers: rows({ stages: 'pr=4,merge=5' }), ...extra })
    // 뒤 PR 이 먼저 머지됐다. 앞 PR 이 열려 있으니 배포를 보지 않는다
    states = { '7': 'OPEN', '9': 'MERGED', 'merge:9': sha, 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' }, runs: [{ headSha: sha, status: 'completed', conclusion: 'success' }] }
    let r = sync([base()])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual((r.board.a.details as Json[]).map((d) => d.done), [true, false, false, true, true])
    // 앞 PR 이 마지막으로 머지됐다. 배포가 끝나지 않았으면 done 이 아니다
    states = { '7': 'MERGED', 'merge:7': sha, 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' }, runs: [{ headSha: sha, status: 'in_progress', conclusion: null }] }
    r = sync([{ ...(r.board.a as Json) }])
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual((r.board.a.details as Json[]).map((d) => d.done), [true, true, false, true, true])
    assert.equal(r.board.a['merged-pr'], '9, 7')
    // 배포가 성공하면 done 이다
    states = { '7': 'MERGED', 'merge:7': sha, 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' }, runs: [{ headSha: sha, status: 'completed', conclusion: 'success' }] }
    r = sync([{ ...(r.board.a as Json) }])
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual((r.board.a.details as Json[]).map((d) => d.done), [true, true, true, true, true])
  })

  test('done_after 기본(merge)이면 마지막 PR 머지 때 done 이고 배포 단계는 남는다', () => {
    const five = [step('1. PR', true), step('2. 머지', false), step('3. 배포', false), step('4. PR (wb)', true), step('5. 머지 (wb)', true)]
    config({ finish: { task_pattern: '^\\[(PROJ-[0-9]+)\\]' } })
    states = { '7': 'MERGED', 'info:7': { title: '[PROJ-1] 작업', headRefName: 'feat/a' } }
    const r = sync([item({ stages: 'pr=1,merge=2,deploy=3', pr: 7, 'merged-pr': 9, details: five, workers: rows({ stages: 'pr=4,merge=5' }) })])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual((r.board.a.details as Json[]).map((d) => d.done), [true, true, false, true, true])
  })

  test('후속 줄은 자기 브랜치의 열린 PR 을 pr 칸과 줄에 잇고 앞 줄의 브랜치도 잇는다', () => {
    const open = JSON.stringify([{ number: 7, headRefName: 'feat/a', title: 'a' }, { number: 9, headRefName: 'feat/b', title: 'b' }])
    const r = sync([item({ pr: undefined, workers: [worker('impl', 'wa', 'd1', { status: 'done', endedAt: '2026-01-02' }), worker('follow', 'wb', 'd2', { branch: 'feat/b', stages: 'pr=3,merge=4', at: '2026-01-03' })] })], ['--open-prs', open])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.pr, '9, 7')
    const linked = r.board.a.workers as Json[]
    assert.equal(linked[0].pr, 7)
    assert.equal(linked[1].pr, 9)
    assert.equal(r.board.a.branch, 'feat/b')
    assert.deepEqual(r.board.a.details, done(1, 3))
  })

  test('대표가 후속 줄로 바뀐 항목은 앞 구현 줄의 브랜치에 열린 PR 을 더한다', () => {
    const open = JSON.stringify([{ number: 7, headRefName: 'feat/a', title: 'a' }, { number: 9, headRefName: 'feat/b', title: 'b' }])
    states = { '9': 'OPEN' }
    const r = sync([item({ pr: 9, workers: [worker('impl', 'wa', 'd1', { status: 'done', endedAt: '2026-01-02' }), worker('follow', 'wb', 'd2', { branch: 'feat/b', pr: 9, stages: 'pr=3,merge=4', at: '2026-01-03' })] })], ['--open-prs', open])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.pr, '9, 7')
    assert.equal((r.board.a.workers as Json[])[0].pr, 7)
    assert.equal(r.board.a.branch, 'feat/b')
    assert.deepEqual(r.board.a.details, done(1, 3))
  })

  test('후속 묶음 단계에 머지된 PR 번호가 적혀 있어도 갱신 필요 알림이 나오지 않는다', () => {
    states = { '7': 'OPEN', '9': 'MERGED' }
    const noted = [step('1. PR', false), step('2. 머지', false), step('3. PR (wb) #9', false), step('4. 머지 (wb) #9', false)]
    const r = sync([item({ pr: 7, 'merged-pr': 9, details: noted })])
    assert.equal(r.code, 0, r.result.stderr)
    assert.doesNotMatch(r.result.stdout, /갱신 필요/)
  })
})
