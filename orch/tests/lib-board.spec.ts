// lib/board.ts 의 보드 항목 찾기(prNumbers, findBoardItems), 중간 PR 명령(intermediateCommands), 지시서의 중간 과정 줄(interimOf)을 본다. 보드는 임시 파일이다.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { findBoardItems, interimOf, intermediateCommands, noteLine, prNumbers } from '../scripts/lib/board.ts'

let tmp = ''
let n = 0
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lib-board-'))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

function board(items: unknown): string {
  n += 1
  const file = join(tmp, `board-${n}.json`)
  writeFileSync(file, JSON.stringify({ items }))
  return file
}

describe('prNumbers', () => {
  test('pr 칸의 숫자는 글자에 붙지 않은 것만 PR 번호로 읽는다', () => {
    const cases: [unknown, string[]][] = [
      ['#492 495', ['492', '495']],
      ['492/495', ['492', '495']],
      ['#492 (v2)', ['492']],
      ['492, #495', ['492', '495']],
      ['PR한2', []],
      ['', []],
      [null, []],
      [492, ['492']],
    ]
    for (const [field, want] of cases) assert.deepEqual([...prNumbers(field)].sort(), want, JSON.stringify(field))
  })
})

describe('findBoardItems', () => {
  test('pr 칸에 그 PR 이 든 항목을 브랜치보다 먼저 찾는다', () => {
    const file = board([
      { id: 'by-pr', pr: '#77, #78' },
      { id: 'by-branch', branch: 'feat/x' },
    ])
    assert.deepEqual(findBoardItems(file, '77', 'feat/x', null), { by: 'pr', ids: ['by-pr'] })
  })

  test('pr 칸에 없으면 pr 칸이 빈 항목을 브랜치나 워크트리 이름으로 찾는다', () => {
    const file = board([
      { id: 'other-pr', pr: '12', branch: 'feat/x' },
      { id: 'branch', pr: '', branch: 'feat/x' },
      { id: 'worktree', worktree: 'x-wt' },
      { id: 'unrelated', branch: 'feat/y', worktree: 'y-wt' },
    ])
    assert.deepEqual(findBoardItems(file, '77', 'feat/x', null), { by: 'branch', ids: ['branch'] })
    assert.deepEqual(findBoardItems(file, '77', 'feat/z', 'x-wt'), { by: 'branch', ids: ['worktree'] })
    assert.deepEqual(findBoardItems(file, '77', 'feat/x', 'x-wt'), { by: 'branch', ids: ['branch', 'worktree'] })
    assert.equal(findBoardItems(file, '77', 'feat/z', null), null)
  })

  test('브랜치로 찾을 때 done 항목과 merged-pr 에 이 PR 이 든 항목은 뺀다', () => {
    const file = board([
      { id: 'done', status: 'done', branch: 'feat/x' },
      { id: 'handled', status: 'doing', branch: 'feat/x', 'merged-pr': '#77' },
      { id: 'open', status: 'doing', branch: 'feat/x', 'merged-pr': 70 },
    ])
    assert.deepEqual(findBoardItems(file, '77', 'feat/x', null), { by: 'branch', ids: ['open'] })
  })

  test('빈 브랜치 이름은 branch 칸이 없는 항목과 맞지 않는다', () => {
    const file = board([{ id: 'blank' }])
    assert.equal(findBoardItems(file, '77', '', null), null)
  })

  test('숫자 id 는 문자열로 내고, 같은 PR 이 든 항목이 둘이면 모두 낸다', () => {
    const file = board([
      { id: 7, pr: '77' },
      { id: 'b', pr: '#77' },
    ])
    assert.deepEqual(findBoardItems(file, '77', 'feat/x', null), { by: 'pr', ids: ['7', 'b'] })
  })

  test('보드가 없거나 깨졌으면 null 이다', () => {
    assert.equal(findBoardItems(join(tmp, 'missing.json'), '77', 'feat/x', null), null)
    const broken = join(tmp, 'broken.json')
    writeFileSync(broken, '{broken')
    assert.equal(findBoardItems(broken, '77', 'feat/x', null), null)
  })
})

describe('intermediateCommands', () => {
  test('남은 일 줄을 바꾸고 그 PR 의 끝나지 않은 단계를 끝내고 PR 을 merged-pr 로 옮긴다', () => {
    const steps = [
      { number: 1, done: false, text: '1. PR #77' },
      { number: 2, done: true, text: '2. PR #77 확인' },
      { number: 3, done: false, text: '3. PR #770' },
    ]
    const note = noteLine(['#78'], ['spec-b.md'])
    assert.equal(note, '남은 일: PR #78, 지시서 spec-b.md')
    assert.deepEqual(intermediateCommands('a', ['1. PR #77', '남은 일: 옛 줄'], steps, '77', note), [
      ['set', 'a', '--detail', '1. PR #77', '--detail', '남은 일: PR #78, 지시서 spec-b.md'],
      ['step', 'a', '1'],
      ['set', 'a', '--pr', '', '--merged-pr', '77'],
    ])
  })

  test('하위 항목이 그대로면 다시 쓰지 않는다', () => {
    assert.equal(noteLine([], []), null)
    assert.deepEqual(intermediateCommands('a', [{ text: '1. 구현', done: false }], [], '77', null), [['set', 'a', '--pr', '', '--merged-pr', '77']])
  })
})

describe('interimOf', () => {
  test('중간 과정 줄의 PR 번호는 #N 을 먼저 읽고, 숫자가 없으면 null 이다', () => {
    assert.deepEqual(interimOf('# CI 고침\n중간 과정: PR #7\n'), { pr: '7' })
    assert.deepEqual(interimOf('# 리뷰\n- 중간 과정: 2차 PR #7\n'), { pr: '7' })
    assert.deepEqual(interimOf('중간 과정: 리뷰 반영'), { pr: null })
  })

  test('중간 과정 줄이 없으면 null 이다', () => {
    assert.equal(interimOf('# 새 기능\n보드 항목 id: a\n중간 과정 없이 만든다\n'), null)
    assert.equal(interimOf(''), null)
  })

  test('첫 ## 제목 뒤 본문이 인용한 중간 과정 줄은 읽지 않는다', () => {
    assert.equal(interimOf('# 지시서 규칙 고치기\n\n## 할 일\n1. 문서에 적는다\n- 중간 과정: PR #N 줄을 넣는다\n'), null)
    assert.deepEqual(interimOf('# CI 고침\n브랜치: `feat/x`\n중간 과정: PR #7\n\n## 할 일\n- 중간 과정: PR #8\n'), { pr: '7' })
  })
})
