// 사람 단위 설정과 상태 파일을 읽고 쓴다.
//
// 설정: ${XDG_CONFIG_HOME:-~/.config}/fos-skills/inbox.json. INBOX_CONFIG 로 바꾼다. 없으면 기능이 꺼진다(R6)
// 상태: ${XDG_STATE_HOME:-~/.local/state}/fos-skills/inbox/. INBOX_STATE_DIR 로 바꾼다
//   cache.json      받은 항목, 받은 시각, 출처별 오류
//   dismissed.json  넘긴 항목 id 목록. 모든 저장소의 보드가 함께 쓴다(D11)
//   repos.json      필터 파일을 가진 저장소(주 checkout 경로) 목록. 미분류 판정에 쓴다
//   fetch.lock/     받기 잠금. 여러 세션이 동시에 받지 않게 한다
//   <adapter>-*.json  adapter 의 캐시(이름, 업무 정보 등)
// 쓰기는 임시 파일에 쓴 뒤 rename 한다. 읽는 쪽이 반쯤 쓴 파일을 보지 않게 하려는 것이다.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdapterConfig, Cache, InboxItem } from './model.ts'

export const DEFAULT_SIGNATURE = '🤖 이 메시지는 AI가 작성했고, 작성자가 검토했습니다.'
export const DEFAULT_INTERVAL_MINUTES = 5
export const DEFAULT_DAYS = 7
// 이보다 오래된 잠금은 죽은 세션이 남긴 것으로 보고 다시 잡는다
export const LOCK_STALE_MS = 10 * 60 * 1000

export type Config = {
  adapters: AdapterConfig[]
  intervalMinutes: number
  days: number
  signature: string
  defaultBoard: string | null
}

export type CacheFile = {
  fetchedAt: string | null
  items: InboxItem[]
  errors: Record<string, string>
}

function home(): string {
  return process.env.HOME || homedir()
}

export function configPath(): string {
  if (process.env.INBOX_CONFIG) return process.env.INBOX_CONFIG
  return join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'fos-skills', 'inbox.json')
}

export function stateDir(): string {
  if (process.env.INBOX_STATE_DIR) return process.env.INBOX_STATE_DIR
  return join(process.env.XDG_STATE_HOME || join(home(), '.local', 'state'), 'fos-skills', 'inbox')
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

// 설정이 없으면 null. JSON 이 아니거나 adapters 가 목록이 아니면 던진다
export function readConfig(path = configPath()): Config | null {
  if (!existsSync(path)) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (!Array.isArray(raw.adapters)) throw new Error(`${path} 의 adapters 는 목록이어야 한다`)
  const adapters = raw.adapters.filter((entry): entry is AdapterConfig =>
    typeof entry === 'object' && entry !== null && typeof (entry as AdapterConfig).type === 'string')
  return {
    adapters,
    intervalMinutes: positive(raw.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
    days: positive(raw.days, DEFAULT_DAYS),
    // 빈 문자열은 표기를 붙이지 않는다는 뜻이라 그대로 둔다(D7)
    signature: typeof raw.signature === 'string' ? raw.signature : DEFAULT_SIGNATURE,
    defaultBoard: typeof raw.defaultBoard === 'string' && raw.defaultBoard ? raw.defaultBoard : null,
  }
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`)
  renameSync(tmp, path)
}

export class Store implements Cache {
  readonly dir: string

  constructor(dir = stateDir()) {
    this.dir = dir
  }

  path(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  read<T>(name: string, fallback: T): T {
    return readJson(this.path(name), fallback)
  }

  write(name: string, value: unknown): void {
    writeJson(this.path(name), value)
  }

  cache(): CacheFile {
    const value = this.read<Partial<CacheFile>>('cache', {})
    return {
      fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : null,
      items: Array.isArray(value.items) ? value.items : [],
      errors: value.errors && typeof value.errors === 'object' ? value.errors : {},
    }
  }

  dismissed(): Set<string> {
    return new Set(this.read<string[]>('dismissed', []))
  }

  repos(): string[] {
    return this.read<string[]>('repos', [])
  }

  // 받기 잠금을 잡으면 true. 이미 다른 세션이 받고 있으면 false 다
  lock(now: number): boolean {
    const dir = join(this.dir, 'fetch.lock')
    mkdirSync(this.dir, { recursive: true })
    try {
      mkdirSync(dir)
      return true
    } catch {
      try {
        if (now - statSync(dir).mtimeMs < LOCK_STALE_MS) return false
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir)
        return true
      } catch {
        return false
      }
    }
  }

  // 다른 세션이 받고 있는지. 오래된 잠금은 없는 것으로 본다
  lockHeld(now: number): boolean {
    try {
      return now - statSync(join(this.dir, 'fetch.lock')).mtimeMs < LOCK_STALE_MS
    } catch {
      return false
    }
  }

  unlock(): void {
    rmSync(join(this.dir, 'fetch.lock'), { recursive: true, force: true })
  }
}
