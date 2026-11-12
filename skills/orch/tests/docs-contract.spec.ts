// 문서의 표·목록이 코드의 원본과 같은지 본다.
//   - waiting.md 종료 코드 7 의 LOOP-EVENT kind 목록과 코드가 알림 파일에 쓰는 kind
//   - gh-call-budget.md 「공유 캐시」 TTL 표와 lib/gh-budget.ts 의 기본 TTL
// 문서만 고치거나 코드만 고치면 코디네이터가 모르는 알림이 오거나 문서와 다른 시간 동안 캐시가 남는다.

import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readTtl } from '../scripts/lib/gh-budget.ts'
import { COMMANDS } from '../scripts/lib/commands.ts'
import { ADVANCE_REASONS } from '../scripts/core/auto-advance.ts'

const ORCH = fileURLToPath(new URL('..', import.meta.url))
const read = (...parts: string[]) => readFileSync(join(ORCH, ...parts), 'utf8')

test('자동 진행 표시와 거절 이유, 코디네이터의 다음 단계 처리는 문서와 같다', () => {
  const board = section(read('references', 'board.md'), '## 자동 진행 표시').join('\n')
  for (const word of ['[auto]', '[ask]', '[wait]', '(스펙:', '(계획:', '(앞 사건:', 'real', '외부로 나가는 글', '범위가 바뀌는 일']) assert.ok(board.includes(word), word)
  const reply = section(read('references', 'replying.md'), '## 다음 단계 이어 가기').join('\n')
  for (const word of ['STEP-READY auto', 'STEP-READY ask', 'orch board auto-check', '다음 단계 자동 진행:', '보드 항목 id:', 'board.auto_advance', 'WORKER-LIMITED', '--on', ...Object.values(ADVANCE_REASONS)]) assert.ok(reply.includes(word), word)
  const waiting = read('references', 'waiting.md')
  for (const word of ['STEP-READY auto', 'STEP-READY ask', '다음 단계 이어 가기']) assert.ok(waiting.includes(word), word)
  assert.equal(read('templates', 'spec-common.md').split('orch-rule: remaining-prs').length - 1, 1)
})

test('보드 안내는 파일 직접 수정 대신 등록된 상태·단계 명령과 남는 board.ts 동작을 가리킨다', () => {
  const doc = read('references', 'board.md')
  assert.match(doc, /`board.json` 은 직접 고치지 않는다/)
  for (const verb of ['set', 'step', 'add-step', 'show', 'get', 'list', 'del']) {
    assert.ok(COMMANDS.some((row) => row.group === 'board' && row.verb === verb))
    assert.ok(doc.includes(`orch board ${verb}`))
  }
  for (const verb of ['set', 'mark']) assert.ok(doc.includes(`board.ts ${verb}`))
  assert.ok(!doc.includes('board.ts del'))
  assert.ok(!doc.includes('`board.ts set/step/mark`'))
})

// `## 제목` 줄 아래부터 다음 같은 단계 제목 전까지
function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.notEqual(start, -1, `${heading} 절이 없다`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,2} /.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

test('waiting.md 는 Orca 깨움과 사용자 답 우선 규칙을 설명한다', () => {
  const doc = read('references', 'waiting.md')
  assert.match(doc, /사용자 답을 먼저 하고/)
  assert.match(doc, /Orca 가 코디네이터를 깨운다/)
  assert.match(doc, /WAITER-LEFT/)
  assert.match(doc, /UNANSWERED/)
})

test('gh-call-budget.md 의 TTL 표는 gh-budget.ts 의 기본 TTL 과 같다', () => {
  const rows = section(read('references', 'gh-call-budget.md'), '## 공유 캐시').filter((line) => /^\| .*\| \d+초 \|/.test(line))
  const ttl = new Map(rows.map((line) => {
    const cells = line.split('|').map((c) => c.trim())
    return [cells[1], Number(/^(\d+)초$/.exec(cells[2])![1])] as const
  }))
  assert.equal(ttl.size, rows.length, '같은 조회가 표에 두 번 있다')

  const saved = { cache: process.env.ORCH_GH_CACHE, ttl: process.env.ORCH_GH_CACHE_TTL_SECONDS }
  delete process.env.ORCH_GH_CACHE
  delete process.env.ORCH_GH_CACHE_TTL_SECONDS
  try {
    const pick = (prefix: string) => [...ttl].find(([name]) => name.startsWith(prefix))![1]
    // 표 행마다 대표 호출 하나를 코드에 물어 같은 시간인지 본다
    const probes: [string, string[]][] = [
      ['표시·목록용', ['pr', 'view', '1']],
      ['표시·목록용', ['pr', 'list']],
      ['표시·목록용', ['pr', 'checks', '1']],
      ['표시·목록용', ['run', 'list']],
      ['표시·목록용', ['run', 'view', '1']],
      ['표시용 REST GET', ['api', 'repos/o/r/pulls']],
      ['표시용 REST GET', ['api', 'graphql', '-f', 'query=query { viewer { login } }']],
      ['표시용 브랜치 규칙 GET', ['api', 'repos/o/r/rules/branches/main']],
      ['`repo view`', ['repo', 'view']],
    ]
    for (const [row, args] of probes) assert.equal(readTtl(args), pick(row), `${args.join(' ')} 의 TTL 이 표 「${row}」 행과 다르다`)
  } finally {
    for (const [key, value] of [['ORCH_GH_CACHE', saved.cache], ['ORCH_GH_CACHE_TTL_SECONDS', saved.ttl]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
