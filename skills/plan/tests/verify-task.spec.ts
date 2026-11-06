// verify_task 의 명령 경계 테스트 1: phase 본문의 검증 명령, 테스트 작업, 사람 의존·모호한 지시 규칙.
// 옛 test_verify_task 의 내부 함수 사례를 임시 저장소의 계획 폴더에 --audit 로 돌려 stdout 의 위반·경고 줄로 본다.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Entry, inspect, kind } from './helpers.ts'

const has = (lines: string[], needle: string) => lines.some((line) => line.includes(needle))
const NOT_RUN = '테스트를 실행하지 않는다'
const NO_TEST = '코드 변경을 검증할 테스트'

test('산문 검사는 코드 블록과 의도 메모를 보지 않는다', () => {
  const work = '### 1. 작업\n직접 확인한다\n```bash\n육안\n```'
  const r = inspect(work, 'pytest', [['src/a.py', '수정']], { extra: '\n## 의도 메모\n직접 확인했다\n' })
  const human = r.violations.filter((line) => line.includes('사람 의존 검증'))
  assert.equal(human.length, 1, r.violations.join('\n'))
  assert.ok(human[0].includes('phase-01.md:') && human[0].endsWith('사람 의존 검증: 직접 확인한다'))
})

test('모호한 범위 지시는 명사 수식어를 빼고 진짜 지시만 잡는다', () => {
  for (const line of ['프로젝트 전체 삭제 경로를 탔는지를 담는다', '전체 변경 이력을 남긴다']) {
    assert.ok(!has(inspect(`### 1. 작업\n${line}`, 'pytest', []).violations, '모호한 범위 지시'), line)
  }
  for (const line of ['전체 삭제한다', '전체 삭제를 한다', '전체 삭제.', '모듈 전체 교체하여 반영한다']) {
    assert.ok(has(inspect(`### 1. 작업\n${line}`, 'pytest', []).violations, `모호한 범위 지시: ${line}`), line)
  }
})

test('없는 근거 문서를 알린다', () => {
  const r = inspect('### 1. 작업', 'pytest', [], { evidence: '`docs/absent.md`' })
  assert.ok(has(r.violations, '근거 문서가 없는 경로를 가리킨다: docs/absent.md'), r.violations.join('\n'))
})

test('여러 줄로 적은 근거 문서를 모두 확인한다', () => {
  const r = inspect('### 1. 문서', 'pytest', [], { evidence: '`docs/flow.md`,\n`docs/missing.md`' })
  assert.ok(has(r.violations, 'docs/missing.md'))
})

test('모노레포 하위 docs 경로도 근거 문서다', () => {
  const ok = inspect('### 1. 문서', 'pytest', [], { evidence: '`frontend/docs/flow.md`', files: { 'frontend/docs/flow.md': '' } })
  assert.ok(!has(ok.violations, '근거 문서'), ok.violations.join('\n'))
  for (const evidence of ['`frontend/docs/absent.md`', '`frontend/src/app.ts`']) {
    assert.ok(has(inspect('### 1. 문서', 'pytest', [], { evidence }).violations, '근거 문서'), evidence)
  }
})

test('번들 명령은 cwd 주석이 있어야 한다', () => {
  const block = (body: string) => `### 1. 작업\n\`\`\`bash\n${body}\n\`\`\``
  for (const command of ['python3 "$SKILL_DIR/scripts/verify.py"', 'bash "${SKILL_DIR}/scripts/verify.sh"', 'python3 ~/.claude/skills/plan/scripts/a.py', 'python3 ~/.codex/skills/plan/scripts/a.py']) {
    assert.ok(has(inspect(block(command), 'pytest', []).violations, 'cwd 주석 누락'), command)
    assert.ok(!has(inspect(block(`# cwd: root\n${command}`), 'pytest', []).violations, 'cwd 주석 누락'), command)
  }
  assert.ok(!has(inspect(block('pytest'), 'pytest', []).violations, 'cwd 주석 누락'))
})

test('cd 가 붙은 스크립트는 하위 프로젝트의 변경 파일과 맞는다', () => {
  // `cd <dir> && bash scripts/x.sh` 의 인자가 변경 파일 경로와 달라 위반으로 막혔던 재현이다
  const entries: Entry[] = [['financial-workbench/scripts/check-compose.sh', '신규']]
  const work = '### 1. `financial-workbench/scripts/check-compose.sh` 추가\n실행: `scripts/check-compose.sh`'
  const joined = inspect(work, 'cd financial-workbench && bash scripts/check-compose.sh', entries)
  assert.ok(!has(joined.violations, '검증할 테스트 파일'), joined.violations.join('\n'))
  // 다른 줄의 cd 는 반영하지 않는다
  assert.ok(has(inspect(work, 'cd financial-workbench\nbash scripts/check-compose.sh', entries).violations, '검증할 테스트 파일'))
})

test('마지막 작업 항목은 인수 평가여도 된다', () => {
  const entries: Entry[] = [['src/app.py', '신규'], ['tests/test_app.py', '신규']]
  const work = '### 1. `src/app.py`\n### 2. `tests/test_app.py`\n정상과 실패 응답을 단언한다.\n### 3. 41종 평가 실행과 기록'
  assert.deepEqual(inspect(work, 'pytest tests/test_app.py', entries).violations, [])
})

test('모듈 이름이 될 수 없는 하이픈 Python 테스트는 건너뛰는 실행기에서 위반이다', () => {
  for (const [rel, command] of [
    ['tests/test-app.py', 'python3 -m unittest discover -s tests'],
    ['tests/test-app.py', 'pytest tests'],
    ['scripts/test-app.py', 'python3 -m unittest scripts.test-app'],
  ]) {
    const entries: Entry[] = [['src/app.py', '신규'], [rel, '신규']]
    const r = inspect(`### 1. \`src/app.py\`\n### 2. \`${rel}\`\n정상과 실패 응답을 단언한다.`, command, entries)
    assert.ok(r.violations.some((line) => line.includes('모듈 이름이 될 수 없어') && line.includes('test_app.py')), `${command}\n${r.violations.join('\n')}`)
  }
})

test('하이픈 Python 테스트를 경로로 직접 실행하면 통과한다', () => {
  for (const command of ['python3 tests/test-app.py', 'pytest tests/test-app.py', 'python3 -m pytest ./tests/test-app.py::test_ok']) {
    const entries: Entry[] = [['src/app.py', '신규'], ['tests/test-app.py', '신규']]
    const r = inspect('### 1. `src/app.py`\n### 2. `tests/test-app.py`\n정상과 실패 응답을 단언한다.', command, entries)
    assert.ok(!has(r.violations, '모듈 이름'), command)
  }
})

test('픽스처 glob 은 별도 테스트 명령이 필요 없다', () => {
  const entries: Entry[] = [['src/app.ts', '수정'], ['tests/fixtures/**', '수정'], ['tests/app.test.ts', '신규']]
  const r = inspect('### 1. `tests/fixtures/**`\n### 2. `tests/app.test.ts`', 'node --test tests/app.test.ts', entries)
  assert.deepEqual(r.violations, [])
})

test('하이픈으로 이은 spec 이름은 테스트가 아니라서 테스트 요구를 채우지 못한다', () => {
  const entries: Entry[] = [['src/panel.js', '수정'], ['src/bottom-panel-spec.js', '신규']]
  const r = inspect('### 1. `src/panel.js` 를 고친다\n### 2. `src/bottom-panel-spec.js` 를 만든다', 'pnpm test', entries)
  assert.ok(has(r.violations, NO_TEST), r.violations.join('\n'))
})

test('테스트가 없다는 위반은 코드로 센 변경 파일 이름을 보인다', () => {
  const r = inspect('### 1. `src/app.py` 변경', 'pytest', [['src/app.py', '수정'], ['src/*.py', '수정']])
  const message = r.violations.find((line) => line.includes(NO_TEST))!
  assert.ok(message.includes('src/app.py') && message.includes('src/*.py'), message)
})

test('작업 항목 제목을 바꿔도 lint 는 테스트가 되지 않는다', () => {
  for (const title of ['확인', '테스트']) {
    assert.ok(inspect(`### 1. 검증하는 ${title}`, 'ruff check src', [['src/app.py', '수정']]).violations.length > 0, title)
  }
})

test('명령 없는 검증 절의 사람 의존 지시는 위반이다', () => {
  for (const prose of ['담당자가 확인한다.', '화면을 확인한다.', '사람이 판정한다.']) {
    const r = inspect('### 1. 작업', 'pytest', [], { text: (t) => t.replace('```bash\npytest\n```', prose) })
    assert.ok(has(r.violations, `명령 없는 사람 의존 검증: ${prose}`), `${prose}\n${r.violations.join('\n')}`)
  }
})

test('명령이 있는 검증 절의 사람 설명은 추가 위반이 아니다', () => {
  const r = inspect('### 1. 작업', 'pytest', [], { text: (t) => t.replace('```bash\npytest\n```', '```bash\npytest\n```\n사용자가 확인하는 화면의 응답을 단언한다.') })
  assert.ok(!has(r.violations, '명령 없는 사람 의존 검증'), r.violations.join('\n'))
})

test('컨텍스트와 의도 메모의 사람 표현은 추가 위반이 아니다', () => {
  const r = inspect('### 1. 작업', 'pytest', [], {
    text: () => '## 목표\n앱\n**범위 외**: 배포\n## 컨텍스트\n**근거 문서**: `docs/flow.md`\n\n사용자가 확인한다.\n## 의도 메모\n담당자가 확인했다.\n## 작업 항목\n### 1. 작업\n## 검증\n자동화한다.\n## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n',
  })
  assert.ok(!has(r.violations, '사람 의존'), r.violations.join('\n'))
})

test('같은 phase 에 테스트 작업이 없는 코드 변경은 위반이다', () => {
  assert.ok(has(inspect('### 1. `src/app.py` 변경', 'pytest', [['src/app.py', '수정']]).violations, NO_TEST))
})

test('변경 파일 표에만 적은 테스트는 작업 항목이 아니라 위반이다', () => {
  const r = inspect('### 1. `src/app.py` 변경', 'pytest', [['src/app.py', '수정'], ['tests/test_app.py', '수정']])
  assert.ok(has(r.violations, NO_TEST))
})

test('확장자 없는 자바 클래스 이름도 테스트 작업으로 받는다', () => {
  const r = inspect('### 1. `AppTest` 에 실패 입력 추가', './gradlew :api:test', [['src/App.java', '수정'], ['src/test/java/AppTest.java', '수정']])
  assert.deepEqual(r.violations, [])
})

test('테스트 선언 앞의 코드 블록은 무시한다', () => {
  const work = '### 1. `App.java`\n```java\nclass App {}\n```\n### 2. `AppTest.java` 추가'
  assert.deepEqual(inspect(work, './gradlew test', [['src/App.java', '신규'], ['src/test/java/AppTest.java', '신규']]).violations, [])
})

test('코드 안에만 적은 테스트 참조는 작업 항목이 아니다', () => {
  const work = '### 1. `src/app.py`\n```python\n# `tests/test_app.py`\n```'
  assert.ok(has(inspect(work, 'pytest', [['src/app.py', '신규'], ['tests/test_app.py', '신규']]).violations, NO_TEST))
})

test('지정한 명령이 선언한 테스트를 실행하지 않으면 위반이다', () => {
  const r = inspect('### 1. `tests/test_app.py` 추가', 'pytest tests/test_other.py', [['src/app.py', '수정'], ['tests/test_app.py', '신규']])
  assert.ok(has(r.violations, NOT_RUN), r.violations.join('\n'))
})

test('테스트 glob 인자는 선언한 파일을 실행한다', () => {
  const r = inspect('### 1. `tests/test_app.py` 추가', 'pytest tests/test_*.py', [['src/app.py', '수정'], ['tests/test_app.py', '신규']])
  assert.deepEqual(r.violations, [])
})

test('디렉터리 인자는 그 아래 테스트를 실행한다', () => {
  const work = '### 1. `frontend/src/__tests__/components/calendar/X.test.tsx` 추가'
  const entries: Entry[] = [['frontend/src/a.tsx', '수정'], ['frontend/src/__tests__/components/calendar/X.test.tsx', '신규']]
  for (const command of [
    'cd frontend && pnpm test -- src/__tests__/components/calendar',
    'cd frontend && pnpm test -- src/__tests__/components/calendar/ src/__tests__/services/calendar',
    'cd frontend && npx vitest run ./src/__tests__/components/calendar',
    'cd frontend && npx jest src/__tests__/components',
    'pnpm test -- frontend/src/__tests__/components/calendar',
  ]) {
    assert.deepEqual(inspect(work, command, entries).violations, [], command)
  }
  const python: Entry[] = [['src/a.py', '수정'], ['tests/unit/test_a.py', '신규']]
  assert.deepEqual(inspect('### 1. `tests/unit/test_a.py` 추가', 'pytest tests/unit', python).violations, [])
  assert.deepEqual(inspect('### 1. `tests/unit/test_a.py` 추가', 'pytest tests', python).violations, [])
})

test('다른 곳의 디렉터리 인자는 위반이다', () => {
  const work = '### 1. `frontend/src/__tests__/components/calendar/X.test.tsx` 추가'
  const entries: Entry[] = [['frontend/src/a.tsx', '수정'], ['frontend/src/__tests__/components/calendar/X.test.tsx', '신규']]
  for (const command of [
    'cd frontend && pnpm test -- src/__tests__/services/calendar',
    'cd frontend && pnpm test -- src/__tests__/components/calendar2',
    'pnpm test -- src/__tests__/components/calendar',
    'cd web && pnpm test -- src/__tests__/components/calendar',
  ]) {
    assert.ok(inspect(work, command, entries).violations.length > 0, command)
  }
})

test('패키지 관리자가 부르는 실행기 bin 의 파일 인자도 지정한 테스트로 센다', () => {
  // `pnpm jest <파일>` 의 파일이 지정한 테스트로 빠져 계획서가 위반으로 막혔던 재현이다
  const entries: Entry[] = [
    ['frontend/src/a.ts', '수정'],
    ['frontend/src/__tests__/services/analytics/analytics-service.test.ts', '신규'],
    ['frontend/src/__tests__/app/analytics/page.test.tsx', '신규'],
    ['frontend/e2e/analytics-charts.spec.ts', '신규'],
  ]
  const work =
    '### 1. `frontend/src/__tests__/services/analytics/analytics-service.test.ts`\n### 2. `frontend/src/__tests__/app/analytics/page.test.tsx`\n### 3. `frontend/e2e/analytics-charts.spec.ts`'
  const tail = 'cd frontend && pnpm tsc --noEmit && pnpm lint && pnpm test\ncd frontend && pnpm test:browser analytics-charts.spec.ts'
  const files = 'src/__tests__/services/analytics/analytics-service.test.ts src/__tests__/app/analytics/page.test.tsx'
  for (const runner of ['pnpm jest', 'pnpm vitest', 'npm exec jest', 'yarn jest', 'pnpm exec jest']) {
    assert.deepEqual(inspect(work, `cd frontend && ${runner} ${files}\n${tail}`, entries).violations, [], runner)
  }
  assert.ok(inspect(work, `cd frontend && pnpm jest src/__tests__/other.test.ts\n${tail}`, entries).violations.length > 0)
})

test('playwright test 는 선언한 e2e 테스트를 실행한 것으로 센다', () => {
  const entries: Entry[] = [['web/src/a.ts', '수정'], ['web/e2e/a.spec.ts', '신규']]
  const work = '### 1. `web/e2e/a.spec.ts` 추가'
  for (const command of ['cd web && npx playwright test e2e/a.spec.ts', 'cd web && pnpm exec playwright test e2e/a.spec.ts', 'cd web && pnpm playwright test e2e/a.spec.ts', 'cd web && playwright test e2e/a.spec.ts']) {
    assert.deepEqual(inspect(work, command, entries).violations, [], command)
  }
  for (const command of ['cd web && npx tsc --noEmit', 'cd web && npx playwright install', 'cd web && npx playwright test e2e/other.spec.ts']) {
    assert.ok(inspect(work, command, entries).violations.length > 0, command)
  }
})

test('패키지 스크립트 본문이 이름이 test 가 아닐 때 판정한다', () => {
  const pkg = JSON.stringify({
    scripts: {
      e2e: 'playwright test',
      unit: 'vitest run',
      lint: 'eslint .',
      ci: 'eslint . && vitest run',
      all: 'npm run e2e',
      l1: 'npm run l2',
      l2: 'npm run l3',
      l3: 'npm run l4',
      l4: 'vitest run',
      loop: 'npm run loop',
    },
  })
  const files = { 'package.json': pkg }
  for (const line of ['npm run e2e', 'pnpm e2e', 'pnpm run e2e', 'yarn e2e', 'yarn run e2e', 'bun run e2e', 'npm run unit', 'npm run ci', 'npm run all']) {
    assert.equal(kind(line, files), 'test', line)
  }
  for (const line of ['npm run lint', 'npm run missing', 'npm run l1', 'npm run loop', 'npm install', 'bun e2e']) {
    assert.equal(kind(line, files), 'other', line)
  }
})

test('패키지 스크립트는 cd 한 폴더의 package.json 에서 읽는다', () => {
  const files = { 'web/package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }) }
  assert.equal(kind('cd web && npm run e2e', files), 'test')
  assert.equal(kind('npm run e2e', files), 'other')
  const entries: Entry[] = [['web/e2e/a.spec.ts', '신규']]
  assert.deepEqual(inspect('### 1. `web/e2e/a.spec.ts` 추가', 'cd web && npm run e2e', entries, { files }).violations, [])
})

test('인자 없는 패키지 테스트 스크립트는 전체 실행이다', () => {
  const entries: Entry[] = [['frontend/src/__tests__/a/X.test.tsx', '신규']]
  for (const command of ['pnpm test', 'npm run test', 'npm run-script test', 'yarn test:ci']) {
    assert.deepEqual(inspect('### 1. `frontend/src/__tests__/a/X.test.tsx` 추가', `cd frontend && ${command}`, entries).violations, [], command)
  }
})

test('패키지 테스트의 디렉터리 인자는 테스트 이름이 없어도 된다', () => {
  const entries: Entry[] = [['frontend/src/components/calendar/X.test.tsx', '신규']]
  const work = '### 1. `frontend/src/components/calendar/X.test.tsx` 추가'
  for (const command of ['pnpm test --', 'npm run test --', 'yarn test:ci']) {
    assert.deepEqual(inspect(work, `cd frontend && ${command} src/components/calendar`, entries).violations, [], command)
    assert.ok(has(inspect(work, `cd frontend && ${command} src/components/elsewhere`, entries).violations, NOT_RUN), command)
  }
})

test('패키지 테스트의 옵션 값은 디렉터리 인자가 아니다', () => {
  const entries: Entry[] = [['frontend/src/components/calendar/X.test.tsx', '신규']]
  const work = '### 1. `frontend/src/components/calendar/X.test.tsx` 추가'
  for (const command of ['pnpm test -- --testNamePattern', 'npm run test -- --coverageDirectory', 'yarn test:ci -t']) {
    const valid = `cd frontend && ${command} src/components/calendar src/components/calendar`
    const invalid = `cd frontend && ${command} src/components/calendar src/components/elsewhere`
    assert.deepEqual(inspect(work, valid, entries).violations, [], command)
    assert.ok(has(inspect(work, invalid, entries).violations, NOT_RUN), command)
  }
})

test('전체 실행과 디렉터리 실행이 줄이나 블록으로 나뉘어도 각자 읽는다', () => {
  const entries: Entry[] = [['frontend/src/__tests__/a/X.test.tsx', '신규']]
  const work = '### 1. `frontend/src/__tests__/a/X.test.tsx` 추가'
  for (const separator of ['\n', '\n```\n\n```bash\n']) {
    const command = `cd frontend && pnpm test${separator}cd frontend && pnpm test -- src/__tests__/a`
    assert.deepEqual(inspect(work, command, entries).violations, [], JSON.stringify(separator))
    const wrong = command.replace('-- src/__tests__/a', '-- src/__tests__/elsewhere')
    assert.ok(has(inspect(work, wrong, entries).violations, NOT_RUN), JSON.stringify(separator))
  }
})

test('따로 선 cd 는 다음 줄에 영향을 주지 않는다', () => {
  const entries: Entry[] = [['frontend/src/__tests__/a/X.test.tsx', '신규']]
  assert.ok(inspect('### 1. `frontend/src/__tests__/a/X.test.tsx` 추가', 'cd frontend\npnpm test -- src/__tests__/a', entries).violations.length > 0)
})

test('bun test 의 디렉터리 인자는 그 아래 테스트를 실행한다', () => {
  // `bun test pkg/scripts/profile` 이 디렉터리 인자로 읽히지 않아 테스트를 실행하지 않는다고 판정된 재현이다
  const work = '### 1. `pkg/scripts/profile/a.test.ts` 추가'
  const entries: Entry[] = [['pkg/scripts/profile/a.ts', '수정'], ['pkg/scripts/profile/a.test.ts', '신규']]
  for (const command of ['bun test pkg/scripts/profile', 'bun test ./pkg/scripts/profile/', 'cd pkg && bun test scripts/profile', 'bun test -t 이름 pkg/scripts']) {
    assert.deepEqual(inspect(work, command, entries).violations, [], command)
  }
  for (const command of ['bun test pkg/scripts/other', 'bun test scripts/profile', 'bun run lint pkg/scripts/profile']) {
    assert.ok(inspect(work, command, entries).violations.length > 0, command)
  }
})

test('같은 phase 의 회귀 스크립트는 실행할 수 있다', () => {
  assert.deepEqual(inspect('### 1. `scripts/check-app.sh` 에 실패 응답 검증 추가', 'bash scripts/check-app.sh', [['scripts/check-app.sh', '신규']]).violations, [])
})

test('테스트를 다른 phase 로 미루는 지시를 잡고 다음 케이스 같은 말은 잡지 않는다', () => {
  const entries: Entry[] = [['tests/test_app.py', '수정']]
  const work = '### 1. `tests/test_app.py`\n'
  for (const prose of ['테스트는 다음 케이스를 추가한다.', '테스트 픽스처는 다음 형식으로 작성한다.', '회귀 테스트를 후속 plan 으로 넘기지 않는다.']) {
    assert.deepEqual(inspect(work + prose, 'pytest', entries).violations, [], prose)
  }
  for (const prose of ['테스트는 다음 phase 에서 작성한다. 지금은 필요하지 않다.', '회귀 테스트는 후속 plan 으로 넘긴다.', '테스트는 나중에 추가한다.']) {
    assert.ok(has(inspect(work + prose, 'pytest', entries).violations, '테스트를 다른 phase 로 미루는 지시'), prose)
  }
})

test('다음 phase 로 테스트를 미루는 지시는 위반이고 미루지 않는다는 말은 아니다', () => {
  const entries: Entry[] = [['tests/test_app.py', '수정']]
  assert.ok(inspect('### 1. `tests/test_app.py`\n회귀 테스트는 다음 phase 에 작성한다.', 'pytest', entries).violations.length > 0)
  assert.deepEqual(inspect('### 1. `tests/test_app.py`\n테스트를 다음 phase 로 미루지 않는다.', 'pytest', entries).violations, [])
})

test('주석만 있는 블록에는 명령이 없다', () => {
  const r = inspect('### 1. 문서', '# pytest 를 실행한다', [['docs/a.md', '수정']])
  assert.ok(has(r.violations, '검증 절에 실행할 명령이 없다'), r.violations.join('\n'))
})

test('echo 와 grep 에 적힌 실행기 이름과 건너뛰는 옵션은 실행이 아니다', () => {
  for (const command of ['echo pytest', 'grep pytest README.md', 'shellcheck scripts/check.sh', './gradlew build -x test', 'mvn verify -DskipTests']) {
    assert.equal(kind(command), 'other', command)
  }
})

test('저장소의 테스트 명령', () => {
  for (const command of ['pytest', 'python3 -m unittest discover', 'npm test', 'pnpm run test', 'npm run test:unit', 'yarn test', './gradlew :api:build', './gradlew test -x lint', 'mvn verify -DskipTests=false', 'go test ./...', 'cargo test', 'dotnet test']) {
    assert.equal(kind(command), 'test', command)
  }
})

test('감싼 실행기와 워크스페이스 명령', () => {
  for (const command of ['make test', 'make -C api check', 'tox', 'tox -e py312', 'jest', 'npx vitest run', 'npx jest --ci', 'bundle exec rspec', 'uv run pytest', 'uv run --with x pytest -q', 'poetry run pytest', 'pipenv run python -m pytest', 'pnpm --filter web test', 'pnpm -r test', 'npm --prefix web test', 'npm -w web run test', 'yarn workspace web test', '(cd web && npm test)']) {
    assert.equal(kind(command), 'test', command)
  }
  for (const command of ['make lint', 'npx eslint .', 'uv run ruff check', 'pnpm --filter web lint', '(cd web && npm run build)']) {
    assert.notEqual(kind(command), 'test', command)
  }
})

test('node 테스트 실행기와 deno, bun 의 test', () => {
  for (const command of ['node --test', 'node --test test/unit/a.test.ts', 'node --import tsx --test test/*.test.ts', 'node --experimental-strip-types --test', 'deno test', 'bun test']) {
    assert.equal(kind(command), 'test', command)
  }
  // --test 가 없거나 스크립트 뒤에 있으면 판정하지 못한 명령으로 둔다
  for (const [command, expected] of [['node scripts/build.ts', 'unknown'], ['node build.ts --test', 'unknown'], ['deno run main.ts', 'other']] as const) {
    assert.equal(kind(command), expected, command)
  }
})

test('node --test 의 파일도 다른 실행기 옆에서 지정한 테스트로 센다', () => {
  // node --test 파일이 지정한 테스트에서 빠져 pnpm 의 파일 인자만으로 대조하던 계획서의 재현이다
  const entries: Entry[] = [['web/src/a.ts', '수정'], ['web/test/unit/a.test.ts', '신규'], ['web/tests/e2e/b.spec.ts', '신규']]
  const work = '### 1. `web/test/unit/a.test.ts`\n### 2. `web/tests/e2e/b.spec.ts`'
  assert.deepEqual(inspect(work, 'node --test test/unit/a.test.ts\npnpm test:browser b.spec.ts', entries).violations, [])
  assert.ok(inspect(work, 'node --test test/unit/other.test.ts\npnpm test:browser b.spec.ts', entries).violations.length > 0)
})

test('판정하지 못한 실행기는 경고이고 lint 만 있으면 위반이다', () => {
  const unknown = inspect('### 1. `tests/test_app.py`', 'just test', [['tests/test_app.py', '수정']])
  assert.ok(!has(unknown.violations, '테스트 실행'), unknown.violations.join('\n'))
  assert.ok(has(unknown.warnings, '판정하지 못한'))
  assert.ok(inspect('### 1. `tests/test_app.py`', 'ruff check src\nnpm run lint', [['tests/test_app.py', '수정']]).violations.length > 0)
})

test('테스트 디렉터리의 보조 파일은 지정해 실행하지 않아도 된다', () => {
  // 가짜 서버와 fixture 를 수정하고 그것을 쓰는 spec 을 파일 이름으로 실행하던 계획서의 재현이다
  const entries: Entry[] = [
    ['web/src/panel.ts', '수정'],
    ['test/e2e/fake-hermes.ts', '수정'],
    ['test/browser/fixtures.ts', '수정'],
    ['test/unit/tool-label.test.ts', '신규'],
    ['test/browser/activity-scroll.spec.ts', '신규'],
  ]
  const work = '### 1. `test/e2e/fake-hermes.ts` 에 이벤트 추가\n### 2. `test/browser/fixtures.ts` 갱신\n### 3. `test/unit/tool-label.test.ts`\n### 4. `test/browser/activity-scroll.spec.ts`'
  const command = 'node --test test/unit/tool-label.test.ts\npnpm test:browser activity-scroll.spec.ts'
  assert.deepEqual(inspect(work, command, entries).violations, [])
  // 실행 대상 테스트는 파일 단위로 대조한다
  assert.ok(inspect(work, 'node --test test/unit/tool-label.test.ts\npnpm test:browser other.spec.ts', entries).violations.length > 0)
})

test('보조 파일만 고치는 phase 도 테스트 실행이 필요하다', () => {
  const entries: Entry[] = [['test/browser/fixtures.ts', '수정']]
  const work = '### 1. `test/browser/fixtures.ts` 갱신'
  assert.ok(inspect(work, 'npx eslint test/browser/fixtures.ts', entries).violations.length > 0)
  assert.ok(inspect(work, 'echo done', entries).violations.length > 0)
  assert.deepEqual(inspect(work, 'pnpm test:browser activity-scroll.spec.ts', entries).violations, [])
  // 운영 코드를 바꾸면서 보조 파일만 고치면 같은 phase 의 테스트 작업으로 친다
  assert.deepEqual(inspect(work, 'pnpm test:browser', [...entries, ['web/src/panel.ts', '수정']]).violations, [])
})

test('테스트 실패를 무시하는 명령은 위반이고 선택 검사는 괜찮다', () => {
  const entries: Entry[] = [['tests/test_app.py', '신규']]
  assert.ok(inspect('### 1. `tests/test_app.py`', 'pytest || true', entries).violations.length > 0)
  assert.ok(has(inspect('### 1. `tests/test_app.py`', 'pytest || exit 0', entries).violations, '테스트 실패를 무시하는 명령'))
  assert.deepEqual(inspect('### 1. `tests/test_app.py`', 'pytest\ngrep optional README.md || true', entries).violations, [])
})

test('exit 0 으로 숨기기와 pipefail 없는 tee', () => {
  const entries: Entry[] = [['tests/test_app.py', '신규']]
  const piped = inspect('### 1. `tests/test_app.py`', 'pytest | tee out.log', entries)
  assert.deepEqual(piped.violations, [])
  assert.ok(has(piped.warnings, 'pipefail'))
  assert.ok(!has(inspect('### 1. `tests/test_app.py`', 'set -euo pipefail\npytest | tee out.log', entries).warnings, 'pipefail'))
})

test('셸 블록의 BSD sed \\b 도 산문과 같이 본다', () => {
  const work = "### 1. 작업\n```bash\nsed -i '' 's/\\bfoo/bar/' a.txt\n```\n```python\nsed = r'sed x \\b'\n```"
  const r = inspect(work, 'pytest', [])
  const sed = r.violations.filter((line) => line.includes('BSD sed'))
  assert.equal(sed.length, 1, r.violations.join('\n'))
  assert.match(sed[0], /phase-01\.md:\d+ — BSD sed 에서 동작하지 않는 \\b: sed -i/)
})

test('산문의 BSD sed \\b 를 잡는다', () => {
  const r = inspect('### 1. 작업\n`sed -E "s/\\bfoo/bar/"` 로 바꾼다', 'pytest', [])
  assert.ok(has(r.violations, 'BSD sed 에서 동작하지 않는 \\b'), r.violations.join('\n'))
})

test('bun test 는 ./ 로 시작하지 않는 점 디렉터리 인자를 알린다', () => {
  // `bun test pkg/.claude/skills/...` 가 그 아래 테스트를 찾지 않고 종료 코드 0 으로 끝난 계획서의 재현이다
  const entries: Entry[] = [['pkg/.claude/skills/x/a.ts', '수정'], ['pkg/.claude/skills/x/a.test.ts', '수정']]
  const work = '### 1. `pkg/.claude/skills/x/a.test.ts`'
  for (const command of ['bun test pkg/.claude/skills/x', 'bun test src .hidden', 'bunx bun test pkg/.claude/skills/x/a.test.ts', 'bun --cwd web test pkg/.claude']) {
    assert.ok(has(inspect(work, command, entries).violations, '`./'), command)
  }
  for (const command of ['bun test ./pkg/.claude/skills/x', 'bun test ../.hidden', 'bun test /repo/.claude/x', 'bun test src', 'bun test -t .only ./pkg/.claude/skills/x']) {
    assert.ok(!has(inspect(work, command, entries).violations, 'bun test'), command)
  }
})

test('bun test 의 점 디렉터리 검사는 독립한 줄마다 본다', () => {
  const work = '### 1. `frontend/.claude/a.test.ts` 추가'
  const entries: Entry[] = [['frontend/.claude/a.test.ts', '신규']]
  const safe = 'cd frontend && bun test ./.claude\ncd frontend && bun test ./.claude'
  assert.deepEqual(inspect(work, safe, entries).violations, [])
  assert.ok(has(inspect(work, safe.replaceAll('./.claude', '.claude'), entries).violations, '점 디렉터리'))
})

test('점 디렉터리가 든 경로의 unittest 인자는 위반이다', () => {
  // `python3 -m unittest .github/...` 는 `ValueError: Empty module name` 으로 테스트를 하나도 돌리지 않는다
  const work = '### 1. `.github/scripts/tests/test_sync.py` 추가'
  const entries: Entry[] = [['.github/scripts/tests/test_sync.py', '신규']]
  for (const [command, fix] of [
    ['python3 -m unittest .github/scripts/tests/test_sync.py', 'discover -s .github/scripts/tests -p test_sync.py'],
    ['python3 -m unittest -v ./.github/scripts/tests/test_sync.py', 'discover -s .github/scripts/tests -p test_sync.py'],
    ['python -m unittest .github/scripts/tests', 'discover -s .github/scripts/tests'],
  ]) {
    const r = inspect(work, command, entries)
    assert.ok(r.violations.some((line) => line.includes('Empty module name') && line.includes(fix)), `${command}\n${r.violations.join('\n')}`)
  }
})

test('unittest discover 와 점 디렉터리 없는 경로는 점 검사를 통과한다', () => {
  const work = '### 1. `.github/scripts/tests/test_sync.py` 추가'
  const entries: Entry[] = [['.github/scripts/tests/test_sync.py', '신규']]
  for (const command of [
    'python3 -m unittest discover -s .github/scripts/tests -p test_sync.py',
    'python3 -m unittest discover .github/scripts/tests',
    'python3 -m unittest -k .github tests/test_sync.py',
    'python3 -m unittest ./tests/test_sync.py ../shared/test_x.py',
  ]) {
    assert.ok(!has(inspect(work, command, entries).violations, 'Empty module name'), command)
  }
})

test('금지 문자열 검사가 같은 phase 의 테스트 파일에 걸리면 경고한다', () => {
  // 「X 가 없어야 한다」 를 단언하는 테스트가 X 를 담아, 같은 경로의 `! git grep X` 와 동시에 통과할 수 없던 계획서의 재현이다
  const entries: Entry[] = [['src/policy.ts', '수정'], ['src/policy.test.ts', '신규']]
  const work = '### 1. `src/policy.test.ts` 에 `legacyKey` 가 없는지 단언'
  const warned = (command: string) => has(inspect(work, `npm test\n${command}`, entries).warnings, '금지 문자열')
  for (const command of ['! git grep "legacyKey" -- src', '! git grep -n legacyKey -- src/policy.test.ts', '! git grep legacyKey', '! git grep -e legacyKey src/', "! git grep legacyKey -- 'src/*.ts'", '! git -C src grep legacyKey -- .']) {
    assert.ok(warned(command), command)
  }
  for (const command of ["! git grep legacyKey -- src ':!src/policy.test.ts'", "! git grep legacyKey -- src ':(exclude)src/*.test.ts'", '! git grep legacyKey -- docs', 'git grep legacyKey -- src', '! git grep legacyKey HEAD -- docs']) {
    assert.ok(!warned(command), command)
  }
})

test('검증 절의 push 와 원격 접속은 경고한다', () => {
  // phase 검증 절에 push 뒤 홈서버에서 검증하는 명령을 넣어, 검증을 끝내려면 먼저 커밋해야 했던 계획서의 재현이다
  const entries: Entry[] = [['src/app.py', '수정'], ['tests/test_app.py', '수정']]
  const warned = (command: string) => has(inspect('### 1. `tests/test_app.py`', `pytest tests/test_app.py\n${command}`, entries).warnings, '원격 접속')
  for (const command of ['git push origin HEAD', "ssh home 'cd /tmp/wt && scripts/verify.sh live'", 'scp dist/app home:/srv/', 'git -C . push', 'rsync -a dist/ deploy@home:/srv/app/']) {
    assert.ok(warned(command), command)
  }
  for (const command of ['git status --short', 'rsync -a dist/ build/', 'grep ssh docs/flow.md', 'echo push']) {
    assert.ok(!warned(command), command)
  }
})

test('스크립트 실행기를 쓰면 테스트 범위를 직접 확인하라고 경고한다', () => {
  const r = inspect('### 1. `scripts/check-app.sh` 추가', 'bash scripts/check-app.sh', [['scripts/check-app.sh', '신규']])
  assert.ok(has(r.warnings, '저장소 스크립트의 테스트 범위와 실패 종료 코드는 직접 확인한다: bash scripts/check-app.sh'), r.warnings.join('\n'))
})

test('phase 본문의 필수 절이 없으면 위반이다', () => {
  const r = inspect('### 1. 작업', 'pytest', [], { text: () => '# Phase\n## 목표\n앱\n' })
  for (const section of ['**범위 외**', '## 작업 항목', '## 검증']) assert.ok(has(r.violations, `필수 섹션 누락: ${section}`), section)
})
