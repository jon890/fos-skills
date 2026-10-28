// 창 버튼이 입력란에 채우는 요청문과 매니페스트를 본다.
//
// 실행: node --test work-board/tests/prompts.spec.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { START_PROMPT, DECIDE_PROMPT, REFRESH_PROMPT } from '../hooks/register.js'

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')

test('오늘 시작 요청문은 보드 갱신, 정리, 감시, 보고를 담는다', () => {
  for (const text of ['done 항목은 비워', 'cleanup-sweep 이 맡는다', 'wait-important', '정할 것은 바로 물어봐']) {
    assert.ok(START_PROMPT.includes(text), text)
  }
})

test('정할 것 묻기 요청문은 결정 모으기, 질문, 보드와 worker 반영을 담는다', () => {
  for (const text of ['결정 필요(decide)', 'AskUserQuestion', '(Recommended)', 'board.ts mark', 'orch/scripts/send-to-worker.ts']) {
    assert.ok(DECIDE_PROMPT.includes(text), text)
  }
})

test('보드 스킬은 매니페스트에 없고 훅은 요청문을 직접 보내지 않는다', () => {
  for (const file of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    assert.doesNotMatch(read(file), /work-board\/board-/, file)
  }
  assert.doesNotMatch(read('work-board/hooks/register.js'), /prompt\.submit\(|command: 'board-start'|command: 'board-decide'/)
})

test('갱신 요청문은 실제 근거 대조와 보드 반영을 요청한다', () => {
  for (const text of ['PR 상태', '배포 결과', '두레이 업무 상태', 'orch worker 보고', 'board.ts', '정할 것만']) assert.ok(REFRESH_PROMPT.includes(text), text)
})
