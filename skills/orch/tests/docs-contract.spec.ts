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
  for (const word of ['[auto]', '[ask]', '[wait]', '(스펙:', '(계획:', '(앞 사건:', 'real', 'feature-loop.md#전이']) assert.ok(board.includes(word), word)
  const featureLoop = section(read('references', 'feature-loop.md'), '## 전이').join('\n')
  for (const word of ['spec → technical-design → plan → implementation', 'PR 이 머지됐거나', '결정(스펙 확인 등)에 답한 직후', '다음 지시서를 써서 바로 띄운다', '다음 worker 를 띄울지 다시 묻지 않는다', '새로 정해야 할 사용자 결정', '허락 범위 밖']) assert.ok(featureLoop.includes(word), word)
  const reply = section(read('references', 'replying.md'), '## 다음 단계 이어 가기').join('\n')
  for (const word of ['STEP-READY auto', 'STEP-READY ask', 'orch board auto-check', '다음 단계 자동 진행:', '보드 항목 id:', 'board.auto_advance', 'WORKER-LIMITED', '--on', ...Object.values(ADVANCE_REASONS)]) assert.ok(reply.includes(word), word)
  const waiting = read('references', 'waiting.md')
  for (const word of ['STEP-READY auto', 'STEP-READY ask', '다음 단계 이어 가기']) assert.ok(waiting.includes(word), word)
  assert.equal(read('templates', 'spec-common.md').split('orch-rule: remaining-prs').length - 1, 1)
})

test('보드 안내는 파일 직접 수정 대신 등록된 상태·단계 명령과 남는 board.ts 동작을 가리킨다', () => {
  const doc = read('references', 'board.md')
  assert.match(doc, /`board.json` 은 직접 고치지 않는다/)
  for (const verb of ['set', 'step', 'add-step', 'show', 'get', 'list', 'del', 'clear-done']) {
    assert.ok(COMMANDS.some((row) => row.group === 'board' && row.verb === verb))
    assert.ok(doc.includes(`orch board ${verb}`))
  }
  for (const verb of ['set', 'mark', 'detail-edit']) assert.ok(doc.includes(`board.ts ${verb}`))
  assert.ok(!doc.includes('board.ts del'))
  assert.ok(!doc.includes('`board.ts set/step/mark`'))
})

test('content-preview 와 spec 의 사용자 확인은 replying.md 「보드 승인」 을 가리킨다', () => {
  assert.ok(read('references', 'replying.md').split('\n').includes('## 보드 승인'), 'replying.md 에 「보드 승인」 절이 없다')
  const pointer = '`references/replying.md` 「보드 승인」'
  const callers: [string, string, string][] = [
    ['content-preview', join(ORCH, '..', '..', 'export-only-skills', 'content-preview', 'SKILL.md'), '--kind post'],
    ['spec', join(ORCH, '..', 'spec', 'SKILL.md'), '--kind spec'],
  ]
  for (const [name, file, kind] of callers) {
    const doc = readFileSync(file, 'utf8')
    assert.ok(doc.includes(pointer), `${name} SKILL.md 가 「보드 승인」 을 가리키지 않는다`)
    assert.ok(doc.includes(`orch board approval add <id> ${kind}`), `${name} SKILL.md 에 ${kind} 승인 대기 명령이 없다`)
    assert.ok(doc.includes('orch 없이 쓰면 지금처럼 채팅으로 확인'), `${name} SKILL.md 에 orch 없는 환경의 채팅 확인 갈래가 없다`)
  }
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

test('모델 비교 절차, 두 틀, evidence 비교 절은 서로 가리키고 결정값을 담는다', () => {
  const procedure = read('references', 'model-compare.md')
  for (const link of ['../templates/spec-compare-review.md', '../templates/model-compare-record.md', 'docs/features/model-auto-routing/spec.md']) {
    assert.ok(procedure.includes(link), `model-compare.md 가 ${link} 를 가리키지 않는다`)
  }
  // 사용자 결정값(스펙 DECISION4~8, 17)이 절차에서 빠지면 비교가 다른 기준으로 돈다
  for (const word of ['5건', '1.5배', '2배', '3건 이상', '5건 중 1건 이하', '후보 밖: 비교', '무승부', '나쁜 건', 'orch board approval add', '--lint-ack']) {
    assert.ok(procedure.includes(word), `model-compare.md 에 「${word}」 가 없다`)
  }
  for (const name of ['spec-compare-review.md', 'model-compare-record.md']) {
    assert.ok(read('templates', name).includes('skills/orch/references/model-compare.md'), `${name} 가 절차 문서를 가리키지 않는다`)
  }
  assert.ok(read('templates', 'model-compare-record.md').includes('docs/features/orch-routing/evidence.md'))
  const evidence = section(readFileSync(join(ORCH, '..', '..', 'docs', 'features', 'orch-routing', 'evidence.md'), 'utf8'), '## 같은 일 두 모델 비교').join('\n')
  for (const link of ['skills/orch/references/model-compare.md', 'skills/orch/templates/model-compare-record.md']) assert.ok(evidence.includes(link), link)
  assert.ok(read('references', 'agent-selection.md').includes('(model-compare.md)'), 'agent-selection.md 가 model-compare.md 를 가리키지 않는다')
})

test('모델 비교 절차는 두 worker 줄, 숨긴 리뷰, 머지, 판단 순서를 스펙 결정대로 적는다', () => {
  const procedure = read('references', 'model-compare.md')
  // 후보 줄은 스펙 REQ18 과 글자까지 같다. 지금 모델 줄도 후보 밖 이유를 적는다
  const launch = section(procedure, '## 두 worker 띄우기').join('\n')
  assert.ok(launch.includes('`후보 밖: 비교, <지금 모델> 대조(사용자 결정 2026-11-20)`'), '후보 줄이 스펙 REQ18 과 다르다')
  assert.ok(launch.includes('`후보 밖: 비교 기준, <후보 모델> 대조(사용자 결정 2026-11-20)`'), '지금 모델 줄의 후보 밖 이유가 없다')
  // 표가 옛 세대일 때 지금 모델 쪽 worker 가 MODEL-OUTDATED 로 막히지 않게 새 세대를 적는다(verification.md 결함 2)
  for (const word of ['MODEL-TABLE-STALE', 'MODEL-OUTDATED', '새 세대를 적는다']) assert.ok(launch.includes(word), `두 worker 띄우기에 「${word}」 가 없다`)
  // 비교 id 와 숨긴 리뷰 틀에 모델 이름이 들어가지 않는다(결함 1). 순서 파일의 뜻을 적는다(결함 3)
  const start = section(procedure, '## 비교 시작').join('\n')
  assert.ok(start.includes('`compare-<행>-<시작 날짜>-<번호>`') && !start.includes('compare-<모델>'), '비교 id 에 모델 이름이 들어간다')
  const review = section(procedure, '## 숨긴 리뷰').join('\n')
  assert.ok(review.includes('`base=A` 는 `A.diff` 가 지금 모델의 PR'), '순서 파일의 뜻이 없다')
  assert.ok(review.includes('`spec.md`'), '리뷰어에게 모델 줄을 뺀 지시서 사본을 넘기지 않는다')
  const template = read('templates', 'spec-compare-review.md').split('\n').filter((line) => !line.startsWith('<!--')).join('\n')
  for (const leak of ['모델 이름', '후보 모델', '지금 모델', '원래 지시서 경로', 'compare-keys']) assert.ok(!template.includes(leak), `숨긴 리뷰 틀 본문에 「${leak}」 가 있다`)
  // 머지: 갈리면 P1·P2, 같으면 준비까지 분(스펙 DECISION34)
  const merge = section(procedure, '## 머지와 건의 결과').join('\n')
  assert.match(merge, /P1·P2 수가 적은 쪽을 머지한다\. P1·P2 수도 같으면 준비까지 분이 짧은 쪽을 머지한다/)
  // 머지 전에는 routing-log 가 없어 준비까지 분을 띄우기 기록과 준비됨 status 에서 읽는다
  for (const word of ['launch-history.jsonl', '`준비됨 #<PR>`']) assert.ok(merge.includes(word), `머지 절에 「${word}」 가 없다`)
  // 판단은 문제 → 시간 → 비용 순서다(스펙 DECISION5). 정의의 원본은 DECISION33 이다
  const judge = section(procedure, '## 5건 뒤 판단').filter((line) => /^\d\. /.test(line)).map((line) => line.slice(3, 5))
  assert.deepEqual(judge, ['문제', '시간', '비용'])
  assert.ok(section(procedure, '## 건마다 기록할 값').join('\n').includes('DECISION33'))
  const spec = readFileSync(join(ORCH, '..', '..', 'docs', 'features', 'model-auto-routing', 'spec.md'), 'utf8')
  for (const id of ['DECISION33', 'DECISION34']) assert.match(spec, new RegExp(`^\\| ${id} \\|.*\\| 사용자 2026-11-23 \\|`, 'm'), `스펙 결정 표에 ${id} 가 없다`)
})

test('공통 지시서는 worker 가 이유 없이 기준 브랜치를 합치지 않게 한다', () => {
  const common = read('templates', 'spec-common.md')
  const rule = common.split('\n').find((line) => line.includes('orch-rule: no-early-base-merge')) ?? ''
  assert.match(rule, /충돌이 났거나 코디네이터나 머지 큐가 요청했을 때만 합친다/)
  assert.match(read('references', 'verification.md'), /최종 최신화는 큐가 머지 직전에 하므로/)
  // 준비됨 뒤에 기준 브랜치 변경을 worker 가 처리하라는 반대 문장이 없다
  for (const doc of [common, read('SKILL.md'), read('references', 'replying.md')]) assert.ok(!doc.includes('기준 브랜치 변경'))
})
