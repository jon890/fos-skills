// overlay_paths 의 명령 경계 테스트. references/monorepo.md 의 판정 순서를 임시 저장소에서 JSON 출력으로 본다.

import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { OVERLAY, Repo, run, type Result } from './helpers.ts'

const LAYOUT = (sub: string, prefix: string) => `## 저장소 배치\n\n| 값 | 값 |\n| --- | --- |\n| docs 경로 | \`${sub}/docs/\` |\n| plan 접두사 | \`${prefix}\` |\n`

type Output = { monorepo: boolean; subprojects: string[]; targets: string[]; reason: string | null; search: Record<string, string[]> }

function repo(): Repo {
  const r = new Repo('plan-overlay-', true)
  r.file('.claude/review-fix-overlay.md', '루트')
  r.file('CLAUDE.md', '지침')
  return r
}

function monorepo(r: Repo): void {
  r.file('frontend/.claude/plan-overlay.md', LAYOUT('frontend', 'fe-'))
  r.file('frontend/.claude/review-fix-overlay.md', '프론트')
  r.file('backend/.claude/plan-overlay.md', LAYOUT('backend', 'be-'))
  r.file('backend/CLAUDE.md', '백엔드 지침')
}

function main(r: Repo, args: string[], opts: { skill?: string; cwd?: string; input?: string } = {}): { code: number | null; out: Output | null; result: Result } {
  const result = r.run(OVERLAY, ['--skill', opts.skill ?? 'review-fix', ...args], { input: opts.input ?? '' })
  return { code: result.code, out: result.stdout ? (JSON.parse(result.stdout) as Output) : null, result }
}

const existing = (paths: string[]) => paths.filter((p) => !p.startsWith('(없음)'))

test('이름이 바뀐 스킬은 같은 범위의 옛 오버레이 값을 읽는다', () => {
  for (const [name, old] of [['plan', 'planning'], ['implementation', 'build-with-teams']]) {
    const r = repo()
    r.file(`.claude/${name}-overlay.md`, 'new root')
    r.file(`backend/.claude/${old}-overlay.md`, 'old local')
    let paths = main(r, ['--sub', 'backend'], { skill: name }).out!.search.backend
    assert.ok(paths.indexOf(`backend/.claude/${old}-overlay.md`) < paths.indexOf(`.claude/${name}-overlay.md`), name)
    r.file(`backend/.claude/${name}-overlay.md`, 'new local')
    paths = main(r, ['--sub', 'backend'], { skill: name }).out!.search.backend
    assert.ok(paths.indexOf(`backend/.claude/${name}-overlay.md`) < paths.indexOf(`backend/.claude/${old}-overlay.md`), name)
  }
})

test('docs-audit 오버레이 이름 대체 규칙은 경우마다 한 번만 경고한다', () => {
  for (const scope of [null, 'backend']) {
    for (const [current, legacy] of [[true, false], [false, true], [true, true], [false, false]]) {
      const r = repo()
      const directory = scope ? `${scope}/.claude` : '.claude'
      const fresh = `${directory}/docs-audit-overlay.md`
      const old = `${directory}/docs-check-overlay.md`
      if (scope) r.file('backend/.claude/plan-overlay.md', LAYOUT('backend', 'be-'))
      if (current) r.file(fresh, '설정')
      if (legacy) r.file(old, '설정')
      const { code, out, result } = main(r, scope ? ['--sub', scope] : [], { skill: 'docs-audit' })
      assert.equal(code, 0)
      const paths = out!.search[scope ?? '.']
      const here = existing(paths)
      const label = JSON.stringify({ scope, current, legacy })
      assert.equal(here.includes(fresh), current, label)
      assert.equal(here.includes(old), legacy && !current, label)
      assert.equal(Boolean(result.stderr), legacy && !current, label)
      if (legacy && !current) {
        assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, label)
        assert.ok(result.stderr.includes(old), label)
      }
      if (current) assert.ok(!paths.includes(old), label)
    }
  }
})

test('docs-consolidate 는 자기 오버레이가 없을 때만 docs-audit 대체 규칙을 쓴다', () => {
  const cases: [boolean, boolean, boolean][] = [[false, false, true], [false, true, true], [true, false, true], [true, true, true], [false, false, false]]
  for (const [own, current, legacy] of cases) {
    const r = repo()
    for (const [name, exists] of [['docs-consolidate', own], ['docs-audit', current], ['docs-check', legacy]] as const) {
      const rel = `.claude/${name}-overlay.md`
      if (exists) r.file(rel, '설정')
      else rmSync(join(r.root, rel), { force: true })
    }
    const { code, out, result } = main(r, [], { skill: 'docs-consolidate' })
    assert.equal(code, 0)
    const here = existing(out!.search['.'])
    const label = JSON.stringify({ own, current, legacy })
    assert.equal(here.includes('.claude/docs-consolidate-overlay.md'), own, label)
    assert.equal(here.includes('.claude/docs-audit-overlay.md'), current && !own, label)
    assert.equal(here.includes('.claude/docs-check-overlay.md'), legacy && !current && !own, label)
    assert.equal(Boolean(result.stderr), legacy && !current && !own, label)
  }
})

test('docs-audit 는 JSON 을 stdout 에, 경고를 stderr 에 낸다', () => {
  const r = repo()
  r.file('.claude/docs-check-overlay.md', '설정')
  const { code, out, result } = main(r, [], { skill: 'docs-audit' })
  assert.equal(code, 0)
  assert.ok(out!.search['.'].includes('.claude/docs-check-overlay.md'))
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1)
  assert.ok(result.stderr.includes('docs-audit-overlay.md'))
  assert.ok(result.stderr.includes('docs-audit 스킬 5.0.0'))
})

test('대상이 여럿이어도 옛 오버레이는 한 번만 경고한다', () => {
  for (const skill of ['docs-audit', 'docs-consolidate']) {
    const r = repo()
    monorepo(r)
    r.file('.claude/docs-check-overlay.md', '공통')
    const { code, out, result } = main(r, ['frontend/src/a.py', 'backend/src/b.py'], { skill })
    assert.equal(code, 0, skill)
    for (const target of ['frontend', 'backend']) assert.ok(out!.search[target].includes('.claude/docs-check-overlay.md'), `${skill} ${target}`)
    assert.equal(result.stderr.split('\n').filter(Boolean).length, 1, skill)
    assert.ok(result.stderr.includes('.claude/docs-check-overlay.md'), skill)
  }
})

test('옛 이름의 하위 프로젝트 오버레이가 새 이름의 루트 오버레이보다 앞선다', () => {
  const r = repo()
  r.file('.claude/docs-audit-overlay.md', '루트')
  r.file('backend/.claude/docs-check-overlay.md', '하위')
  const { out, result } = main(r, ['--sub', 'backend'], { skill: 'docs-audit' })
  const paths = out!.search.backend
  assert.ok(paths.indexOf('backend/.claude/docs-check-overlay.md') < paths.indexOf('.claude/docs-audit-overlay.md'))
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1)
})

test('단일 저장소는 이전 순서를 지킨다', () => {
  const { code, out } = main(repo(), ['src/app.ts'])
  assert.equal(code, 0)
  assert.equal(out!.monorepo, false)
  assert.deepEqual(out!.search['.'].slice(0, 2), ['.claude/review-fix-overlay.md', 'CLAUDE.md'])
})

test('경로가 한 하위 프로젝트에 있으면 그것이 대상이다', () => {
  const r = repo()
  monorepo(r)
  const { code, out } = main(r, ['frontend/src/app.ts', 'frontend/docs/flow.md'])
  assert.deepEqual([code, out!.targets, out!.reason], [0, ['frontend'], 'paths'])
  assert.deepEqual(out!.search.frontend.slice(0, 3), ['frontend/.claude/review-fix-overlay.md', '.claude/review-fix-overlay.md', 'CLAUDE.md'])
})

test('하위 프로젝트의 지침 파일은 루트 지침보다 앞선다', () => {
  const r = repo()
  monorepo(r)
  const { out } = main(r, ['backend/src/App.java'])
  assert.deepEqual(out!.search.backend.slice(0, 3), ['.claude/review-fix-overlay.md', 'backend/CLAUDE.md', 'CLAUDE.md'])
})

test('경로가 여러 하위 프로젝트에 걸치면 둘 다 낸다', () => {
  const r = repo()
  monorepo(r)
  const { code, out } = main(r, ['-'], { input: 'frontend/a.ts\nbackend/B.java\n' })
  assert.deepEqual([code, out!.targets], [0, ['backend', 'frontend']])
})

test('루트 경로가 섞이면 정하지 못해 1 로 끝난다', () => {
  const r = repo()
  monorepo(r)
  const { code, out } = main(r, ['frontend/a.ts', 'README.md'])
  assert.deepEqual([code, out!.targets], [1, []])
})

test('plan 접두사가 하위 프로젝트를 고른다', () => {
  const r = repo()
  monorepo(r)
  const { code, out } = main(r, ['--plan', 'be-plan027-login'])
  assert.deepEqual([code, out!.targets, out!.reason], [0, ['backend'], 'plan'])
})

test('접두사 없는 plan 은 접두사 있는 하위 프로젝트와 맞지 않는다', () => {
  const r = repo()
  monorepo(r)
  assert.equal(main(r, ['--plan', 'plan027-login']).code, 1)
})

test('사용자가 고른 하위 프로젝트가 이기고 있어야 한다', () => {
  const r = repo()
  monorepo(r)
  const picked = main(r, ['--sub', 'backend', 'frontend/a.ts'])
  assert.deepEqual([picked.code, picked.out!.targets, picked.out!.reason], [0, ['backend'], 'user'])
  assert.equal(main(r, ['--sub', 'infra']).code, 2)
})

test('cwd 가 하위 프로젝트 안이면 그것이 대상이다', () => {
  const r = repo()
  monorepo(r)
  assert.equal(r.run(OVERLAY, ['--skill', 'review-fix']).code, 1, '루트에서는 정하지 못한다')
  const done = run(OVERLAY, { cwd: join(r.root, 'frontend'), args: ['--skill', 'review-fix'] })
  const out = JSON.parse(done.stdout) as Output
  assert.deepEqual([done.code, out.targets, out.reason], [0, ['frontend'], 'cwd'])
})

test('오버레이가 없는 디렉터리는 하위 프로젝트가 아니다', () => {
  const r = repo()
  r.file('scripts/.claude/settings.json', '{}')
  const { code, out } = main(r, ['scripts/x.sh'])
  assert.deepEqual([code, out!.monorepo], [0, false])
})

test('옵션: 고유 접두와 사용법 오류', () => {
  const r = repo()
  monorepo(r)
  const picked = r.run(OVERLAY, ['--skill', 'review-fix', '--su', 'backend'])
  assert.equal(picked.code, 0)
  assert.equal((JSON.parse(picked.stdout) as Output).reason, 'user')
  assert.equal(r.run(OVERLAY, []).code, 2)
  assert.equal(r.run(OVERLAY, ['--skill']).code, 2)
  assert.equal(r.run(OVERLAY, ['--skill', 'review-fix', '--nope']).code, 2)
  assert.equal(r.run(OVERLAY, ['--help']).code, 0)
})

test('git 저장소 밖에서는 실행하지 못해 2 로 끝난다', () => {
  const outside = new Repo('plan-overlay-outside-')
  const done = outside.run(OVERLAY, ['--skill', 'review-fix'])
  assert.equal(done.code, 2)
  assert.equal(done.stdout, '')
})
