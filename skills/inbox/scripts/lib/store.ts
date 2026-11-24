// 사람 단위 설정과 상태 파일을 읽고 쓴다.
//
// 설정: ${XDG_CONFIG_HOME:-~/.config}/fos-skills/inbox.json. INBOX_CONFIG 로 바꾼다. 없으면 기능이 꺼진다(R6)
// 상태: ${XDG_STATE_HOME:-~/.local/state}/fos-skills/inbox/. INBOX_STATE_DIR 로 바꾼다
//   source-cache.json  받은 항목, 출처별 시도 시각·성공 커서·오류
//   cache.json      이전 버전의 캐시. 새 캐시가 없을 때 읽는다
//   dismissed.json  넘긴 항목 id 목록. 모든 저장소의 보드가 함께 쓴다(D11)
//   repos.json      보드가 연 저장소들의 필터 파일 경로 목록. 미분류 판정에 쓴다
//   last-ok.json    옛 커서. 새 캐시에 해당 출처가 없을 때 읽는다
//   fetch-*.lock/   출처별 받기 잠금. cache-write.lock 은 캐시 갱신에만 쓴다
//   react-*.lock/   같은 항목에 리액션을 동시에 다는 것을 막는다
//   <adapter>-*.json  adapter 의 캐시(이름, 업무 정보, 다시 읽을 대화방 등)
// 쓰기는 임시 파일에 쓴 뒤 rename 한다. 읽는 쪽이 반쯤 쓴 파일을 보지 않게 하려는 것이다.
// 사내 메시지 발췌가 들어 있어 폴더는 0700, 파일은 0600 으로 만든다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { peek, withOwnerLock } from '../../../orch/scripts/lib/owner-lock.ts'
import { alive } from '../../../orch/scripts/lib/process.ts'
import type { AdapterConfig, Cache, InboxItem } from './model.ts'

export const DEFAULT_SIGNATURE = '🤖 이 메시지는 AI가 작성했고, 작성자가 검토했습니다.'
export const DEFAULT_INTERVAL_MINUTES = 5
export const DEFAULT_DAYS = 7

export type Config = {
  adapters: AdapterConfig[]
  taskIntervalMinutes?: number
  messengerIntervalMinutes: number
  days: number
  signature: string
  reactionEmoji: string
  defaultBoard: string | null
}

export type SourceState = { attemptedAt: string | null; cursor?: string; authError?: string; fullScan?: boolean }

export type CacheFile = {
  fetchedAt: string | null
  legacyFetchedAt: string | null
  sources: Record<string, SourceState>
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

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
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
    taskIntervalMinutes: positive(raw.taskIntervalMinutes) ?? positive(raw.intervalMinutes),
    messengerIntervalMinutes: positive(raw.messengerIntervalMinutes) ?? 1,
    days: positive(raw.days) ?? DEFAULT_DAYS,
    // 빈 문자열은 표기를 붙이지 않는다는 뜻이라 그대로 둔다(D7)
    signature: typeof raw.signature === 'string' ? raw.signature : DEFAULT_SIGNATURE,
    reactionEmoji: typeof raw.reactionEmoji === 'string' ? raw.reactionEmoji : '+1',
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 })
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
    const value = this.read<Partial<CacheFile> | null>('source-cache', null) ?? this.read<Partial<CacheFile> | null>('cache', null) ?? {}
    return {
      fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : null,
      legacyFetchedAt: value.sources ? value.legacyFetchedAt ?? null : value.fetchedAt ?? null,
      sources: value.sources ?? {},
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

  sourceState(key: string, cache: CacheFile): SourceState {
    return cache.sources[key] ?? {
      attemptedAt: cache.legacyFetchedAt,
      cursor: this.read<Record<string, string>>('last-ok', {})?.[key],
    }
  }

  private fetchLock(key: string): string {
    return join(this.dir, `fetch-${encodeURIComponent(key)}.lock`)
  }

  fetchHeld(key: string): boolean {
    const owner = peek(this.fetchLock(key))?.owner
    const match = /^(\d+) \S+$/.exec(owner ?? '')
    return match !== null && alive(Number(match[1]))
  }

  withFetchLock<T>(key: string, work: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    return withOwnerLock(this.fetchLock(key), work, { waitMs: 0 })
  }

  withReactionLock<T>(id: string, work: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    return withOwnerLock(join(this.dir, `react-${encodeURIComponent(id)}.lock`), work, { waitMs: 0 })
  }

  markAnswered(id: string): void {
    this.updateCache((cache) => {
      for (const row of cache.items) if (row.id === id) row.state = 'answered'
    })
  }

  updateCache(update: (cache: CacheFile) => void): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    withOwnerLock(join(this.dir, 'cache-write.lock'), () => {
      const cache = this.cache()
      update(cache)
      this.write('source-cache', cache)
    })
  }
}
