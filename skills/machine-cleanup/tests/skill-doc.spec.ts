// SKILL.md 의 「개인 오버레이」 와 「머신 고르기」 절이 스펙의 절차를 갖는지 본다(스펙 REQ2, REQ3).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const skill = readFileSync(join(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

// 문서의 `## 제목` 절 본문
const section = (heading: string): string => {
  const lines = skill.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  assert.ok(start >= 0, `${heading} 절이 없다`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  return rest.slice(0, end < 0 ? undefined : end).join('\n')
}

describe('REQ2 개인 오버레이', () => {
  test('오버레이 절이 overlay_path.ts 를 불러 고른 파일을 먼저 읽는다', () => {
    const body = section('개인 오버레이')
    assert.ok(body.includes('node "$SKILL_DIR/scripts/overlay_path.ts"'))
    assert.ok(body.includes('**먼저 읽는다**'))
    for (const rel of ['~/.claude/overlays/machine-cleanup.md', '~/.claude/overlays/mac-cleanup.md', '~/.claude/mac-cleanup-overlay.md']) assert.ok(body.includes(rel), rel)
    assert.ok(!body.includes('다음 major 에서 읽기를 끝낸다'))
    assert.ok(body.includes('**종료 코드 3 이면 정리 후보를 만들기 전에 멈춘다.**'))
  })
})

describe('REQ3 머신 고르기', () => {
  const body = section('머신 고르기')

  test('실행 절차보다 앞에 있다', () => {
    assert.ok(skill.indexOf('## 머신 고르기') < skill.indexOf('## 실행 절차'))
  })

  test('「둘 다」, 홈서버와 홈서버에만 있는 대상, 그 밖은 이 맥 순서로 고른다', () => {
    const both = body.indexOf('「둘 다」')
    const home = body.indexOf('홈서버를 말하거나')
    const mac = body.indexOf('그 밖은 이 맥이다')
    assert.ok(both >= 0 && home > both && mac > home, body)
    for (const word of ['백업', '복구본', 'journal', 'snap', 'apt', 'Hermes']) assert.ok(body.includes(word), word)
  })

  test('둘이면 머신마다 승인 질문과 전후 표를 따로 둔다', () => {
    assert.ok(body.includes('승인 질문과 정리 전후 표는 머신 이름을 붙여 머신마다 따로 둔다'))
    assert.ok(body.includes('이 맥을 아래 1~5단계까지 끝낸 뒤 홈서버를 돈다'))
  })

  test('홈서버는 아직 조사하지 않고 알리며, 둘이면 이 맥만 정리한다', () => {
    assert.ok(body.includes('**홈서버 정리는 아직 지원하지 않는다.**'))
    assert.ok(body.includes('조사하지 않고'))
    assert.ok(body.includes('둘이면 이 맥만 정리하고 보고에 같은 줄을 남긴다'))
  })
})
