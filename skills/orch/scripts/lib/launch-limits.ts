import { jsonEqual } from '../core/json.ts'
import type { LimitEvidence } from '../core/model-limits.ts'
import { readClaudeLimits } from './claude-limits.ts'
import { readCodexLimits } from './codex-limits.ts'
import { selectedClaudeAccount, selectedCodexAccount, type ClaudeAccount, type CodexAccount, type Provider } from './worker-account.ts'

type Accounts = { claude?: ClaudeAccount | null; codex?: CodexAccount }

export function launchLimits(remote: boolean, now: number) {
  const accounts: Accounts = {}
  const readers = new Map<Provider, (model: string) => LimitEvidence>()
  function codexAccount(): CodexAccount {
    return accounts.codex ??= selectedCodexAccount()
  }
  function claudeAccount(): ClaudeAccount | null {
    if (!Object.hasOwn(accounts, 'claude')) accounts.claude = selectedClaudeAccount()
    return accounts.claude ?? null
  }

  function reader(provider: Provider): (model: string) => LimitEvidence {
    const unknown = (reason: string) => () => ({ windows: [], unknown: reason })
    if (remote) return unknown('원격 worker 의 선택 계정을 확인할 수 없다')
    if (provider === 'claude') {
      const account = claudeAccount()
      return account ? readClaudeLimits(account) : unknown('Orca 의 선택 프로필을 확인하지 못했다')
    }
    const { home, creatorId } = codexAccount()
    return home && creatorId ? readCodexLimits(home, creatorId, now) : unknown('Orca 의 선택 계정과 기록의 귀속을 확인하지 못했다')
  }

  return {
    codexHome() {
      const fixed = process.env.ORCH_WORKER_CODEX_HOME
      return fixed === undefined ? codexAccount() : { home: fixed || null, failure: null }
    },
    read(provider: Provider, model: string): LimitEvidence {
      let resolve = readers.get(provider)
      if (!resolve) {
        resolve = reader(provider)
        readers.set(provider, resolve)
      }
      return resolve(model)
    },
    changed(): boolean {
      if (remote) return false
      const claudeChanged = Object.hasOwn(accounts, 'claude') && !jsonEqual(accounts.claude, selectedClaudeAccount())
      const codexChanged = accounts.codex !== undefined && !jsonEqual(accounts.codex, selectedCodexAccount())
      return claudeChanged || codexChanged
    },
  }
}
