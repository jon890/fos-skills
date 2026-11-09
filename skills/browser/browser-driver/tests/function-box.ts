// 함수 main으로 명령을 실행하되 CLI Box와 같은 파일·규칙·호출 기록을 쓴다.
// 동기 CommonJS 가짜만 평가한다. prelude(비동기 ego 스크립트), 별도 진입·cwd·입력은 실제 자식이다.
// timeout·신호·출력 한도·자식 생명주기는 함수 평가로 보증하지 않는다.
// argv/env와 fd 입출력·exitCode만 제공하고, 본문 예외는 종료 코드 1로 바꾼다.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { main } from '../browser_driver.ts'
import { Box, type EnvChange, type Result, type FakeRule } from './helpers.ts'

const require = createRequire(import.meta.url)
const bodies = new Map<string, Function>()

export class FunctionBox extends Box {
  // 같은 Box에서 CLI 결과를 대조할 때 사용한다.
  cli(args: string[], extra: EnvChange = {}): Result { return super.run(args, extra) }

  override run(args: string[], extra: EnvChange = {}, opts: { command?: string[]; input?: string; cwd?: string } = {}): Result {
    if (opts.command || opts.input !== undefined || opts.cwd) return super.run(args, extra, opts)
    let stdout = ''
    let stderr = ''
    const env = this.childEnv(extra)
    const spawn: typeof spawnSync = ((command: string, argv: string[], options: any) => {
      const file = isAbsolute(command) ? command : join(this.bin, command)
      // 허용된 fixture 실행 파일만 평가한다. prelude는 실제 Node 자식에서 실행한다.
      let source: string
      try {
        if (!file.startsWith(`${this.bin}/`)) return spawnSync(command, argv, options)
        fs.accessSync(file, fs.constants.X_OK)
        source = fs.readFileSync(file, 'utf8')
        const rules: FakeRule[] = JSON.parse(fs.readFileSync(`${file}.rules.json`, 'utf8'))
        if (rules.some((rule) => rule.prelude !== undefined)) return spawnSync(command, argv, options)
      } catch { return spawnSync(command, argv, options) }
      if (!source.startsWith(`#!${process.execPath}\n`)) return spawnSync(command, argv, options)
      const chunks: Buffer[][] = [[], []]
      const exit = Symbol('exit')
      const fake = {
        argv: [process.execPath, file, ...argv], env: options.env,
        exitCode: 0,
        exit(code = fake.exitCode): never { fake.exitCode = code; throw exit },
      }
      const writeSync = (fd: number, data: string | Uint8Array) => {
        if (fd !== 1 && fd !== 2) throw new Error(`지원하지 않는 fd: ${fd}`)
        const bytes = Buffer.from(data)
        chunks[fd - 1].push(bytes)
        return bytes.length
      }
      const readFileSync = (file: any, ...rest: any[]) => file === 0
        ? (options.input ?? '')
        : (fs.readFileSync as Function)(file, ...rest)
      try {
        let body = bodies.get(source)
        if (!body) {
          body = new Function('require', 'process', source.replace(/^#![^\n]*\n/, ''))
          bodies.set(source, body)
        }
        body((name: string) => name === 'node:fs' ? { ...fs, readFileSync, writeSync } : require(name), fake)
      } catch (error) {
        if (error !== exit) {
          fake.exitCode = 1
          chunks[1].push(Buffer.from(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`))
        }
      }
      return { status: fake.exitCode, signal: null, stdout: Buffer.concat(chunks[0]), stderr: Buffer.concat(chunks[1]) }
    }) as typeof spawnSync
    const code = main(args, {
      env, spawn,
      write(fd, text) { if (fd === 1) stdout += text; else stderr += text },
    })
    return { code, stdout, stderr }
  }
}
