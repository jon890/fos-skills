import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const tool = fileURLToPath(new URL('../bin/board-file.ts', import.meta.url))
test('창의 보드 파일은 orch 와 같이 finish.board, 기본 위치 순서로 정하고 repo 는 필수다', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'board-file-')))
  const shared = join(repo, 'shared', 'board.json')
  const run = (args: string[]) => spawnSync(process.execPath, [tool, ...args], { env: { ...process.env, ORCH_DIR: join(repo, '.orch'), GIT_CEILING_DIRECTORIES: repo }, encoding: 'utf8' })
  try {
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
    mkdirSync(join(repo, '.orch'))
    assert.deepEqual(JSON.parse(run(['--repo', repo]).stdout), { path: join(repo, '.orch/board.json'), error: null })
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: shared } }))
    assert.deepEqual(JSON.parse(run(['--repo', repo]).stdout), { path: shared, error: null })
    writeFileSync(join(repo, '.orch/config.json'), JSON.stringify({ finish: { board: 3 } }))
    const invalid = run(['--repo', repo]); assert.equal(invalid.status, 0)
    assert.equal(JSON.parse(invalid.stdout).path, null); assert.match(JSON.parse(invalid.stdout).error, /finish.board/)
    assert.equal(run([]).status, 2)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
