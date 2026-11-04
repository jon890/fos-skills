// c 다음 번호가 고르는 항목과 채우는 상태 확인 요청문을 본다 (docs/features/board-item-check REQ1~REQ3).
//
// 실행: node --test extensions/work-board/tests/check.spec.ts

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHECK_PROMPT, CHECK_ROWS, RESUME_PROMPT, checkPrompt, checkTargets, closeCancelsCheck, itemPrompt, onPaneClose, resumePrompt, toggleCheckMode, waitReasons } from '../hooks/register.js'

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
  const text = checkPrompt({ id: 'w', title: '멈춘 항목', status: 'doing', worktree: 'wt-w' }, null, null)
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

test('대기 사유는 끝나지 않은 단계와 기다림을 적은 참고 줄이다', () => {
  const item = { id: 'w', status: 'wait', details: [
    { text: '1. 구현', done: true },
    { text: '기획 답 대기', done: false },
    { text: '참고: 메모', done: false },
    { text: '배포 뒤 확인 대기', done: true },
    { text: '2. 배포 뒤 확인', done: false },
  ], next: '외부 회신 기다림' }
  assert.deepEqual(waitReasons(item), ['기획 답 대기', '2. 배포 뒤 확인', '외부 회신 기다림'])
  // 단계가 없으면 첫 참고 줄이 지금 단계라 대기 낱말이 없어도 사유로 본다
  assert.deepEqual(waitReasons({ id: 'n', status: 'wait', next: '사용자 결정\n참고: 메모' }), ['사용자 결정'])
  assert.deepEqual(waitReasons({ id: 'e', status: 'wait' }), [])
})

test('대기 항목 요청문은 대기 사유, 업무 주소, worker, PR 을 담고 재개를 시킨다', () => {
  const item = { id: 'login-fix', title: '로그인 오류 수정', status: 'wait', pr: 41, worktree: 'login-fix',
    task: 'https://tasks.example.com/task/7', details: [{ text: '1. 구현', done: true }, { text: '기획 답 대기', done: false }] }
  const text = resumePrompt(item, null, null)
  assert.match(text, /^보드 항목 login-fix 의 대기 사유를 다시 확인하고 조사를 재개해 줘\. \(로그인 오류 수정\)\n/)
  assert.match(text, /- 대기 사유: 기획 답 대기\n/)
  assert.match(text, /- 업무: https:\/\/tasks\.example\.com\/task\/7\n/)
  assert.match(text, /- worker: 없음 \(워크트리 login-fix\)\n/)
  assert.match(text, /- PR: #41\n/)
  assert.ok(text.endsWith(RESUME_PROMPT))
  for (const words of ['업무 댓글, 메신저, PR, 배포 상태로 확인', '진행 중(doing)으로 올려', '재촉하거나 우회할 방법', '추측하지 말고', 'board.ts'])
    assert.ok(RESUME_PROMPT.includes(words), words)
  const bare = resumePrompt({ id: 'b', status: 'wait' }, null, null)
  assert.match(bare, /대기 사유: 적혀 있지 않음\n- 업무: 없음\n- worker: 없음\n- PR: 없음/)
})

test('클릭 요청문은 대기 항목이면 재개, 진행 중이면 상태 확인이다', () => {
  const wait = { id: 'w', status: 'wait', next: '답 대기' }
  const doing = { id: 'd', status: 'doing', next: '1. 구현' }
  assert.equal(itemPrompt(wait, null, null), resumePrompt(wait, null, null))
  assert.equal(itemPrompt(doing, null, null), checkPrompt(doing, null, null))
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
