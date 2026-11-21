#!/usr/bin/env node
// Colima VM 안에서 fstrim 을 돌리고, 호스트 VM 디스크 파일이 줄었는지 재서 부족하면 다시 돈다.
//
// 사용법:
//   colima_trim.ts [--profile default] [--disk PATH] [--threshold-gib 4]
//                  [--max-attempts 4] [--interval 60] [--max-seconds 100]
//
// VM 디스크 파일의 실제 점유 크기(`du -sk`)와 VM 안 `/mnt/lima-colima` 의 사용량을 비교한다.
// 점유 크기가 사용량보다 기준값보다 더 크면 아직 비워지지 않은 블록이 남은 것으로 보고 잠시 기다렸다 다시 trim 한다.
// volume 을 지운 직후에는 한 번에 덜 비워지는 경우가 있어(실측: 8GiB 만 trim, 1분 뒤 43.8GiB) 결과를 재서 재시도한다.
// `--disk` 가 없으면 `~/.colima/_lima/_disks/colima/datadisk`(default 프로필) 나 `colima-<프로필>/datadisk` 를 쓴다.
// 전체 시간이 `--max-seconds` 를 넘기지 않게 한다. 다음 시도(대기 + 직전 시도 소요 시간)가 그 안에 끝나지 않을 것 같으면
// 재시도하지 않고 남은 차이를 출력한 채 종료 코드 2 로 끝낸다. 기본값 100초는 에이전트 도구의 명령 시간 한도(120초)보다 짧다.
// 한도가 긴 환경에서는 `--max-seconds` 를 늘린다. 기본값 그대로 최악의 소요 시간은 첫 시도 소요 시간 + 대기와 시도 한 번씩이다.
// fstrim 은 데이터를 지우지 않는다.
//
// 종료 코드: 0 차이가 기준값 이하, 1 Colima 가 떠 있지 않거나 측정 실패, 2 재시도 횟수나 시간 상한까지 차이가 남음.

import { statfsSync } from 'node:fs'
import { readArgs, type Entry } from './cli.ts'
import { isMain, runText, sleep, write } from './io.ts'
import { expanduser, osJoin, parsePyFloat, parsePyInt, pyFixed, pyPath } from './pylike.ts'
import { pySplitLines } from './kit/py.ts'
import { splitWhitespace } from './pylike.ts'

const USAGE = `usage: colima_trim.ts [-h] [--profile PROFILE] [--disk DISK]
                      [--threshold-gib THRESHOLD_GIB]
                      [--max-attempts MAX_ATTEMPTS] [--interval INTERVAL]
                      [--max-seconds MAX_SECONDS]
`

// argparse 가 만든 도움말(80칸)과 같다. 옵션 이름 대신 파일 이름이 .ts 다
const HELP = `${USAGE}
Colima VM 안에서 fstrim 을 돌리고, 호스트 VM 디스크 파일이 줄었는지 재서 부족하면 다시 돈다.

options:
  -h, --help            show this help message and exit
  --profile PROFILE
  --disk DISK
  --threshold-gib THRESHOLD_GIB
  --max-attempts MAX_ATTEMPTS
  --interval INTERVAL   재시도 전 대기 초
  --max-seconds MAX_SECONDS
                        전체 시간 상한 초(도구 한도 120초 안)
`

const ENTRY: Entry = {
  prog: 'colima_trim.ts',
  usage: USAGE,
  help: HELP,
  spec: {
    options: [
      { name: 'profile', value: true },
      { name: 'disk', value: true },
      { name: 'threshold-gib', value: true, float: true },
      { name: 'max-attempts', value: true, int: true },
      { name: 'interval', value: true, float: true },
      { name: 'max-seconds', value: true, float: true },
    ],
    positionals: [],
  },
}

const GIB = 1024 ** 3
const MOUNT = '/mnt/lima-colima'
const TRIM_RE = /\((\p{Nd}+) bytes\) trimmed/gu

class MeasureError extends Error {}

// `fstrim -v` 출력에서 trim 한 바이트 수의 합을 낸다. 알아볼 수 없으면 0 이다
export function parseTrimBytes(output: string | null): number {
  let sum = 0
  for (const m of (output ?? '').matchAll(TRIM_RE)) sum += parsePyInt(m[1])
  return sum
}

// `df -B1 --output=used` 출력의 마지막 숫자 줄을 바이트로 바꾼다. 없으면 null 이다
export function parseUsedBytes(output: string | null): number | null {
  const lines = pySplitLines((output ?? '').trim())
  for (const line of lines.reverse()) if (/^\p{Nd}+$/u.test(line.trim())) return parsePyInt(line.trim())
  return null
}

// `du -sk` 출력의 첫 열(KiB)을 바이트로 바꾼다. 알아볼 수 없으면 null 이다
export function parseDuBytes(output: string | null): number | null {
  const head = splitWhitespace(output ?? '')
  return head.length && /^\p{Nd}+$/u.test(head[0]) ? parsePyInt(head[0]) * 1024 : null
}

// 호스트 디스크 파일 점유 크기에서 VM 안 사용량을 뺀 값. 비워지지 않은 블록의 양이다
export const gapBytes = (diskFile: number, vmUsed: number): number => diskFile - vmUsed

// 차이가 기준값을 넘고, 시도 횟수가 남고, 다음 시도가 시간 상한 안에 끝날 것 같으면 다시 돈다
export function shouldRetry(gap: number, threshold: number, attempt: number, maxAttempts: number, elapsed = 0, interval = 0, lastDuration = 0, maxSeconds: number | null = null): boolean {
  if (gap <= threshold || attempt >= maxAttempts) return false
  return maxSeconds === null || elapsed + interval + lastDuration <= maxSeconds
}

export function diskPath(profile: string, override?: string): string {
  if (override) return pyPath(expanduser(override))
  const name = profile === 'default' ? 'colima' : `colima-${profile}`
  return osJoin(osJoin(osJoin(osJoin(pyPath(expanduser('~')), '.colima'), '_lima'), '_disks'), `${name}/datadisk`)
}

export const fmt = (num: number): string => `${pyFixed(num / GIB, 1)}GiB`

const run = (argv: string[]) => {
  const done = runText(argv)
  if (done.failure) throw new Error(done.message)
  return done
}

function colimaRunning(profile: string): boolean {
  const done = runText(['colima', 'status', '-p', profile])
  return done.failure === null && done.code === 0
}

export type Measure = [number, number, number]

// [디스크 파일 점유, VM 안 사용량, 호스트 여유] 를 바이트로 잰다. 실패하면 MeasureError 다
function measure(profile: string, disk: string): Measure {
  const du = parseDuBytes(run(['du', '-sk', disk]).stdout)
  const df = run(['colima', 'ssh', '-p', profile, '--', 'df', '-B1', '--output=used', MOUNT])
  const used = parseUsedBytes(df.stdout)
  if (du === null || used === null) throw new MeasureError(`측정 실패: du=${du === null ? 'None' : du} df=${df.stderr.trim() || df.stdout.trim()}`)
  const stats = statfsSync(pyPath(expanduser('~')))
  return [du, used, stats.bavail * stats.bsize]
}

// sync 뒤에 fstrim -v 를 돌려 trim 한 바이트 수를 낸다
function trim(profile: string): number {
  const done = run(['colima', 'ssh', '-p', profile, '--', 'sh', '-c', `sync && sudo fstrim -v ${MOUNT}`])
  if (done.code !== 0) throw new MeasureError(`fstrim 실패: ${done.stderr.trim() || done.stdout.trim()}`)
  return parseTrimBytes(done.stdout + done.stderr)
}

export type Deps = { clock?: () => number; sleep?: (seconds: number) => void; out?: (line: string) => void }

const line = (label: string, diskFile: number, used: number, free: number) => `${label}: 디스크 파일 ${fmt(diskFile)}, VM 사용량 ${fmt(used)}, 차이 ${fmt(gapBytes(diskFile, used))}, 호스트 여유 ${fmt(free)}`

// gap 이 기준값 이하가 되거나 횟수와 시간 상한에 닿을 때까지 trim 한다. [시도 횟수, 마지막 측정] 을 낸다
export function trimUntilDone(trimFn: () => number, measureFn: () => Measure, threshold: number, maxAttempts: number, interval: number, maxSeconds: number, deps: Deps = {}): [number, Measure] {
  const clock = deps.clock ?? (() => performance.now() / 1000)
  const doSleep = deps.sleep ?? sleep
  const out = deps.out ?? ((text: string) => write(1, `${text}\n`))
  const start = clock()
  let attempt = 0
  for (;;) {
    const began = clock()
    attempt += 1
    const trimmed = trimFn()
    const after = measureFn()
    out(`시도 ${attempt}: trim ${fmt(trimmed)}`)
    out(`  ${line('측정', ...after)}`)
    const gap = gapBytes(after[0], after[1])
    if (!shouldRetry(gap, threshold, attempt, maxAttempts, clock() - start, interval, clock() - began, maxSeconds)) return [attempt, after]
    out(`  차이가 기준값 ${fmt(threshold)} 보다 커 ${pyFixed(interval, 0)}초 뒤 다시 돈다`)
    doSleep(interval)
  }
}

export function main(argv: string[]): number {
  const args = readArgs(argv, ENTRY)
  if (typeof args === 'number') return args
  const profile = (args.options.profile as string | undefined) ?? 'default'
  const thresholdGib = args.options['threshold-gib'] === undefined ? 4.0 : parsePyFloat(args.options['threshold-gib'] as string)
  const maxAttempts = args.options['max-attempts'] === undefined ? 4 : parsePyInt(args.options['max-attempts'] as string)
  const interval = args.options.interval === undefined ? 60.0 : parsePyFloat(args.options.interval as string)
  const maxSeconds = args.options['max-seconds'] === undefined ? 100.0 : parsePyFloat(args.options['max-seconds'] as string)

  if (!colimaRunning(profile)) {
    write(2, `Colima 프로필 ${profile} 가 떠 있지 않다. 아무것도 하지 않았다.\n`)
    return 1
  }
  const disk = diskPath(profile, args.options.disk as string | undefined)
  const threshold = Math.trunc(thresholdGib * GIB)
  let before: Measure
  let attempt: number
  let after: Measure
  try {
    before = measure(profile, disk)
    write(1, `${line('전', ...before)}\n`)
    ;[attempt, after] = trimUntilDone(() => trim(profile), () => measure(profile, disk), threshold, maxAttempts, interval, maxSeconds)
  } catch (error) {
    if (!(error instanceof MeasureError)) throw error
    write(2, `${error.message}\n`)
    return 1
  }

  write(1, `${line('후', ...after)}\n`)
  write(1, `디스크 파일 ${fmt(before[0])} -> ${fmt(after[0])}, 호스트 확보 ${fmt(after[2] - before[2])}\n`)
  const gap = gapBytes(after[0], after[1])
  if (gap > threshold) {
    write(2, `시도 ${attempt}회 뒤에도 차이 ${fmt(gap)} 가 남았다(기준값 ${fmt(threshold)}, 횟수 상한 ${maxAttempts}, 시간 상한 ${pyFixed(maxSeconds, 0)}초)\n`)
    return 2
  }
  return 0
}

if (isMain(import.meta.url, import.meta.main)) process.exitCode = main(process.argv.slice(2))
