// worker 워크트리 훅(lib/commit-check.ts 가 거는 githooks/dispatch.mjs)의 비공개 낱말 검사를 임시 저장소의 실제 git commit 으로 본다.
// 스펙은 docs/features/private-leak-guard/spec.md 의 REQ1~REQ3, REQ5, REQ6 이다.
// 가상 낱말만 쓴다. 홈, 머신 폴더, gh 는 모두 가짜다. 한국어 검사가 끼지 않게 .txt 파일만 커밋한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { installCommitCheck } from '../scripts/lib/commit-check.ts'
import { GIT_ISOLATION } from '../../../modules/testkit/git.ts'

const WORD = 'example-secret'
let tmp = ''
let wt = ''
let home = ''
let calls = ''
let env: NodeJS.ProcessEnv = {}

function g(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...env, ...extra } })
}

function commit(name: string, text: string, message = 'work', extra: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(wt, name), text)
  assert.equal(g(wt, ['add', '--', name]).status, 0)
  return g(wt, ['commit', '-q', '-m', message], extra)
}

function setWords(text: string | null): void {
  const file = join(home, '.config', 'orch', 'private-words.txt')
  if (text === null) rmSync(file, { force: true })
  else writeFileSync(file, text)
}

function ghCalls(): number {
  return existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'private-hook-'))
  home = join(tmp, 'home')
  mkdirSync(join(home, '.config', 'orch'), { recursive: true })
  calls = join(tmp, 'gh-calls.txt')
  const gh = join(tmp, 'gh')
  // FAKE_VIS 가 fail 이면 조회 실패, 아니면 그 값을 visibility 로 낸다
  writeFileSync(gh, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')\nconst v = process.env.FAKE_VIS || 'PUBLIC'\nif (v === 'fail') process.exit(1)\nprocess.stdout.write(v + '\\n')\n`)
  chmodSync(gh, 0o755)
  env = {
    ...process.env,
    HOME: home,
    GH: gh,
    ORCH_MACHINE_DIR: join(tmp, 'machine'),
    ...GIT_ISOLATION,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  delete env.NODE_TEST_CONTEXT
  // 목록 경로를 바꾸는 값을 물려받지 않게 지운다. 이 테스트는 가짜 홈의 기본 경로를 쓴다
  delete env.ORCH_PRIVATE_WORDS
  const proj = join(tmp, 'proj')
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', proj], { env }).status, 0)
  writeFileSync(join(proj, 'seed.txt'), `seed\n${WORD} 이 든 옛 줄\n`)
  assert.equal(g(proj, ['add', '.']).status, 0)
  assert.equal(g(proj, ['commit', '-q', '-m', 'seed']).status, 0)
  wt = join(tmp, 'wt')
  assert.equal(g(proj, ['worktree', 'add', '-q', '-b', 'work', wt]).status, 0)
  // installCommitCheck 는 이 프로세스의 git 을 쓴다. 전역 설정을 읽지 않게 같은 값을 둔다
  const keep = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    assert.equal(installCommitCheck(wt).status, 'set')
  } finally {
    if (keep.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = keep.global
    if (keep.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = keep.system
  }
})
after(() => rmSync(tmp, { recursive: true, force: true }))

describe('worker 훅의 비공개 낱말 검사', { concurrency: false }, () => {
  beforeEach(() => {
    setWords(`# 가상 목록\n${WORD}\n`)
    rmSync(join(tmp, 'machine'), { recursive: true, force: true })
    rmSync(calls, { force: true })
    g(wt, ['reset', '-q', '--hard'])
  })

  test('훅 폴더에 검사기 사본이 있다', () => {
    const hooks = g(wt, ['config', '--worktree', '--get', 'core.hooksPath']).stdout.trim()
    assert.ok(existsSync(join(hooks, 'private-words.ts')))
  })

  test('더한 줄에 낱말이 있으면 커밋을 막고 값은 내지 않는다(REQ3, REQ5)', () => {
    const done = commit('a.txt', `깨끗한 줄\n경로 /srv/${WORD.toUpperCase()}/data\n`)
    assert.equal(done.status, 1, done.stderr)
    assert.match(done.stderr, /a\.txt:2\(목록 2번째 줄\)/)
    assert.ok(!`${done.stdout}${done.stderr}`.toLowerCase().includes(WORD), done.stderr)
  })

  test('커밋 메시지에 낱말이 있으면 막는다(REQ3)', () => {
    const done = commit('b.txt', '깨끗한 줄\n', `feat: 제목\n\n${WORD} 를 설명한다`)
    assert.equal(done.status, 1, done.stderr)
    assert.match(done.stderr, /커밋 메시지 3번째 줄/)
    assert.ok(!done.stderr.includes(WORD))
  })

  test('파일 이름에 낱말이 있으면 가려서 막는다', () => {
    const done = commit(`${WORD}.txt`, '깨끗한 줄\n')
    assert.equal(done.status, 1, done.stderr)
    assert.match(done.stderr, /파일 이름 \*\*\*\.txt/)
    assert.ok(!done.stderr.includes(WORD))
  })

  test('낱말이 없거나 지우는 줄에만 있으면 통과한다(REQ3)', () => {
    assert.equal(commit('c.txt', '깨끗한 줄\n').status, 0)
    writeFileSync(join(wt, 'seed.txt'), 'seed\n')
    assert.equal(g(wt, ['add', 'seed.txt']).status, 0)
    const done = g(wt, ['commit', '-q', '-m', 'chore: 옛 줄을 지운다'])
    assert.equal(done.status, 0, done.stderr)
  })

  test('목록이 없거나 비었으면 검사하지 않고 gh 도 부르지 않는다(REQ2)', () => {
    setWords(null)
    assert.equal(commit('d.txt', `${WORD}\n`).status, 0)
    setWords('# 비었다\n\n')
    assert.equal(commit('e.txt', `${WORD}\n`).status, 0)
    assert.equal(ghCalls(), 0)
  })

  test('비공개 저장소면 검사하지 않는다', () => {
    const done = commit('f.txt', `${WORD}\n`, 'work', { FAKE_VIS: 'PRIVATE' })
    assert.equal(done.status, 0, done.stderr)
  })

  test('공개 여부를 읽지 못하면 공개로 보고 검사한다(REQ6)', () => {
    const done = commit('g.txt', `${WORD}\n`, 'work', { FAKE_VIS: 'fail' })
    assert.equal(done.status, 1, done.stderr)
    assert.ok(ghCalls() >= 1)
  })

  test('바이너리로 보이는 파일과 diff 를 끈 파일의 내용도 본다', () => {
    const nul = commit('n.txt', `앞\0뒤\n${WORD}\n`)
    assert.equal(nul.status, 1, nul.stderr)
    assert.match(nul.stderr, /n\.txt:2/)
    writeFileSync(join(wt, '.gitattributes'), 'quiet.txt -diff\n')
    assert.equal(g(wt, ['add', '.gitattributes']).status, 0)
    const quiet = commit('quiet.txt', `${WORD}\n`)
    assert.equal(quiet.status, 1, quiet.stderr)
    assert.match(quiet.stderr, /quiet\.txt:1/)
    assert.ok(!`${nul.stderr}${quiet.stderr}`.includes(WORD))
  })

  test('목록이 있는데 검사기가 없거나 예외로 끝나면 막는다', () => {
    const hooks = g(wt, ['config', '--worktree', '--get', 'core.hooksPath']).stdout.trim()
    const copy = join(hooks, 'private-words.ts')
    const original = readFileSync(copy, 'utf8')
    try {
      rmSync(copy)
      const missing = commit('m.txt', '깨끗한 줄\n')
      assert.equal(missing.status, 1, missing.stderr)
      assert.match(missing.stderr, /비공개 낱말 검사기 사본이 없다/)
      g(wt, ['reset', '-q', '--hard'])
      writeFileSync(copy, "throw new Error('broken')\n")
      const thrown = commit('t.txt', '깨끗한 줄\n')
      assert.equal(thrown.status, 1, thrown.stderr)
      assert.match(thrown.stderr, /비공개 낱말 검사기가 돌지 못했다/)
    } finally {
      writeFileSync(copy, original)
    }
  })

  test('같은 저장소의 연속 커밋은 공개 여부를 한 번만 묻는다(REQ6)', () => {
    for (const name of ['h1.txt', 'h2.txt', 'h3.txt']) assert.equal(commit(name, `${name}\n`).status, 0)
    assert.equal(ghCalls(), 1)
  })
})
