import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { branchRefs, judgeLastPr, taskNumberOf } from '../scripts/lib/last-pr.ts'
import { GIT_ISOLATION } from '../../../modules/testkit/git.ts'

function git(repo: string, ...args: string[]): string {
  const done = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ISOLATION, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  assert.equal(done.status, 0, done.stderr)
  return done.stdout.trim()
}

test('현재 PR 뒤 로컬 커밋과 같은 브랜치의 후속 PR 지시서는 마지막 PR 로 보지 않는다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'last-pr-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'base'), 'base\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
  const head = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/main', head)
  git(repo, 'checkout', '-q', '-b', 'work')
  writeFileSync(join(repo, 'local'), 'later\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'local after PR')
  const specDir = join(repo, '.orch', 'specs'); mkdirSync(specDir, { recursive: true })
  writeFileSync(join(specDir, 'spec-next.md'), '업무: PROJ-1\n브랜치: `work`\n다음 PR 에서 남은 구현을 한다.\n')
  const fake = join(repo, 'gh')
  writeFileSync(fake, '#!/bin/sh\nprintf \'[]\\n\'\n'); chmodSync(fake, 0o755)
  const oldGh = process.env.GH, oldCache = process.env.ORCH_GH_CACHE
  process.env.GH = fake; process.env.ORCH_GH_CACHE = '0'
  try {
    const verdict = judgeLastPr(repo, { number: '10', title: 'PROJ-1 변경', branch: 'work', head }, {
      taskPattern: /(PROJ-\d+)/, specTaskPattern: /(PROJ-\d+)/, specsDir: specDir,
    })
    assert.equal(verdict.last, false)
    assert.match(verdict.reason, /로컬 브랜치에 PR 뒤 커밋 1 개/)
    assert.ok(verdict.specs.includes('spec-next.md'))
  } finally {
    if (oldGh === undefined) delete process.env.GH; else process.env.GH = oldGh
    if (oldCache === undefined) delete process.env.ORCH_GH_CACHE; else process.env.ORCH_GH_CACHE = oldCache
  }
})

test('PR 제목에 업무 번호가 없으면 브랜치 이름, 그다음 보드 task-ref 에서 찾는다', () => {
  const pattern = /^#AI-프로젝트\/([0-9]+)/
  const pr = (title: string, branch: string, taskRef: string | null = null) => ({ number: '1', title, branch, taskRef })
  assert.deepEqual(taskNumberOf(pr('#AI-프로젝트/12 고침', 'feature/AI-프로젝트/587-x'), pattern), { number: '12', from: 'title' })
  assert.deepEqual(taskNumberOf(pr('(SHIP) 문구 정리', 'feature/AI-프로젝트/587-wording'), pattern), { number: '587', from: 'branch' })
  assert.deepEqual(taskNumberOf(pr('(SHIP) 문구 정리', 'fix/retired-wording', 'AI-프로젝트/590'), pattern), { number: '590', from: 'task-ref' })
  assert.equal(taskNumberOf(pr('(SHIP) 문구 정리', 'fix/retired-wording'), pattern), null)
  // 다른 말머리의 번호는 맞추지 않는다
  assert.equal(taskNumberOf(pr('(SHIP)', 'feature/OTHER/587-x'), pattern), null)
  // 번호만 담는 규칙은 브랜치의 번호 조각으로도 맞는다
  assert.deepEqual(taskNumberOf(pr('정리', 'feat/PROJ-1-x'), /(PROJ-\d+)/), null)
  assert.deepEqual(taskNumberOf(pr('정리', 'feat/1234-x'), /^#?(\d+)/), { number: '1234', from: 'branch' })
  assert.deepEqual(branchRefs('feature/AI-프로젝트/587-x'), ['AI-프로젝트/587', '587'])
})

test('제목에 업무 번호가 없어도 브랜치 이름으로 마지막 PR 을 판정한다', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'last-pr-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const fake = join(repo, 'gh')
  writeFileSync(fake, '#!/bin/sh\nprintf \'[]\\n\'\n'); chmodSync(fake, 0o755)
  const oldGh = process.env.GH, oldCache = process.env.ORCH_GH_CACHE
  process.env.GH = fake; process.env.ORCH_GH_CACHE = '0'
  try {
    const verdict = judgeLastPr(repo, { number: '2198', title: '(SHIP) 어드민 문구 정리', branch: 'feature/AI-프로젝트/587-wording' }, {
      taskPattern: /^#AI-프로젝트\/([0-9]+)/, specTaskPattern: null, specsDir: null,
    })
    assert.equal(verdict.last, true)
    assert.equal(verdict.number, '587')
    assert.match(verdict.reason, /업무 587\(브랜치 이름에서 찾음\)/)
  } finally {
    if (oldGh === undefined) delete process.env.GH; else process.env.GH = oldGh
    if (oldCache === undefined) delete process.env.ORCH_GH_CACHE; else process.env.ORCH_GH_CACHE = oldCache
  }
})
