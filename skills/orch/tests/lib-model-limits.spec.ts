import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { chooseWithinLimits, exhaustedWindows, refusalLines } from '../scripts/core/model-limits.ts'
import { readClaudeIdentity, readClaudeLimits } from '../scripts/lib/claude-limits.ts'
import { readCodexLimits } from '../scripts/lib/codex-limits.ts'
import { parseAccountList } from '../scripts/lib/worker-account.ts'
import { claudeProfile, CREDENTIAL_ID, CREATOR, rollout, session, token, turn, window } from './fixtures/usage-limits.ts'

const now = Date.now()
const future = Math.ceil(now / 1000) + 3600
const time = (delta: number) => new Date(now + delta).toISOString()
const iso = new Date(now).toISOString()
const started = turn('task_started')

test('99.9%, 100%, 걸림 표시와 초기화 경계를 구분한다', () => {
  const evaluate = (used: number | null, reset: number, reached = false) => exhaustedWindows([{ label: '주간', used, resetsAt: reset, reached }], now).length
  assert.equal(evaluate(99.9, now + 1), 0)
  assert.equal(evaluate(100, now + 1), 1)
  assert.equal(evaluate(100, now), 0)
  assert.equal(evaluate(100, now - 1), 0)
  assert.equal(evaluate(null, now + 1, true), 1)
  assert.equal(evaluate(null, NaN, true), 0)
})

test('같은 등급 순서를 따르고 쓸 후보가 없으면 모든 초기화 시각을 반환한다', () => {
  const model = (name: string) => ({ model: name })
  const candidates = ['a', 'b', 'c', 'd'].map(model)
  const [a, b, c] = candidates
  const read = ({ model }: { model: string }) => ({ windows: model === 'c' ? [] : [
    { label: '5시간', used: 100, resetsAt: now + 1 },
    { label: '주간', used: 100, resetsAt: now + 20 },
  ] })
  const checked: string[] = []
  const chose = chooseWithinLimits(a, () => candidates.slice(1), value => { checked.push(value.model); return read(value) }, now)
  assert.deepEqual(chose, { chosen: c, reason: `한도: a 주간 100%, ${time(20)}` })
  assert.deepEqual(checked, ['a', 'b', 'c'])
  for (const others of [[], [b]]) {
    const blocked = chooseWithinLimits(a, () => others, read, now)
    assert.ok('blocked' in blocked)
    const lines = refusalLines(blocked.blocked)
    assert.equal(lines.length, 3 + others.length * 2)
    assert.equal(lines.at(-1), `USAGE-RESET 가장 먼저 풀리는 시각 ${time(1)}`)
  }
})

test('Orca host 선택의 null 과 필드 누락을 구분한다', () => {
  const managed = { id: 'host-profile' }
  assert.deepEqual(parseAccountList({ codex: { activeAccountId: 'old', activeAccountIdsByRuntime: { host: 'host-profile' }, accounts: [managed] } }, 'codex')?.accounts, [managed])
  assert.equal(parseAccountList({ activeAccountId: 'old', activeAccountIdsByRuntime: { host: 'host-profile' } }, 'codex')?.id, 'host-profile')
  assert.equal(parseAccountList({ activeAccountId: 'old', activeAccountIdsByRuntime: { host: null } }, 'codex')?.id, null)
  assert.equal(parseAccountList({ accounts: [] }, 'codex'), null)
  assert.equal(parseAccountList({ activeAccountId: 7 }, 'claude'), null)
})

test('Claude 공유 캐시의 계정 귀속, 오래된 성공 값과 모델별 창을 확인한다', t => {
  const root = tempDir('claude-limits-', t)
  const { accounts: [{ home, id }] } = claudeProfile(root, 20, {
    fiveHourPercent: 100, fiveHourResetsAt: time(-10_000),
    sonnetWeeklyPercent: 100, sonnetWeeklyResetsAt: time(480_000),
    scopedWeeklyBuckets: [
      { id: 'fable', percent: 100, resetsAt: time(490_000), isActive: false },
      { id: 'opus', percent: 30, resetsAt: time(500_000), isActive: true },
      { id: 'unknown', percent: 100, resetsAt: time(500_000) },
    ],
  })
  const file = join(home, 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), error: true }))
  const account = { id, home, configDir: home }
  const read = readClaudeLimits(account, () => CREDENTIAL_ID)
  assert.deepEqual(exhaustedWindows(read('claude-sonnet-5-5').windows, now).map(w => w.label), ['Sonnet 주간'])
  assert.deepEqual(exhaustedWindows(read('fable').windows, now).map(w => w.label), ['fable 주간'])
  assert.deepEqual(exhaustedWindows(read('opus').windows, now), [])
  assert.ok(readClaudeLimits(account, () => 'b'.repeat(64))('fable').unknown)
  const module = join(root, 'fake-omc', 'dist', 'hud', 'usage-api.js')
  assert.match(readFileSync(module, 'utf8'), /CLAUDE_CONFIG_DIR/)
  writeFileSync(module, `export function getUsageCredentialIdentity() {
    return process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(home + '/')} ? '${CREDENTIAL_ID}' : null
  }`)
  assert.equal(readClaudeIdentity({ ...account, configDir: home + '/' }), CREDENTIAL_ID)
  const key = 'CLAUDE_CODE_OAUTH_TOKEN'
  const original = process.env[key]
  process.env[key] = 'fake-override'
  try { assert.equal(readClaudeIdentity(account), null) } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

test('Codex 는 선택 계정의 첫 턴에서 창 길이별 최신 값만 읽는다', t => {
  const root = tempDir('codex-limits-', t)
  rollout(root, 'first', [
    session(), started,
    token(time(-10_000), { limit_id: 'codex', primary: window(100, future), secondary: window(100, future, 300) }),
    turn('task_complete'), started, token(iso, { primary: window(100, future) }),
  ], '2000/01/01')
  const second = rollout(root, 'second', [
    session(), started,
    token(time(-2000), { limit_id: 'codex', primary: window(99.9, future), secondary: window(88, future, 5) }),
    token(time(-1000), { limit_id: 'codex', primary: window(0, future, 5), secondary: { window_minutes: 10080 } }),
  ])
  appendFileSync(second, '{"type":')
  rollout(root, 'other', [session('other-account'), started, token(iso, { primary: window(100, future) })])
  rollout(root, 'no-turn', [session(), token(iso, { primary: window(100, future) })])
  rollout(root, 'missing-creator', [{ type: 'session_meta', payload: {} }, started, token(iso, { primary: window(100, future) })])
  const read = readCodexLimits(root, CREATOR, now)
  const windows = read('gpt-6.2-sol').windows
  assert.deepEqual(windows.map(({ label, used }) => [label, used]).sort(), [['5시간', 100], ['주간', 99.9]])
  assert.ok(readCodexLimits(root, CREATOR, now, { bytes: 4, milliseconds: 3000 })('gpt-6.2-sol').unknown?.includes('탐색 한도'))
  assert.ok(readCodexLimits(root, CREATOR, now, { bytes: 100000, milliseconds: 0 })('gpt-6.2-sol').unknown?.includes('탐색 한도'))
})

test('Codex 모델 전용 값과 걸림 표시는 적용 대상을 확인한다', t => {
  const root = tempDir('codex-scoped-', t)
  rollout(root, 'limits', [session(), started,
    token(iso, { limit_id: 'codex', primary: window(0, future), rate_limit_reached_type: 'workspace_owner_credits_depleted' }),
    token(iso, { limit_id: 'codex_bengalfox', limit_name: 'GPT-5.3-Codex-Spark', secondary: window(99, future), rate_limit_reached_type: 'rate_limit_reached' }),
    token(iso, { limit_id: 'base_model_inference', limit_name: 'gpt-reserve', primary: window(100, future) }),
    token(iso, { limit_id: 'codex_other', primary: window(100, future) }),
  ])
  const read = readCodexLimits(root, CREATOR, now)
  assert.equal(exhaustedWindows(read('gpt-6-luna').windows, now).length, 0)
  assert.equal(exhaustedWindows(read('gpt-5.3-codex-spark').windows, now).length, 1)
  assert.equal(exhaustedWindows(read('gpt-reserve').windows, now).length, 1)
  assert.ok(read('gpt-5.3-codex-sonic').unknown)
})
