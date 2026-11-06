// implementation 의 pr_mergeable 명령 경계 테스트. 가짜 gh 가 호출 순서대로 답한다. GitHub 에는 닿지 않는다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['node', join(import.meta.dirname, '..', 'scripts', 'pr_mergeable.ts')]
// ──

const roots: string[] = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

// answers 를 호출 순서대로 내고 마지막 값은 반복한다. exit 이 0 이 아니면 늘 그 코드로 끝난다
function run(answers: string[], args: string[] = [], exit = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pr-mergeable-')))
  roots.push(dir)
  const gh = join(dir, 'gh')
  const state = join(dir, 'count')
  writeFileSync(state, '0')
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst fs = require('node:fs')\nconst n = Number(fs.readFileSync(${JSON.stringify(state)}, 'utf8'))\nfs.writeFileSync(${JSON.stringify(state)}, String(n + 1))\nfs.appendFileSync(${JSON.stringify(join(dir, 'argv'))}, process.argv.slice(2).join(' ') + '\\n')\nif (${exit}) process.exit(${exit})\nconst answers = ${JSON.stringify(answers)}\nconsole.log(answers[Math.min(n, answers.length - 1)])\n`,
  )
  chmodSync(gh, 0o755)
  const done = spawnSync(COMMAND[0], [...COMMAND.slice(1), '12', '--interval', '0', ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr, calls: Number(readFileSync(state, 'utf8')), argv: readFileSync(join(dir, 'argv'), 'utf8').split('\n').filter(Boolean) }
}

const CLEAN = 'mergeable=MERGEABLE mergeStateStatus=CLEAN'
const UNKNOWN = 'mergeable=UNKNOWN mergeStateStatus=UNKNOWN'
const CONFLICT = 'mergeable=CONFLICTING mergeStateStatus=DIRTY'

describe('pr_mergeable', () => {
  test('충돌이 없으면 0 이고 한 줄을 낸다', () => {
    const done = run([CLEAN])
    assert.deepEqual([done.code, done.stdout, done.calls], [0, `${CLEAN}\n`, 1])
    assert.deepEqual(done.argv, ['pr view 12 --json mergeable,mergeStateStatus --jq "mergeable=\\(.mergeable) mergeStateStatus=\\(.mergeStateStatus)"'])
  })

  test('보호 규칙의 BLOCKED 는 충돌이 아니다', () => {
    assert.equal(run(['mergeable=MERGEABLE mergeStateStatus=BLOCKED']).code, 0)
  })

  test('충돌이면 1 과 stderr 안내', () => {
    const done = run([CONFLICT])
    assert.deepEqual([done.code, done.stdout], [1, `${CONFLICT}\n`])
    assert.equal(done.stderr, 'pr_mergeable: 기준 브랜치와 충돌한다. 기준 브랜치를 병합해 풀고 일반 push 로 올린다\n')
  })

  test('mergeStateStatus 가 DIRTY 이기만 해도 충돌이다', () => {
    assert.equal(run(['mergeable=UNKNOWN mergeStateStatus=DIRTY']).code, 1)
  })

  test('UNKNOWN 이면 다시 묻는다', () => {
    const done = run([UNKNOWN, CONFLICT])
    assert.deepEqual([done.code, done.calls], [1, 2])
  })

  test('횟수를 다 써도 UNKNOWN 이면 2', () => {
    const done = run([UNKNOWN], ['--tries', '3'])
    assert.deepEqual([done.code, done.calls, done.stdout], [2, 3, `${UNKNOWN}\n`])
    assert.equal(done.stderr, 'pr_mergeable: 3 번 물어도 값이 정해지지 않았다\n')
  })

  test('기본 횟수는 10', () => {
    assert.equal(run([UNKNOWN]).calls, 10)
  })

  test('--interval 은 소수도 받는다', () => {
    const done = run([UNKNOWN, CLEAN], ['--interval', '.01'])
    assert.deepEqual([done.code, done.calls], [0, 2])
  })

  test('gh 가 실패하면 2', () => {
    const done = run(['x'], [], 1)
    assert.deepEqual([done.code, done.stdout, done.stderr], [2, '', 'pr_mergeable: gh pr view 가 실패했다\n'])
  })

  test('옵션 오류와 PR 번호 없음은 2', () => {
    const spawn = (args: string[]) => spawnSync(COMMAND[0], [...COMMAND.slice(1), ...args], { encoding: 'utf8' })
    const unknown = spawn(['12', '--nope'])
    assert.deepEqual([unknown.status, unknown.stderr], [2, 'pr_mergeable: 다루지 않는 옵션이다: --nope\n'])
    const missing = spawn([])
    assert.deepEqual([missing.status, missing.stderr], [2, 'pr_mergeable: PR 번호가 필요하다\n'])
  })
})
