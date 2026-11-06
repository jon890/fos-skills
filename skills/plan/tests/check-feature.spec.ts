// check_feature 의 명령 경계 테스트. 스펙, 기술 설계, 계획 index, 인수 검증 계획의 형식과 연결을 임시 저장소의 파일로 검사한다.
// 옛 test_feature_contract, test_technical_design_contract, test_verification_plan 사례를 명령의 종료 코드와 stdout 줄로 본다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DESIGN, FEATURE, Repo, SKILL_DIR, type Result, UNCONFIRMED, VALID, VALID_REQ } from './helpers.ts'

const ROOT = join(SKILL_DIR, '..', '..')

const SPEC = 'docs/features/cancel/spec.md'
const DESIGN_PATH = 'docs/features/cancel/design.md'
const SAMPLE = readFileSync(join(SKILL_DIR, 'templates', 'verification-plan.md'), 'utf8')

type Plan = Record<string, unknown>

function feature(spec = VALID): Repo {
  const repo = new Repo('plan-feature-')
  repo.file(SPEC, spec)
  return repo
}

const check = (repo: Repo, ...args: string[]): Result => repo.run(FEATURE, args)
const plan = (updates: Plan = {}): Plan => ({ spec: SPEC, requirements: ['R1'], phases: [{ requirements: ['R1'] }], ...updates })

// 계획 index 를 쓰고 `--plan` 으로 검사한다
function checkPlan(repo: Repo, data: Plan, ...flags: string[]): Result {
  repo.file('index.json', JSON.stringify(data))
  return check(repo, SPEC, '--plan', 'index.json', ...flags)
}

const lines = (r: Result) => r.stdout.split('\n').filter(Boolean)

test('도메인 규칙 변경은 확정돼야 하고 draft 는 기다릴 수 있다', () => {
  const table =
    '\n## 도메인 규칙 변경\n| 규칙 | 바꿀 내용 | 결정 상태 | 제안자 | 확정 근거 | 외부 검토 |\n| --- | --- | --- | --- | --- | --- |\n| docs/domain/jobs.md RULE1 | 분류 변경 | 확인 대기 | 기획 | 사용자 확인 예정 | 기획 확인 대기 |\n'
  const run = (text: string, ...flags: string[]) => check(feature(text), SPEC, ...flags).code
  assert.equal(run(VALID + table), 1)
  assert.equal(run(VALID + table, '--draft'), 0)
  const confirmed = table.replace('확인 대기 | 기획', '확정 | 기획').replace('사용자 확인 예정', '사용자 2026-11-04')
  assert.equal(run(VALID + confirmed), 0)
  assert.equal(run(VALID + confirmed.replace('사용자 2026-11-04', '없음')), 1)
  assert.equal(run(VALID + '\n## 도메인 규칙 변경\n도메인 규칙 변경 없음: 기존 규칙 유지'), 0)
})

test('PR 하나는 기능의 요구사항을 모두 갖지 않아도 된다', () => {
  assert.equal(checkPlan(feature(), plan()).code, 0)
})

test('모르는 요구사항과 배정하지 않은 요구사항은 막는다', () => {
  for (const data of [plan({ requirements: ['R3'] }), plan({ requirements: ['R1', 'R2'] }), plan({ phases: [{ requirements: ['R2'] }] })]) {
    assert.equal(checkPlan(feature(), data).code, 1, JSON.stringify(data))
  }
})

test('다른 기능의 같은 ID 는 섞이지 않는다', () => {
  const repo = feature()
  repo.file('docs/features/memory/spec.md', VALID)
  repo.file('index.json', JSON.stringify(plan()))
  const r = check(repo, 'docs/features/memory/spec.md', '--plan', 'index.json')
  assert.equal(r.code, 1)
  assert.ok(r.stdout.includes('검사한 스펙과 계획의 spec 이 다르다'), r.stdout)
})

test('예시 코드 블록은 실제 계약이 되지 않는다', () => {
  assert.equal(check(feature('```markdown\n' + VALID + '\n```'), SPEC).code, 1)
})

test('중복 ID 와 닫히지 않은 결정은 실패한다', () => {
  const cases = [
    VALID.replace('| R2 |', '| R1 |'),
    VALID.replace('| 소유자만 |', '| 미정 |'),
    VALID.replace('| 200 |', '| TBD |'),
    VALID.replace('| 소유자만 |', '|  |'),
    VALID.replace('| D2 |', '| D1 |'),
    VALID.replace('| 작성자 |', '| worker |'),
    VALID.replace('| 기존 멱등 관례 |', '|  |'),
    VALID.replace('타 사용자는 거부', ''),
  ]
  for (const text of cases) assert.equal(check(feature(text), SPEC).code, 1, text)
})

test('올바른 스펙과 위임한 결정은 통과한다', () => {
  assert.equal(check(feature(), SPEC).code, 0)
  assert.equal(check(feature(VALID.replace('| 작성자 |', '| 작성자(위임) |')), SPEC).code, 0)
})

test('결정이 없으면 이유가 한 줄 필요하다', () => {
  const head = VALID.split('## 결정\n')[0]
  assert.equal(check(feature(head + '## 결정\n없음: 기존 API 를 그대로 노출한다\n'), SPEC).code, 0)
  for (const body of ['없음\n', '없음:\n']) assert.equal(check(feature(head + '## 결정\n' + body), SPEC).code, 1, body)
})

test('옛 미결정 절은 결정 표로 바꾸라고 알린다', () => {
  const head = VALID.split('## 결정\n')[0]
  const r = check(feature(head + '## 미결정\n없음\n'), SPEC)
  assert.equal(r.code, 1)
  assert.ok(lines(r).some((line) => line.includes('미결정')), r.stdout)
})

test('확인 줄은 최종 검사만 막고 draft 는 막지 않는다', () => {
  const unconfirmed = check(feature(UNCONFIRMED), SPEC)
  assert.equal(unconfirmed.code, 1)
  assert.ok(lines(unconfirmed).some((line) => line.includes('확인')), unconfirmed.stdout)
  assert.equal(check(feature(UNCONFIRMED), SPEC, '--draft').code, 0)
  assert.equal(check(feature(VALID.replace('2026-11-02\n## 목표', '2026-13-40\n## 목표')), SPEC).code, 1)
  // 본문 안의 확인 줄은 머리가 아니라서 세지 않는다
  assert.equal(check(feature(UNCONFIRMED.replace('## 설계\n', '## 설계\n확인: 2026-11-02\n')), SPEC).code, 1)
})

test('계획과 함께 주면 --draft 여도 확인한 스펙을 요구한다', () => {
  const repo = feature(UNCONFIRMED)
  assert.equal(checkPlan(repo, plan(), '--draft').code, 1)
  assert.equal(check(repo, SPEC, '--draft').code, 0)
})

test('저장소 밖 경로와 잘못된 계획은 실패한다', () => {
  const repo = feature()
  const cases = [plan({ spec: '../elsewhere.md' }), plan({ spec: join(repo.root, SPEC) }), plan({ requirements: 'R1' }), plan({ phases: [null] })]
  for (const data of cases) assert.equal(checkPlan(repo, data).code, 1, JSON.stringify(data))
})

test('이어지지 않는 링크는 0 이 아닌 종료 코드를 낸다', () => {
  const repo = feature()
  repo.file('index.json', JSON.stringify(plan({ spec: 'missing.md' })))
  assert.equal(check(repo, SPEC, '--plan', 'index.json').code, 1)
})

test('스펙 경로가 저장소 밖이거나 없으면 읽지 못해 2 로 끝난다', () => {
  const repo = feature()
  assert.equal(check(repo, 'docs/features/none/spec.md').code, 2)
  assert.equal(check(repo, '/etc/hosts').code, 2)
  assert.equal(check(repo, '../escape.md').code, 2)
})

test('옵션: 고유 접두, 위치 인자 없음과 알 수 없는 옵션', () => {
  const repo = feature(UNCONFIRMED)
  assert.equal(check(repo, SPEC, '--dra').code, 0)
  assert.equal(check(repo, SPEC, '--draft=1').code, 2)
  assert.equal(check(repo).code, 2)
  assert.equal(check(repo, SPEC, '--nope').code, 2)
  assert.equal(check(repo, SPEC, '--require-verification').code, 2)
  assert.equal(check(repo, '--help').code, 0)
})

// 기술 설계

function designRepo(spec = VALID_REQ, design = DESIGN): Repo {
  const repo = feature(spec)
  repo.file(DESIGN_PATH, design)
  return repo
}
const withDesign = (updates: Plan = {}): Plan => ({ spec: SPEC, design: DESIGN_PATH, requirements: ['REQ1'], phases: [{ requirements: ['REQ1'] }], ...updates })

test('새 스펙은 계획을 만들 때까지 기술 설계가 필요 없다', () => {
  const repo = designRepo()
  const noDesign = VALID_REQ.replace('## 설계\n실행 API 의 상태를 통합 테스트로 확인한다.\n', '')
  assert.equal(check(feature(noDesign), SPEC).code, 0)
  assert.equal(checkPlan(repo, withDesign()).code, 0)
  const data = withDesign()
  delete data.design
  const r = checkPlan(repo, data)
  assert.equal(r.code, 1)
  assert.ok(lines(r).some((line) => line.includes('design')), r.stdout)
})

test('없는 설계와 저장소 밖 설계는 계획을 막는다', () => {
  const repo = designRepo()
  for (const design of ['missing.md', '../design.md', join(repo.root, DESIGN_PATH)]) {
    assert.equal(checkPlan(repo, withDesign({ design })).code, 1, design)
  }
})

test('연결하지 않은 요구사항, 모르는 ID, 빈 절, 열린 결정은 설계를 막는다', () => {
  const cases = [
    DESIGN.replace('| REQ2 | 조건부 상태 갱신을 사용한다 |', ''),
    DESIGN.replace('REQ2', 'REQ9'),
    DESIGN.replace('작업 모듈이 상태를 소유한다.', ''),
    DESIGN.replace('없음: 기존 구조를 유지한다.', '| DECISION1 | 저장소 | TBD | 작성자 | 관례 |'),
  ]
  for (const design of cases) assert.equal(check(designRepo(VALID_REQ, design), SPEC, '--design', DESIGN_PATH).code, 1, design)
  assert.equal(check(designRepo(), SPEC, '--design', DESIGN_PATH).code, 0)
})

test('스펙 안의 기술 설계는 중첩한 절을 쓴다', () => {
  const nested = DESIGN.split('\n')
    .slice(1)
    .map((line) => (line.startsWith('## ') ? '### ' + line.slice(3) : line))
    .join('\n')
  const repo = feature(VALID_REQ + '\n## 기술 설계\n' + nested)
  assert.equal(checkPlan(repo, withDesign({ design: SPEC })).code, 0)
  assert.equal(check(repo, SPEC, '--design', SPEC).code, 0)
})

test('--design 검사는 사용자 확인 줄을 요구한다', () => {
  const ok = check(designRepo(), SPEC, '--design', DESIGN_PATH, '--draft')
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  const failed = check(designRepo(VALID_REQ.replace('확인: 2026-11-02\n', '')), SPEC, '--design', DESIGN_PATH, '--draft')
  assert.equal(failed.code, 1, failed.stdout)
})

test('기존 R 형식 계획은 기술 설계 연결 없이 읽는다', () => {
  assert.equal(checkPlan(feature(VALID), plan()).code, 0)
})

// 인수 검증 계획

const VERIFICATION = SAMPLE.replaceAll('REQ1', 'R1').replaceAll('REQ2', 'R2')
const PLAN_DIR = 'docs/features/cancel/tasks/cancel-api'
const withVerification = (updates: Plan = {}): Plan => ({
  spec: SPEC,
  requirements: ['R1', 'R2'],
  verification_plan: 'verification-plan.md',
  phases: [{ requirements: ['R1', 'R2'] }],
  ...updates,
})

function verificationRepo(text = VERIFICATION): Repo {
  const repo = feature()
  repo.file(`${PLAN_DIR}/verification-plan.md`, text)
  return repo
}

function checkVerification(repo: Repo, data: Plan, required = false): Result {
  repo.file(`${PLAN_DIR}/index.json`, JSON.stringify(data))
  return check(repo, SPEC, '--plan', `${PLAN_DIR}/index.json`, ...(required ? ['--require-verification'] : []))
}

test('양식은 여러 사례를 받고 요구사항 누락을 막는다', () => {
  assert.equal(checkVerification(verificationRepo(), withVerification(), true).code, 0)
  const without = VERIFICATION.split('\n')
    .filter((line) => !line.startsWith('| R2 |'))
    .join('\n')
  const r = checkVerification(verificationRepo(without), withVerification())
  assert.equal(r.code, 1)
  assert.ok(lines(r).some((line) => line.includes('R2') && line.includes('없는 요구사항')), r.stdout)
  const both = checkVerification(verificationRepo(VERIFICATION.replace('| R2 |', '| R1 |')), withVerification({ requirements: ['R1'], phases: [{ requirements: ['R1'] }] }))
  assert.equal(both.code, 0, both.stdout)
})

test('이번 PR 밖의 사례와 빈 절차는 통과하지 못한다', () => {
  const cases = [
    VERIFICATION.replace('| R2 |', '| R3 |'),
    VERIFICATION.replace('두 요청 성공, 취소 이력 1건', ''),
    VERIFICATION.replace('두 요청 성공, 취소 이력 1건', '{{actual expectation}}'),
    '```markdown\n' + VERIFICATION + '\n```',
  ]
  for (const text of cases) assert.equal(checkVerification(verificationRepo(text), withVerification()).code, 1, text)
})

test('명령 안의 이스케이프한 파이프는 칸을 늘리지 않는다', () => {
  const text = VERIFICATION.replace('다른 사용자로 취소 API 를 호출하고 저장 상태를 조회', '`pytest tests/test_cancel.py \\| tee results.log`')
  const r = checkVerification(verificationRepo(text), withVerification())
  assert.equal(r.code, 0, r.stdout)
})

test('머지·배포가 필요한 검증은 PR 전이 될 수 없다', () => {
  for (const text of [VERIFICATION.replace('| 없음 | PR 전 |', '| 배포 | PR 전 |'), VERIFICATION.replace('| PR 전 |', '| 나중에 |')]) {
    assert.equal(checkVerification(verificationRepo(text), withVerification()).code, 1, text)
  }
  const after = VERIFICATION.replace('| 없음 | PR 전 |', '| 배포 후 | PR 뒤 |')
  assert.equal(checkVerification(verificationRepo(after), withVerification()).code, 0)
})

test('검증 계획 경로는 이 계획 폴더 기준이다', () => {
  const repo = verificationRepo()
  repo.file('docs/features/cancel/outside.md', VERIFICATION)
  for (const rel of ['../../outside.md', join(repo.root, 'docs/features/cancel/outside.md'), 'missing.md', '']) {
    assert.equal(checkVerification(repo, withVerification({ verification_plan: rel })).code, 1, rel)
  }
  symlinkSync(join(repo.root, 'docs/features/cancel/outside.md'), join(repo.root, PLAN_DIR, 'linked.md'))
  assert.equal(checkVerification(repo, withVerification({ verification_plan: 'linked.md' })).code, 1)
})

test('phase 안의 검증 계획과 필드 없는 옛 계획을 받는다', () => {
  const repo = verificationRepo()
  repo.file(`${PLAN_DIR}/phase-01.md`, '# phase\n## 목표\n취소\n' + VERIFICATION)
  assert.equal(checkVerification(repo, withVerification({ verification_plan: 'phase-01.md' })).code, 0)
  const old = withVerification()
  delete old.verification_plan
  assert.equal(checkVerification(repo, old).code, 0)
  assert.equal(checkVerification(repo, old, true).code, 1)
})

test('스펙과 설계 양식은 실제 사용자 확인을 요구한다', () => {
  const specTemplate = join(ROOT, 'skills/spec/templates/spec.md')
  const designTemplate = join(ROOT, 'skills/technical-design/templates/design.md')
  if (!existsSync(specTemplate) || !existsSync(designTemplate)) return
  const repo = new Repo('plan-template-')
  repo.file('spec.md', readFileSync(specTemplate, 'utf8'))
  repo.file('design.md', readFileSync(designTemplate, 'utf8'))
  assert.equal(check(repo, 'spec.md', '--draft').code, 0)
  assert.equal(check(repo, 'spec.md').code, 1)
  assert.equal(check(repo, 'spec.md', '--design', 'design.md', '--draft').code, 1)
  // 확인 줄만 채운 스펙은 설계와 함께 통과한다
  const confirmed = readFileSync(specTemplate, 'utf8').replace(/^(# .*\n)/, '$1확인: 2026-11-02\n')
  repo.file('spec.md', confirmed)
  const r = check(repo, 'spec.md', '--design', 'design.md')
  assert.equal(r.code, 0, r.stdout)
})

test('경로는 심볼릭 링크를 먼저 따라간 뒤 `..` 를 처리한다', () => {
  const repo = new Repo('plan-symlink-')
  repo.file('docs/nested/.keep')
  repo.file('docs/spec.md', UNCONFIRMED)
  repo.file('spec.md', VALID)
  symlinkSync(join(repo.root, 'docs/nested'), join(repo.root, 'alias'))
  assert.equal(check(repo, 'alias/../spec.md').code, 1)
  assert.equal(check(repo, 'spec.md').code, 0)
})

test('확인 줄의 공백은 Python 의 공백 집합으로 본다', () => {
  const withGap = (gap: string) => VALID.replace('확인: 2026-11-02', `확인:${gap}2026-11-02`)
  assert.equal(check(feature(withGap('﻿')), SPEC).code, 1)
  assert.equal(check(feature(withGap('\u001F')), SPEC).code, 0)
  assert.equal(check(feature(withGap(' ')), SPEC).code, 0)
})
