import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  claudeGeneration, codexGeneration, compareGeneration, isCurrent, forgetCodexModels, parseCodexModels, parseModel, pinnedCheck, staleRows, readCodexModels, sameFamily, workerCodexHome, type CodexModel,
} from '../scripts/lib/model-generation.ts'
import { limitRowOf } from '../scripts/lib/limit-table.ts'

const TABLE = readFileSync(join(import.meta.dirname, '..', 'references', 'agent-selection.md'), 'utf8')
const model = (slug: string, description = 'Current model.', efforts = ['low', 'medium', 'high'], visibility = 'list'): CodexModel => ({ slug, visibility, description, efforts })

// 2026-11-20 이 머신의 `codex debug models`(Codex CLI 0.166.0) 가운데 표에 닿는 것
const TODAY: CodexModel[] = [
  model('gpt-6.2-sol', 'Fast, go-to model for coding and everyday work.'),
  model('gpt-6.2-astra', 'Our most capable model for complex coding and professional work.'),
  model('gpt-6.1-terra', 'Efficient model that excels at visual understanding and computer use.'),
  model('gpt-6.1-sol', 'Previous generation model for coding and everyday work.'),
  model('gpt-6-astra', 'Previous generation model for complex coding and professional work.'),
  model('gpt-6-sol', 'Legacy model for coding and everyday work.'),
  model('gpt-6-luna', 'Fast and affordable model for easier tasks.'),
  model('gpt-reserve', 'Fast and affordable agentic coding model.', ['low'], 'hide'),
]

describe('이름과 세대', () => {
  test('Codex 는 gpt-<세대>-<계열>, Claude 는 claude-<계열>-<세대> 이거나 계열 이름이다', () => {
    assert.deepEqual(parseModel('gpt-6.2-sol'), { provider: 'codex', family: 'sol', generation: [6, 2] })
    assert.deepEqual(parseModel('gpt-6-luna'), { provider: 'codex', family: 'luna', generation: [6] })
    assert.deepEqual(parseModel('claude-fable-5-2'), { provider: 'claude', family: 'fable', generation: [5, 2] })
    assert.deepEqual(parseModel('opus'), { provider: 'claude', family: 'opus', generation: null })
    for (const other of ['codex-auto-review', 'gpt-reserve', 'claude-unknown-1', '', null]) assert.equal(parseModel(other), null)
  })

  test('세대는 숫자 조각을 앞에서부터 비교하고 계열 이름만이면 가장 높다', () => {
    assert.ok(compareGeneration([6, 2], [6, 1]) > 0)
    assert.ok(compareGeneration([6], [6, 1]) < 0)
    assert.equal(compareGeneration([6, 0], [6]), 0)
    assert.ok(compareGeneration(null, [9]) > 0)
  })

  test('같은 제공자의 같은 계열이면 세대가 달라도 같은 모델로 본다', () => {
    assert.ok(sameFamily('gpt-6.1-sol', 'gpt-6.2-sol'))
    assert.ok(sameFamily('claude-opus-5-5', 'opus'))
    assert.ok(!sameFamily('gpt-6.2-sol', 'gpt-6.2-astra'))
    assert.ok(!sameFamily('gpt-6.2-sol', 'claude-sonnet-5-5'))
    assert.ok(sameFamily('custom', 'custom'))
    assert.ok(!sameFamily('custom', 'other'))
  })

  test('현재 세대는 목록에 보이고 설명이 Legacy 나 Previous generation 이 아닌 것이다', () => {
    assert.deepEqual(TODAY.filter(isCurrent).map(m => m.slug), ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna'])
  })

  test('codex debug models 출력에서 slug 와 effort 가 있는 항목만 읽는다', () => {
    const list = parseCodexModels(JSON.stringify({ models: [{ slug: 'a', visibility: 'list', description: 'd', supported_reasoning_levels: [{ effort: 'low' }, {}] }, { slug: 'b' }] }))
    assert.deepEqual(list, { models: [{ slug: 'a', visibility: 'list', description: 'd', efforts: ['low'] }], failure: null })
    assert.equal(parseCodexModels('{').failure, '의 출력이 JSON 이 아니었')
    assert.equal(parseCodexModels('{}').failure, '의 models 목록을 읽지 못했')
  })
})

describe('띄울 세대', () => {
  test('같은 계열의 더 높은 세대가 있으면 그 세대로 바꾼다', () => {
    assert.deepEqual(codexGeneration('gpt-6.1-sol', 'medium', TODAY), { from: 'gpt-6.1-sol', to: 'gpt-6.2-sol', reason: '같은 계열 새 세대' })
    assert.deepEqual(codexGeneration('gpt-6-sol', 'low', TODAY)?.to, 'gpt-6.2-sol')
  })

  test('이미 최신이거나 같은 계열이 목록에 없으면 바꾸지 않는다', () => {
    assert.equal(codexGeneration('gpt-6.2-sol', 'medium', TODAY), null)
    assert.equal(codexGeneration('gpt-6-luna', 'low', TODAY), null)
    assert.equal(codexGeneration('gpt-7-nova', 'low', TODAY), null)
    assert.equal(codexGeneration('custom', 'low', TODAY), null)
  })

  test('새 세대가 그 effort 를 지원하지 않으면 지원하는 세대로 띄운다', () => {
    const list = [model('gpt-6.2-sol', 'New.', ['low']), model('gpt-6.1-sol', 'Previous generation.', ['low', 'medium'])]
    // 받을 수 있는 세대 그대로 두고 이유만 남긴다(to 가 from 과 같다)
    assert.equal(codexGeneration('gpt-6.1-sol', 'medium', list)?.to, 'gpt-6.1-sol')
    assert.deepEqual(codexGeneration('gpt-6.2-sol', 'medium', list), { from: 'gpt-6.2-sol', to: 'gpt-6.1-sol', reason: 'gpt-6.2-sol 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다' })
  })

  test('Claude 는 세대가 붙은 이름을 계열 이름으로 바꾼다', () => {
    assert.deepEqual(claudeGeneration('claude-fable-5-2'), { from: 'claude-fable-5-2', to: 'fable', reason: '계열 이름으로 최신' })
    assert.equal(claudeGeneration('sonnet'), null)
    assert.equal(claudeGeneration('claude-other-1'), null)
  })
})

describe('낡은 표 행', () => {
  test('지금 표는 오늘 목록의 최신 세대라 낡은 행이 없다', () => {
    assert.deepEqual(staleRows(TABLE, TODAY), [])
  })

  test('표의 모델보다 높은 같은 계열의 현재 세대가 나오면 그 행을 낸다. 한도 표와 산문은 보지 않는다', () => {
    const next = [...TODAY, model('gpt-6.3-sol', 'Fast, go-to model.'), model('gpt-6.3-astra', 'Most capable.')]
    const rows = staleRows(TABLE, next)
    assert.ok(rows.some(r => r.row === 'impl-explore' && r.from === 'gpt-6.2-sol' && r.to === 'gpt-6.3-sol'))
    assert.ok(rows.every(r => /^[a-z-]+$/.test(r.row)))
    // 한 행에 같은 바꿈은 한 번이다(review 행은 Codex 칸 하나)
    assert.equal(rows.filter(r => r.row === 'review').length, 1)
  })

  test('현재 세대가 그 effort 를 지원하지 않으면 그 행은 내지 않는다. 띄울 때의 판정과 같다', () => {
    // 6.3 은 medium 만, 6.2 는 low 와 medium 을 지원한다
    const list = [model('gpt-6.3-sol', 'New.', ['medium']), model('gpt-6.2-sol', 'Current.', ['low', 'medium'])]
    const rows = staleRows(TABLE, list)
    assert.ok(rows.some(r => r.row === 'impl-explore'))
    assert.ok(!rows.some(r => r.row === 'impl-planned'))
    assert.equal(codexGeneration('gpt-6.2-sol', 'low', list)?.to, 'gpt-6.2-sol')
    assert.equal(codexGeneration('gpt-6.2-sol', 'medium', list)?.to, 'gpt-6.3-sol')
  })

  test('Previous generation 으로 표시된 더 높은 세대로는 올리지 않는다', () => {
    const list = [model('gpt-6.4-sol', 'Current.', ['medium']), model('gpt-6.3-sol', 'Previous generation model.', ['low']), model('gpt-6.2-sol', 'Previous generation model.', ['low', 'medium'])]
    const rows = staleRows(TABLE, list)
    assert.ok(!rows.some(r => r.row === 'impl-planned'))
    assert.ok(rows.some(r => r.row === 'impl-explore' && r.to === 'gpt-6.4-sol'))
  })
})

describe('계정', () => {
  test('Orca 가 새 Codex worker 에 쓸 계정 홈으로 모델 목록을 읽는다', (t) => {
    const dir = tempDir('model-home-', t)
    const saved = { ...process.env }
    t.after(() => { process.env = saved; forgetCodexModels() })
    const accounts = join(dir, 'accounts')
    mkdirSync(join(accounts, 'acct-1', 'home'), { recursive: true })
    process.env.ORCA_CODEX_ACCOUNTS = accounts
    delete process.env.ORCH_WORKER_CODEX_HOME
    process.env.ORCA = linkBin(dir, 'orca', `console.log(JSON.stringify({ ok: true, result: { codex: { activeAccountId: 'acct-1', accounts: [] } } }))`)
    // 가짜 codex 는 CODEX_HOME 을 모델 설명으로 돌려준다
    process.env.CODEX_BIN = linkBin(dir, 'codex', `console.log(JSON.stringify({ models: [{ slug: 'gpt-6.3-sol', visibility: 'list', description: process.env.CODEX_HOME || 'shell', supported_reasoning_levels: [{ effort: 'medium' }] }] }))`)
    forgetCodexModels()
    assert.deepEqual(workerCodexHome(), { home: join(accounts, 'acct-1', 'home'), failure: null })
    assert.equal(readCodexModels().models?.[0].description, join(accounts, 'acct-1', 'home'))
    assert.equal(codexGeneration('gpt-6.2-sol', 'medium', readCodexModels().models!)?.to, 'gpt-6.3-sol')
    // 조회하지 못하거나 관리 계정이 없으면 부른 셸 그대로다
    // system 계정을 고르면 부른 셸에 남은 CODEX_HOME 이 아니라 Codex 기본 홈으로 읽는다
    process.env.ORCA = linkBin(dir, 'orca-system', `console.log(JSON.stringify({ ok: true, result: { codex: { activeAccountId: null, accounts: [] } } }))`)
    process.env.CODEX_HOME = join(accounts, 'acct-1', 'home')
    process.env.ORCH_SYSTEM_CODEX_HOME = join(dir, 'system-home')
    forgetCodexModels()
    assert.deepEqual(workerCodexHome(), { home: join(dir, 'system-home'), failure: null })
    assert.equal(readCodexModels().models?.[0].description, join(dir, 'system-home'))
    // 계정을 조회하지 못하면 셸 계정으로 읽지 않고 목록을 읽지 못한 것으로 본다
    process.env.ORCA = linkBin(dir, 'orca-fail', 'process.exit(1)')
    forgetCodexModels()
    assert.match(workerCodexHome().failure ?? '', /Codex 계정을 확인하지 못했/)
    assert.equal(readCodexModels().models, null)
    process.env.ORCH_WORKER_CODEX_HOME = ''
    delete process.env.CODEX_HOME
    forgetCodexModels()
    assert.equal(readCodexModels().models?.[0].description, 'shell')
  })
})

describe('직접 고른 옛 세대', () => {
  function withCodex(t: { after(fn: () => void): void }, body: string): void {
    const dir = tempDir('pinned-', t)
    const saved = { ...process.env }
    t.after(() => { process.env = saved; forgetCodexModels() })
    process.env.ORCH_WORKER_CODEX_HOME = ''
    process.env.CODEX_BIN = linkBin(dir, 'codex', body)
    forgetCodexModels()
  }
  const list = (models: unknown[]) => `console.log(${JSON.stringify(JSON.stringify({ models }))})`
  const entry = (slug: string, efforts: string[], description = 'Current.') => ({ slug, visibility: 'list', description, supported_reasoning_levels: efforts.map(effort => ({ effort })) })

  test('계정 목록에 그 effort 를 지원하는 새 세대가 있으면 거절한다', (t) => {
    withCodex(t, list([entry('gpt-6.2-sol', ['low']), entry('gpt-6.1-sol', ['low'], 'Previous generation.')]))
    const pin = pinnedCheck('codex', 'gpt-6.1-sol', 'low', { known: [] })
    assert.equal(pin.kind, 'outdated')
    assert.match((pin as { message: string }).message, /^MODEL-OUTDATED gpt-6\.1-sol → gpt-6\.2-sol\n지시서를 새 세대로 고친다/)
  })

  test('목록 조회가 실패해도 감지 기록이 새 세대를 알면 거절하고, 모르면 확인하지 못했다고 알린다', (t) => {
    withCodex(t, 'process.exit(7)')
    const known = [model('gpt-6.2-sol', 'Fast.', ['low'])]
    const pin = pinnedCheck('codex', 'gpt-6.1-sol', 'low', { known })
    assert.equal(pin.kind, 'outdated')
    assert.match((pin as { message: string }).message, /감지 기록에 gpt-6\.2-sol 가 있다/)
    const unknown = pinnedCheck('codex', 'gpt-6.1-sol', 'low', { known: [] })
    assert.equal(unknown.kind, 'none')
    assert.match((unknown as { warning: string }).warning, /^MODEL-CHECK-SKIP 직접 고른 gpt-6\.1-sol 이 낡았는지 확인하지 못했다/)
  })

  test('새 세대를 알지만 계정이 받지 못하거나 effort 를 지원하지 않으면 그대로 두고 이유를 남긴다', (t) => {
    withCodex(t, list([entry('gpt-6.2-sol', ['low']), entry('gpt-6.1-sol', ['ultra'], 'Previous generation.')]))
    const effort = pinnedCheck('codex', 'gpt-6.1-sol', 'ultra', { known: [] })
    assert.deepEqual(effort, { kind: 'kept', generation: { from: 'gpt-6.1-sol', to: 'gpt-6.1-sol', reason: 'gpt-6.2-sol 가 effort ultra 를 지원하지 않아 gpt-6.1-sol 그대로 띄웠다' } })
    forgetCodexModels()
    process.env.CODEX_BIN = linkBin(tempDir('pinned-only-', t), 'codex', list([entry('gpt-6.1-sol', ['low'])]))
    const account = pinnedCheck('codex', 'gpt-6.1-sol', 'low', { known: [model('gpt-6.2-sol', 'Fast.', ['low'])] })
    assert.deepEqual(account, { kind: 'kept', generation: { from: 'gpt-6.1-sol', to: 'gpt-6.1-sol', reason: 'worker 계정 목록에 gpt-6.2-sol 가 없어 직접 고른 세대 그대로 띄웠다' } })
  })

  test('원격 worker 는 이 머신의 목록을 보지 않고 감지 기록만 본다', (t) => {
    withCodex(t, list([entry('gpt-6.2-sol', ['low'])]))
    assert.equal(pinnedCheck('codex', 'gpt-6.1-sol', 'low', { remote: true, known: [] }).kind, 'none')
    assert.equal(pinnedCheck('codex', 'gpt-6.1-sol', 'low', { remote: true, known: [model('gpt-6.2-sol', 'Fast.', ['low'])] }).kind, 'outdated')
  })
})

describe('한도 표의 대체 후보', () => {
  test('지금 표의 sol 은 medium·high 가 Opus, low 가 Sonnet 이고 옛 sol 은 같은 계열 줄로 찾는다', () => {
    assert.equal(limitRowOf(TABLE, { model: 'gpt-6.2-sol', effort: 'high' })?.cell, 'Claude Opus 5.5')
    assert.equal(limitRowOf(TABLE, { model: 'gpt-6.2-sol', effort: 'medium' })?.cell, 'Claude Opus 5.5 `medium`')
    assert.equal(limitRowOf(TABLE, { model: 'gpt-6.2-sol', effort: 'low' })?.cell, 'Claude Sonnet 5.5')
    assert.equal(limitRowOf(TABLE, { model: 'gpt-6.1-sol', effort: 'low' })?.cell, 'Claude Sonnet 5.5')
    assert.doesNotMatch(TABLE.split('### 사용 한도에 걸렸을 때')[1].split('###')[0], /gpt-6\.1-sol|`gpt-6-sol`/)
    assert.match(limitRowOf(TABLE, { model: 'claude-fable-5-2', effort: null })?.cell ?? '', /`gpt-6\.2-astra`/)
  })
})
