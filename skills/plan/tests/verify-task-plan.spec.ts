// verify_task 의 명령 경계 테스트 3: 계획 index 와 PR 크기, 계획 번호 겹침, 레포 설정의 상한, 원격 검증 표, 호출자 경고, 기능 계약 연결.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkEstimatedSize, checkTestReferences } from '../scripts/verify_task.ts'
import { DESIGN, type Entry, indexJson, type Phase, Repo, SKILL_DIR, VALID, VALID_REQ, verify, writePlan } from './helpers.ts'

const has = (lines: string[], needle: string) => lines.some((line) => line.includes(needle))

// index.json

function oneTest(): Phase {
  return { work: '### 1. 문서', command: 'pytest', entries: [['docs/a.md', '수정']] }
}

function planWith(index: Record<string, unknown>, phases: Phase[] = [oneTest()], name = 'plan1-a') {
  const repo = new Repo()
  repo.file('docs/flow.md')
  repo.file('docs/a.md')
  writePlan(repo, name, phases, { index })
  return { repo, run: (...args: string[]) => verify(repo, [name, '--audit', ...args]) }
}

test('index: name, total_phases, 금지 키, phase 항목의 스키마를 본다', () => {
  const bad = planWith({ name: 'other', total_phases: 5, depends_on: [], related_docs: [], prerequisites: [] }).run()
  assert.ok(has(bad.violations, "name 이 디렉터리명과 다르다: 'other' != 'plan1-a'"), bad.violations.join('\n'))
  assert.ok(has(bad.violations, 'total_phases(5) 가 phases 길이(1)와 다르다'))
  for (const key of ['depends_on', 'related_docs', 'prerequisites']) assert.ok(has(bad.violations, `스키마에 없는 키: ${key}`), key)

  const phases = [
    { number: 2, file: 'phase-01.md', execution_profile: 'standard' },
    { number: 1, file: 'phase-02.md', model: 'sonnet' },
    { number: 3, file: 'phase-09.md', execution_profile: 'slow' },
    { file: 'phase-01.md', execution_profile: 'standard', model: 'opus' },
    'text',
  ]
  const r = planWith({ total_phases: 5, phases }, [oneTest(), oneTest()]).run()
  assert.ok(has(r.violations, 'phases[0] number 가 1 이 아니다: 2'), r.violations.join('\n'))
  assert.ok(has(r.violations, 'phases[2] 가 가리키는 phase-09.md 가 없다'))
  assert.ok(has(r.violations, 'phases[2] execution_profile/model schema 오류'))
  assert.ok(has(r.violations, 'phases[3] 에 number 가 없다'))
  assert.ok(has(r.violations, 'phases[3] execution_profile/model schema 오류'))
  assert.ok(has(r.violations, 'phases[4] 가 객체가 아니다'))
  assert.ok(has(r.violations, 'phases 목록과 실제 phase 파일이 일치하지 않는다'))
})

test('index: 객체와 phases 배열이 아니면 위반이다', () => {
  const repo = new Repo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [oneTest()])
  repo.file('tasks/plan1-a/index.json', '[1]')
  const r = verify(repo, ['plan1-a', '--audit'])
  assert.ok(has(r.violations, 'index 객체와 phases 배열이 필요하다'), r.violations.join('\n'))
})

// pr_scope, deferred

const SCOPE = { created_at: '2026-10-25', pr_scope: '로그인 화면을 만든다', deferred: [{ what: '소셜 로그인', why: '화면이 먼저 필요하다', after: '이 PR 의 머지' }] }
const scopeLines = (lines: string[]) => lines.filter((line) => /pr_scope|deferred|plan 을 나누고/.test(line))

test('pr_scope: 완전한 새 계획은 통과한다', () => {
  const r = planWith(SCOPE).run()
  assert.deepEqual(scopeLines([...r.violations, ...r.warnings]), [])
})

test('pr_scope: deferred 는 빈 배열이어도 된다', () => {
  assert.deepEqual(scopeLines(planWith({ ...SCOPE, deferred: [] }).run().violations), [])
})

test('pr_scope: 새 계획에 pr_scope 나 deferred 가 없으면 위반이다', () => {
  const r = planWith({ created_at: '2026-10-25' }).run()
  assert.equal(scopeLines(r.warnings).length, 0)
  assert.equal(scopeLines(r.violations).length, 2, r.violations.join('\n'))
  assert.ok(has(r.violations, 'pr_scope 가 없거나 비었다'))
  assert.ok(has(r.violations, 'deferred 칸이 없다'))
})

test('pr_scope: 빈 pr_scope 와 덜 채운 deferred 항목은 위반이다', () => {
  const r = planWith({ ...SCOPE, pr_scope: '  ', deferred: [{ what: '소셜 로그인', why: '', after: 'x' }, 'text'] }).run()
  assert.ok(has(r.violations, 'pr_scope 가 없거나 비었다'))
  assert.ok(has(r.violations, 'deferred[0] 에 why 가 비었다'))
  assert.ok(has(r.violations, 'deferred[1] 에 what, why, after 가 비었다'), r.violations.join('\n'))
})

test('pr_scope: 여러 줄이면 위반이다', () => {
  assert.ok(has(planWith({ ...SCOPE, pr_scope: '하나\n둘' }).run().violations, 'pr_scope 는 한 문장이어야 한다'))
})

const manyPhases = (count: number) => Array.from({ length: count }, oneTest)

test('pr_scope: phase 가 상한을 넘으면 새 계획은 위반이다', () => {
  const r = planWith(SCOPE, manyPhases(7)).run()
  const found = r.violations.filter((line) => line.includes('plan 을 나누고'))
  assert.equal(found.length, 1, r.violations.join('\n'))
  assert.ok(found[0].includes('phase 가 7개로 PR 하나의 크기(6개)를 넘는다'))
  assert.equal(scopeLines(planWith(SCOPE, manyPhases(6)).run().violations).length, 0)
})

test('pr_scope: 옛 계획은 같은 검사를 경고만 한다', () => {
  for (const created_at of ['2026-10-24', undefined]) {
    const r = planWith({ created_at }, manyPhases(7)).run()
    assert.deepEqual(scopeLines(r.violations), [], String(created_at))
    assert.equal(scopeLines(r.warnings).length, 3, r.warnings.join('\n'))
    assert.ok(r.warnings.every((w) => !scopeLines([w]).length || w.includes('옛 plan 이라 경고만 낸다')))
  }
})

test('변경 파일 수가 기본 상한을 넘으면 경고하고 docs 는 세지 않는다', () => {
  const files = (count: number): Entry[] => [...Array.from({ length: count }, (_, n): Entry => [`src/f${n}.py`, '신규']), ['docs/a.md', '수정']]
  const make = (count: number) => planWith({}, [{ work: '### 1. 문서', command: 'pytest', entries: files(count) }])
  assert.ok(!has(make(40).run().warnings, '변경 파일이 40개'), 'x')
  const over = make(41).run()
  assert.ok(has(over.warnings, '변경 파일이 41개로 PR 하나의 크기(40개)를 넘는다'), over.warnings.join('\n'))
})

// 계획 번호

function numberRepo() {
  const repo = new Repo('plan-number-', true)
  repo.file('tasks/plan12-login/index.json', '{}')
  repo.git('add', '-A')
  repo.git('commit', '-q', '-m', 'plan12-login')
  repo.file('docs/flow.md')
  return repo
}

function addPlan(repo: Repo, name: string, prefix = ''): void {
  writePlan(repo, `${prefix}${name}`, [oneTest()])
  repo.file('docs/a.md')
}

test('이미 커밋된 번호를 쓰는 새 계획은 위반이다', () => {
  const repo = numberRepo()
  addPlan(repo, 'plan012-board')
  const r = verify(repo, ['plan012-board', '--audit'])
  assert.deepEqual(r.warnings.filter((w) => w.includes('계획 번호가 겹친다')), [])
  const found = r.violations.filter((line) => line.includes('계획 번호가 겹친다'))
  assert.equal(found.length, 1, r.violations.join('\n'))
  assert.match(found[0], /계획 번호가 겹친다: plan12-login \(main, 작업 트리, \d{4}-\d{2}-\d{2} 추가\)\. 이 계획은 커밋 전 추가/)
  assert.ok(found[0].includes('이 계획의 번호를'))
  assert.ok(found[0].includes('의 다음 번호로 바꾼다'))
})

test('커밋된 계획끼리 같은 번호면 경고만 한다', () => {
  // 이미 phase 가 진행 중인 계획을 폴더 이름 때문에 막지 않는다
  const repo = numberRepo()
  repo.git('checkout', '-q', '-b', 'other')
  addPlan(repo, 'plan012-board')
  repo.git('add', '-A')
  repo.git('commit', '-q', '-m', 'plan012-board')
  repo.git('checkout', '-q', 'main')
  repo.file('docs/flow.md')
  writePlan(repo, 'plan12-login', [oneTest()])
  repo.file('docs/a.md')
  const r = verify(repo, ['plan12-login', '--audit'])
  assert.deepEqual(r.violations.filter((line) => line.includes('계획 번호가 겹친다')), [])
  const found = r.warnings.filter((w) => w.includes('계획 번호가 겹친다'))
  assert.equal(found.length, 1, r.warnings.join('\n'))
  assert.match(found[0], /plan012-board \(other, \d{4}-\d{2}-\d{2} 추가\)\. 이 계획은 \d{4}-\d{2}-\d{2} 추가/)
  assert.ok(found[0].includes('보고에서 계획 이름을 붙인다'))
})

test('같은 계획과 다른 번호와 다른 접두사는 겹치지 않는다', () => {
  const repo = numberRepo()
  addPlan(repo, 'plan13-board')
  addPlan(repo, 'plan12-board', 'fe-')
  addPlan(repo, 'plan12-login')
  const r = verify(repo, ['plan12-login', '--audit'])
  assert.ok(!has([...r.violations, ...r.warnings], '계획 번호가 겹친다'), r.stdout)
})

// 레포 설정의 상한

function overlay(repo: Repo, rows: [string, string][], rel = '.claude/plan-overlay.md'): void {
  const table = rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')
  repo.file(rel, `# plan 레포 설정\n\n## 저장소 배치\n\n| 값 | 값 |\n| --- | --- |\n${table}\n`)
}

function fileEntries(count: number, prefix = 'src'): Entry[] {
  return Array.from({ length: count }, (_, n): Entry => [`${prefix}/f${n}.py`, '신규'])
}

function limited(repo: Repo, count: number, tasksDir = 'tasks', prefix = 'src') {
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [{ work: '### 1. 문서', command: 'pytest', entries: [...fileEntries(Math.ceil(count / 2), prefix), ...fileEntries(count - Math.ceil(count / 2), `${prefix}b`)] }], { tasksDir })
  return verify(repo, ['plan1-a', '--audit', '--tasks-dir', tasksDir])
}

test('설정이 없으면 기본 기준을 쓴다', () => {
  const repo = new Repo()
  overlay(repo, [['docs 경로', '`docs/`']])
  const r = limited(repo, 41)
  assert.ok(has(r.warnings, '변경 파일이 41개로 PR 하나의 크기(40개)를 넘는다'))
})

test('PR 변경 파일 상한은 정수나 JSON 키로 읽는다', () => {
  const repo = new Repo()
  overlay(repo, [['PR 변경 파일 상한', '`20`']])
  const r = limited(repo, 21)
  assert.ok(r.warnings.some((w) => w.includes('변경 파일이 21개로 저장소의 PR 크기 기준(20개, .claude/plan-overlay.md)을 넘는다') && w.includes('phase 별 변경 파일: phase-01 21개')), r.warnings.join('\n'))
  assert.ok(!has(limited(repo, 20).warnings, 'PR 크기 기준'))

  const json = new Repo()
  json.file('.github/pr-size.json', JSON.stringify({ grades: { B: { files: 15 } } }))
  overlay(json, [['PR 변경 파일 상한', '`.github/pr-size.json#grades.B.files` (B 등급)']])
  assert.ok(has(limited(json, 16).warnings, '저장소의 PR 크기 기준(15개, .claude/plan-overlay.md)'))
})

test('읽지 못한 상한은 경고하고 기본 기준을 쓴다', () => {
  const repo = new Repo()
  overlay(repo, [['PR 변경 파일 상한', '`.github/pr-size.json#grades.B.files`']])
  const r = limited(repo, 41)
  const found = r.warnings.filter((w) => w.includes('「PR 변경 파일 상한」 을 읽지 못해 기본 기준'))
  assert.equal(found.length, 1, r.warnings.join('\n'))
  assert.ok(found[0].startsWith('.claude/plan-overlay.md — '))
  assert.ok(found[0].includes('기본 기준(40개)'))
  assert.ok(has(r.warnings, '변경 파일이 41개로 PR 하나의 크기(40개)'))
})

test('하위 프로젝트 오버레이는 그 계획에서 이긴다', () => {
  const repo = new Repo()
  overlay(repo, [['PR 변경 파일 상한', '`30`']])
  overlay(repo, [['PR 변경 파일 상한', '`10`']], 'frontend/.claude/plan-overlay.md')
  const inFrontend = limited(repo, 12, 'frontend/tasks', 'frontend/src')
  assert.ok(has(inFrontend.warnings, '저장소의 PR 크기 기준(10개, frontend/.claude/plan-overlay.md)'), inFrontend.warnings.join('\n'))
  const inRoot = limited(new Repo(), 12)
  assert.ok(!has(inRoot.warnings, 'PR 크기 기준'))
  const root = new Repo()
  overlay(root, [['PR 변경 파일 상한', '`30`']])
  overlay(root, [['PR 변경 파일 상한', '`10`']], 'frontend/.claude/plan-overlay.md')
  assert.ok(!has(limited(root, 12).warnings, 'PR 크기 기준'))
})

test('저장소 상한은 계획 폴더만 빼고 센다', () => {
  const repo = new Repo()
  overlay(repo, [['PR 변경 파일 상한', '`4`']])
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [
    { entries: [['src/f0.py', '신규'], ['docs/a.md', '수정']] },
    { entries: [['src/f1.py', '신규'], ['src/f2.py', '신규'], ['tasks/plan1-a/extra.md', '신규']] },
  ])
  const ok = verify(repo, ['plan1-a', '--audit'])
  assert.ok(!has(ok.warnings, 'PR 크기 기준'), ok.warnings.join('\n'))
  writePlan(repo, 'plan1-a', [
    { entries: [['src/f0.py', '신규'], ['docs/a.md', '수정']] },
    { entries: [['src/f1.py', '신규'], ['src/f2.py', '신규'], ['src/extra.py', '신규'], ['tasks/plan1-a/extra.md', '신규']] },
  ])
  const over = verify(repo, ['plan1-a', '--audit'])
  const found = over.warnings.find((w) => w.includes('PR 크기 기준'))!
  assert.ok(found.includes('변경 파일이 5개로 저장소의 PR 크기 기준(4개, .claude/plan-overlay.md)'), over.warnings.join('\n'))
  assert.ok(found.includes('phase 별 변경 파일: phase-01 2개, phase-02 4개'), found)
})

function lengthRepo(): Repo {
  const repo = new Repo()
  overlay(repo, [['파일 길이 상한', '`600`'], ['파일 길이 대상', '`*.java`, `src/**/*.kt`']])
  for (const [rel, lines] of [['a/Big.java', 580], ['a/Small.java', 560], ['src/x/Big.kt', 599], ['a/Big.py', 599], ['a/New.java', 599]] as const) repo.file(rel, 'x\n'.repeat(lines))
  return repo
}

test('상한에 가까운 수정 파일만 길이 경고를 낸다', () => {
  const repo = lengthRepo()
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [
    {
      entries: [['a/Big.java', '수정'], ['a/Small.java', '수정'], ['src/x/Big.kt', '수정'], ['a/Big.py', '수정'], ['a/New.java', '신규'], ['a/*.java', '신규·수정']],
    },
  ])
  const r = verify(repo, ['plan1-a'])
  const found = r.warnings.filter((w) => w.includes('파일 길이 상한'))
  assert.equal(found.length, 2, r.warnings.join('\n'))
  assert.ok(found[0].includes('a/Big.java 이 580줄') && found[0].includes('20줄 남았다') && found[0].includes('(600줄, .claude/plan-overlay.md)'), found[0])
  assert.ok(found[1].includes('src/x/Big.kt 이 599줄'), found[1])
  // 구현 후 검사는 길이를 보지 않는다
  assert.ok(!has(verify(repo, ['plan1-a', '--audit']).warnings, '파일 길이 상한'))
})

test('길이 대상이 없으면 코드 파일 전부에 적용한다', () => {
  const repo = new Repo()
  overlay(repo, [['파일 길이 상한', '`100`']])
  repo.file('a.py', 'x\n'.repeat(99))
  repo.file('a.md', 'x\n'.repeat(99))
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [{ entries: [['a.py', '수정'], ['a.md', '수정']] }])
  const found = verify(repo, ['plan1-a']).warnings.filter((w) => w.includes('파일 길이 상한'))
  assert.equal(found.length, 1)
  assert.ok(found[0].includes('a.py 이 99줄'))
})

test('읽지 못한 길이 상한은 경고하고 길이를 보지 않는다', () => {
  const repo = new Repo()
  overlay(repo, [['파일 길이 상한', '`abc`']])
  repo.file('a.py', 'x\n'.repeat(999))
  repo.file('docs/flow.md')
  writePlan(repo, 'plan1-a', [{ entries: [['a.py', '수정']] }])
  const r = verify(repo, ['plan1-a'])
  assert.ok(has(r.warnings, '「파일 길이 상한」 을 읽지 못해 파일 길이를 보지 않는다'), r.warnings.join('\n'))
})

// 원격 검증 표

const REMOTE_HEAD = '| 선행 조건 | 시점 | 실행 위치 | 명령 | 기대값 |\n|---|---|---|---|---|\n'

function remote(table: string) {
  const repo = new Repo()
  repo.file('docs/flow.md')
  repo.file('docs/a.md')
  writePlan(repo, 'plan1-a', [oneTest()])
  repo.file('tasks/plan1-a/remote-verification.md', `# 원격 검증\n\n${table}`)
  const r = verify(repo, ['plan1-a', '--audit'])
  return { violations: r.violations.filter((l) => l.includes('remote-verification.md')), warnings: r.warnings.filter((w) => w.includes('remote-verification.md')) }
}

test('원격 검증 표: 올바른 행은 통과한다', () => {
  // dev 읽기 전용 실측은 push 없이 PR 전에 돌려야 했는데, 양식이 시점을 받지 않아 PR 뒤로만 읽혔던 재현이다
  const ok =
    '| 없음 | PR 전 | app | 읽기 전용 측정 절차 | 1 |\n| push 한 뒤 | PR 뒤 | app | `scripts/verify.sh live` | 0 |\n| 배포 | PR 뒤 | app | 상태 확인 절차 | 200 |\n'
  assert.deepEqual(remote(REMOTE_HEAD + ok), { violations: [], warnings: [] })
})

test('원격 검증 표: 선행 조건과 시점의 위반', () => {
  for (const [row, needle] of [
    ['| 머지 | PR 전 | dev | `x` | 0 |\n', 'PR 전에 돌릴 수 없다'],
    ['| 배포 | PR 전 | dev | `x` | 0 |\n', 'PR 전에 돌릴 수 없다'],
    ['| 없음 | 언젠가 | dev | `x` | 0 |\n', '시점은'],
    ['| 아마 | PR 전 | dev | `x` | 0 |\n', '선행 조건은'],
  ]) {
    const r = remote(REMOTE_HEAD + row)
    assert.ok(has(r.violations, needle), `${row}\n${r.violations.join('\n')}`)
  }
  const noColumn = remote('| 선행 조건 | 실행 위치 | 명령 |\n|---|---|---|\n| 없음 | dev | `x` |\n')
  assert.ok(has(noColumn.violations, '열이 없다'), noColumn.violations.join('\n'))
  assert.ok(has(remote('본문만 있다\n').violations, '원격 검증 표가 없다'))
})

test('원격 검증 표: 명령 칸의 원격 접속은 경고만 한다', () => {
  const headers = ['| 선행 조건 | 시점 | 실행 위치 | 명령 | 기대값 |\n|---|---|---|---|---|\n', '| 선행 조건 | 실행 위치 | 명령 | 기대값 |\n|---|---|---|---|\n']
  for (const header of headers) {
    for (const command of ["ssh dev 'select 1'", 'env FLAG=1 /usr/bin/ssh dev', 'scp dist/app dev:/srv/', 'sftp dev', 'mosh dev', 'rsync -a dist/ dev:/srv/', 'echo ready && ssh dev true']) {
      const timing = header.includes('시점') ? ' PR 전 |' : ''
      const r = remote(`${header}| 없음 |${timing} app | \`${command}\` | 0 |\n`)
      assert.deepEqual(r.violations, [], command)
      assert.ok(has(r.warnings, '명령 칸에 원격 접속'), `${command}\n${r.warnings.join('\n')}`)
    }
  }
})

test('원격 검증 표: 절차 이름과 저장소 스크립트는 경고하지 않는다', () => {
  for (const command of ['읽기 전용 측정 절차', 'scripts/verify.sh live', 'python3 scripts/measure.py', 'scripts/ssh-check.py', 'echo ssh', 'rsync -a dist/ build/']) {
    assert.deepEqual(remote(`${REMOTE_HEAD}| 없음 | PR 전 | app | \`${command}\` | 0 |\n`), { violations: [], warnings: [] }, command)
  }
})

test('원격 검증 표: 시점 열이 없는 옛 형식은 경고만 한다', () => {
  const legacy = '| 선행 조건 | 실행 위치 | 명령 | 기대값 |\n|---|---|---|---|\n| PR 브랜치를 push 한 뒤 | 홈서버 | `x` | 0 |\n'
  const r = remote(legacy)
  assert.deepEqual(r.violations, [])
  assert.ok(has(r.warnings, '옛 형식'), r.warnings.join('\n'))
  assert.ok(has(r.warnings, '선행 조건은 없음, push, 머지, 배포 중 하나로 시작한다'))
})

// 호출자 경고

function callerRepo(files: Record<string, string>): Repo {
  const repo = new Repo('plan-callers-', true)
  repo.file('docs/flow.md')
  for (const [rel, text] of Object.entries(files)) repo.file(rel, text)
  repo.git('add', '-A')
  return repo
}

function callers(repo: Repo, phases: { work: string; entries: Entry[] }[]) {
  writePlan(repo, 'plan1-a', phases.map((p) => ({ work: p.work, entries: p.entries, command: 'pytest' })))
  return verify(repo, ['plan1-a']).warnings.filter((w) => w.includes('을 쓰는 파일이 plan 의 변경 파일에 없다') || w.includes('너무 흔한 이름'))
}

test('호출자: plan 의 변경 파일에 없는 호출자는 경고다', () => {
  const repo = callerRepo({ 'src/repo.py': 'def save(user):\n    pass\n', 'src/api.py': 'from src.repo import save\nsave(1)\n', 'src/other.py': 'x = 1\n', 'docs/notes.md': 'save() 를 설명한다\n' })
  const warnings = callers(repo, [{ work: '### 1. `save(user, now)` 에 인자를 더한다', entries: [['src/repo.py', '수정']] }])
  assert.equal(warnings.length, 1, warnings.join('\n'))
  assert.ok(warnings[0].includes('src/api.py'))
  assert.ok(!warnings[0].includes('docs/notes.md') && !warnings[0].includes('src/other.py'))
  assert.match(warnings[0], /phase-01\.md — `save` 을 쓰는 파일이 plan 의 변경 파일에 없다: src\/api\.py\. 시그니처나 동작이 바뀌어 고쳐야 하면 변경 파일 표에 넣는다$/)
})

test('호출자: plan 의 어느 phase 에든 있으면 통과한다', () => {
  const repo = callerRepo({ 'src/repo.py': 'def save(user):\n    pass\n', 'src/api.py': 'from src.repo import save\nsave(1)\n' })
  const warnings = callers(repo, [
    { work: '### 1. `Repo.save()` 를 바꾼다', entries: [['src/repo.py', '수정']] },
    { work: '### 1. 호출부', entries: [['src/api.py', '수정']] },
  ])
  assert.deepEqual(warnings, [])
})

const OWNERS: [string, string, boolean][] = [
  ['export declare function triage(): void;', 'triage', true],
  ['declare function triage(): void;', 'triage', false],
  ['export abstract class Repo { abstract triage(): void; }', 'triage', true],
  ['abstract class Repo { abstract triage(): void; }', 'triage', false],
  ["const a = <p>It's</p>;\nexport function triage() {}\nconst b = <p>won't</p>;", 'triage', true],
  ['function triage() {}\nmodule.exports = { triage };', 'triage', true],
  ['exports.triage = () => {};', 'triage', true],
  ['module.exports.triage = () => {};', 'triage', true],
  ['module.exports = { triage() {} };', 'triage', true],
  ['const repo = { triage() {} };\nmodule.exports = repo;', 'triage', true],
  ['module.exports = { method() { function triage() {} } };', 'triage', false],
  ['function triage() {}\nmodule.exports = { otherName };', 'triage', false],
  ['// exports.triage = () => {};', 'triage', false],
  ['const text = "module.exports = { triage }";', 'triage', false],
  ['export class Repo { triage() {} }', 'triage', true],
  ['export const repo = { triage() {} };', 'triage', true],
  ['class Repo { triage() {} }', 'triage', false],
  ['const repo = { triage() {} };', 'triage', false],
  ['export class Repo { private triage() {} }', 'triage', false],
  ['export class Repo { method() { function triage() {} } }', 'triage', false],
  ['class Repo { triage() {} }\nexport { Repo as PublicRepo };', 'triage', true],
  ['export class Repo { other() {}\n triage() {} }', 'triage', true],
  ['export class Repo { static triage() {} }', 'triage', true],
  ['export const repo = { triage: () => {} };', 'triage', true],
  ['export default { triage() {} };', 'triage', true],
  ['export default class { triage() {} }', 'triage', true],
  ['const repo = { triage() {} };\nexport default repo;', 'triage', true],
  ['function triage() {}', 'triage', false],
  ["const oneLine = () => '';", 'oneLine', false],
  ['export function triage() {}', 'triage', true],
  ['export async function triage() {}', 'triage', true],
  ["export const oneLine = () => '';", 'oneLine', true],
  ['function triage() {}\nexport { triage };', 'triage', true],
  ["export { localName as triage } from './other';", 'triage', true],
  ['export { triage as publicName };', 'triage', false],
  ['export default function triage() {}', 'triage', true],
  ['const triage = () => {};\nexport default triage;', 'triage', true],
  ['// export function triage() {}', 'triage', false],
  ['const text = "export function triage() {}";', 'triage', false],
]

test('호출자: TS 와 JS 파일은 공개한 이름만 주인으로 본다', () => {
  const suffixes = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']
  OWNERS.forEach(([source, name, exported], i) => {
    const suffix = suffixes[i % suffixes.length]
    const owner = `src/repo.${suffix}`
    const repo = callerRepo({ [owner]: source, 'src/api.js': `${name}();\n` })
    const warnings = callers(repo, [{ work: `\`${name}()\``, entries: [[owner, '수정']] }])
    assert.equal(warnings.length > 0, exported, `${suffix} ${source}\n${warnings.join('\n')}`)
  })
})

test('호출자: 흔한 이름은 수정 파일이 정의해도 알리지 않는다', () => {
  const repo = callerRepo({ 'src/repo.py': 'def print(x):\n    pass\n', 'src/api.py': 'print(1)\n' })
  assert.deepEqual(callers(repo, [{ work: '### 1. `print(x, end)` 에 인자를 더한다', entries: [['src/repo.py', '수정']] }]), [])
})

test('호출자: 수정 파일이 정의하지 않은 이름은 무시한다', () => {
  const repo = callerRepo({ 'src/repo.py': 'def save(user):\n    pass\n', 'src/api.py': 'from src.repo import save\nsave(1)\n', 'src/other.py': 'x = 1\n' })
  assert.deepEqual(callers(repo, [{ work: '### 1. `print()` 로 남긴다', entries: [['src/repo.py', '수정']] }]), [])
})

test('호출자: 짧은 이름과 널리 퍼진 이름은 경고를 쏟아내지 않는다', () => {
  const files: Record<string, string> = {
    'src/repo.py': 'def save(x):\n    pass\ndef of(x):\n    pass\ndef record(x):\n    pass\ndef real_call(x):\n    pass\n',
    'src/api.py': 'from src.repo import real_call\nreal_call(1)\n',
  }
  for (let i = 0; i < 40; i++) files[`src/user${i}.py`] = 'save(1)\nrecord(2)\nof(3)\n'
  const warnings = callers(callerRepo(files), [{ work: '### 1. `save(x)`, `of(x)`, `record(x)`, `real_call(x)` 를 바꾼다', entries: [['src/repo.py', '수정']] }])
  assert.equal(warnings.length, 2, warnings.join('\n'))
  assert.ok(warnings.some((w) => w.includes('src/api.py') && w.includes('`real_call`')))
  const crowded = warnings.find((w) => w.includes('너무 흔한 이름'))!
  assert.ok(crowded.includes('`save` 40개') && crowded.includes('`record` 40개'), crowded)
  const all = warnings.join(' ')
  assert.ok(!all.includes('`of`') && !all.includes('src/user0.py'))
})

test('호출자: 호출자가 많으면 다섯 개와 나머지 수만 보인다', () => {
  const files: Record<string, string> = { 'src/repo.py': 'def triage(x):\n    pass\n' }
  for (let i = 0; i < 8; i++) files[`src/u${i}.py`] = 'triage(1)\n'
  const warnings = callers(callerRepo(files), [{ work: '### 1. `triage(x)` 를 바꾼다', entries: [['src/repo.py', '수정']] }])
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('src/u0.py, src/u1.py, src/u2.py, src/u3.py, src/u4.py 외 3개'), warnings[0])
})

// 기능 계약 연결

const feature = (spec = VALID) => {
  const repo = new Repo('plan-contract-')
  repo.file('docs/features/cancel/spec.md', spec)
  repo.file('docs/flow.md')
  return repo
}

const CANCEL_PHASE = `# Phase 1
## 목표
취소
**범위 외**: 없음
## 작업 항목
### test_cancel.py 테스트
\`\`\`python
assert True
\`\`\`
## 검증
\`\`\`bash
python3 test_cancel.py
\`\`\`
## 변경 파일
| 파일 | 변경 |
| --- | --- |
| \`test_cancel.py\` | 신규 |
`

test('기능 계약이 어긋난 계획은 성공으로 끝나지 않는다', () => {
  // audit 는 구현 전 파일 존재 검사를 건너뛴다. 기능 계획이 아닌 옛 계획은 스펙이 필요 없다
  for (const featurePlan of [false, true]) {
    const repo = feature()
    repo.file('tasks/plan1-cancel/phase-01.md', CANCEL_PHASE)
    const extra = featurePlan ? { spec: 'missing.md', requirements: ['R1'] } : {}
    repo.file('tasks/plan1-cancel/index.json', indexJson('plan1-cancel', 1, extra))
    const r = verify(repo, ['plan1-cancel', '--audit'])
    assert.equal(has(r.violations, '기능 계약 검사 실패'), featurePlan, r.stdout + r.stderr)
    if (featurePlan) assert.notEqual(r.code, 0)
  }
})

test('기능 계약 검사 실패는 check_feature 의 출력을 줄 끝에 붙인다', () => {
  const repo = feature()
  repo.file('tasks/plan1-cancel/phase-01.md', CANCEL_PHASE)
  repo.file('tasks/plan1-cancel/index.json', indexJson('plan1-cancel', 1, { spec: 'missing.md', requirements: ['R1'] }))
  const r = verify(repo, ['plan1-cancel', '--audit'])
  const line = r.violations.find((l) => l.includes('기능 계약 검사 실패'))!
  assert.ok(line.includes('plan1-cancel — 기능 계약 검사 실패: 계획의 스펙을 읽을 수 없다') || line.includes('기능 계약 검사 실패: '), line)
})

test('인수 검증 계획: 같은 검사를 돌리고 없는 계획을 막는다', () => {
  const sample = readFileSync(join(SKILL_DIR, 'templates', 'verification-plan.md'), 'utf8').replaceAll('REQ1', 'R1').replaceAll('REQ2', 'R2')
  const repo = feature()
  const dir = 'docs/features/cancel/tasks/cancel-api'
  repo.file(`${dir}/verification-plan.md`, sample)
  repo.file(
    `${dir}/phase-01.md`,
    '# Phase 1\n## 목표\n취소\n**범위 외**: 없음\n## 컨텍스트\n**근거 문서**: `docs/features/cancel/spec.md`\n\n## 작업 항목\n### `test_cancel.py` 테스트\n```python\nassert True\n```\n## 검증\n```bash\npytest test_cancel.py\n```\n## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n| `test_cancel.py` | 신규 |\n',
  )
  const data = {
    name: 'cancel-api',
    total_phases: 1,
    spec: 'docs/features/cancel/spec.md',
    requirements: ['R1', 'R2'],
    verification_plan: 'verification-plan.md',
    phases: [{ number: 1, file: 'phase-01.md', execution_profile: 'standard', requirements: ['R1', 'R2'] }],
  }
  repo.file(`${dir}/index.json`, JSON.stringify(data))
  const args = ['cancel-api', '--tasks-dir', 'docs/features/cancel/tasks', '--audit', '--require-verification']
  const ok = verify(repo, args)
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  const { verification_plan: _removed, ...without } = data
  repo.file(`${dir}/index.json`, JSON.stringify(without))
  const failed = verify(repo, args)
  assert.equal(failed.code, 1, failed.stdout)
  assert.ok(failed.stdout.includes('verification_plan'))
  assert.equal(verify(repo, args.slice(0, -1)).code, 0)
})

test('기능 계획이 아니면 --require-verification 을 적용하지 않는다고 알린다', () => {
  const repo = new Repo()
  repo.file('docs/flow.md')
  repo.file('docs/a.md')
  writePlan(repo, 'plan1-a', [oneTest()])
  const r = verify(repo, ['plan1-a', '--audit', '--require-verification'])
  assert.ok(has(r.violations, '인수 검증 계획 검사는 spec 이 있는 기능 계획에 적용한다'), r.violations.join('\n'))
})

test('기능 폴더 아래 계획은 스펙과 설계를 함께 검사한다', () => {
  const repo = feature(VALID_REQ)
  repo.file('docs/features/cancel/design.md', DESIGN)
  const dir = 'docs/features/cancel/tasks/cancel-api'
  repo.file(
    `${dir}/phase-01.md`,
    '# Phase 1\n## 목표\n취소\n**범위 외**: 없음\n## 컨텍스트\n**근거 문서**: `docs/features/cancel/spec.md`\n\n## 작업 항목\n### test_cancel.py 테스트\n```python\nassert True\n```\n## 검증\n```bash\npytest test_cancel.py\n```\n## 변경 파일\n| 파일 | 변경 |\n| --- | --- |\n| `test_cancel.py` | 신규 |\n',
  )
  const data = {
    name: 'cancel-api',
    total_phases: 1,
    spec: 'docs/features/cancel/spec.md',
    design: 'docs/features/cancel/design.md',
    requirements: ['REQ1'],
    phases: [{ number: 1, file: 'phase-01.md', execution_profile: 'standard', requirements: ['REQ1'] }],
  }
  repo.file(`${dir}/index.json`, JSON.stringify(data))
  const args = ['cancel-api', '--tasks-dir', 'docs/features/cancel/tasks', '--audit']
  const ok = verify(repo, args)
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  repo.run(['rm', join(repo.root, 'docs/features/cancel/design.md')])
  const failed = verify(repo, args)
  assert.equal(failed.code, 1, failed.stdout)
  assert.ok(failed.stdout.includes('기술 설계'))
})


test('PR 크기 추정은 저장소 등급과 미상 신규 파일을 알리고 큰 경우 경고한다', () => {
  const repo = new Repo()
  repo.file('.github/pr-size.json', JSON.stringify({ grades: { A: { core_lines: 2 }, B: { core_lines: 4 }, D: { core_lines: 6 } }, core: [], generated: [], tests: [], docs: [] }))
  repo.file('src/a.ts', 'a\n'.repeat(35))
  const warnings: string[] = []
  checkEstimatedSize('plan', new Set(['src/a.ts\0수정', 'src/new.ts\0신규']), repo.root, warnings)
  assert.match(warnings[0], /D등급.*본 코드 7줄.*미상 1개/)
  assert.doesNotMatch(warnings[0], /PR 나눔 검토/)
  const complete: string[] = []
  checkEstimatedSize('plan', new Set(['src/a.ts\0수정']), repo.root, complete)
  assert.match(complete[0], /D등급.*PR 나눔 검토/)
  const small: string[] = []
  checkEstimatedSize('plan', new Set(['src/new.ts\0신규']), repo.root, small)
  assert.match(small[0], /A등급/)
  assert.doesNotMatch(small[0], /PR 나눔 검토/)
  repo.file('.github/pr-size.json', JSON.stringify({ grades: { A: { core_lines: 2 }, B: { core_lines: 4 } } }))
  const invalid: string[] = []
  checkEstimatedSize('plan', new Set(), repo.root, invalid)
  assert.match(invalid[0], /A, B, D 기준/)
  const noConfig = new Repo()
  noConfig.file('src/a.ts', 'a\nb\n')
  const estimate: string[] = []
  checkEstimatedSize('plan', new Set(['src/a.ts\0수정']), noConfig.root, estimate)
  assert.match(estimate[0], /전체 1줄/)
  assert.doesNotMatch(estimate[0], /등급|본 코드/)
})

test('검증 테스트 경로는 추적 파일과 신규 계획을 허용하고 없는 파일을 막는다', () => {
  const repo = new Repo('test-ref-', true)
  repo.file('svc/src/test/FooTest.java', '')
  repo.git('add', 'svc/src/test/FooTest.java')
  repo.file('tests/existing.test.ts', '')
  repo.git('add', 'tests/existing.test.ts')
  const out: string[] = []
  checkTestReferences('phase', '`tests/existing.test.ts` `src/test/FooTest.java` `tests/new.test.ts` `tests/missing.test.ts` tests/fixtures/data.json tests/other.pyc tests/a.shx tests/a.javascript', [['tests/new.test.ts', '신규']], repo.root, out)
  assert.equal(out.length, 1)
  assert.match(out[0], /tests\/missing.test.ts/)
})


test('계획 검사는 phase 와 별도 인수 검증의 경로를 확인하고 옛 계획은 경고한다', () => {
  const repo = new Repo('plan-test-refs-', true)
  repo.file('docs/flow.md')
  repo.file('svc/src/test/FooTest.java')
  repo.git('add', 'svc/src/test/FooTest.java')
  const phase = { work: '### 1. 문서', command: 'pytest src/test/FooTest.java tests/missing.test.ts', entries: [['docs/a.md', '수정'], ['tests/new.test.ts', '신규'], ['tests/absent.test.ts', '수정']] as Entry[] }
  repo.file('docs/a.md', 'hello\n')
  const dir = writePlan(repo, 'plan1-x', [phase], { index: { created_at: '2026-11-13', verification_plan: 'verification.md' } })
  repo.file(`${dir}/verification.md`, '## 인수 검증 계획\n| `tests/new.test.ts` | `tests/absent.test.ts` |\n')
  const result = verify(repo, ['plan1-x', '--audit'])
  assert.ok(result.violations.some((x) => x.includes('tests/missing.test.ts')), result.stdout)
  assert.ok(result.violations.some((x) => x.includes('tests/absent.test.ts')), result.stdout)
  assert.ok(!result.violations.some((x) => x.includes('FooTest.java') || x.includes('tests/new.test.ts')), result.stdout)
  assert.ok(!result.warnings.some((x) => x.includes('PR 크기 추정')), result.stdout)
  const old = writePlan(repo, 'plan1-x', [phase], { index: { created_at: '2026-10-24', verification_plan: 'verification.md' } })
  repo.file(`${old}/verification.md`, '## 인수 검증 계획\n| `tests/absent.test.ts` |\n')
  const legacy = verify(repo, ['plan1-x', '--audit'])
  assert.ok(legacy.warnings.some((x) => x.includes('tests/absent.test.ts')), legacy.stdout)
  assert.ok(!legacy.violations.some((x) => x.includes('검증에 적은 테스트 파일')), legacy.stdout)
  const before = verify(repo, ['plan1-x'])
  assert.ok(before.warnings.some((x) => x.includes('PR 크기 추정')), before.stdout)
})
