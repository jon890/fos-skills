// 같은 PC 의 무거운 검사를 FIFO 대기열에서 실행한다.
//
// 사용: heavy-slot.ts [--exclusive] [--slot-dir DIR] [--slots N] -- 명령...
//     옵션은 고유 접두로 줄여 쓸 수 있다. 첫 `--` 나 옵션이 아닌 첫 인자부터가 명령이다
//
// 환경 변수:
//     HEAVY_SLOT_DIR    대기열 폴더. 기본은 주 checkout 의 .orch/state/heavy-slot(lib/paths.ts 의 heavy-slot)
//     HEAVY_SLOTS       자리 수. 기본 3. 같은 slot 폴더는 같은 값을 써야 한다
//     HEAVY_EXCLUSIVE   1 이면 혼자 실행한다(--exclusive 와 같다)
//     HEAVY_POLL        자리와 wait_idle 을 다시 보는 간격(초). 기본 5
//     HEAVY_IDLE_WAIT   wait_idle 로 기다리는 최대 시간(초). 기본 1800
//     MEM_GATE          자리를 잡은 뒤 부르는 메모리 대기. 기본은 같은 폴더의 mem-gate.ts. 메모리를 기다리는 동안도 자리를 쓴다
//     HEAVY_SLOT_HELD   자리를 쥔 heavy-slot 이 명령에 물려준다. 있으면 대기열을 건너뛰고 바로 명령을 실행한다(중첩 호출).
//                       수동으로 설정하지 않는다
//
// 분류: 현재 디렉터리 저장소의 .orch/config.json 의 heavy 절(lib/config.ts 의 HEAVY_KEYS)을 읽는다.
// 값은 JS 정규식 문자열 목록이다(플래그 없음). 설정이 없으면 모든 명령이 normal 이다.
//     1. 명령줄이 `bash -c` 나 `sh -c` 면 그 본문을, 아니면 인자를 공백으로 이은 글자를 본다
//     2. `&&`, `||`, `;`, `|` 로 조각을 나누고, 조각마다 앞의 `time`, `/usr/bin/time`, `/usr/bin/time -l` 과 앞뒤 괄호를 뗀다.
//        공백뿐인 조각은 버린다. 괄호를 뗀 뒤에야 비는 조각(`()` 같은 것)은 남아 light 에 맞지 않는다(옛 heavy-slot.py 와 같다)
//     3. 조각 하나라도 heavy.exclusive 에 맞으면 exclusive. 모든 자리가 빌 때 혼자 실행한다
//     4. 아니면 조각 하나라도 heavy.normal 에 맞으면 normal
//     5. 아니면 모든 조각이 heavy.light 의 정규식 가운데 하나에 맞을 때만 light. 대기열을 거치지 않고 바로 실행한다
//     6. 그 밖은 normal. 자리 하나를 쓴다
//     --exclusive 와 HEAVY_EXCLUSIVE=1 은 분류와 관계없이 exclusive 다.
//     정규식 하나라도 틀리면 등록하기 전에 `heavy-slot: heavy.<키> 의 정규식이 틀렸다: <원문>: <이유>` 를 내고 2 로 끝난다
//
// wait_idle: 대기열에 등록한 뒤, 자리를 잡으려 할 때마다 먼저 `ps -axo pid=,ppid=,command=` 를 읽어
// 명령줄이 heavy.wait_idle 의 정규식 가운데 하나에 맞는 프로세스가 있으면 자리를 잡지 않고 HEAVY_POLL 뒤에 다시 본다.
// 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스를 기다리려는 것이다. 목록이 비어 있으면 ps 를 읽지 않는다.
// 등록한 뒤에 기다리므로 뒤에 온 검사가 앞질러 자리를 잡지 않는다(FIFO).
// 대상에서 빼는 것: 자기 pid 와 그 조상, slot 폴더에 등록된 heavy-slot 프로세스와 그 조상, 그 자손.
// 자기 명령줄이나 이미 자리를 쥔 검사가 정규식에 맞아 서로를 기다리지 않게 한다. 등록된 것의 조상도 빼는 것은
// 두 heavy-slot 을 띄운 상위 셸의 명령줄이 정규식에 맞을 때 둘이 서로의 조상을 기다리며 멈추지 않게 하려는 것이다.
// 맞는 프로세스를 기다린 시간이 모두 HEAVY_IDLE_WAIT 초를 넘으면 stdout 에
// `heavy-slot: wait_idle 대기가 <초>초를 넘었다: <맞은 명령줄 하나>` 를 내고 등록을 지운 뒤 124 로 끝난다.
// ps 를 읽지 못하면 등록을 지우고 1 로 끝난다. ps 가 신호로 죽었고 이 프로세스도 INT 나 TERM 을 받았으면 128+신호 번호다.
//
// 대기열: slot 폴더의 <pid>.json 이 등록 하나다. 등록과 자리 잡기, 반납은 queue.lock 의 flock 아래에서 한다.
// 등록이나 자리 잡기에서 잠금을 기다리는 중에 INT 나 TERM 을 받으면 기다림을 멈추고 128+신호 번호로 끝난다.
// 등록 전이면 지울 등록이 없고, 등록 뒤면 반납할 때 잠금을 다시 기다려 등록을 지운다.
// 끝난 pid 의 등록은 다음 검사에서 회수하고, 정상 종료와 INT, TERM 때는 명령이 끝난 뒤 자리를 반납한다.
// 신호를 받으면 명령의 프로세스 그룹에 TERM 을 보내고 KILL 유예(기본 10초, ORCH_KILL_GRACE_SEC) 뒤에도 살아 있으면 KILL 을 보낸다.
// macOS 에서는 slot 폴더와 명령의 TMPDIR 를 실경로로 푼다. 기본 slot 폴더는 주 checkout 기준이라 워크트리끼리 함께 쓴다.
// 옛 orch 설정이 남아 있고 --slot-dir 도 HEAVY_SLOT_DIR 도 없으면 실행하지 않고 옮기는 명령을 알린다(종료 코드 2).
//
// 종료: 명령의 종료 코드, 2 인자·설정 오류, 1 대기열·메모리 검사 실패, 124 wait_idle 대기 초과, 128+신호 번호,
//       127 명령이 없다, 126 명령을 실행할 수 없다. 대기열을 건너뛰는 명령이 실행 파일 형식이 아니면 1 이다(lib/proc.ts 의 execCommand)
//
// 테스트가 Queue, classify, compileHeavy 를 import 한다. 명령으로 실행했을 때만 main 을 부른다.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, HEAVY_KEYS, loadConfig, section } from './lib/config.ts'
import { killGraceMs } from './lib/env.ts'
import { real, realPath } from './lib/fs.ts'
import { ensure, requireMigrated } from './lib/paths.ts'
import { execCommand, killGroup, run, scriptCommand, signalCode } from './lib/proc.ts'
import { alive } from './lib/process.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const USAGE = '사용법: heavy-slot.ts [--exclusive] [--slot-dir DIR] [--slots N] -- 명령...'
const OPTION_NAMES = ['exclusive', 'slot-dir', 'slots', 'help']
const IDLE_WAIT_SEC = '1800'
const POLL_SEC = '5'

// queue.lock 을 flock 으로 잡는 도우미. Node 에는 flock 이 없어 perl 자식이 잠금을 쥐고 "locked" 를 낸 뒤 stdin 이 닫힐 때까지 기다린다.
// 옛 heavy-slot.py 가 같은 파일에 fcntl.flock 을 걸었으므로, 옮기는 동안 옛 버전과 같은 slot 폴더를 써도 서로를 막는다.
// 이 프로세스가 죽으면 stdin 이 닫혀 도우미도 끝나고 잠금이 풀린다. 도우미는 따로 그룹으로 띄워
// 터미널의 Ctrl-C 가 잠금을 쥔 도중에 도우미만 죽이지 않게 한다.
const LOCK_HELPER = [
  'use Fcntl qw(:flock);',
  'open(my $f, ">>", $ARGV[0]) or die "$ARGV[0]: $!\\n";',
  'flock($f, LOCK_EX) or die "flock $ARGV[0]: $!\\n";',
  '$| = 1; print "locked\\n";',
  'my $rest = <STDIN>;',
].join(' ')

export type Kind = 'exclusive' | 'normal' | 'light'
export type Heavy = Record<'exclusive' | 'normal' | 'light' | 'wait_idle', RegExp[]>
type Row = { pid: number; ticket: number; exclusive: boolean; held: boolean; slots: number }

class Usage extends Error {}
// 잠금을 기다리는 중에 INT 나 TERM 을 받았다. main 이 128+신호 번호로 바꾼다
class Stopped extends Error {}
// ps 가 0 이 아닌 코드로 끝났다. 신호로 죽었는지(128 초과) 보려고 코드를 함께 둔다
class PsFailed extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

// heavy 절을 정규식으로 바꾼다. 값이 문자열 목록이 아니면 ConfigError, 정규식이 틀리면 Usage 다(둘 다 종료 코드 2).
export function compileHeavy(body: Record<string, unknown>): Heavy {
  const heavy: Heavy = { exclusive: [], normal: [], light: [], wait_idle: [] }
  for (const key of HEAVY_KEYS as readonly (keyof Heavy)[]) {
    const value = body[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new ConfigError(`설정 파일의 heavy.${key} 는 정규식 문자열 목록이어야 한다`)
    }
    heavy[key] = value.map((source: string) => {
      try {
        return new RegExp(source)
      } catch (e) {
        throw new Usage(`heavy.${key} 의 정규식이 틀렸다: ${source}: ${(e as Error).message}`)
      }
    })
  }
  return heavy
}

// 명령을 조각으로 나눈다. 옛 heavy-slot.py 의 classify 와 같은 꼴이다.
// 공백뿐인 조각은 괄호를 떼기 전에 버린다. `()` 처럼 괄호를 뗀 뒤에야 비는 조각은 남는다(옛 classify 와 같다).
function parts(argv: string[]): string[] {
  const body = (argv[0] === 'bash' || argv[0] === 'sh') && argv[1] === '-c' ? argv.slice(2).join(' ') : argv.join(' ')
  return body
    .split(/&&|\|\||;|\|/)
    .filter((part) => part.trim())
    .map((part) =>
      part
        .trim()
        .replace(/^(\(?time|\/usr\/bin\/time( -l)?)\s+/, '')
        .replace(/^\(+|\)+$/g, '')
        .trim(),
    )
}

export function classify(argv: string[], heavy: Heavy): Kind {
  const pieces = parts(argv)
  const any = (patterns: RegExp[]) => pieces.some((piece) => patterns.some((pattern) => pattern.test(piece)))
  if (any(heavy.exclusive)) return 'exclusive'
  if (any(heavy.normal)) return 'normal'
  const light = pieces.length > 0 && pieces.every((piece) => heavy.light.some((pattern) => pattern.test(piece)))
  return light ? 'light' : 'normal'
}

// queue.lock 을 잡은 채로 fn 을 부른다. fn 은 동기여야 한다. 도중에 다른 이벤트가 끼어들지 않게 하려는 것이다.
// 기다리는 중에 INT 나 TERM 을 받으면 도우미를 끝내고 Stopped 를 던진다. 신호를 받은 뒤에 부른 잠금(반납)은 끝까지 기다린다.
async function locked<T>(lockFile: string, fn: () => T): Promise<T> {
  const helper = spawn('perl', ['-e', LOCK_HELPER, lockFile], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const closed = new Promise<void>((resolve) => helper.once('close', () => resolve()))
  helper.stdin.on('error', () => {})
  let acquired = false
  let stop: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let out = ''
      let err = ''
      if (!stopSignal) {
        stop = () => {
          if (acquired) return
          reject(new Stopped('queue.lock 을 기다리는 중에 멈췄다'))
          helper.kill('SIGTERM')
        }
        wakers.add(stop)
      }
      helper.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
        if (out.includes('locked\n')) {
          acquired = true
          resolve()
        }
      })
      helper.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8')
      })
      helper.once('error', (e: Error) => reject(new Error(`queue.lock 을 잡을 perl 을 띄우지 못했다: ${e.message}`)))
      helper.once('exit', (code) => reject(new Error(`queue.lock 을 잡지 못했다(perl 종료 코드 ${code}): ${err.trim()}`)))
    })
    return fn()
  } finally {
    if (stop) wakers.delete(stop)
    helper.stdin.end()
    if (helper.pid !== undefined) await closed
  }
}

// 하나의 파일 잠금 아래 등록과 선점을 처리해 pid 기록이 중간에 드러나지 않는다.
export class Queue {
  readonly root: string
  readonly slots: number
  readonly pid: number
  readonly entry: string
  private readonly isAlive: (pid: number) => boolean
  // 등록 파일을 쓰려 했는지. 쓰기 전에 멈췄으면 반납할 때 잠금을 기다리지 않는다
  private written = false

  constructor(root: string, slots: number, opts: { pid?: number; alive?: (pid: number) => boolean } = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.root = real(root)
    this.slots = slots
    this.pid = opts.pid ?? process.pid
    this.isAlive = opts.alive ?? alive
    this.entry = join(this.root, `${this.pid}.json`)
  }

  private lock<T>(fn: () => T): Promise<T> {
    return locked(join(this.root, 'queue.lock'), fn)
  }

  // 등록된 pid. 등록 파일을 읽지 않고 이름만 본다. wait_idle 이 대상에서 뺄 프로세스를 고를 때 쓴다
  registeredPids(): number[] {
    return readdirSync(this.root)
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number(name.slice(0, -'.json'.length)))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  // 잠금 아래에서만 부른다. 끝난 pid 의 등록은 지운다.
  private rows(): Row[] {
    const rows: Row[] = []
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue
      const stem = name.slice(0, -'.json'.length)
      if (!/^\d+$/.test(stem)) throw new Error(`queue entry name is not a pid: ${join(this.root, name)}`)
      const pid = Number(stem)
      const file = join(this.root, name)
      if (!this.isAlive(pid)) {
        rmSync(file, { force: true })
        continue
      }
      const row = JSON.parse(readFileSync(file, 'utf8')) as Row
      if (row === null || typeof row !== 'object') throw new Error(`queue entry is not an object: ${file}`)
      for (const key of ['pid', 'ticket', 'slots'] as const) {
        if (typeof row[key] !== 'number') throw new Error(`queue entry has no ${key}: ${file}`)
      }
      for (const key of ['exclusive', 'held'] as const) {
        if (typeof row[key] !== 'boolean') throw new Error(`queue entry has no ${key}: ${file}`)
      }
      if (row.pid !== pid) throw new Error(`queue PID mismatch: ${file}`)
      rows.push(row)
    }
    return rows.sort((a, b) => a.ticket - b.ticket || a.pid - b.pid)
  }

  register(exclusive: boolean): Promise<void> {
    return this.lock(() => {
      if (this.rows().some((row) => row.slots !== this.slots)) throw new Error('active queue uses a different HEAVY_SLOTS value')
      // 옛 heavy-slot.py 의 time.time_ns() 와 같은 단위(ns)다. 같은 폴더의 옛 등록과 순서를 비교한다.
      // 값이 2^53 을 넘어 double 로는 수백 ns 단위로만 갈린다. 같은 값이 되면 rows 가 pid 로 순서를 다시 정한다
      const ticket = Math.round((performance.timeOrigin + performance.now()) * 1e6)
      const row: Row = { pid: this.pid, ticket, exclusive, held: false, slots: this.slots }
      this.written = true
      writeFileSync(this.entry, JSON.stringify(row))
    })
  }

  claim(): Promise<boolean> {
    return this.lock(() => {
      const rows = this.rows()
      const own = rows.find((row) => row.pid === this.pid)
      if (!own) throw new Error(`queue entry is missing: ${this.entry}`)
      const held = rows.filter((row) => row.held)
      const waiting = rows.filter((row) => !row.held)
      const index = waiting.indexOf(own)
      if (index < 0) throw new Error(`queue entry already holds a slot: ${this.entry}`)
      const ahead = waiting.slice(0, index)
      if (held.some((row) => row.exclusive)) return false
      const ready = own.exclusive
        ? held.length === 0 && ahead.length === 0
        : !ahead.some((row) => row.exclusive) && ahead.length < this.slots - held.length
      if (ready) {
        own.held = true
        writeFileSync(this.entry, JSON.stringify(own))
      }
      return ready
    })
  }

  // 잠금을 잡지 못해도 자기 등록은 지운다. 남겨 두면 이 pid 가 끝날 때까지 뒤의 검사가 기다린다
  async cleanup(): Promise<void> {
    if (!this.written) return
    try {
      await this.lock(() => rmSync(this.entry, { force: true }))
    } catch {
      rmSync(this.entry, { force: true })
    }
  }
}

// 명령줄이 patterns 에 맞는 프로세스 하나의 명령줄. 없으면 null. ps 를 읽지 못하면 PsFailed 다.
function busyProcess(patterns: RegExp[], registered: number[]): string | null {
  const done = run(['ps', '-axo', 'pid=,ppid=,command='])
  if (done.code !== 0) throw new PsFailed(done.code, `프로세스 목록을 읽지 못했다(ps 종료 코드 ${done.code}): ${done.stderr.trim()}`)
  const rows: { pid: number; ppid: number; command: string }[] = []
  for (const line of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] })
  }
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]))
  const children = new Map<number, number[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid])
  const skip = new Set<number>()
  // 자기와 등록된 heavy-slot 의 조상. 이미 본 pid 에서 멈춰 ppid 가 고리를 이루어도 끝난다
  const up = new Set<number>()
  for (const start of [process.pid, ...registered]) {
    for (let pid: number | undefined = start; pid !== undefined && !up.has(pid); pid = parent.get(pid)) {
      up.add(pid)
      skip.add(pid)
    }
  }
  // 등록된 heavy-slot 과 그 자손. 자기도 등록돼 있으므로 ps 같은 자기 자식도 여기서 빠진다
  const seen = new Set<number>()
  const stack = [...registered]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    skip.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  const found = rows.find((row) => !skip.has(row.pid) && patterns.some((pattern) => pattern.test(row.command)))
  return found ? found.command : null
}

function seconds(name: string, fallback: string): number {
  const text = process.env[name] ?? fallback
  const value = Number(text)
  if (text.trim() === '' || !Number.isFinite(value) || value < 0) throw new Error(`${name} 는 0 이상의 초여야 한다: ${text}`)
  return value
}

type Parsed = { exclusive: boolean; slotDir?: string; slots: number; command: string[] }

function parse(argv: string[]): Parsed | 'help' {
  let exclusive = false
  let slotDir = process.env.HEAVY_SLOT_DIR || undefined
  let slotsText = process.env.HEAVY_SLOTS ?? '3'
  let i = 0
  for (; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      i++
      break
    }
    if (token === '-h') return 'help'
    if (!token.startsWith('-') || token === '-') break
    if (!token.startsWith('--')) throw new Usage(`모르는 옵션: ${token}`)
    const eq = token.indexOf('=')
    const given = eq >= 0 ? token.slice(2, eq) : token.slice(2)
    const matches = OPTION_NAMES.includes(given) ? [given] : OPTION_NAMES.filter((name) => name.startsWith(given))
    if (matches.length > 1) throw new Usage(`--${given} 이 여러 옵션의 접두다: ${matches.map((name) => `--${name}`).join(', ')}`)
    if (matches.length === 0) throw new Usage(`모르는 옵션: ${token}`)
    const name = matches[0]
    if (name === 'help') return 'help'
    if (name === 'exclusive') {
      if (eq >= 0) throw new Usage('--exclusive 는 값을 받지 않는다')
      exclusive = true
      continue
    }
    let value: string
    if (eq >= 0) value = token.slice(eq + 1)
    else if (i + 1 < argv.length) value = argv[++i]
    else throw new Usage(`--${name} 에 값이 필요하다`)
    if (name === 'slot-dir') slotDir = value
    else slotsText = value
  }
  if (!/^\s*[+-]?\d+\s*$/.test(slotsText)) throw new Usage(`--slots 는 정수여야 한다: ${slotsText}`)
  const slots = Number(slotsText)
  const command = argv.slice(i)
  if (command.length === 0 || slots < 1) throw new Usage('a command and positive slot count are required')
  return { exclusive, slotDir, slots, command }
}

// 신호 처리 ---------------------------------------------------------------

let stopSignal: NodeJS.Signals | null = null
let running: ChildProcess | null = null
let killTimer: NodeJS.Timeout | undefined
const wakers = new Set<() => void>()

function onSignal(signal: NodeJS.Signals): void {
  if (stopSignal) return
  stopSignal = signal
  for (const wake of wakers) wake()
  // 명령이 정말 멈출 때까지 자리를 쥔다. 그룹 전체에 TERM 을 보내고 KILL 유예 뒤에도 남았으면 KILL 을 보낸다
  const pid = running?.pid
  if (pid !== undefined) {
    killGroup(pid, 'SIGTERM')
    killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), killGraceMs())
  }
}

function stopCode(): number {
  return 128 + ((constants.signals as Record<string, number>)[stopSignal as string] ?? 0)
}

// 신호가 오면 바로 깬다
function pause(ms: number): Promise<void> {
  if (stopSignal) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      wakers.delete(done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    wakers.add(done)
  })
}

// 명령을 새 세션(그룹)으로 띄우고 끝날 때까지 기다린다. 표준 입출력은 물려준다.
function runChild(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true, env })
    child.once('error', (e: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return
      running = null
      if (e.code === 'ENOENT') {
        process.stderr.write(`heavy-slot: command not found: ${argv[0]}\n`)
        resolve(127)
      } else if (e.code === 'EACCES') {
        process.stderr.write(`heavy-slot: command is not executable: ${argv[0]}\n`)
        resolve(126)
      } else {
        process.stderr.write(`heavy-slot: ${e.message}\n`)
        resolve(1)
      }
    })
    child.once('exit', (code, signal) => {
      running = null
      clearTimeout(killTimer)
      resolve(signal ? signalCode(signal) : (code ?? 1))
    })
    running = child
  })
}

async function waitAndRun(queue: Queue, exclusive: boolean, heavy: Heavy, command: string[]): Promise<number> {
  const pollMs = seconds('HEAVY_POLL', POLL_SEC) * 1000
  const idleLimit = seconds('HEAVY_IDLE_WAIT', IDLE_WAIT_SEC)
  await queue.register(exclusive)
  let busyMs = 0
  for (;;) {
    if (stopSignal) return stopCode()
    let busy: string | null = null
    if (heavy.wait_idle.length > 0) {
      try {
        busy = busyProcess(heavy.wait_idle, queue.registeredPids())
      } catch (e) {
        if (!(e instanceof PsFailed) || e.code <= 128) throw e
        // 터미널의 Ctrl-C 는 ps 를 포함한 그룹 전체에 간다. ps 를 동기로 기다리는 동안은 신호 처리기가 돌지 못하므로
        // 처리기가 돌 틈을 준 뒤 이 프로세스도 신호를 받았는지 본다. 받았으면 pause 가 바로 깬다
        await pause(100)
        if (stopSignal) return stopCode()
        throw e
      }
    }
    if (busy !== null) {
      if (busyMs >= idleLimit * 1000) {
        process.stdout.write(`heavy-slot: wait_idle 대기가 ${idleLimit}초를 넘었다: ${busy}\n`)
        return 124
      }
      process.stderr.write(`heavy-slot: waiting for idle: ${busy}\n`)
      const started = Date.now()
      await pause(pollMs)
      busyMs += Date.now() - started
      continue
    }
    if (await queue.claim()) break
    if (stopSignal) return stopCode()
    process.stderr.write('heavy-slot: waiting\n')
    await pause(pollMs)
  }
  if (stopSignal) return stopCode()
  const gate = process.env.MEM_GATE || join(HERE, 'mem-gate.ts')
  const gateCode = await runChild(scriptCommand(gate, []), process.env)
  if (stopSignal) return stopCode()
  if (gateCode) return gateCode
  const code = await runChild(command, { ...process.env, HEAVY_SLOT_HELD: String(process.pid) })
  return stopSignal ? stopCode() : code
}

async function main(argv: string[]): Promise<number> {
  let args: Parsed | 'help'
  try {
    args = parse(argv)
  } catch (e) {
    if (!(e instanceof Usage)) throw e
    process.stderr.write(`${USAGE}\nheavy-slot: error: ${e.message}\n`)
    return 2
  }
  if (args === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (process.platform === 'darwin') process.env.TMPDIR = `${realPath(process.env.TMPDIR || '/tmp')}/`
  if (process.env.HEAVY_SLOT_HELD) return execCommand(args.command, 'heavy-slot')
  let heavy: Heavy
  try {
    heavy = compileHeavy(section(loadConfig(process.cwd()), 'heavy', HEAVY_KEYS))
  } catch (e) {
    if (!(e instanceof ConfigError || e instanceof Usage)) throw e
    process.stderr.write(`heavy-slot: ${e.message}\n`)
    return 2
  }
  const kind = classify(args.command, heavy)
  const exclusive = args.exclusive || process.env.HEAVY_EXCLUSIVE === '1' || kind === 'exclusive'
  if (!exclusive && kind === 'light') return execCommand(args.command, 'heavy-slot')
  if (!args.slotDir && !requireMigrated(process.cwd(), 'heavy-slot', '--slot-dir 로 공유할 대기열을 직접 준다')) return 2
  const queue = new Queue(args.slotDir || ensure('heavy-slot', process.cwd()), args.slots)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    return await waitAndRun(queue, exclusive, heavy, args.command)
  } catch (e) {
    if (e instanceof Stopped) return stopCode()
    throw e
  } finally {
    await queue.cleanup()
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e: Error) => {
      process.stderr.write(`heavy-slot: ${e.message}\n`)
      process.exitCode = 1
    },
  )
}
