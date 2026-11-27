// core/board-find.ts 의 항목 찾기 순서와 시작 단계 대조를 값으로 본다.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findBoardItem, startStageProblem, type BoardQuery } from '../scripts/core/board-find.ts'
import type { BoardItem } from '../scripts/core/board-details.ts'
import { adoptsAskStage as adopts } from '../../../modules/work-board/item.ts'

const A = { path: 'docs/features/a', repo: '/repo' }
const B = { path: 'docs/features/b', repo: '/repo' }
const query = (q: Partial<BoardQuery> = {}): BoardQuery => ({ worktree: 'wt', branch: 'feat/x', ref: null, taskNumber: null, feature: null, ...q })
const found = (items: BoardItem[], q: Partial<BoardQuery> = {}) => findBoardItem(items, query(q))

test('같은 워크트리의 worker 줄이 같은 브랜치 항목보다 먼저다', () => {
  const items: BoardItem[] = [
    { id: 'branch', status: 'doing', branch: 'feat/x' },
    { id: 'row', status: 'doing', workers: [{ role: 'impl', worktree: 'wt', branch: 'old' }] },
  ]
  assert.deepEqual(found(items), { item: items[1] })
})

test('워크트리와 브랜치 단계는 worker 줄의 브랜치도 보고, 둘이면 최근 stepAt 을 고른다', () => {
  const items: BoardItem[] = [
    { id: 'old', status: 'doing', branch: 'feat/x', stepAt: '2026-11-01' },
    { id: 'new', status: 'doing', workers: [{ role: 'impl', worktree: 'other', branch: 'feat/x' }], stepAt: '2026-11-02' },
  ]
  assert.equal((found(items) as { item: BoardItem }).item.id, 'new')
})

test('업무 번호는 task-ref 다음 제목이고, 같은 값이 둘이면 many 다', () => {
  const byRef: BoardItem[] = [{ id: 'ref', status: 'doing', 'task-ref': 'P/1' }, { id: 'title', status: 'doing', title: 'P/1 일' }]
  assert.equal((found(byRef, { branch: '', ref: 'P/1', taskNumber: 'P/1' }) as { item: BoardItem }).item.id, 'ref')
  assert.equal((found([byRef[1]], { branch: '', ref: 'P/1', taskNumber: 'P/1' }) as { item: BoardItem }).item.id, 'title')
  const twice: BoardItem[] = [{ id: 'a', status: 'doing', 'task-ref': 'P/1' }, { id: 'b', status: 'todo', 'task-ref': 'P/1' }]
  assert.deepEqual(found(twice, { branch: '', ref: 'P/1' }), { many: ['a', 'b'] })
})

test('기능 폴더로 찾고, 같은 상대경로라도 다른 저장소의 항목은 고르지 않는다', () => {
  const items: BoardItem[] = [{ id: 'other-repo', status: 'doing', feature: A.path, 'feature-repo': '/other' }, { id: 'mine', status: 'doing', feature: A.path, 'feature-repo': A.repo }]
  assert.equal((found(items, { branch: '', feature: A }) as { item: BoardItem }).item.id, 'mine')
  assert.deepEqual(found([items[0]], { branch: '', feature: A }), { none: true })
  assert.deepEqual(found([items[1], { ...items[1], id: 'twin' }], { branch: '', feature: A }), { many: ['mine', 'twin'] })
})

test('같은 업무에 걸린 다른 기능의 항목은 어느 단계에서도 후보가 아니다', () => {
  const items: BoardItem[] = [{ id: 'feature-a', status: 'doing', 'task-ref': 'P/1', branch: 'feat/x', feature: A.path, 'feature-repo': A.repo }]
  assert.deepEqual(found(items, { ref: 'P/1', feature: B }), { none: true })
  assert.equal((found(items, { ref: 'P/1', feature: A }) as { item: BoardItem }).item.id, 'feature-a')
})

test('done, decide 항목은 보지 않고, 아무것도 없으면 none 이다', () => {
  const items: BoardItem[] = [{ id: 'done', status: 'done', branch: 'feat/x' }, { id: 'decide', status: 'decide', branch: 'feat/x' }]
  assert.deepEqual(found(items), { none: true })
})

test('지시서 id 는 순서를 보지 않고, 다른 기능 폴더면 conflict, 보드에 없으면 none 이다', () => {
  const items: BoardItem[] = [{ id: 'b', status: 'done', feature: B.path, 'feature-repo': B.repo }, { id: 'a', status: 'done', feature: A.path }]
  assert.deepEqual(found(items, { explicit: 'b', feature: A }), { conflict: 'b' })
  assert.deepEqual(found(items, { explicit: 'a', feature: A }), { item: items[1] })
  assert.deepEqual(found(items, { explicit: 'new', feature: A }), { none: true })
})

test('시작 단계는 끝나지 않은 [ask] 기능 줄과 차수까지 같아야 한다', () => {
  const item: BoardItem = { id: 'f', details: [{ text: '1. 기능 technical-design', done: true }, { text: '2. [ask] 기능 implementation 2/3', done: false }] }
  const opts = { id: 'f', newSpec: false, hasDesign: true, adopts }
  assert.equal(startStageProblem(item, { name: 'implementation', part: 2, total: 3 }, opts), null)
  assert.equal(startStageProblem(item, { name: 'implementation', part: 1, total: 3 }, opts), '항목 f 의 다음 단계는 implementation 2/3 인데 지시서는 implementation 1/3 부터 시작한다')
  const placeholder: BoardItem = { id: 'f', details: [{ text: '2. [ask] 기능 implementation 1/1', done: false }] }
  assert.equal(startStageProblem(placeholder, { name: 'implementation', part: 1, total: 3 }, opts), null)
  assert.match(startStageProblem(placeholder, { name: 'implementation', part: 2, total: 3 }, opts)!, /다음 단계는 implementation 1\/1 인데 지시서는 implementation 2\/3 부터/)
  const design: BoardItem = { id: 'f', details: [{ text: '1. [ask] 기능 technical-design', done: false }] }
  assert.match(startStageProblem(design, { name: 'implementation', part: 1, total: 1 }, opts)!, /다음 단계는 technical-design 인데 지시서는 implementation 1\/1 부터/)
})

test('끝나지 않은 기능 줄은 같은 단계의 재시도만 받고, 모두 끝났으면 막는다', () => {
  const running: BoardItem = { id: 'f', details: ['✓ 1. 기능 technical-design', '2. 기능 implementation 1/1'] }
  const opts = { id: 'f', newSpec: false, hasDesign: true, adopts }
  assert.equal(startStageProblem(running, { name: 'implementation', part: 1, total: 1 }, opts), null)
  const finished: BoardItem = { id: 'f', details: [{ text: '1. 기능 technical-design', done: true }] }
  assert.match(startStageProblem(finished, { name: 'implementation', part: 1, total: 1 }, opts)!, /모두 끝났고 다음 단계 줄이 없다/)
})

test('기능 단계 줄이 없는 항목은 새 스펙이면 spec, 확인된 스펙이면 설계부터, 설계가 있으면 구현 1차도 받는다', () => {
  const plain: BoardItem = { id: 'p', details: [{ text: '1. PR', done: false }] }
  assert.equal(startStageProblem(plain, { name: 'spec' }, { id: 'p', newSpec: true, hasDesign: false, adopts }), null)
  assert.match(startStageProblem(undefined, { name: 'technical-design' }, { id: 'p', newSpec: true, hasDesign: false, adopts })!, /다음 단계는 spec /)
  assert.equal(startStageProblem(plain, { name: 'technical-design' }, { id: 'p', newSpec: false, hasDesign: false, adopts }), null)
  assert.match(startStageProblem(plain, { name: 'implementation', part: 1, total: 2 }, { id: 'p', newSpec: false, hasDesign: false, adopts })!, /다음 단계는 technical-design 인데/)
  assert.equal(startStageProblem(plain, { name: 'implementation', part: 1, total: 2 }, { id: 'p', newSpec: false, hasDesign: true, adopts }), null)
  assert.match(startStageProblem(plain, { name: 'implementation', part: 2, total: 2 }, { id: 'p', newSpec: false, hasDesign: true, adopts })!, /technical-design, implementation 1\/n/)
})
