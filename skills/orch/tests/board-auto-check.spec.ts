// 실제 보드 도구와 임시 git 저장소를 사용하며 Orca 와 GitHub 조회만 가짜다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const script = fileURLToPath(new URL('../scripts/board/auto-check.ts', import.meta.url))
function setup(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'auto-check-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, '.omc'), { recursive: true })
  mkdirSync(join(repo, '.orch/state'), { recursive: true })
  mkdirSync(join(repo, 'docs/plan'), { recursive: true })
  spawnSync('git', ['init', '-b', 'main', repo])
  const board = join(repo, '.omc/board.json')
  const state = join(root, 'state.json')
  const log = join(root, 'calls')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const common = `const fs=require('node:fs'); const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')); `
  writeNodeBin(bin, 'orca', common + `fs.appendFileSync(${JSON.stringify(log)},'orca\\n'); if(s.orcaFail) process.exit(1); fs.writeSync(1,JSON.stringify({ok:true,result:s.rawResult||{workers:s.workers||[]}}));`)
  writeNodeBin(bin, 'gh', common + `if(s.ghFail) process.exit(1); fs.writeSync(1,JSON.stringify(s.prs||[]));`)
  const setState = (value: unknown) => writeFileSync(state, JSON.stringify(value))
  setState({})
  const item = (text = '2. [auto] PR4 (계획: docs/plan)', extra = {}) => ({ id: 'a', status: 'doing', details: [{ text: '1. 앞 단계', done: true }, { text, done: false }], ...extra })
  const put = (rows = [item()]) => writeFileSync(board, JSON.stringify({ items: rows }))
  put()
  const extraEnv: Record<string, string> = {}
  const run = (args: string[] = ['a', '--run', 'R'], cwd = repo, entry = script) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', env: { ...process.env,
      ORCH_DIR: join(repo, '.orch'), BOARD_BIN: '', ORCA: join(bin, 'orca'), GH: join(bin, 'gh'), ORCH_GH_CACHE: '0',
      ORCH_MACHINE_DIR: join(root, 'machine'),
      ORCH_SCRIPTS_DIR: fileURLToPath(new URL('../scripts', import.meta.url)), ORCH_OUTPUT: '', ...extraEnv,
    } })
    return { ...result, first: result.stdout.trim().split('\n')[0] }
  }
  const launch = (text = '2. [auto] PR4 (계획: docs/plan)') => writeFileSync(join(repo, '.orch/state/step-launches.jsonl'), JSON.stringify({ item: 'a', step: text, dispatch: 'ctx_9', branch: 'feat/x' }) + '\n')
  return { repo, root, board, log, put, item, run, setState, launch, extraEnv }
}

test('통과는 읽기만 하고 진입점에서는 판정 줄만 보인다', t => {
  const c = setup(t)
  const before = readFileSync(c.board, 'utf8')
  const r = c.run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.first, 'AUTO-OK a 2 계획: docs/plan')
  assert.equal(readFileSync(c.board, 'utf8'), before)
  assert.equal(existsSync(join(c.repo, '.orch/state/step-launches.jsonl')), false)
  const entry = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
  const short = c.run(['board', 'auto-check', 'a', '--run', 'R'], c.repo, entry)
  assert.equal(short.status, 0, short.stderr)
  assert.equal(short.stdout.trim(), r.first)
})

test('스펙 확인 줄과 경로, 근거 유무를 확인한다', t => {
  const c = setup(t)
  for (const [content, want] of [['# 스펙\n\n확인: 2026-11-10\n\n## 범위\n', 'AUTO-OK'], ['# 스펙\n', '스펙에 확인 줄이 없다'], ['# 스펙\n확인: 2026-02-30\n', '스펙에 확인 줄이 없다'], ['# 스펙\n```\n확인: 2026-11-10\n```\n', '스펙에 확인 줄이 없다']]) {
    writeFileSync(join(c.repo, 'spec.md'), content)
    c.put([c.item('2. [auto] 다음 (스펙: spec.md)')])
    assert.ok(c.run().first.includes(want))
  }
  for (const [text, want] of [['2. [auto] 다음 (스펙: missing)', '스펙 파일이 없다'], ['2. [auto] 다음 (계획: missing)', '계획 파일이 없다'], ['2. [auto] PR4', '근거가 없다']]) {
    c.put([c.item(text)])
    assert.equal(c.run().first, `AUTO-REJECT a 2 ${want}`)
  }
  c.put([c.item(`2. [auto] 다음 (계획: ${c.root})`)])
  assert.equal(c.run().status, 0)
})

test('연결 워크트리에서 호출해도 기본 checkout 의 보드와 미커밋 계획을 읽는다', t => {
  const c = setup(t)
  const git = (args: string[]) => {
    const r = spawnSync('git', ['-C', c.repo, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init'])
  const worktree = join(c.root, 'worktree')
  git(['worktree', 'add', '-b', 'feat/test', worktree])
  assert.equal(c.run(['a', '--run', 'R'], worktree).status, 0)
  rmSync(join(c.repo, 'docs/plan'), { recursive: true })
  assert.equal(c.run(['a', '--run', 'R'], worktree).first, 'AUTO-REJECT a 2 계획 파일이 없다')
})

test('앞 사건은 완료 꼬리표와 merged-pr 을 모든 항목에서 찾는다', t => {
  const c = setup(t)
  const next = c.item('2. [auto] 다음 (앞 사건: #665 merge)')
  for (const done of [true, false]) {
    c.put([next, { ...c.item(), id: 'other', details: [{ text: '3. 머지 (#665 merge)', done }] }])
    assert.equal(c.run().status, done ? 0 : 1)
  }
  c.put([next, { ...c.item(), id: 'other', 'merged-pr': 665, details: [] }])
  assert.equal(c.run().status, 0)
  c.put([next])
  assert.equal(c.run().first, 'AUTO-REJECT a 2 앞 사건이 끝나지 않았다')
})

test('앞 사건과 관련 없는 마일스톤 항목은 단계 조회 프로세스를 띄우지 않는다', t => {
  const c = setup(t)
  const calls = join(c.root, 'board-calls.jsonl')
  const wrapper = join(c.root, 'board.ts')
  const real = fileURLToPath(new URL('../../../extensions/work-board/bin/board.ts', import.meta.url))
  writeFileSync(wrapper, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); const r=spawnSync(process.execPath,[${JSON.stringify(real)},...args],{stdio:'inherit'}); process.exitCode=r.status;`)
  c.extraEnv.BOARD_BIN = wrapper
  c.put([
    c.item('2. [auto] 다음 (앞 사건: #665 merge) (앞 사건: #665 merge)'),
    { ...c.item(), id: 'related', details: [{ text: '3. 머지 (#665 merge)', done: true }] },
    ...Array.from({ length: 20 }, (_, i) => ({ ...c.item(), id: `other-${i}`, pr: i + 100, stages: 'pr=1,merge=2' })),
  ])
  const r = c.run()
  assert.equal(r.status, 0, r.stderr)
  const read = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(read.map(args => args.slice(0, 2)), [['steps', 'a'], ['steps', 'related']])
})

test('진행 중인지 먼저 확인하고 같은 단계의 재실행을 막는다', t => {
  const c = setup(t)
  c.launch()
  c.setState({ workers: [{ dispatchId: 'ctx_9', taskId: 'task_9', dispatchStatus: 'running', workerState: 'working', agentTerminalHandle: 'term_9', resource: { worktreeId: null, ownershipState: 'owned' } }] })
  assert.equal(c.run().first, 'AUTO-REJECT a 2 worker 나 열린 PR 이 있다')
  c.setState({ prs: [{ number: 9, headRefName: 'feat/x' }] })
  assert.equal(c.run().first, 'AUTO-REJECT a 2 worker 나 열린 PR 이 있다')
  c.setState({})
  assert.equal(c.run().first, 'AUTO-REJECT a 2 이미 한 번 띄웠다')
  c.put([c.item('2. [auto] PR4 (계획: docs/plan) (#700 merge)')])
  assert.equal(c.run().first, 'AUTO-REJECT a 2 이미 한 번 띄웠다')
  c.put([c.item('2. [auto] 다른 일 (계획: docs/plan)')])
  assert.equal(c.run().status, 0)
  c.put([c.item(undefined, { worktree: 'work' })])
  c.setState({ workers: [{ dispatchId: 'ctx_1', taskId: 'task_1', dispatchStatus: 'running', workerState: 'working', agentTerminalHandle: 'term_1', resource: { worktreeId: 'repo::/tmp/work', ownershipState: 'owned' } }] })
  assert.equal(c.run().first, 'AUTO-REJECT a 2 worker 나 열린 PR 이 있다')
})

test('worker 또는 PR 조회 실패와 Run 누락은 진행 중 여부를 알 수 없다고 답한다', t => {
  const c = setup(t)
  for (const state of [{ orcaFail: true }, { ghFail: true }]) {
    c.setState(state)
    assert.equal(c.run().first, 'AUTO-REJECT a 2 worker 나 PR 을 확인하지 못했다')
  }
  c.setState({})
  assert.equal(c.run(['a']).first, 'AUTO-REJECT a 2 worker 나 PR 을 확인하지 못했다')
})

test('필수 키가 빠진 worker 와 깨진 목록은 worker 없음으로 보지 않는다', t => {
  const c = setup(t)
  for (const rawResult of [{}, { workers: null }, { workers: {} }, { workers: [null] }, { workers: [{ dispatchId: 'ctx_live', resource: { worktreeId: 'repo::/tmp/work' } }] }]) {
    c.setState({ rawResult })
    const result = c.run()
    assert.equal(result.status, 1)
    assert.equal(result.first, 'AUTO-REJECT a 2 worker 나 PR 을 확인하지 못했다')
  }
  for (const prs of [[null], [{}], [{ number: 9 }], [{ number: 9, headRefName: '' }]]) {
    c.setState({ prs })
    assert.equal(c.run().first, 'AUTO-REJECT a 2 worker 나 PR 을 확인하지 못했다')
  }
})

test('표시와 첫 미완료 단계, 상태가 맞지 않으면 외부 조회를 하지 않는다', t => {
  const c = setup(t)
  for (const text of ['2. [ask] 다음', '2. [wait] 다음', '2. 다음']) {
    c.put([c.item(text)])
    assert.equal(c.run().first, 'AUTO-REJECT a 2 첫 미완료 단계가 [auto] 가 아니다')
  }
  c.put([c.item(undefined, { stages: 'merge=2' })])
  assert.equal(c.run().first, 'AUTO-REJECT a 2 첫 미완료 단계가 [auto] 가 아니다')
  c.put([c.item(undefined, { details: ['1. 앞 단계', '2. [auto] 다음 (계획: docs/plan)'] })])
  assert.equal(c.run().first, 'AUTO-REJECT a 1 첫 미완료 단계가 [auto] 가 아니다')
  c.put([c.item(undefined, { status: 'done' })])
  assert.equal(c.run().first, 'AUTO-REJECT a - 상태가 doing 이나 wait 가 아니다')
  assert.equal(c.run(['x', '--run', 'R']).first, 'AUTO-REJECT x - 항목이 없다')
  assert.equal(existsSync(c.log), false)
  rmSync(c.board)
  assert.equal(c.run().first, 'AUTO-REJECT a - 항목이 없다')
})

test('next 단계와 설정 오류, 깨진 보드, 사용법을 구분한다', t => {
  const c = setup(t)
  c.put([c.item(undefined, { details: [], next: ['2. [auto] 다음 (계획: docs/plan)'] })])
  assert.equal(c.run().status, 0)
  writeFileSync(join(c.repo, '.orch/config.json'), JSON.stringify({ board: { auto_advance: false } }))
  assert.equal(c.run().first, 'AUTO-REJECT a - 자동 진행이 꺼져 있다')
  writeFileSync(join(c.repo, '.orch/config.json'), JSON.stringify({ board: { auto_advance: 'no' } }))
  assert.equal(c.run().status, 2)
  rmSync(join(c.repo, '.orch/config.json'))
  writeFileSync(c.board, 'broken')
  const broken = c.run()
  assert.equal(broken.status, 1)
  assert.equal(broken.stdout, '')
  assert.match(broken.stderr, /보드를 읽지 못했다/)
  assert.equal(c.run([]).status, 2)
  assert.equal(c.run(['a', 'b']).status, 2)
})

test('머신의 마지막 사용 한도 알림 뒤 30분 안에는 자동 진행을 거절한다', t => {
  const c = setup(t)
  mkdirSync(join(c.root, 'machine'))
  const file = join(c.root, 'machine/worker-limited.json')
  writeFileSync(file, JSON.stringify({ at: Date.now() }))
  assert.equal(c.run().first, 'AUTO-REJECT a 2 사용 한도 알림 뒤 30분이 지나지 않았다')
  writeFileSync(file, JSON.stringify({ at: Date.now() - 30 * 60_000 }))
  assert.equal(c.run().status, 0)
})
