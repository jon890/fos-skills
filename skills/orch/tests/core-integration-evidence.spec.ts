// 통합 테스트 기록 판정(core/integration-evidence.ts)의 규칙 읽기, 바뀐 모듈 찾기, 본문 판정을 본다.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ConfigError } from '../scripts/core/config.ts'
import { integrationNeeds, integrationProblems, integrationRules } from '../scripts/core/integration-evidence.ts'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const RULE = { paths: 'modules/<모듈>/src/main/**', command: './gradlew :<모듈>:integrationTest' }
const rules = integrationRules({ queue: { integration_tests: [RULE] } })
const need = (module: string) => ({ module, command: `./gradlew :${module}:integrationTest` })
const record = (module: string, commit = HEAD) => `- 통합 테스트 통과: ${module} | ./gradlew :${module}:integrationTest | ${commit}`

describe('integrationRules', () => {
  test('설정이 없으면 규칙이 없다', () => {
    assert.deepEqual(integrationRules({}), [])
    assert.deepEqual(integrationRules({ queue: { integration_tests: [] } }), [])
  })

  for (const [name, value] of [
    ['목록이 아니다', { paths: 'a/<모듈>/**', command: 'x' }],
    ['모듈 자리가 없다', [{ paths: 'a/**', command: 'x' }]],
    ['모듈 자리가 둘이다', [{ paths: '<모듈>/<모듈>/**', command: 'x' }]],
    ['명령이 비었다', [{ paths: 'a/<모듈>/**', command: ' ' }]],
    ['모르는 키가 있다', [{ paths: 'a/<모듈>/**', command: 'x', when: 'y' }]],
    ['모듈 목록 대신 문자열을 썼다', [{ ...RULE, modules: 'core' }]],
    ['모듈 목록이 비었다', [{ ...RULE, modules: [] }]],
    ['모듈 이름 대신 경로를 썼다', [{ ...RULE, modules: ['modules/core'] }]],
    ['모듈 이름이 공백이다', [{ ...RULE, modules: [' '] }]],
    ['모듈 이름에 줄바꿈이 있다', [{ ...RULE, modules: ['core\n'] }]],
  ] as const) {
    test(`꼴이 틀리면 ConfigError 다: ${name}`, () => {
      assert.throws(() => integrationRules({ queue: { integration_tests: value } }), ConfigError)
    })
  }
})

describe('integrationNeeds', () => {
  test('패턴에 맞는 파일의 모듈을 이름 순서로 한 번씩 낸다', () => {
    const files = ['modules/zeta/src/main/A.kt', 'modules/core/src/main/x/B.kt', 'modules/core/src/main/C.kt', 'modules/core/src/test/D.kt', 'docs/a.md']
    assert.deepEqual(integrationNeeds(files, rules), [need('core'), need('zeta')])
  })

  test('경로 전체가 맞아야 하고 모듈 자리는 경로 조각 하나다', () => {
    assert.deepEqual(integrationNeeds(['x/modules/core/src/main/A.kt', 'modules/a/b/src/main/A.kt'], rules), [])
  })

  test('**/ 는 시작과 경로 중간에서 폴더 0개 이상과 맞는다', () => {
    const nested = integrationRules({ queue: { integration_tests: [{
      ...RULE,
      paths: ['**/<모듈>/src/main/**', 'modules/**/<모듈>/x/**'],
    }] } })
    const files = ['core/src/main/A.kt', 'apps/deep/api/src/main/A.kt', 'modules/data/x/A.kt', 'modules/apps/deep/web/x/A.kt', 'modules/ignored/y/A.kt']
    assert.deepEqual(integrationNeeds(files, nested), [need('api'), need('core'), need('data'), need('web')])
  })

  test('모듈 목록은 그 규칙에만 적용하고 이름 전체를 비교한다', () => {
    const scoped = integrationRules({ queue: { integration_tests: [
      { ...RULE, modules: ['core'] },
      { ...RULE, command: 'make verify-<모듈>' },
    ] } })
    const files = ['modules/core/src/main/A.kt', 'modules/core-web/src/main/B.ts']
    assert.deepEqual(integrationNeeds(files, scoped), [
      need('core'),
      { module: 'core', command: 'make verify-core' },
      { module: 'core-web', command: 'make verify-core-web' },
    ])
  })
})

describe('integrationProblems', () => {
  const body = (...lines: string[]) => `## 요약\n본문\n\n## 검증\n${lines.join('\n')}\n\n## 결정\n없음\n`

  test('바뀐 모듈이 없으면 문제가 없다', () => {
    assert.deepEqual(integrationProblems('', HEAD, []), { reasons: [], notes: [] })
  })

  test('검증 절에 head 커밋 기록이 있으면 통과다', () => {
    assert.deepEqual(integrationProblems(body(record('core')), HEAD, [need('core')]), { reasons: [], notes: [] })
  })

  test('기록이 없으면 모듈과 명령을 알린다', () => {
    assert.deepEqual(integrationProblems(body('- 단위 테스트 통과'), HEAD, [need('core')]).reasons, ['통합 테스트 기록 없음: core (./gradlew :core:integrationTest)'])
  })

  test('검증 절 밖에서 찾은 기록은 위치를 알리고 코드 블록 안의 기록은 읽지 않는다', () => {
    const outside = `${record('core')}\n${body()}`
    const fenced = body('```', record('core'), '```')
    assert.deepEqual(integrationProblems(outside, HEAD, [need('core')]).reasons, ['통합 테스트 기록이 검증 절 밖에 있다: core (./gradlew :core:integrationTest)'])
    assert.match(integrationProblems(fenced, HEAD, [need('core')]).reasons.join(), /기록 없음: core/)
    assert.deepEqual(integrationProblems(`${body(record('core'))}\n${record('core')}`, HEAD, [need('core')]).reasons, [])
  })

  test('커밋이 head 와 다르면 head 가 아니라고 알린다. accept 가 받으면 통과다', () => {
    assert.deepEqual(integrationProblems(body(record('core', OLD)), HEAD, [need('core')]).reasons, ['통합 테스트 기록이 head 가 아니다: core'])
    assert.deepEqual(integrationProblems(body(record('core', OLD)), HEAD, [need('core')], (c) => c === OLD).reasons, [])
  })

  test('명령이 규칙과 다르면 그 명령의 기록이 없다', () => {
    const text = body('- 통합 테스트 통과: core | ./gradlew test | ' + HEAD)
    assert.match(integrationProblems(text, HEAD, [need('core')]).reasons.join(), /기록 없음: core/)
  })

  test('이유가 있는 생략 줄은 넘기고 notes 로 보인다. 이유가 비면 생략이 아니다', () => {
    assert.deepEqual(integrationProblems('통합 테스트 생략: core 주석만 바꿨다', HEAD, [need('core')]), { reasons: [], notes: ['통합 테스트 생략 core: 주석만 바꿨다'] })
    assert.match(integrationProblems('- 통합 테스트 생략: core', HEAD, [need('core')]).reasons.join(), /기록 없음: core/)
  })

  test('HTML 주석 안의 생략 줄과 기록 줄은 읽지 않는다', () => {
    const text = body('<!--', record('core'), '-->') + '\n<!-- 통합 테스트 생략: core 틀 예시 -->\n'
    assert.deepEqual(integrationProblems(text, HEAD, [need('core')]), { reasons: ['통합 테스트 기록 없음: core (./gradlew :core:integrationTest)'], notes: [] })
  })

  test('뒤에 글이 붙은 펜스 줄은 열린 코드 블록을 닫지 않는다', () => {
    const text = body('```', '```bash', record('core'), '```')
    assert.match(integrationProblems(text, HEAD, [need('core')]).reasons.join(), /기록 없음: core/)
  })

  test('칸의 백틱, 번호와 체크박스 목록, 굵은 제목을 받는다', () => {
    const lines = [
      `1. 통합 테스트 통과: \`core\` | \`./gradlew :core:integrationTest\` | \`${HEAD}\``,
      `- [x] 통합 테스트 통과: api | ./gradlew :api:integrationTest | ${HEAD}`,
    ]
    const text = `## **검증**\n${lines.join('\n')}\n`
    assert.deepEqual(integrationProblems(text, HEAD, [need('api'), need('core')]).reasons, [])
  })

  test('커밋이 40자리가 아니면 따로 알린다', () => {
    assert.deepEqual(integrationProblems(body(record('core', 'a'.repeat(7))), HEAD, [need('core')]).reasons, ['통합 테스트 기록의 커밋이 40자리가 아니다: core'])
  })

  test('한 모듈에 규칙이 둘이면 명령마다 기록이 필요하다', () => {
    const two = integrationRules({ queue: { integration_tests: [RULE, { paths: 'modules/<모듈>/src/main/**', command: 'make it-<모듈>' }] } })
    const needs = integrationNeeds(['modules/core/src/main/A.kt'], two)
    assert.deepEqual(needs, [need('core'), { module: 'core', command: 'make it-core' }])
    assert.deepEqual(integrationProblems(body(record('core')), HEAD, needs).reasons, ['통합 테스트 기록 없음: core (make it-core)'])
  })

  test('여러 모듈은 모듈마다 따로 본다', () => {
    const text = body(record('core'), record('api', OLD)) + '\n통합 테스트 생략: batch 설정 문구만 바꿨다\n'
    const result = integrationProblems(text, HEAD, [need('api'), need('batch'), need('core'), need('web')])
    assert.deepEqual(result.reasons, ['통합 테스트 기록이 head 가 아니다: api', '통합 테스트 기록 없음: web (./gradlew :web:integrationTest)'])
    assert.deepEqual(result.notes, ['통합 테스트 생략 batch: 설정 문구만 바꿨다'])
  })
})
