// c 다음 번호가 고르는 항목과 채우는 상태 확인 요청문을 본다 (docs/features/board-item-check REQ1~REQ3).
//
// 실행: node --test work-board/tests/check.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHECK_PROMPT, CHECK_ROWS, checkPrompt, checkTargets, closeCancelsCheck, onPaneClose, toggleCheckMode } from '../hooks/register.js'

test('대상은 진행 중 다음 대기 항목을 파일 순서로 고르고 앞 9개만 받는다', () => {
  const items = [
    { id: 'w1', status: 'wait' },
    { id: 'd1', status: 'doing' },
    { id: 'x', status: 'done' },
    { id: 'q', status: 'decide' },
    { id: 'g', status: 'goal' },
    { id: 'd2', status: 'doing' },
    { id: 'w2', status: 'wait' },
  ]
  assert.deepEqual(checkTargets(items).map((item) => item.id), ['d1', 'd2', 'w1', 'w2'])
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'i' + i, status: 'doing' }))
  assert.equal(CHECK_ROWS, 9)
  assert.deepEqual(checkTargets(many).map((item) => item.id), many.slice(0, 9).map((item) => item.id))
  assert.deepEqual(checkTargets(null), [])
})

test('요청문은 항목 id, 제목, 끝나지 않은 단계, worker, PR 번호를 담는다', () => {
  const item = { id: 'board-item-check', title: '보드 항목 확인', status: 'doing', pr: '#310', worktree: 'board-item-check',
    details: [{ text: '1. 구현', done: true }, { text: '2. 리뷰', done: false }, { text: '3. 머지 (#310 merge)', done: false }, { text: '참고: 메모', done: false }] }
  const worker = { id: 'task_1', worktree: 'board-item-check', state: 'running' }
  const text = checkPrompt(item, worker, [{ number: 310, branch: 'feat/board-item-check', pass: 3, fail: 0, pending: 0 }])
  assert.match(text, /보드 항목 board-item-check /)
  assert.match(text, /\(보드 항목 확인\)/)
  assert.match(text, /끝나지 않은 단계: 2\. 리뷰 \/ 3\. 머지\n/)
  assert.doesNotMatch(text, /1\. 구현|참고: 메모|#310 merge/)
  assert.match(text, /worker: board-item-check  PR #310 CI 3\/3  running/)
  assert.match(text, /PR: #310/)
})

test('worker 와 PR, 남은 단계가 없으면 없음으로 적는다', () => {
  const text = checkPrompt({ id: 'w', title: '대기', status: 'wait', worktree: 'wt-w' }, null, null)
  assert.match(text, /끝나지 않은 단계: 없음/)
  assert.match(text, /worker: 없음 \(워크트리 wt-w\)/)
  assert.match(text, /PR: 없음/)
  assert.match(checkPrompt({ id: 'n', status: 'doing', pr: 9 }, null, null), /worker: 없음\n- PR: #9/)
})

test('요청문은 상태 확인과 다음 단계 진행이나 정할 것 묻기를 시킨다', () => {
  const sentence = 'PR·CI·배포·worker 보고·업무 상태와 대조해 지금 상태를 확인하고, 멈춰 있으면 다음 단계를 진행하거나 내가 정할 것을 물어 줘'
  assert.ok(CHECK_PROMPT.includes(sentence))
  assert.ok(checkPrompt({ id: 'a', status: 'doing' }, null, null).endsWith(CHECK_PROMPT))
  for (const text of ['추측하지 말고', 'board.ts']) assert.ok(CHECK_PROMPT.includes(text), text)
})

test('확인 모드에서 사람이 창을 닫으면(Esc) 모드만 끄고, 엔진의 unload 나 모드 밖의 닫기는 그대로 닫는다 (REQ1)', () => {
  assert.equal(closeCancelsCheck({ id: 'work-board', origin: { kind: 'person' } }, true), true)
  assert.equal(closeCancelsCheck({ id: 'work-board', origin: { kind: 'person' } }, false), false)
  assert.equal(closeCancelsCheck({ id: 'work-board', origin: { kind: 'unload' } }, true), false)
  assert.equal(closeCancelsCheck({ id: 'other', origin: { kind: 'person' } }, true), false)
})

test('확인 모드의 창 닫기 훅은 next 없이 { value: undefined } 로 답해 창을 남기고, 모드를 끈 뒤에는 닫기를 넘긴다 (REQ1)', async () => {
  const calls = []
  const $ = { ui: { invalidate: (name) => calls.push('invalidate ' + name) } }
  const next = async (e) => { calls.push('next ' + e.id); return { value: undefined } }
  const esc = { id: 'work-board', origin: { kind: 'person' } }
  assert.equal(toggleCheckMode(), true)
  assert.deepEqual(await onPaneClose($, esc, next), { value: undefined })
  assert.deepEqual(calls, ['invalidate ui.render'])
  // 모드가 꺼졌으니 다음 Esc 는 엔진에 넘겨 창을 닫는다
  await onPaneClose($, esc, next)
  assert.deepEqual(calls, ['invalidate ui.render', 'next work-board'])
})
