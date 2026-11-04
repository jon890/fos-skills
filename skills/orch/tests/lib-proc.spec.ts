import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { run, runAsync, runInherit, scriptCommand } from '../scripts/lib/proc.ts'
import type { RunResult } from '../scripts/lib/proc.ts'
import { alive } from '../scripts/lib/process.ts'

const NODE = process.execPath

function node(code: string): string[] {
  return [NODE, '-e', code]
}

describe('run', () => {
  test('자식의 종료 코드와 stdout, stderr 를 낸다', () => {
    const r = run(node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'))
    assert.deepEqual(r, { code: 3, stdout: 'out', stderr: 'err', timedOut: false })
  })

  test('자식이 stdin 을 읽지 않고 끝나도 EPIPE 가 아니라 자식의 종료 코드다', () => {
    // 파이프 버퍼보다 큰 입력이라 자식이 먼저 끝나면 쓰기가 반드시 EPIPE 를 만난다
    const r = run(node('process.exit(3)'), { input: 'x'.repeat(1 << 20) })
    assert.equal(r.code, 3, r.stderr)
  })

  test('input 을 자식의 stdin 으로 넘긴다', () => {
    const r = run(node('process.stdin.pipe(process.stdout)'), { input: '입력' })
    assert.equal(r.stdout, '입력')
    assert.equal(r.code, 0)
  })

  test('env 는 process.env 위에 덮이고 undefined 인 키는 자식 환경에서 빠진다', () => {
    const saved = { keep: process.env.ORCH_SPEC_KEEP, drop: process.env.ORCH_SPEC_DROP }
    process.env.ORCH_SPEC_KEEP = 'keep'
    process.env.ORCH_SPEC_DROP = 'drop'
    try {
      const r = run(
        node('const e = process.env; process.stdout.write(JSON.stringify({ keep: e.ORCH_SPEC_KEEP, drop: "ORCH_SPEC_DROP" in e, add: e.ORCH_SPEC_ADD }))'),
        { env: { ORCH_SPEC_ADD: 'add', ORCH_SPEC_DROP: undefined } },
      )
      assert.deepEqual(JSON.parse(r.stdout), { keep: 'keep', drop: false, add: 'add' })
    } finally {
      for (const [key, value] of [['ORCH_SPEC_KEEP', saved.keep], ['ORCH_SPEC_DROP', saved.drop]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('없는 실행 파일은 127 이고 이유가 stderr 에 있다', () => {
    const r = run(['/nonexistent-orch-spec/missing-bin'])
    assert.equal(r.code, 127)
    assert.match(r.stderr, /ENOENT/)
    assert.equal(r.timedOut, false)
  })

  test('시간을 넘기면 124 와 timedOut 이다', () => {
    const r = run(node('setTimeout(() => {}, 10000)'), { timeoutMs: 200 })
    assert.equal(r.code, 124)
    assert.equal(r.timedOut, true)
  })

  test('자기에게 SIGKILL 을 보낸 자식은 128 + 9 인 137 이다', () => {
    const r = run(node('process.kill(process.pid, "SIGKILL")'))
    assert.equal(r.code, 137)
    assert.equal(r.timedOut, false)
  })

  test('출력이 maxBuffer 와 같으면 정상이고 넘으면 1 과 ENOBUFS 이유다', () => {
    const exact = run(node('process.stdout.write("x".repeat(1024))'), { maxBuffer: 1024 })
    assert.equal(exact.code, 0)
    assert.equal(exact.stdout.length, 1024)
    const over = run(node('process.stdout.write("x".repeat(1025))'), { maxBuffer: 1024 })
    assert.equal(over.code, 1)
    assert.match(over.stderr, /ENOBUFS/)
    assert.equal(over.timedOut, false)
  })
})

describe('runAsync', () => {
  test('자식의 종료 코드와 출력을 낸다', async () => {
    const r = await runAsync(node('process.stdout.write("out"); process.stderr.write("err"); process.exit(4)'))
    assert.deepEqual(r, { code: 4, stdout: 'out', stderr: 'err', timedOut: false })
  })

  test('없는 실행 파일은 127 이다', async () => {
    const r = await runAsync(['/nonexistent-orch-spec/missing-bin'])
    assert.equal(r.code, 127)
    assert.match(r.stderr, /ENOENT/)
  })

  test('시그널로 죽은 자식은 128 + 신호 번호다', async () => {
    const r = await runAsync(node('process.kill(process.pid, "SIGKILL")'))
    assert.equal(r.code, 137)
  })

  test('출력이 maxBuffer 를 넘으면 1 과 ENOBUFS 이유다', async () => {
    const exact = await runAsync(node('process.stdout.write("x".repeat(1024))'), { maxBuffer: 1024 })
    assert.equal(exact.code, 0)
    const over = await runAsync(node('process.stdout.write("x".repeat(1025)); setTimeout(() => {}, 10000)'), { maxBuffer: 1024 })
    assert.equal(over.code, 1)
    assert.match(over.stderr, /ENOBUFS/)
  })

  test('시간을 넘기면 TERM 으로 끝내고 124 와 timedOut 이다', async () => {
    const r = await runAsync(node('setTimeout(() => {}, 10000)'), { timeoutMs: 200 })
    assert.equal(r.code, 124)
    assert.equal(r.timedOut, true)
  })

  test('signal 이 abort 되면 TERM 으로 끝내고 143 이며 timedOut 이 아니다', async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 100)
    const started = Date.now()
    const r = await runAsync(node('setTimeout(() => {}, 20000)'), { timeoutMs: 30_000, signal: stop.signal })
    assert.deepEqual([r.code, r.timedOut], [143, false])
    assert.ok(Date.now() - started < 10_000)
  })

  test('이미 abort 된 signal 을 받으면 띄운 자식을 바로 끝낸다', async () => {
    const stop = new AbortController()
    stop.abort()
    const r = await runAsync(node('setTimeout(() => {}, 20000)'), { timeoutMs: 30_000, signal: stop.signal })
    assert.equal(r.code, 143)
  })

  test('TERM 을 무시하는 자식은 KILL 유예 뒤 KILL 로 끝난다', { timeout: 30_000 }, async (t) => {
    // 운영 기본 유예는 10초다. 테스트는 1초로 줄여 같은 동작을 본다
    process.env.ORCH_KILL_GRACE_SEC = '1'
    t.after(() => delete process.env.ORCH_KILL_GRACE_SEC)
    const started = Date.now()
    const r = await runAsync(
      node('process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'),
      { timeoutMs: 500 },
    )
    const elapsed = Date.now() - started
    assert.equal(r.code, 124)
    assert.equal(r.timedOut, true)
    assert.equal(r.stdout, 'ready')
    assert.ok(elapsed >= 1_500, `KILL 전에 시간 제한과 유예 1초를 기다려야 하는데 ${elapsed}ms 만에 끝났다`)
    assert.ok(elapsed < 10_000, `KILL 뒤 바로 끝나야 하는데 ${elapsed}ms 걸렸다`)
  })
})

describe('runAsync 와 출력 파이프를 쥔 손자', () => {
  // 자식(sh)은 바로 3 으로 끝나고, 백그라운드 sleep 이 stdout 과 stderr 를 물려받아 30초 동안 쥔다. 첫 줄은 그 sleep 의 pid 다.
  const HOLDER = ['sh', '-c', 'sleep 30 & echo $!; exit 3']

  async function withHolder(timeoutMs: number | undefined): Promise<{ r: RunResult; elapsed: number }> {
    const started = Date.now()
    const r = await runAsync(HOLDER, timeoutMs === undefined ? {} : { timeoutMs })
    const elapsed = Date.now() - started
    const grandchild = Number(r.stdout.split('\n')[0])
    if (Number.isInteger(grandchild) && grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    return { r, elapsed }
  }

  test('자식이 끝나면 손자가 파이프를 쥐어도 짧은 유예 뒤 자식의 종료 코드로 돌아온다', { timeout: 30_000 }, async () => {
    const { r, elapsed } = await withHolder(undefined)
    assert.equal(r.code, 3, `자식의 종료 코드 3 이 아니다: ${JSON.stringify(r)}`)
    assert.equal(r.timedOut, false)
    assert.match(r.stdout, /^\d+\n/, `유예 안에 온 출력(손자 pid)을 잃었다: ${JSON.stringify(r.stdout)}`)
    assert.ok(elapsed < 8000, `손자가 끝날 때까지 기다렸다: ${elapsed}ms`)
  })

  test('시간 제한이 유예보다 짧아도 이미 끝난 자식은 124 가 아니라 자식의 종료 코드다', { timeout: 30_000 }, async () => {
    const { r, elapsed } = await withHolder(500)
    assert.equal(r.code, 3, `끝난 자식에 시간 초과를 냈다: ${JSON.stringify(r)}`)
    assert.equal(r.timedOut, false)
    assert.ok(elapsed < 8000, `손자가 끝날 때까지 기다렸다: ${elapsed}ms`)
  })
})

describe('runInherit', () => {
  // 출력을 물려주므로 자식은 아무것도 쓰지 않는다. 쓰면 테스트 러너의 출력에 섞인다
  test('자식의 종료 코드를 낸다', async () => {
    assert.deepEqual(await runInherit(node('process.exit(3)')), { code: 3, timedOut: false })
  })

  test('시간을 넘기면 124 와 timedOut 이다', { timeout: 30_000 }, async () => {
    assert.deepEqual(await runInherit(node('setTimeout(() => {}, 20000)'), { timeoutMs: 300 }), { code: 124, timedOut: true })
  })

  test('시그널로 죽으면 128 + 신호 번호이고, 실행 파일이 없으면 127 이다', async () => {
    assert.deepEqual(await runInherit(node('process.kill(process.pid, "SIGTERM")')), { code: 143, timedOut: false })
    assert.deepEqual(await runInherit(['/nonexistent/orch-spec-tool']), { code: 127, timedOut: false })
  })
})

describe('scriptCommand', () => {
  test('확장자로 인터프리터를 고르고 .ts 는 이 프로세스의 node 로 띄운다', () => {
    assert.deepEqual(scriptCommand('/s/a.ts', ['x']), [process.execPath, '--disable-warning=ExperimentalWarning', '/s/a.ts', 'x'])
    assert.deepEqual(scriptCommand('/s/a.py', ['x']), ['python3', '/s/a.py', 'x'])
    assert.deepEqual(scriptCommand('/s/a.sh', []), ['bash', '/s/a.sh'])
    assert.deepEqual(scriptCommand('/s/a.zsh', ['x', 'y']), ['zsh', '/s/a.zsh', 'x', 'y'])
  })

  test('확장자 없는 파일과 모르는 확장자는 옛 명령처럼 python3 으로 띄운다', () => {
    assert.deepEqual(scriptCommand('/s/tool', ['x']), ['python3', '/s/tool', 'x'])
    assert.deepEqual(scriptCommand('/s/a.rb', []), ['python3', '/s/a.rb'])
  })
})

describe('execCommand', () => {
  const PROC = fileURLToPath(new URL('../scripts/lib/proc.ts', import.meta.url))

  // execCommand 를 부르는 node 를 띄운다. 바꾸지 못하면 execCommand 가 낸 코드로 끝난다
  function exec(argv: string[]) {
    const code = `import { execCommand } from ${JSON.stringify(PROC)}; process.exitCode = execCommand(${JSON.stringify(argv)}, 'label')`
    const done = spawnSync(NODE, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { encoding: 'utf8' })
    return { code: done.status, signal: done.signal, stdout: done.stdout, stderr: done.stderr }
  }

  test('실행 권한이 있어도 #! 나 실행 파일 형식이 아니면 abort 하지 않고 이유와 1 을 낸다', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-proc-')))
    try {
      const script = join(tmp, 'no-shebang')
      writeFileSync(script, 'echo ran\n', { mode: 0o755 })
      const bad = exec([script])
      assert.deepEqual([bad.code, bad.signal, bad.stdout], [1, null, ''], bad.stderr)
      assert.equal(bad.stderr, `label: exec format error: ${script}\n`)
      // 앞 2바이트만 #! 이면 넘긴다
      const good = join(tmp, 'shebang')
      writeFileSync(good, '#!/bin/sh\necho ran\n', { mode: 0o755 })
      const ran = exec([good])
      assert.deepEqual([ran.code, ran.stdout], [0, 'ran\n'], ran.stderr)
      // 실행 파일(이 node)도 넘긴다
      const binary = exec([NODE, '-e', "process.stdout.write('bin')"])
      assert.deepEqual([binary.code, binary.stdout], [0, 'bin'], binary.stderr)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
