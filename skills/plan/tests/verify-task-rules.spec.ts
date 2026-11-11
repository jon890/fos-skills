// 오버레이가 지정한 생성 파일, 계약 검증 명령, 통합 테스트 표지의 명령 경계 회귀 테스트.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspect, Repo, verify, writePlan } from './helpers.ts'

test('staged 생성 파일 예외는 설정한 glob 만 허용하고 신규 테스트 누락은 막는다', () => {
  const repo = new Repo('plan-generated-', true)
  repo.file('docs/flow.md', '# 흐름')
  repo.file('.claude/plan-overlay.md', '| 생성 파일 | `docs/adr/INDEX.md` `generated/**/*.json` |\n')
  writePlan(repo, 'plan1-x', [{ entries: [['tests/test_app.py', '신규']] }])
  repo.git('add', '-A')
  repo.git('commit', '--quiet', '-m', 'initial')
  for (const rel of ['docs/adr/INDEX.md', 'generated/a.json', 'generated/sub/b.json', 'unrelated.md']) repo.file(rel, 'generated')
  repo.git('add', '-A')
  const run = () => verify(repo, ['--staged', 'tasks/plan1-x/phase-01.md'])
  const missing = run()
  assert.deepEqual(missing.violations, [
    'tasks/plan1-x/phase-01.md — phase 범위 밖의 staged 파일: unrelated.md',
    'tasks/plan1-x/phase-01.md — 신규로 적은 파일이 staged 에 없다: tests/test_app.py',
  ])
  repo.file('tests/test_app.py', 'def test_app(): pass')
  repo.git('add', 'tests/test_app.py')
  repo.git('reset', '--quiet', '--', 'unrelated.md')
  assert.equal(run().code, 0)
  repo.file('.claude/plan-overlay.md', '# 설정 없음')
  assert.ok(run().violations.some((line) => line.includes('범위 밖') && line.includes('INDEX.md')))
})

const rules = [{ files: ['contracts/**/*.yaml'], commands: ['scripts/verify.sh contracts', 'scripts/verify.sh backend'] }]
const contractFiles = {
  '.claude/plan-overlay.md': '| 계약 검증 규칙 | `.claude/contract-checks.json` |\n',
  '.claude/contract-checks.json': JSON.stringify(rules),
}
const inspectContract = (command: string, files = contractFiles, rel = 'contracts/api.yaml') => inspect('### 1. 계약 수정', command, [[rel, '수정']], { files })

test('계약 경로에 대응하는 검증 명령은 같은 phase 의 셸 블록에 있어야 한다', () => {
  for (const command of ['scripts/verify.sh contracts', 'scripts/verify.sh backend', './scripts/verify.sh contracts']) {
    const r = inspectContract(command)
    assert.equal(r.violations.some((line) => line.includes('계약 파일 변경')), false, r.stdout)
  }
  for (const command of ['./gradlew build', 'echo scripts/verify.sh contracts', 'scripts/verify.sh contracts-other', 'cd wrong && scripts/verify.sh contracts']) {
    assert.ok(inspectContract(command).violations.some((line) => line.includes('계약 파일 변경')), command)
  }
  assert.ok(inspectContract('cd contracts && ../scripts/verify.sh contracts').violations.every((line) => !line.includes('계약 파일 변경')))
  assert.ok(inspectContract('pytest', contractFiles, 'src/app.py').violations.every((line) => !line.includes('계약 파일 변경')))
  const without = inspectContract('pytest', { '.claude/plan-overlay.md': '', '.claude/contract-checks.json': '[]' })
  assert.ok(without.violations.every((line) => !line.includes('계약 파일 변경')))
  assert.ok(inspectContract('pytest', contractFiles, 'contracts/**/*.yaml').violations.some((line) => line.includes('계약 파일 변경')))
  const prose = inspect('### 1. 계약 수정\n검증 명령: `scripts/verify.sh contracts`', 'pytest', [['contracts/api.yaml', '삭제']], { files: contractFiles })
  assert.ok(prose.violations.some((line) => line.includes('계약 파일 변경')))
})

test('계약 규칙 설정 오류를 조용히 무시하지 않는다', () => {
  const r = inspectContract('pytest', { ...contractFiles, '.claude/contract-checks.json': '[{"files":[],"commands":[]}]' })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('files glob 목록'), r.stderr)
})

test('하위 프로젝트의 계약 검증 규칙은 그 경로에 적용한다', () => {
  const files = {
    ...contractFiles,
    'api/.claude/plan-overlay.md': '| 계약 검증 규칙 | `api/checks.json` |\n',
    'api/checks.json': JSON.stringify([{ files: ['api/contracts/*.yaml'], commands: ['scripts/verify.sh api'] }]),
  }
  assert.ok(inspectContract('scripts/verify.sh contracts', files, 'api/contracts/a.yaml').violations.some((line) => line.includes('계약 파일 변경')))
  assert.ok(inspectContract('scripts/verify.sh api', files, 'api/contracts/a.yaml').violations.every((line) => !line.includes('계약 파일 변경')))
})

const integrationFiles = {
  '.claude/plan-overlay.md': '| 통합 테스트 표지 | `@IntegrationTest` |\n',
  'app/src/test/java/example/JobTest.java': 'package example;\n@IntegrationTest\nclass JobTest {}',
}
const inspectIntegration = (command: string, files = integrationFiles) => inspect('### 1. 테스트 수정', command, [['app/src/test/java/example/JobTest.java', '수정']], { files })

test('일반 Gradle test 의 필터가 통합 테스트를 고르면 경고한다', () => {
  for (const filter of ['*JobTest', 'example.JobTest', 'example.JobTest.method', '*JobTest.method', 'JobTest']) {
    const r = inspectIntegration(`./gradlew :app:test --tests '${filter}'`)
    assert.ok(r.warnings.some((line) => line.includes('통합 테스트 표지')), r.stdout)
  }
  assert.ok(inspectIntegration('./gradlew :app:test --tests=example.JobTest').warnings.some((line) => line.includes('통합 테스트 표지')))
  for (const command of ['./gradlew :app:integrationTest --tests JobTest', './gradlew :app:test --tests OtherTest']) {
    assert.ok(inspectIntegration(command).warnings.every((line) => !line.includes('통합 테스트 표지')), command)
  }
  const unmarked = { ...integrationFiles, 'app/src/test/java/example/JobTest.java': '// @IntegrationTest\nclass JobTest {}' }
  assert.ok(inspectIntegration('./gradlew :app:test --tests JobTest', unmarked).warnings.every((line) => !line.includes('통합 테스트 표지')))
  const similar = { ...integrationFiles, 'app/src/test/java/example/JobTest.java': '@IntegrationTestSupport\nclass JobTest {}' }
  assert.ok(inspectIntegration('./gradlew :app:test --tests JobTest', similar).warnings.every((line) => !line.includes('통합 테스트 표지')))
  const noConfig = { ...integrationFiles, '.claude/plan-overlay.md': '' }
  assert.ok(inspectIntegration('./gradlew :app:test --tests JobTest', noConfig).warnings.every((line) => !line.includes('통합 테스트 표지')))
  const custom = {
    ...integrationFiles,
    '.claude/plan-overlay.md': '| 통합 테스트 표지 | `@Tag("database")` |\n',
    'app/src/test/java/example/JobTest.java': 'package example;\n@Tag("database")\nclass JobTest {}',
  }
  assert.ok(inspectIntegration('./gradlew :app:test --tests JobTest', custom).warnings.some((line) => line.includes('통합 테스트 표지')))
})

test('Gradle 필터 검사는 변경 목록 밖의 기존 테스트도 읽는다', () => {
  const r = inspect('### 1. 코드 수정', './gradlew :app:test --tests example.JobTest', [['src/app.java', '수정']], { files: integrationFiles, git: true })
  assert.ok(r.warnings.some((line) => line.includes('통합 테스트 표지')), r.stdout)
})
