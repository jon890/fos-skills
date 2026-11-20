// lib/followups.ts 의 목록 파일, 루프 확인(followupTick), 보드 반영을 임시 git 저장소로 본다. gh 와 Orca 에는 닿지 않는다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { markDone, upsertFollowup } from '../scripts/core/followups.ts'
import type { Followup } from '../scripts/core/followups.ts'
import { followupDone, followupsFile, followupTick, loadFollowups, mirrorBoard, updateFollowups } from '../scripts/lib/followups.ts'

delete process.env.ORCH_DIR
delete process.env.BOARD_BIN

const AT = '2026-11-20T01:00:00.000Z'

function repo(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'followups-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0)
  return dir
}

function add(dir: string, pr: number, deploy: Followup['deploy']): void {
  updateFollowups(dir, (items) => ({ items: upsertFollowup(items, { pr, title: `제목 ${pr}`, text: `smoke ${pr}`, merge_commit: 'b'.repeat(40), deploy }, AT).items, value: null }))
}

type Sent = { run: string; text: string }
function notifier(sent: Sent[], ok = true) {
  return (run: string, text: string) => {
    sent.push({ run, text })
    return ok ? { ok: true as const } : { ok: false as const, error: 'offline' }
  }
}

test('목록 파일이 없으면 배포도 알림도 보지 않는다', (t) => {
  const dir = repo(t)
  const sent: Sent[] = []
  const got = followupTick(dir, { deploy: { workflow: 'deploy.yml', branch: 'main' }, run: 'run_1', notify: notifier(sent), deployed: () => { throw new Error('부르면 안 된다') } })
  assert.deepEqual(got, { deployed: [], notified: [], error: null })
  assert.equal(sent.length, 0)
  assert.equal(existsSync(followupsFile(dir)), false)
})

test('배포를 확인한 항목을 한 번 묶어 알리고 다음 틱에는 되풀이하지 않는다', (t) => {
  const dir = repo(t)
  add(dir, 787, 'success')
  add(dir, 789, 'none')
  add(dir, 793, 'timeout')
  const sent: Sent[] = []
  const deps = { deploy: null, run: 'run_1', notify: notifier(sent), now: () => AT }
  const first = followupTick(dir, deps)
  assert.deepEqual(first.notified, [787, 789])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].run, 'run_1')
  assert.match(sent[0].text, /^배포 뒤 할 일 2건/)
  assert.doesNotMatch(sent[0].text, /#793/)
  const second = followupTick(dir, deps)
  assert.deepEqual(second.notified, [])
  assert.equal(sent.length, 1)
})

test('배포 설정이 있으면 확인하지 못한 항목의 배포를 다시 보고, 성공한 것만 알린다', (t) => {
  const dir = repo(t)
  add(dir, 793, 'timeout')
  add(dir, 794, 'failure')
  const sent: Sent[] = []
  const got = followupTick(dir, {
    deploy: { workflow: 'deploy.yml', branch: 'main' }, run: 'run_1', notify: notifier(sent), now: () => AT,
    deployed: (merge) => merge === 'b'.repeat(40) && sent.length === 0,
  })
  assert.deepEqual(got.deployed, [793, 794])
  assert.deepEqual(got.notified, [793, 794])
  assert.deepEqual(loadFollowups(dir).map((item) => item.deploy), ['success', 'success'])
})

test('배포 설정이 없으면 확인하지 못한 항목을 다시 보지 않고 알리지도 않는다', (t) => {
  const dir = repo(t)
  add(dir, 793, 'timeout')
  const sent: Sent[] = []
  const got = followupTick(dir, { deploy: null, run: 'run_1', notify: notifier(sent), deployed: () => true })
  assert.deepEqual(got, { deployed: [], notified: [], error: null })
  assert.equal(sent.length, 0)
})

test('보내지 못하면 알림 기록을 남기지 않아 다음 틱이 다시 보낸다. Run 이 없으면 보내지 않는다', (t) => {
  const dir = repo(t)
  add(dir, 787, 'success')
  const sent: Sent[] = []
  assert.equal(followupTick(dir, { deploy: null, run: null, notify: notifier(sent) }).notified.length, 0)
  assert.equal(sent.length, 0)
  const failed = followupTick(dir, { deploy: null, run: 'run_1', notify: notifier(sent, false) })
  assert.equal(failed.error, 'offline')
  assert.equal(loadFollowups(dir)[0].notified_at, null)
  assert.deepEqual(followupTick(dir, { deploy: null, run: 'run_1', notify: notifier(sent) }).notified, [787])
})

test('끝낸 PR 만 후속 검증을 끝난 것으로 본다', (t) => {
  const dir = repo(t)
  add(dir, 787, 'success')
  assert.equal(followupDone(dir, 787), false)
  updateFollowups(dir, (items) => ({ items: markDone(items, 787, AT, null).items, value: null }))
  assert.equal(followupDone(dir, '787'), true)
  assert.equal(followupDone(dir, 788), false)
})

test('보드 파일이 있으면 followup-<PR> 항목을 wait 로 만들고 끝내면 done 으로 바꾼다. 없으면 건너뛴다', (t) => {
  const dir = repo(t)
  add(dir, 787, 'success')
  const item = loadFollowups(dir)[0]
  assert.equal(mirrorBoard(dir, item), '보드 없음')
  const board = join(dir, '.omc', 'board.json')
  mkdirSync(join(dir, '.omc'), { recursive: true })
  writeFileSync(board, JSON.stringify({ items: [] }))
  assert.equal(mirrorBoard(dir, item), '보드 followup-787 wait')
  let saved = JSON.parse(readFileSync(board, 'utf8')).items.find((one: { id: string }) => one.id === 'followup-787')
  assert.equal(saved.status, 'wait')
  assert.equal(saved.title, '배포 뒤 확인 #787 제목 787')
  assert.match(JSON.stringify(saved.details), /smoke 787/)
  // 보드는 목록의 상태를 따른다. 목록을 끝낸 뒤 쓴다
  updateFollowups(dir, (items) => ({ items: markDone(items, 787, AT, null).items, value: null }))
  assert.equal(mirrorBoard(dir, loadFollowups(dir)[0]), '보드 followup-787 done')
  saved = JSON.parse(readFileSync(board, 'utf8')).items.find((one: { id: string }) => one.id === 'followup-787')
  assert.equal(saved.status, 'done')
})

test('목록에서 끝난 항목은 받아 둔 옛 대기 값으로 보드에 써도 done 을 지킨다', (t) => {
  const dir = repo(t)
  add(dir, 787, 'success')
  const stale = loadFollowups(dir)[0]
  const board = join(dir, '.omc', 'board.json')
  mkdirSync(join(dir, '.omc'), { recursive: true })
  writeFileSync(board, JSON.stringify({ items: [] }))
  // 마무리가 대기 항목을 받아 둔 사이 followup done 이 목록과 보드를 끝냈다
  updateFollowups(dir, (items) => ({ items: markDone(items, 787, AT, null).items, value: null }))
  assert.equal(mirrorBoard(dir, loadFollowups(dir)[0]), '보드 followup-787 done')
  // 이어서 마무리가 옛 대기 값으로 보드를 써도 목록의 끝남을 따른다
  assert.equal(mirrorBoard(dir, stale), '보드 followup-787 done')
  const saved = JSON.parse(readFileSync(board, 'utf8')).items.find((one: { id: string }) => one.id === 'followup-787')
  assert.equal(saved.status, 'done')
})
