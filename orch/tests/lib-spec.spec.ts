import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { BRANCH_LINE, branchesOf, deleteSpecs, liveSpecPaths, permissionsOf, selectionsOf, specCandidates } from '../scripts/lib/spec.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import type { FakeBin, FakeRule } from './fixtures/fake-bin.ts'

const saved = { ORCA: process.env.ORCA }
let base: string
let fake: FakeBin

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lib-spec-')))
  fake = fakeBin(base, 'orca', [])
  process.env.ORCA = fake.path
})

after(() => {
  if (saved.ORCA === undefined) delete process.env.ORCA
  else process.env.ORCA = saved.ORCA
  rmSync(base, { recursive: true, force: true })
})

function envelope(result: unknown): string {
  return JSON.stringify({ ok: true, result })
}

describe('BRANCH_LINE 과 branchesOf', () => {
  test('목록 기호와 굵은 글씨를 섞은 모든 꼴을 받는다', () => {
    const text = [
      '# 일',
      '브랜치: `feat/plain`',
      '- 브랜치: `feat/dash`',
      '* 브랜치: `feat/star`',
      '**브랜치:** `feat/bold-in`',
      '**브랜치**: `feat/bold-out`',
      '- **브랜치:** `feat/dash-bold-in`',
      '* **브랜치**: `feat/star-bold-out`',
      '   브랜치:   `feat/indent`',
      '설명에 든 브랜치: `feat/not-head`',
      '브랜치: feat/no-tick',
    ].join('\n')
    assert.deepEqual(branchesOf(text), [
      'feat/plain',
      'feat/dash',
      'feat/star',
      'feat/bold-in',
      'feat/bold-out',
      'feat/dash-bold-in',
      'feat/star-bold-out',
      'feat/indent',
    ])
  })

  test('같은 줄을 두 번 검사해도 같은 결과다', () => {
    const line = '- **브랜치:** `feat/a`'
    assert.equal(BRANCH_LINE.exec(line)?.[1], 'feat/a')
    assert.equal(BRANCH_LINE.exec(line)?.[1], 'feat/a')
    assert.equal(BRANCH_LINE.test(line), true)
    assert.equal(BRANCH_LINE.test(line), true)
  })

  test('겹친 브랜치 줄도 나온 수만큼 낸다', () => {
    assert.deepEqual(branchesOf('브랜치: `a`\r\n브랜치: `a`\n'), ['a', 'a'])
    assert.deepEqual(branchesOf(''), [])
  })

  test('줄은 옛 명령의 splitlines 처럼 \\u2028 같은 경계에서도 나눈다', () => {
    assert.deepEqual(branchesOf('설명\u2028브랜치: `a`\u000c브랜치: `b`'), ['a', 'b'])
  })
})

describe('permissionsOf', () => {
  test('허락 줄 여러 개를 마침표로 끝낸 문구로 낸다', () => {
    const text = ['허락: push 를 허락했다.', '- **허락:** PR 을 연다', '* 허락 :  draft 로 둔다  ', '허락받지 않은 줄'].join('\n')
    assert.deepEqual(permissionsOf(text), ['push 를 허락했다.', 'PR 을 연다.', 'draft 로 둔다.'])
  })
})

describe('selectionsOf', () => {
  test('백틱 값의 첫째를 에이전트, 둘째를 모델로 읽고 effort 뒤의 값은 effort 로 뺀다', () => {
    const text = '# 일\n- **worker 선택:** effort `high` 로 `claude` `claude-opus-5-5` 를 고른다. 비교: `gpt-6.1-sol`. 이유: 계약 설계다.\n'
    assert.deepEqual(selectionsOf(text), [{ no: 2, agent: 'claude', model: 'claude-opus-5-5', effort: 'high', problems: [] }])
  })

  test('빠진 요소를 problems 에 적고 선택 줄이 아닌 줄은 건너뛴다', () => {
    const text = 'worker 선택 이유는 아래에 적는다\nworker 선택: `codex`\n'
    assert.deepEqual(selectionsOf(text), [{ no: 2, agent: 'codex', model: null, effort: null, problems: ['모델', 'effort', '비교', '이유'] }])
  })
})

describe('specCandidates', () => {
  test('지시서 두 꼴과 이름, 브랜치, PR 번호의 PR 본문 후보를 낸다', () => {
    const got = specCandidates({ specsDir: '/r/.orch/specs', name: 'feat-a', branch: 'feat/a/b', prNumber: 42 })
    assert.deepEqual(got.specs, ['/r/.orch/specs/feat-a.md', '/r/.orch/specs/spec-feat-a.md'])
    assert.deepEqual(got.prBodies, ['/r/.orch/pr-feat-a.md', '/r/.orch/pr-feat-a-b.md', '/r/.orch/pr-a/b.md', '/r/.orch/pr-42.md'])
  })

  test('겹치는 후보는 한 번만 내고 / 없는 브랜치는 그대로 쓴다', () => {
    const got = specCandidates({ specsDir: '/r/.orch/specs', name: 'fix', branch: 'fix' })
    assert.deepEqual(got.prBodies, ['/r/.orch/pr-fix.md'])
  })
})

describe('deleteSpecs', () => {
  let root: string
  let specsDir: string
  let lines: string[]
  const log = (line: string) => lines.push(line)

  function touch(target: string, body = 'x') {
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }

  beforeEach(() => {
    root = join(mkdtempSync(join(base, 'repo-')), '.orch')
    specsDir = join(root, 'specs')
    mkdirSync(specsDir, { recursive: true })
    lines = []
  })

  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true })
  })

  test('이름으로 고른 지시서와 PR 본문 가운데 살아 있는 지시서만 남기고 지운다', () => {
    const { specs, prBodies } = specCandidates({ specsDir, name: 'a', branch: 'feat/a', prNumber: 7 })
    touch(join(specsDir, 'spec-a.md'))
    touch(join(specsDir, 'a.md'))
    touch(join(root, 'pr-a.md'))
    touch(join(root, 'pr-7.md'))
    const live = new Set([realpathSync(join(specsDir, 'a.md'))])
    const got = deleteSpecs({ root, specs, prBodies, live, mode: 'delete', apply: true, log })
    assert.deepEqual(got.removed, [join(specsDir, 'spec-a.md'), join(root, 'pr-a.md'), join(root, 'pr-7.md')])
    assert.deepEqual(got.kept, [{ path: join(specsDir, 'a.md'), reason: '살아 있는 dispatch 가 쓴다' }])
    assert.equal(existsSync(join(specsDir, 'spec-a.md')), false)
    assert.equal(existsSync(join(root, 'pr-7.md')), false)
    assert.equal(existsSync(join(specsDir, 'a.md')), true)
  })

  test('live 가 null 이면 지시서와 PR 본문 모두 지우지 않는다', () => {
    touch(join(specsDir, 'spec-a.md'))
    touch(join(root, 'pr-a.md'))
    const got = deleteSpecs({
      root,
      specs: [join(specsDir, 'spec-a.md')],
      prBodies: [join(root, 'pr-a.md')],
      live: null,
      mode: 'delete',
      apply: true,
      log,
    })
    assert.deepEqual(got.removed, [])
    assert.deepEqual(
      got.kept.map((k) => k.reason),
      ['살아 있는 지시서 목록을 읽지 못했다', '살아 있는 지시서 목록을 읽지 못했다'],
    )
    assert.equal(existsSync(join(specsDir, 'spec-a.md')), true)
    assert.equal(existsSync(join(root, 'pr-a.md')), true)
  })

  test('없는 파일은 건너뛰고 root 밖의 파일은 남긴다', () => {
    const outside = join(base, 'outside-spec.md')
    touch(outside)
    try {
      const got = deleteSpecs({
        root,
        specs: [join(specsDir, 'missing.md'), outside],
        prBodies: [],
        live: new Set(),
        mode: 'delete',
        apply: true,
        log,
      })
      assert.deepEqual(got.removed, [])
      assert.deepEqual(got.kept, [{ path: outside, reason: 'orch 루트 밖이다' }])
      assert.equal(existsSync(outside), true)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('apply 가 false 면 파일을 두고 할 일만 알린다', () => {
    touch(join(specsDir, 'spec-a.md'))
    const got = deleteSpecs({ root, specs: [join(specsDir, 'spec-a.md')], prBodies: [], live: new Set(), mode: 'delete', apply: false, log })
    assert.deepEqual(got.removed, [join(specsDir, 'spec-a.md')])
    assert.equal(existsSync(join(specsDir, 'spec-a.md')), true)
    assert.deepEqual(lines, [`지시서를 지울 것 ${join(specsDir, 'spec-a.md')}`])
  })

  test('휴지통 모드는 <휴지통>/<루트 이름>/<상대경로> 로 옮기고 같은 이름에 번호를 붙인다', () => {
    const trash = join(root, '..', 'trash')
    const spec = join(specsDir, 'spec-a.md')
    const dest = join(trash, '.orch', 'specs', 'spec-a.md')
    touch(spec, 'first')
    deleteSpecs({ root, specs: [spec], prBodies: [], live: new Set(), mode: { trash }, apply: true, log })
    touch(spec, 'second')
    const got = deleteSpecs({ root, specs: [spec], prBodies: [], live: new Set(), mode: { trash }, apply: true, log })
    assert.deepEqual(got.removed, [spec])
    assert.equal(existsSync(spec), false)
    assert.equal(readFileSync(dest, 'utf8'), 'first')
    assert.equal(readFileSync(`${dest}.2`, 'utf8'), 'second')
    touch(spec, 'third')
    deleteSpecs({ root, specs: [spec], prBodies: [], live: new Set(), mode: { trash }, apply: true, log })
    assert.equal(readFileSync(`${dest}.3`, 'utf8'), 'third')
  })
})

describe('liveSpecPaths', () => {
  const tasks = [
    { id: 't1', status: 'dispatched', spec: '지시서 /s/one.md 를 읽고 `/s/common.md` 도 본다. /s/notes.txt 와 x.md 는 아니다' },
    { id: 't2', status: 'completed', spec: '지시서 /s/two.md 를 읽는다' },
    { id: 't3', status: 'completed', spec: '지시서 /s/three.md 를 읽는다' },
    { id: 't4', status: 'ready', spec: '지시서 /s/four.md 를 읽는다' },
    { id: 't5', status: 'completed', spec: '지시서 /s/five.md 를 읽는다' },
  ]

  function rules(...list: FakeRule[]) {
    fake.setRules(list)
  }

  function lastCalls(from: number): string[][] {
    return fake.calls().slice(from).map((c) => c.argv)
  }

  test('살아 있는 Task 와 살아 있는 dispatch 의 Task 의 지시서를 모은다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      {
        args: ['worker-list'],
        stdout: envelope({
          workers: [
            { taskId: 't3', dispatchStatus: 'dispatched' },
            { taskId: 't2', dispatchStatus: 'completed' },
          ],
          scope: { source: 'flag' },
        }),
      },
    )
    const from = fake.calls().length
    assert.deepEqual(liveSpecPaths('run_x'), new Set(['/s/one.md', '/s/common.md', '/s/three.md']))
    const argv = lastCalls(from)
    assert.ok(argv.some((a) => a.join(' ') === 'orchestration task-list --run run_x --json'), JSON.stringify(argv))
    assert.ok(argv.some((a) => a.join(' ') === 'orchestration worker-list --run run_x --limit 100 --json'), JSON.stringify(argv))
  })

  test('worker-list 가 nextCursor 로 두 페이지를 주면 둘째 페이지의 지시서도 살아 있다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      { args: ['worker-list', '--cursor', 'c2'], stdout: envelope({ workers: [{ taskId: 't5', dispatchStatus: 'running' }], page: { nextCursor: null } }) },
      { args: ['worker-list'], stdout: envelope({ workers: [{ taskId: 't3', dispatchStatus: 'pending' }], page: { nextCursor: 'c2' } }) },
    )
    const from = fake.calls().length
    assert.deepEqual(liveSpecPaths('run_x'), new Set(['/s/one.md', '/s/common.md', '/s/three.md', '/s/five.md']))
    assert.ok(
      lastCalls(from).some((a) => a.join(' ') === 'orchestration worker-list --run run_x --limit 100 --cursor c2 --json'),
      JSON.stringify(lastCalls(from)),
    )
  })

  test('task-list 도 nextCursor 로 끝까지 읽는다', () => {
    rules(
      { args: ['task-list', '--cursor', 'k2'], stdout: envelope({ tasks: [{ id: 't9', status: 'running', spec: '지시서 /s/nine.md' }] }) },
      { args: ['task-list'], stdout: envelope({ tasks: [], page: { nextCursor: 'k2' } }) },
      { args: ['worker-list'], stdout: envelope({ workers: [] }) },
    )
    assert.deepEqual(liveSpecPaths('run_x'), new Set(['/s/nine.md']))
  })

  test('둘째 페이지 조회가 실패하면 null 이다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      { args: ['worker-list', '--cursor', 'c2'], stderr: 'boom', code: 1 },
      { args: ['worker-list'], stdout: envelope({ workers: [], page: { nextCursor: 'c2' } }) },
    )
    assert.equal(liveSpecPaths('run_x'), null)
  })

  test('같은 cursor 가 다시 오면 null 이다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      { args: ['worker-list'], stdout: envelope({ workers: [], page: { nextCursor: 'same' } }) },
    )
    assert.equal(liveSpecPaths('run_x'), null)
  })

  test('조회가 하나라도 실패하면 null 이다', () => {
    rules({ args: ['task-list'], code: 1 }, { args: ['worker-list'], stdout: envelope({ workers: [] }) })
    assert.equal(liveSpecPaths('run_x'), null)
    rules({ args: ['task-list'], stdout: envelope({ tasks }) }, { args: ['worker-list'], stdout: envelope(null) })
    assert.equal(liveSpecPaths('run_x'), null)
  })

  test('run 이 null 이고 scope.source 가 bound 면 null 이다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      { args: ['worker-list'], stdout: envelope({ workers: [], scope: { source: 'bound' } }) },
    )
    const from = fake.calls().length
    assert.equal(liveSpecPaths(null), null)
    assert.ok(lastCalls(from).every((a) => !a.includes('--run')), JSON.stringify(lastCalls(from)))
  })

  test('run 이 null 이고 scope.source 가 all 이면 모든 Run 의 지시서다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      { args: ['worker-list'], stdout: envelope({ workers: [{ taskId: 't3', dispatchStatus: 'running' }], scope: { source: 'all' } }) },
    )
    assert.deepEqual(liveSpecPaths(null), new Set(['/s/one.md', '/s/common.md', '/s/three.md']))
  })

  test('run 이 null 이고 worker-list 가 all 이어도 task-list 의 scope.source 가 all 이 아니면 null 이다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks, scope: { source: 'bound' } }) },
      { args: ['worker-list'], stdout: envelope({ workers: [{ taskId: 't3', dispatchStatus: 'running' }], scope: { source: 'all' } }) },
    )
    assert.equal(liveSpecPaths(null), null)
  })

  test('run 이 null 이고 살아 있는 dispatch 의 taskId 가 task-list 행에 없으면 null 이다', () => {
    // task-list 가 scope 를 알리지 않고 묶인 Run 의 Task 만 준 경우다. t7 은 다른 Run 의 살아 있는 dispatch 다.
    rules(
      { args: ['task-list'], stdout: envelope({ tasks }) },
      {
        args: ['worker-list'],
        stdout: envelope({
          workers: [
            { taskId: 't3', dispatchStatus: 'running' },
            { taskId: 't7', dispatchStatus: 'dispatched' },
          ],
          scope: { source: 'all' },
        }),
      },
    )
    assert.equal(liveSpecPaths(null), null)
  })

  test('run 이 null 이어도 task-list 행에 없는 taskId 가 끝난 dispatch 의 것이면 판정에 쓰지 않는다', () => {
    rules(
      { args: ['task-list'], stdout: envelope({ tasks, scope: { source: 'all' } }) },
      {
        args: ['worker-list'],
        stdout: envelope({
          workers: [
            { taskId: 't3', dispatchStatus: 'running' },
            { taskId: 't7', dispatchStatus: 'completed' },
          ],
          scope: { source: 'all' },
        }),
      },
    )
    assert.deepEqual(liveSpecPaths(null), new Set(['/s/one.md', '/s/common.md', '/s/three.md']))
  })

  test('지시서 경로를 실경로로 바꾼다', () => {
    const spec = join(base, 'specs-real', 'spec-x.md')
    mkdirSync(join(spec, '..'), { recursive: true })
    writeFileSync(spec, 'x')
    // macOS 의 임시 폴더는 /var 가 /private/var 를 가리켜, 실경로가 아닌 꼴로 주어도 같은 파일로 본다.
    const alias = spec.replace(/^\/private\//, '/')
    rules(
      { args: ['task-list'], stdout: envelope({ tasks: [{ id: 'tx', status: 'running', spec: `지시서 ${alias} 를 읽는다` }] }) },
      { args: ['worker-list'], stdout: envelope({ workers: [] }) },
    )
    assert.deepEqual(liveSpecPaths('run_x'), new Set([spec]))
  })
})
