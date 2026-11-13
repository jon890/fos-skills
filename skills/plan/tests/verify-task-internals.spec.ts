// verify_task 의 내부 함수 테스트. 명령 경계로 관측되지 않는 사례(분류 결과, 인자 목록, 경로 판정)를 함수로 직접 본다.
// 옛 test_verify_task.py 의 내부 함수 사례를 구현과 함께 옮겼다.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classify,
  codeBlocks,
  commandCwds,
  directoryArgs,
  fences,
  gitGrepPaths,
  isGlob,
  isTest,
  iterProse,
  literalSegment,
  matches,
  omitted,
  ownsCallName,
  pythonModuleNameProblem,
  runnableTest,
  section,
  shellCommands,
  slotInner,
  unwrap,
  vagueScope,
} from '../scripts/verify_task.ts'
import { Repo } from './helpers.ts'

const commandsOf = (text: string) => shellCommands(text).map((c) => c.command)
const bash = (body: string) => `\`\`\`bash\n${body}\n\`\`\``

test('iterProse 는 코드와 의도 메모와 머리말을 뺀다', () => {
  const text = '## 의도 메모\n직접 확인했다\n## 작업 항목\n직접 확인한다\n```bash\n육안\n```\n'
  assert.deepEqual(iterProse(text), [[4, '직접 확인한다']])
  assert.deepEqual(iterProse('머리말\n## 목표\n본문'), [[3, '본문']])
})

test('vagueScope 는 명사 수식어를 빼고 지시를 잡는다', () => {
  for (const line of ['프로젝트 전체 삭제 경로를 탔는지를 담는다', '전체 변경 이력을 남긴다']) assert.equal(vagueScope(line), false, line)
  for (const line of ['전체 삭제한다', '전체 삭제를 한다', '전체 삭제.', '모듈 전체 교체하여 반영한다']) assert.equal(vagueScope(line), true, line)
})

test('하이픈 테스트 이름과 모듈 이름 판정', () => {
  assert.equal(isTest('scripts/test-app.py'), true)
  assert.equal(runnableTest('tests/test-app.py'), true)
  assert.equal(pythonModuleNameProblem('tests/test-app.py'), true)
  assert.equal(pythonModuleNameProblem('tests/test_app.py'), false)
  assert.equal(pythonModuleNameProblem('tests/fixtures/data-set.json'), false)
  assert.equal(pythonModuleNameProblem('tests/*.py'), false)
})

test('픽스처 경로와 glob 은 실행 대상 테스트가 아니다', () => {
  for (const rel of ['skills/orch/tests/fixtures/**', 'tests/fixtures/*', './tests/fixtures/test_*.py', 'tests/fixture/test_*.py', 'tests/__fixtures__/test_sample.py', 'tests/__fixtures__/**', 'tests/fixtures/test_sample.py', 'tests/fixtures', 'tests/fixtures/']) {
    assert.equal(runnableTest(rel), false, rel)
  }
  for (const rel of ['tests/test_*.py', 'skills/orch/tests/*.spec.ts', 'tests/**', 'tests/test_sample.py', 'tests/', 'src/test/', 'src/fixture/tests/test_sample.py', 'src/__fixtures__/tests/test_sample.py', 'src/fixtures/tests/test_sample.py']) {
    assert.equal(runnableTest(rel), true, rel)
  }
})

test('하이픈으로 이은 spec 은 테스트 이름이 아니다', () => {
  for (const rel of ['frontend/src/bottom-panel-spec.js', 'src/hud-spec.ts', 'lib/panel-spec.rb']) assert.equal(isTest(rel), false, rel)
  for (const rel of ['src/a.spec.ts', 'e2e/analytics-charts.spec.ts', 'lib/a_spec.rb', 'src/a.test.js', 'src/bottom-panel-test.js', 'src/__tests__/x.js', 'tests/helper.js']) assert.equal(isTest(rel), true, rel)
})

test('spec 이름은 테스트 디렉터리나 코드 테스트 이름이 있어야 테스트다', () => {
  for (const rel of ['src/main/java/UserSpec.java', 'docs/specs/x.md', 'src/testing.py']) assert.equal(isTest(rel), false, rel)
  for (const rel of ['src/test/java/UserSpec.java', 'spec/user_spec.rb', 'tests/fixtures/data.json', 'web/app.spec.ts', 'pkg/app_test.go', 'src/AppTest.java', 'tests/test_*.py', 'tests']) assert.equal(isTest(rel), true, rel)
})

test('테스트 디렉터리의 보조 파일은 테스트이지만 실행 대상은 아니다', () => {
  for (const rel of ['test/e2e/fake-hermes.ts', 'test/browser/fixtures.ts', 'tests/conftest.py', 'tests/helpers.py', 'src/test/java/TestUtils.java', 'tests/fixtures/data.json']) {
    assert.equal(isTest(rel), true, rel)
    assert.equal(runnableTest(rel), false, rel)
  }
  for (const rel of ['src/test/java/UserSpec.java', 'src/test/java/AppIT.java', 'spec/user_spec.rb', 'web/app.spec.ts', 'pkg/app_test.go', 'src/AppTest.java', 'tests/test_*.py', 'tests']) assert.equal(runnableTest(rel), true, rel)
})

test('fences, section, codeBlocks 는 같은 길이 이상의 같은 문자로 닫는다', () => {
  const text = '## 작업 항목\n````bash\n```\n## 코드 안\n````\n## 검증\n끝'
  assert.ok(section(text, '작업 항목').includes('## 코드 안'))
  assert.deepEqual(iterProse(text).map(([n]) => n), [7])
  assert.deepEqual(codeBlocks(text).map((b) => b.body), ['```\n## 코드 안'])
  assert.deepEqual(fences('~~~python\nx\n~~~').map((f) => f.kind), ['open', 'code', 'close'])
  assert.ok(section('## 검증\n```bash\n## 설명\npytest\n```\n## 변경 파일\n끝', '검증').includes('pytest'))
})

test('shellCommands 는 대입, 체인, 여러 줄 명령, 줄 끝 주석을 읽는다', () => {
  const chained = commandsOf('```bash\nenv FLAG=1 pytest \\\n tests/test_app.py; echo "exit=$?"\ngrep x a && pytest\n```')
  assert.deepEqual(chained.map((c) => c[0]), ['pytest', 'echo', 'grep', 'pytest'])
  const comments = commandsOf('```bash\ngrep x src # 기존 설정\npytest # 전체 테스트\necho done\n```')
  assert.deepEqual(comments.map((c) => c[0]), ['grep', 'pytest', 'echo'])
  assert.deepEqual(shellCommands('```bash\na\n\nb && c\n```').map((c) => [c.line, c.command[0]]), [[2, 'a'], [4, 'b'], [4, 'c']])
  assert.deepEqual(commandsOf('```python\npytest\n```'), [])
  assert.deepEqual(commandsOf(bash("echo 'unclosed\npytest")), [['pytest']])
})

test('commandCwds 는 줄이 바뀌면 루트로 돌아가고 한 줄의 체인과 이어 붙인 줄은 이어 간다', () => {
  const reset = shellCommands('```bash\ncd frontend && pnpm test\n```\n\n```sh\ncd frontend && pnpm test -- src/__tests__/a\n```')
  assert.deepEqual(commandCwds(reset.map((c) => c.command), reset.map((c) => c.line)), ['frontend', 'frontend', 'frontend', 'frontend'])
  const chain = shellCommands('```bash\ncd frontend && cd src && pnpm test\ncd backend && \\\npytest tests\npnpm test\n```')
  assert.deepEqual(commandCwds(chain.map((c) => c.command), chain.map((c) => c.line)), ['frontend', 'frontend/src', 'frontend/src', 'backend', 'backend', ''])
  assert.deepEqual(commandCwds([['cd', '/abs'], ['cd'], ['cd', '..'], ['cd', 'a'], ['cd', '-P', 'b']]), ['', '', '', 'a', 'a/b'])
})

test('패키지 스크립트 이름은 디렉터리 인자가 아니다', () => {
  for (const command of [['pnpm', 'test'], ['npm', 'run', 'test'], ['npm', 'run-script', 'test'], ['yarn', 'test:ci'], ['pnpm', '--filter', 'tests', 'run', 'test'], ['yarn', 'workspace', 'tests', 'test']]) {
    assert.deepEqual(directoryArgs(command), [], command.join(' '))
  }
  for (const command of [['pnpm', 'test', '--', 'src/__tests__/a'], ['npm', 'run', 'test', '--', 'src/__tests__/a'], ['yarn', 'test:ci', 'src/__tests__/a']]) {
    assert.deepEqual(directoryArgs(command), ['src/__tests__/a'], command.join(' '))
  }
  for (const command of ['pnpm test -- --testNamePattern', 'npm run test -- --coverageDirectory', 'yarn test:ci -t']) {
    assert.deepEqual(directoryArgs([...command.split(' '), 'src/components/calendar']), [], command)
  }
  assert.deepEqual(directoryArgs(['pnpm', 'playwright', 'test', 'e2e/a.spec.ts']), ['e2e/a.spec.ts'])
  assert.deepEqual(directoryArgs(['bun', 'test', '-t', '이름', 'pkg/scripts']), ['pkg/scripts'])
  assert.deepEqual(directoryArgs(['node', '--test', 'a.test.ts', 'b.js']), ['a.test.ts'])
})

test('unwrap 은 실행기 접두어와 그 옵션을 벗긴다', () => {
  assert.deepEqual(unwrap(['npx', '-y', 'jest', '--ci']), ['jest', '--ci'])
  assert.deepEqual(unwrap(['uv', 'run', '--with', 'x', 'pytest', '-q']), ['pytest', '-q'])
  assert.deepEqual(unwrap(['/usr/bin/npx', 'vitest']), ['vitest'])
  assert.deepEqual(unwrap(['pnpm', 'exec', 'npx', 'jest']), ['jest'])
  assert.deepEqual(unwrap(['pnpm', 'test']), ['pnpm', 'test'])
  assert.deepEqual(unwrap(['uv']), ['uv'])
})

test('slotInner 는 orch slot 감싸기의 안쪽 명령을 낸다', () => {
  assert.deepEqual(slotInner(['orch', 'slot', 'heavy', '--', './gradlew', 'test']), ['./gradlew', 'test'])
  assert.deepEqual(slotInner(['orch', 'slot', 'heavy', '--exclusive', '--', 'npx', 'jest']), ['npx', 'jest'])
  assert.deepEqual(slotInner(['orch', 'slot', 'mem', '--', 'pytest']), ['pytest'])
  assert.deepEqual(slotInner(['heavy-slot', '--', 'pytest']), ['pytest'])
  assert.equal(slotInner(['orch', 'slot', 'heavy']), null)
  assert.equal(slotInner(['orch', 'slot', 'heavy', '--']), null)
  assert.equal(slotInner(['pytest']), null)
})

test('git grep 의 포함·제외 pathspec 을 읽는다', () => {
  assert.equal(gitGrepPaths(['git', 'grep', 'x']), null)
  assert.deepEqual(gitGrepPaths(['!', 'git', 'grep', 'x']), [['.'], []])
  assert.deepEqual(gitGrepPaths(['!', 'git', 'grep', '-n', 'x', '--', 'src', ':!src/a.test.ts']), [['src'], ['src/a.test.ts']])
  assert.deepEqual(gitGrepPaths(['!', 'git', '-C', 'src', 'grep', 'x', '--', '.']), [['src'], []])
  assert.deepEqual(gitGrepPaths(['!', 'git', 'grep', '-e', 'x', 'docs/']), [['docs'], []])
  assert.deepEqual(gitGrepPaths(['!', 'git', 'grep', 'x', 'HEAD', '--', 'docs']), [['docs'], []])
  assert.deepEqual(gitGrepPaths(['!', 'git', 'grep', 'x', '--', ':(exclude)a']), [['.'], ['a']])
})

test('glob 은 디렉터리 깊이를 지킨다', () => {
  assert.equal(matches('src/a.py', 'src/*.py'), true)
  assert.equal(matches('src/nested/a.py', 'src/*.py'), false)
  assert.equal(matches('src/nested/a.py', 'src/**/*.py'), true)
  assert.equal(matches('src/a.py', 'src/**/*.py'), true)
  assert.equal(matches('src/a.py', 'src/**'), true)
  assert.equal(matches('src', 'src/**'), true)
})

test('동적 라우트 조각과 glob, 생략 경로', () => {
  const route = 'web/src/app/api/x/[id]/files/[...path]/route.ts'
  for (const rel of [route, 'web/src/app/[[...slug]]/page.tsx']) {
    assert.equal(omitted(rel), false, rel)
    assert.equal(isGlob(rel), false, rel)
  }
  assert.equal(matches(route, 'web/src/app/api/x/[id]/files/*/route.ts'), true)
  assert.equal(matches('web/src/app/api/x/i/files/a/route.ts', 'web/src/app/api/x/[id]/files/*/route.ts'), false)
  assert.equal(isGlob('src/file[0-9].py'), true)
  assert.equal(omitted('src/.../[id]/route.ts'), true)
  assert.equal(omitted('src/…/a.ts'), true)
  assert.equal(literalSegment('[id]'), true)
  assert.equal(literalSegment('[0-9]'), true)
  assert.equal(literalSegment('a[id]'), false)
})

test('classify 는 실행기, 스크립트, 판정 불가를 가른다', () => {
  const repo = new Repo()
  repo.file('scripts/check-app.sh')
  repo.file('scripts/build.sh')
  repo.file('web/scripts/verify-web.sh')
  const kind = (line: string, cwd = '', entries: [string, string][] = []) => classify(commandsOf(bash(line))[0], entries, repo.root, cwd)
  assert.equal(kind('bash scripts/check-app.sh'), 'test')
  assert.equal(kind('bash scripts/build.sh'), 'other')
  assert.equal(kind('./scripts/check-app.sh'), 'test')
  assert.equal(kind('bash scripts/verify-web.sh', 'web'), 'test')
  assert.equal(kind('bash scripts/verify-gone.sh', 'web'), 'other')
  assert.equal(kind('bash scripts/verify-gone.sh', 'web', [['web/scripts/verify-gone.sh', '수정']]), 'test')
  assert.equal(kind('bash scripts/verify-gone.sh', 'web', [['web/scripts/verify-gone.sh', '삭제']]), 'other')
  assert.equal(kind('bash scripts/check-new.sh', '', [['scripts/check-new.sh', '신규']]), 'test')
  assert.equal(kind('just test'), 'unknown')
  assert.equal(kind('bash -c "pytest"'), 'other')
  assert.equal(kind('python3 --version'), 'other')
  assert.equal(kind('./gradlew test -m'), 'other')
  assert.equal(kind('./gradlew build --exclude-task=test'), 'other')
  assert.equal(kind('./gradlew :api:build -x :api:check'), 'other')
  assert.equal(kind('mvn test -Dmaven.test.skip=true'), 'other')
  assert.equal(kind('mvn test -DskipTests=false'), 'test')
  assert.equal(kind('pytest --collect-only'), 'other')
  assert.equal(kind('npm test --help'), 'other')
  assert.equal(kind('claude plugin test .'), 'test')
  assert.equal(kind('claude plugin list'), 'other')
  assert.equal(kind('yarn workspace web test'), 'test')
})

const OWNERS: [string, string, boolean][] = [
  ['export declare function triage(): void;', 'triage', true],
  ['declare function triage(): void;', 'triage', false],
  ['export abstract class Repo { abstract triage(): void; }', 'triage', true],
  ["const a = <p>It's</p>;\nexport function triage() {}\nconst b = <p>won't</p>;", 'triage', true],
  ['function triage() {}\nmodule.exports = { triage };', 'triage', true],
  ['exports.triage = () => {};', 'triage', true],
  ['module.exports = { method() { function triage() {} } };', 'triage', false],
  ['// exports.triage = () => {};', 'triage', false],
  ['const text = "module.exports = { triage }";', 'triage', false],
  ['export class Repo { private triage() {} }', 'triage', false],
  ['class Repo { triage() {} }\nexport { Repo as PublicRepo };', 'triage', true],
  ['export const repo = { triage: () => {} };', 'triage', true],
  ['export default class { triage() {} }', 'triage', true],
  ['const repo = { triage() {} };\nexport default repo;', 'triage', true],
  ['export { triage as publicName };', 'triage', false],
  ['export { localName as triage } from "./other";', 'triage', true],
  ['const triage = () => {};\nexport default triage;', 'triage', true],
  ['export const 한글이름 = () => 1;', '한글이름', false],
  ['export class Repo {\r\n  other() {}\r\n  triage() {}\r\n}', 'triage', true],
]

test('ownsCallName 은 TS·JS 확장자마다 공개한 이름만 주인으로 본다', () => {
  const repo = new Repo()
  for (const suffix of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
    for (const [source, name, exported] of OWNERS) {
      const file = repo.file(`src/repo.${suffix}`, source)
      assert.equal(ownsCallName(file, name), exported, `${suffix}\n${source}`)
    }
  }
})

test('ownsCallName 은 다른 언어를 낱말 대조로 본다', () => {
  const repo = new Repo()
  const py = repo.file('src/repo.py', 'def save(user):\n    pass\n')
  assert.equal(ownsCallName(py, 'save'), true)
  assert.equal(ownsCallName(py, 'sav'), false)
  assert.equal(ownsCallName(py, 'user'), true)
  assert.equal(ownsCallName(repo.file('src/한글.py', 'def 저장_save(): pass\n'), 'save'), false)
})
