import assert from 'node:assert/strict'
import { test } from 'node:test'
import { featureEvidenceProblem, featureLoopRequested } from '../scripts/lib/feature-evidence.ts'

const HEAD = 'a'.repeat(40)
const BODY = `<!-- fos-feature-evidence -->
검증 커밋: ${HEAD}
인수 검증: 통과 | REQ1 API 응답과 DB 상태 확인, PR 본문의 실행 기록
문서 대조: 통과 | design과 domain 대조, 후보 없음: 기존 계약 재사용
독립 리뷰: 통과 | 독립 검토자의 리뷰 링크
후속 검증: 대기 | 배포 후 smoke, 코디네이터, CI 실행기, 기대값은 본문
<!-- /fos-feature-evidence -->`

test('기능 지시의 첫 줄만 보고 예시와 다른 절은 무시한다', () => {
  for (const heading of ['## 할 일', '## 할 일 · 후속']) {
    for (const prefix of ['', '- ', '1. ', '2) ', '- [ ] ', '* [x] ']) {
      assert.equal(featureLoopRequested(`${heading}\n\n${prefix}**루프를 쓴다(스펙: 새로 쓴다)**\n`), true)
    }
  }
  assert.equal(featureLoopRequested('## 할 일\n루프 없이: 오타\n## 참고\n루프를 쓴다(스펙: a)'), false)
  assert.equal(featureLoopRequested('```md\n## 할 일\n루프를 쓴다(스펙: a)\n```'), false)
})

test('필수 블록 누락, 예시 사본, 중복과 오래된 HEAD 를 막는다', () => {
  assert.ok(featureEvidenceProblem('', HEAD, true))
  assert.equal(featureEvidenceProblem('', HEAD), null)
  assert.ok(featureEvidenceProblem('```md\n' + BODY + '\n```', HEAD, true))
  assert.ok(featureEvidenceProblem(BODY + BODY, HEAD))
  assert.ok(featureEvidenceProblem(BODY, 'b'.repeat(40)))
  assert.ok(featureEvidenceProblem(BODY.replace('문서 대조: 통과', '문서 대조: 통과 | 중복\n문서 대조: 통과'), HEAD))
})

test('인수 검증, 문서 대조와 독립 리뷰는 모두 현재 근거가 필요하다', () => {
  assert.equal(featureEvidenceProblem(BODY, HEAD, true), null)
  for (const key of ['인수 검증', '문서 대조', '독립 리뷰']) {
    assert.ok(featureEvidenceProblem(BODY.replace(`${key}: 통과`, `${key}: 대기`), HEAD))
    assert.ok(featureEvidenceProblem(BODY.replace(new RegExp(`${key}:.*`), `${key}: 통과 | TBD`), HEAD))
    assert.ok(featureEvidenceProblem(BODY.replace(new RegExp(`${key}:.*\n`), ''), HEAD))
  }
})

test('후속 검증 대기는 머지를 허용하지만 완료와 정리는 막는다', () => {
  assert.equal(featureEvidenceProblem(BODY, HEAD), null)
  assert.ok(featureEvidenceProblem(BODY, HEAD, true, true))
  assert.equal(featureEvidenceProblem(BODY.replace('후속 검증: 대기', '후속 검증: 통과'), HEAD, true, true), null)
  assert.equal(featureEvidenceProblem(BODY.replace('후속 검증: 대기', '후속 검증: 없음'), HEAD, true, true), null)
})
