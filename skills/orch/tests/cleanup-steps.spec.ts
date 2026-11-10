// 정리 단계가 진입 파일로 다시 합쳐지거나 공개 호출 경로가 끊기는 것을 막는다.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const entry = new URL('../scripts/cleanup/cleanup-sweep.ts', import.meta.url)

test('진입 파일은 단계 호출을 모으고 단계 구현을 갖지 않는다', async () => {
  const source = readFileSync(entry, 'utf8')
  for (const name of ['sweepWorktree', 'sweepBranches', 'sweepReviews', 'sweepStaleSpecs', 'sweepRemoteBranches', 'sweepDocker']) {
    assert.doesNotMatch(source, new RegExp(`(?:async )?function ${name}\\(`), name)
  }
  for (const [file, name] of [
    ['prepare', 'prepare'], ['worktrees', 'cleanupWorktrees'], ['branches', 'cleanupBranches'],
    ['reviews', 'cleanupReviews'], ['specs', 'cleanupSpecs'], ['remote-branches', 'cleanupRemoteBranches'],
    ['state', 'cleanupState'], ['docker', 'cleanupDocker'],
  ]) {
    const module = await import(new URL(`../scripts/cleanup/steps/${file}.ts`, import.meta.url).href)
    assert.equal(typeof module[name], 'function', `${file}: ${name}`)
    assert.match(source, new RegExp(`await ${name}\\(`), name)
  }
})

test('기존 공개 경로는 프로세스와 출력 도우미를 그대로 내보낸다', async () => {
  const api = await import(entry.href)
  const processes = await import('../scripts/cleanup/steps/processes.ts')
  const output = await import('../scripts/cleanup/steps/output.ts')
  assert.equal(api.waitFree, processes.waitFree)
  assert.equal(api.stopHolders, processes.stopHolders)
  assert.equal(api.sweepLine, output.sweepLine)
})
