// lib/tell-worker.ts 를 임시 git 저장소의 워크트리와 가짜 orca, 가짜 send-to-worker 로 본다. Orca 에는 닿지 않는다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { tellBranchWorker } from '../scripts/lib/tell-worker.ts'

const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
process.stdout.write(JSON.stringify({ ok: true, result: { workers: JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/workers.json', 'utf8')), page: {} } }) + '\\n')
`
const FAKE_SEND = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.FAKE_DIR + '/send.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n')
process.exitCode = Number(process.env.FAKE_SEND_CODE || 0)
`

let tmp = ''
let repo = ''
const saved = { ORCA: process.env.ORCA, SEND_TO_WORKER: process.env.SEND_TO_WORKER, FAKE_DIR: process.env.FAKE_DIR, FAKE_SEND_CODE: process.env.FAKE_SEND_CODE }
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' }

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  assert.equal(done.status, 0, done.stderr)
}

function workers(rows: { id: string; status: string; path: string }[]): void {
  const list = rows.map((r) => ({ dispatchId: r.id, dispatchStatus: r.status, resource: { worktreeId: `repo::${r.path}` } }))
  writeFileSync(join(tmp, 'workers.json'), JSON.stringify(list))
}

function sends(): string[][] {
  const file = join(tmp, 'send.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-tell-worker-')))
  repo = join(tmp, 'repo')
  git(tmp, 'init', '-q', '-b', 'main', repo)
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', join(tmp, 'feat'))
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA)
  chmodSync(join(tmp, 'orca'), 0o755)
  writeFileSync(join(tmp, 'send.ts'), FAKE_SEND)
  process.env.ORCA = join(tmp, 'orca')
  process.env.SEND_TO_WORKER = join(tmp, 'send.ts')
  process.env.FAKE_DIR = tmp
  delete process.env.FAKE_SEND_CODE
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

test('브랜치 워크트리의 살아 있는 dispatch 에 --no-reply 와 Run 으로 보낸다', async () => {
  workers([{ id: 'd0', status: 'completed', path: join(tmp, 'feat') }, { id: 'd1', status: 'running', path: join(tmp, 'feat') }])
  assert.deepEqual(await tellBranchWorker(repo, 'feat', 'run_x', '본문'), { sent: 'd1' })
  assert.deepEqual(sends(), [['--dispatch', 'd1', '--body', '본문', '--no-reply', '--run', 'run_x']])
})

test('워크트리나 살아 있는 dispatch 가 없거나 보내지 못하면 이유를 낸다', async () => {
  workers([{ id: 'd0', status: 'completed', path: join(tmp, 'feat') }])
  assert.deepEqual(await tellBranchWorker(repo, 'nope', 'run_x', 'b'), { skipped: '워크트리 없음' })
  assert.deepEqual(await tellBranchWorker(repo, 'feat', 'run_x', 'b'), { skipped: '살아 있는 dispatch 없음' })
  workers([{ id: 'd1', status: 'running', path: join(tmp, 'feat') }])
  process.env.FAKE_SEND_CODE = '3'
  assert.deepEqual(await tellBranchWorker(repo, 'feat', 'run_x', 'b'), { skipped: 'd1 에 보내지 못했다(send-to-worker 종료 코드 3)' })
})
