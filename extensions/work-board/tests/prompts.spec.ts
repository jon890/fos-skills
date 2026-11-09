// 창 버튼이 입력란에 채우는 요청문과 매니페스트를 본다.
//
// 실행: node --test extensions/work-board/tests/prompts.spec.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { START_PROMPT, DECIDE_PROMPT } from '../hooks/register.js'

const read = (path: string) => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8')

test('오늘 시작 요청문은 보드 갱신, 정리, 감시, 보고, 확인 단계 확인을 담는다', () => {
  for (const text of ['orch cleanup handoff --apply', 'done 항목은 비워', 'cleanup-sweep 이 맡는다', 'wait-important', '정할 것은 바로 물어봐', '확인 단계', '사람이 할 확인만']) {
    assert.ok(START_PROMPT.includes(text), text)
  }
})

test('오늘 시작 요청문은 전날 미룬 결정과 아침 확인 목록을 맨 앞 단계로 둔다', () => {
  const lines = START_PROMPT.split('\n')
  assert.match(lines[1], /^1\. .*미룬 결정.*아침에 확인/)
  assert.match(lines[2], /^2\. .*orch cleanup handoff --apply/)
})

test('정할 것 묻기 요청문은 결정 모으기, 질문, 보드와 worker 반영을 담는다', () => {
  for (const text of ['결정 필요(decide)', 'AskUserQuestion', '(Recommended)', 'board.ts mark', 'orch worker send']) {
    assert.ok(DECIDE_PROMPT.includes(text), text)
  }
})

test('정할 것 묻기 요청문은 직접 올린 막힘과 Orca 자동 알림을 다루는 방법을 담는다 (docs/features/board-decision-box R7)', () => {
  for (const text of ['직접 올린 막힘', '사람이 정할 것만', '자동 알림', '한 줄로', '계정 한도', '터미널이 종료', '같은 워크트리', '깨워', '해제로 닫아']) {
    assert.ok(DECIDE_PROMPT.includes(text), text)
  }
})

test('보드 스킬은 매니페스트에 없고 훅은 요청문을 직접 보내지 않는다', () => {
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    assert.doesNotMatch(read(file), /work-board\/board-/, file)
  }
  assert.doesNotMatch(read('extensions/work-board/hooks/register.js'), /prompt\.submit\(|command: 'board-start'|command: 'board-decide'/)
})
