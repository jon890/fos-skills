// lib/board.ts 의 보드 항목 찾기(prNumbers, findBoardItems)를 임시 보드 파일로 본다.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { findBoardItems, prNumbers } from '../scripts/lib/board.ts'

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
