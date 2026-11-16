// 오버레이가 지정한 생성 파일, 계약 검증 명령, 통합 테스트 표지의 명령 경계 회귀 테스트.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { baseEnv, inspect, Repo, VERIFY, verify, write, writePlan } from './helpers.ts'

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
const inspectContract = (command: string, files: Record<string, string> = contractFiles, rel = 'contracts/api.yaml') => inspect('### 1. 계약 수정', command, [[rel, '수정']], { files })

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

test('계약 규칙 JSON 문법이 깨지면 실행 오류로 끝난다', () => {
  const r = inspectContract('pytest', { ...contractFiles, '.claude/contract-checks.json': '[{"files":' })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.startsWith('검사를 실행하지 못했다:'), r.stderr)
  assert.equal(r.stdout, '')
})

test('계약 규칙 설정 파일이 없으면 실행 오류로 끝난다', () => {
  const r = inspectContract('pytest', { '.claude/plan-overlay.md': contractFiles['.claude/plan-overlay.md'] })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.startsWith('검사를 실행하지 못했다:'), r.stderr)
  assert.ok(r.stderr.includes('contract-checks.json'), r.stderr)
  assert.equal(r.stdout, '')
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

test('통합 테스트 표지가 없으면 파일 목록을 조회하지 않고 하위 프로젝트에만 있어도 검사한다', () => {
  const repo = new Repo('plan-integration-skip-', true)
  repo.file('docs/flow.md', '# 흐름')
  repo.file('app/src/test/JobTest.java', '@IntegrationTest\nclass JobTest {}')
  writePlan(repo, 'plan1-x', [{ command: './gradlew :app:test --tests JobTest', entries: [['app/src/test/JobTest.java', '수정']] }])
  const counter = `${repo.root}/listed.txt`
  write(`${repo.root}/bin/git`, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('ls-files')) appendFileSync(${JSON.stringify(counter)}, 'listed\\n');
const result = spawnSync('git', process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, PATH: process.env.PLAN_REAL_PATH } });
process.exit(result.status ?? 1);
`, 0o755)
  const run = () => repo.run(VERIFY, ['plan1-x', '--audit'], { env: baseEnv({ PATH: `${repo.root}/bin:${process.env.PATH}`, PLAN_REAL_PATH: process.env.PATH ?? '' }) })
  const skipped = run()
  assert.equal(skipped.code, 0, skipped.stdout + skipped.stderr)
  assert.equal(existsSync(counter), false)
  repo.file('app/.claude/plan-overlay.md', '| 통합 테스트 표지 | `@IntegrationTest` |\n')
  const enabled = run()
  assert.equal(enabled.code, 0, enabled.stdout + enabled.stderr)
  assert.ok(enabled.stdout.includes('통합 테스트 표지'), enabled.stdout)
  assert.equal(readFileSync(counter, 'utf8'), 'listed\n')
})

// 느린 e2e 도 같은 phase 에 작성하되 실행 명령 대조만 마지막 phase 까지 미룬다.
for (const [label, rel, files] of [
  ['오버레이 없음', 'web/e2e/login.spec.ts', {}],
  ['기본 파일 이름', 'tests/test_login.e2e.ts', {}],
  ['기본 playwright 폴더', 'web/playwright/login.spec.ts', {}],
  ['루트 설정', 'tests/service_test.py', { '.claude/plan-overlay.md': '| 느린 e2e | `tests/service_test.py` |' }],
  ['하위 설정', 'web/browser/login.spec.ts', {
    '.claude/plan-overlay.md': '| 느린 e2e | `tests/service_test.py` |',
    'web/.claude/plan-overlay.md': '| 느린 e2e | `web/browser/**/*.spec.ts` |',
  }],
] as [string, string, Record<string, string>][]) {
  test(`느린 e2e 실행 대조는 중간 phase 에서 제외하고 마지막 phase 에서는 유지한다: ${label}`, () => {
    const repo = new Repo()
    repo.file('docs/flow.md')
    for (const [name, body] of Object.entries(files)) repo.file(name, body)
    const phase = {
      work: `### 1. 테스트 수정\n\`${rel}\` 와 \`tests/test_fast.py\` 를 고친다.`,
      entries: [[rel, '수정'], ['tests/test_fast.py', '수정']] as [string, string][],
      command: 'pytest tests/test_fast.py',
    }
    const dir = writePlan(repo, 'plan1-x', [phase, phase])
    const result = verify(repo, ['plan1-x', '--audit'])
    assert.deepEqual(result.violations, [
      `${repo.root}/${dir}/phase-02.md — 검증 명령이 작업 항목의 테스트를 실행하지 않는다: ${rel}`,
    ], result.stdout + result.stderr)
    // 느린 테스트를 제외해도 같은 중간 phase 의 일반 테스트 누락은 막는다.
    writePlan(repo, 'plan1-x', [{ ...phase, command: 'pytest tests/test_other.py' }, phase])
    assert.ok(verify(repo, ['plan1-x', '--audit']).violations.some((line) => line.includes('phase-01.md') && line.endsWith('tests/test_fast.py')))
  })
}

test('느린 e2e 설정은 기본값을 대체하며 다른 하위 프로젝트에는 퍼지지 않는다', () => {
  const repo = new Repo()
  repo.file('docs/flow.md')
  repo.file('web/.claude/plan-overlay.md', '| 느린 e2e | `web/browser/**/*.spec.ts` |')
  const rels = ['web/e2e/login.spec.ts', 'api/browser/login.spec.ts', 'web/browser/login.spec.ts']
  const phase = {
    work: `### 1. 테스트 수정\n${rels.map((rel) => `\`${rel}\``).join(' ')} 를 고친다.`,
    entries: rels.map((rel) => [rel, '수정'] as [string, string]),
    command: 'pytest tests/test_fast.py',
  }
  writePlan(repo, 'plan1-x', [phase, { command: 'pytest tests/test_fast.py', entries: [['docs/flow.md', '수정']] }])
  const result = verify(repo, ['plan1-x', '--audit'])
  assert.equal(result.violations.length, 2, result.stdout + result.stderr)
  for (const rel of rels.slice(0, 2)) assert.ok(result.violations.some((line) => line.endsWith(rel)), result.stdout)
})
