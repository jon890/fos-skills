// 함수 평가에는 timeoutMs·input·maxBuffer 를 적용하지 않는다.
// 지연·입력·출력 한도를 검증하는 가짜는 resolveCommand 에서 undefined 를 돌려 실제 실행으로 넘긴다.
// 동기 CommonJS 가짜 실행 파일만 같은 프로세스에서 평가한다.
// 허용 목록·PATH 해석·실제 실행 조건은 호출자가 정한다.
// argv/env/cwd, console·writeSync 출력과 exitCode/exit 만 지원한다.
// 비동기 출력·신호·자식 생명주기·상대 파일 접근은 실제 실행으로 검증해야 한다.
// require('node:fs') 의 writeSync 만 가로채며 나머지 모듈은 실제 require 다.
import * as fs from 'node:fs'
import { Console } from 'node:console'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import { runProcess } from '../../scripts/lib/proc.ts'
import type { RunOptions, Runner } from '../../scripts/lib/proc.ts'

const require = createRequire(import.meta.url)
const bodies = new Map<string, Function>()
type Options = {
  resolveCommand: (argv: string[], env: NodeJS.ProcessEnv) => string | undefined
}

export function createStatefulRun(options: Options): Runner {
  return (argv: string[], opts: RunOptions = {}) => {
    const env = { ...process.env, ...opts.env }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    const command = options.resolveCommand(argv, env)
    if (!command) return runProcess(argv, opts)
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
}
