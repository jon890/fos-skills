// bin/board.ts 를 임시 보드 파일로 실행해 단계 줄 처리와 set 규칙, 기본 보드 위치를 확인한다.
//
// 실행: node --test work-board/tests/board.spec.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { defaultBoardPath } from '../bin/board.ts'

const BOARD = fileURLToPath(new URL('../bin/board.ts', import.meta.url))
const SHIM = fileURLToPath(new URL('../bin/board.py', import.meta.url))
// shim 이 PATH 의 node 를 부르므로 이 테스트를 돌리는 node(24 이상)를 앞에 둔다
const SHIM_ENV = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }

type Json = Record<string, unknown>
type Result = { code: number | null; stdout: string; stderr: string }

let tmp: string
let file: string

const rows = (...values: [string, boolean][]) => values.map(([text, done]) => ({ text, done }))

function write(...items: Json[]): void {
  writeFileSync(file, JSON.stringify({ items }), 'utf8')
}

function board(...args: string[]): Result {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BOARD, ...args, '--file', file], { encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function items(): Json[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { items: Json[] }).items
}

function item(id: string): Json {
  const found = items().find((row) => row.id === id)
  assert.ok(found, `항목이 없다: ${id}`)
  return found
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'board-')))
  file = join(tmp, 'board.json')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('step 과 steps', () => {
  test('번호 붙은 next 줄을 찾아 끝내고 --undo 로 되돌린다', () => {
    write({ id: 'up', status: 'doing', next: '1. 구현\n2. 리뷰 반영\n3. 머지' })
    const r = board('step', 'up', '1')
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(item('up').next, rows(['1. 구현', true], ['2. 리뷰 반영', false], ['3. 머지', false]))
    board('step', 'up', '1', '--undo')
    assert.deepEqual(item('up').next, rows(['1. 구현', false], ['2. 리뷰 반영', false], ['3. 머지', false]))
  })

  test('details 에 단계가 있으면 next 보다 앞선다', () => {
    write({ id: 'g', status: 'doing', next: '1. 할 일 목록', details: ['1 a', '2 b'] })
    board('step', 'g', '1')
    assert.deepEqual(item('g').details, rows(['1 a', true], ['2 b', false]))
    assert.deepEqual(item('g').next, rows(['1. 할 일 목록', false]))
  })

  test('체크 상자 줄의 done 값을 바꾼다', () => {
    write({ id: 'c', status: 'doing', details: ['[ ] 1. a', '[ ] 2) b'] })
    board('step', 'c', '2')
    assert.deepEqual(item('c').details, rows(['1. a', false], ['2) b', true]))
    board('step', 'c', '2', '--undo')
    assert.deepEqual(item('c').details, rows(['1. a', false], ['2) b', false]))
  })

  test('진행 중 표시를 떼고 done 값으로 바꾼다', () => {
    write({ id: 'm', status: 'doing', details: ['▶ 1 a', '◇ 2 b'] })
    board('step', 'm', '1')
    assert.deepEqual(item('m').details, rows(['1 a', true], ['2 b', false]))
  })

  test('없는 번호는 단계 줄 쓰는 법을 알린다', () => {
    write({ id: 'x', status: 'doing', next: '1. a' })
    const r = board('step', 'x', '4')
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('4 번 단계 줄이 없다'), r.stderr)
    assert.ok(r.stderr.includes('「4. …」'), r.stderr)
  })

  test('steps 는 세는 줄만 JSON 으로 내고 파일을 고치지 않는다', () => {
    write({ id: 's', status: 'doing', details: ['참고: x', '✓ 1 a', '[ ] 2. b #7'] })
    const before = readFileSync(file, 'utf8')
    const r = board('steps', 's')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, '[{"number": 1, "done": true, "text": "1 a"}, {"number": 2, "done": false, "text": "2. b #7"}]\n')
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(board('steps', 'none').code, 1)
  })
})

describe('set', () => {
  test('진행률 없는 doing 은 거절하고 보드를 고치지 않는다', () => {
    write({ id: 'old', status: 'wait', title: '옛 항목' })
    let r = board('set', 'old', 'doing')
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('진행률이 필요하다'), r.stderr)
    assert.ok(r.stderr.includes("--next '1. 구현'"), r.stderr)
    assert.ok(r.stderr.includes('--progress'), r.stderr)
    assert.equal(item('old').status, 'wait')
    r = board('set', 'new', 'doing', '--title', '새 항목')
    assert.equal(r.code, 1, r.stderr)
    assert.deepEqual(
      items().map((row) => row.id),
      ['old'],
    )
  })

  test('단계 줄이나 --progress 가 있으면 doing 을 받는다', () => {
    write()
    const r = board('set', 'a', 'doing', '--next', '1. 구현', '--next', '2. 머지')
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(item('a').next, rows(['1. 구현', false], ['2. 머지', false]))
    assert.equal(board('set', 'b', 'doing', '--progress', '2/5').code, 0)
    assert.equal(board('set', 'c', 'doing', '--detail', '✓ 1 a', '--detail', '2 b').code, 0)
  })

  test('표시를 done 값으로 바꾸고 빈 값은 칸을 지운다', () => {
    let r = board('set', 'a', 'doing', '--next', '[X] 1. 구현\n[ ] 2. 머지', '--detail', '✓ 참고', '--detail', '▶ 3 검증', '--detail', '◇ 4 배포')
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(item('a').next, rows(['1. 구현', true], ['2. 머지', false]))
    assert.deepEqual(item('a').details, rows(['참고', true], ['3 검증', false], ['4 배포', false]))
    r = board('set', 'a', 'wait', '--next', '', '--detail', '')
    assert.equal(r.code, 0, r.stderr)
    assert.equal('next' in item('a'), false)
    assert.equal('details' in item('a'), false)
  })

  test('섞인 형식은 쓸 때 옮기고 객체의 done 값은 지킨다', () => {
    write(
      { id: 'a', status: 'doing', details: ['[x] 1 a', { text: '2 b', done: false }, { text: '3 c', done: true }, '참고'] },
      { id: 'b', status: 'wait', next: '✓ 1 d' },
    )
    let before = readFileSync(file)
    assert.ok(board('list').stdout.split('\n')[0].endsWith('2/3 (67%)'))
    assert.deepEqual(readFileSync(file), before)
    const r = board('step', 'a', '2')
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(item('a').details, rows(['1 a', true], ['2 b', true], ['3 c', true], ['참고', false]))
    assert.deepEqual(item('b').next, rows(['1 d', true]))
    before = readFileSync(file)
    assert.equal(board('step', 'a', '9').code, 1)
    assert.deepEqual(readFileSync(file), before)
  })

  test('--progress 는 분수여야 한다', () => {
    write()
    const r = board('set', 'a', 'doing', '--progress', '거의 완료')
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('끝낸단계/전체단계'), r.stderr)
  })

  test('옛 doing 항목은 set 할 때까지 그대로 둔다', () => {
    write({ id: 'old', status: 'doing', progress: '거의 완료' }, { id: 'w', status: 'wait' })
    assert.equal(board('set', 'w', '--title', '대기').code, 0)
    assert.equal(item('old').status, 'doing')
    assert.equal(board('set', 'old', '--pr', '#1').code, 1)
    assert.equal(board('set', 'old', 'done').code, 0)
  })

  test('쓴 파일은 옛 board.py 의 json.dump(indent=1) 꼴이다', () => {
    write({ id: 'old', status: 'wait', title: '옛 항목', note: { tags: [], n: 2 } })
    const r = board('set', 'a', 'doing', '--next', '1. 구현', '--pr', '#1')
    assert.equal(r.code, 0, r.stderr)
    const text = readFileSync(file, 'utf8')
    const at = /"updatedAt": "([^"]+)"/.exec(text)
    assert.ok(at, text)
    assert.match(at[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    // 한 칸 들여쓰기, 빈 목록은 [], 한글은 그대로, 끝 줄바꿈 없음
    const expected = [
      '{',
      ' "items": [',
      '  {',
      '   "id": "old",',
      '   "status": "wait",',
      '   "title": "옛 항목",',
      '   "note": {',
      '    "tags": [],',
      '    "n": 2',
      '   }',
      '  },',
      '  {',
      '   "id": "a",',
      '   "title": "a",',
      '   "status": "doing",',
      '   "pr": "#1",',
      '   "next": [',
      '    {',
      '     "text": "1. 구현",',
      '     "done": false',
      '    }',
      '   ]',
      '  }',
      ' ],',
      ' "updatedAt": "<at>"',
      '}',
    ].join('\n')
    assert.equal(text.replace(at[1], '<at>'), expected)
  })

  test('id 는 타입까지 같을 때만 맞는다', () => {
    write({ id: 1, status: 'wait', title: '숫자 id' })
    const r = board('steps', '1')
    assert.equal(r.code, 1, r.stderr)
    assert.ok(r.stderr.includes('항목이 없다: 1'), r.stderr)
    assert.equal(board('del', '1').code, 0)
    assert.deepEqual(
      items().map((row) => row.id),
      [1],
    )
  })

  test('옵션은 고유 접두로 줄여 쓸 수 있다', () => {
    write()
    const r = board('set', 'a', 'wait', '--tit', '줄임')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(item('a').title, '줄임')
  })
})

describe('사용법', () => {
  for (const flag of ['--help', '-h', '--he']) {
    test(`${flag} 는 사용법을 stdout 에 내고 0 이다`, () => {
      const r = board('set', flag)
      assert.equal(r.code, 0, r.stderr)
      assert.ok(r.stdout.startsWith('사용법: board.ts {set,step,steps,del,list}'), r.stdout)
      assert.ok(r.stdout.includes('board.ts steps <id>'), r.stdout)
      assert.equal(existsSync(file), false, '도움말인데 보드를 만들었다')
    })
  }

  test('모르는 명령과 옵션은 사용법 오류 2 이고 보드를 만들지 않는다', () => {
    for (const args of [['show'], ['list', '--bogus'], ['set', 'a', 'wait', '--p', 'x']]) {
      const r = board(...args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`)
      assert.ok(r.stderr.startsWith('사용법: board.ts'), r.stderr)
    }
    assert.equal(existsSync(file), false)
  })
})

describe('list', () => {
  test('항목마다 진행률을 붙인다', () => {
    write({ id: 'a', status: 'doing', next: '✓ 1. a\n[x] 2. b\n3. c' }, { id: 'b', status: 'doing', progress: '1/4' }, { id: 'c', status: 'wait' })
    const lines = board('list').stdout.split('\n')
    assert.ok(lines[0].endsWith('2/3 (67%)'), lines[0])
    assert.ok(lines[1].endsWith('1/4 (25%)'), lines[1])
    assert.ok(lines[2].endsWith('진행률 없음'), lines[2])
  })

  test('딱 반인 백분율은 옛 명령처럼 짝수 쪽으로 반올림한다', () => {
    write({ id: 'a', status: 'doing', progress: '1/8' })
    assert.ok(board('list').stdout.split('\n')[0].endsWith('1/8 (12%)'))
  })
})

describe('기본 보드 위치', () => {
  function git(cwd: string, ...args: string[]): void {
    const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
  }

  test('git 작업 트리의 .omc/board.json 이고 옛 .omc/handoffs/board.json 이 있으면 그것이다', () => {
    const repo = join(tmp, 'repo')
    mkdirSync(join(repo, 'sub'), { recursive: true })
    git(repo, 'init', '-q')
    assert.equal(defaultBoardPath(join(repo, 'sub')), join(repo, '.omc/board.json'))
    mkdirSync(join(repo, '.omc/handoffs'), { recursive: true })
    writeFileSync(join(repo, '.omc/handoffs/board.json'), '{}')
    assert.equal(defaultBoardPath(repo), join(repo, '.omc/handoffs/board.json'))
  })

  test('git 밖의 폴더면 그 폴더의 .omc/board.json 이다', () => {
    const plain = join(tmp, 'plain')
    mkdirSync(plain)
    // tmp 위로 git 저장소를 찾아 올라가지 않게 막는다
    const prev = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmp
    try {
      assert.equal(defaultBoardPath(plain), join(plain, '.omc/board.json'))
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = prev
    }
  })

  test('import 해도 명령이 돌지 않는다', () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    const done = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `import { defaultBoardPath } from ${JSON.stringify(BOARD)}; defaultBoardPath(process.cwd())`],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout, '')
    assert.equal(existsSync(join(repo, '.omc')), false)
  })

  test('--file 이 없으면 기본 위치에 쓴다', () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q')
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', BOARD, 'set', 'a', 'wait'], { cwd: repo, encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    const saved = JSON.parse(readFileSync(join(repo, '.omc/board.json'), 'utf8')) as { items: Json[]; updatedAt: string }
    assert.deepEqual(saved.items, [{ id: 'a', title: 'a', status: 'wait' }])
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
})

describe('옛 경로', () => {
  test('board.py 는 board.ts 로 넘긴다', () => {
    write({ id: 'a', status: 'wait' })
    const done = spawnSync('python3', [SHIM, 'list', '--file', file], { encoding: 'utf8', env: SHIM_ENV })
    assert.equal(done.status, 0, done.stderr)
    assert.ok(done.stdout.startsWith('wait    a'), done.stdout)
    assert.match(done.stderr, /^DEPRECATED python3 board\.py → /m)
  })

  test('board.py 를 다른 폴더의 symlink 로 불러도 board.ts 로 넘긴다', () => {
    write({ id: 'a', status: 'wait' })
    const link = join(tmp, 'link', 'board.py')
    mkdirSync(dirname(link))
    symlinkSync(SHIM, link)
    const done = spawnSync('python3', [link, 'list', '--file', file], { encoding: 'utf8', env: SHIM_ENV })
    assert.equal(done.status, 0, done.stderr)
    assert.ok(done.stdout.startsWith('wait    a'), done.stdout)
  })
})
