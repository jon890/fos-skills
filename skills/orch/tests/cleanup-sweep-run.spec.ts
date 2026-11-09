// 실제 CLI 의 인자·출력·종료 코드를 남기고 함수 가짜와 대응한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { linkBin, fakeBin } from '../../../modules/testkit/fake-bin.ts'
import { runProcess } from '../scripts/lib/proc.ts'
import { statefulRun } from './fixtures/cleanup-sweep-run.ts'
import { fx, SCRIPT, REMOVE, save, worktree } from './fixtures/cleanup-sweep.ts'

function cli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: fx.env, encoding: 'utf8' })
}

test('실제 cleanup CLI 의 help 는 사용법과 종료 코드 0 이다', () => {
  const done = cli(['--help'])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /사용법:/)
})

test('실제 cleanup CLI 의 잘못된 인자는 종료 코드 2 다', () => {
  const done = cli(['--unknown-option'])
  assert.equal(done.status, 2)
  assert.match(done.stderr, /사용법:/)
})

test('실제 cleanup CLI 의 dry-run 은 저장소와 정리 요약을 낸다', () => {
  save()
  const done = cli(['--repo', fx.repo])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /cleanup-sweep dry-run:/)
})

test('실제 cleanup CLI 의 조회 실패는 stderr 와 종료 코드 2 다', () => {
  fx.orcaFail = true
  save()
  const done = cli(['--repo', fx.repo])
  assert.equal(done.status, 2)
  assert.match(done.stderr, /orca terminal list/)
})

test('실제 cleanup CLI 의 예상하지 못한 출력 예외는 종료 코드 1 이다', () => {
  save()
  const preload = join(fx.tmp, 'output-error.cjs')
  // CLI 의 출력 경계만 실패시킨다. 가짜 명령 자식의 출력은 그대로 둔다.
  writeFileSync(preload, `if (process.argv[1] === ${JSON.stringify(SCRIPT)}) process.stdout.write = () => { throw new Error('forced-output-error') }`)
  fx.env.NODE_OPTIONS = `${fx.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim()
  const done = cli(['--repo', fx.repo])
  assert.equal(done.status, 1)
  assert.match(done.stderr, /cleanup-sweep: Error: forced-output-error/)
})

test('공유 가짜의 성공·실패·상태 변화·SWEEP pid 가 실행 파일과 같다', () => {
  fx.processes = [{ pid: 'SWEEP', cwd: fx.repo, command: 'cleanup-sweep' }, { pid: 501, cwd: fx.repo, command: 'zsh' }]
  fx.terminals = [{ handle: 'term_shell', worktreePath: fx.repo }]
  const cases: [string, string[]][] = [
    [fx.env.GH!, ['repo', 'view']],
    [fx.env.GH!, ['api', 'user']], // 빈 사용자 조회는 실패한다
    [fx.env.ORCA!, ['terminal', 'list']],
    [fx.env.ORCA!, ['terminal', 'close', '--terminal', 'term_shell']],
    ['lsof', ['-d', 'cwd', '-Fpn']],
    ['ps', ['-axo', 'pid=,ppid=,command=']],
    [fx.env.ORCH_KILL!, ['-TERM', '501']],
    [fx.env.DOCKER!, ['ps']],
  ]
  for (const [command, args] of cases) {
    const reset = () => { save(); rmSync(fx.logFile, { force: true }) }
    reset()
    const real = runProcess([command, ...args], { env: fx.env })
    const realState = readFileSync(fx.env.FAKE_STATE!, 'utf8')
    const realCalls = (() => { try { return readFileSync(fx.logFile, 'utf8') } catch { return '' } })()
    reset()
    assert.deepEqual(statefulRun([command, ...args], { env: fx.env }), real, command)
    assert.equal(readFileSync(fx.env.FAKE_STATE!, 'utf8'), realState, command)
    const fakeCalls = (() => { try { return readFileSync(fx.logFile, 'utf8') } catch { return '' } })()
    assert.equal(fakeCalls, realCalls, command)
  }
})

test('규칙 가짜의 env·cwd·stdout·stderr·종료와 호출 기록이 같다', () => {
  const gh = fakeBin(fx.tmp, 'gh-rules', [{ args: ['fail'], code: 7, stdout: 'out\n', stderr: 'err\n' }], { recordEnv: ['SET', 'UNSET'] })
  const opts = { cwd: fx.tmp, env: { GH: gh.path, SET: 'value', UNSET: undefined } }
  for (const args of [[], ['fail']]) assert.deepEqual(statefulRun([gh.path, ...args], opts), runProcess([gh.path, ...args], opts))
  const rows = gh.calls()
  assert.deepEqual(rows[0], rows[1])
  assert.deepEqual(rows[2], rows[3])
  assert.deepEqual(rows[0].env, { SET: 'value', UNSET: null })
})

test('본문 예외는 명령 실패이고 실제 명령은 기존 실행기로 보낸다', () => {
  const gh = linkBin(fx.tmp, 'broken', "throw new Error('broken fake')")
  const result = statefulRun([gh], { env: { GH: gh } })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /broken fake/)
  assert.equal(result.timedOut, false)
  const argv = [process.execPath, '-e', 'process.stdout.write("real")']
  assert.deepEqual(statefulRun(argv), runProcess(argv))
})

test('exitCode 뒤 exit 과 console 의 동기 출력이 실제 실행과 같다', () => {
  for (const [name, body] of Object.entries({
    exit: 'process.exitCode = 3; process.exit()',
    console: "console.log('value %d', 3); console.info({ ok: true }); console.warn('warn'); console.error('error')",
  })) {
    const gh = linkBin(fx.tmp, name, body)
    const opts = { env: { GH: gh } }
    assert.deepEqual(statefulRun([gh], opts), runProcess([gh], opts))
  }
})

test('없는 경로·실행 권한·shebang·상대 실행 경로는 실제 실행을 유지한다', () => {
  const noExec = join(fx.tmp, 'no-exec')
  writeFileSync(noExec, `#!${process.execPath}\nprocess.exitCode = 0\n`)
  const shell = join(fx.tmp, 'shell')
  writeFileSync(shell, '#!/bin/sh\nprintf "shell\\n"\nexit 7\n')
  chmodSync(shell, 0o755)
  const noShebang = join(fx.tmp, 'no-shebang')
  writeFileSync(noShebang, 'exit 7\n')
  chmodSync(noShebang, 0o755)
  linkBin(fx.tmp, 'relative', "console.log('relative')")
  for (const bin of [join(fx.tmp, 'missing'), noExec, shell, noShebang, './relative']) {
    const opts = { cwd: fx.tmp, env: { GH: bin } }
    assert.deepEqual(statefulRun([bin], opts), runProcess([bin], opts), bin)
  }
})

test('같은 가짜 본문은 링크 경로가 달라도 같은 inode 를 쓴다', () => {
  const body = "console.log('same')"
  const a = linkBin(fx.tmp, 'first', body)
  const b = linkBin(fx.tmp, 'second', body)
  assert.equal(statSync(a).ino, statSync(b).ino)
})


test('실제 CLI 와 함수 fixture 는 같은 예외 출력·종료 코드를 낸다', () => {
  const config = new URL('../scripts/lib/config.ts', import.meta.url).href
  const entries = [
    { script: SCRIPT, fixture: fileURLToPath(new URL('./fixtures/cleanup-sweep-run.ts', import.meta.url)), code: 1, prefix: 'cleanup-sweep' },
    { script: fileURLToPath(new URL('../scripts/queue/notify-conflicts.ts', import.meta.url)), fixture: fileURLToPath(new URL('./fixtures/notify-conflicts-run.ts', import.meta.url)), code: 2, prefix: 'notify-conflicts' },
  ]
  for (const name of ['Error', 'ConfigError']) {
    const preload = join(fx.tmp, `error-${name}.mjs`)
    writeFileSync(preload, `import { ConfigError } from ${JSON.stringify(config)}; process.stdout.write = () => { throw new ${name}('forced-main-error') }`)
    for (const entry of entries) {
      const run = (script: string) => spawnSync(process.execPath, ['--import', preload, script, '--help'], { env: fx.env, encoding: 'utf8' })
      const cli = run(entry.script)
      const fixture = run(entry.fixture)
      const code = name === 'ConfigError' ? entry.code : 1
      assert.equal(cli.status, code, cli.stderr)
      assert.equal(fixture.status, code, fixture.stderr)
      assert.equal(fixture.stderr.split('\n')[0], cli.stderr.split('\n')[0])
      assert.match(cli.stderr, new RegExp(`^${entry.prefix}: .*forced-main-error`))
      if (name === 'ConfigError' && entry.prefix === 'notify-conflicts') assert.equal(cli.stderr, 'notify-conflicts: forced-main-error\n')
    }
  }
})


test('실제 삭제 자식과 함수 가짜 자식의 0·1·2 출력과 종료가 같다', () => {
  const dirty = worktree('dirty-remove')
  writeFileSync(join(dirty, 'untracked.txt'), 'keep')
  const cases: [string[], number][] = [[['--help'], 0], [[join(fx.tmp, 'missing')], 1], [['--unknown-option'], 2], [[dirty, '--wait', '0'], 1]]
  for (const [args, code] of cases) {
    save()
    const argv = [process.execPath, '--disable-warning=ExperimentalWarning', REMOVE, ...args]
    const real = runProcess(argv, { env: fx.env })
    assert.equal(real.code, code, args.join(' '))
    save()
    assert.deepEqual(statefulRun(argv, { env: fx.env }), real, args.join(' '))
  }
})

test('remove-worktree를 import하면 삭제 명령을 실행하지 않는다', () => {
  const done = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(REMOVE)})`], { env: fx.env, encoding: 'utf8' })
  assert.deepEqual([done.status, done.stdout, done.stderr], [0, '', ''])
})
