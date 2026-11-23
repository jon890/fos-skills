import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isObject } from '../core/json.ts'
import type { LimitEvidence, LimitWindow } from '../core/model-limits.ts'
import { parseModel } from './model-generation.ts'
import { run } from './proc.ts'
import type { ClaudeAccount } from './worker-account.ts'

const AUTH_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'MINIMAX_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
]
const IDENTITY = /^[0-9a-f]{64}$/i

type Bucket = LimitWindow & { model?: string }
type IdentityReader = (account: ClaudeAccount) => string | null

function jsonObject(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function identityModule(home: string): string | null {
  const installed = jsonObject(join(home, 'plugins', 'installed_plugins.json'))
  if (!isObject(installed?.plugins)) return null
  const entries = Object.entries(installed.plugins)
    .filter(([key]) => key.startsWith('oh-my-claudecode@'))
    .flatMap(([, values]) => Array.isArray(values) ? values.filter(isObject) : [])
    .filter(entry => entry.scope === 'user' && typeof entry.installPath === 'string')
  const locations = new Set(entries.map(entry => entry.installPath as string))
  return locations.size === 1 ? join([...locations][0], 'dist', 'hud', 'usage-api.js') : null
}

export function readClaudeIdentity(account: ClaudeAccount): string | null {
  // 호출한 셸의 별도 인증 환경을 새 worker 에서 쓸 값으로 확인할 수 없다.
  if (AUTH_ENV.some(key => process.env[key])) return null
  const module = identityModule(account.home)
  if (!module) return null
  const env = Object.fromEntries(AUTH_ENV.map(key => [key, undefined]))
  const result = run([
    process.execPath, '--input-type=module', '-e',
    'const { getUsageCredentialIdentity } = await import(process.argv[1]); const id = getUsageCredentialIdentity(); if (typeof id === "string") process.stdout.write(id)',
    pathToFileURL(module).href,
  ], {
    env: { ...env, CLAUDE_CONFIG_DIR: account.configDir, NODE_OPTIONS: undefined, OMC_DEBUG: undefined },
    timeoutMs: 2500, killSignal: 'SIGKILL', maxBuffer: 4096,
  })
  return result.code === 0 && IDENTITY.test(result.stdout) ? result.stdout : null
}

function bucket(label: string, used: unknown, rawReset: unknown, model?: string): Bucket[] {
  const resetsAt = typeof rawReset === 'string' && /^\d{4}-\d\d-\d\dT/.test(rawReset) ? Date.parse(rawReset) : NaN
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || !Number.isFinite(resetsAt)) return []
  return [{ label, used, resetsAt, model }]
}

function scopedModel(raw: Record<string, unknown>): string | null {
  for (const hint of [raw.id, raw.label]) {
    if (typeof hint !== 'string') continue
    const model = hint.trim().toLowerCase()
    if (parseModel(model)?.provider === 'claude') return model
    const family = /^claude (opus|sonnet|haiku|fable)$/.exec(model)?.[1]
    if (family) return family
  }
  return null
}

export function readClaudeLimits(account: ClaudeAccount, identity: IdentityReader = readClaudeIdentity): (model: string) => LimitEvidence {
  const cache = jsonObject(join(account.home, 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'))
  if (!cache || !isObject(cache.data) || !Number.isFinite(cache.lastSuccessAt)) {
    return () => ({ windows: [], unknown: '사용량 캐시에서 마지막 성공 값을 읽지 못했다' })
  }
  if (typeof cache.credentialIdentity !== 'string' || !IDENTITY.test(cache.credentialIdentity) || cache.credentialIdentity !== identity(account)) {
    return () => ({ windows: [], unknown: '사용량 캐시가 이 계정의 인증으로 쓰였는지 확인하지 못했다' })
  }
  const data = cache.data
  const buckets = [
    ...bucket('주간', data.weeklyPercent, data.weeklyResetsAt),
    ...bucket('5시간', data.fiveHourPercent, data.fiveHourResetsAt),
    ...bucket('Sonnet 주간', data.sonnetWeeklyPercent, data.sonnetWeeklyResetsAt, 'sonnet'),
    ...bucket('Opus 주간', data.opusWeeklyPercent, data.opusWeeklyResetsAt, 'opus'),
  ]
  if (Array.isArray(data.scopedWeeklyBuckets)) {
    for (const raw of data.scopedWeeklyBuckets.filter(isObject)) {
      const model = scopedModel(raw)
      if (model) buckets.push(...bucket(`${model} 주간`, raw.percent, raw.resetsAt, model))
    }
  }
  return model => {
    const family = parseModel(model)?.family
    const windows = buckets.filter(window => !window.model || window.model === model || window.model === family)
    return windows.length ? { windows } : { windows, unknown: '이 모델에 적용할 한도 창이 없다' }
  }
}
