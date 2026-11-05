// 테스트에서 명령을 띄우고 결과를 한 꼴로 받는다. node:test 를 import 하지 않아 일반 스크립트도 쓴다.
// 자식 환경에서 NODE_TEST_CONTEXT 를 지운다. 테스트 안에서 띄운 `node --test` 가 이 값을 물려받으면 reporter 출력이 사라진다.

import { spawn, spawnSync } from 'node:child_process'

export type CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }

function childEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const copy = { ...(env ?? process.env) }
  delete copy.NODE_TEST_CONTEXT
  return copy
}

export function runCommand(argv: string[], opts: CommandOptions = {}): CommandResult {
  const done = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    input: opts.input,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
  })
  const timedOut = (done.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { code: done.status, signal: done.signal, stdout: done.stdout ?? '', stderr: done.stderr ?? '', timedOut }
}

export function runCommandAsync(argv: string[], opts: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    // 새 프로세스 그룹으로 띄워 시간이 지나면 손자까지 함께 죽인다
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: childEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = ''
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, signal, stdout, stderr: stderr + spawnError, timedOut })
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
          // 손자가 파이프를 쥐고 있어도 close 를 기다리지 않고 제한 시간 안에 돌려준다
          finish(null, 'SIGKILL')
        }, opts.timeoutMs)
      : null
    child.on('error', (error) => (spawnError = error.message))
    child.on('close', finish)
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

export function nodeScript(script: string, args: string[] = []): string[] {
  return [process.execPath, script, ...args]
}
