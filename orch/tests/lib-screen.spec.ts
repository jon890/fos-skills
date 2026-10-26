// lib/screen.ts 의 마지막 메시지 묶음과 그 해시를 본다. 화면 판정 자체는 nudge-worker.spec.ts 가 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { blockHash, readScreen } from '../scripts/lib/screen.ts'

function claudeScreen(status: string): string[] {
  return `⏺ 검사를 다시 돌린다.
❯ 계속 진행해
  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}
✻ Cooked for ${status}
───────────────────────────────────────────────
❯
───────────────────────────────────────────────
   Model: Opus 5.5  Context: ${status} · 5h 41%
  ⏵⏵ bypass permissions on · ← 1 agent ${status}`.split('\n')
}

function codexScreen(footer: string): string[] {
  return `• 테스트를 고쳤다.
■ Selected model is at capacity. Please try a different model.

› Ask Codex to do anything
  ~/work/repo · user/branch · GPT-6.1-Sol medium · ${footer}
  ? for shortcuts`.split('\n')
}

describe('마지막 메시지 묶음', () => {
  test('입력란 아래와 묶음 밖의 상태 줄만 바뀐 두 화면은 해시가 같다', () => {
    const before = readScreen(claudeScreen('3m 2s'))
    const after = readScreen(claudeScreen('8m 40s'))
    assert.equal(before.state, 'error')
    assert.equal(after.state, 'error')
    assert.equal(blockHash(before.block), blockHash(after.block))
  })

  test('Codex 하단 안내 줄만 바뀐 두 화면은 해시가 같다', () => {
    const before = readScreen(codexScreen('Context 47% used'))
    const after = readScreen(codexScreen('Context 52% used'))
    assert.equal(before.state, 'error')
    assert.deepEqual(before.block, ['■ Selected model is at capacity. Please try a different model.'])
    assert.equal(blockHash(before.block), blockHash(after.block))
  })

  test('묶음은 지난 입력 줄에서 시작한다', () => {
    const { block } = readScreen(claudeScreen('1s'))
    assert.deepEqual(block, ['❯ 계속 진행해', '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'])
  })

  test('묶음 내용이 바뀌면 해시가 다르다', () => {
    const other = codexScreen('Context 47% used').map((line) => line.replace('at capacity', 'overloaded'))
    assert.notEqual(blockHash(readScreen(codexScreen('Context 47% used')).block), blockHash(readScreen(other).block))
  })

  test('입력란이 없으면 묶음이 비어 있다', () => {
    assert.deepEqual(readScreen(['$ ls', 'a b']), { state: 'unknown', block: [] })
  })
})
