// 스킬 문서가 `$SKILL_DIR/scripts/<이름>` 과 상대 링크, 새 꼴 `orch <묶음> <동작>` 으로 부르는 스크립트가 모두 있는지 본다.
// 문서가 orch 스크립트를 옛 진입점이나 파일 경로로 부르지 않는지도 본다(docs/features/orch-cli/spec.md 의 REQ8).
//
// 문서만 고치고 스크립트를 빠뜨리거나 이름을 바꾸면, 설치한 쪽은 그 단계에서 「파일이 없다」 로 멈춘다.
// 판정은 `skills/orch/scripts/doctor/orch-doctor.ts --skip-version` 이 소유한다. 이 테스트는 스킬마다 그것을 부른다.

import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const DOCTOR = join(ROOT, 'skills/orch/scripts/doctor/orch-doctor.ts')
// 정규식의 \\b 는 Python 처럼 한글도 글자로 보게 \\p{L}, \\p{N} 으로 쓴다
const ORCH_SCRIPTS = join(ROOT, 'skills/orch/scripts')
// 기록이라 옛 꼴이 남는 곳. 기능 문서, 변경 이력, ADR
const SKIP = ['docs/features/orch-cli/', 'skills/orch/CHANGELOG.md', 'docs/adr/']

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('문서가 부르는 스크립트', () => {
  const skills = [...globSync('skills/*/SKILL.md', { cwd: ROOT }), ...globSync('export-only-skills/*/SKILL.md', { cwd: ROOT })].map((p) => dirname(p)).sort()

  test('스킬이 있다', () => assert.ok(skills.length > 0))

  for (const skill of skills) {
    test(`${skill} 의 문서가 부르는 스크립트가 있다`, () => {
      const done = runCommand([process.execPath, '--disable-warning=ExperimentalWarning', DOCTOR, '--skip-version', '--skill-dir', join(ROOT, skill)])
      assert.equal(done.code, 0, done.stdout + done.stderr)
    })
  }

  test('문서는 orch 를 새 꼴로 부른다', () => {
    // 진입 스크립트는 묶음 폴더(scripts/<묶음>/) 아래에 있다. lib, handlers 는 진입 스크립트가 아니다
    const entries = new Set(
      globSync('*/*.ts', { cwd: ORCH_SCRIPTS })
        .filter((p) => !['lib', 'handlers'].includes(dirname(p)))
        .map((p) => p.split('/').pop()!.replace(/\.ts$/, '')),
    )
    assert.ok(entries.has('merge_queue'))
    for (const p of globSync('*.py', { cwd: ORCH_SCRIPTS })) entries.add(p.replace(/\.py$/, ''))
    const joined = [...entries].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
    const old = new RegExp(`"\\$SKILL_DIR/bin/orch\\.ts"\\s+[a-z_-]+|(?:\\$SKILL_DIR|\\$\\{?ORCH_SCRIPTS\\}?)/(?:scripts/)?(?:[a-z]+/)?(?:${joined})\\.(?:ts|py)(?![\\p{L}\\p{N}_])`, 'u')
    // 요청문은 Markdown 이 아니라 경로 꼴이 다르다(코디네이터에게 보내는 글)
    const prompt = new RegExp(`skills/orch/scripts/(?:[a-z]+/)?(?:${joined})\\.ts|(?<![\\p{L}\\p{N}_])(?:${joined})\\.ts 답장`, 'u')
    const files = ['README.md', ...['skills', 'export-only-skills', 'docs', 'extensions'].flatMap((top) => globSync(`${top}/**/*.md`, { cwd: ROOT }))]
    const found: string[] = []
    for (const rel of files) {
      if (SKIP.some((skip) => rel.startsWith(skip)) || rel.includes('/tests/')) continue
      const rows = readFileSync(join(ROOT, rel), 'utf8').split('\n')
      rows.forEach((row, i) => {
        if (row.includes('orch-compat') || (i > 0 && rows[i - 1].includes('orch-compat'))) return
        if (old.test(row)) found.push(`${rel}:${i + 1}: ${row.trim().slice(0, 120)}`)
      })
    }
    const register = 'extensions/work-board/hooks/register.js'
    readFileSync(join(ROOT, register), 'utf8')
      .split('\n')
      .forEach((row, i) => {
        if (row.trimStart().startsWith("'") && prompt.test(row)) found.push(`${register}:${i + 1}: ${row.trim().slice(0, 120)}`)
      })
    assert.deepEqual(found, [], 'orch 는 `orch <묶음> <동작>` 으로 부른다. 호환 설명이면 그 줄이나 윗줄에 orch-compat 를 둔다')
  })
})
