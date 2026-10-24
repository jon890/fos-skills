// 상주 루프(orch-loop.ts)의 상태 판정 한 벌이다. 루프 상태 읽기, 생존 판정, 알림 파일과 커서를 이 모듈 한 곳이 소유한다.
// 사용처: orch-loop.ts(쓰는 쪽과 --status), wait-important.ts(--loop-repo 로 깨어나기), orch-doctor.ts(session-resume 의 loop_alive).
// 파일 형식은 docs/data-schema.md 「orch 루트에 더하는 파일」 이 정한다. 경로는 모두 <orch 루트>/state/ 아래다.
//
//   loop.json            루프 상태. 루프의 부모 프로세스만 쓴다(옆 파일에 쓰고 rename)
//   loop.lock            한 저장소에 루프 하나. orch-loop.ts --foreground 가 쥔다
//   loop-events.jsonl    코디네이터를 깨워야 하는 알림. 한 줄에 {"seq", "time", "kind", "pr", "text"}. text 는 kind 를 뺀 나머지다
//   loop-events.cursor   읽는 쪽이 마지막으로 읽은 seq 하나
//
// 생존(loopStatus): loop.json 이 있고, pid 가 살아 있고(lib/process.ts 의 alive), alive_at 이 now 에서 max(3 × tick_sec, 120) 초 안이면
//   살아 있다. tick_sec 은 loop.json 에 루프가 적은 값이다. last_tick 은 상태 보고용이고 판정에 쓰지 않는다.
//   틱 하나가 길어도(정리의 --wait, 끝난 dispatch 이어 쓰기) 부모가 틱과 따로 alive_at 을 쓰므로 죽은 것으로 보지 않는다.
//   죽은 이유는 `없음`(파일이 없거나 깨졌다), `pid <n> 종료`, `alive_at <시각> 이후 응답 없음` 가운데 하나다.
//   alive_at 만 오래됐고 pid 가 살아 있는 루프 프로세스(isLoopProcess 가 true 나 null)면 recheck: true 를 붙인다. 잠들었다 깬 macOS 에서는
//   루프의 생존 타이머가 아직 alive_at 을 쓰지 못했을 수 있다. 판정은 동기라 기다리지 않는다. 부르는 쪽(wait-important, doctor)이
//   recheckMs() 를 기다린 뒤 한 번 더 부르고, 그때도 죽었으면 죽음으로 낸다.
//   recheckMs 는 생존 타이머 간격(ORCH_LOOP_ALIVE_SEC, 양수 초, 기본 30. 양수가 아니면 기본값)에 여유 5초를 더한 값이다.
//   간격은 부르는 쪽의 환경 변수로 읽는다. 루프는 그 값을 loop.json 에 적지 않는다.
//
// 루프 프로세스(isLoopProcess): pid 가 살아 있고 `ps -o command=` 의 명령줄에 orch-loop 가 들어 있으면 true 다.
//   죽은 루프의 pid 를 다른 프로세스가 다시 받았으면 그 프로세스를 루프로 보지 않는다(false).
//   pid 가 살아 있는데 ps 가 0 이 아닌 코드로 끝나거나 실행되지 않으면 판정할 수 없어 null 이다. 부르는 쪽은 null 을 루프 프로세스로
//   다룬다(잠금을 회수하지 않고, recheck 를 붙인다). 루프가 아니라고 잘못 보면 살아 있는 루프의 잠금을 빼앗아 루프가 둘이 된다.
//   ps 가 실패한 사이 pid 가 죽었으면 false 다.
//
// 알림 파일(appendEvent, readEvents):
//   - 한 때에 쓰는 쪽은 하나다(틱 자식, 또는 틱 자식이 끝난 뒤의 부모). 그래서 잠금이 없다.
//     쓰는 프로세스가 틱마다 바뀌므로 부를 때마다 파일의 마지막 seq 와 커서 값 가운데 큰 것의 다음 값을 새 seq 로 쓴다.
//     파일을 잘라 내거나 지운 뒤에도 seq 가 되돌아가 새 알림이 커서 뒤에 숨지 않게 하기 위해서다
//   - 더한 뒤 줄이 1000 줄을 넘으면 마지막 1000 줄만 옆 파일에 써서 rename 으로 바꾼다. 읽는 쪽은 rename 전이나 뒤의 온전한 파일 하나를 읽는다
//   - 읽는 쪽은 seq 가 커서보다 큰 줄만 낸다. 파일의 첫 seq 가 커서의 다음 값보다 크면 그 사이를 gap 으로 낸다.
//     읽지 않은 줄이 1000 줄을 넘어 잘린 경우다. 읽는 것만으로는 커서를 옮기지 않는다. 낸 뒤 writeCursor 로 옮긴다
//   - 커서 파일이 없거나 정수가 아니면 0 이다. 깨진 커서로 멈추면 알림을 다시 받을 길이 없어서다(대신 남은 줄을 다시 낸다)
//   - JSON 으로 읽지 못한 줄(쓰다 끊긴 줄)은 건너뛴다

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeParent, pathOf } from './paths.ts'
import { run } from './proc.ts'
import { alive } from './process.ts'

export const EVENTS_LIMIT = 1000
const DEFAULT_TICK_SEC = 300
const MIN_DEAD_SEC = 120
export const DEFAULT_ALIVE_SEC = 30
const RECHECK_MARGIN_SEC = 5

export type LoopState = {
  pid: number
  run: string | null
  repo: string
  tick_sec: number
  started_at: string
  alive_at: string
  last_tick: string | null
  ticks: number
  errors: Record<string, string | null>
  [key: string]: unknown
}
export type LoopStatus = { alive: true; state: LoopState } | { alive: false; reason: string; recheck?: true }
export type LoopEvent = { seq: number; time: string; kind: string; pr: number | null; text: string }

export function loopFile(repo: string): string {
  return join(pathOf('state', repo), 'loop.json')
}

export function eventsFile(repo: string): string {
  return join(pathOf('state', repo), 'loop-events.jsonl')
}

export function cursorFile(repo: string): string {
  return join(pathOf('state', repo), 'loop-events.cursor')
}

export function lockFile(repo: string): string {
  return join(pathOf('state', repo), 'loop.lock')
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

// 옆 파일에 쓰고 바꾼다. 쓰는 도중에 끊겨도 읽는 쪽이 반쯤 쓴 파일을 보지 않는다.
// 폴더 만들기와 git 무시(makeParent)는 파일이 처음 생길 때만 한다. 생존 타이머가 쓸 때마다 git 을 부르지 않게 한다
function replace(file: string, content: string, repo: string): void {
  if (!existsSync(file)) makeParent(file, repo)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, file)
}

export function readLoop(repo: string): LoopState | null {
  let parsed: unknown
  try {
    const raw = readText(loopFile(repo))
    if (raw === null) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as LoopState
}

// loop.json 을 쓴다. 루프의 부모 프로세스만 부른다(머리 주석).
export function writeLoop(repo: string, state: LoopState): void {
  replace(loopFile(repo), `${JSON.stringify(state, null, 1)}\n`, repo)
}

// 머리 주석의 「루프 프로세스」
export function isLoopProcess(pid: number): boolean | null {
  if (!alive(pid)) return false
  const done = run(['ps', '-o', 'command=', '-p', String(pid)], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return alive(pid) ? null : false
  return done.stdout.includes('orch-loop')
}

// 머리 주석의 「생존」. 다시 판정하기 전에 기다릴 ms
export function recheckMs(): number {
  const raw = Number(process.env.ORCH_LOOP_ALIVE_SEC)
  const sec = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ALIVE_SEC
  return (sec + RECHECK_MARGIN_SEC) * 1000
}

// now 는 epoch ms 다.
export function loopStatus(repo: string, now: number): LoopStatus {
  const state = readLoop(repo)
  if (!state) return { alive: false, reason: '없음' }
  const pid = Number(state.pid)
  if (!alive(pid)) return { alive: false, reason: `pid ${String(state.pid)} 종료` }
  const tick = typeof state.tick_sec === 'number' && Number.isFinite(state.tick_sec) && state.tick_sec > 0 ? state.tick_sec : DEFAULT_TICK_SEC
  const at = typeof state.alive_at === 'string' ? Date.parse(state.alive_at) : Number.NaN
  if (!Number.isFinite(at) || now - at > Math.max(3 * tick, MIN_DEAD_SEC) * 1000) {
    const reason = `alive_at ${String(state.alive_at ?? '-')} 이후 응답 없음`
    return isLoopProcess(pid) !== false ? { alive: false, reason, recheck: true } : { alive: false, reason }
  }
  return { alive: true, state }
}

function parseLines(raw: string | null): LoopEvent[] {
  const rows: LoopEvent[] = []
  for (const line of (raw ?? '').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as LoopEvent
      if (row && typeof row === 'object' && Number.isInteger(row.seq)) rows.push(row)
    } catch {
      // 쓰다 끊긴 줄이다. 건너뛴다
    }
  }
  return rows
}

function cursorAt(file: string): number {
  let raw: string | null
  try {
    raw = readText(file)
  } catch {
    return 0
  }
  const text = (raw ?? '').trim()
  return /^\d+$/.test(text) ? Number(text) : 0
}

export function readCursor(repo: string): number {
  return cursorAt(cursorFile(repo))
}

export function writeCursor(repo: string, seq: number): void {
  replace(cursorFile(repo), `${seq}\n`, repo)
}

// 알림 한 줄을 더하고 그 줄을 돌려준다. pr 은 PR 번호이고 없으면 null 이다.
// 상태 폴더는 한 번만 구한다. pathOf 는 부를 때마다 git 으로 주 checkout 을 찾는다.
export function appendEvent(repo: string, kind: string, pr: number | null, text: string): LoopEvent {
  const dir = pathOf('state', repo)
  const file = join(dir, 'loop-events.jsonl')
  const raw = readText(file)
  const rows = parseLines(raw)
  const last = rows.reduce((max, row) => Math.max(max, row.seq), 0)
  const event: LoopEvent = { seq: Math.max(last, cursorAt(join(dir, 'loop-events.cursor'))) + 1, time: new Date().toISOString(), kind, pr, text }
  const line = `${JSON.stringify(event)}\n`
  if (raw === null) makeParent(file, repo)
  if (rows.length + 1 > EVENTS_LIMIT) {
    const kept = [...rows.slice(rows.length + 1 - EVENTS_LIMIT).map((row) => JSON.stringify(row)), JSON.stringify(event)]
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${kept.join('\n')}\n`)
    renameSync(temporary, file)
  } else {
    // 쓰다 끊긴 마지막 줄에 이어 붙지 않게 줄을 먼저 끝낸다
    appendFileSync(file, raw && !raw.endsWith('\n') ? `\n${line}` : line)
  }
  return event
}

// 커서보다 큰 seq 의 줄과 빠진 구간. 커서는 옮기지 않는다.
export function readEvents(repo: string): { events: LoopEvent[]; gap: [number, number] | null } {
  const dir = pathOf('state', repo)
  const cursor = cursorAt(join(dir, 'loop-events.cursor'))
  const rows = parseLines(readText(join(dir, 'loop-events.jsonl')))
  const events = rows.filter((row) => row.seq > cursor)
  const first = rows.reduce((min, row) => Math.min(min, row.seq), Number.POSITIVE_INFINITY)
  const gap: [number, number] | null = events.length > 0 && first > cursor + 1 ? [cursor + 1, first - 1] : null
  return { events, gap }
}
