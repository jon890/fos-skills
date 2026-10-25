// lib/loop.ts 의 생존 판정과 알림 파일, 커서를 임시 orch 루트(ORCH_DIR)로 본다. loop.json 은 테스트가 직접 쓴다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { appendEvent, eventsFile, isLoopProcess, loopFile, loopStatus, readEvents, recheckMs, writeCursor } from '../scripts/lib/loop.ts'
import { fakeBin } from './fixtures/fake-bin.ts'

let tmp: string
let repo: string
const saved = {
  ORCH_DIR: process.env.ORCH_DIR,
  GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
  ORCH_LOOP_ALIVE_SEC: process.env.ORCH_LOOP_ALIVE_SEC,
  PATH: process.env.PATH,
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-loop-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  process.env.ORCH_DIR = join(tmp, 'orch')
  // 임시 폴더 위의 git 저장소를 올라가 찾지 않게 막는다
  process.env.GIT_CEILING_DIRECTORIES = tmp
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const NOW = Date.parse('2026-10-25T12:00:00.000Z')

function ago(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString()
}

function writeState(fields: Record<string, unknown>): void {
  const file = loopFile(repo)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, run: 'r', repo, tick_sec: 300, started_at: ago(7200), alive_at: ago(10), last_tick: ago(60), ticks: 1, errors: {}, ...fields }),
  )
}

function seqs(): number[] {
  return readEvents(repo).events.map((event) => event.seq)
}

// seq 1..count 의 줄을 파일에 바로 쓴다. appendEvent 를 천 번 부르면 부를 때마다 git 으로 주 checkout 을 찾느라 느리다
function seed(count: number): void {
  const file = eventsFile(repo)
  mkdirSync(dirname(file), { recursive: true })
  const rows = Array.from({ length: count }, (_, i) => JSON.stringify({ seq: i + 1, time: ago(0), kind: 'REMINDER', pr: null, text: `줄 ${i + 1}` }))
  writeFileSync(file, `${rows.join('\n')}\n`)
}

function fileLines(): string[] {
  return readFileSync(eventsFile(repo), 'utf8').split('\n').filter((line) => line)
}

describe('loopStatus', () => {
  test('틱이 65분 걸려도 alive_at 이 새로우면 살아 있다', () => {
    // send-to-worker 가 끝난 dispatch 이어 쓰기를 기다리는 긴 틱이다
    writeState({ alive_at: ago(10), last_tick: ago(65 * 60), tick_sec: 300 })
    const status = loopStatus(repo, NOW)
    assert.equal(status.alive, true, JSON.stringify(status))
  })

  test('alive_at 이 max(3 × tick_sec, 120) 초보다 오래되면 죽었다', () => {
    // tick_sec 10 이면 기준은 120초다. 119초 전은 살아 있고 121초 전은 죽었다
    writeState({ tick_sec: 10, alive_at: ago(119) })
    assert.equal(loopStatus(repo, NOW).alive, true)
    writeState({ tick_sec: 10, alive_at: ago(121) })
    const dead = loopStatus(repo, NOW)
    assert.equal(dead.alive, false)
    assert.ok(!dead.alive && dead.reason === `alive_at ${ago(121)} 이후 응답 없음`, JSON.stringify(dead))
    // tick_sec 300 이면 기준은 900초다
    writeState({ tick_sec: 300, alive_at: ago(899) })
    assert.equal(loopStatus(repo, NOW).alive, true)
  })

  test('끝난 자식 프로세스의 pid 면 죽었다', () => {
    const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    const pid = Number(done.stdout)
    writeState({ pid, alive_at: ago(1) })
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: `pid ${pid} 종료` })
  })

  test('alive_at 만 오래됐고 pid 가 살아 있는 루프 프로세스면 recheck 를 붙이고, 루프가 아닌 프로세스면 붙이지 않는다', async (t) => {
    // 명령줄에 orch-loop 가 든 살아 있는 프로세스다
    const fakeLoop = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'orch-loop'], { stdio: 'ignore' })
    t.after(() => fakeLoop.kill('SIGKILL'))
    await new Promise((resolve) => fakeLoop.once('spawn', resolve))
    writeState({ pid: fakeLoop.pid, tick_sec: 10, alive_at: ago(121) })
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: `alive_at ${ago(121)} 이후 응답 없음`, recheck: true })
    // 이 테스트 프로세스의 명령줄(lib-loop.spec.ts)에는 orch-loop 가 없다
    writeState({ tick_sec: 10, alive_at: ago(121) })
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: `alive_at ${ago(121)} 이후 응답 없음` })
  })

  test('ps 가 실패하면 살아 있는 pid 는 판정할 수 없어(null) recheck 를 붙이고, 죽은 pid 는 루프가 아니다', async (t) => {
    // 명령줄에 orch-loop 가 없는 프로세스다. ps 가 성공하면 recheck 가 붙지 않는다
    const other = spawn('sleep', ['60'], { stdio: 'ignore' })
    t.after(() => other.kill('SIGKILL'))
    await new Promise((resolve) => other.once('spawn', resolve))
    const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    fakeBin(tmp, 'ps', [{ code: 1, stderr: 'ps: 실패\n' }])
    process.env.PATH = `${tmp}${delimiter}${dirname(process.execPath)}${delimiter}${saved.PATH ?? ''}`
    assert.equal(isLoopProcess(other.pid as number), null)
    assert.equal(isLoopProcess(Number(done.stdout)), false)
    writeState({ pid: other.pid, tick_sec: 10, alive_at: ago(121) })
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: `alive_at ${ago(121)} 이후 응답 없음`, recheck: true })
  })

  test('recheckMs 는 ORCH_LOOP_ALIVE_SEC 에 5초를 더하고, 값이 없거나 양수가 아니면 30초에 더한다', () => {
    process.env.ORCH_LOOP_ALIVE_SEC = '0.5'
    assert.equal(recheckMs(), 5_500)
    process.env.ORCH_LOOP_ALIVE_SEC = '0'
    assert.equal(recheckMs(), 35_000)
    delete process.env.ORCH_LOOP_ALIVE_SEC
    assert.equal(recheckMs(), 35_000)
  })

  test('loop.json 이 없거나 깨졌으면 죽었고 이유는 없음이다', () => {
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: '없음' })
    writeState({})
    writeFileSync(loopFile(repo), '{깨짐')
    assert.deepEqual(loopStatus(repo, NOW), { alive: false, reason: '없음' })
  })
})

describe('알림 파일과 커서', () => {
  test('세 줄을 더하면 커서 0 에서 세 줄, 커서 3 에서 빈 목록이다', () => {
    appendEvent(repo, 'REMINDER', null, 'REMINDER q')
    appendEvent(repo, 'WATCH-ERROR', null, 'WATCH-ERROR questions: offline')
    appendEvent(repo, 'CI-FAILED', 12, 'ci')
    const first = readEvents(repo)
    assert.deepEqual(
      first.events.map((event) => [event.seq, event.kind, event.pr, event.text]),
      [
        [1, 'REMINDER', null, 'REMINDER q'],
        [2, 'WATCH-ERROR', null, 'WATCH-ERROR questions: offline'],
        [3, 'CI-FAILED', 12, 'ci'],
      ],
    )
    assert.equal(first.gap, null)
    assert.ok(first.events.every((event) => !Number.isNaN(Date.parse(event.time))), JSON.stringify(first.events))
    // 읽기만으로는 커서를 옮기지 않는다
    assert.deepEqual(seqs(), [1, 2, 3])
    writeCursor(repo, 3)
    assert.deepEqual(readEvents(repo), { events: [], gap: null })
  })

  test('1000 줄을 넘으면 마지막 1000 줄만 남고, 잘라 낸 뒤에도 커서 뒤의 줄을 한 번씩만 낸다', () => {
    seed(1000)
    writeCursor(repo, 1000)
    for (let i = 1000; i < 1005; i++) appendEvent(repo, 'REMINDER', null, `줄 ${i + 1}`)
    const kept = fileLines()
    assert.equal(kept.length, 1000)
    assert.equal(JSON.parse(kept[0]).seq, 6)
    const found = readEvents(repo)
    assert.deepEqual(
      found.events.map((event) => event.seq),
      [1001, 1002, 1003, 1004, 1005],
    )
    assert.equal(found.gap, null)
    writeCursor(repo, 1005)
    assert.deepEqual(readEvents(repo), { events: [], gap: null })
  })

  test('읽지 않은 줄이 잘렸으면 그 구간을 gap 으로 낸다', () => {
    seed(1000)
    for (let i = 1000; i < 1005; i++) appendEvent(repo, 'REMINDER', null, `줄 ${i + 1}`)
    writeCursor(repo, 2)
    const found = readEvents(repo)
    // 커서 2 보다 큰 seq 는 3 부터다. 파일에는 6 부터 남았으므로 3..5 를 잃었다
    assert.deepEqual(found.gap, [3, 5])
    assert.equal(found.events[0].seq, 6)
    assert.equal(found.events.length, 1000)
  })

  test('알림 파일을 지운 뒤 새로 쓰는 쪽도 커서 다음 seq 를 쓴다', () => {
    appendEvent(repo, 'REMINDER', null, 'a')
    writeCursor(repo, 7)
    unlinkSync(eventsFile(repo))
    const event = appendEvent(repo, 'REMINDER', null, 'b')
    assert.equal(event.seq, 8)
    assert.deepEqual(seqs(), [8])
  })

  test('쓰다 끊긴 마지막 줄은 건너뛰고 새 줄을 이어 붙이지 않는다', () => {
    appendEvent(repo, 'REMINDER', null, 'a')
    writeFileSync(eventsFile(repo), `${readFileSync(eventsFile(repo), 'utf8')}{"seq": 2, "ki`)
    appendEvent(repo, 'REMINDER', null, 'b')
    assert.deepEqual(seqs(), [1, 2])
  })
})
