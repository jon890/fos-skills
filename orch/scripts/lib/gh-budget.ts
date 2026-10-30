// gh 실행 결과만 캐시한다. 인자와 응답은 호출 기록에 남기지 않는다.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { orchDir } from './paths.ts'
import type { RunResult } from './proc.ts'

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function option(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1]
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
      if (name.length === 2 && args[i].startsWith(name) && args[i].length > 2) return args[i].slice(2)
    }
  }
}

const READ_COMMANDS = new Set(['pr view', 'pr list', 'pr checks', 'run list', 'run view', 'repo view'])

function defaultTtl(args: string[]): number {
  let seconds = 60
  if (READ_COMMANDS.has(args.slice(0, 2).join(' '))) {
    if (args.includes('--watch') || args.includes('--web')) return 0
    if (args[0] === 'repo') seconds = 300
  } else if (args[0] === 'api') {
    const method = option(args, '-X', '--method')?.toUpperCase()
    const query = option(args, '-f', '-F', '--field', '--raw-field')
    const graphql = args.includes('graphql')
    if (args.some((arg) => arg === '--input' || arg.startsWith('--input='))) return 0
    if (graphql) {
      // query 파일, stdin, 축약 query, mutation 여부를 확신할 수 없으면 실행한다.
      const fields = args.filter((arg) => arg.startsWith('query='))
      if (fields.length !== 1 || !/^query=\s*(query\b|\{)/.test(fields[0]) || /\bmutation\b/.test(fields[0])) return 0
      if (method && method !== 'POST' && method !== 'GET') return 0
    } else if ((method && method !== 'GET') || (!method && query !== undefined) || args.includes('--input')) return 0
    if (args.some((arg) => arg.includes('/rules/branches/'))) seconds = 300
  } else return 0
  return seconds
}

function readOnly(args: string[]): boolean {
  if (READ_COMMANDS.has(args.slice(0, 2).join(' '))) return true
  if (args[0] !== 'api') return false
  if (args.includes('graphql')) return defaultTtl(args) > 0
  const method = option(args, '-X', '--method')?.toUpperCase()
  const hasBody = option(args, '-f', '-F', '--field', '--raw-field', '--input') !== undefined
  return (method ?? (hasBody ? 'POST' : 'GET')) === 'GET'
}

export function readTtl(args: string[]): number {
  const seconds = defaultTtl(args)
  if (seconds === 0 || process.env.ORCH_GH_CACHE === '0') return 0
  const override = Number(process.env.ORCH_GH_CACHE_TTL_SECONDS)
  return process.env.ORCH_GH_CACHE_TTL_SECONDS !== undefined && Number.isFinite(override) && override >= 0 ? override : seconds
}

export function pollSeconds(attempt: number, base = 60): number {
  const minimum = Math.min(300, Math.max(60, base))
  return Math.min(300, minimum * 2 ** Math.min(attempt, 10))
}

type Entry = { expires: number; generation: string; result: RunResult }
const roots = new Map<string, string>()

function cacheRoot(repo: string): string {
  const key = JSON.stringify([repo, process.env.ORCH_DIR])
  let root = roots.get(key)
  if (!root) { root = join(orchDir(repo), 'state', 'gh'); roots.set(key, root) }
  return root
}

function generation(root: string): string {
  try { return readFileSync(join(root, 'generation'), 'utf8') } catch { return '' }
}

function invalidate(root: string): void {
  try {
    const temporary = join(root, `generation.${randomUUID()}.tmp`)
    writeFileSync(temporary, randomUUID(), { mode: 0o600 })
    renameSync(temporary, join(root, 'generation'))
  } catch { /* 캐시 폴더를 쓸 수 없어도 호출 결과를 유지한다. */ }
}

export type BudgetOptions = {
  lockWaitMs?: number
  passthrough?: boolean
  cacheKey?: string
  ttlSeconds?: (result: RunResult) => number
  refresh?: boolean
}

export function budgetGh(args: string[], repo: string, identity: unknown, execute: () => RunResult, options: BudgetOptions = {}): RunResult {
  const start = Date.now()
  const root = cacheRoot(repo)
  const writable = !readOnly(args)
  const configuredTtl = process.env.ORCH_GH_CACHE_TTL_SECONDS
  const disabled = options.passthrough || process.env.ORCH_GH_CACHE === '0' || (configuredTtl !== undefined && Number(configuredTtl) === 0)
  const ttl = disabled || writable ? 0 : options.cacheKey && options.ttlSeconds ? 60 : readTtl(args)
  const key = digest(options.cacheKey ? [identity, args, options.cacheKey] : [identity, args])
  const file = join(root, 'cache', `${key}.json`)
  // 같은 저장소의 읽기를 묶는다. 쓰기는 세대 번호로 진행 중 읽기와 옛 응답을 무효화한다.
  const lock = join(root, 'lock')
  let locked = false
  let hit = false
  let result: RunResult
  let epoch = ''
  try {
    mkdirSync(join(root, 'cache'), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + (options.lockWaitMs ?? 65_000)
    while (ttl > 0) {
      try {
        mkdirSync(lock)
        locked = true
        writeFileSync(join(lock, 'pid'), String(process.pid))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'))
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0) } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ESRCH') rmSync(lock, { recursive: true, force: true })
            }
          }
        } catch { /* 잠금을 막 만든 프로세스가 pid 를 쓰기 전일 수 있다. */ }
        if (Date.now() >= deadline) throw new Error('gh cache lock timeout')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  } catch {
    // 캐시 폴더를 쓸 수 없어도 gh 호출은 계속한다.
  }
  try {
    epoch = generation(root)
    if (locked && ttl > 0 && !options.refresh) {
      try {
        const entry: Entry = JSON.parse(readFileSync(file, 'utf8'))
        if (entry.generation === epoch && entry.expires > Date.now() && entry.result && typeof entry.result.stdout === 'string' && typeof entry.result.code === 'number') {
          hit = true
          return result = entry.result
        }
      } catch { /* 없거나 깨진 캐시는 새로 읽는다. */ }
    }
    // 쓰기 실패도 서버에서 반영됐을 수 있다. 저장소 전체를 비워 PR 목록과 run 조회도 무효화한다.
    if (writable) {
      invalidate(root)
      try {
        rmSync(join(root, 'cache'), { recursive: true, force: true })
        mkdirSync(join(root, 'cache'), { mode: 0o700 })
      } catch { /* 저장소 쓰기 권한이 바뀌어도 gh 는 실행한다. */ }
    }
    result = execute()
    if (locked && ttl > 0 && (result.code === 0 || (args[0] === 'pr' && args[1] === 'checks' && result.code === 8))) {
      try {
        const temporary = `${file}.${randomUUID()}.tmp`
        writeFileSync(temporary, JSON.stringify({ expires: Date.now() + (options.ttlSeconds?.(result) ?? ttl) * 1000, generation: epoch, result }), { mode: 0o600 })
        renameSync(temporary, file)
      } catch { /* 캐시 저장 실패는 호출 성공을 바꾸지 않는다. */ }
    }
    return result
  } finally {
    // 쓰기가 끝나기 전에 시작한 읽기도 다음 호출에서 다시 조회하게 한다.
    if (!hit && writable) invalidate(root)
    if (locked) {
      try { rmSync(lock, { recursive: true, force: true }) } catch { /* 호출 결과를 유지한다. */ }
    }
    try {
      const now = new Date()
      mkdirSync(join(root, 'logs'), { recursive: true, mode: 0o700 })
      const command = args[0] === 'api' ? (args.includes('graphql') ? 'api graphql' : 'api') : args.slice(0, 2).join(' ')
      appendFileSync(join(root, 'logs', `${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ time: now.toISOString(), command, durationMs: Date.now() - start, cacheHit: hit }) + '\n', { mode: 0o600 })
    } catch { /* 기록 오류로 gh 결과를 바꾸지 않는다. */ }
  }
}
