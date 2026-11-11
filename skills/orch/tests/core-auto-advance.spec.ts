import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADVANCE_REASONS as R, autoAdvanceOf, eventDone, itemBusy, judgeAdvance } from '../scripts/core/auto-advance.ts'
import type { AdvanceInput, BoardView } from '../scripts/core/auto-advance.ts'
import { ConfigError } from '../scripts/core/config.ts'

test('보드의 완료 사건을 꼬리표와 마일스톤, 머지 기록에서 읽는다', () => {
  const row: BoardView = { pr: ['665'], mergedPr: [], stages: null, steps: [{ number: 1, done: false, tag: { pr: '665', event: 'merge' } }] }
  assert.equal(eventDone([row], '665', 'merge'), false)
  row.steps[0].done = true
  assert.equal(eventDone([row], '665', 'merge'), true)
  row.steps = []
  row.mergedPr = ['665']
  assert.equal(eventDone([row], '665', 'merge'), true)
  row.stages = { pr: 1, merge: 2, deploy: 3 }
  row.steps = [{ number: 1, done: true, tag: null }, { number: 3, done: true, tag: null }]
  assert.equal(eventDone([row], '665', 'pr'), true)
  assert.equal(eventDone([row], '665', 'deploy'), true)
  row.mergedPr.push('664')
  assert.equal(eventDone([row], '665', 'deploy'), false)
})

test('worker 와 열린 PR, 보드 잇기 실패 뒤 남은 기록으로 진행 중인 일을 찾는다', () => {
  const empty = { worktree: null, branch: null, pr: [] }
  const live = { paths: new Set(['/repo/work']), dispatches: new Set(['ctx_9']) }
  const branches = new Map([['feat/a', '/repo/work']])
  assert.equal(itemBusy(empty, [], live, branches, []), false)
  assert.equal(itemBusy({ ...empty, worktree: 'work' }, [], live, branches, []), true)
  assert.equal(itemBusy({ ...empty, branch: 'feat/a' }, [], live, branches, []), true)
  assert.equal(itemBusy(empty, [{ dispatch: 'ctx_9', branch: null }], live, branches, []), true)
  for (const item of [{ ...empty, pr: ['5'] }, { ...empty, branch: 'feat/a' }, { ...empty, worktree: 'work' }])
    assert.equal(itemBusy(item, [], { paths: new Set(), dispatches: new Set() }, branches, [{ number: '5', branch: 'feat/a' }]), true)
  assert.equal(itemBusy(empty, [{ dispatch: 'done', branch: 'feat/a' }], live, branches, [{ number: '5', branch: 'feat/a' }]), true)
})

test('자동 진행 거절 순서와 근거를 확인한다', () => {
  const input: AdvanceInput = { autoAdvance: true, status: 'doing', step: { number: 2, mark: 'auto' }, busy: false, launched: false, evidence: [{ text: '계획: a', problem: null }, { text: '앞 사건: #665 merge', problem: null }] }
  const cases: Array<[Partial<AdvanceInput>, string, number | null]> = [
    [{ autoAdvance: false, evidence: [] }, R.off, null],
    [{ status: null }, R.noItem, null],
    [{ status: 'done' }, R.status, null],
    [{ step: { number: 2, mark: 'ask' } }, R.notAuto, 2],
    [{ step: null }, R.notAuto, null],
    [{ busy: null }, R.unknownBusy, 2],
    [{ busy: true, launched: true }, R.busy, 2],
    [{ launched: true, evidence: [{ text: 'x', problem: R.noPlan }] }, R.launched, 2],
    [{ evidence: [] }, R.noEvidence, 2],
    [{ evidence: [{ text: 'x', problem: R.noPlan }] }, R.noPlan, 2],
  ]
  for (const [patch, reason, number] of cases) assert.deepEqual(judgeAdvance({ ...input, ...patch }), { ok: false, reason, number })
  assert.deepEqual(judgeAdvance(input), { ok: true, number: 2, evidence: '계획: a, 앞 사건: #665 merge' })
})

test('자동 진행 설정은 boolean 만 받으며 기본은 켜짐이다', () => {
  assert.equal(autoAdvanceOf({}), true)
  assert.equal(autoAdvanceOf({ board: { auto_advance: false } }), false)
  for (const value of ['no', 0]) assert.throws(() => autoAdvanceOf({ board: { auto_advance: value } }), ConfigError)
})
