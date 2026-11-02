// 사람 단위 설정과 상태 파일을 읽고 쓴다.
//
// 설정: ${XDG_CONFIG_HOME:-~/.config}/fos-skills/inbox.json. INBOX_CONFIG 로 바꾼다. 없으면 기능이 꺼진다(R6)
// 상태: ${XDG_STATE_HOME:-~/.local/state}/fos-skills/inbox/. INBOX_STATE_DIR 로 바꾼다
//   cache.json      받은 항목, 받은 시각, 출처별 오류
//   dismissed.json  넘긴 항목 id 목록. 모든 저장소의 보드가 함께 쓴다(D11)
//   repos.json      보드가 연 저장소들의 필터 파일 경로 목록. 미분류 판정에 쓴다
//   last-ok.json    '<adapter>:<출처>' 마다 다 읽은 시각(커서). 다음 받기는 그 뒤만 읽는다
//   fetch.lock/     받기 잠금. 안의 owner 파일이 잡은 쪽의 표지라 자기 잠금만 푼다
//   <adapter>-*.json  adapter 의 캐시(이름, 업무 정보, 다시 읽을 대화방 등)
// 쓰기는 임시 파일에 쓴 뒤 rename 한다. 읽는 쪽이 반쯤 쓴 파일을 보지 않게 하려는 것이다.
// 사내 메시지 발췌가 들어 있어 폴더는 0700, 파일은 0600 으로 만든다.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

  private token = ''

  private lockDir(): string {
    return join(this.dir, 'fetch.lock')
  }

  // 받기 잠금을 잡으면 true. 이미 다른 세션이 받고 있으면 false 다
  lock(now: number): boolean {
    const dir = this.lockDir()
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      mkdirSync(dir)
    } catch {
      if (this.lockHeld(now)) return false
      rmSync(dir, { recursive: true, force: true })
      try {
        mkdirSync(dir)
      } catch {
        return false
      }
    }
    this.token = randomUUID()
    writeFileSync(join(dir, 'owner'), this.token, { mode: 0o600 })
    return true
  }

  // 다른 세션이 받고 있는지. 오래된 잠금은 없는 것으로 본다
  lockHeld(now: number): boolean {
    try {
      return now - statSync(this.lockDir()).mtimeMs < LOCK_STALE_MS
    } catch {
      return false
    }
  }

  // 받기가 길어질 때 잠금이 오래된 것으로 보이지 않게 시각을 새로 한다
  touchLock(): void {
    if (!this.token) return
    const now = new Date()
    try {
      utimesSync(this.lockDir(), now, now)
    } catch {
      // 잠금을 빼앗겼으면 할 것이 없다
    }
  }

  // 자기가 잡은 잠금만 푼다. 오래돼 다른 세션이 다시 잡은 잠금은 그대로 둔다
  unlock(): void {
    if (!this.token) return
    try {
      if (readFileSync(join(this.lockDir(), 'owner'), 'utf8') === this.token) rmSync(this.lockDir(), { recursive: true, force: true })
    } catch {
      // 잠금이 이미 없다
    }
    this.token = ''
  }
}
