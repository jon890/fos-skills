// 보드 창(hooks/register.js)이 열린 PR 마다 머지 가능 여부와 그 이유를 한 줄로 그릴 수 있게 orch 의 설정, 상태 파일과 로그를 읽어 낸다. 읽기만 한다.
// gh 를 부르지 않는다. 열린 PR 목록은 창이 이미 읽은 것과 합친다. gh 호출 예산을 늘리지 않으려는 것이다.
// mod 는 TypeScript 와 node:fs 를 import 하지 못해, 이 명령을 $.process.run 으로 불러 JSON 출력만 읽는다.
//
// 사용법:
//     merge-queue.ts --repo DIR
//
//     --repo  orch 상태 폴더(<orch 루트>/state)를 찾을 저장소(주 checkout)
//
// 큐를 쓰는 저장소인가(enabled): <orch 루트>/config.json 의 queue.auto_merge 가 true 이거나, 아래 1 의 살아 있는 차례 기록이 있으면 쓴다.
//     설정 파일이 없거나 읽지 못하면 auto_merge 는 꺼진 것으로 본다. 쓰지 않으면 prs 는 비고 아래 3 도 읽지 않는다.
//     auto_merge 가 꺼져 있으면 코디네이터가 건 큐(1)만 보이고 3 은 읽지 않는다. 예전에 켰을 때 남은 루프 로그의 이유를 보이지 않으려는 것이다.
//
// 읽는 곳. 아래는 모두 <orch 루트>/state 아래다. 형식은 쓰는 쪽(orch/scripts/orch-loop.ts, merge_queue.ts)이 소유한다.
//     1. queue-turn/<pid>.json: 머지 큐가 도는 동안 적는 차례 기록 { pid, prs, pr, phase, since }(orch 의 lib/queue-turn.ts).
//        pid 의 명령줄(ps)에 `merge_queue.` 가 있는 파일만 쓴다. 차례 PR 은 지금 차례, prs 의 나머지는 적힌 순서대로 n 번째다.
//     2. 1 이 없으면 auto-merge.json 의 queue { pid, log, prs, at } 와 그 큐 로그(auto-merge/<시각>.log). 루프가 건 큐만 여기 남는다.
//        pid 의 명령줄에 `merge-with-finish.` 가 있을 때만 도는 큐로 본다. 로그의 `HH:MM <PR> …` 줄에서 머지했거나 뺀 PR
//        (MERGED, 충돌, 보류, QUEUE-HELD, QUEUE-CONFLICT)을 빼고, 마지막으로 줄을 남긴 남은 PR 을 지금 차례로 본다. 줄이 없으면 첫 PR 이다.
//        단계는 그 PR 의 마지막 줄로 정한다(update-branch → `update-branch 뒤 체크 대기`, 판정·체크 줄 → `체크 대기`, 없으면 `차례 시작`).
//     3. loop.log(앞에 loop.log.1)의 `tick <n> <ISO>` 줄과 `AUTO-MERGE-WAIT #<PR> <이유>` 줄. 자동 머지 판정을 한 마지막 틱
//        (AUTO-MERGE-WAIT, AUTO-MERGE-BASIS, AUTO-MERGE 줄이 있는 틱)의 이유를 큐 밖 PR 의 대기 이유로 쓴다.
//        그 틱에 `AUTO-MERGE-BASIS #<PR>` 줄이 있는 PR 은 판정을 통과한 것이라 ready 로 낸다.
//        마지막으로 바뀐 시각은 그 PR 의 이유가 지금 값으로 바뀐 틱의 시각이다. 판정 틱마다 이유가 같으면 처음 그 이유가 나온 틱이다.
//     큐 안의 PR 은 1, 2 가 3 보다 앞선다. 큐가 돌면 루프는 판정하지 않아(AUTO-MERGE-HELD) 3 의 이유가 큐를 걸기 전 값이기 때문이다.
//
// 출력(stdout 한 줄 JSON):
//     {"enabled": b, "running": b, "prs": {"<PR>": QueueRow}, "error": null | "<읽지 못한 이유>"}
//     QueueRow = {"place": "turn"|"queued"|"ready"|"out", "rank": n|null, "reason": string|null, "at": ISO|null}
//     turn 은 지금 차례(rank 1), queued 는 큐 안에서 기다리는 PR(rank 2 부터), ready 는 판정을 통과한 큐 밖 PR(reason null),
//     out 은 큐 밖에서 기다리는 PR 이다. 어디에도 없는 PR 은 넣지 않고, 창은 그 PR 에 줄을 붙이지 않는다.
//     error 는 상태 폴더나 로그를 읽지 못했을 때만 둔다
//
// 종료 코드: 0 냈다(읽지 못해도 error 에 이유를 두고 0), 1 예기치 못한 오류, 2 사용법 오류(stderr 에 이유)

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../../orch/scripts/lib/config.ts'
import { real } from '../../orch/scripts/lib/fs.ts'
import { pathOf } from '../../orch/scripts/lib/paths.ts'

export type QueueRow = { place: 'turn' | 'queued' | 'ready' | 'out'; rank: number | null; reason: string | null; at: string | null }
export type QueueView = { enabled: boolean; running: boolean; prs: Record<string, QueueRow>; error: string | null }

type Turn = { pid: number; prs: number[]; pr: number | null; phase: string; since: string }
type Queue = { pid: number; log: string; prs: number[]; at: string }

const USAGE = '사용법: merge-queue.ts --repo DIR'
// loop.log 는 1MiB 에서 loop.log.1 로 넘어간다(orch-loop.ts 의 LOG_LIMIT). 둘을 합쳐 이 크기의 뒷부분만 읽는다
const LOG_TAIL_BYTES = 2 * 1_048_576

const isInt = (v: unknown): v is number => Number.isInteger(v)

export function parseTurn(text: string): Turn | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (!isInt(row.pid) || !Array.isArray(row.prs) || !row.prs.every(isInt)) return null
  if (!(row.pr === null || isInt(row.pr)) || typeof row.phase !== 'string' || typeof row.since !== 'string') return null
  return { pid: row.pid, prs: row.prs as number[], pr: row.pr as number | null, phase: row.phase, since: row.since }
}

export function parseQueue(text: string): Queue | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const queue = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).queue : null
  if (!queue || typeof queue !== 'object') return null
  const q = queue as Record<string, unknown>
  if (!isInt(q.pid) || typeof q.log !== 'string' || !Array.isArray(q.prs) || !q.prs.every(isInt)) return null
  return { pid: q.pid, log: q.log, prs: q.prs as number[], at: typeof q.at === 'string' ? q.at : '' }
}

// 차례 기록 하나를 줄로. 차례 PR 이 1 번, prs 의 나머지가 적힌 순서대로 2 번부터다
export function turnRows(turn: Turn): Record<string, QueueRow> {
  const rows: Record<string, QueueRow> = {}
  const rest = turn.prs.filter((n) => n !== turn.pr)
  if (turn.pr !== null) rows[String(turn.pr)] = { place: 'turn', rank: 1, reason: turn.phase, at: turn.since }
  const offset = turn.pr === null ? 1 : 2
  rest.forEach((n, i) => {
    rows[String(n)] = { place: 'queued', rank: i + offset, reason: turn.pr === null ? turn.phase : `#${turn.pr} 차례 대기`, at: turn.since }
  })
  return rows
}

// 큐 로그의 「HH:MM」(머지 큐가 지역 시각으로 적는다)을 큐를 건 시각 뒤의 처음 같은 시각으로 바꾼다
export function clockAt(hhmm: string, startedAt: string): string | null {
  const start = Date.parse(startedAt)
  const m = /^(\d\d):(\d\d)$/.exec(hhmm)
  if (!m || !Number.isFinite(start)) return null
  const at = new Date(start)
  at.setHours(Number(m[1]), Number(m[2]), 0, 0)
  // 큐를 건 같은 분이면 그 분의 0초가 시작보다 앞선다. 1분을 넘게 앞서면 다음 날이다
  if (at.getTime() < start - 60_000) at.setDate(at.getDate() + 1)
  return at.toISOString()
}

const FINISHED = /^(?:이미 )?MERGED$|^충돌\. |^보류\. /

// 루프가 건 큐(auto-merge.json 의 queue)와 그 로그를 줄로. 로그를 읽지 못하면 첫 PR 을 차례로 본다
export function queueRows(queue: Queue, logText: string): Record<string, QueueRow> {
  const finished = new Set<number>()
  const last = new Map<number, { text: string; at: string | null }>()
  let latest: number | null = null
  let latestAt: string | null = null
  for (const line of logText.split(/\r?\n/)) {
    const held = /^QUEUE-(?:HELD|CONFLICT) ([\d ]+)$/.exec(line)
    if (held) {
      for (const n of held[1].trim().split(/\s+/)) finished.add(Number(n))
      continue
    }
    const m = /^(\d\d:\d\d) (\d+) (.*)$/.exec(line)
    if (!m) continue
    const n = Number(m[2])
    if (!queue.prs.includes(n)) continue
    if (FINISHED.test(m[3])) finished.add(n)
    last.set(n, { text: m[3], at: clockAt(m[1], queue.at) })
    latest = n
    latestAt = last.get(n)?.at ?? latestAt
  }
  const left = queue.prs.filter((n) => !finished.has(n))
  if (left.length === 0) return {}
  const turn = latest !== null && left.includes(latest) ? latest : left[0]
  const seen = last.get(turn)
  const phase = !seen ? '차례 시작' : /update-branch/.test(seen.text) ? 'update-branch 뒤 체크 대기' : '체크 대기'
  return turnRows({ pid: queue.pid, prs: [turn, ...left.filter((n) => n !== turn)], pr: turn, phase, since: seen?.at ?? latestAt ?? queue.at })
}

// 루프 로그에서 큐 밖 PR 의 대기 이유. 자동 머지 판정을 한 마지막 틱의 AUTO-MERGE-WAIT 줄과 AUTO-MERGE-BASIS 줄(통과, reason null)만 남긴다
export function waitRows(logText: string): Record<string, QueueRow> {
  let tickAt: string | null = null
  let history = new Map<string, { reason: string; at: string | null }>()
  let current: Map<string, { reason: string; at: string | null }> | null = null
  const close = () => {
    if (current) history = current
    current = null
  }
  for (const line of logText.split(/\r?\n/)) {
    const tick = /^tick \d+ (\S+)$/.exec(line)
    if (tick) {
      close()
      tickAt = Number.isFinite(Date.parse(tick[1])) ? tick[1] : null
      continue
    }
    const wait = /^AUTO-MERGE-WAIT #(\d+) (.+)$/.exec(line)
    const passed = /^AUTO-MERGE-BASIS #(\d+) /.exec(line)
    if (wait || /^AUTO-MERGE(?:-BASIS)? #?\d/.test(line)) current ??= new Map()
    const n = wait?.[1] ?? passed?.[1]
    if (!n || !current) continue
    // 통과는 이유 자리에 빈 글을 둔다. 이유가 바뀐 시각을 셀 때 대기 이유와 같은 규칙을 쓰려는 것이다
    const reason = wait ? wait[2] : ''
    const before = history.get(n)
    current.set(n, { reason, at: before && before.reason === reason ? before.at : tickAt })
  }
  close()
  const rows: Record<string, QueueRow> = {}
  for (const [n, row] of history) rows[n] = row.reason ? { place: 'out', rank: null, reason: row.reason, at: row.at } : { place: 'ready', rank: null, reason: null, at: row.at }
  return rows
}

// pid 의 명령줄. 없으면 null
function commandOf(pid: number): string | null {
  const got = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return got.status === 0 && got.stdout.trim() ? got.stdout.trim() : null
}

// 설정의 queue.auto_merge. 설정 파일이 없거나 읽지 못하면 꺼진 것으로 본다
export function autoMergeOn(repo: string): boolean {
  try {
    return loadConfig(repo).queue?.auto_merge === true
  } catch {
    return false
  }
}

function readTail(files: string[]): string {
  const text = files.filter((file) => existsSync(file)).map((file) => readFileSync(file, 'utf8')).join('\n')
  if (text.length <= LOG_TAIL_BYTES) return text
  const tail = text.slice(-LOG_TAIL_BYTES)
  return tail.slice(tail.indexOf('\n') + 1)
}

// autoMerge 는 설정의 queue.auto_merge 다(머리 주석의 「큐를 쓰는 저장소인가」)
export function readView(state: string, isQueue: (pid: number, marker: string) => boolean, autoMerge: boolean): QueueView {
  if (!existsSync(state) || !statSync(state).isDirectory()) return { enabled: autoMerge, running: false, prs: {}, error: `orch 상태 폴더가 없다: ${state}` }
  let queued: Record<string, QueueRow> = {}
  let running = false
  const turnDir = join(state, 'queue-turn')
  const names = existsSync(turnDir) ? readdirSync(turnDir).filter((n) => /^\d+\.json$/.test(n)).sort() : []
  for (const name of names) {
    let turn: Turn | null = null
    try {
      turn = parseTurn(readFileSync(join(turnDir, name), 'utf8'))
    } catch {
      continue
    }
    if (!turn || `${turn.pid}.json` !== name || !isQueue(turn.pid, 'merge_queue.')) continue
    running = true
    // 큐가 둘이면 앞 파일의 순서를 둔다
    queued = { ...turnRows(turn), ...queued }
  }
  if (!running && autoMerge) {
    const record = join(state, 'auto-merge.json')
    const queue = existsSync(record) ? parseQueue(readFileSync(record, 'utf8')) : null
    if (queue && isQueue(queue.pid, 'merge-with-finish.')) {
      running = true
      let logText = ''
      try {
        logText = readFileSync(queue.log, 'utf8')
      } catch {
        // 로그가 없으면 첫 PR 을 차례로 본다
      }
      queued = queueRows(queue, logText)
    }
  }
  if (!autoMerge) return { enabled: running, running, prs: queued, error: null }
  let waits: Record<string, QueueRow> = {}
  let error: string | null = null
  try {
    waits = waitRows(readTail([join(state, 'loop.log.1'), join(state, 'loop.log')]))
  } catch (e) {
    error = `루프 로그를 읽지 못했다: ${(e as Error).message}`
  }
  return { enabled: true, running, prs: { ...waits, ...queued }, error }
}

function main(argv: string[]): number {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { repo: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }))
  } catch (e) {
    process.stderr.write(`${USAGE}\nmerge-queue: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo) {
    process.stderr.write(`${USAGE}\nmerge-queue: --repo 가 필요하다\n`)
    return 2
  }
  const repo = real(values.repo)
  const view = readView(pathOf('state', repo), (pid, marker) => (commandOf(pid) ?? '').includes(marker), autoMergeOn(repo))
  process.stdout.write(`${JSON.stringify(view)}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`merge-queue: ${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  }
}
