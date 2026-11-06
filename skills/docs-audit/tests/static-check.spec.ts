// docs-audit 의 static_check 명령 경계 테스트. 임시 git 저장소에 Markdown 을 쓰고 stdout 줄, stderr 안내, 종료 코드를 본다.
// 검사마다 걸리는 표본과 걸리지 않는 표본을 함께 둔다. 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'static_check.py')]
// ──

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function repo(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'static-check-')))
  roots.push(root)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  spawnSync('git', ['init', '-q', '.'], { cwd: root, env })
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  const run = (...args: string[]) => {
    const done = spawnSync(COMMAND[0], [...COMMAND.slice(1), ...args], { cwd: root, env, encoding: 'utf8' })
    return { code: done.status, stdout: done.stdout, stderr: done.stderr, lines: done.stdout.split('\n').filter(Boolean) }
  }
  return { root, run }
}

// 파일 하나를 쓰고 stdout 줄을 돌려준다
function lines(path: string, body: string): string[] {
  return repo({ [path]: body }).run().lines
}

const ARCH = 'docs/code-architecture.md'
const CELL = '| 경로 | 소유하는 것 |\n| --- | --- |\n'

describe('표, 제목, 코드 펜스', () => {
  test('열 수가 어긋난 표', () => {
    assert.deepEqual(lines('t.md', '| 머리 | 값 |\n| --- | --- |\n| 하나 |'), ['t.md:3: 표 열 수 불일치 (헤더 2칸, 이 행 1칸)'])
  })

  test('열 수가 맞는 표는 통과', () => {
    assert.deepEqual(lines('t.md', '| 머리 | 값 |\n| --- | --- |\n| 하나 | 1 |'), [])
  })

  test('코드 스팬 안의 이스케이프한 파이프는 열이 아니다', () => {
    const head = '| 이름 | 설명 | 처리 |\n| --- | --- | --- |\n'
    for (const row of ['| `table_cell_health` | 셀 안의 `\\|` 를 센다 | 고쳤다 |', '| 배포 방식 | `[Ship\\|Show\\|Ask]` 로 적는다 | 그대로 |']) {
      assert.deepEqual(lines('t.md', head + row), [], row)
    }
  })

  test('코드 스팬 안의 맨 파이프는 열이다', () => {
    assert.deepEqual(lines('t.md', '| 머리 | 값 |\n| --- | --- |\n| `a|b` | 1 |'), ['t.md:3: 표 열 수 불일치 (헤더 2칸, 이 행 3칸)'])
  })

  test('역슬래시 다음의 파이프는 진짜 구분자다', () => {
    assert.deepEqual(lines('t.md', '| 머리 | 값 |\n| --- | --- |\n| 경로\\\\ | 1 | 남는다 |'), ['t.md:3: 표 열 수 불일치 (헤더 2칸, 이 행 3칸)'])
  })

  test('제목 단계를 건너뛰면 위반, 차례대로면 통과', () => {
    assert.deepEqual(lines('t.md', '# 하나\n#### 넷'), ['t.md:2: 헤딩 레벨 건너뜀 (h1 → h4)'])
    assert.deepEqual(lines('t.md', '# 하나\n## 둘\n### 셋'), [])
  })

  test('닫히지 않은 코드 펜스', () => {
    assert.deepEqual(lines('t.md', '# 제목\n```bash\necho 열림'), ['t.md: 코드 펜스 짝이 안 맞음 (``` 1개)'])
  })

  test('코드 블록 안의 셸 주석과 표는 보지 않는다', () => {
    assert.deepEqual(lines('t.md', '# 하나\n\n```bash\n#### 셸 주석\n| 표 | 아님 |\n```'), [])
  })
})

describe('PLAN_REF', () => {
  const cases: [string, string[]][] = [
    ['이 결정의 출처는 (ADR-008, plan051) 이다.', ['plan051']],
    ['구현은 `tasks/plan059-foo/` 에 있다.', ['plan059']],
    ['source: [plan037, plan041]', ['plan037', 'plan041']],
    ['plan-018 을 본다.', ['plan-018']],
  ]
  for (const [body, found] of cases) {
    test(`번호로 가리키면 잡는다: ${body}`, () => {
      assert.deepEqual(lines('docs/a.md', body), found.map((id) => `docs/a.md:1: PLAN_REF 계획서를 번호로 가리킨다 → ${id}`))
    })
  }

  for (const body of ['`tests/unit/test_plan032_error_classify.py` 를 본다.', '`tasks/plan{N}-{slug}/` 를 만든다.', '사고 사례(plan###)는 1개로 충분하다.', '```\ntasks/plan051/\n```']) {
    test(`식별자, 자리 표시자, 코드 블록은 건너뛴다: ${body.split('\n')[0]}`, () => {
      assert.deepEqual(lines('docs/a.md', body), [])
    })
  }

  test('계획서 폴더 안의 파일은 자기 번호를 불러도 된다', () => {
    for (const path of ['tasks/plan059-foo/phase-01.md', 'tasks/fe-plan027-login/phase-01.md', 'backend/tasks/be-plan003/phase-02.md']) {
      assert.deepEqual(lines(path, 'plan027 의 phase 다.'), [], path)
    }
  })

  test('하위 프로젝트 문서의 접두 번호 참조는 잡는다', () => {
    assert.deepEqual(lines('frontend/docs/flow.md', '근거는 `tasks/fe-plan027-login/` 에 있다.'), ['frontend/docs/flow.md:1: PLAN_REF 계획서를 번호로 가리킨다 → plan027'])
  })

  test('식별자 이름의 폴더는 계획서 폴더가 아니다', () => {
    assert.deepEqual(lines('docs/test_plan032/a.md', 'plan051 을 본다.'), ['docs/test_plan032/a.md:1: PLAN_REF 계획서를 번호로 가리킨다 → plan051'])
  })
})

describe('LISTED_ITEMS', () => {
  const warn = (path: string, line: number, hit: string) => `${path}:${line}: WARN LISTED_ITEMS 책임 설명에 목록을 늘어놓았다 → ${hit}`

  test('표 칸과 트리 줄의 목록을 경고로 낸다', () => {
    assert.deepEqual(lines(ARCH, `${CELL}| \`config.yaml\` | 런타임 설정 (기능 플래그, 캐시 크기, 외부 API 주소) |`), [warn(ARCH, 3, '(기능 플래그, 캐시 크기, 외부 API 주소)')])
    assert.deepEqual(lines(ARCH, '```\nsrc/\n  config.yaml  런타임 설정 (기능 플래그, 캐시 크기, 외부 API 주소)\n```'), [warn(ARCH, 3, '(기능 플래그, 캐시 크기, 외부 API 주소)')])
    assert.deepEqual(lines(ARCH, '```text\n├── config.yaml   런타임 설정（플래그、캐시、주소）\n```'), [warn(ARCH, 2, '（플래그、캐시、주소）')])
  })

  test('둘짜리 부연, 첫 열, 코드, 본문은 건너뛴다', () => {
    for (const body of [
      `${CELL}| \`a/\` | 재시도 (기본값 3, 최대 10) |`,
      '| 경로 (a, b, c) | 소유하는 것 |\n| --- | --- |\n| `a/` | 업무 규칙 |',
      '```python\nconfig = load(a, b, c)\n```',
      '```markdown\n| `a/` | 설정 (가, 나, 다) |\n```',
      '런타임 설정 (기능 플래그, 캐시 크기, 외부 API 주소) 을 본문에 적었다.',
    ]) {
      assert.deepEqual(lines(ARCH, body), [], body)
    }
  })

  test('docs/code-architecture.md 에서만 본다', () => {
    const row = `${CELL}| \`a/\` | 설정 (가, 나, 다) |`
    for (const path of ['docs/flow.md', 'references/examples/code-architecture.md']) assert.deepEqual(lines(path, row), [], path)
    assert.deepEqual(lines('frontend/docs/code-architecture.md', row), [warn('frontend/docs/code-architecture.md', 3, '(가, 나, 다)')])
  })

  test('경고만 있으면 0 이고, 위반과 함께면 위반 줄 다음에 경고 줄이 온다', () => {
    const row = `# 구조\n\n${CELL}| \`a/\` | 설정 (가, 나, 다) |\n`
    const only = repo({ [ARCH]: row }).run()
    assert.deepEqual([only.code, only.lines], [0, [warn(ARCH, 5, '(가, 나, 다)')]])
    const both = repo({ [ARCH]: `${row}\n### 건너뜀\n` }).run()
    assert.deepEqual([both.code, both.lines], [1, [`${ARCH}:7: 헤딩 레벨 건너뜀 (h1 → h3)`, warn(ARCH, 5, '(가, 나, 다)')]])
  })
})

describe('파일 수집과 종료 코드', () => {
  test('한글 이름 파일도 검사하고 개수를 stderr 에 낸다', () => {
    const done = repo({ '한글 이름.md': '# 제목\n\n### 건너뜀\n' }).run()
    assert.deepEqual([done.code, done.stdout, done.stderr], [1, '한글 이름.md:3: 헤딩 레벨 건너뜀 (h1 → h3)\n', '검사한 Markdown: 1개 (scope: .)\n'])
  })

  test('추적하지 않은 새 파일도 검사한다', () => {
    assert.equal(repo({ '새문서.md': '# 제목\n\n### 건너뜀\n' }).run().code, 1)
  })

  test('.gitignore 로 무시한 파일은 건너뛴다', () => {
    const done = repo({ '.gitignore': '무시.md\n', '무시.md': '# 제목\n\n### 건너뜀\n', '정상.md': '# 제목\n' }).run()
    assert.deepEqual([done.code, done.stdout], [0, ''])
  })

  test('Markdown 이 하나도 없으면 통과가 아니라 2', () => {
    const done = repo({ 'code.py': 'x = 1\n' }).run()
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', '검사한 Markdown: 0개 (scope: .)\n검사 오류: 범위 안에서 Markdown 파일을 찾지 못했다.\n'])
  })

  test('ADR_DIR 인자는 받기만 하고 stderr 에 안내한다', () => {
    const r = repo({ 'docs/adr/001-a.md': '## ADR-001: 결정\n', 'docs/adr/INDEX.md': '# INDEX\n', 'a.md': '# 제목\n\n[깨짐](없다.md)\n\n### 건너뜀\n' })
    const done = r.run('docs/adr', '.')
    assert.deepEqual([done.code, done.lines], [1, ['a.md:5: 헤딩 레벨 건너뜀 (h1 → h3)']])
    assert.equal(done.stderr, '안내: ADR 검사는 plan 의 adr-docs.ts 가 맡는다. ADR_DIR 인자는 쓰지 않는다.\n검사한 Markdown: 3개 (scope: .)\n')
    assert.equal(r.run('없는디렉터리').code, 1)
  })

  test('범위를 주면 그 아래만 본다', () => {
    const r = repo({ 'docs/a.md': '# 제목\n\n### 건너뜀\n', 'other/b.md': '# 제목\n\n### 건너뜀\n' })
    const done = r.run('', 'docs')
    assert.deepEqual([done.code, done.lines, done.stderr], [1, ['docs/a.md:3: 헤딩 레벨 건너뜀 (h1 → h3)'], '검사한 Markdown: 1개 (scope: docs)\n'])
  })

  test('없는 범위는 사용법 오류 2', () => {
    const done = repo({ 'a.md': '# 제목\n' }).run('', '없는경로')
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', '사용법 오류: 문서 범위를 찾을 수 없다: 없는경로\n'])
  })

  test('git 저장소 밖에서는 사용법 오류 2', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'static-check-plain-')))
    roots.push(plain)
    const done = spawnSync(COMMAND[0], COMMAND.slice(1), { cwd: plain, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: plain } })
    assert.deepEqual([done.status, done.stderr], [2, '사용법 오류: Git 저장소 루트에서 실행해야 한다.\n'])
  })
})
