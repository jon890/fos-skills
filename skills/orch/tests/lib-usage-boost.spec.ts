// lib/usage-boost.ts 의 판정을 고정 시각과 임시 사용량 파일로 본다. 실제 사용량 캐시는 읽지 않는다.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { decideBoost, readSelectionTable, readWeekly, sameGradeClaude, usageCacheFile, type Weekly } from '../scripts/lib/usage-boost.ts'
import type { Selection } from '../scripts/lib/spec.ts'

const NOW = Date.parse('2026-11-20T07:00:00.000Z')
const HOUR = 3_600_000
const TABLE = readSelectionTable()

function selection(row: string, agent: string, model: string, effort: string, outsideReason: string | null = null): Selection {
  return { row, agent, model, effort, outsideReason, no: 1, problems: [] }
}

function weekly(used: number, resetsIn: number): () => Weekly {
  return () => ({ kind: 'ok', used, resetsAt: NOW + resetsIn, at: NOW })
}

function decide(sel: Selection, w: () => Weekly, enabled = true) {
  return decideBoost({ selection: sel, enabled: () => enabled, weekly: w, now: NOW, table: TABLE })
}

describe('같은 등급 대응', () => {
  test('모델 표의 Codex 행은 「사용 한도에 걸렸을 때」 표의 첫 Claude 로 바뀐다', () => {
    assert.deepEqual(sameGradeClaude(TABLE, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }), { agent: 'claude', model: 'claude-opus-5-5', effort: 'medium' })
    assert.deepEqual(sameGradeClaude(TABLE, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' }), { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' })
  })

  test('표에 없는 모델은 대응이 없다', () => {
    assert.equal(sameGradeClaude(TABLE, { agent: 'codex', model: 'gpt-9', effort: 'low' }), null)
    assert.equal(sameGradeClaude('# 표 없음\n', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' }), null)
  })
})

describe('바꿀지 판정', () => {
  for (const [row, effort, model] of [
    ['impl-planned', 'low', 'claude-sonnet-5-5'],
    ['impl-explore', 'medium', 'claude-opus-5-5'],
    ['small-fix', 'low', 'claude-sonnet-5-5'],
    ['design', 'medium', 'claude-opus-5-5'],
  ] as const) {
    test(`기준 위면 바꾼다: ${row}`, () => {
      const boost = decide(selection(row, 'codex', 'gpt-6.1-sol', effort), weekly(22, 37 * HOUR))
      assert.equal(boost.kind, 'boost')
      if (boost.kind !== 'boost') return
      assert.deepEqual(boost.override, { row, agent: 'claude', model, effort, reason: '사용량: 남은 78%, 남은 시간 22%' })
    })
  }

  test('남은 사용량이 남은 시간과 같으면 바꾸지 않는다', () => {
    assert.deepEqual(decide(selection('impl-planned', 'codex', 'gpt-6.1-sol', 'low'), weekly(50, 84 * HOUR)), { kind: 'keep', notice: null })
  })

  test('남은 사용량이 남은 시간보다 적으면 바꾸지 않는다', () => {
    assert.deepEqual(decide(selection('impl-planned', 'codex', 'gpt-6.1-sol', 'low'), weekly(80, 120 * HOUR)), { kind: 'keep', notice: null })
  })

  for (const sel of [
    selection('visual', 'codex', 'gpt-6.1-terra', 'low'),
    selection('review', 'codex', 'gpt-6.1-sol', 'medium'),
    selection('impl-hard', 'claude', 'claude-fable-5-2', '기본'),
    selection('impl-planned', 'codex', 'gpt-6.1-sol', 'medium', '사용자 지정'),
  ]) {
    test(`바꾸지 않는 선택은 사용량을 읽지 않는다: ${sel.row} ${sel.outsideReason ?? ''}`, () => {
      const boost = decide(sel, () => assert.fail('사용량을 읽었다'))
      assert.deepEqual(boost, { kind: 'keep', notice: null })
    })
  }

  test('꺼져 있으면 사용량을 읽지 않는다', () => {
    const boost = decide(selection('design', 'codex', 'gpt-6.1-sol', 'medium'), () => assert.fail('사용량을 읽었다'), false)
    assert.deepEqual(boost, { kind: 'keep', notice: null })
  })

  test('사용량을 모르면 알림 줄만 낸다', () => {
    const boost = decide(selection('design', 'codex', 'gpt-6.1-sol', 'medium'), () => ({ kind: 'unknown', reason: '출처 없음: x' }))
    assert.deepEqual(boost, { kind: 'keep', notice: 'USAGE-UNKNOWN 출처 없음: x' })
  })
})

describe('사용량 읽기', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'usage-boost-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function file(body: unknown): string {
    const target = join(dir, 'usage.json')
    writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
    return target
  }

  test('상태 줄 캐시의 주간 사용 % 와 초기화 시각을 읽는다', () => {
    const target = file({ timestamp: NOW, lastSuccessAt: NOW - 5 * 60_000, data: { weeklyPercent: 22, weeklyResetsAt: '2026-11-21T20:59:59.886Z' }, error: false })
    assert.deepEqual(readWeekly(target, NOW), { kind: 'ok', used: 22, resetsAt: Date.parse('2026-11-21T20:59:59.886Z'), at: NOW - 5 * 60_000 })
  })

  test('1시간 안의 값은 받고 넘으면 오래된 값이다', () => {
    const fresh = file({ timestamp: NOW, lastSuccessAt: NOW - HOUR, data: { weeklyPercent: 1, weeklyResetsAt: '2026-11-21T00:00:00Z' } })
    assert.equal(readWeekly(fresh, NOW).kind, 'ok')
    const stale = file({ timestamp: NOW, lastSuccessAt: NOW - HOUR - 60_000, data: { weeklyPercent: 1, weeklyResetsAt: '2026-11-21T00:00:00Z' } })
    assert.deepEqual(readWeekly(stale, NOW), { kind: 'unknown', reason: '오래된 값: 61분 전에 갱신됐다' })
  })

  test('없거나 깨졌거나 값이 빠지면 이유를 낸다', () => {
    assert.match((readWeekly(join(dir, 'none.json'), NOW) as { reason: string }).reason, /^출처 없음: /)
    assert.match((readWeekly(file('{'), NOW) as { reason: string }).reason, /^읽지 못함: /)
    assert.match((readWeekly(file({ timestamp: NOW, data: {} }), NOW) as { reason: string }).reason, /^값 없음: /)
    assert.match((readWeekly(file({ timestamp: NOW, lastSuccessAt: NOW, error: true, data: { weeklyPercent: 1, weeklyResetsAt: '2026-11-21T00:00:00Z' } }), NOW) as { reason: string }).reason, /^값 없음: /)
  })

  test('429 로 timestamp 만 새로 쓰인 캐시는 lastSuccessAt 으로 오래된 값이다', () => {
    const target = file({ timestamp: NOW, lastSuccessAt: NOW - 2 * HOUR, error: false, data: { weeklyPercent: 10, weeklyResetsAt: '2026-11-21T00:00:00Z' } })
    assert.deepEqual(readWeekly(target, NOW), { kind: 'unknown', reason: '오래된 값: 120분 전에 갱신됐다' })
  })

  test('lastSuccessAt 이 없으면 timestamp 가 새것이어도 값 없음이다', () => {
    const target = file({ timestamp: NOW, data: { weeklyPercent: 10, weeklyResetsAt: '2026-11-21T00:00:00Z' } })
    assert.match((readWeekly(target, NOW) as { reason: string }).reason, /^값 없음: /)
  })

  test('초기화 시각이 지난 값은 쓰지 않는다', () => {
    const target = file({ timestamp: NOW, lastSuccessAt: NOW, data: { weeklyPercent: 1, weeklyResetsAt: '2026-11-20T06:00:00Z' } })
    assert.deepEqual(readWeekly(target, NOW), { kind: 'unknown', reason: '초기화 시각이 지난 값이다' })
  })

  test('출처 경로는 ORCH_CLAUDE_USAGE, 없으면 Claude 설정 폴더의 oh-my-claudecode 캐시다', () => {
    assert.equal(usageCacheFile({ ORCH_CLAUDE_USAGE: '/x/usage.json' }), '/x/usage.json')
    assert.equal(usageCacheFile({ CLAUDE_CONFIG_DIR: '/p/home' }), '/p/home/plugins/oh-my-claudecode/.usage-cache-anthropic.json')
  })
})
