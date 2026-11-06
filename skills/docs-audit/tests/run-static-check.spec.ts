// docs-audit 의 run_static_check 명령 경계 테스트. static_check 의 종료 코드를 판정 낱말과 표로 옮기는지 본다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['python3', join(import.meta.dirname, '..', 'scripts', 'run_static_check.py')]
// ──

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function run(files: Record<string, string>, args: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-static-check-')))
  roots.push(root)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  spawnSync('git', ['init', '-q'], { cwd: root, env })
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  const done = spawnSync(COMMAND[0], [...COMMAND.slice(1), ...args], { cwd: root, env, encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

const TABLE = '| 검사 | 종료 코드 | 판정 | 출력 줄 수 |\n| --- | --- | --- | --- |\n'

describe('run_static_check', () => {
  test('위반이 없으면 통과', () => {
    const done = run({ 'docs/a.md': '# 제목\n' }, ['', 'docs'])
    assert.deepEqual([done.code, done.stdout, done.stderr], [0, `${TABLE}| static_check | 0 | 통과 | 0 |\n\n(표준 출력 없음)\n\n표준 오류:\n검사한 Markdown: 1개 (scope: docs)\n`, ''])
  })

  test('위반은 발견이고 종료 코드 1', () => {
    const done = run({ 'docs/a.md': '# 제목\n\n### 건너뜀\n' }, ['', 'docs'])
    assert.deepEqual([done.code, done.stdout], [1, `${TABLE}| static_check | 1 | 발견 | 1 |\n\ndocs/a.md:3: 헤딩 레벨 건너뜀 (h1 → h3)\n\n표준 오류:\n검사한 Markdown: 1개 (scope: docs)\n`])
  })

  test('경고만 있으면 0 이고 경고 줄 수를 낸다', () => {
    const done = run({ 'docs/code-architecture.md': '# 구조\n\n```text\ncore/   도메인 (A, B, C)\n```\n' }, ['', 'docs'])
    assert.equal(done.code, 0, done.stdout + done.stderr)
    assert.ok(done.stdout.startsWith(`${TABLE}| static_check | 0 | 통과 (경고 1줄) | 1 |\n\n`))
  })

  test('Markdown 이 없으면 실행 실패와 종료 코드 2', () => {
    const done = run({ 'code.py': 'x = 1\n' })
    assert.equal(done.code, 2)
    assert.ok(done.stdout.startsWith(`${TABLE}| static_check | 2 | 실행 실패 | 0 |\n\n(표준 출력 없음)\n\n표준 오류:\n`))
    assert.match(done.stdout, /검사 오류: 범위 안에서 Markdown 파일을 찾지 못했다\./)
  })

  test('없는 범위는 실행 실패와 2', () => {
    const done = run({ 'a.md': '# 제목\n' }, ['', '없는경로'])
    assert.equal(done.code, 2)
    assert.match(done.stdout, /\| static_check \| 2 \| 실행 실패 \| 0 \|/)
  })
})
