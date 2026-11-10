import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAdd, applyCancel, applyUsed, checkVerdict, emptyFile, formatLine, latest, parseFile, prune, signalMatches, validateAdd, waitedText } from '../scripts/core/approvals.ts'
import type { AddInput, Approval, ApprovalKind, CheckFacts } from '../scripts/core/approvals.ts'
const now = new Date('2026-11-10T12:00:00Z')
function input(kind: ApprovalKind = 'post'): AddInput {
  return { id: 'demo', kind, title: '제목', run: 'R', terminal: 'term_c', preview: kind === 'command' ? null : { path: '/preview', sha256: 'hash' }, item: 'item', step: 2, then: null, real: { target: '대상', change: '변경', rollback: '복구' }, command: 'echo yes' }
}
function approved(): Approval {
  return { ...applyAdd(emptyFile(), input(), now).entry, state: 'approved', closedAt: now.toISOString(), press: { action: 'approve', terminal: 'term_c', origin: 'human', at: now.toISOString(), nonce: 'nonce' } }
}
const facts = (): CheckFacts => ({ askedVersion: null, previewSha: 'hash', message: { found: true, sender: 'term_c' }, workers: { ok: true, workerHandles: new Set() } })
test('종류별 필수 칸을 모두 알리고 command 는 미리보기 없이 받는다', () => {
  for (const kind of ['post', 'spec', 'step', 'real', 'command'] as const) {
    assert.deepEqual(validateAdd(input(kind)), { ok: true })
    const bad = input(kind)
    const key = kind === 'command' ? 'command' : 'preview'
    bad[key] = null
    const result = validateAdd(bad)
    assert.ok(!result.ok && 'missing' in result && result.missing.includes(key))
  }
  assert.deepEqual(validateAdd({ ...input('real'), real: null }), { ok: false, missing: ['target', 'change', 'rollback'] })
  assert.deepEqual(validateAdd({ ...input('step'), item: null, step: null }), { ok: false, missing: ['item', 'step'] })
  assert.equal(validateAdd({ ...input(), kind: 'other' as ApprovalKind }).ok, false)
  assert.deepEqual(validateAdd({ ...input(), kind: '' as ApprovalKind, title: '' }), { ok: false, missing: ['title', 'kind'] })
})
test('열린 대기만 바꾸고 keep-open 은 버전과 파일을 그대로 둔다', () => {
  const a = applyAdd(emptyFile(), input(), now)
  const kept = applyAdd(a.file, { ...input(), keepOpen: true }, now)
  assert.equal(kept.file, a.file)
  assert.equal(kept.kept, true)
  const b = applyAdd(a.file, input(), now)
  assert.equal(b.replaced, true)
  assert.deepEqual(b.file.entries.map(e => e.state), ['replaced', 'open'])
  const done = { ...a.entry, state: 'revise' as const }
  const c = applyAdd({ seq: 1, entries: [done] }, input(), now)
  assert.equal(c.replaced, false)
  assert.equal(c.file.entries[0].state, 'revise')
  assert.equal(applyAdd(emptyFile(), { ...input(), keepOpen: true }, now).kept, false)
})
test('취소는 열린 대기만 닫고 정리 뒤에도 버전은 늘어난다', () => {
  const a = applyAdd(emptyFile(), input(), new Date('2026-11-01T12:00:00Z'))
  const cancelled = applyCancel(a.file, 'demo', 'chat', new Date('2026-11-01T12:00:00Z'))
  assert.ok('file' in cancelled)
  const pruned = prune(cancelled.file, now)
  assert.equal(pruned.entries.length, 0)
  assert.equal(applyAdd(pruned, input(), now).entry.version, 2)
  assert.deepEqual(applyCancel({ seq: 1, entries: [approved()] }, 'demo', null, now), { error: '열린 대기가 없다' })
  assert.deepEqual(applyCancel(emptyFile(), 'none', null, now), { error: '열린 대기가 없다' })
})
test('check 는 상태부터 검사하고 각 거절 이유와 통과를 구분한다', () => {
  const a = approved()
  assert.deepEqual(checkVerdict(a, facts()), { ok: true })
  const cases: [Approval | null, CheckFacts, string][] = [
    [null, facts(), '기록 없음'], [{ ...a, state: 'open' }, facts(), '아직 누르지 않음'],
    [{ ...a, state: 'used' }, facts(), '이미 사용함'], [{ ...a, state: 'revise' }, facts(), '고쳐 달라'],
    [{ ...a, state: 'cancelled' }, facts(), '취소됨'], [a, { ...facts(), previewSha: null }, '미리보기가 바뀜'],
    [a, { ...facts(), askedVersion: 9 }, '버전이 다름'], [a, { ...facts(), message: { found: false } }, '신호를 읽지 못함'],
    [a, { ...facts(), workers: { ok: false } }, '신호를 읽지 못함'],
    [a, { ...facts(), workers: { ok: true, workerHandles: new Set(['term_c']) } }, 'worker 가 보냄'],
  ]
  for (const [entry, f, reason] of cases) assert.deepEqual(checkVerdict(entry, f), { ok: false, reason })
  assert.deepEqual(checkVerdict({ ...a, state: 'open' }, { ...facts(), message: { found: true, sender: 'worker' } }), { ok: false, reason: '아직 누르지 않음' })
  assert.deepEqual(checkVerdict({ ...a, terminal: 'worker' }, { ...facts(), workers: { ok: true, workerHandles: new Set(['worker']) } }), { ok: false, reason: 'worker 가 보냄' })
  assert.deepEqual(checkVerdict({ ...a, press: { ...a.press!, terminal: null } }, { ...facts(), message: { found: true, sender: '' } }), { ok: true })
})
test('신호는 nonce 와 버전을 확인하고 한 번만 쓴다', () => {
  const a = approved()
  const payload = { source: 'board-approval', action: 'approve', id: 'demo', version: 1, nonce: 'nonce' }
  assert.equal(signalMatches(payload, a), true)
  for (const change of [{ nonce: 'other' }, { version: 2 }]) assert.equal(signalMatches({ ...payload, ...change }, a), false)
  const file = { seq: 1, entries: [a] }
  const used = applyUsed(file, 'demo', 1, 'nonce', now)
  assert.ok('file' in used)
  assert.deepEqual(applyUsed(used.file, 'demo', 1, 'nonce', now), { reason: '이미 사용함' })
  const newer = applyAdd(file, input(), now)
  assert.deepEqual(applyUsed(newer.file, 'demo', 1, 'nonce', now), { reason: '아직 누르지 않음' })
  assert.equal(newer.file.entries[0].state, 'approved')
  assert.equal(latest(newer.file, 'demo')?.version, 2)
})
test('7일 정리는 끝난 기록에만 적용하고 출력 시간 경계를 지킨다', () => {
  const a = approved()
  const file = { seq: 3, entries: [
    { ...a, closedAt: '2026-11-02T12:00:00Z' },
    { ...a, version: 2, closedAt: '2026-11-04T12:00:00Z' },
    { ...a, version: 3, state: 'open' as const, createdAt: '2026-11-09T06:00:00Z', closedAt: null },
  ] }
  assert.deepEqual(prune(file, now).entries.map(e => e.version), [2, 3])
  for (const [minutes, value] of [[59, '59분'], [61, '1시간'], [1500, '1일'], [2880, '2일']] as const) {
    const createdAt = new Date(now.getTime() - minutes * 60000).toISOString()
    assert.equal(waitedText(createdAt, now), value)
    assert.equal(formatLine({ ...a, state: 'open', createdAt }, now, false), `APPROVAL demo post ${value} 제목`)
  }
  assert.equal(formatLine(a, now, true), 'APPROVAL demo post approved v1 제목')
})
test('파일 꼴과 버전 중복을 확인한다', () => {
  assert.deepEqual(parseFile(''), emptyFile())
  const file = { seq: 1, entries: [approved()] }
  assert.deepEqual(parseFile(JSON.stringify(file)), file)
  for (const bad of ['{', '{}', JSON.stringify({ ...file, seq: 0 }), JSON.stringify({ seq: 1, entries: [approved(), approved()] })]) assert.throws(() => parseFile(bad))
})
