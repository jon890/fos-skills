// lib/refresh.ts 의 설정 읽기와 판정은 순수 함수로, 갈라진 뒤 변경 읽기(forkFiles)는 임시 git 저장소로 본다.
// 예시 경로는 가상의 모노레포(`modules/api/`, `contracts/`)다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { ConfigError } from '../scripts/lib/config.ts'
import type { Config } from '../scripts/lib/config.ts'
import { aheadInQueue, forkFiles, inFlight, readRefresh, refreshSettings, verdict, writeRefresh } from '../scripts/lib/refresh.ts'
import type { ForkFiles, RefreshRecord } from '../scripts/lib/refresh.ts'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const MIN = 60_000

function settings(extra: { pipeline?: Record<string, unknown>; queue?: Record<string, unknown> } = {}) {
  const config: Config = {
    pipeline: { refresh_slots: 2, ...extra.pipeline },
    queue: { require_up_to_date: true, up_to_date_when: 'overlap', shared_paths: ['^contracts/'], ...extra.queue },
  }
  return refreshSettings(config)
}

function behind(pr: string[], base: string[]): ForkFiles {
  return { behind: true, pr, base }
}

describe('refreshSettings', () => {
  test('refresh_slots 가 없으면 0 이고, 0 이면 queue 절의 다른 키를 검사하지 않는다', () => {
    const off = refreshSettings({ queue: { shared_paths: 7 } })
    assert.equal(off.slots, 0)
    assert.equal(off.upToDate, false)
  })

  test('머지 큐와 같은 queue 키를 읽는다. 목록은 머지 큐처럼 잇는다', () => {
    const got = settings({ pipeline: { refresh_worker_paths: ['^contracts/version', 'VERSION$'] }, queue: { docs_glob: ['docs/*', '*.md'], unit_groups: [['web', 'bff']] } })
    assert.equal(got.slots, 2)
    assert.equal(got.upToDate, true)
    assert.equal(got.when, 'overlap')
    assert.equal(got.judge.sharedPaths, '^contracts/')
    assert.deepEqual(got.judge.docsGlobs, ['docs/*', '*.md'])
    assert.deepEqual(got.judge.groups, [['web', 'bff']])
    assert.equal(got.judge.unitPrefix, 'modules/')
    assert.ok(got.workerPaths?.test('contracts/version.txt'))
    assert.ok(got.workerPaths?.test('modules/api/VERSION'))
  })

  test('틀린 값은 ConfigError 다', () => {
    for (const pipeline of [{ refresh_slots: -1 }, { refresh_slots: 1.5 }, { refresh_slots: '2' }, { refresh_slots: 1, refresh_worker_paths: '(' }]) {
      assert.throws(() => refreshSettings({ pipeline }), ConfigError, JSON.stringify(pipeline))
    }
    for (const queue of [{ up_to_date_when: 'never' }, { require_up_to_date: 'yes' }, { shared_paths: '(' }, { unit_groups: [['web']] }]) {
      assert.throws(() => refreshSettings({ pipeline: { refresh_slots: 1 }, queue }), ConfigError, JSON.stringify(queue))
    }
  })
})

describe('verdict', () => {
  test('base 를 품으면 최신화하지 않는다', () => {
    assert.deepEqual(verdict({ behind: false, pr: ['contracts/a.yaml'], base: [] }, settings()), { action: 'skip', reason: '최신' })
  })

  test('overlap 은 머지 큐의 판정이 갱신 필요일 때만 최신화한다', () => {
    assert.equal(verdict(behind(['modules/api/A.java'], ['modules/web/B.java']), settings()).action, 'skip')
    assert.deepEqual(verdict(behind(['modules/api/A.java'], ['modules/api/B.java']), settings()), { action: 'update', reason: '단위 겹침: api' })
    assert.deepEqual(verdict(behind(['modules/api/A.java'], ['contracts/b.yaml']), settings()), { action: 'update', reason: '공용 경로: contracts/b.yaml' })
  })

  test('always 는 뒤처지면 늘 최신화한다', () => {
    const got = verdict(behind(['modules/api/A.java'], ['modules/web/B.java']), settings({ queue: { up_to_date_when: 'always' } }))
    assert.deepEqual(got, { action: 'update', reason: 'base 에 뒤처졌다' })
  })

  test('refresh_worker_paths 에 맞는 파일을 양쪽이 모두 바꿨으면 worker 다. 한쪽만 바꿨으면 update 다', () => {
    const s = settings({ pipeline: { refresh_worker_paths: '^contracts/version' } })
    assert.deepEqual(verdict(behind(['contracts/version.txt', 'modules/api/A.java'], ['contracts/version.txt']), s), {
      action: 'worker',
      reason: '양쪽이 바꾼 worker 판단 파일: contracts/version.txt',
      files: ['contracts/version.txt'],
    })
    assert.equal(verdict(behind(['contracts/a.yaml'], ['contracts/version.txt']), s).action, 'update')
  })
})

describe('aheadInQueue', () => {
  const files = behind(['modules/api/A.java'], ['modules/api/B.java'])
  const changed: Record<number, string[] | null> = { 1: ['modules/web/W.java'], 2: ['modules/api/C.java'], 3: null }

  test('큐에 든 PR 은 앞선 PR 가운데 겹치는 것을 낸다', () => {
    assert.equal(aheadInQueue(9, files, [1, 2, 9], (n) => changed[n] ?? [], settings()), 2)
    assert.equal(aheadInQueue(9, files, [1, 9, 2], (n) => changed[n] ?? [], settings()), null)
  })

  test('큐에 없는 PR 은 남은 PR 전부와 겹치는지 본다. 읽지 못한 PR 은 겹친 것으로 본다', () => {
    assert.equal(aheadInQueue(9, files, [1], (n) => changed[n] ?? [], settings()), null)
    assert.equal(aheadInQueue(9, files, [1, 3], (n) => changed[n] ?? null, settings()), 3)
  })

  test('always 는 앞 PR 이 하나라도 있으면 미룬다', () => {
    assert.equal(aheadInQueue(9, files, [1], (n) => changed[n] ?? [], settings({ queue: { up_to_date_when: 'always' } })), 1)
    assert.equal(aheadInQueue(9, files, [9, 1], (n) => changed[n] ?? [], settings({ queue: { up_to_date_when: 'always' } })), null)
  })
})

describe('inFlight', () => {
  const record = (extra: Partial<RefreshRecord> = {}): RefreshRecord => ({
    base: 'b'.repeat(40),
    from: 'a'.repeat(40),
    at: new Date(NOW - 5 * MIN).toISOString(),
    action: 'update',
    value: 'updated',
    ...extra,
  })

  test('update 를 걸고 HEAD 가 아직 그대로면 10분까지 센다', () => {
    assert.equal(inFlight(record(), 'a'.repeat(40), 'passed', NOW), true)
    assert.equal(inFlight(record({ at: new Date(NOW - 11 * MIN).toISOString() }), 'a'.repeat(40), 'passed', NOW), false)
  })

  test('HEAD 가 바뀐 뒤에는 CI 가 끝날 때까지 센다', () => {
    assert.equal(inFlight(record(), 'c'.repeat(40), 'pending', NOW), true)
    assert.equal(inFlight(record(), 'c'.repeat(40), null, NOW), true)
    assert.equal(inFlight(record(), 'c'.repeat(40), 'passed', NOW), false)
    assert.equal(inFlight(record(), 'c'.repeat(40), 'failed', NOW), false)
  })

  test('실패, worker 없음, 3시간 넘은 기록, worker 가 아직 push 하지 않은 기록은 세지 않는다', () => {
    assert.equal(inFlight(record({ value: 'failed' }), 'a'.repeat(40), 'passed', NOW), false)
    assert.equal(inFlight(record({ action: 'worker', value: 'orphan' }), 'c'.repeat(40), 'pending', NOW), false)
    assert.equal(inFlight(record({ at: new Date(NOW - 181 * MIN).toISOString() }), 'c'.repeat(40), 'pending', NOW), false)
    assert.equal(inFlight(record({ action: 'worker', value: 'd1' }), 'a'.repeat(40), 'passed', NOW), false)
    assert.equal(inFlight(record({ action: 'worker', value: 'd1' }), 'c'.repeat(40), 'pending', NOW), true)
  })
})

describe('기록과 git', () => {
  let tmp: string
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }

  function git(...args: string[]): string {
    const done = spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8', env })
    assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`)
    return done.stdout.trim()
  }

  function commit(files: Record<string, string>): string {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(tmp, name)), { recursive: true })
      writeFileSync(join(tmp, name), body)
    }
    git('add', '-A')
    git('commit', '-q', '-m', 'c')
    return git('rev-parse', 'HEAD')
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lib-refresh-')))
    git('init', '-q', '-b', 'main')
    commit({ 'modules/api/A.java': '1\n' })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('forkFiles 는 갈라진 뒤 양쪽 변경과 뒤처졌는지를 낸다', () => {
    git('checkout', '-q', '-b', 'feat')
    const head = commit({ 'modules/api/A.java': '2\n' })
    git('checkout', '-q', 'main')
    const base = commit({ 'contracts/b.yaml': 'b\n' })
    assert.deepEqual(forkFiles(tmp, base, head), { ok: true, files: { behind: true, pr: ['modules/api/A.java'], base: ['contracts/b.yaml'] } })
    git('checkout', '-q', 'feat')
    git('merge', '-q', '--no-edit', 'main')
    const merged = git('rev-parse', 'HEAD')
    const got = forkFiles(tmp, base, merged)
    assert.ok(got.ok)
    assert.equal(got.files.behind, false)
    assert.equal(forkFiles(tmp, 'f'.repeat(40), head).ok, false)
  })

  test('기록은 번호 순으로 쓰고, 형식이 틀린 항목과 깨진 파일은 빈 것으로 읽는다', () => {
    mkdirSync(join(tmp, '.orch', 'state'), { recursive: true })
    const file = join(tmp, '.orch', 'state', 'refresh.json')
    const row: RefreshRecord = { base: 'b', from: 'a', at: '2026-11-04T00:00:00Z', action: 'update', value: 'updated' }
    writeRefresh(file, tmp, { 10: row, 9: { ...row, action: 'worker', value: 'd1' } })
    assert.deepEqual(Object.keys(readRefresh(file)), ['9', '10'])
    writeFileSync(file, JSON.stringify({ 7: row, x: row, 8: { ...row, action: 'nope' } }))
    assert.deepEqual(readRefresh(file), { 7: row })
    writeFileSync(file, '{')
    assert.deepEqual(readRefresh(file), {})
  })
})
