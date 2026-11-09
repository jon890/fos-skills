// orch-status.ts(사람용 요약 orch status)를 가짜 orca 와 임시 저장소로 본다. 읽기만 하는지도 본다. Orca 에는 닿지 않는다.
// 가짜 orca 는 orca.json 의 workers_by_run(Run 마다의 worker-list 행)으로 답하고, 없는 Run 은 실패로 답한다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/status/orch-status.ts', import.meta.url))
const ENTRY = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))

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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-status-')))
  repo = join(tmp, 'repo')
  mkdirSync(repo)
  writeFileSync(join(tmp, 'orca'), FAKE_ORCA)
  chmodSync(join(tmp, 'orca'), 0o755)
  env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, ORCA: join(tmp, 'orca'), FAKE_DIR: tmp, GIT_CEILING_DIRECTORIES: tmp }
  for (const key of ['ORCH_DIR', 'NODE_OPTIONS', 'ORCH_OUTPUT', 'ORCH_SCRIPTS_DIR']) delete env[key]
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env }).status, 0)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function write(rel: string, body: unknown): void {
  const target = join(repo, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body))
}

// 수정 시각이 minutes 분 전인 파일 하나를 둔 워크트리 폴더. 기본은 이 저장소 아래(<repo>/worktrees/<name>)다
function worktree(name: string, minutes: number, root = join(repo, 'worktrees')): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'a.txt'), 'x')
  const sec = (Date.now() - minutes * 60_000) / 1000
  utimesSync(join(path, 'a.txt'), sec, sec)
  return path
}

function row(dispatch: string, path: string): Json {
  return { dispatchId: dispatch, dispatchStatus: 'running', agentTerminalHandle: `term_${dispatch}`, resource: { worktreeId: `repo::${path}` } }
}

// 살아 있는 루프(pid 는 이 테스트 프로세스)와 등록 Run 둘, 보드(doing 둘, decide 하나)
function scene(): void {
  const now = new Date().toISOString()
  write('.orch/state/loop.json', { pid: process.pid, run: 'r1', repo, tick_sec: 300, started_at: now, alive_at: now, last_tick: now, ticks: 1, errors: {}, runs: ['r1', 'r2'] })
  for (const run of ['r1', 'r2']) write(`.orch/state/loop-runs/${run}.json`, { run, specs_dir: null, registered_at: now, coordinator_terminal: null })
  write('.omc/board.json', { items: [{ id: 'a', status: 'doing' }, { id: 'b', status: 'doing' }, { id: 'c', status: 'decide' }, { id: 'd', status: 'done' }] })
  writeFileSync(join(tmp, 'orca.json'), JSON.stringify({ workers_by_run: { r1: [row('d1', worktree('wt-old', 45)), row('d2', worktree('wt-new', 2))], r2: [] } }))
}

function status(args: string[] = []) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, '--repo', repo, ...args], { env, cwd: tmp, encoding: 'utf8' })
  return { code: done.status, lines: done.stdout.split('\n').filter(Boolean), stdout: done.stdout, stderr: done.stderr }
}

// 저장소 안 파일의 경로와 수정 시각. 읽기만 하는지 본다
function snapshot(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else out.push(`${relative(repo, full)} ${st.mtimeMs} ${readFileSync(full, 'utf8').length}`)
    }
  }
  walk(repo)
  return out.sort()
}

describe('orch status', () => {
  test('루프, 등록된 Run 마다의 worker, 보드, 멈춘 worker 를 한 번에 내고 아무것도 쓰지 않는다', () => {
    scene()
    const before = snapshot()
    const r = status()
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.match(r.lines[0], new RegExp(`^LOOP-ALIVE ${process.pid} runs=r1,r2 last_tick=\\S+$`))
    assert.deepEqual(r.lines.slice(1), ['RUN r1 workers=2 stalled=1', 'RUN r2 workers=0 stalled=0', 'BOARD doing=2 decide=1', 'STALLED\td1\tidle\t45\twt-old\tr1'])
    assert.deepEqual(snapshot(), before)
  })

  for (const [name, bundle, scope, expectStale] of [
    ['옛 user 번들', '5.12.0', 'user', true],
    ['문자열 pid 의 옛 번들', '5.12.0', 'user', true],
    ['현재 user 번들', '5.13.0', 'user', false],
    ['project 행과 같은 옛 번들', '5.12.0', 'project', true],
    ['개발 checkout', 'checkout', 'user', false],
  ] as const) {
    test(`${name}: 살아 있는 루프의 번들도 판정한다`, () => {
      scene()
      if (name.startsWith('문자열')) {
        const state = JSON.parse(readFileSync(join(repo, '.orch', 'state', 'loop.json'), 'utf8'))
        write('.orch/state/loop.json', { ...state, pid: String(state.pid) })
      }
      const profile = join(tmp, 'Application Support', 'profile')
      const bundleOf = (version: string) => join(profile, 'plugins', 'cache', 'fos-skills', 'fos-skills', version)
      const record = join(profile, 'plugins', 'installed_plugins.json')
      mkdirSync(dirname(record), { recursive: true })
      writeFileSync(record, JSON.stringify({ plugins: { 'fos-skills@fos-skills': [
        { scope: 'user', installPath: bundleOf('5.13.0') },
        ...(scope === 'project' ? [{ scope, installPath: bundleOf(bundle) }] : []),
      ] } }))
      const script = bundle === 'checkout' ? join(tmp, 'repo', 'skills', 'orch', 'scripts', 'loop', 'orch-loop.ts')
        : join(bundleOf(bundle), 'skills', 'orch', 'scripts', 'loop', 'orch-loop.ts')
      const ps = join(tmp, 'ps')
      writeFileSync(ps, `#!${process.execPath}\nconsole.log(${JSON.stringify(` ${process.pid} node ${script} --repo ${repo} --foreground`)})\n`)
      chmodSync(ps, 0o755)
      env.PS = ps
      env.CLAUDE_CONFIG_DIR = profile
      const r = status()
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /^LOOP-ALIVE /m)
      assert.equal(r.lines.includes(`LOOP-STALE ${repo} ${process.pid} ${bundle}`), expectStale, r.stdout)
    })
  }

  test('같은 Run 이 다른 저장소의 worker 도 맡아도 이 저장소의 worker 만 센다', () => {
    scene()
    const other = join(tmp, 'other')
    mkdirSync(other)
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: other, env }).status, 0)
    const rows = JSON.parse(readFileSync(join(tmp, 'orca.json'), 'utf8')) as { workers_by_run: Record<string, Json[]> }
    rows.workers_by_run.r1.push(row('d9', worktree('wt-b', 50, join(other, 'worktrees'))))
    writeFileSync(join(tmp, 'orca.json'), JSON.stringify(rows))
    const r = status(['--run', 'r1'])
    assert.equal(r.code, 0, r.stdout + r.stderr)
    assert.ok(r.lines.includes('RUN r1 workers=2 stalled=1'), r.stdout)
    assert.ok(!r.stdout.includes('d9'), r.stdout)
  })

  test('--run 을 주면 그 Run 만 본다', () => {
    scene()
    const r = status(['--run', 'r2'])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.lines.filter((l) => l.startsWith('RUN ')), ['RUN r2 workers=0 stalled=0'])
    assert.ok(!r.stdout.includes('STALLED'), r.stdout)
  })

  test('루프가 없으면 LOOP-DEAD, Run 이 없으면 Run 줄 없이 보드만 낸다', () => {
    const r = status()
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.lines, [`LOOP-DEAD ${repo} 없음`, 'BOARD doing=0 decide=0'])
  })

  test('worker 목록을 읽지 못한 Run 은 SKIP-WORKERS 이고 1 이다', () => {
    scene()
    const r = status(['--run', 'gone'])
    assert.equal(r.code, 1, r.stdout)
    assert.match(r.stdout, /^SKIP-WORKERS gone /m)
  })

  test('진입점의 orch status 는 작업 폴더 저장소를 채우고 Run 은 채우지 않는다', () => {
    scene()
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'status'], {
      env: { ...env, ORCH_SCRIPTS_DIR: dirname(dirname(SCRIPT)), HOME: join(tmp, 'home') },
      cwd: repo,
      encoding: 'utf8',
    })
    assert.equal(done.status, 0, done.stdout + done.stderr)
    assert.match(done.stdout, /^RUN r1 workers=2 stalled=1$/m)
    assert.match(done.stdout, /^RUN r2 /m)
    assert.doesNotMatch(done.stderr, /run=/)
  })
})
