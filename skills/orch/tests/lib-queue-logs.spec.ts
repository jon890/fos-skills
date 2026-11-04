// lib/queue-logs.ts 가 끝난 머지 큐 로그만 휴지통으로 옮기는지 본다. lsof 와 gh 는 host 로 갈아 끼운다.

import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { run } from '../scripts/lib/proc.ts'
import { lsofOpenedBy, type QueueLogHost, sweepQueueLogs } from '../scripts/lib/queue-logs.ts'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const HOUR = 3600_000
let tmp: string
let dir: string
let trash: string
let open: Set<string>
let states: Record<number, string>

const host = (): QueueLogHost => ({
  now: () => NOW,
  openedBy: (file) => open.has(file),
  prStates: (numbers) => new Map(numbers.filter((n) => states[n]).map((n) => [n, states[n]])),
})

// 마지막으로 바뀐 때를 NOW 에서 agoMs 전으로 둔다
function put(name: string, text: string, agoMs = 5 * HOUR): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  const when = new Date(NOW - agoMs)
  utimesSync(file, when, when)
  return file
}

function sweep(apply = true) {
  const lines: string[] = []
  const done = sweepQueueLogs({ dir, trash, apply, log: (line) => lines.push(line), host: host() })
  return { ...done, lines }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'queue-logs-'))
  dir = join(tmp, 'queue')
  trash = join(tmp, 'trash')
  mkdirSync(dir)
  open = new Set()
  states = {}
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('마무리 로그', () => {
  test('끝난 마무리의 로그와 pid 를 휴지통으로 옮긴다', () => {
    const out = put('finish-7.out', 'a\nFINISH-DONE\n')
    const pid = put('finish-7.pid', '999999999')
    const done = sweep()
    assert.deepEqual(done.moved.sort(), [out, pid].sort())
    assert.ok(!existsSync(out) && !existsSync(pid))
    assert.ok(existsSync(join(trash, 'queue', 'finish-7.out')))
    assert.ok(existsSync(join(trash, 'queue', 'finish-7.pid')))
  })

  test('pid 의 프로세스가 살아 있으면 남긴다', () => {
    const out = put('finish-8.out', 'a\nFINISH-DONE\n')
    put('finish-8.pid', String(process.pid))
    sweep()
    assert.ok(existsSync(out))
  })

  test('끝 표시가 없으면 남긴다', () => {
    const out = put('finish-9.out', '머지를 기다린다\n')
    sweep()
    assert.ok(existsSync(out))
  })

  test('끝 표시 없이 pid 만 죽었으면 남길 시간 동안 남기고 지나면 옮긴다', () => {
    const young = put('finish-5.out', '머지를 기다린다\n', HOUR / 2)
    put('finish-5.pid', '999999999')
    const old = put('finish-6.out', '머지를 기다린다\n', 2 * HOUR)
    const oldPid = put('finish-6.pid', '999999999')
    sweep()
    assert.ok(existsSync(young))
    assert.ok(!existsSync(old) && !existsSync(oldPid))
  })

  test('FINISH-FAIL 은 남길 시간 안이면 남기고 지나면 옮긴다', () => {
    const young = put('finish-1.out', 'FINISH-FAIL\n', HOUR / 2)
    const old = put('finish-2.out', 'FINISH-FAIL\n', 2 * HOUR)
    sweep()
    assert.ok(existsSync(young))
    assert.ok(!existsSync(old))
  })
})

describe('머지 큐 로그', () => {
  test('QUEUE-DONE 으로 끝났고 연 프로세스가 없으면 옮긴다', () => {
    const file = put('queue-a.out', '12:00 5 MERGED\nQUEUE-DONE\n')
    sweep()
    assert.ok(!existsSync(file))
  })

  test('연 프로세스가 있으면 남긴다', () => {
    const file = put('queue-b.out', 'QUEUE-DONE\n')
    open.add(file)
    sweep()
    assert.ok(existsSync(file))
  })

  test('끝 표시가 없어도 담긴 PR 이 모두 머지됐으면 옮긴다', () => {
    const file = put('queue-c.log', '12:00 5 판정: 갱신 필요\n12:01 6 MERGED\n')
    states = { 5: 'MERGED', 6: 'CLOSED' }
    sweep()
    assert.ok(!existsSync(file))
  })

  test('열린 PR 이 있거나 상태를 못 읽으면 남긴다', () => {
    const open1 = put('queue-d.out', '12:00 5 판정\n12:01 6 판정\n')
    const unknown = put('queue-e.out', '12:00 7 판정\n')
    states = { 5: 'MERGED', 6: 'OPEN' }
    sweep()
    assert.ok(existsSync(open1) && existsSync(unknown))
  })

  test('STOP 로그는 남길 시간 안이면 남긴다', () => {
    const young = put('queue-f.out', '12:00 5 판정\nSTOP 5 충돌\n', HOUR / 2)
    const old = put('queue-g.out', 'STOP 5 충돌\n', 2 * HOUR)
    sweep()
    assert.ok(existsSync(young))
    assert.ok(!existsSync(old))
  })
})

test('모르는 파일은 남기고 줄도 내지 않는다', () => {
  const file = put('notes.txt', 'QUEUE-DONE\n')
  const done = sweep()
  assert.ok(existsSync(file))
  assert.deepEqual(done.lines, [])
})

test('dry-run 은 옮기지 않고 할 일만 낸다', () => {
  const file = put('finish-3.out', 'FINISH-DONE\n')
  const done = sweep(false)
  assert.ok(existsSync(file))
  assert.deepEqual(done.moved, [file])
  assert.match(done.lines[0], /옮길 것/)
  assert.ok(!existsSync(trash))
})

test('휴지통에 같은 이름이 있으면 번호를 붙인다', () => {
  mkdirSync(join(trash, 'queue'), { recursive: true })
  writeFileSync(join(trash, 'queue', 'finish-4.out'), 'old')
  put('finish-4.out', 'FINISH-DONE\n')
  sweep()
  assert.ok(existsSync(join(trash, 'queue', 'finish-4.out.2')))
})

test('폴더가 없으면 아무것도 하지 않는다', () => {
  rmSync(dir, { recursive: true })
  assert.deepEqual(sweep().moved, [])
})

// host 를 갈아 끼우지 않고 실제 lsof 를 부른다. lsof 가 없는 머신에서는 건너뛴다
describe('lsofOpenedBy', { skip: run(['lsof', '-v']).code === 127 ? 'lsof 가 없다' : false }, () => {
  test('연 프로세스가 있으면 true, 없으면 false 를 낸다', () => {
    const file = put('queue-h.out', 'QUEUE-DONE\n')
    assert.equal(lsofOpenedBy(file), false)
    const fd = openSync(file, 'r')
    try {
      assert.equal(lsofOpenedBy(file), true)
    } finally {
      closeSync(fd)
    }
  })

  test('실제 lsof 로 판정해 끝난 큐 로그를 옮기고 열린 로그는 남긴다', () => {
    const ended = put('queue-i.out', '12:00 5 MERGED\nQUEUE-DONE\n')
    const live = put('queue-j.out', '12:00 6 MERGED\nQUEUE-DONE\n')
    const fd = openSync(live, 'r')
    try {
      sweepQueueLogs({ dir, trash, apply: true, log: () => {}, host: { ...host(), openedBy: lsofOpenedBy } })
    } finally {
      closeSync(fd)
    }
    assert.ok(!existsSync(ended))
    assert.ok(existsSync(live))
  })
})
