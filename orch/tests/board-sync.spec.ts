// board-sync.ts 를 임시 보드, 가짜 gh, 저장소의 실제 work-board/bin/board.ts 로 돌려 본다. GitHub 에는 닿지 않는다.
//
// 가짜 gh 는 --repo 로 준 폴더의 state.json 에서 PR 번호의 상태를 읽는다. 없는 번호는 조회 실패다.
// BOARD_BIN 을 주지 않으므로 기본 보드 명령(work-board/bin/board.ts)이 항목을 고친다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/board-sync.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../scripts/board-sync.py', import.meta.url))

// 마지막 PR 판정의 조회: \`pr view N --json title,headRefName\` 은 state['info:N'], 열린 PR 목록(\`--json number,title\`)은 state.open,
// \`--head B\` 목록은 state.list 에서 그 브랜치의 행만 낸다
const FAKE_GH = `const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'))
const args = process.argv.slice(2)
const say = (value) => fs.writeSync(1, (typeof value === 'string' ? value : JSON.stringify(value)) + '\\n')
const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : null
if (args[1] === 'view' && args.includes('title,headRefName')) {
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

function run(args: string[], opts: { script?: string; env?: Record<string, string> } = {}): Result {
  // shim 은 PATH 의 node 를 부른다. 이 테스트를 도는 node 를 앞에 둔다
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), GH: join(bindir, 'gh'), ...opts.env }
  if (!opts.env?.BOARD_BIN) delete env.BOARD_BIN
  const argv = opts.script ? ['python3', opts.script] : [process.execPath, '--disable-warning=ExperimentalWarning', SCRIPT]
  const done = spawnSync(argv[0], [...argv.slice(1), ...args], { env, cwd: tmp, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

// 보드를 쓰고 동기화한 뒤 종료 코드와 id 별 항목을 낸다
function sync(items: Json[], extra: string[] = [], opts: { boardBin?: string } = {}): { code: number | null; board: Record<string, Json>; result: Result } {
  writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
  writeFileSync(board, JSON.stringify({ items }))
  const result = run(['--board', board, '--repo', tmp, ...extra, ...(opts.boardBin ? ['--board-bin', opts.boardBin] : [])])
  return { code: result.code, board: load(), result }
}

function load(): Record<string, Json> {
  const items = (JSON.parse(readFileSync(board, 'utf8')) as { items: Json[] }).items
  return Object.fromEntries(items.map((item) => [String(item.id), item]))
}

const step = (text: string, done: boolean): Json => ({ text, done })

describe('board-sync', () => {
  test('BOARD_BIN 이 없으면 저장소의 work-board/bin/board.ts 가 보드 항목을 done 으로 바꾼다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
  })

  test('머지된 PR 은 남은 단계를 끝내고 항목을 done 으로 바꾼다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. PR 리뷰 반영', '✓ 3. 머지'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.equal(r.board.a.pr, '#7')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. PR 리뷰 반영', true), step('3. 머지', true)])
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
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. 머지'] }])
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지', true)])
  })

  test('체크박스 단계는 보드 명령이 done 값으로 끝내고 본문에 표시를 저장하지 않는다', () => {
    states['7'] = 'MERGED'
    const r = sync([
      { id: 'a', status: 'doing', pr: '#7', details: ['[x] 1. 구현', '[ ] 2. 머지 #7', '[ ] 3. 배포'] },
      { id: 'b', status: 'doing', pr: '#7', next: '[x] 1. 구현\n[ ] 2. 머지' },
    ])
    assert.equal(r.code, 0, r.result.stderr)
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지 #7', true), step('3. 배포', false)])
    assert.equal(r.board.a.status, 'doing')
    assert.deepEqual(r.board.b.next, [step('1. 구현', true), step('2. 머지', true)])
    assert.equal(r.board.b.status, 'done')
  })

  test('참고 줄은 끝나지 않은 단계로 세지 않는다', () => {
    states['7'] = 'MERGED'
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '2. 머지', '참고: 후속 검토'] }])
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지', true), step('참고: 후속 검토', false)])
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
    const items = [{ id: 'a', status: 'doing', pr: '7', details: ['1. 구현'] }]
    const before = JSON.stringify({ items })
    const r = sync(items, ['--dry-run'])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(readFileSync(board, 'utf8'), before)
    assert.equal(r.result.stdout, 'a -> done\n  step a 1\n  set a done\nboard-sync: a\n')
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
    const r = sync([{ id: 'goal', status: 'goal' }, { id: 'a', status: 'doing', pr: '7', next: '1. 구현' }], ['--goal', 'goal', '--goal-items', join(tmp, 'items.txt')])
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

  test('옛 .py 경로는 같은 결과를 내는 shim 이다', () => {
    states['7'] = 'MERGED'
    writeFileSync(join(tmp, 'state.json'), JSON.stringify(states))
    writeFileSync(board, JSON.stringify({ items: [{ id: 'a', status: 'doing', pr: '7', details: ['1. 구현'] }] }))
    const r = run(['--board', board, '--repo', tmp], { script: SHIM })
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stderr, /DEPRECATED/)
    assert.equal(load().a.status, 'done')
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
  const r = sync([{ id: 'a', status: 'doing', branch: 'feat/a', details: ['✓ 1. 구현', '2. 머지'] }], ['--open-prs', '[]'])
  writeFileSync(join(tmp, 'state.json'), JSON.stringify({ list: merged }))
  const result = run(['--board', board, '--repo', tmp, '--open-prs', '[]'])
  assert.equal(r.code, 0, r.result.stderr)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(load().a.status, 'done')
  assert.deepEqual(load().a.details, [step('1. 구현', true), step('2. 머지', true)])
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

  test('마지막 PR 이면 남은 단계가 여럿이어도 끝내고 done 으로 바꾼다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '[PROJ-1] 마무리', headRefName: 'feat/b' }
    states.open = [{ number: 8, title: '[PROJ-2] 다른 업무' }]
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. PR #7', '2. dev 확인', '3. 문서'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. PR #7', true), step('2. dev 확인', true), step('3. 문서', true)])
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
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['✓ 1. 구현', '남은 일: PR #6', '2. 머지'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.deepEqual(r.board.a.details, [step('1. 구현', true), step('2. 머지', true)])
  })

  test('판정하지 못하면 단계 수로 정한다', () => {
    rules()
    states['7'] = 'MERGED'
    states['info:7'] = { title: '업무 번호 없는 제목', headRefName: 'feat/b' }
    const r = sync([{ id: 'a', status: 'doing', pr: '#7', details: ['1. 구현'] }])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.status, 'done')
    assert.match(r.result.stdout, /단계 수로 정함\(판정하지 못했다: PR 제목에서 업무 번호를 찾지 못했다/)
  })

  test('done 과 goal 이 아닌 항목이면 wait 이어도 같은 브랜치의 열린 PR 을 연결한다', () => {
    states['9'] = 'OPEN'
    const r = sync([{ id: 'a', status: 'wait', branch: 'feat/a' }], ['--open-prs', JSON.stringify([{ number: 9, headRefName: 'feat/a' }])])
    assert.equal(r.code, 0, r.result.stderr)
    assert.equal(r.board.a.pr, 9)
  })
})
