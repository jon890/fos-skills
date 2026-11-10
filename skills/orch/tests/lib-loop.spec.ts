// lib/loop.ts 의 생존 판정과 알림 파일, 커서를 임시 orch 루트(ORCH_DIR)로 본다. loop.json 은 테스트가 직접 쓴다.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { isLoopProcess, loopFile, loopStatus, recheckMs, registerRun, registeredRuns } from '../scripts/lib/loop.ts'
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

test('Run 등록은 코디네이터 터미널을 보존하고 --start 재등록 때 갱신한다', () => {
  registerRun(repo, 'r', null, false, 'term_first')
  registerRun(repo, 'r', 'specs', false)
  assert.deepEqual(registeredRuns(repo), [{ run: 'r', specs_dir: 'specs', registered_at: registeredRuns(repo)[0].registered_at, coordinator_terminal: 'term_first' }])
  registerRun(repo, 'r', null, false, 'term_current')
  assert.equal(registeredRuns(repo)[0].coordinator_terminal, 'term_current')
})

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
