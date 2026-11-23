// 오래된 머지 큐 로그를 고른다. 열린 PR 이 있거나 상태를 모르거나 연 프로세스가 있으면 남긴다.
// 끝난 마무리 로그와 pid 는 한 묶음으로 본다. 실패 로그와 끝 표시 없이 pid 만 죽은 로그는 적어도 한 시간 남긴다.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pidFileAlive } from './process.ts'
import { run } from './proc.ts'
import { moveToTrash } from './spec.ts'

export const RETENTION_DAY_MS = 86_400_000
export const QUEUE_DAYS = 3
export const FAIL_HOLD_MS = 60 * 60 * 1000

const FINISH_PID = /^finish-(\d+)\.pid$/
const FINISH_OUT = /^finish-(\d+)\.out$/
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
  if (done.code !== 0 && (done.code !== 1 || done.stderr.trim())) return null
  return done.stdout.trim() !== ''
}

function tail(text: string): string {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-TAIL_LINES).join('\n')
}

function prNumbers(text: string): number[] {
  const found = new Set<number>()
  for (const re of [/^\d{1,2}:\d{2} (\d+) /gm, /^(?:STOP|MERGED|SKIP|CONFLICT|FINISH-STARTED|FINISH-RUNNING) (\d+)\b/gm, /\bPR (\d+)\b/g]) {
    for (const m of text.matchAll(re)) found.add(Number(m[1]))
  }
  for (const m of text.matchAll(/^QUEUE-(?:HELD|CONFLICT)((?: \d+)+)\s*$/gm)) {
    for (const number of m[1].trim().split(' ')) found.add(Number(number))
  }
  return [...found]
}

export function closedPr(state: string | undefined): boolean {
  return state !== undefined && CLOSED.has(state)
}

// 파일과 상위 경로에 심볼릭 링크가 들어오면 관리 폴더 밖의 파일을 읽거나 옮길 수 있다
export function oldFiles(dir: string, pattern: RegExp, cutoff: number): { file: string; name: string; mtime: number }[] {
  try {
    if (!lstatSync(dir).isDirectory()) return []
    return readdirSync(dir).sort().flatMap((name) => {
      if (!pattern.test(name)) return []
      const file = join(dir, name)
      try {
        const stat = lstatSync(file)
        return stat.isFile() && stat.mtimeMs < cutoff ? [{ file, name, mtime: stat.mtimeMs }] : []
      } catch { return [] }
    })
  } catch { return [] }
}

export function queueLogCandidates(opts: {
  dir: string
  host: QueueLogHost
  days?: number
  kind?: 'queue' | 'handoff' | 'auto-merge'
}): string[] {
  const { dir, host, kind = 'queue', days = QUEUE_DAYS } = opts
  const now = host.now()
  const cutoff = now - days * RETENTION_DAY_MS
  const pattern = kind === 'auto-merge' ? /^\d{8}T\d{6}Z\.log$/ : kind === 'handoff' ? /\.out$/ : /\.(out|log|pid)$/
  const candidates = oldFiles(dir, pattern, cutoff).flatMap(({ file, name, mtime }) => {
    const orphan = FINISH_PID.exec(name)
    if (orphan) {
      if (existsSync(join(dir, `finish-${orphan[1]}.out`)) || pidFileAlive(file) || host.openedBy(file) !== false) return []
      return [{ files: [file], numbers: [Number(orphan[1])] }]
    }
    const finish = FINISH_OUT.exec(name)
    if (!finish && (name.startsWith('finish-') || name.endsWith('.pid'))) return []
    const pidFile = finish ? join(dir, `finish-${finish[1]}.pid`) : null
    try {
      const pid = pidFile ? lstatSync(pidFile, { throwIfNoEntry: false }) : null
      if (pid && (!pid.isFile() || pid.mtimeMs >= cutoff)) return []
      if ((pidFile && pidFileAlive(pidFile)) || host.openedBy(file) !== false) return []
      const content = readFileSync(file, 'utf8')
      const end = tail(content)
      const ended = (finish ? FINISH_END : QUEUE_END).test(end)
      const numbers = finish ? [Number(finish[1])] : prNumbers(content)
      if (!ended) {
        if (kind === 'handoff') return []
        if (finish && !pid) return []
        if (!finish && kind === 'queue' && numbers.length === 0) return []
      }
      if ((FAILED_END.test(end) || (finish && !ended)) && now - mtime < FAIL_HOLD_MS) return []
      return [{ files: pid && pidFile ? [file, pidFile] : [file], numbers }]
    } catch { return [] }
  })
  const numbers = [...new Set(candidates.flatMap((item) => item.numbers))]
  const states = numbers.length ? host.prStates(numbers) : new Map<number, string>()
  return candidates.flatMap(({ numbers, files }) => {
    if (!numbers.every((n) => closedPr(states.get(n)))) return []
    try {
      return files.every((file) => {
        const stat = lstatSync(file)
        return stat.isFile() && stat.mtimeMs < cutoff
      }) ? files : []
    } catch { return [] }
  })
}

export function trashRetainedFile(file: string, subdir: string, trash: string, apply: boolean, log: (line: string) => void): void {
  const label = subdir === 'queue' ? '머지 큐 로그' : '보존 기한이 지난 파일'
  const object = subdir === 'queue' ? '머지 큐 로그를' : '보존 기한이 지난 파일을'
  if (!apply) {
    log(`${object} 휴지통으로 옮길 것 ${file}`)
    return
  }
  try {
    const dest = moveToTrash(file, resolve(trash, subdir))
    log(`${label} 옮김 ${file} -> ${dest}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`${object} 남긴다 ${file}: ${(e as Error).message}`)
  }
}
