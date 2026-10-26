// 머지 큐 로그 폴더(<orch>/queue)에 남은 끝난 로그를 휴지통으로 옮긴다. cleanup-sweep.ts 가 저장소마다 한 번 부른다.
//
// 대상은 폴더 바로 아래의 파일이고, 아래 셋 가운데 어디에도 들지 않는 파일(모르는 파일)은 건드리지 않는다.
//     finish-<PR>.out, finish-<PR>.pid   merge-with-finish.ts 가 PR 마다 띄우는 마무리의 출력과 pid
//     그 밖의 *.out, *.log               머지 큐(merge_queue.ts)와 merge-with-finish.ts 의 출력
//
// 옮기는 조건:
//     마무리 로그  pid 파일의 프로세스가 살아 있지 않고 끝 3줄에 FINISH-DONE 이나 FINISH-FAIL 이 있다. 같은 PR 의 .pid 도 함께 옮긴다.
//                 로그 없이 .pid 만 있으면 남긴다
//     큐 로그      그 로그를 연 프로세스가 없고(lsof) 아래 가운데 하나다
//                   · 끝 3줄에 QUEUE-DONE 이나 STOP 이 있다
//                   · 로그에 나온 PR 이 하나 이상이고 모두 MERGED 나 CLOSED 다. PR 번호는 `HH:MM <번호> …`, `STOP <번호> …`, `PR <번호>` 줄에서 읽는다
//     lsof 를 못 돌리거나 PR 상태를 읽지 못하면 돌고 있다고 보고 남긴다.
//     FINISH-FAIL 과 STOP 로그는 코디네이터가 볼 수 있게 마지막으로 바뀐 뒤 holdMs(기본 1시간) 동안 남긴다.
//
// 휴지통 안에서는 <휴지통>/<폴더 이름>/<파일 이름> 이고 같은 이름이 있으면 번호를 붙여 덮어쓰지 않는다(handoff-cleanup.ts 와 같다).
//
// 내보내는 것:
//     sweepQueueLogs  옮길 것을 정하고 apply 이면 옮긴다. 옮긴 파일 경로와 남긴 파일의 이유를 돌려준다

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { alive } from './process.ts'
import { run } from './proc.ts'
import { moveToTrash } from './spec.ts'

export const FAIL_HOLD_MS = 60 * 60 * 1000

const FINISH_OUT = /^finish-(\d+)\.out$/
const FINISH_PID = /^finish-(\d+)\.pid$/
const LOG_FILE = /\.(out|log)$/
const FINISH_END = /^(FINISH-DONE|FINISH-FAIL)$/m
const QUEUE_END = /^(QUEUE-DONE|STOP)\b/m
const FAILED_END = /^(FINISH-FAIL|STOP)\b/m
const TAIL_LINES = 3
const CLOSED = new Set(['MERGED', 'CLOSED'])

export type QueueLogHost = {
  now: () => number
  // 그 파일을 연 프로세스가 있는가. 확인하지 못하면 null
  openedBy: (file: string) => boolean | null
  // PR 번호별 state. 읽지 못한 번호는 들어 있지 않다
  prStates: (numbers: number[]) => Map<number, string>
}

export const lsofOpenedBy = (file: string): boolean | null => {
  const done = run(['lsof', '-t', '--', file])
  if (done.code !== 0 && done.code !== 1) return null
  return done.out.trim() !== ''
}

function tail(text: string): string {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-TAIL_LINES).join('\n')
}

function prNumbers(text: string): number[] {
  const found = new Set<number>()
  for (const re of [/^\d{1,2}:\d{2} (\d+) /gm, /^STOP (\d+)\b/gm, /\bPR (\d+)\b/g]) {
    for (const m of text.matchAll(re)) found.add(Number(m[1]))
  }
  return [...found]
}

function pidAlive(file: string): boolean {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return /^\d+$/.test(text) && alive(Number(text))
  } catch {
    return false
  }
}

type Verdict = { move: true } | { move: false; reason: string | null }

function hold(failed: boolean, mtimeMs: number, host: QueueLogHost, holdMs: number): Verdict | null {
  if (!failed) return null
  return host.now() - mtimeMs < holdMs ? { move: false, reason: '실패 로그라 코디네이터가 볼 시간 동안 남긴다' } : null
}

function finishVerdict(dir: string, name: string, number: string, host: QueueLogHost, holdMs: number): Verdict {
  const file = join(dir, name)
  if (pidAlive(join(dir, `finish-${number}.pid`))) return { move: false, reason: '마무리가 돌고 있다' }
  const text = readFileSync(file, 'utf8')
  const end = tail(text)
  if (!FINISH_END.test(end)) return { move: false, reason: '끝 표시(FINISH-DONE, FINISH-FAIL)가 없다' }
  return hold(FAILED_END.test(end), statSync(file).mtimeMs, host, holdMs) ?? { move: true }
}

function queueVerdict(dir: string, name: string, host: QueueLogHost, holdMs: number): Verdict {
  const file = join(dir, name)
  const open = host.openedBy(file)
  if (open === null) return { move: false, reason: '돌고 있는지 확인하지 못했다' }
  if (open) return { move: false, reason: '큐가 돌고 있다' }
  const text = readFileSync(file, 'utf8')
  const end = tail(text)
  const ended = QUEUE_END.test(end)
  if (!ended) {
    const numbers = prNumbers(text)
    if (numbers.length === 0) return { move: false, reason: '끝 표시가 없고 PR 도 찾지 못했다' }
    const states = host.prStates(numbers)
    const pending = numbers.filter((n) => !CLOSED.has(states.get(n) ?? ''))
    if (pending.length > 0) return { move: false, reason: `머지나 닫힘이 아닌 PR 이 있다: ${pending.join(' ')}` }
  }
  return hold(FAILED_END.test(end), statSync(file).mtimeMs, host, holdMs) ?? { move: true }
}

export function sweepQueueLogs(opts: {
  dir: string
  trash: string
  apply: boolean
  log: (line: string) => void
  host: QueueLogHost
  holdMs?: number
}): { moved: string[]; kept: { path: string; reason: string }[] } {
  const { dir, trash, apply, log, host } = opts
  const holdMs = opts.holdMs ?? FAIL_HOLD_MS
  const moved: string[] = []
  const kept: { path: string; reason: string }[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { moved, kept }
  }
  const take = (path: string) => {
    if (!apply) {
      log(`머지 큐 로그를 휴지통으로 옮길 것 ${path}`)
      moved.push(path)
      return
    }
    try {
      const dest = moveToTrash(path, join(resolve(trash), basename(dir)))
      log(`머지 큐 로그 옮김 ${path} -> ${dest}`)
      moved.push(path)
    } catch (e) {
      keep(path, `휴지통으로 옮기지 못했다: ${(e as Error).message}`)
    }
  }
  const keep = (path: string, reason: string) => {
    kept.push({ path, reason })
    log(`머지 큐 로그를 남긴다 ${path}: ${reason}`)
  }
  const stat = (name: string) => {
    try {
      return statSync(join(dir, name)).isFile()
    } catch {
      return false
    }
  }
  for (const name of names.sort()) {
    const path = join(dir, name)
    if (!stat(name)) continue
    const out = FINISH_OUT.exec(name)
    const pid = FINISH_PID.exec(name)
    let verdict: Verdict
    try {
      if (out) verdict = finishVerdict(dir, name, out[1], host, holdMs)
      else if (pid) continue
      else if (LOG_FILE.test(name) && !name.startsWith('finish-')) verdict = queueVerdict(dir, name, host, holdMs)
      else continue
    } catch (e) {
      keep(path, `읽지 못했다: ${(e as Error).message}`)
      continue
    }
    if (!verdict.move) {
      if (verdict.reason) keep(path, verdict.reason)
      continue
    }
    take(path)
    // 로그를 옮길 때 같은 PR 의 pid 파일도 함께 옮긴다. 살아 있는 프로세스의 pid 파일은 위에서 이미 남겼다
    if (out && stat(`finish-${out[1]}.pid`)) take(join(dir, `finish-${out[1]}.pid`))
  }
  return { moved, kept }
}
