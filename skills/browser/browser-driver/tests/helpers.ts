// browser-driver 명령 경계 테스트의 공용 helper. 임시 폴더, 가짜 백엔드 실행 파일, 명령 실행, 「명령 경계」 상수를 둔다.
// 이 폴더는 팀 저장소에 tools/browser-driver 로 실려 거기서 테스트가 돈다. 그래서 Node 내장 모듈만 import 한다(modules/testkit 을 쓰지 않는다).
//
// 「명령 경계」 상수(COMMAND)가 구현을 가린다. 테스트 사례는 이 상수만 보고 드라이버를 부르고, 구현을 바꿀 때 이 상수만 바꾼다.
//
// 실제 브라우저는 열지 않는다. 백엔드(ego-browser, orca, cmux, agent-browser)는 PATH 맨 앞의 가짜 실행 파일이고,
// 홈과 설정 폴더는 임시 폴더다. 자식 프로세스의 PATH 는 가짜 폴더 하나(와 필요하면 /usr/bin:/bin)뿐이라 이 머신의 백엔드가 섞이지 않는다.
//
// 가짜 실행 파일은 본문이 하나다. macOS 는 방금 쓴 실행 파일의 첫 실행에 수백 ms 를 쓰고 그 비용이 파일(inode) 단위로 붙으므로,
// 프로세스마다 원본 하나를 쓰고 하드 링크로 건다. 규칙(`<링크>.rules.json`)과 기록(`<링크>.calls.jsonl`)은 링크 경로로 갈린다.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const DRIVER_DIR = realpathSync(join(import.meta.dirname, '..'))

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
const ENTRY_NAME = 'browser_driver.py'
export const COMMAND: string[] = [PYTHON, join(DRIVER_DIR, ENTRY_NAME)]
// 드라이버 폴더를 복사한 사본(설치 캐시 배치 등)의 진입을 부르는 명령
export const commandIn = (dir: string): string[] => [PYTHON, join(dir, ENTRY_NAME)]
// ──

export type Result = { code: number | null; stdout: string; stderr: string }
export type T = { after(fn: () => void): void }

// ── 가짜 실행 파일 ──
// rules: 위에서부터 보고 args 가 argv 에 모두 들어 있는 첫 규칙을 쓴다. args 가 없는 규칙은 늘 맞는다. 맞는 규칙이 없으면 아무것도 내지 않고 0 이다.
//   stdout, stderr, code   낼 것
//   stdoutFile             이 파일의 내용을 stdout 으로 낸다(바이트 그대로)
//   prelude                stdin 으로 받은 스크립트 앞에 붙여 `node --input-type=module` 로 돌리고 그 stdout 을 낸다(ego 용)
// 호출마다 {argv, stdin} 을 calls.jsonl 에 남긴다.
const FAKE_BODY = `const fs = require('node:fs')
const cp = require('node:child_process')
const self = process.argv[1]
const argv = process.argv.slice(2)
const rules = JSON.parse(fs.readFileSync(self + '.rules.json', 'utf8'))
let stdin = ''
if (rules.some((r) => r.readStdin !== false)) {
  try {
    stdin = fs.readFileSync(0, 'utf8')
  } catch {
    stdin = ''
  }
}
fs.appendFileSync(self + '.calls.jsonl', JSON.stringify({ argv, stdin }) + '\\n')
const rule = rules.find((r) => !r.args || r.args.every((a) => argv.includes(a))) || {}
const write = (fd, data) => {
  let buf = Buffer.from(data)
  while (buf.length) {
    try {
      buf = buf.subarray(fs.writeSync(fd, buf))
    } catch (e) {
      if (e.code !== 'EAGAIN') throw e
    }
  }
}
if (rule.prelude !== undefined) {
  const done = cp.spawnSync(process.execPath, ['--input-type=module'], { input: rule.prelude + stdin, encoding: 'utf8' })
  if (done.status !== 0) {
    write(2, done.stderr)
    process.exitCode = done.status ?? 1
  } else write(1, done.stdout)
} else {
  if (rule.stdoutFile) write(1, fs.readFileSync(rule.stdoutFile))
  if (rule.stdout) write(1, rule.stdout)
  if (rule.stderr) write(2, rule.stderr)
  process.exitCode = rule.code ?? 0
}
`

export type FakeRule = { args?: string[]; stdout?: string; stdoutFile?: string; stderr?: string; code?: number; prelude?: string; readStdin?: boolean }
export type FakeCall = { argv: string[]; stdin: string }
export type Fake = { path: string; calls(): FakeCall[]; setRules(rules: FakeRule[]): void }

let store: string | null = null
function storeDir(): string {
  if (!store) {
    store = realpathSync(mkdtempSync(join(tmpdir(), 'bd-bin-')))
    const dir = store
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  return store
}

function linkBody(dir: string, name: string, body: string): string {
  const content = `#!${process.execPath}\n${body}`
  const source = join(storeDir(), createHash('sha256').update(content).digest('hex'))
  if (!existsSync(source)) {
    writeFileSync(source, content)
    chmodSync(source, 0o755)
  }
  const target = join(dir, name)
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { force: true })
  try {
    linkSync(source, target)
  } catch {
    copyFileSync(source, target)
    chmodSync(target, 0o755)
  }
  return target
}

export function fake(dir: string, name: string, rules: FakeRule[] = []): Fake {
  const path = linkBody(dir, name, FAKE_BODY)
  const log = `${path}.calls.jsonl`
  rmSync(log, { force: true })
  const setRules = (next: FakeRule[]) => writeFileSync(`${path}.rules.json`, JSON.stringify(next))
  setRules(rules)
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line)
          .map((line) => JSON.parse(line) as FakeCall)
      : []
  return { path, calls, setRules }
}

// ── 임시 폴더 ──
const folders: string[] = []
process.on('exit', () => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

export function tempDir(t?: T, prefix = 'bd-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  folders.push(dir)
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function write(path: string, text: string | Uint8Array = '', mode = 0o644): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
  return path
}

// 이름을 주지 않은 환경변수는 자식에게 넘기지 않는다(undefined 로 지운다)
export type EnvChange = Record<string, string | undefined>

// ── 샌드박스 ──
// PATH 는 가짜 폴더 하나다. systemPath 가 참이면 /usr/bin:/bin 을 뒤에 붙인다(sh 가 필요한 가짜 파일은 쓰지 않는다)
export class Box {
  readonly root: string
  readonly home: string
  readonly bin: string
  readonly claude: string
  readonly config: string
  systemPath = false
  env: EnvChange

  constructor(t?: T) {
    this.root = tempDir(t)
    this.home = join(this.root, 'home')
    this.bin = join(this.root, 'bin')
    this.claude = join(this.root, 'claude')
    this.config = join(this.root, 'browser.config.json')
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.bin, { recursive: true })
    this.env = {
      HOME: this.home,
      CLAUDE_CONFIG_DIR: this.claude,
      BROWSER_CONFIG: this.config,
      LANG: 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  fake(name: string, rules: FakeRule[] = []): Fake {
    return fake(this.bin, name, rules)
  }

  setConfig(data: unknown): string {
    return write(this.config, typeof data === 'string' ? data : JSON.stringify(data))
  }

  childEnv(extra: EnvChange = {}): NodeJS.ProcessEnv {
    const merged: EnvChange = { ...this.env, PATH: this.bin + (this.systemPath ? `${delimiter}/usr/bin${delimiter}/bin` : ''), ...extra }
    const out: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(merged)) if (value !== undefined) out[key] = value
    return out
  }

  // 드라이버를 부른다. command 를 주면 다른 진입(설치 캐시 사본, 옛 이름 진입)을 부른다
  run(args: string[], extra: EnvChange = {}, opts: { command?: string[]; input?: string; cwd?: string } = {}): Result {
    const argv = [...(opts.command ?? COMMAND), ...args]
    const done = spawnSync(argv[0], argv.slice(1), { env: this.childEnv(extra), cwd: opts.cwd, input: opts.input, encoding: 'utf8', timeout: 60_000 })
    return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' }
  }
}

// ego 가 stdout 에 쓰는 반환값 표식과 업데이트 알림 표식
export const MARKER = '<<<browser-driver-result>>>'
export const NOTICE = '[ego-browser:notice]'
export const egoOut = (value: string): string => `\n${MARKER}\n${value}`

// ── 기록한 출력과 비교 ──
// fixtures/<파일> 은 {키: 출력} JSON 이다. 옛 구현이 낸 글자를 그대로 적어 두고 구현이 바뀌어도 같은 글자가 나오는지 본다.
// UPDATE_GOLDEN=1 로 돌리면 현재 구현의 출력으로 덮어쓴다. 구현을 바꾼 뒤에는 쓰지 않는다(옛 출력이 기준이다).
export function golden(file: string, key: string, actual: string): void {
  const path = join(DRIVER_DIR, 'tests', 'fixtures', file)
  const data: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  if (process.env.UPDATE_GOLDEN === '1') {
    data[key] = actual
    write(path, `${JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : 1))), null, 1)}\n`)
    return
  }
  assert.ok(key in data, `${file} 에 ${key} 가 없다`)
  assert.equal(actual, data[key], key)
}

// 임시 폴더 이름처럼 실행마다 다른 경로를 자리표시자로 바꾼다
export function mask(text: string, ...roots: string[]): string {
  let out = text
  roots.forEach((root, i) => {
    out = out.split(root).join(`<ROOT${i}>`)
  })
  return out
}
