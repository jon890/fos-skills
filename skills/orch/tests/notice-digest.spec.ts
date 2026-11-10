import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { sendNotice, setNoticeOwner } from '../scripts/lib/run-notice.ts'
import { flushDigest, watchStreak } from '../scripts/lib/notice-digest.ts'
let repo: string, bin: FakeBin
const saved = { ...process.env }
beforeEach(t => {
  repo = tempDir('notice-digest-', t); process.env.ORCH_DIR = join(repo, '.orch'); process.env.GIT_CEILING_DIRECTORIES = repo
  bin = fakeBin(repo, 'orca', [{ args: ['send'], stdout: JSON.stringify({ ok: true, result: { message: { id: 'notice' } } }) }]); process.env.ORCA = bin.path
})
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
const kinds = () => bin.calls().filter(c => c.argv.includes('send')).map(c => c.argv[c.argv.indexOf('--subject') + 1].split(' ')[0])
test('할 일이 있는 kind 는 그 틱에 바로 간다', () => {
  for (const kind of ['CI-FAILED', 'WORKER-STALLED', 'UNANSWERED', 'FINISH-MISSING', 'HEAVY-SLOT-HELD']) sendNotice(kind, null, 'x', 'R', repo)
  assert.deepEqual(kinds(), ['CI-FAILED', 'WORKER-STALLED', 'UNANSWERED', 'FINISH-MISSING', 'HEAVY-SLOT-HELD'])
})
test('안내성 kind 는 주기 전에는 가지 않고 주기에 DIGEST 하나로 묶여 간다', () => {
  for (const kind of ['WATCH-ERROR', 'LEGACY-NOTICE', 'STAGE-STALLED', 'LOOP-RESTARTED']) sendNotice(kind, null, `${kind} 본문`, 'R', repo)
  assert.deepEqual(kinds(), [])
  assert.equal(flushDigest(repo, 'R', 1800), false)
  assert.deepEqual(kinds(), [])
  assert.equal(flushDigest(repo, 'R', 1800, Date.now() + 1801_000), true)
  assert.deepEqual(kinds(), ['DIGEST'])
  const body = bin.calls().at(-1)!.argv[bin.calls().at(-1)!.argv.indexOf('--body') + 1]
  for (const kind of ['WATCH-ERROR', 'LEGACY-NOTICE', 'STAGE-STALLED', 'LOOP-RESTARTED']) assert.match(body, new RegExp(kind))
  assert.equal(flushDigest(repo, 'R', 1800, Date.now() + 9000_000), false, '모을 것이 없으면 보내지 않는다')
  assert.equal(kinds().length, 1)
})
test('DIGEST 전송이 실패하면 쌓아 둔 것을 지우지 않고 다음에 다시 보낸다', () => {
  sendNotice('STAGE-STALLED', null, 'x', 'R', repo)
  bin.setRules([{ args: ['send'], code: 1, stderr: 'offline' }])
  assert.equal(flushDigest(repo, 'R', 1, Date.now() + 5000), false)
  bin.setRules([{ args: ['send'], stdout: JSON.stringify({ ok: true, result: { message: { id: 'n' } } }) }])
  assert.equal(flushDigest(repo, 'R', 1, Date.now() + 5000), true)
})
test('같은 WATCH-ERROR 가 연속 세 틱 넘게 이어지면 한 번 바로 보내고 풀리면 다시 센다', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(() => watchStreak(repo, 'q@R', 'offline')), [false, false, false, true, false])
  assert.equal(watchStreak(repo, 'q@R', null), false)
  assert.deepEqual([1, 2, 3, 4].map(() => watchStreak(repo, 'q@R', 'offline')), [false, false, false, true])
})
test('한 Run 에 등록된 다른 저장소의 루프가 보낸 같은 알림은 보내지 않는다', t => {
  process.env.ORCH_MACHINE_DIR = join(repo, 'machine')
  t.after(() => setNoticeOwner(null))
  setNoticeOwner('/repo/a'); sendNotice('DECISION-PENDING', null, '같은 결정', 'R')
  setNoticeOwner('/repo/b'); sendNotice('DECISION-PENDING', null, '같은 결정', 'R')
  assert.equal(kinds().length, 1, '다른 저장소의 루프는 이미 보낸 같은 알림을 건너뛴다')
  setNoticeOwner('/repo/a'); sendNotice('DECISION-PENDING', null, '같은 결정', 'R'); sendNotice('DECISION-PENDING', null, '다른 결정', 'R')
  assert.equal(kinds().length, 3, '같은 저장소의 되풀이 억제는 호출한 쪽이 맡고 다른 본문은 보낸다')
})
