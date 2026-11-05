// 테스트 파일의 전후 시간과 child_process 기동 수를 같은 방법으로 잰다. PR 본문에 붙일 markdown 표를 낸다.
//
// 사용법: node modules/testkit/measure.ts --before <커밋> --after <커밋> [--runs N] <테스트 파일...>
//   cwd 는 저장소 루트다. 두 커밋은 `git archive` 로 임시 폴더에 풀고, 이 명령은 작업 트리에서 돈다.
//   --before, --after  비교할 커밋(필수)
//   --runs N           파일마다 전후를 번갈아 돌릴 횟수(기본 3). 시간은 성공한 실행의 가운데 값(초)이다
// 기동 수: 사본의 `delete <무엇>.NODE_OPTIONS` 줄을 지우고 preload 를 `NODE_OPTIONS=--import` 로 걸어
//   node 프로세스가 spawn, spawnSync, execFile, execFileSync, exec, execSync 로 띄운 수를 센다. 파일마다 한 번 잰다.
// 종료 코드: 0 측정 끝, 1 측정 중 테스트 실패가 있음(기동 수를 세는 실행의 실패 포함, 그 칸에 적는다), 2 인자 오류나 실행 오류.
//
// 표 위에 두 커밋의 짧은 SHA 와 load average 를 적는다. 부하가 높으면 시간은 비율로 본다. 기동 수는 부하와 무관하다.
// stdout 에 node:test 요약이 붙지 않도록 temp.ts, git.ts 를 거치지 않고 command.ts 만 쓴다.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './command.ts'

const RUN_TIMEOUT_MS = 600_000
const NODE_OPTIONS_LINE = /^\s*delete\s+[\w.]+\.NODE_OPTIONS\s*;?\s*$/m

const PRELOAD = `import cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const log = process.env.TESTKIT_MEASURE_LOG
let inside = false
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const original = cp[name]
  cp[name] = function (...args) {
    // exec 가 안에서 execFile 을 부르는 것처럼 한 호출이 다른 호출을 거치면 한 번만 센다
    if (inside) return original.apply(this, args)
    inside = true
    try {
      appendFileSync(log, JSON.stringify({ pid: process.pid, name, args: args.slice(0, 2) }) + '\\n')
      return original.apply(this, args)
    } finally {
      inside = false
    }
  }
}
syncBuiltinESMExports()
`

class UsageError extends Error {}

type Args = { before: string; after: string; runs: number; files: string[] }

function parseArgs(argv: string[]): Args {
  let before = ''
  let after = ''
  let runs = 3
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--before' || arg === '--after' || arg === '--runs') {
      const value = argv[++i]
      if (value === undefined) throw new UsageError(`${arg} 에 값이 없다`)
      if (arg === '--before') before = value
      else if (arg === '--after') after = value
      else {
        runs = Number(value)
        if (!Number.isInteger(runs) || runs < 1) throw new UsageError(`--runs 는 1 이상의 정수다: ${value}`)
      }
    } else if (arg.startsWith('-')) {
      throw new UsageError(`모르는 옵션: ${arg}`)
    } else files.push(arg)
  }
  if (!before || !after) throw new UsageError('--before 와 --after 가 필요하다')
  if (!files.length) throw new UsageError('테스트 파일이 없다')
  return { before, after, runs, files }
}

function gitOut(args: string[]): string {
  const done = spawnSync('git', args, { encoding: 'utf8' })
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${done.stderr}`)
  return done.stdout.trim()
}

function extract(commit: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  const archive = spawnSync('git', ['archive', commit], { maxBuffer: 1 << 30 })
  if (archive.status !== 0) throw new Error(`git archive ${commit} 실패: ${archive.stderr}`)
  const untar = spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout })
  if (untar.status !== 0) throw new Error(`tar 실패: ${untar.stderr}`)
}

// 테스트가 자식 환경에서 NODE_OPTIONS 를 지우는 줄을 없애 preload 가 모든 node 프로세스에 닿게 한다
function stripNodeOptionsDeletes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath ?? dir, entry.name)
    if (entry.isDirectory()) stripNodeOptionsDeletes(path)
    else if (entry.name.endsWith('.ts')) {
      const text = readFileSync(path, 'utf8')
      if (NODE_OPTIONS_LINE.test(text)) writeFileSync(path, text.replace(new RegExp(NODE_OPTIONS_LINE, 'gm'), ''))
    }
  }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function timeRun(copy: string, file: string): { seconds: number; ok: boolean } {
  const start = process.hrtime.bigint()
  const done = runCommand([process.execPath, '--test', file], { cwd: copy, timeoutMs: RUN_TIMEOUT_MS })
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  return { seconds, ok: done.code === 0 && !done.timedOut }
}

function countSpawns(copy: string, file: string, preload: string, log: string): { count: number; ok: boolean } {
  rmSync(log, { force: true })
  const done = runCommand([process.execPath, '--test', file], {
    cwd: copy,
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, TESTKIT_MEASURE_LOG: log },
    timeoutMs: RUN_TIMEOUT_MS,
  })
  const count = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  return { count, ok: done.code === 0 && !done.timedOut }
}

function main(argv: string[]): number {
  const args = parseArgs(argv)
  const shortBefore = gitOut(['rev-parse', '--short', args.before])
  const shortAfter = gitOut(['rev-parse', '--short', args.after])
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'testkit-measure-')))
  try {
    const sides = { before: join(tmp, 'before'), after: join(tmp, 'after') }
    const counted = { before: join(tmp, 'before-count'), after: join(tmp, 'after-count') }
    for (const side of ['before', 'after'] as const) {
      const commit = side === 'before' ? args.before : args.after
      extract(commit, sides[side])
      extract(commit, counted[side])
      stripNodeOptionsDeletes(counted[side])
    }
    const preload = join(tmp, 'preload.mjs')
    writeFileSync(preload, PRELOAD)
    const log = join(tmp, 'spawns.jsonl')

    const rows: string[] = []
    let failed = false
    for (const file of args.files) {
      const times = { before: [] as number[], after: [] as number[] }
      const fails = { before: 0, after: 0 }
      for (let i = 0; i < args.runs; i++) {
        for (const side of ['before', 'after'] as const) {
          const r = timeRun(sides[side], file)
          if (r.ok) times[side].push(r.seconds)
          else fails[side]++
        }
      }
      const spawns = { before: countSpawns(counted.before, file, preload, log), after: countSpawns(counted.after, file, preload, log) }
      const countFailed = !spawns.before.ok || !spawns.after.ok
      if (fails.before || fails.after || countFailed) failed = true
      const fmt = (v: number | null) => (v === null ? '-' : v.toFixed(2))
      const parts: string[] = []
      if (fails.before || fails.after) parts.push(`전 ${fails.before}/${args.runs}, 후 ${fails.after}/${args.runs}`)
      if (countFailed) parts.push(`기동 수 계측 실패(${[!spawns.before.ok && '전', !spawns.after.ok && '후'].filter(Boolean).join(', ')})`)
      const failCell = parts.length ? parts.join('; ') : '0'
      rows.push(`| ${file} | ${fmt(median(times.before))} | ${fmt(median(times.after))} | ${spawns.before.count} | ${spawns.after.count} | ${failCell} |`)
    }
    const load = loadavg().map((v) => v.toFixed(2)).join(' ')
    console.log(`전 ${shortBefore}, 후 ${shortAfter}, load average ${load}, 실행 ${args.runs}회`)
    console.log('')
    console.log('| 파일 | 전 시간(s) | 후 시간(s) | 전 기동 수 | 후 기동 수 | 실패 |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const row of rows) console.log(row)
    return failed ? 1 : 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`measure: ${(error as Error).message}`)
  process.exitCode = 2
}
