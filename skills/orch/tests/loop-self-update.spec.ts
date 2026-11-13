// 다시 뜰 때의 판정은 고정 시각으로, 설치 기록과 바쁜 프로세스는 임시 파일과 대역으로 본다.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin } from './fixtures/fake-bin.ts'
import { busyReason, decide, heirEntry, newSelfUpdate, observe, STALE_WAIT_MAX_MS, updatedText, failedText } from '../scripts/loop/self-update.ts'

test('다시 뜰 때의 판정은 실패 기억, 설정 오류, 기다림 상한, 바쁜 이유 순서다', () => {
  const base = { target: '/new', failed: null, since: 1000, now: 2000, busy: null, lastCode: 0 }
  assert.deepEqual(decide({ ...base, target: null }), { kind: 'none' })
  assert.deepEqual(decide({ ...base, failed: heirEntry('/new'), lastCode: 2 }), { kind: 'none' })
  assert.deepEqual(decide({ ...base, lastCode: 2, busy: '마무리' }), { kind: 'go' })
  assert.deepEqual(decide({ ...base, now: 1000 + STALE_WAIT_MAX_MS + 1000, busy: '마무리' }), { kind: 'go' })
  assert.deepEqual(decide({ ...base, now: 1000 + STALE_WAIT_MAX_MS, busy: '마무리' }), { kind: 'go' })
  assert.deepEqual(decide({ ...base, now: 1000 + 59 * 60_000, busy: '마무리' }), { kind: 'wait', reason: '마무리' })
  assert.deepEqual(decide(base), { kind: 'go' })
})

test('설치본이 바뀔 때만 로그를 내고 처음 발견한 시각은 지킨다', t => {
  const root = tempDir('self-update-observe-', t)
  const bundles = ['old', 'new', 'next'].map(name => join(root, name))
  bundles.forEach((dir, i) => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ version: String(i) }))
  })
  const state = newSelfUpdate()
  assert.equal(observe(state, bundles[1], 100, bundles[0]), `LOOP-STALE 0 1 ${heirEntry(bundles[1])}`)
  assert.equal(observe(state, bundles[1], 200, bundles[0]), null)
  state.failed = heirEntry(bundles[1])
  assert.equal(observe(state, bundles[2], 300, bundles[0]), `LOOP-STALE 0 2 ${heirEntry(bundles[2])}`)
  assert.equal(state.since, 100)
  assert.equal(state.failed, null)
  assert.equal(observe(state, null, 400, bundles[0]), null)
  assert.deepEqual(state, newSelfUpdate())
})

test('이 저장소의 살아 있는 마무리와 큐만 기다리고 ps 오류도 기다린다', t => {
  const root = tempDir('self-update-busy-', t)
  const saved = { ORCH_DIR: process.env.ORCH_DIR, PS: process.env.PS, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  process.env.ORCH_DIR = join(root, 'orch')
  process.env.GIT_CEILING_DIRECTORIES = root
  const ps = fakeBin(root, 'ps', [{ stdout: '' }])
  process.env.PS = ps.path
  const queue = join(root, 'orch', 'queue')
  mkdirSync(queue, { recursive: true })
  const file = join(queue, 'finish-7.pid')
  writeFileSync(file, String(process.pid))
  assert.equal(busyReason(root), '마무리 PR 7')
  writeFileSync(file, '999999999')
  assert.equal(busyReason(root), null)
  ps.setRules([{ stdout: ` 123 node merge_queue.ts --repo ${root}\n` }])
  assert.equal(busyReason(root), '머지 큐 pid 123')
  ps.setRules([{ stdout: ` 123 node merge-with-finish.ts --repo ${join(root, 'other')}\n` }])
  assert.equal(busyReason(root), null)
  ps.setRules([{ stdout: ' 123 node merge-queue.sh\n' }])
  assert.equal(busyReason(root), '머지 큐 pid 123')
  ps.setRules([{ code: 1 }])
  assert.equal(busyReason(root), '프로세스 목록을 읽지 못했다')
})

test('다시 뜬 알림은 저장소와 버전을, 버전이 같거나 없으면 경로도 보인다', () => {
  assert.equal(updatedText('repo', '1', '2', '/old', '/new'), 'repo 루프: 1 → 2 으로 다시 떴다')
  assert.equal(updatedText('repo', '1', '1', '/old', '/new'), 'repo 루프: 1(/old) → 1(/new) 으로 다시 떴다')
  assert.match(updatedText('repo', '-', '2', '/old', '/new'), /-\(\/old\) → 2\(\/new\)/)
  assert.match(failedText('repo', '1', '2', '진입점이 없다', '/new/entry'), /repo 루프: 2 .* 1 .*진입점이 없다.*새 진입점: \/new\/entry/)
})
