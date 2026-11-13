import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const tool = fileURLToPath(new URL('../bin/task-tool.ts', import.meta.url))
test('창에 도구 이름과 설정 오류를 내고 repo 는 필수다', () => {
  const repo = mkdtempSync(join(tmpdir(), 'task-tool-'))
  const run = (args: string[]) => spawnSync(process.execPath, [tool, ...args], { env: { ...process.env, ORCH_DIR: join(repo, '.orch'), GIT_CEILING_DIRECTORIES: repo }, encoding: 'utf8' })
  try {
    mkdirSync(join(repo, '.orch'))
    assert.deepEqual(JSON.parse(run(['--repo', repo]).stdout), { name: null, error: null })
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ board: { task: { adapter: 'dooray', web_url: 'https://x.dooray.com', project: 'P' } } }))
    assert.deepEqual(JSON.parse(run(['--repo', repo]).stdout), { name: '두레이', error: null })
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ board: { task: { adapter: 'unknown' } } }))
    const invalid = run(['--repo', repo]); assert.equal(invalid.status, 0); assert.match(JSON.parse(invalid.stdout).error, /board.task/)
    assert.equal(run([]).status, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
