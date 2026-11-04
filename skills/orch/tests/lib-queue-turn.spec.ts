// lib/queue-turn.ts 의 차례 기록 쓰기, 읽기, 지우기와 로그 줄을 임시 git 저장소의 .orch 아래에서 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { clearTurn, finishedTurns, readTurns, turnDir, turnFile, turnLine, writeTurn } from '../scripts/lib/queue-turn.ts'
import type { QueueTurn } from '../scripts/lib/queue-turn.ts'

const NOW = Date.parse('2026-11-04T12:00:00Z')
let repo: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lib-queue-turn-')))
  spawnSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  delete process.env.ORCH_DIR
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

function turn(extra: Partial<QueueTurn> = {}): QueueTurn {
  return { pid: 4242, prs: [9, 10], pr: 9, phase: '체크 대기', since: new Date(NOW - 3 * 60_000).toISOString(), held: [], ...extra }
}

describe('기록', () => {
  test('pid 마다 파일 하나를 .orch/state/queue-turn 에 쓰고, 다시 쓰면 바꾸고, 지우면 없앤다', () => {
    writeTurn(repo, turn())
    writeTurn(repo, turn({ phase: '머지' }))
    assert.equal(turnFile(repo, 4242), join(repo, '.orch', 'state', 'queue-turn', '4242.json'))
    assert.deepEqual(readdirSync(turnDir(repo)), ['4242.json'])
    assert.deepEqual(readTurns(repo, () => true), [turn({ phase: '머지' })])
    clearTurn(repo, 4242)
    assert.equal(existsSync(turnFile(repo, 4242)), false)
    clearTurn(repo, 4242)
  })

  test('머지 큐가 아닌 pid, 형식이 틀린 파일, 이름과 pid 가 다른 파일은 읽지 않는다', () => {
    writeTurn(repo, turn())
    writeTurn(repo, turn({ pid: 7 }))
    writeFileSync(join(turnDir(repo), '8.json'), '{')
    writeFileSync(join(turnDir(repo), '5.json'), JSON.stringify(turn({ pid: 6 })))
    writeFileSync(join(turnDir(repo), '11.json'), JSON.stringify({ ...turn({ pid: 11 }), prs: ['9'] }))
    assert.deepEqual(readTurns(repo, (pid) => pid !== 7).map((t) => t.pid), [4242])
  })

  test('폴더가 없으면 빈 목록이다', () => {
    assert.deepEqual(readTurns(repo, () => true), [])
    assert.deepEqual(finishedTurns(repo, () => true), [])
  })

  test('held 는 형식이 맞는 항목만 읽고 없으면 빈 목록이다. 끝난 큐의 기록은 finishedTurns 가 낸다', () => {
    writeTurn(repo, turn({ held: [{ pr: 9, reason: '9 실패한 체크 1 개' }] }))
    writeFileSync(join(turnDir(repo), '7.json'), JSON.stringify({ ...turn({ pid: 7 }), held: [{ pr: 'x' }, { pr: 8, reason: 'r' }] }))
    writeFileSync(join(turnDir(repo), '6.json'), JSON.stringify({ pid: 6, prs: [], pr: null, phase: '끝', since: 'x' }))
    writeFileSync(join(turnDir(repo), '5.json'), '{')
    assert.deepEqual(readTurns(repo, (pid) => pid === 4242)[0].held, [{ pr: 9, reason: '9 실패한 체크 1 개' }])
    const done = finishedTurns(repo, (pid) => pid === 4242)
    assert.deepEqual(done.map((d) => [d.file.split('/').at(-1), d.turn?.held ?? null]), [
      ['5.json', null],
      ['6.json', []],
      ['7.json', [{ pr: 8, reason: 'r' }]],
    ])
  })
})

describe('turnLine', () => {
  test('pid, 차례, 단계, 분, 남은 PR 을 한 줄로 낸다', () => {
    assert.equal(turnLine(turn(), NOW), 'pid 4242 #9 체크 대기 3분 남은 #9 #10')
    assert.equal(turnLine(turn({ pr: null, prs: [], phase: '머지 뒤 정리' }), NOW), 'pid 4242 차례 없음 머지 뒤 정리 3분 남은 없음')
    assert.equal(turnLine(turn({ since: 'x' }), NOW), 'pid 4242 #9 체크 대기 ?분 남은 #9 #10')
  })
})
