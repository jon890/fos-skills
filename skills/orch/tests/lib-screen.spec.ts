// lib/screen.ts 의 마지막 메시지 묶음과 멈춤 해시, 오류 줄과 끊김 줄의 판정을 본다. 나머지 화면 판정은 nudge-worker.spec.ts 가 본다.

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { backgroundWork, readScreen, stallHash } from '../scripts/lib/screen.ts'

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
    assert.equal(stallHash(before), stallHash(after))
  })

  test('Codex 하단 안내 줄만 바뀐 두 화면은 해시가 같다', () => {
    const before = readScreen(codexScreen('Context 47% used'))
    const after = readScreen(codexScreen('Context 52% used'))
    assert.equal(before.state, 'error')
    assert.deepEqual(before.block, ['■ Selected model is at capacity. Please try a different model.'])
    assert.equal(stallHash(before), stallHash(after))
  })

  test('묶음은 지난 입력 줄에서 시작한다', () => {
    const { block } = readScreen(claudeScreen('1s'))
    assert.deepEqual(block, ['❯ 계속 진행해', '  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'])
  })

  test('묶음 내용이 바뀌면 해시가 다르다', () => {
    const other = codexScreen('Context 47% used').map((line) => line.replace('at capacity', 'overloaded'))
    assert.notEqual(stallHash(readScreen(codexScreen('Context 47% used'))), stallHash(readScreen(other)))
  })

  test('이어 가게 한 worker 가 같은 오류로 다시 끝나면 묶음은 같아도 오류 줄이 늘어 해시가 다르다', () => {
    const first = readScreen(codexScreen('Context 47% used'))
    const again = readScreen(
      codexScreen('Context 47% used').flatMap((line) =>
        line.startsWith('■') ? [line, '› 계속 진행해', line] : [line],
      ),
    )
    assert.equal(again.state, 'error')
    assert.deepEqual(again.block, first.block)
    assert.deepEqual([first.errors, again.errors], [1, 2])
    assert.notEqual(stallHash(first), stallHash(again))
  })

  test('입력란이 없으면 묶음이 비어 있다', () => {
    assert.deepEqual(readScreen(['$ ls', 'a b']), { state: 'unknown', block: [], errors: 0 })
  })
})

describe('오류 줄과 끊김 줄', () => {
  const claude = (body: string) => `❯ 결과를 정리해
${body}
───────────────
❯
───────────────
  ⏵⏵ bypass permissions on`.split('\n')

  test('Codex 의 끊김 줄은 error 가 아니라 interrupted 다', () => {
    // Codex 0.164 의 on_interrupted_turn 이 그리는 줄이다
    const screen = `• 파일을 고친다.
■ Conversation interrupted - use /feedback if something went wrong
› Ask Codex to do anything
  ? for shortcuts`.split('\n')
    const read = readScreen(screen)
    assert.equal(read.state, 'interrupted')
    assert.equal(read.errors, 0)
  })

  test('옛 Codex 의 끊김 문구도 interrupted 다', () => {
    const screen = ['■ Conversation interrupted - tell the model what to do differently.', '› Ask Codex to do anything']
    assert.equal(readScreen(screen).state, 'interrupted')
  })

  test('Claude 는 ⎿ 뒤의 API Error: 와 API Error ( 만 오류 줄이다', () => {
    assert.equal(readScreen(claude('  ⎿  API Error: 500 {"type":"error"}')).state, 'error')
    assert.equal(readScreen(claude('  ⎿  API Error (500 Internal) · 다시 시도하지 않는다')).state, 'error')
  })

  test('API Error 로 시작하는 답 본문은 오류 줄이 아니다', () => {
    for (const body of [
      '⏺ API Error 판정을 lib/screen.ts 로 옮겼다. 테스트는 모두 통과했다.',
      '● API Error: 라는 문구를 찾는 정규식을 고쳤다.',
      '⏺ 오류 처리 경로를 정리했다.\n  API Error 문자열을 그대로 쓰는 곳은 없다.',
      '  ⎿  API Errors 는 없다',
    ]) {
      assert.equal(readScreen(claude(body)).state, 'idle', body)
    }
  })
})

describe('백그라운드 작업', () => {
  const claude = (footer: string) => `⏺ 빌드를 백그라운드로 돌렸다. 끝나면 이어 간다.
───────────────────────────────────────────────
❯
───────────────────────────────────────────────
  ${footer}`.split('\n')

  test('Claude 바닥 모드 줄의 셸, 모니터, 백그라운드 작업 칸을 찾는다(실제 화면 문구)', () => {
    assert.equal(backgroundWork(claude('⏵⏵ auto mode on · 7 shells · ← 1 agent')), '7 shells')
    assert.equal(backgroundWork(claude('⏵⏵ auto mode on · 1 shell · ← 1 agent')), '1 shell')
    assert.equal(backgroundWork(claude('⏵⏵ bypass permissions on · 1 shell, 2 monitors')), '1 shell, 2 monitors')
    assert.equal(backgroundWork(claude('⏵⏵ auto mode on · 3 background tasks')), '3 background tasks')
    // 화면 상태는 그대로 idle 이다. nudge-worker 의 판정과 출력을 바꾸지 않는다
    assert.equal(readScreen(claude('⏵⏵ auto mode on · 1 shell · ← 1 agent')).state, 'idle')
  })

  test('에이전트 보기 안내와 답 본문의 같은 낱말은 백그라운드 작업이 아니다', () => {
    assert.equal(backgroundWork(claude('⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent')), null)
    assert.equal(backgroundWork(['⏺ 3 shells 를 열어 확인했다', '❯', '  ⏵⏵ auto mode on']), null)
  })

  test('Codex 의 백그라운드 터미널 표시를 찾는다', () => {
    const lines = ['• Working (13m 09s • esc to interrupt) · 2 background terminals running · /ps to view · /stop to close', '› Ask Codex to do anything', '  ? for shortcuts']
    assert.equal(backgroundWork(lines), '2 background terminals running')
    assert.equal(backgroundWork(['• 끝났다.', '› Ask Codex to do anything', '  ? for shortcuts']), null)
  })

  test('답변 본문에 같은 문구가 있어도 상태 표시줄에 없으면 백그라운드 작업이 아니다', () => {
    assert.equal(backgroundWork(['• 상태 문구는 2 background terminals running 입니다.', '› Ask Codex to do anything', '  ? for shortcuts']), null)
    assert.equal(backgroundWork(['⏺ 1 shell', '───────────────', '❯', '───────────────', '  ⏵⏵ auto mode on']), null)
  })
})
