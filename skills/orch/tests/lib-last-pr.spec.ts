import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { judgeLastPr } from '../scripts/lib/last-pr.ts'

function git(repo: string, ...args: string[]): string {
  const done = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
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
