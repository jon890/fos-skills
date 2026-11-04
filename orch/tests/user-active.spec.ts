// lib/user-active.ts 의 대화 중 판정과 user-active.ts 명령을 임시 머신 폴더로 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { inputDir, isAutoPrompt, lastInput, recordInput, userActive } from '../scripts/lib/user-active.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/user-active.ts', import.meta.url))
let tmp: string
const saved = { ...process.env }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'user-active-')))
  process.env.ORCH_MACHINE_DIR = tmp
  delete process.env.ORCH_USER_ACTIVE_SEC
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(tmp, { recursive: true, force: true })
})

test('마지막 사용자 입력이 600초 안이면 대화 중이고 지나면 아니다', () => {
  const t = Date.parse('2026-11-04T09:00:00Z')
  assert.equal(recordInput('term_c', '이건 왜 자꾸 날라오지?', t), true)
  assert.equal(lastInput('term_c'), t)
  assert.deepEqual(userActive('term_c', t + 599_000), { active: true, ago: 599 })
  assert.deepEqual(userActive('term_c', t + 600_000), { active: false, ago: 600 })
  process.env.ORCH_USER_ACTIVE_SEC = '0'
  assert.equal(userActive('term_c', t + 1_000).active, false)
})

test('기록이 없거나 handle 이 아니면 대화 중이 아니고 쓰지 않는다', () => {
  assert.deepEqual(userActive('term_none'), { active: false, ago: null })
  assert.deepEqual(userActive(null), { active: false, ago: null })
  assert.equal(recordInput(undefined, '말'), false)
  assert.equal(recordInput('../x', '말'), false)
  assert.ok(!existsSync(inputDir()))
})

test('orch 와 Orca 가 넣는 자동 입력은 사용자 입력으로 세지 않는다', () => {
  for (const prompt of ['대기 없음: Run r', '  정할 것 묻기: Run r', '<task-notification>', 'You have 2 orchestration messages']) {
    assert.equal(isAutoPrompt(prompt), true, prompt)
    assert.equal(recordInput('term_c', prompt), false, prompt)
  }
  assert.equal(isAutoPrompt('대기 없음이 왜 와?'), false)
})

test('쓸 때 7일 넘은 다른 터미널의 기록을 지운다', () => {
  const t = Date.now()
  recordInput('term_old', '말', t)
  const old = join(inputDir(), 'term_old.json')
  const past = new Date(t - 8 * 24 * 3600 * 1000)
  utimesSync(old, past, past)
  recordInput('term_new', '말', t)
  assert.ok(!existsSync(old))
  assert.equal(lastInput('term_new'), t)
})

test('user-active 명령은 대화 중이면 USER-ACTIVE, 아니면 USER-IDLE 한 줄을 낸다', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ORCA_TERMINAL_HANDLE: 'term_me' } })
  let r = run()
  assert.deepEqual([r.status, r.stdout], [0, 'USER-IDLE term_me -\n'])
  recordInput('term_me', '말', Date.now() - 5_000)
  r = run()
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^USER-ACTIVE term_me \d+\n$/)
  recordInput('term_other', '말', Date.now() - 700_000)
  assert.match(run('--terminal', 'term_other').stdout, /^USER-IDLE term_other 7\d\d\n$/)
  assert.equal(run('--terminal', 'nope').status, 2)
})
