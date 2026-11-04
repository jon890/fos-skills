// bin/merge-queue.ts 가 orch 설정, 상태 파일과 루프 로그에서 머지 큐의 순서, 머지 가능 여부, 대기 이유를 내는지 본다. 상태 폴더는 임시 폴더다.
//
// 실행: node --test work-board/tests/merge-queue.spec.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { autoMergeOn, clockAt, queueRows, readView, turnRows, waitRows } from '../bin/merge-queue.ts'

const SCRIPT = fileURLToPath(new URL('../bin/merge-queue.ts', import.meta.url))

let tmp: string
let state: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'merge-queue-')))
  state = join(tmp, 'state')
  mkdirSync(state)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const LOOP_LOG = [
  'tick 1 2026-11-04T04:00:00.000Z',
  'AUTO-MERGE-WAIT #10 CI pending',
  'AUTO-MERGE-WAIT #11 미해결 스레드 2',
  'tick 2 2026-11-04T04:05:00.000Z',
  'CI-PASSED #10 abcdef12',
  'tick 3 2026-11-04T04:10:00.000Z',
  'AUTO-MERGE-WAIT #10 리뷰 보류',
  'AUTO-MERGE-WAIT #11 미해결 스레드 2',
  'AUTO-MERGE-WAIT #12 기능 완료 근거 없음',
  'tick 4 2026-11-04T04:15:00.000Z',
  'AUTO-MERGE-HELD pid 99 #13 체크 대기 3분 남은 #13 #14',
].join('\n')

test('큐 밖 PR 은 자동 머지를 판정한 마지막 틱의 이유와 그 이유로 바뀐 틱의 시각을 낸다', () => {
  assert.deepEqual(waitRows(LOOP_LOG), {
    10: { place: 'out', rank: null, reason: '리뷰 보류', at: '2026-11-04T04:10:00.000Z' },
    11: { place: 'out', rank: null, reason: '미해결 스레드 2', at: '2026-11-04T04:00:00.000Z' },
    12: { place: 'out', rank: null, reason: '기능 완료 근거 없음', at: '2026-11-04T04:10:00.000Z' },
  })
})

test('마지막 판정 틱에 없는 PR 은 빠지고, 판정을 통과한 PR(AUTO-MERGE-BASIS)은 ready 다', () => {
  const log = `${LOOP_LOG}\ntick 5 2026-11-04T04:20:00.000Z\nAUTO-MERGE-WAIT #11 충돌\nAUTO-MERGE-BASIS #10 HEAD 1234 근거\nAUTO-MERGE #10 run=r log=l\n`
  assert.deepEqual(waitRows(log), {
    10: { place: 'ready', rank: null, reason: null, at: '2026-11-04T04:20:00.000Z' },
    11: { place: 'out', rank: null, reason: '충돌', at: '2026-11-04T04:20:00.000Z' },
  })
})

test('차례 기록은 차례 PR 을 지금 차례로, 나머지를 적힌 순서대로 2 번째부터 낸다', () => {
  assert.deepEqual(turnRows({ pid: 1, prs: [13, 14, 15], pr: 13, phase: 'update-branch 뒤 체크 대기', since: 'S' }), {
    13: { place: 'turn', rank: 1, reason: 'update-branch 뒤 체크 대기', at: 'S' },
    14: { place: 'queued', rank: 2, reason: '#13 차례 대기', at: 'S' },
    15: { place: 'queued', rank: 3, reason: '#13 차례 대기', at: 'S' },
  })
})

test('큐 로그에서 머지했거나 뺀 PR 을 빼고 마지막 줄의 PR 을 차례로, 단계는 그 줄로 정한다', () => {
  const at = '2026-11-04T03:46:08.000Z'
  const hhmm = (iso: string) => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const t1 = '2026-11-04T03:47:00.000Z'
  const t2 = '2026-11-04T04:01:00.000Z'
  const log = [
    `마무리 시작: PR 21 -> x`,
    `${hhmm(t1)} 21 판정: 바로 머지`,
    `${hhmm(t1)} 21 MERGED`,
    `${hhmm(t2)} 22 판정: 갱신 필요(공용 경로: a)`,
    `${hhmm(t2)} 22 base(main) 보다 3 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다`,
    `update-branch o/r#22 이유: merge-turn`,
  ].join('\n')
  assert.deepEqual(queueRows({ pid: 1, log: 'l', prs: [21, 22, 23], at }, log), {
    22: { place: 'turn', rank: 1, reason: 'update-branch 뒤 체크 대기', at: t2 },
    23: { place: 'queued', rank: 2, reason: '#22 차례 대기', at: t2 },
  })
  // 줄이 없으면 첫 PR 이 차례 시작이고, QUEUE-HELD 로 뺀 PR 은 빠진다
  assert.deepEqual(queueRows({ pid: 1, log: 'l', prs: [21, 22], at }, 'QUEUE-HELD 21'), {
    22: { place: 'turn', rank: 1, reason: '차례 시작', at },
  })
})

test('큐 로그의 시각이 큐를 건 시각보다 1분 넘게 앞서면 다음 날로 본다', () => {
  const start = new Date(2026, 10, 4, 23, 50).toISOString()
  assert.equal(clockAt('23:50', start), new Date(2026, 10, 4, 23, 50).toISOString())
  assert.equal(clockAt('00:10', start), new Date(2026, 10, 5, 0, 10).toISOString())
})

test('살아 있는 차례 기록이 루프의 큐 기록보다 앞서고, 큐 안 PR 은 루프 로그의 이유를 덮는다', () => {
  writeFileSync(join(state, 'loop.log'), LOOP_LOG)
  mkdirSync(join(state, 'queue-turn'))
  writeFileSync(join(state, 'queue-turn', '99.json'), JSON.stringify({ pid: 99, prs: [10, 14], pr: 10, phase: '체크 대기', since: 'S' }))
  // 죽은 큐의 파일은 넘어간다
  writeFileSync(join(state, 'queue-turn', '98.json'), JSON.stringify({ pid: 98, prs: [11], pr: 11, phase: '머지', since: 'S' }))
  writeFileSync(join(state, 'auto-merge.json'), JSON.stringify({ queue: { pid: 97, log: join(state, 'none.log'), prs: [12], at: 'A' } }))
  const alive = new Set([99, 97])
  const view = readView(state, (pid) => alive.has(pid), true)
  assert.equal(view.running, true)
  assert.equal(view.error, null)
  assert.deepEqual(view.prs['10'], { place: 'turn', rank: 1, reason: '체크 대기', at: 'S' })
  assert.deepEqual(view.prs['14'], { place: 'queued', rank: 2, reason: '#10 차례 대기', at: 'S' })
  assert.equal(view.prs['11'].place, 'out')
  assert.equal(view.prs['12'].place, 'out')
})

test('차례 기록이 없으면 루프가 건 큐를 쓰고, 그 큐의 명령줄 표시를 본다', () => {
  writeFileSync(join(state, 'auto-merge.json'), JSON.stringify({ queue: { pid: 97, log: join(state, 'none.log'), prs: [12, 13], at: 'A' } }))
  const markers: string[] = []
  const view = readView(state, (_pid, marker) => {
    markers.push(marker)
    return marker === 'merge-with-finish.'
  }, true)
  assert.deepEqual(markers, ['merge-with-finish.'])
  assert.deepEqual(view.prs, {
    12: { place: 'turn', rank: 1, reason: '차례 시작', at: 'A' },
    13: { place: 'queued', rank: 2, reason: '#12 차례 대기', at: 'A' },
  })
  // 큐 프로세스가 끝났으면 도는 큐가 없다
  assert.deepEqual(readView(state, () => false, true), { enabled: true, running: false, prs: {}, error: null })
})

test('자동 머지가 꺼지고 차례 기록도 없으면 큐를 쓰지 않는 저장소라 줄이 하나도 없다', () => {
  writeFileSync(join(state, 'loop.log'), LOOP_LOG)
  writeFileSync(join(state, 'auto-merge.json'), JSON.stringify({ queue: { pid: 97, log: join(state, 'none.log'), prs: [12], at: 'A' } }))
  assert.deepEqual(readView(state, () => true, false), { enabled: false, running: false, prs: {}, error: null })
})

test('자동 머지가 꺼져도 코디네이터가 건 큐의 차례 기록이 살아 있으면 큐 안 PR 만 보인다', () => {
  writeFileSync(join(state, 'loop.log'), LOOP_LOG)
  mkdirSync(join(state, 'queue-turn'))
  writeFileSync(join(state, 'queue-turn', '99.json'), JSON.stringify({ pid: 99, prs: [20, 21], pr: 20, phase: '머지', since: 'S' }))
  const view = readView(state, (pid, marker) => pid === 99 && marker === 'merge_queue.', false)
  assert.equal(view.enabled, true)
  assert.deepEqual(Object.keys(view.prs).sort(), ['20', '21'])
})

test('설정의 queue.auto_merge 가 true 일 때만 켜진 것으로 보고, 설정이 없거나 깨졌으면 꺼진 것으로 본다', () => {
  const orch = join(tmp, 'orch')
  mkdirSync(orch)
  const env = process.env.ORCH_DIR
  process.env.ORCH_DIR = orch
  try {
    assert.equal(autoMergeOn(tmp), false)
    writeFileSync(join(orch, 'config.json'), JSON.stringify({ queue: { auto_merge: true } }))
    assert.equal(autoMergeOn(tmp), true)
    writeFileSync(join(orch, 'config.json'), JSON.stringify({ queue: { auto_merge: false } }))
    assert.equal(autoMergeOn(tmp), false)
    writeFileSync(join(orch, 'config.json'), '{')
    assert.equal(autoMergeOn(tmp), false)
  } finally {
    if (env === undefined) delete process.env.ORCH_DIR
    else process.env.ORCH_DIR = env
  }
})

test('상태 폴더가 없으면 error 에 이유를 두고 0 으로 끝난다', () => {
  const got = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', tmp], { encoding: 'utf8', env: { ...process.env, ORCH_DIR: join(tmp, 'nowhere') } })
  assert.equal(got.status, 0, got.stderr)
  const out = JSON.parse(got.stdout)
  assert.equal(out.enabled, false)
  assert.equal(out.running, false)
  assert.deepEqual(out.prs, {})
  assert.match(out.error, /orch 상태 폴더가 없다/)
})

test('--repo 가 없으면 사용법 오류로 2 를 낸다', () => {
  const got = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT], { encoding: 'utf8' })
  assert.equal(got.status, 2)
  assert.match(got.stderr, /--repo 가 필요하다/)
})
