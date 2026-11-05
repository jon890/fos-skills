// 가짜 기록 폴더로 resume 의 세션 찾기와 실행 줄을 검증한다. 실제 계정 폴더는 읽지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, test } from 'node:test'
import { claudeProjectDir, claudeResumeArgv, codexResumeArgv, findClaudeSession, findCodexSession, pickPluginDir, shellLine } from '../scripts/lib/resume.ts'

let root: string, worktree: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lib-resume-')))
  worktree = join(root, 'my_repo.wt', 'feat')
  mkdirSync(worktree, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ORCA_ENV = {
  ORCA_USER_DATA_PATH: '/Users/u/Library/Application Support/orca', ORCA_WORKSPACE_ID: 'ws::/w', ORCA_WORKTREE_ID: 'ws::/w',
  ORCA_PANE_KEY: '1234', ORCA_TERMINAL_HANDLE: 'term_new',
}

test('claudeProjectDir 는 실경로의 영숫자 밖 글자를 - 로 바꾼다', () => {
  const dir = claudeProjectDir('/home', worktree)
  assert.equal(dir, join('/home', 'projects', worktree.replace(/[^A-Za-z0-9]/g, '-')))
  assert.ok(!dir.slice('/home/projects/'.length).includes('_'))
  assert.ok(!dir.slice('/home/projects/'.length).includes('.'))
})

test('findClaudeSession 은 dispatch id 가 든 기록의 세션 id 를 낸다', () => {
  const home = join(root, 'claude')
  const dir = claudeProjectDir(home, worktree)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.jsonl'), '{"text":"Dispatch ID is: ctx_other"}\n')
  writeFileSync(join(dir, 'b.jsonl'), '{"text":"Dispatch ID is: ctx_target"}\n')
  assert.equal(findClaudeSession(home, worktree, 'ctx_target'), 'b')
  assert.equal(findClaudeSession(home, worktree, 'ctx_missing'), null)
  assert.equal(findClaudeSession(join(root, 'none'), worktree, 'ctx_target'), null)
  // 여럿이면 가장 최근 것
  writeFileSync(join(dir, 'c.jsonl'), '{"text":"ctx_target 다시"}\n')
  utimesSync(join(dir, 'b.jsonl'), new Date(1000), new Date(1000))
  assert.equal(findClaudeSession(home, worktree, 'ctx_target'), 'c')
})

test('findCodexSession 은 threads 에서 rollout 에 dispatch 가 든 행을 고르고, DB 가 없으면 rollout 첫 줄로 찾는다', () => {
  const home = join(root, 'codex')
  const now = new Date()
  const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  const one = join(day, 'rollout-1.jsonl')
  const two = join(day, 'rollout-2.jsonl')
  writeFileSync(one, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: worktree } })}\n{"text":"ctx_other"}\n`)
  writeFileSync(two, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-2', cwd: worktree } })}\n{"text":"ctx_target"}\n`)
  // DB 가 없으면 rollout 파일로 찾는다
  assert.equal(findCodexSession(home, worktree, 'ctx_target'), 'thread-2')
  assert.equal(findCodexSession(home, worktree, 'ctx_missing'), null)
  assert.equal(findCodexSession(home, join(root, 'elsewhere'), 'ctx_target'), null)
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec('create table threads (id text primary key, cwd text, rollout_path text, updated_at integer)')
  const insert = db.prepare('insert into threads values (?, ?, ?, ?)')
  insert.run('db-1', worktree, one, 2)
  insert.run('db-2', worktree, two, 1)
  db.close()
  // DB 의 id 를 쓴다(rollout 첫 줄의 id 와 다르게 두어 어느 쪽에서 왔는지 본다)
  assert.equal(findCodexSession(home, worktree, 'ctx_target'), 'db-2')
  // DB 에 맞는 행이 없으면 rollout 파일로 찾는다
  assert.equal(findCodexSession(home, worktree, 'ctx_other'), 'db-1')
  rmSync(join(home, 'state_5.sqlite'))
  writeFileSync(join(home, 'state_5.sqlite'), 'not a database')
  assert.equal(findCodexSession(home, worktree, 'ctx_target'), 'thread-2')
})

test('pickPluginDir 은 환경 값, 요청 값 순으로 있는 폴더만 고른다', () => {
  const env = join(root, 'env-view')
  const req = join(root, 'req-view')
  mkdirSync(env); mkdirSync(req)
  assert.equal(pickPluginDir(env, req), env)
  assert.equal(pickPluginDir(undefined, req), req)
  assert.equal(pickPluginDir(join(root, 'missing'), req), req)
  assert.equal(pickPluginDir(undefined, null), null)
  assert.equal(pickPluginDir(join(root, 'missing'), join(root, 'missing2')), null)
})

test('claudeResumeArgv 는 Orca 의 실행 줄에 --resume 을 더하고 effort 가 없으면 뺀다', () => {
  assert.deepEqual(claudeResumeArgv('s1', { model: 'claude-haiku-5-5', effort: 'medium' }, '/p/orca-agent-view'),
    ['claude', '--plugin-dir', '/p/orca-agent-view', '--permission-mode', 'auto', '--model', 'claude-haiku-5-5', '--effort', 'medium', '--resume', 's1'])
  assert.ok(!claudeResumeArgv('s1', { model: 'm', effort: null }, '/p').includes('--effort'))
})

test('codexResumeArgv 는 ORCA_* 다섯을 -c 로 넘기고 하나라도 없으면 null', () => {
  const argv = codexResumeArgv('t1', { model: 'gpt-6-luna', effort: 'high' }, ORCA_ENV)!
  assert.deepEqual(argv.slice(0, 4), ['codex', 'resume', 't1', '--no-daemon'])
  const sets = argv.filter((word, i) => argv[i - 1] === '-c' && word.startsWith('shell_environment_policy.set.'))
  assert.deepEqual(sets, Object.entries(ORCA_ENV).map(([k, v]) => `shell_environment_policy.set.${k}=${JSON.stringify(v)}`))
  assert.deepEqual(argv.slice(-9), ['-c', 'check_for_update_on_startup=false', '-c', 'disable_paste_burst=true',
    '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high'])
  assert.equal(argv.length, 4 + 10 + 9)
  assert.ok(!codexResumeArgv('t1', { model: 'm', effort: null }, ORCA_ENV)!.some((w) => w.startsWith('model_reasoning_effort')))
  for (const name of Object.keys(ORCA_ENV)) {
    const env = { ...ORCA_ENV } as Record<string, string | undefined>
    delete env[name]
    assert.equal(codexResumeArgv('t1', { model: 'm', effort: null }, env), null, name)
  }
})

test('shellLine 은 공백과 작은따옴표가 든 낱말을 셸이 그대로 받게 쓴다', () => {
  const words = ['a b', "it's", '$HOME', 'x"y', '']
  const line = shellLine(words)
  assert.ok(line.startsWith('exec '))
  const r = spawnSync('/bin/sh', ['-c', `${line.replace(/^exec /, "printf '%s\\n' ")}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, `${words.join('\n')}\n`)
})
