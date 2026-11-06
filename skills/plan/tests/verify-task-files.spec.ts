// verify_task 의 명령 경계 테스트 2: 변경 파일 표, 구현 전 파일 상태, git index 대조(--staged), 상대 링크, 옵션과 종료 코드.

import assert from 'node:assert/strict'
import { symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { type Entry, indexJson, Repo, verify, writePlan } from './helpers.ts'

const has = (lines: string[], needle: string) => lines.some((line) => line.includes(needle))

// 파일 상태 대조가 내는 줄만 남긴다
const STATE = /존재|생략하지 않은|신규 glob|생략 경로|신규·수정|4단계/
const state = (lines: string[]) => lines.filter((line) => STATE.test(line))

// phase 마다 변경 파일만 다른 계획을 만들어 구현 전 상태로 검사한다. repo 의 파일은 호출하는 쪽이 미리 둔다
function check(repo: Repo, phases: Entry[][], extra: string[] = []) {
  repo.file('docs/flow.md')
  const name = 'plan1-x'
  writePlan(repo, name, phases.map((entries) => ({ entries })))
  return verify(repo, [name, ...extra])
}

test('파일 생애: 신규, 수정, 삭제를 뒤 phase 가 이어 받는다', () => {
  const repo = new Repo()
  const ok = check(repo, [[['src/new.py', '신규']], [['src/new.py', '수정']], [['src/new.py', '삭제']]])
  assert.deepEqual(state(ok.violations), [])
  const again = check(new Repo(), [[['src/new.py', '신규']], [['src/new.py', '수정']], [['src/new.py', '삭제']], [['src/new.py', '수정']]])
  assert.ok(has(state(again.violations), '수정 파일이 존재하지 않는다: src/new.py'), again.violations.join('\n'))
})

test('파일 상태와 glob 일치', () => {
  const cases: [Entry[], number][] = [
    [[['src/existing.py', '수정']], 0],
    [[['src/*.py', '삭제']], 0],
    [[['src/existing.py', '신규']], 1],
    [[['absent.py', '수정']], 1],
    [[['absent.py', '삭제']], 1],
  ]
  for (const [entries, expected] of cases) {
    const repo = new Repo()
    repo.file('src/existing.py')
    assert.equal(state(check(repo, [entries]).violations).length, expected, JSON.stringify(entries))
  }
})

test('없는 파일 위반은 rebase 를 안내한다', () => {
  for (const action of ['수정', '삭제']) {
    const out = state(check(new Repo(), [[['absent.py', action]]]).violations)
    assert.equal(out.length, 1, action)
    assert.ok(out[0].includes(`${action} 파일이 존재하지 않는다: absent.py`), out[0])
    assert.ok(out[0].includes('선행 계획이 만들 파일이면 그 계획이 머지된 뒤 기준 브랜치로 rebase 해 다시 돌린다'), out[0])
  }
})

test('glob 삭제는 뒤 phase 에서 보인다', () => {
  const repo = new Repo()
  repo.file('src/app.py')
  const out = state(check(repo, [[['src/*.py', '삭제']], [['src/app.py', '수정']]]).violations)
  assert.equal(out.length, 1, out.join('\n'))
})

test('생략 경로는 변경 파일 표에서 위반이고 옛 Critical Files 에서는 경고다', () => {
  // 생성 검사가 경고로 통과시킨 경로를 커밋 전 staged 대조가 막던 불일치의 재현이다
  const r = check(new Repo(), [[['src/.../app.py', '수정'], ['src/*.py', '신규']]])
  assert.equal(state(r.violations).length, 1, r.violations.join('\n'))
  assert.ok(has(r.violations, '변경 파일에는 생략하지 않은 경로가 필요하다: src/.../app.py'))
  assert.equal(state(r.warnings).length, 1, r.warnings.join('\n'))
  assert.ok(has(r.warnings, '신규 glob 은 구체 파일의 부재를 보장하지 못한다: src/*.py'))

  const repo = new Repo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-x', [{ entries: [] }])
  repo.file('tasks/plan1-x/phase-01.md', require_text('## Critical Files\n| 파일 | 변경 |\n| --- | --- |\n| `src/.../app.py` | 수정 |\n'))
  const legacy = verify(repo, ['plan1-x'])
  assert.deepEqual(state(legacy.violations), [])
  assert.ok(has(legacy.warnings, '생략 경로는 존재를 대조하지 않는다: src/.../app.py'), legacy.warnings.join('\n'))
  assert.ok(has(legacy.warnings, 'Critical Files 는 읽기 호환이다'))
})

// 변경 파일 절만 바꾼 phase 본문
function require_text(manifest: string): string {
  return `## 목표\n앱\n**범위 외**: 배포\n\n## 컨텍스트\n**근거 문서**: \`docs/flow.md\`\n\n## 작업 항목\n### 1. 작업\n\n## 검증\n\`\`\`bash\npytest\n\`\`\`\n\n${manifest}`
}

test('동적 라우트 조각은 문자 그대로의 경로다', () => {
  // Next.js 의 [...path] 를 생략으로, [id] 를 문자 클래스로 읽던 결함의 재현이다
  const route = 'web/src/app/api/x/[id]/files/[...path]/route.ts'
  const repo = new Repo()
  repo.file(route)
  const ok = check(repo, [[[route, '수정'], ['web/src/app/[[...slug]]/page.tsx', '신규']]])
  assert.deepEqual(state(ok.violations), [], ok.violations.join('\n'))
  assert.deepEqual(state(ok.warnings), [])
  // 한 글자 디렉터리는 [id] 문자 클래스에 맞지만 문자 그대로 대조하므로 존재로 보지 않는다
  const other = new Repo()
  other.file('web/src/app/api/y/i/route.ts')
  assert.equal(state(check(other, [[['web/src/app/api/y/[id]/route.ts', '수정']]]).violations).length, 1)
  // 대괄호 조각과 * 가 섞인 glob 은 대괄호 조각만 문자 그대로 읽는다
  const mixed = new Repo()
  mixed.file(route)
  assert.deepEqual(state(check(mixed, [[['web/src/app/api/x/[id]/files/*/route.ts', '수정']]]).violations), [])
  const miss = new Repo()
  miss.file('web/src/app/api/x/i/files/a/route.ts')
  assert.equal(state(check(miss, [[['web/src/app/api/x/[id]/files/*/route.ts', '수정']]]).violations).length, 1)
  // 조각 안의 대괄호와 대괄호 밖의 ... 는 glob 과 생략이다
  const glob = new Repo()
  glob.file('src/file1.py')
  assert.deepEqual(state(check(glob, [[['src/file[0-9].py', '수정']]]).violations), [])
  assert.ok(has(check(new Repo(), [[['src/.../[id]/route.ts', '수정']]]).violations, '생략하지 않은 경로가 필요하다'))
})

test('glob 의 ? 와 문자 클래스는 보조 평면 문자도 한 글자로 센다', () => {
  for (const pattern of ['docs/?.md', 'docs/[😀].md', 'docs/*.md']) {
    const repo = new Repo()
    repo.file('docs/😀.md')
    const r = check(repo, [[[pattern, '수정']]])
    assert.deepEqual(state(r.violations), [], pattern)
  }
})

test('glob 문자 클래스의 역순 범위는 오류가 아니라 Python fnmatch 의 규칙을 따른다', () => {
  const repo = new Repo()
  repo.file('docs/a.md')
  const r = check(repo, [[['docs/[!z-a].md', '수정']]])
  assert.equal(r.code === 2, false, r.stderr)
  assert.deepEqual(state(r.violations), [])
})

test('앞 phase 가 신규로 둔 glob 은 존재로 센다', () => {
  const r = check(new Repo(), [
    [['src/dto/*.java', '신규']],
    [['src/dto/Foo.java', '수정']],
    [['src/dto/Foo.java', '삭제']],
    [['src/dto/Foo.java', '수정']],
    [['src/other/Foo.java', '수정']],
  ])
  const out = state(r.violations)
  assert.equal(out.length, 2, out.join('\n'))
  assert.ok(out[0].includes('phase-04.md') && out[0].includes('src/dto/Foo.java'))
  assert.ok(out[1].includes('phase-05.md') && out[1].includes('src/other/Foo.java'))
})

test('앞 phase 의 신규 glob 안쪽 glob 도 존재로 센다', () => {
  // 앞 phase 가 backend/** 를 신규로 두고 뒤 phase 가 backend/tasks/** 를 삭제하던 계획서의 재현이다
  const r = check(new Repo(), [
    [['backend/**', '신규']],
    [['backend/tasks/**', '삭제']],
    [['backend/tasks/**', '삭제']],
    [['backend/tasks/a.py', '수정']],
    [['backend/src/*.py', '수정']],
  ])
  const out = state(r.violations)
  assert.equal(out.length, 2, out.join('\n'))
  assert.ok(out[0].includes('phase-03.md') && out[1].includes('phase-04.md'), out.join('\n'))
})

test('앞 phase 의 신규 glob 밖의 glob 은 여전히 없다', () => {
  const out = state(check(new Repo(), [[['backend/**', '신규']], [['frontend/tasks/**', '삭제']]]).violations)
  assert.equal(out.length, 1, out.join('\n'))
})

test('신규·수정 glob 은 존재하는 파일이 없어도 된다', () => {
  const r = check(new Repo(), [[['src/none/*.png', '신규·수정']]])
  assert.deepEqual(state(r.violations), [])
  assert.deepEqual(state(r.warnings), [])
})

test('신규·수정은 구체 경로에 쓰지 못한다', () => {
  const repo = new Repo()
  repo.file('src/app.py')
  const r = check(repo, [[['src/app.py', '신규·수정']]])
  const found = r.violations.filter((line) => line.includes('신규·수정은 glob 행에만 쓴다'))
  assert.equal(found.length, 1, r.violations.join('\n'))
  assert.ok(found[0].includes('src/app.py'))
})

test('변경 파일 표의 호환 이름과 잘못된 행', () => {
  for (const name of ['변경 파일', 'Critical Files']) {
    const repo = new Repo()
    repo.file('src/a.py')
    repo.file('docs/flow.md')
    writePlan(repo, 'plan1-x', [{ entries: [] }])
    repo.file('tasks/plan1-x/phase-01.md', require_text(`## ${name}\n| 파일 | 변경 |\n| \`src/a.py\` | 수정 |\n`))
    const r = verify(repo, ['plan1-x'])
    assert.ok(!has(r.violations, '변경 파일 절이 없다') && !has(r.violations, '변경 파일 목록이 비었다'), `${name}\n${r.violations.join('\n')}`)
    assert.ok(!has(r.violations, '존재하지 않는다'), name)
  }
  for (const rel of ['../escape.py', '/tmp/escape.py', '$APP/a.py']) {
    const r = check(new Repo(), [[[rel, '수정']]])
    assert.ok(has(r.violations, `저장소 상대경로가 필요하다: ${rel}`), `${rel}\n${r.violations.join('\n')}`)
  }
  const row = check(new Repo(), [[]])
  assert.ok(has(row.violations, '변경 파일 목록이 비었다'))
})

test('변경 파일 행의 형식 오류와 중복을 알린다', () => {
  const repo = new Repo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-x', [{ entries: [] }])
  repo.file(
    'tasks/plan1-x/phase-01.md',
    require_text('## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n| `a.py` | 수정 | 덤 |\n| `b.py` | 이동 |\n| `c.py` | 신규 |\n| `c.py` | 신규 |\n'),
  )
  const r = verify(repo, ['plan1-x', '--audit'])
  assert.ok(has(r.violations, '변경 파일 행은 파일과 변경 두 칸이어야 한다'), r.violations.join('\n'))
  assert.ok(has(r.violations, '변경 파일 행의 경로 또는 변경 종류가 잘못됐다'))
  assert.ok(has(r.violations, '변경 파일 중복: c.py'))
})

test('4단계에서 먼저 쓴 커밋 전 docs 는 경고이고 나머지는 위반이다', () => {
  const committed = new Repo('plan-docs-', true)
  committed.file('docs/flow.md', 'x')
  committed.git('add', '-A')
  committed.git('commit', '-q', '-m', 'init')
  committed.file('docs/adr/012-queue.md', '# ADR\n')
  const warn = check(committed, [[['docs/adr/012-queue.md', '신규']]])
  assert.deepEqual(state(warn.violations), [])
  assert.ok(warn.warnings.some((w) => w.includes('docs/adr/012-queue.md') && w.includes('넣지 않는다')), warn.warnings.join('\n'))

  // 커밋한 docs 의 신규는 그대로 위반이다
  const already = new Repo('plan-docs-', true)
  already.file('docs/flow.md', 'x')
  already.git('add', '-A')
  already.git('commit', '-q', '-m', 'init')
  assert.ok(has(check(already, [[['docs/flow.md', '신규']]]).violations, '신규 파일이 이미 존재한다'))

  // docs 가 아닌 커밋 전 파일은 위반이다
  const code = new Repo('plan-docs-', true)
  code.file('docs/flow.md', 'x')
  code.git('add', '-A')
  code.git('commit', '-q', '-m', 'init')
  code.file('src/app.py', 'x = 1\n')
  assert.ok(has(check(code, [[['src/app.py', '신규']]]).violations, '신규 파일이 이미 존재한다'))

  // git 밖의 docs 도 위반이다
  const outside = new Repo('plan-docs-')
  outside.file('docs/flow.md')
  assert.ok(has(check(outside, [[['docs/flow.md', '신규']]]).violations, '신규 파일이 이미 존재한다'))
})

// 상대 링크

function links(text: string, tasksDir = 'tasks') {
  const repo = new Repo()
  repo.file('docs/adr/001-x.md')
  repo.file('docs/flow.md')
  const dir = writePlan(repo, 'plan1-a', [{ entries: [] }], { tasksDir })
  repo.file(`${dir}/phase-01.md`, require_text('## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n') + text)
  return verify(repo, ['plan1-a', '--audit', '--tasks-dir', tasksDir]).violations.filter((line) => line.includes('링크 대상 파일이 없다'))
}

test('상대 링크는 phase 파일 위치 기준으로 푼다', () => {
  assert.deepEqual(links('\n[ADR](../../docs/adr/001-x.md) 와 [절](../../docs/adr/001-x.md#a)\n'), [])
})

test('저장소 루트 기준으로 쓴 링크는 위반이다', () => {
  const out = links('\n[ADR](docs/adr/001-x.md)\n')
  assert.equal(out.length, 1, out.join('\n'))
  assert.match(out[0], /phase-01\.md:\d+ — 링크 대상 파일이 없다: docs\/adr\/001-x\.md \(phase-01\.md 위치 기준\)\. /)
})

test('옆 파일 링크와 참조 링크도 검사한다', () => {
  const out = links('\n[다음](031-next.md)\n\n[ref]: ../../docs/missing.md\n')
  assert.equal(out.length, 2, out.join('\n'))
})

test('URL, 앵커, 코드, 절대 링크는 건너뛴다', () => {
  const text = '\n[웹](https://example.com/a.md) [앵커](#절) [메일](mailto:a@b.c) [절대](/docs/x.md)\n`[코드](missing.md)`\n```md\n[블록](missing.md)\n```\n'
  assert.deepEqual(links(text), [])
})

test('퍼센트 인코딩한 링크와 꺾쇠 링크를 푼다', () => {
  assert.deepEqual(links('\n[ADR](<../../docs/adr/001-x.md>) [인코딩](../../docs/adr/001%2Dx.md)\n'), [])
  assert.equal(links('\n[없음](../../docs/adr/%EC%97%86.md)\n').length, 1)
})

// git index 대조(--staged)

function stagedRepo(): Repo {
  const repo = new Repo('plan-staged-', true)
  return repo
}

const manifest = (rows: string) => `## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n${rows}`

// phase 파일을 쓰고 --staged 로 검사한다. phase 경로는 저장소 루트 기준이다
function staged(repo: Repo, rows: string, phase = 'p.md', content?: string) {
  repo.file(phase, content ?? manifest(rows))
  return verify(repo, ['--staged', phase])
}

function commitAll(repo: Repo, message = 'initial'): void {
  repo.git('add', '-A')
  repo.git('commit', '--quiet', '-m', message)
}

test('staged: 추가, 수정, 삭제, 이름 변경을 목록과 대조한다', () => {
  const repo = stagedRepo()
  repo.file('src/old.py', 'old\n')
  repo.file('src/edit.py', 'before\n')
  commitAll(repo)
  repo.git('mv', 'src/old.py', 'src/new.py')
  repo.file('src/edit.py', 'after\n')
  repo.git('add', 'src')
  const rows = '| `src/old.py` | 삭제 |\n| `src/new.py` | 신규 |\n| `src/edit.py` | 수정 |\n'
  const r = staged(repo, rows)
  assert.deepEqual([r.violations, r.warnings], [[], []])
  assert.equal(r.summary, '위반 0건, 경고 0건')
  repo.file('unrelated.py')
  repo.git('add', 'unrelated.py')
  const bad = staged(repo, rows)
  assert.deepEqual(bad.violations, ['p.md — phase 범위 밖의 staged 파일: unrelated.py'])
  assert.equal(bad.code, 1)
})

test('staged: 목록에 있는데 staged 에 없는 파일', () => {
  const repo = stagedRepo()
  repo.file('src/app.py', 'before\n')
  repo.file('src/edit.py', 'before\n')
  commitAll(repo)
  repo.file('src/app.py', 'after\n')
  repo.git('add', 'src/app.py')
  const r = staged(repo, '| `src/app.py` | 수정 |\n| `tests/test_app.py` | 신규 |\n| `src/edit.py` | 수정 |\n| `src/gen/*.py` | 신규 |\n')
  assert.deepEqual(r.violations, ['p.md — 신규로 적은 파일이 staged 에 없다: tests/test_app.py'])
  assert.deepEqual(r.warnings, ['p.md — 수정로 적은 파일이 staged 에 없다: src/edit.py'])
})

function metadataRepo() {
  const repo = stagedRepo()
  const planDirs = ['tasks/plan1-app', 'docs/features/app/tasks/plan1-app']
  const phaseManifest = manifest('| `tests/test_app.py` | 신규 |\n')
  for (const dir of planDirs) {
    repo.file(`${dir}/index.json`, '{"current_phase": 1}\n')
    repo.file(`${dir}/phase-01.md`, phaseManifest)
  }
  commitAll(repo)
  return { repo, planDirs, phaseManifest }
}

test('staged: 메타데이터만 staged 면 구현 파일 누락을 보지 않는다', () => {
  const { repo, planDirs, phaseManifest } = metadataRepo()
  repo.file('tests/test_app.py', 'pass\n')
  commitAll(repo, 'phase implementation')
  for (const dir of planDirs) {
    for (const names of [['index.json'], ['index.json', 'phase-01.md'], ['verification-plan.md']]) {
      repo.git('reset', '--quiet')
      for (const name of names) {
        repo.file(`${dir}/${name}`, name === 'index.json' ? '{"current_phase": 2}\n' : `${phaseManifest}\n보완\n`)
        repo.git('add', `${dir}/${name}`)
      }
      const r = verify(repo, ['--staged', `${dir}/phase-01.md`])
      assert.deepEqual([r.violations, r.warnings], [[], []], `${dir} ${names}`)
      assert.equal(r.stdout, '위반 0건, 경고 0건\n')
      // 절대 경로로 줘도 같다
      assert.equal(verify(repo, ['--staged', join(repo.root, dir, 'phase-01.md')]).code, 0)
    }
  }
})

test('staged: 구현은 자기 계획의 메타데이터를 함께 받는다', () => {
  const { repo, planDirs, phaseManifest } = metadataRepo()
  for (const dir of planDirs) {
    repo.git('reset', '--quiet')
    repo.file('tests/test_app.py', 'pass\n')
    repo.file(`${dir}/index.json`, '{"current_phase": 2}\n')
    repo.file(`${dir}/phase-01.md`, `${phaseManifest}\n`)
    repo.file(`${dir}/phase-02.md`, 'next phase\n')
    repo.git('add', 'tests', dir)
    const r = verify(repo, ['--staged', `${dir}/phase-01.md`])
    assert.deepEqual([r.violations, r.warnings], [[], []], dir)
  }
})

test('staged: 계획 안의 phase 이름 변경은 메타데이터다', () => {
  const { repo, planDirs } = metadataRepo()
  repo.file('tests/test_app.py', 'pass\n')
  commitAll(repo, 'phase implementation')
  for (const dir of planDirs) {
    repo.git('reset', '--quiet')
    repo.git('mv', `${dir}/phase-01.md`, `${dir}/phase-02.md`)
    const r = verify(repo, ['--staged', `${dir}/phase-02.md`])
    assert.deepEqual([r.violations, r.warnings], [[], []], dir)
  }
})

test('staged: 메타데이터가 다른 파일이나 빠진 테스트를 가리지 않는다', () => {
  const { repo, planDirs } = metadataRepo()
  const dir = planDirs[0]
  repo.file(`${dir}/index.json`, '{"current_phase": 2}\n')
  const unrelated = ['tasks/plan2-other/index.json', `${planDirs[1]}/phase-02.md`, `${dir}/notes.md`, `${planDirs[1]}/verification-plan.md`, `${dir}/nested/phase-02.md`, 'src/app.py']
  for (const rel of unrelated) repo.file(rel, 'unrelated\n')
  repo.git('add', '.')
  const phase = `${dir}/phase-01.md`
  const r = verify(repo, ['--staged', phase])
  for (const rel of unrelated) assert.ok(r.violations.includes(`${phase} — phase 범위 밖의 staged 파일: ${rel}`), `${rel}\n${r.violations.join('\n')}`)
  assert.ok(r.violations.includes(`${phase} — 신규로 적은 파일이 staged 에 없다: tests/test_app.py`))
  assert.equal(r.violations.length, unrelated.length + 1)
})

test('staged: 메타데이터가 있어도 구현의 변경 종류를 본다', () => {
  const { repo, planDirs } = metadataRepo()
  const dir = planDirs[0]
  repo.file(`${dir}/index.json`, '{"current_phase": 2}\n')
  repo.file('tests/test_app.py', 'pass\n')
  repo.git('add', '.')
  const r = staged(repo, '| `tests/test_app.py` | 수정 |\n', `${dir}/phase-01.md`)
  assert.equal(r.violations.length, 1, r.violations.join('\n'))
  assert.ok(r.violations[0].includes('staged 변경 종류가 목록과 다르다: tests/test_app.py (신규)'))
})

test('staged: 계획 밖의 심볼릭 링크는 자기 메타데이터가 아니다', () => {
  const { repo, planDirs, phaseManifest } = metadataRepo()
  repo.file('tests/test_app.py', 'pass\n')
  mkdirSync(join(repo.root, 'tasks/plan2-other'), { recursive: true })
  symlinkSync('../plan1-app/index.json', join(repo.root, 'tasks/plan2-other/index.json'))
  repo.git('add', 'tests', 'tasks/plan2-other')
  const phase = `${planDirs[0]}/phase-01.md`
  const r = verify(repo, ['--staged', phase])
  assert.deepEqual(r.violations, [`${phase} — phase 범위 밖의 staged 파일: tasks/plan2-other/index.json`])
  assert.ok(phaseManifest)
})

test('staged: 종류가 틀리거나 경로를 생략하면 위반이다', () => {
  const repo = stagedRepo()
  repo.file('src/app.py')
  repo.git('add', 'src')
  for (const row of ['| `src/app.py` | 수정 |', '| `src/.../app.py` | 신규 |']) assert.ok(staged(repo, `${row}\n`).violations.length > 0, row)
})

function commitSrc(...files: string[]): Repo {
  const repo = stagedRepo()
  for (const rel of files) repo.file(rel, 'old\n')
  repo.git('add', 'src')
  repo.git('commit', '--quiet', '-m', 'initial')
  return repo
}

test('staged: 신규·수정 glob 은 새 파일과 고친 파일을 모두 받는다', () => {
  // 에셋 phase: glob 아래에 고친 파일과 새 파일이 함께 staged 되어도 종류가 맞다고 본다
  const repo = commitSrc('src/gen/a.png')
  repo.file('src/gen/a.png', 'new\n')
  repo.file('src/gen/b.png', 'new\n')
  repo.git('add', 'src')
  assert.deepEqual(staged(repo, '| `src/gen/*.png` | 신규·수정 |\n').violations, [])
})

test('staged: 신규·수정 glob 도 삭제는 받지 않는다', () => {
  const repo = commitSrc('src/gen/a.png', 'src/gen/c.png')
  repo.file('src/gen/a.png', 'new\n')
  repo.file('src/gen/b.png', 'new\n')
  repo.git('rm', '--quiet', 'src/gen/c.png')
  repo.git('add', 'src/gen/a.png', 'src/gen/b.png')
  assert.deepEqual(staged(repo, '| `src/gen/*.png` | 신규·수정 |\n').violations, ['p.md — staged 변경 종류가 목록과 다르다: src/gen/c.png (삭제)'])
})

test('staged: 생략 경로 위반은 glob 과 신규·수정을 안내한다', () => {
  const repo = stagedRepo()
  const r = staged(repo, '| `src/.../app.py` | 신규 |\n')
  const found = r.violations.filter((line) => line.includes('생략하지 않은 변경 파일 경로가 필요하다'))
  assert.equal(found.length, 1, r.violations.join('\n'))
  assert.ok(found[0].includes('신규·수정') && found[0].includes('glob'))
})

test('staged: 동적 라우트는 문자 그대로 대조한다', () => {
  const repo = stagedRepo()
  const route = 'web/src/app/api/x/[id]/files/[...path]/route.ts'
  repo.file(route)
  repo.git('add', 'web')
  const r = staged(repo, `| \`${route}\` | 신규 |\n`)
  assert.deepEqual([r.violations, r.warnings], [[], []])
})

test('staged: staged 변경이 없으면 위반이다', () => {
  const repo = stagedRepo()
  const r = staged(repo, '| `src/app.py` | 신규 |\n')
  assert.ok(r.violations.includes('p.md — staged 변경이 없다'), r.violations.join('\n'))
})

// 옵션과 종료 코드

function goodPlan(repo: Repo, name = 'plan1-app', tasksDir = 'tasks') {
  repo.file('src/app.py')
  repo.file('docs/flow.md')
  const phase = require_text(
    '## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n| `src/app.py` | 신규 |\n| `tests/test_app.py` | 신규 |\n## 마감\nindex.json status completed\n',
  ).replace('## 작업 항목\n### 1. 작업', '## 작업 항목\n### 1. `tests/test_app.py` 추가')
  repo.file(`${tasksDir}/${name}/phase-01.md`, phase)
  repo.file(`${tasksDir}/${name}/index.json`, indexJson(name, 1))
}

test('구현 전 검사는 1, --audit 는 0, 깨진 index 와 없는 계획은 2 로 끝난다', () => {
  const repo = new Repo()
  goodPlan(repo)
  assert.equal(verify(repo, ['plan1-app']).code, 1)
  assert.equal(verify(repo, ['plan1-app', '--audit']).code, 0)
  repo.file('tasks/plan1-app/index.json', '{')
  assert.equal(verify(repo, ['plan1-app']).code, 2)
  assert.equal(verify(repo, ['missing']).code, 2)
  const none = verify(repo, [])
  assert.equal(none.code, 2)
  assert.equal(none.stdout, '')
  assert.ok(none.stderr.includes('--staged'), none.stderr)
})

test('옵션: 고유 접두, 거듭 준 값, 사용법 오류', () => {
  const repo = new Repo()
  goodPlan(repo)
  goodPlan(repo, 'plan1-app', 'frontend/tasks')
  assert.equal(verify(repo, ['plan1-app', '--aud']).code, 0)
  assert.equal(verify(repo, ['plan1-app', '--audit=1']).code, 2)
  assert.equal(verify(repo, ['--audit', 'plan1-app']).code, 0)
  assert.equal(verify(repo, ['plan1-app', '--tasks-dir', 'x', '--tasks-dir', 'frontend/tasks', '--audit']).code, 0)
  assert.equal(verify(repo, ['plan1-app', '--tasks-d=frontend/tasks', '--audit']).code, 0)
  assert.equal(verify(repo, ['plan1-app', '--nope']).code, 2)
  assert.equal(verify(repo, ['plan1-app', '--tasks-dir']).code, 2)
  assert.equal(verify(repo, ['plan1-app', 'plan2-app']).code, 2)
  assert.equal(verify(repo, ['plan1-app', '--staged', 'tasks/plan1-app/phase-01.md']).code, 2)
  assert.equal(verify(repo, ['plan1-app', '--audit', '--staged', 'x']).code, 2)
  assert.equal(verify(repo, ['--staged', 'x', '--require-verification']).code, 2)
  assert.equal(verify(repo, ['--help']).code, 0)
  assert.equal(verify(repo, ['-h']).code, 0)
  assert.equal(verify(repo, ['plan1-app', '--require-verification', '--audit']).code, 1)
})

test('plan 은 tasks 폴더 아래 디렉터리 이름이어야 한다', () => {
  const repo = new Repo()
  goodPlan(repo)
  const r = verify(repo, ['tasks/plan1-app', '--audit'])
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('plan 은 tasks/ 아래 디렉터리 이름이어야 한다'), r.stderr)
})

test('마지막 phase 가 완료 표시를 요구하지 않는다', () => {
  // 완료한 계획서는 지우므로 마지막 phase 가 index.json 을 completed 로 바꾸라고 적지 않아도 된다
  const repo = new Repo()
  repo.file('src/app.py')
  repo.file('docs/flow.md')
  writePlan(repo, 'plan2-app', [
    {
      work: '### 1. `tests/test_app.py` 추가',
      command: 'pytest tests/test_app.py',
      entries: [['src/app.py', '수정'], ['tests/test_app.py', '신규']],
    },
  ])
  const r = verify(repo, ['plan2-app'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok(!r.stdout.includes('completed'))
})

test('접두사 계획은 tasks 경로를 바꿔 검사한다', () => {
  const repo = new Repo()
  repo.file('frontend/docs/flow.md')
  const phases = [
    {
      work: '### 1. `frontend/tests/test_app.py` 추가',
      command: 'pytest frontend/tests/test_app.py',
      entries: [['frontend/src/app.py', '신규'], ['frontend/tests/test_app.py', '신규']] as Entry[],
      evidence: '`frontend/docs/flow.md`',
    },
  ]
  for (const tasksDir of ['tasks', 'frontend/tasks']) writePlan(repo, 'fe-plan27-app', phases, { tasksDir })
  const stdout = (args: string[]) => verify(repo, args)
  assert.equal(stdout(['fe-plan27-app']).code, 0)
  assert.equal(stdout(['fe-plan27-app', '--tasks-dir', 'frontend/tasks']).code, 0)
  assert.equal(stdout(['fe-plan27-app', '--tasks-dir', 'backend/tasks']).code, 2)
})

test('node --test 와 파일을 지정한 pnpm 테스트, 동적 라우트를 한 phase 에 적은 계획', () => {
  const route = 'web/src/app/api/x/[id]/files/[...path]/route.ts'
  const repo = new Repo()
  repo.file('docs/flow.md')
  repo.file(route)
  writePlan(repo, 'plan1-route', [
    {
      work: '### 1. `web/test/unit/a.test.ts` 추가\n### 2. `web/tests/b.spec.ts` 추가',
      command: 'node --test test/unit/a.test.ts\npnpm test:browser b.spec.ts',
      entries: [[route, '수정'], ['web/test/unit/a.test.ts', '신규'], ['web/tests/b.spec.ts', '신규']],
    },
  ])
  const r = verify(repo, ['plan1-route'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal(r.summary, '위반 0건, 경고 0건'.replace('경고 0건', `경고 ${r.warnings.length}건`))
})

test('전체 실행과 디렉터리 실행을 다른 블록에 둔 계획은 통과한다', () => {
  const rel = 'frontend/src/__tests__/a/X.test.tsx'
  const repo = new Repo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-cwd', [
    {
      work: `### 1. \`${rel}\` 추가`,
      command: 'cd frontend && pnpm test\n```\n\n```bash\ncd frontend && pnpm test -- src/__tests__/a',
      entries: [[rel, '신규']],
    },
  ])
  const r = verify(repo, ['plan1-cwd'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok(r.stdout.includes('위반 0건'))
})

test('산문 위반은 검사 이름을 줄에 낸다', () => {
  const repo = new Repo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-names', [{ work: '### 1. `src/a.py` 추가\n전체 삭제를 한다\n직접 확인한다\n전체 삭제 경로를 담는다', command: 'pytest', entries: [['src/a.py', '신규']] }])
  const r = verify(repo, ['plan1-names'])
  assert.ok(has(r.violations, '모호한 범위 지시: 전체 삭제를 한다'), r.violations.join('\n'))
  assert.ok(has(r.violations, '사람 의존 검증: 직접 확인한다'))
  assert.ok(!has(r.violations, '전체 삭제 경로'))
  assert.match(r.violations.find((line) => line.includes('모호한 범위 지시'))!, /phase-01\.md:\d+ — 모호한 범위 지시: 전체 삭제를 한다$/)
})
