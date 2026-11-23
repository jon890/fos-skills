// orch-followup.ts(orch followup list, done)를 임시 저장소와 가짜 마무리로 본다. Orca 와 GitHub 에는 닿지 않는다.
// 가짜 마무리는 받은 인자를 FAKE_LOG 에 적는 python 스크립트다. 확장자대로 python3 로 돈다.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/followup/orch-followup.ts', import.meta.url))
const FAKE_FINISH = `import os, sys
open(os.environ["FAKE_LOG"], "a").write("finish " + " ".join(sys.argv[1:]) + "\\n")
`
const HAS_PYTHON = spawnSync('sh', ['-c', 'command -v python3']).status === 0

type Ctx = { repo: string; log: string; run: (args: string[]) => { code: number | null; stdout: string; stderr: string } }

function setup(t: TestContext): Ctx {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-followup-')))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const repo = join(tmp, 'repo')
  mkdirSync(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  writeFileSync(join(tmp, 'finish.py'), FAKE_FINISH)
  const log = join(tmp, 'log.txt')
  const env: NodeJS.ProcessEnv = { ...process.env, FINISH_PR: join(tmp, 'finish.py'), FAKE_LOG: log, GIT_CEILING_DIRECTORIES: tmp }
  for (const key of ['ORCH_DIR', 'ORCH_OUTPUT', 'BOARD_BIN']) delete env[key]
  const item = (pr: number, extra: Record<string, unknown> = {}) => ({ pr, title: `t${pr}`, text: `smoke ${pr}`, merge_commit: 'a'.repeat(40), deploy: 'success', added_at: '2026-11-20T00:00:00Z', notified_at: null, done_at: null, note: null, ...extra })
  mkdirSync(join(repo, '.orch', 'state'), { recursive: true })
  writeFileSync(join(repo, '.orch', 'state', 'followups.json'), JSON.stringify({ items: [item(787), item(789, { done_at: '2026-11-20T01:00:00Z' })] }))
  return {
    repo, log,
    run: (args) => {
      // 메인 코디네이터 확인은 이 테스트의 범위가 아니라 --not-main 으로 넘긴다
      const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args, '--repo', repo], { env, cwd: tmp, encoding: 'utf8' })
      return { code: done.status, stdout: done.stdout, stderr: done.stderr }
    },
  }
}

const saved = (c: Ctx) => JSON.parse(readFileSync(join(c.repo, '.orch', 'state', 'followups.json'), 'utf8')).items

test('list 는 끝나지 않은 항목만, --all 은 끝난 항목도 낸다', (t) => {
  const c = setup(t)
  assert.deepEqual(c.run(['list']).stdout.trim().split('\n'), ['FOLLOWUP #787 배포 확인 smoke 787'])
  assert.deepEqual(c.run(['list', '--all']).stdout.trim().split('\n'), ['FOLLOWUP #787 배포 확인 smoke 787', 'FOLLOWUP #789 끝남 smoke 789'])
})

test('done 은 항목을 끝내고 그 PR 의 마무리를 다시 띄운다', { skip: !HAS_PYTHON && 'python3 가 필요하다' }, async (t) => {
  const c = setup(t)
  const r = c.run(['done', '787', '--note', '운영 smoke 통과', '--run', 'run_1', '--not-main', '테스트'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^FOLLOWUP-DONE #787$/m)
  assert.match(r.stdout, /^FINISH-STARTED 787 .*finish-787\.out$/m)
  const item = saved(c).find((one: { pr: number }) => one.pr === 787)
  assert.ok(item.done_at)
  assert.equal(item.note, '운영 smoke 통과')
  const deadline = Date.now() + 5000
  while (!existsSync(c.log) && Date.now() < deadline) await sleep(50)
  assert.match(readFileSync(c.log, 'utf8'), /^finish 787 --repo \S+ --pid-file \S+finish-787\.pid --run run_1 --not-main 테스트$/m)
})

test('같은 PR 의 마무리가 돌고 있으면 띄우지 않고 다시 돌기 표시를 남긴다', (t) => {
  const c = setup(t)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  const pidFile = join(c.repo, '.orch', 'queue', 'finish-787.pid')
  mkdirSync(join(c.repo, '.orch', 'queue'), { recursive: true })
  writeFileSync(pidFile, String(child.pid))
  const r = c.run(['done', '787', '--not-main', '테스트'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^FINISH-RUNNING 787 /m)
  // 도는 마무리가 끝날 때 이 표시를 보고 한 번 더 돈다(finish-pr.spec.ts)
  assert.equal(existsSync(join(c.repo, '.orch', 'state', 'finish-rerun', '787')), true)
  assert.equal(existsSync(c.log), false)
})

test('처음 마무리가 다른 pid 파일을 썼으면 그 파일로 도는 마무리를 알아보고, 죽었으면 그 옆에 로그를 쓴다', { skip: !HAS_PYTHON && 'python3 가 필요하다' }, async (t) => {
  const c = setup(t)
  const logDir = join(c.repo, 'other-logs')
  mkdirSync(logDir)
  const pidFile = join(logDir, 'finish-787.pid')
  const file = join(c.repo, '.orch', 'state', 'followups.json')
  writeFileSync(file, JSON.stringify({ items: saved(c).map((one: { pr: number }) => (one.pr === 787 ? { ...one, pid_file: pidFile } : one)) }))
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  writeFileSync(pidFile, String(child.pid))
  const running = c.run(['done', '787', '--no-finish', '--not-main', '테스트'])
  assert.equal(running.code, 0, running.stdout + running.stderr)
  // 끝난 항목을 다시 끝내도 마무리는 다시 띄울 수 있다. 도는 마무리를 알아봐야 둘이 함께 돌지 않는다
  const again = c.run(['done', '787', '--not-main', '테스트'])
  assert.match(again.stdout, new RegExp(`^FINISH-RUNNING 787 ${pidFile}$`, 'm'))
  assert.equal(existsSync(c.log), false)
  child.kill('SIGKILL')
  await sleep(200)
  const started = c.run(['done', '787', '--not-main', '테스트'])
  assert.match(started.stdout, new RegExp(`^FINISH-STARTED 787 ${join(logDir, 'finish-787.out')}$`, 'm'))
  const deadline = Date.now() + 5000
  while (!existsSync(c.log) && Date.now() < deadline) await sleep(50)
  assert.match(readFileSync(c.log, 'utf8'), new RegExp(`--pid-file ${pidFile} `))
})

test('done 은 연결 정보를 저장하기 전에 만든 별도 보드 항목을 끝내고 처음 마무리 옵션을 유지한다', { skip: !HAS_PYTHON && 'python3 가 필요하다' }, async (t) => {
  const c = setup(t)
  const board = join(c.repo, 'boards', 'team.json')
  mkdirSync(join(c.repo, 'boards'), { recursive: true })
  const legacy = { id: 'followup-787', title: '배포 뒤 확인 #787', status: 'wait', details: [{ text: 'smoke 787', done: false }] }
  const parent = { id: 'feature', pr: '#787', status: 'wait' }
  writeFileSync(board, JSON.stringify({ items: [legacy, parent] }))
  const file = join(c.repo, '.orch', 'state', 'followups.json')
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  items[0].finish_args = ['--run', 'run_first', '--board', board, '--complete']
  writeFileSync(file, JSON.stringify({ items }))
  const r = c.run(['done', '787', '--not-main', '테스트'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /FOLLOWUP-BOARD-FAIL/)
  const [completed, ...others] = JSON.parse(readFileSync(board, 'utf8')).items
  assert.equal(completed.status, 'done')
  assert.equal(completed.id, legacy.id)
  assert.equal(completed.title, legacy.title)
  assert.deepEqual(completed.details, legacy.details)
  assert.deepEqual(others, [parent])
  const deadline = Date.now() + 5000
  while (!existsSync(c.log) && Date.now() < deadline) await sleep(50)
  assert.match(readFileSync(c.log, 'utf8'), new RegExp(`^finish 787 --repo \\S+ --pid-file \\S+ --run run_first --board ${board} --complete --not-main 테스트$`, 'm'))
})

test('done 은 연결된 보드에서 해당 PR 의 단계만 끝낸다', (t) => {
  const c = setup(t)
  const board = join(c.repo, 'board.json')
  const steps = [
    { text: '1. [wait] 배포 뒤 확인 (PR 787) · smoke 787', done: false },
    { text: '2. [wait] 배포 뒤 확인 (PR 789) · smoke 789', done: false },
  ]
  writeFileSync(board, JSON.stringify({ items: [{ id: 'feature', status: 'doing', next: steps }] }))
  const file = join(c.repo, '.orch', 'state', 'followups.json')
  const items = saved(c)
  items[0].finish_args = ['--board', board]
  items[0].board_item = 'feature'
  writeFileSync(file, JSON.stringify({ items }))
  for (const expected of ['FOLLOWUP-DONE #787', 'FOLLOWUP-ALREADY #787']) {
    const r = c.run(['done', '787', '--no-finish', '--not-main', '테스트'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.equal(r.stdout.trim(), expected)
  }
  const [row, ...rest] = JSON.parse(readFileSync(board, 'utf8')).items
  assert.deepEqual(rest, [])
  assert.equal(row.id, 'feature')
  assert.equal(row.status, 'doing')
  assert.deepEqual(row.next, [{ ...steps[0], done: true }, steps[1]])
})

test('done 에 --run 을 주면 처음 마무리의 --run 대신 그 값을 준다', { skip: !HAS_PYTHON && 'python3 가 필요하다' }, async (t) => {
  const c = setup(t)
  const file = join(c.repo, '.orch', 'state', 'followups.json')
  const items = JSON.parse(readFileSync(file, 'utf8')).items
  items[0].finish_args = ['--run', 'run_first', '--intermediate']
  writeFileSync(file, JSON.stringify({ items }))
  assert.equal(c.run(['done', '787', '--run', 'run_2', '--not-main', '테스트']).code, 0)
  const deadline = Date.now() + 5000
  while (!existsSync(c.log) && Date.now() < deadline) await sleep(50)
  assert.match(readFileSync(c.log, 'utf8'), /^finish 787 --repo \S+ --pid-file \S+ --intermediate --run run_2 --not-main 테스트$/m)
})

test('같은 PR 의 마무리가 없으면 다시 돌기 표시를 둔 채 새로 띄운다', { skip: !HAS_PYTHON && 'python3 가 필요하다' }, async (t) => {
  const c = setup(t)
  const r = c.run(['done', '787', '--not-main', '테스트'])
  assert.match(r.stdout, /^FINISH-STARTED 787 /m)
  // 분리 실행한 가짜 마무리가 기록을 쓴 뒤에 끝낸다. 먼저 끝내면 임시 폴더를 지우는 사이에 파일이 생긴다
  const deadline = Date.now() + 5000
  while (!existsSync(c.log) && Date.now() < deadline) await sleep(50)
  // 표시는 띄운 마무리가 실행권을 잡으면 지운다. 끝나던 마무리가 아직 쥐고 있어 잡지 못하면 그 마무리가 놓은 뒤 가져간다(lib-finish-claim.spec.ts)
  assert.equal(existsSync(join(c.repo, '.orch', 'state', 'finish-rerun', '787')), true)
})

test('--no-finish 면 마무리를 띄우지 않고, 이미 끝난 항목은 ALREADY, 없는 항목은 MISSING 과 1 이다', (t) => {
  const c = setup(t)
  const done = c.run(['done', '787', '--no-finish', '--not-main', '테스트'])
  assert.equal(done.code, 0, done.stdout + done.stderr)
  assert.doesNotMatch(done.stdout, /FINISH-/)
  assert.match(c.run(['done', '789', '--no-finish', '--not-main', '테스트']).stdout, /^FOLLOWUP-ALREADY #789$/m)
  const missing = c.run(['done', '1', '--not-main', '테스트'])
  assert.equal(missing.code, 1)
  assert.match(missing.stdout, /^FOLLOWUP-MISSING #1$/m)
  assert.equal(existsSync(c.log), false)
})

test('PR 번호가 없거나 모르는 동작이면 사용법 오류다', (t) => {
  const c = setup(t)
  assert.equal(c.run(['done']).code, 2)
  assert.equal(c.run(['remove', '787']).code, 2)
})
