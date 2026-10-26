// 창 버튼이 채우는 스킬 명령과 스킬 파일, 매니페스트가 서로 맞는지 확인한다.
//
// 실행: node --test work-board/tests/skills.spec.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { START_COMMAND, DECIDE_COMMAND } from '../hooks/register.js'

const read = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const manifest = JSON.parse(read('.claude-plugin/plugin.json'))

test('오늘 시작 스킬은 board 갱신, 완료 비우기, 정리, 감시, 보고를 모두 담는다', () => {
  const skill = read('work-board/board-start/SKILL.md')
  for (const text of ['완료(done) 항목은 비운다', '현재 저장소의 남은 워크트리', '.orch/overlay.md 의 정리 규칙', 'orch-watch', '정할 것은 바로 물어본다']) {
    assert.ok(skill.includes(text), text)
  }
  assert.doesNotMatch(skill, /fos-|세 저장소/)
})

test('정할 것 묻기 스킬은 결정 모으기, 질문, 보드 갱신을 담는다', () => {
  const skill = read('work-board/board-decide/SKILL.md')
  for (const text of ['결정 필요(decide)', 'AskUserQuestion', '(Recommended)', '보드 항목을 갱신하고', 'board.ts mark']) {
    assert.ok(skill.includes(text), text)
  }
})

test('버튼이 채우는 명령은 매니페스트에 등록된 스킬 이름과 같다', () => {
  for (const [command, dir] of [[START_COMMAND, 'board-start'], [DECIDE_COMMAND, 'board-decide']]) {
    assert.ok(manifest.skills.includes('./work-board/' + dir), dir)
    assert.equal(command, '/' + manifest.name + ':' + dir)
    assert.match(read('work-board/' + dir + '/SKILL.md'), new RegExp('^name: ' + dir + '$', 'm'))
  }
})

test('훅은 명령 요청문을 따로 갖지 않는다', () => {
  const hook = read('work-board/hooks/register.js')
  assert.doesNotMatch(hook, /command: 'board-start'|command: 'board-decide'|START_PROMPT|DECIDE_PROMPT|prompt\.submit/)
})
