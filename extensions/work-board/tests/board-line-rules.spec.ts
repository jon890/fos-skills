// 줄 규칙(hooks/line-rules.js)과 보드 명령의 거절을 본다.
// 실행: node --test extensions/work-board/tests/board-line-rules.spec.ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lineProblem } from '../hooks/line-rules.js'
import { run, tempBoard, write } from './board-run.ts'

const LONG = '가'.repeat(81)

test('본문 80자까지는 통과하고 81자부터 거절한다. 번호·표시·줄 끝 괄호는 세지 않는다', () => {
  assert.equal(lineProblem(`1. ${'가'.repeat(80)}`), null)
  assert.match(lineProblem(`1. ${LONG}`) ?? '', /80자/)
  assert.equal(lineProblem(`2. [auto] ${'가'.repeat(80)} (계획: docs/features/x/tasks/pr4/plan.md) (#12 merge)`), null)
  assert.equal(lineProblem('3. PR (litellm-stray-callers2-worktree-name-very-long-xx)'), null)
  assert.match(lineProblem(`3. 머지 (${'가'.repeat(78)})`) ?? '', /80자/)
  assert.match(lineProblem(`3. ${'가'.repeat(70)} (설명이 긴 괄호 글입니다)`) ?? '', /80자/)
})

test('확인·경과 기록 줄은 거절하고 앞의 완료 표시는 허용한다', () => {
  for (const text of ['5. 확인(CI 통과)', '지금(리뷰 중)', '끝난 것: 설계', '4. 설계 ✓ 끝', '3. 확인 (CI 통과)', '3. 지금 (배포)']) {
    assert.match(lineProblem(text) ?? '', /한 일을 적는 줄/, text)
  }
  assert.equal(lineProblem('✓ 4. 설계'), null)
  assert.equal(lineProblem('4. 확인 절차 정리'), null)
  assert.equal(lineProblem('9. 확인 (#481 merge)'), null)
})

test('기다림은 짧은 조건만 받고 이유와 뒤 계획이 든 조건과 줄 글은 거절한다', () => {
  assert.equal(lineProblem('4. [wait: 기획 답] real 활성화'), null)
  assert.equal(lineProblem('4. [wait: worker litellm-stray-callers2] 활성화'), null)
  assert.equal(lineProblem('4. [wait: 2026-11-10 19:00] 회차'), null)
  assert.match(lineProblem('4. [wait: 기획 답이 와야 해서, 오면 PR5] 활성화') ?? '', /기다림 조건/)
  assert.match(lineProblem('4. 기획 답 기다리는 중') ?? '', /\[wait: 누구\/무엇\]/)
})

test('스크립트가 쓰는 남은 일·중간 과정 줄은 검사하지 않는다', () => {
  assert.equal(lineProblem(`남은 일: ${LONG} 확인(…) ✓`), null)
  assert.equal(lineProblem(`중간 과정: PR #1 ${LONG}`), null)
})

test('step-add, step-edit, detail-add, detail-edit, step-mark wait 가 어긴 줄을 종료 코드 1 로 거절하고 저장하지 않는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'decide', details: ['1. 구현', '참고'] })
    const before = readFileSync(t.file, 'utf8')
    for (const args of [
      ['step-add', 'a', `2. ${LONG}`],
      ['step-add', 'a', '2. 확인(CI 통과)'],
      ['step-edit', 'a', '1', `1. ${LONG}`],
      ['detail-add', 'a', '끝난 것: 구현'],
      ['detail-edit', 'a', '2', `${LONG}`],
      ['step-mark', 'a', '1', 'wait', '기획 답이 와야 해서, 오면 진행'],
    ]) {
      const result = run(t.file, args)
      assert.equal(result.code, 1, args.join(' '))
      assert.notEqual(result.stderr.trim(), '')
      assert.equal(readFileSync(t.file, 'utf8'), before)
    }
    assert.equal(run(t.file, ['step-add', 'a', '2. 머지']).code, 0)
    assert.equal(run(t.file, ['step-mark', 'a', '1', 'wait', '기획 답']).code, 0)
  } finally { t.cleanup() }
})

test('set --detail 의 통째 저장과 옛 긴 줄은 거절하지 않는다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'decide', details: [`1. ${LONG}`] })
    assert.equal(run(t.file, ['set', 'a', '--detail', `1. ${LONG}`, '--detail', '남은 일: 다음 PR']).code, 0)
    assert.equal(run(t.file, ['step', 'a', '1']).code, 0)
  } finally { t.cleanup() }
})

test('step-add 의 긴 워크트리 괄호와 step-edit --event 는 통과하고 긴 괄호 글은 거절한다', () => {
  const t = tempBoard()
  try {
    write(t.file, { id: 'a', status: 'decide', details: ['1. 구현'] })
    assert.equal(run(t.file, ['step-add', 'a', `PR (${'w'.repeat(50)})`]).code, 0)
    assert.equal(run(t.file, ['step-edit', 'a', '1', '1. 구현 확인', '--event', '12 merge']).code, 0)
    assert.equal(run(t.file, ['step-add', 'a', `4. 머지 (${'가'.repeat(78)} 글)`]).code, 1)
  } finally { t.cleanup() }
})
