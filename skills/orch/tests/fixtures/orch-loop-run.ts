// 루프의 프로세스 격리는 유지하고 gh/orca/ps 의 CommonJS 가짜 본문만 함수로 실행한다.
// argv/env/cwd, 출력과 종료만 제공한다. 신호·지연·자식 생명주기와 ESM 스크립트는 실제 실행을 쓴다.
// 함수 본문은 동기 실행과 절대 파일 경로만 지원한다. 비동기 출력·상대 경로 파일 접근은 runProcess 로 직접 검증한다.
// fs 가로채기는 require('node:fs') 에만 적용한다. 다른 모듈은 실제 require 를 쓴다.
import * as fs from 'node:fs'
import { Console } from 'node:console'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { main } from '../../scripts/loop/orch-loop.ts'
import { runProcess } from '../../scripts/lib/proc.ts'
import type { RunOptions, RunResult } from '../../scripts/lib/proc.ts'

const require = createRequire(import.meta.url)
const bodies = new Map<string, Function>()

export function statefulRun(argv: string[], opts: RunOptions = {}): RunResult {
  const env = { ...process.env, ...opts.env }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  const allowed = [env.GH, env.ORCA, env.PS].filter(Boolean)
  if (!allowed.includes(argv[0])) return runProcess(argv, opts)
  if (!isAbsolute(argv[0])) return runProcess(argv, opts)
  let source: string
  try {
    fs.accessSync(argv[0], fs.constants.X_OK)
    source = fs.readFileSync(argv[0], 'utf8')
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
    argv: [process.execPath, ...argv], env,
    cwd: () => opts.cwd ?? process.cwd(),
    stdout: { write: (data: string) => { output(1, data); return true } },
    stderr: { write: (data: string) => { output(2, data); return true } },
    exitCode: 0,
    exit(code: number = fake.exitCode): never { fake.exitCode = code; throw exited },
  }
  const stream = (fd: number) => new Writable({ write(data, _encoding, done) { output(fd, data); done() } })
  const console = new Console({ stdout: stream(1), stderr: stream(2), colorMode: false })
  try {
    if (argv[0] === env.ORCA && env.FAKE_DIR && fs.existsSync(`${env.FAKE_DIR}/orca.json`)) {
      const state = JSON.parse(fs.readFileSync(`${env.FAKE_DIR}/orca.json`, 'utf8'))
      if (state.sleep || state.slow_run_current) return runProcess(argv, opts)
    }
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

const SELF = fileURLToPath(import.meta.url)
if (import.meta.main || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === SELF)) {
  main(process.argv.slice(2), statefulRun, SELF).then(
    (code) => { process.exitCode = code },
    (error) => { console.error(error); process.exitCode = 1 },
  )
}
