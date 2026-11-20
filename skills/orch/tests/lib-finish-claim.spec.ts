// lib/finish-claim.ts: PR 하나의 마무리는 실행권을 쥔 프로세스 하나만 돌고, pid 파일은 쥔 동안에만 쓰고 지운다.
// PR 558 리뷰에서 재현된 「끝나는 마무리와 새 마무리의 겹침」 을 순서대로 고정한다.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { askRerun, beginFinish, rerunFile, rerunOrRelease, retakeForRerun, takeRerun } from '../scripts/lib/finish-claim.ts'
import { claimFile } from '../scripts/lib/pr-claim.ts'

const HOLDER = fileURLToPath(new URL('./fixtures/claim-holder.ts', import.meta.url))

function setup(t: TestContext): { repo: string; pidFile: string; marker: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'finish-claim-')))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  const before = process.env.ORCH_DIR
  delete process.env.ORCH_DIR
  t.after(() => { if (before !== undefined) process.env.ORCH_DIR = before })
  const pidFile = join(repo, '.orch', 'queue', 'finish-7.pid')
  return { repo, pidFile, marker: join(repo, '.orch', 'state', 'finish-rerun', '7') }
}

// 다른 프로세스가 같은 PR 의 마무리를 시작하려 한 결과. 시작했으면 테스트가 끝날 때까지 돈다
async function other(t: TestContext, repo: string, pidFile: string): Promise<{ child: ChildProcess; result: { pid: number; kind: string } }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOLDER, 'finish', repo, '7', pidFile], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  let text = ''
  for await (const chunk of child.stdout!) {
    text += chunk
    if (text.includes('\n')) break
  }
  return { child, result: JSON.parse(text) }
}

test('시작하면 pid 를 쓰고 앞선 다시 돌기 표시를 지운다. 도는 동안 다른 마무리는 시작하지 못하고 pid 파일도 건드리지 못한다', async (t) => {
  const c = setup(t)
  writeFileSync(join(c.repo, 'x'), '')
  const begun = beginFinish(c.repo, 7, c.pidFile)
  assert.equal(begun.kind, 'run')
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(process.pid))
  const second = await other(t, c.repo, c.pidFile)
  assert.equal(second.result.kind, 'running')
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(process.pid))
  if (begun.kind === 'run') assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), false)
  assert.equal(existsSync(c.pidFile), false)
  assert.equal(existsSync(claimFile(c.repo, 'finish', 7)), false)
})

test('시작할 때 있던 표시는 지금 실행이 대신하므로 지우고, 도는 중에 들어온 표시는 끝날 때 가져가 한 번 더 돈다', (t) => {
  const c = setup(t)
  const begun = beginFinish(c.repo, 7, c.pidFile)
  assert.equal(begun.kind, 'run')
  if (begun.kind !== 'run') return
  askRerun(c.repo, 7)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), true)
  assert.equal(existsSync(c.marker), false)
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(process.pid))
  assert.equal(existsSync(claimFile(c.repo, 'finish', 7)), true)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), false)
  // 표시를 둔 채 새로 시작하면 그 표시를 지운다
  askRerun(c.repo, 7)
  const again = beginFinish(c.repo, 7, c.pidFile)
  assert.equal(again.kind, 'run')
  assert.equal(existsSync(c.marker), false)
  if (again.kind === 'run') rerunOrRelease(c.repo, 7, c.pidFile, again.claim)
})

// orch followup done 이 pid 가 살아 있는 것을 보고 표시만 남겼는데, 그때 마무리는 이미 마지막 표시 확인을 지난 순서
test('놓기 직전에 들어온 표시는 놓은 뒤의 확인에서 보고 실행권을 다시 잡아 돈다', (t) => {
  const c = setup(t)
  const begun = beginFinish(c.repo, 7, c.pidFile)
  if (begun.kind !== 'run') return assert.fail(begun.kind)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), false)
  askRerun(c.repo, 7)
  const again = retakeForRerun(c.repo, 7, c.pidFile)
  assert.equal(again.kind, 'rerun')
  assert.equal(existsSync(c.marker), false)
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(process.pid))
  if (again.kind === 'rerun') assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, again.claim), false)
  assert.equal(retakeForRerun(c.repo, 7, c.pidFile).kind, 'done')
  assert.equal(existsSync(c.pidFile), false)
})

// 리뷰의 순서: 앞 마무리가 pid 파일을 놓은 뒤 새 마무리가 pid 를 쓰고, 앞 마무리의 끝내기가 이어 돈다
test('끝나는 마무리가 놓은 뒤 새 마무리가 시작하면, 끝나는 쪽은 새 마무리의 pid 파일과 그 마무리에게 온 표시를 건드리지 않는다', async (t) => {
  const c = setup(t)
  const begun = beginFinish(c.repo, 7, c.pidFile)
  if (begun.kind !== 'run') return assert.fail(begun.kind)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), false)
  const fresh = await other(t, c.repo, c.pidFile)
  assert.equal(fresh.result.kind, 'run')
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(fresh.result.pid))
  // 새 마무리가 도는 동안 들어온 요청이다. 끝나는 쪽이 가져가면 새 마무리가 끝날 때 보지 못한다
  askRerun(c.repo, 7)
  assert.equal(retakeForRerun(c.repo, 7, c.pidFile).kind, 'done')
  assert.equal(readFileSync(c.pidFile, 'utf8'), String(fresh.result.pid))
  assert.equal(existsSync(c.marker), true)
})

// 리뷰의 순서: 끝나는 마무리가 아직 쥐고 있을 때 followup done 이 새 마무리를 띄운다
test('끝나는 마무리가 아직 쥐고 있을 때 띄운 마무리는 시작하지 못하지만, 남은 표시를 끝나는 쪽이 놓은 뒤 가져가 한 번 더 돈다', async (t) => {
  const c = setup(t)
  const begun = beginFinish(c.repo, 7, c.pidFile)
  if (begun.kind !== 'run') return assert.fail(begun.kind)
  // followup done: 표시를 쓰고 새 마무리를 띄운다. 새 마무리는 실행권을 잡지 못해 표시를 둔 채 끝난다
  askRerun(c.repo, 7)
  const late = await other(t, c.repo, c.pidFile)
  assert.equal(late.result.kind, 'running')
  assert.equal(existsSync(c.marker), true)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), true)
  assert.equal(rerunOrRelease(c.repo, 7, c.pidFile, begun.claim), false)
})

// PR 568 리뷰: 로그 폴더를 따로 준 마무리와 followup done 이 서로 다른 자리의 표시를 봤다
test('다시 돌기 표시는 pid 파일의 폴더와 상관없이 저장소와 PR 번호로 정한 한 자리에 있고, 한쪽만 가져간다', (t) => {
  const c = setup(t)
  const elsewhere = join(c.repo, 'custom-logs', 'finish-7.pid')
  const begun = beginFinish(c.repo, '07', elsewhere)
  if (begun.kind !== 'run') return assert.fail(begun.kind)
  askRerun(c.repo, 7)
  assert.equal(rerunFile(c.repo, '007'), c.marker)
  assert.equal(existsSync(c.marker), true)
  assert.equal(rerunOrRelease(c.repo, 7, elsewhere, begun.claim), true)
  assert.equal(takeRerun(c.repo, 7), false)
  assert.equal(rerunOrRelease(c.repo, 7, elsewhere, begun.claim), false)
})
