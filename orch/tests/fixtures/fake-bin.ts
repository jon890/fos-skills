// 테스트용 가짜 실행 파일을 만든다. orca, gh, lsof 처럼 외부 명령을 대신한다.
//
// 가짜 실행 파일은 받은 argv 와 고른 환경 변수, 작업 디렉터리를 JSONL 로 기록한다.
// 규칙은 위에서부터 보고, args 에 적은 문자열이 argv 에 모두 들어 있는 첫 규칙의 stdout, stderr, 종료 코드를 낸다.
// args 가 없는 규칙은 늘 맞는다. 맞는 규칙이 없으면 아무것도 내지 않고 0 으로 끝난다.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeRule = { args?: string[]; stdout?: string; stderr?: string; code?: number }
export type FakeCall = { argv: string[]; env: Record<string, string | null>; cwd: string }
export type FakeBin = { path: string; calls: () => FakeCall[]; setRules: (rules: FakeRule[]) => void }

export function fakeBin(dir: string, name: string, rules: FakeRule[], opts: { recordEnv?: string[] } = {}): FakeBin {
  const bin = join(dir, name)
  const rulesFile = join(dir, `${name}.rules.json`)
  const log = join(dir, `${name}.calls.jsonl`)
  // 확장자 없는 실행 파일은 타입 제거 대상이 아니라 타입 문법을 쓰지 않는다.
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const env = {}
for (const key of ${JSON.stringify(opts.recordEnv ?? [])}) env[key] = process.env[key] ?? null
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env, cwd: process.cwd() }) + '\\n')
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(rulesFile)}, 'utf8'))
const rule = rules.find((r) => !r.args || r.args.every((a) => argv.includes(a))) || {}
if (rule.stdout) process.stdout.write(rule.stdout)
if (rule.stderr) process.stderr.write(rule.stderr)
process.exitCode = rule.code ?? 0
`
  const setRules = (next: FakeRule[]) => writeFileSync(rulesFile, JSON.stringify(next))
  setRules(rules)
  writeFileSync(bin, script)
  chmodSync(bin, 0o755)
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line)
          .map((line) => JSON.parse(line) as FakeCall)
      : []
  return { path: bin, calls, setRules }
}
