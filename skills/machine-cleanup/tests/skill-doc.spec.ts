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

  test('홈서버는 홈서버 절차로 돌고, 실패하면 홈서버는 지우지 않고 이 맥은 끝까지 정리한다', () => {
    assert.ok(body.includes('`references/homeserver.md`'))
    assert.ok(body.includes('**오버레이를 찾지 못했거나, 접속하지 못했거나, 조사가 실패하면 홈서버는 아무것도 지우지 않는다.**'))
    assert.ok(body.includes('이 맥은 끝까지 정리하고, 보고에 「홈서버 조사하지 못함」 과 원인, 고칠 곳을 적는다'))
    assert.ok(!body.includes('아직 지원하지 않는다'))
  })
})

describe('홈서버 절차(REQ3, REQ6, REQ7, REQ12)', () => {
  const doc = readFileSync(join(import.meta.dirname, '..', 'references', 'homeserver.md'), 'utf8')
  const targets = readFileSync(join(import.meta.dirname, '..', 'references', 'homeserver-targets.md'), 'utf8')

  test('스킬 설명에 홈서버 낱말이 있다', () => {
    const head = skill.slice(0, skill.indexOf('---', 4))
    for (const word of ['홈서버 정리', '백업 정리', 'journal 정리', 'Hermes 세션 정리']) assert.ok(head.includes(word), word)
  })

  test('승인 질문은 머신마다 따로 두고, 표에 없는 용도는 지울지와 표에 올릴지를 함께 묻는다', () => {
    assert.ok(doc.includes('승인 질문은 맥과 따로 둔다'))
    assert.ok(doc.includes('**표에 없는 백업 용도는 용도마다 지울지와 보관 규칙 표에 올릴지를 함께 묻는다.**'))
    assert.ok(targets.includes('**표에 없는 용도는 3단계 승인에서 용도마다 두 가지를 함께 묻는다.**'))
  })

  test('이미지, 백업, 운영 checkout 은 잠금 아래에서 지우고 prune -a 와 sudo 는 스킬이 돌리지 않는다', () => {
    assert.ok(doc.includes('**Docker 이미지, 백업, 운영 checkout 의 브랜치와 워크트리는 `--lock "$LOCK"` 으로 돌린다.**'))
    assert.ok(doc.includes('**sudo 가 필요한 명령은 직접 돌리지 않는다.**'))
    assert.ok(targets.includes('**`docker image prune -a` 와 `docker system prune -a` 는 쓰지 않는다.**'))
  })

  test('실패 처리가 오버레이 없음, 접속 실패, 조사 실패를 모두 다룬다', () => {
    const fail = doc.slice(doc.indexOf('## 실패 처리'))
    for (const w of ['오버레이 없음', '접속 실패', '조사 실패', '**홈서버는 아무것도 지우지 않는다.**']) assert.ok(fail.includes(w), w)
  })
})
