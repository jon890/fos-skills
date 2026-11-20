// lib/queue-process.ts 의 repoQueues 가 이 저장소의 머지 큐만 고르는지 임시 저장소와 가짜 작업 폴더로 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { queueRepoOf, repoQueues } from '../scripts/lib/queue-process.ts'

function repos(t: TestContext): { mine: string; other: string; tmp: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'queue-process-')))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const mine = join(tmp, 'mine')
  const other = join(tmp, 'other')
  for (const dir of [mine, other]) {
    mkdirSync(dir)
    assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
  }
  return { mine, other, tmp }
}

test('--repo 나 작업 폴더가 이 저장소인 큐와 기록에 든 pid 만 고른다', (t) => {
  const { mine, other, tmp } = repos(t)
  mkdirSync(join(mine, 'sub'))
  const cwd: Record<number, string> = { 3: other, 4: mine, 5: join(tmp, 'gone'), 6: mine }
  const list = [
    { pid: 1, command: `node merge-with-finish.ts --repo ${mine} 9` },
    { pid: 2, command: `node merge_queue.ts --repo=${other} 9` },
    { pid: 3, command: 'node merge_queue.ts 9' },
    { pid: 4, command: 'node merge_queue.ts --repo sub 9' },
    { pid: 5, command: 'node merge_queue.ts 9' },
    { pid: 6, command: 'node --test tests/a.spec.ts' },
    { pid: 7, command: 'node merge_queue.ts 9' },
    { pid: 8, command: `node merge_queue.ts --repo ${other} 9` },
  ]
  const picked = repoQueues(list, mine, new Set([8]), (pid) => cwd[pid] ?? null).map((p) => p.pid)
  // 7 은 작업 폴더를 알 수 없어 센다. 8 은 이 저장소의 기록에 든 pid 다
  assert.deepEqual(picked, [1, 4, 7, 8])
})

test('상대경로 --repo 는 작업 폴더 기준이다', () => {
  assert.equal(queueRepoOf({ pid: 1, command: 'node merge_queue.ts --repo ../x 9' }, () => '/a/b'), '/a/x')
  assert.equal(queueRepoOf({ pid: 1, command: 'node merge_queue.ts 9' }, () => null), null)
})
