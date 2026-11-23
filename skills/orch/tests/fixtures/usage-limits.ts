import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CREATOR = 'creator-codex'
export const CREDENTIAL_ID = 'a'.repeat(64)

export function rollout(
  home: string, name: string, events: unknown[], date = '2026/01/01',
): string {
  const file = join(home, 'sessions', date, `rollout-${name}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return file
}

export const session = (creator = CREATOR) => ({ type: 'session_meta', payload: { creator_account_id: creator } })
export const turn = (type: string) => ({ type: 'event_msg', payload: { type } })
export const token = (timestamp: string, rate_limits: unknown) => ({ timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits } })
export const window = (used_percent: number, resets_at: number, window_minutes = 10080) => ({ used_percent, resets_at, window_minutes })

export function codexUsage(home: string, used: number, creator = CREATOR): string {
  const reset = Math.ceil(Date.now() / 1000) + 3600
  rollout(home, 'current', [session(creator), turn('task_started'), token(new Date().toISOString(), { limit_id: 'codex', primary: window(used, reset) })])
  return new Date(reset * 1000).toISOString()
}

export function claudeProfile(root: string, used: number, extra: Record<string, unknown> = {}) {
  const id = 'claude-profile'
  const home = join(root, id, 'home')
  const shared = join(root, 'shared-plugins')
  const cache = join(shared, 'oh-my-claudecode', '.usage-cache-anthropic.json')
  const plugin = join(root, 'fake-omc')
  mkdirSync(home, { recursive: true })
  mkdirSync(dirname(cache), { recursive: true })
  mkdirSync(join(plugin, 'dist', 'hud'), { recursive: true })
  symlinkSync(shared, join(home, 'plugins'), 'dir')
  writeFileSync(join(home, 'settings.json'), '{}')
  writeFileSync(join(root, 'selected-host'), home)
  writeFileSync(join(shared, 'installed_plugins.json'), JSON.stringify({
    plugins: { 'oh-my-claudecode@fake': [{ scope: 'user', installPath: plugin }] },
  }))
  writeFileSync(join(plugin, 'dist', 'hud', 'usage-api.js'),
    `export function getUsageCredentialIdentity() { return process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(home)} ? '${CREDENTIAL_ID}' : null }`)
  writeFileSync(cache, JSON.stringify({
    credentialIdentity: CREDENTIAL_ID,
    lastSuccessAt: Date.now() - 2 * 60 * 60 * 1000,
    data: { weeklyPercent: used, weeklyResetsAt: new Date(Date.now() + 3600_000).toISOString(), ...extra },
  }))
  return { activeAccountId: id, accounts: [{ id, home, authMethod: 'subscription-oauth' }] }
}
