// 정리·충돌 알림의 동기 CommonJS 가짜 본문만 함수로 실행한다.
// 호출별 프로세스 격리는 유지하며 실제 git·remove-worktree·hook·ESM 대역은 runProcess 로 보낸다.
// argv/env/cwd, 동기 출력·종료와 부모 pid 만 지원한다. 지연·신호·비동기 출력·상대 파일 접근은
// 지원 범위 밖이며 그러한 대역은 실제 실행을 써야 한다. require('node:fs') 의 writeSync 만 가로챈다.
import * as fs from 'node:fs'
import { Console } from 'node:console'
import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join } from 'node:path'
import { Writable } from 'node:stream'
import { main, reportError } from '../../scripts/cleanup/cleanup-sweep.ts'
import { runProcess } from '../../scripts/lib/proc.ts'
import type { RunOptions, RunResult } from '../../scripts/lib/proc.ts'

const require = createRequire(import.meta.url)
const bodies = new Map<string, Function>()

export function statefulRun(argv: string[], opts: RunOptions = {}): RunResult {
  const env = { ...process.env, ...opts.env }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  let command = argv[0]
  // lsof 와 ps 만 fixture 의 PATH 에서 푼다. 다른 상대 경로는 실제 실행 경계에 둔다.
  if (command === 'lsof' || command === 'ps') {
    const first = (env.PATH ?? '').split(delimiter).map((dir) => join(dir, command)).find((file) => {
      try { fs.accessSync(file, fs.constants.X_OK); return true } catch { return false }
    })
    if (!env.CLEANUP_FAKE_BIN || first !== join(env.CLEANUP_FAKE_BIN, command)) return runProcess(argv, opts)
    command = first
  } else if (![env.GH, env.ORCA, env.ORCH_KILL, env.DOCKER].includes(command)) return runProcess(argv, opts)
  if (!isAbsolute(command)) return runProcess(argv, opts)
  let source: string
  try {
    fs.accessSync(command, fs.constants.X_OK)
    source = fs.readFileSync(command, 'utf8')
  } catch {
    return runProcess(argv, opts)
  }
  const shebang = source.split('\n', 1)[0]
  if (shebang !== `#!${process.execPath}` && shebang !== '#!/usr/bin/env node') return runProcess(argv, opts)
  let stdout = ''
  let stderr = ''
  const exited = Symbol('fake-exit')
  const output = (fd: number, data: string | Uint8Array) => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString()
    if (fd === 1) stdout += text
    else if (fd === 2) stderr += text
    else return fs.writeSync(fd, data as string)
    return Buffer.byteLength(text)
  }
  const fake = {
    argv: [process.execPath, command, ...argv.slice(1)], env,
    // 실제 가짜 자식의 부모는 지금 main 을 실행 중인 프로세스다.
    ppid: process.pid,
    cwd: () => opts.cwd ?? process.cwd(),
    stdout: { write: (data: string) => { output(1, data); return true } },
    stderr: { write: (data: string) => { output(2, data); return true } },
    exitCode: 0,
    exit(code: number = fake.exitCode): never { fake.exitCode = code; throw exited },
  }
  const stream = (fd: number) => new Writable({ write(data, _encoding, done) { output(fd, data); done() } })
  const console = new Console({ stdout: stream(1), stderr: stream(2), colorMode: false })
  try {
    const body = source.replace(/^#![^\n]*\n/, '')
    let compiled = bodies.get(body)
    if (!compiled) { compiled = new Function('require', 'process', 'console', body); bodies.set(body, compiled) }
    compiled((name: string) => name === 'node:fs' ? { ...fs, writeSync: output } : require(name), fake, console)
  } catch (error) {
    if (error !== exited) {
      fake.exitCode = 1
      stderr += `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    }
  }
  return { code: fake.exitCode, stdout, stderr, timedOut: false }
}

if (import.meta.main) {
  main(process.argv.slice(2), statefulRun).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
