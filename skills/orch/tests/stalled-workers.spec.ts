// stalled-workers.ts 를 가짜 orca 와 임시 저장소로 돌려 출력 줄과 종료 코드를 본다. Orca 에는 닿지 않는다.
// 가짜 orca 는 orca.json 의 workers_by_run(Run 마다의 worker-list 행)으로 답하고, 없는 Run 은 실패로 답한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/stalled-workers.ts', import.meta.url))

// 확장자 없는 실행 파일이라 타입 문법을 쓰지 않는다
const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
const st = JSON.parse(fs.readFileSync(process.env.FAKE_DIR + '/orca.json', 'utf8'))
const run = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : null
const rows = (st.workers_by_run || {})[run]
if (argv[1] === 'worker-list' && rows) process.stdout.write(JSON.stringify({ ok: true, result: { workers: rows, page: {} } }) + '\\n')
else { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'runtime_unavailable', message: 'offline' } }) + '\\n'); process.exitCode = 1 }
`

type Json = Record<string, unknown>

let tmp: string
let repo: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stalled-workers-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA)
  chmodSync(join(tmp, 'orca'), 0o755)
  env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, ORCA: join(tmp, 'orca'), FAKE_DIR: tmp, GIT_CEILING_DIRECTORIES: tmp }
  delete env.ORCH_DIR
  delete env.NODE_OPTIONS
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env }).status, 0)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// 파일 하나를 둔 워크트리 폴더. 수정 시각은 지금에서 minutes 분 전이다. git 저장소가 아니라 커밋 시각은 없다
function worktree(name: string, minutes: number): string {
  const path = join(tmp, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'a.txt'), 'x')
  const sec = (Date.now() - minutes * 60_000) / 1000
  utimesSync(join(path, 'a.txt'), sec, sec)
  return path
}

function row(dispatch: string, path: string, extra: Json = {}): Json {
  return { dispatchId: dispatch, dispatchStatus: 'running', agentTerminalHandle: `term_${dispatch}`, resource: { worktreeId: `repo::${path}` }, ...extra }
}

function orca(workers: Record<string, Json[]>): void {
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ workers_by_run: workers }))
}

function board(items: Json[]): void {
  mkdirSync(join(repo, '.omc'), { recursive: true })
  writeFileSync(join(repo, '.omc', 'board.json'), JSON.stringify({ items }))
}

function run(...args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { env, cwd: tmp, encoding: 'utf8' })
  return { code: done.status, lines: done.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')), stderr: done.stderr, stdout: done.stdout }
}

describe('stalled-workers', () => {
  test('오래 움직이지 않은 worker 를 STALLED 로, 움직이는 worker 를 MOVING 으로 내고 3 으로 끝난다', () => {
    orca({ A: [row('d1', worktree('wt-old', 45)), row('d2', worktree('wt-new', 2)), { ...row('d3', '/none'), dispatchStatus: 'completed' }] })
    const got = run('--run', 'A')
    assert.equal(got.code, 3, got.stderr)
    assert.deepEqual(got.lines, [
      ['STALLED', 'd1', 'idle', '45', 'wt-old', 'A'],
      ['MOVING', 'd2', '-', '2', 'wt-new', 'A'],
    ])
  })

  test('짧은 출력은 MOVING 을 빼고 STALLED 만 낸다', () => {
    orca({ A: [row('d1', worktree('wt-old', 45)), row('d2', worktree('wt-new', 2))] })
    env.ORCH_OUTPUT = 'short'
    const got = run('--run', 'A')
    assert.equal(got.code, 3, got.stderr)
    assert.deepEqual(got.lines, [['STALLED', 'd1', 'idle', '45', 'wt-old', 'A']])
  })

  test('멈춘 것이 없으면 0 이고, --idle-min 으로 기준을 바꾼다', () => {
    orca({ A: [row('d1', worktree('wt', 45))] })
    assert.equal(run('--run', 'A', '--idle-min', '60').code, 0)
    assert.equal(run('--run', 'A', '--idle-min', '0').code, 0)
  })

  test('liveness 가 exited 면 움직임과 상관없이 exited 다', () => {
    orca({ A: [row('d1', worktree('wt', 1), { projection: { liveness: { verdict: 'exited' } } })] })
    const got = run('--run', 'A')
    assert.equal(got.code, 3)
    assert.deepEqual(got.lines[0].slice(0, 3), ['STALLED', 'd1', 'exited'])
  })

  test('worker 없는 doing 항목의 끝나지 않은 단계를 STAGE 로 낸다', () => {
    orca({ A: [row('d1', worktree('wt-live', 1))] })
    board([
      { id: 'eval', status: 'doing', worktree: 'wt-gone', details: [{ text: '평가 결과 확인', done: false }] },
      { id: 'busy', status: 'doing', worktree: 'wt-live', details: [{ text: '구현', done: false }] },
    ])
    const got = run('--run', 'A')
    assert.equal(got.code, 3, got.stderr)
    assert.deepEqual(got.lines.at(-1), ['STAGE', 'eval', 'wt-gone', '평가 결과 확인'])
    assert.equal(got.lines.filter((line) => line[0] === 'STAGE').length, 1)
  })

  test('--json 은 workers, stages, errors 를 한 줄로 낸다', () => {
    orca({ A: [row('d1', worktree('wt', 45))] })
    const got = run('--run', 'A', '--run', 'B', '--json')
    assert.equal(got.code, 1)
    const body = JSON.parse(got.stdout) as { workers: Json[]; stages: Json[]; errors: Json }
    assert.equal(body.workers[0].reason, 'idle')
    assert.deepEqual(body.stages, [])
    assert.deepEqual(Object.keys(body.errors), ['B'])
    assert.match(got.stderr, /stalled-workers: B: /)
  })

  test('Run 을 정하지 못하거나 설정과 옵션이 틀리면 2 다', () => {
    orca({})
    assert.equal(run().code, 2)
    assert.equal(run('--run', 'A', '--idle-min', 'x').code, 2)
    mkdirSync(join(repo, '.orch'))
    writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ pipeline: { idle_min: -5 } }))
    const got = run('--run', 'A')
    assert.equal(got.code, 2)
    assert.match(got.stderr, /pipeline\.idle_min/)
  })

  test('--run 이 없으면 config.json 의 finish.run 을 쓴다', () => {
    orca({ R: [row('d1', worktree('wt', 45))] })
    mkdirSync(join(repo, '.orch'))
    writeFileSync(join(repo, '.orch', 'config.json'), JSON.stringify({ finish: { run: 'R' } }))
    const got = run()
    assert.equal(got.code, 3, got.stderr)
    assert.equal(got.lines[0][5], 'R')
  })
})
