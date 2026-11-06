// run_doc_checks 의 명령 경계 테스트. 레포 설정의 「문서 검사 명령」 을 찾아 저장소 루트에서 실행하는지 임시 저장소에서 본다.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DOC_CHECKS, Repo } from './helpers.ts'

function repo(): Repo {
  return new Repo('plan-doc-checks-', true)
}

function overlay(r: Repo, rel: string, command: string): void {
  r.file(rel, `# 레포 설정\n\n## 저장소 검사\n\n| 값 | 값 |\n| --- | --- |\n| 문서 검사 명령 | ${command} |\n`)
}

const ran = (r: Repo, name: string) => existsSync(join(r.root, name))

test('명령이 없으면 통과하고 그렇다고 알린다', () => {
  const r = repo()
  r.file('.claude/spec-overlay.md', '# spec 레포 설정\n')
  const done = r.run(DOC_CHECKS, ['--skill', 'spec', 'docs/features/a/spec.md'])
  assert.equal(done.code, 0)
  assert.ok(done.stdout.includes('「문서 검사 명령」 이 레포 설정에 없다'), done.stdout)
  assert.equal(done.stdout, '「문서 검사 명령」 이 레포 설정에 없다. 저장소 문서 검사를 건너뛴다\n')
})

test('인라인 코드 하나가 명령 하나이고 저장소 루트에서 실행한다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`touch ran-1` 과 `touch ran-2`')
  const done = r.run(DOC_CHECKS, ['--skill', 'spec', 'docs/features/a/spec.md'])
  assert.equal(done.code, 0, done.stdout)
  assert.ok(ran(r, 'ran-1') && ran(r, 'ran-2'))
  assert.ok(done.stdout.includes('출처: .claude/spec-overlay.md'), done.stdout)
  assert.equal(
    done.stdout,
    '실행: touch ran-1 (출처: .claude/spec-overlay.md)\n통과: touch ran-1\n실행: touch ran-2 (출처: .claude/spec-overlay.md)\n통과: touch ran-2\n문서 검사 2개 중 실패 0개\n',
  )
})

test('인라인 코드가 없으면 칸 전체가 명령 하나다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', 'touch whole')
  assert.equal(r.run(DOC_CHECKS, ['--skill', 'spec']).code, 0)
  assert.ok(ran(r, 'whole'))
})

test('실패한 명령이 있으면 1 로 끝나고 종료 코드를 알린다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`exit 3`')
  const done = r.run(DOC_CHECKS, ['--skill', 'spec'])
  assert.equal(done.code, 1)
  assert.ok(done.stdout.includes('실패(종료 코드 3): exit 3'), done.stdout)
  assert.ok(done.stdout.endsWith('문서 검사 1개 중 실패 1개\n'), done.stdout)
})

test('같은 명령은 한 번만 실행한다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`echo same >> count` 과 `echo same >> count`')
  assert.equal(r.run(DOC_CHECKS, ['--skill', 'spec']).code, 0)
  assert.equal(r.run(['cat', join(r.root, 'count')]).stdout, 'same\n')
})

test('technical-design 은 자기 오버레이가 없으면 spec 오버레이를 읽는다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`touch from-spec`')
  assert.equal(r.run(DOC_CHECKS, ['--skill', 'technical-design', 'docs/features/a/spec.md']).code, 0)
  assert.ok(ran(r, 'from-spec'))
  overlay(r, '.claude/technical-design-overlay.md', '`touch from-design`')
  assert.equal(r.run(DOC_CHECKS, ['--skill', 'technical-design']).code, 0)
  assert.ok(ran(r, 'from-design'))
})

test('하위 프로젝트 오버레이는 문서 경로로 고른다', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`touch root`')
  overlay(r, 'web/.claude/spec-overlay.md', '`touch web`')
  const web = r.run(DOC_CHECKS, ['--skill', 'spec', 'web/docs/features/a/spec.md'])
  assert.ok(web.stdout.startsWith('실행: touch web (출처: web/.claude/spec-overlay.md)\n'), web.stdout)
  assert.ok(!ran(r, 'root') && ran(r, 'web'))
  const root = r.run(DOC_CHECKS, ['--skill', 'spec', 'docs/features/a/spec.md'])
  assert.ok(root.stdout.startsWith('실행: touch root (출처: .claude/spec-overlay.md)\n'), root.stdout)
})

test('옵션: 고유 접두와 사용법 오류', () => {
  const r = repo()
  overlay(r, '.claude/spec-overlay.md', '`touch abbreviated`')
  assert.equal(r.run(DOC_CHECKS, ['--sk', 'spec']).code, 0)
  assert.ok(ran(r, 'abbreviated'))
  assert.equal(r.run(DOC_CHECKS, []).code, 2)
  assert.equal(r.run(DOC_CHECKS, ['--skill', 'orch']).code, 2)
  assert.equal(r.run(DOC_CHECKS, ['--skill']).code, 2)
  assert.equal(r.run(DOC_CHECKS, ['docs/a.md', '--skill', 'spec', 'docs/b.md']).code, 2)
  assert.equal(r.run(DOC_CHECKS, ['--help']).code, 0)
})

test('저장소 밖에서는 실행하지 못해 2 로 끝난다', () => {
  const outside = new Repo('plan-doc-checks-outside-')
  assert.equal(outside.run(DOC_CHECKS, ['--skill', 'spec']).code, 2)
})
