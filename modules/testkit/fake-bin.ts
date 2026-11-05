// 테스트용 가짜 실행 파일. orca, gh, lsof 처럼 외부 명령을 대신한다. node:test 를 import 하지 않는다.
//
// macOS 는 방금 쓴 실행 파일의 첫 실행에 220~690ms 를 쓰고 그 비용은 파일(inode) 단위로 붙는다.
// 그래서 본문에 테스트별 경로를 넣지 않고(내용이 종류마다 하나), 프로세스마다 원본 하나를 쓴 뒤 하드 링크로 건다.
// 규칙과 기록 파일은 링크 경로(`process.argv[1]`)에서 이름을 만든다.
//
// 규칙은 위에서부터 보고, args 에 적은 문자열이 argv 에 모두 들어 있는 첫 규칙의 stdout, stderr, 종료 코드를 낸다.
// args 가 없는 규칙은 늘 맞는다. 맞는 규칙이 없으면 아무것도 내지 않고 0 으로 끝난다.
// 가짜 경로에 직접 쓰면 원본이 바뀌어 모든 링크가 함께 바뀐다. 그런 테스트는 이 모듈을 쓰지 않는다.

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type FakeRule = { args?: string[]; stdout?: string; stderr?: string; code?: number }
export type FakeCall = { argv: string[]; env: Record<string, string | null>; cwd: string }
export type FakeBin = { path: string; calls(): FakeCall[]; setRules(rules: FakeRule[]): void }

// 규칙 고르기의 원본. 가짜 실행 파일의 본문(RULES_BODY)이 같은 식을 문자열로 갖는다
export function matchRule(rules: FakeRule[], args: string[]): FakeRule | undefined {
  return rules.find((r) => !r.args || r.args.every((a) => args.includes(a)))
}

// 확장자 없는 실행 파일은 타입 제거 대상이 아니라 타입 문법을 쓰지 않는다
const RULES_BODY = `const fs = require('node:fs')
const argv = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(process.argv[1] + '.rules.json', 'utf8'))
const env = {}
for (const key of config.recordEnv) env[key] = process.env[key] ?? null
fs.appendFileSync(process.argv[1] + '.calls.jsonl', JSON.stringify({ argv, env, cwd: process.cwd() }) + '\\n')
const rule = config.rules.find((r) => !r.args || r.args.every((a) => argv.includes(a))) || {}
// 파이프가 비동기인 macOS 에서 끝나기 전에 다 나가도록 동기로 쓴다
const write = (fd, text) => {
  let buf = Buffer.from(text)
  while (buf.length) {
    try {
      buf = buf.subarray(fs.writeSync(fd, buf))
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e
    }
  }
}
if (rule.stdout) write(1, rule.stdout)
if (rule.stderr) write(2, rule.stderr)
process.exitCode = rule.code ?? 0
`

let store: string | null = null

function storeDir(): string {
  if (!store) {
    store = realpathSync(mkdtempSync(join(tmpdir(), 'testkit-bin-')))
    const dir = store
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  return store
}

// 같은 본문은 같은 원본(같은 inode)에 건다. 원본에는 처음 한 번만 쓴다
export function linkBin(dir: string, name: string, body: string): string {
  const content = `#!${process.execPath}\n${body}`
  const source = join(storeDir(), createHash('sha256').update(content).digest('hex'))
  if (!existsSync(source)) {
    writeFileSync(source, content)
    chmodSync(source, 0o755)
  }
  const target = join(dir, name)
  mkdirSync(dir, { recursive: true })
  rmSync(target, { force: true })
  try {
    linkSync(source, target)
  } catch {
    // 다른 장치 등으로 링크할 수 없으면 복사한다. 첫 실행 검사를 내지만 동작은 같다
    copyFileSync(source, target)
    chmodSync(target, 0o755)
  }
  return target
}

export function fakeBin(dir: string, name: string, rules: FakeRule[], opts: { recordEnv?: string[] } = {}): FakeBin {
  const bin = linkBin(dir, name, RULES_BODY)
  const rulesFile = `${bin}.rules.json`
  const log = `${bin}.calls.jsonl`
  const recordEnv = opts.recordEnv ?? []
  const setRules = (next: FakeRule[]) => writeFileSync(rulesFile, JSON.stringify({ rules: next, recordEnv }))
  setRules(rules)
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line)
          .map((line) => JSON.parse(line) as FakeCall)
      : []
  return { path: bin, calls, setRules }
}
