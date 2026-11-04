// 새 꼴의 문맥 기본값(lib/context.ts)이 「명시 > 문맥 > 설정」 순서로 채우는지 본다. 임시 git 저장소와 가짜 orca 만 쓴다.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { resolveNew, type Command } from '../scripts/lib/commands.ts'
import { contextEnv, fillContext } from '../scripts/lib/context.ts'
import { registerRun } from '../scripts/lib/loop.ts'

let tmp: string
let main: string
let worktree: string
let outside: string
const saved: Record<string, string | undefined> = {}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
}

// 가짜 orca. FAKE_RUN 이 있으면 run-current 에 그 Run 을 낸다. FAKE_SLOW_ONCE 가 있으면 첫 호출만 3초 늦는다
function fakeOrca(): string {
  const file = join(tmp, 'orca')
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ -n "$FAKE_SLOW_ONCE" ] && [ ! -e "$FAKE_SLOW_ONCE" ]; then : > "$FAKE_SLOW_ONCE"; sleep 3; fi',
      '[ -n "$FAKE_RUN" ] || { echo "no run" >&2; exit 1; }',
      'printf \'{"ok":true,"result":{"run":{"id":"%s"}}}\\n\' "$FAKE_RUN"',
      '',
    ].join('\n'),
  )
  chmodSync(file, 0o755)
  return file
}

function config(repo: string, finish: Record<string, string>): void {
  mkdirSync(join(repo, '.orch'), { recursive: true })
  writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ finish }))
}

function command(argv: string[]): { command: Command; args: string[] } {
  const r = resolveNew(argv)
  assert.ok(!('error' in r), JSON.stringify(r))
  return r as { command: Command; args: string[] }
}

function fill(argv: string[], cwd: string, opts = {}) {
  const { command: c, args } = command(argv)
  return fillContext(c, args, cwd, { orcaTimeoutMs: 2000, ackTimeoutMs: 8000, ...opts })
}

function filled(argv: string[], cwd: string, opts = {}): { args: string[]; note: string | null; sources: Record<string, string> } {
  const r = fill(argv, cwd, opts)
  assert.ok(!('error' in r), 'error' in r ? r.error : '')
  return r as { args: string[]; note: string | null; sources: Record<string, string> }
}

// 저장소는 한 번만 만든다. 테스트마다 .orch 와 다른 저장소만 지운다
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-context-')))
  main = join(tmp, 'repo')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  writeFileSync(join(main, '.gitignore'), '.orch/\n')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
  worktree = join(tmp, 'wt')
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature')
  outside = join(tmp, 'outside')
  mkdirSync(outside)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

beforeEach(() => {
  for (const dir of [join(main, '.orch'), join(tmp, 'other'), join(tmp, 'slow-once')]) rmSync(dir, { recursive: true, force: true })
  for (const key of ['ORCA', 'FAKE_RUN', 'FAKE_SLOW_ONCE', 'ORCH_DIR']) saved[key] = process.env[key]
  delete process.env.ORCH_DIR
  process.env.ORCA = fakeOrca()
  process.env.FAKE_RUN = 'run_ctx'
  delete process.env.FAKE_SLOW_ONCE
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('채우기', () => {
  test('워크트리 안에서 인자 없이 부르면 주 checkout, run-current, 기본 지시서 폴더를 채운다', () => {
    const r = filled(['loop', 'start'], worktree)
    assert.deepEqual(r.args, ['--start', '--repo', main, '--run', 'run_ctx', '--specs-dir', join(main, '.orch', 'specs')])
    assert.equal(r.note, `orch: 문맥 repo=${main}(작업 폴더) run=run_ctx(run-current) specs-dir=${join(main, '.orch', 'specs')}(기본 위치)`)
    assert.equal(contextEnv(r.sources), 'repo=cwd run=run-current specs-dir=default')
  })

  test('채운 결과가 같은 값을 명시한 결과와 같다', () => {
    const auto = filled(['loop', 'start'], worktree).args
    const given = filled(['loop', 'start', '--repo', main, '--run', 'run_ctx', '--specs-dir', join(main, '.orch', 'specs')], outside).args
    assert.deepEqual([...auto].sort(), [...given].sort())
  })

  test('명시한 값은 그대로 두고 채우지 않는다', () => {
    assert.deepEqual(filled(['loop', 'stop', '--run', 'mine'], worktree).args, ['--stop', '--repo', main, '--run', 'mine'])
    const merge = filled(['queue', 'merge', '--finish-arg=--run', '--finish-arg=x', '12'], worktree).args
    assert.ok(!merge.includes('run_ctx'), merge.join(' '))
  })

  test('run-current 가 없으면 설정의 finish.run 과 finish.specs_dir 를 쓴다', () => {
    delete process.env.FAKE_RUN
    config(main, { run: 'run_conf', specs_dir: 'docs/specs' })
    const r = filled(['loop', 'start'], worktree)
    assert.deepEqual(r.args, ['--start', '--repo', main, '--run', 'run_conf', '--specs-dir', join(main, 'docs', 'specs')])
    assert.match(r.note!, /run=run_conf\(설정\) specs-dir=.*\(설정\)/)
  })

  test('둘 다 없으면 run 을 채우지 않는다', () => {
    delete process.env.FAKE_RUN
    assert.deepEqual(filled(['loop', 'status'], worktree).args, ['--status', '--repo', main])
    assert.deepEqual(filled(['loop', 'stop'], worktree).args, ['--stop', '--repo', main])
  })

  test('명시한 --repo 가 하나면 그 저장소의 설정과 지시서 폴더를 쓴다', () => {
    const other = join(tmp, 'other')
    mkdirSync(other)
    git(other, 'init', '-q')
    config(other, { run: 'run_other', specs_dir: 's' })
    delete process.env.FAKE_RUN
    assert.deepEqual(filled(['cleanup', 'sweep', '--repo', other], main).args, ['--run', 'run_other', '--specs-dir', join(other, 's'), '--repo', other])
    assert.deepEqual(filled(['queue', 'merge', '--repo', other, '3'], main).args, ['--run', 'run_other', '--repo', other, '3'])
  })

  test('--repo 가 둘 이상인 cleanup sweep 은 지시서 폴더를 채우지 않는다', () => {
    const r = filled(['cleanup', 'sweep', '--repo', 'a', '--repo', 'b'], main).args
    assert.ok(!r.includes('--specs-dir'), r.join(' '))
    assert.equal(r.filter((a) => a === '--repo').length, 2)
  })

  test('loop stop --all 은 run 을, worker launch --worktree 는 repo 를 채우지 않는다', () => {
    assert.deepEqual(filled(['loop', 'stop', '--all'], worktree).args, ['--stop', '--repo', main, '--all'])
    assert.deepEqual(filled(['worker', 'launch', '--worktree', worktree, '--spec', 's'], worktree).args, ['--run', 'run_ctx', '--worktree', worktree, '--spec', 's'])
  })

  test('worker worktree 의 위치 인자는 repo 의 명시다', () => {
    assert.deepEqual(filled(['worker', 'worktree', '/x', '--name', 'n'], worktree).args, ['--repo', '/x', '--name', 'n'])
  })

  test('doctor 와 loop stalled 는 run-current 가 있어도 run 을 채우지 않는다', () => {
    assert.deepEqual(filled(['doctor'], worktree).args, ['--repo', main])
    assert.deepEqual(filled(['loop', 'stalled'], worktree).args, ['--repo', main])
  })

  test('worker send 는 run-current 만 쓰고 설정으로 대신하지 않는다', () => {
    delete process.env.FAKE_RUN
    config(main, { run: 'run_conf' })
    assert.deepEqual(filled(['worker', 'send', '--dispatch', 'd', '--body', 'b'], worktree).args, ['--dispatch', 'd', '--body', 'b'])
  })

  test('wait 은 루프에 등록된 Run 이면 루프 저장소를 채운다', () => {
    registerRun(main, 'run_ctx', null)
    const r = filled(['wait'], worktree)
    assert.deepEqual(r.args, ['--run', 'run_ctx', '--loop-repo', main])
    assert.equal(contextEnv(r.sources), 'run=run-current loop-repo=registered')
    // ack-lost 는 run 만 채운다
    assert.deepEqual(filled(['wait', 'ack-lost', 'd1'], worktree).args, ['--run', 'run_ctx', '--ack-lost', 'd1'])
  })

  test('git 저장소 밖에서는 repo 를 채우지 않는다', () => {
    assert.deepEqual(filled(['loop', 'status'], outside).args, ['--status'])
  })

  test('잘못된 config.json 이 있어도 오류가 아니고 설정 출처만 건너뛴다', () => {
    mkdirSync(join(main, '.orch'), { recursive: true })
    writeFileSync(join(main, '.orch', 'config.json'), '{broken')
    delete process.env.FAKE_RUN
    assert.deepEqual(filled(['loop', 'status'], worktree).args, ['--status', '--repo', main])
  })

  test('`--` 뒤의 문맥 인자는 명시로 보지 않고 건드리지 않는다', () => {
    const r = filled(['worker', 'launch', '--spec', 's', '--', '--repo', 'x'], worktree).args
    assert.deepEqual(r, ['--repo', main, '--run', 'run_ctx', '--spec', 's', '--', '--repo', 'x'])
  })

  test('passthrough 명령은 문맥을 채우지 않는다', () => {
    assert.deepEqual(filled(['slot', 'heavy', '--', 'make'], worktree).args, ['--', 'make'])
  })
})

describe('사용법 오류', () => {
  test('줄여 쓴 문맥 인자는 오류다', () => {
    for (const argv of [['loop', 'start', '--re', 'x'], ['loop', 'start', '--ru=x'], ['cleanup', 'sweep', '--specs', 'x']]) {
      const r = fill(argv, worktree)
      assert.ok('error' in r, argv.join(' '))
      assert.match(r.error, /줄여 쓴 것이다/)
    }
  })

  test('wait 의 run 을 문맥도 설정도 주지 못하면 무엇을 줘야 하는지 알린다', () => {
    delete process.env.FAKE_RUN
    const r = fill(['wait'], worktree)
    assert.ok('error' in r)
    assert.match(r.error, /--run <Run> 이 필요하다/)
  })

  test('--ack 가 있는 wait 은 run-current 를 못 읽으면 설정으로 대신하지 않는다', () => {
    delete process.env.FAKE_RUN
    config(main, { run: 'run_conf' })
    const r = fill(['wait', '--ack', 'x'], worktree)
    assert.ok('error' in r)
    assert.match(r.error, /--run <Run> 을 붙인다/)
  })

  test('--ack 가 있는 wait 은 run-current 가 첫 제한에 늦어도 더 긴 제한으로 다시 읽는다', () => {
    process.env.FAKE_SLOW_ONCE = join(tmp, 'slow-once')
    assert.deepEqual(filled(['wait', '--ack', 'x'], worktree).args, ['--run', 'run_ctx', '--ack', 'x'])
  })
})
