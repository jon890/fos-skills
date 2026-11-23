import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isObject } from '../core/json.ts'
import { homeOf, profilesRoot } from './claude-profile.ts'
import { orcaJson } from './orca.ts'

export type Provider = 'claude' | 'codex'
type AccountList = { id: string | null; accounts: Record<string, unknown>[]; result: Record<string, unknown> }
export type ClaudeAccount = { id: string | null; home: string; configDir: string | undefined }
export type CodexAccount = { id: string | null; home: string | null; creatorId: string | null; failure: string | null }

const accountId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]+$/.test(value)

export function parseAccountList(data: unknown, provider: Provider): AccountList | null {
  if (!isObject(data)) return null
  const result = Object.hasOwn(data, provider) ? data[provider] : data
  if (!isObject(result)) return null
  const runtime = result.activeAccountIdsByRuntime
  if (Object.hasOwn(result, 'activeAccountIdsByRuntime') && !isObject(runtime)) return null
  const id = isObject(runtime) && Object.hasOwn(runtime, 'host') ? runtime.host : result.activeAccountId
  if (id !== null && !accountId(id)) return null
  const accounts = Array.isArray(result.accounts) ? result.accounts.filter(isObject) : []
  return { id, accounts, result }
}

function list(provider: Provider): AccountList | null {
  const response = orcaJson<unknown>(['account', 'list', '--agent', provider], { timeoutMs: 10_000 })
  return response.ok ? parseAccountList(response.data, provider) : null
}

function absoluteHome(value: string): string | null {
  if (isAbsolute(value)) return resolve(value)
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2))
  return null
}

function providerId(account: Record<string, unknown>): string | null {
  const { workspaceAccountId: workspace, providerAccountId: provider } = account
  if ((workspace != null && !accountId(workspace)) || (provider != null && !accountId(provider))) return null
  if (workspace && provider && workspace !== provider) return null
  return (workspace ?? provider ?? null) as string | null
}

export function selectedCodexAccount(): CodexAccount {
  const selected = list('codex')
  const fail = (failure: string): CodexAccount => ({ home: null, id: null, creatorId: null, failure })
  if (!selected) return fail('Orca 가 새 worker 에 쓸 Codex 계정을 확인하지 못했')
  const { id, accounts, result } = selected
  const system = isObject(result.systemDefault) ? result.systemDefault : {}
  const chosen = id === null ? [system] : accounts.filter(a => a.id === id)
  const home = id === null ? process.env.ORCH_SYSTEM_CODEX_HOME || join(homedir(), '.codex')
    : join(process.env.ORCA_CODEX_ACCOUNTS || join(homedir(), 'Library/Application Support/Orca/codex-accounts'), id, 'home')
  if (id !== null && !existsSync(home)) return fail('Orca 의 Codex 계정 홈을 찾지 못했')
  const creator = chosen.length === 1 ? providerId(id === null ? { providerAccountId: chosen[0].providerAccountId } : chosen[0]) : null
  // 하나의 세션 생성 ID 를 둘 이상의 Orca 계정이 쓰면 기록의 실제 계정을 알 수 없다.
  const others = id === null ? accounts : [...accounts.filter(a => a.id !== id), system]
  const duplicate = creator !== null && others.some(a => a.workspaceAccountId === creator || a.providerAccountId === creator)
  return { home, id, creatorId: duplicate ? null : creator, failure: null }
}

export function selectedClaudeAccount(root = profilesRoot()): ClaudeAccount | null {
  const selected = list('claude')
  if (!selected) return null
  const { id, accounts, result } = selected
  const matches = accounts.filter(a => a.id === id)
  const managed = matches.length === 1 ? matches[0] : undefined
  if (id !== null && managed?.authMethod !== 'subscription-oauth') return null
  const home = id === null ? result.systemDefaultHome : managed?.home
  // 시스템 기본 실행은 Orca 가 CLAUDE_CONFIG_DIR 을 넣지 않는 표준 홈만 확인할 수 있다.
  if (typeof home !== 'string' || !home.trim()) return null
  const fileHome = absoluteHome(home)
  if (!fileHome || (id === null && home !== join(homedir(), '.claude'))) return null
  try {
    const marker = readFileSync(join(root, 'selected-host'), 'utf8').trim()
    const markedHome = absoluteHome(marker) ?? (accountId(marker) ? resolve(homeOf(root, marker)) : null)
    if (marker && markedHome !== fileHome) return null
    if (!marker && id !== null) return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  return { id, home: fileHome, configDir: id === null ? undefined : home }
}
