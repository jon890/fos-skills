// orch worker continue: 머지 전에 worker_done 을 보낸 worker 와 보고 없이 턴을 끝낸 worker 를 같은 워크트리에서 이어 맡기는 명령을
// 가짜 orca, gh, send-to-worker 로 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { continueNote, STOP_LIMIT, stoppedNote } from '../scripts/lib/continue-worker.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'
import { recordHistory } from '../scripts/lib/launch-history.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/continue-worker.ts', import.meta.url))
let repo: string, orca: FakeBin, gh: FakeBin, env: NodeJS.ProcessEnv
const saved = { ...process.env }
const result = (value: unknown) => JSON.stringify({ ok: true, result: value })
const PR = [{ number: 7, title: '제목', url: 'https://x/7', headRefName: 'feat/x' }]

type Stage = { activity?: string; backgroundWait?: unknown }
function setup(options: { status?: string; stage?: Stage; prs?: unknown[]; merged?: unknown[]; spec?: string; completion?: 'none'; sendCode?: number; sendOut?: string; branch?: false; at?: string } = {}) {
  const spec = join(repo, 'spec-x.md')
  if (options.at) {
    process.env.ORCH_DIR = join(repo, '.orch')
    recordHistory(repo, { dispatch: 'd1', terminal: 'worker', worktree: repo, run: 'R', spec, branch: 'feat/x', at: options.at, title: null, row: null, retry_of: null })
  }
  writeFileSync(spec, options.spec ?? '# 작업\n\n브랜치: `feat/x`\n허락: PR 생성까지 허락했다.\n')
  recordLaunch(repo, { dispatch: 'd1', terminal: 'worker', worktree: repo, run: 'R', spec, ...(options.branch === false ? {} : { branch: 'feat/x' }), ...(options.completion ? { completion: options.completion } : {}) })
  const projection = options.stage ? { projection: { stage: options.stage } } : {}
  orca.setRules([{ args: ['worker-show'], stdout: result({ dispatch: { id: 'd1', runId: 'R', status: options.status ?? 'completed' }, worker: { worktreeId: repo }, ...projection }) }])
  gh.setRules([{ args: ['merged'], stdout: JSON.stringify(options.merged ?? []) }, { args: ['list'], stdout: JSON.stringify(options.prs ?? PR) }])
  const send = join(repo, 'send.ts')
  writeFileSync(send, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(repo, 'send.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n')\nconsole.log(${JSON.stringify(options.sendOut ?? 'FOLLOW-UP d1 d2 task2')})\nprocess.exitCode = ${options.sendCode ?? 0}\n`)
}
function run(...args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 60_000 })
  return { code: done.status, stdout: done.stdout.trim(), stderr: done.stderr }
}
const sent = () => existsSync(join(repo, 'send.log')) ? readFileSync(join(repo, 'send.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) : []

beforeEach(t => {
  repo = tempDir('continue-worker-', t)
  orca = fakeBin(repo, 'orca', []); gh = fakeBin(repo, 'gh', [])
  env = { ...process.env, ORCH_DIR: join(repo, '.orch'), GIT_CEILING_DIRECTORIES: repo, ORCA: orca.path, GH: gh.path, ORCH_GH_CACHE: '0', SEND_TO_WORKER: join(repo, 'send.ts') }
})
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })

test('열린 PR 이 있고 dispatch 가 끝났으면 지시서와 이유를 후속 지시로 보내고 CONTINUED 를 낸다', () => {
  setup()
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, 'CONTINUED d1 d2 task2 pr=#7')
  const [args] = sent()
  assert.deepEqual(args, ['--dispatch', 'd1', '--spec', join(repo, 'spec-x.md'), '--note', continueNote(7), '--origin', 'returned', '--run', 'R'])
  assert.match(continueNote(7), /PR #7 이 아직 열려 있다.*머지될 때까지 이 worker 가 맡는다/)
})
test('--run 을 주면 그 Run 으로 보낸다', () => {
  setup()
  assert.equal(run('--dispatch', 'd1', '--run', 'R2').code, 0)
  assert.deepEqual(sent()[0].slice(-2), ['--run', 'R2'])
})
for (const [name, options, reason] of [
  ['열린 PR 이 없고 띄운 시각을 모르는데 머지된 PR 이 있으면', { prs: [], merged: [{ number: 6, headRefName: 'feat/x', mergedAt: '2026-11-01T00:00:00Z' }] }, /이미 머지됐다/],
  ['열린 PR 이 없고 띄운 뒤 머지된 PR 이 있으면', { prs: [], at: '2026-11-27T00:00:00Z', merged: [{ number: 6, headRefName: 'feat/x', mergedAt: '2026-11-27T01:00:00Z' }] }, /이미 머지됐다/],
  ['dispatch 가 아직 살아 있으면', { status: 'running' }, /아직 살아 있다/],
  ['살아 있는 dispatch 가 작업 중이면', { status: 'dispatched', stage: { activity: 'working' } }, /아직 살아 있다/],
  ['턴을 끝냈어도 백그라운드 작업을 기다리면', { status: 'dispatched', stage: { activity: 'done', backgroundWait: { since: 1 } } }, /아직 살아 있다/],
  ['리뷰 worker 면', { spec: '# 리뷰\n\n리뷰 PR: #9\n브랜치: `review/pr-9`\n' }, /리뷰 worker/],
  ['PR 없는 작업이면', { completion: 'none' as const }, /PR 없는 작업/],
  ['브랜치를 모르면', { spec: '# 작업\n허락: x\n', branch: false as const }, /브랜치를 모른다/],
] as const) test(`${name} CONTINUE-SKIP 이고 보내지 않는다`, () => {
  setup(options)
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 3, r.stdout + r.stderr)
  assert.match(r.stdout, /^CONTINUE-SKIP d1 /); assert.match(r.stdout, reason)
  assert.deepEqual(sent(), [])
})
test('send-to-worker 가 실패하면 CONTINUE-FAIL 과 1 이다', () => {
  setup({ sendCode: 1 })
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 1)
  assert.match(r.stdout, /^CONTINUE-FAIL d1 send-to-worker 가 종료 코드 1/)
})
test('기록에 없는 dispatch 는 CONTINUE-SKIP 이고 --dispatch 가 없으면 사용법 오류 2 다', () => {
  setup()
  const missing = run('--dispatch', 'nope')
  assert.equal(missing.code, 3); assert.match(missing.stdout, /이 dispatch 가 없다/)
  const usage = run()
  assert.equal(usage.code, 2); assert.match(usage.stderr, /--dispatch 가 필요하다/)
})
test('PR 을 열기 전에 끝난 dispatch 는 남은 할 일을 후속 지시로 보내고 횟수를 적는다', () => {
  setup({ prs: [] })
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, `CONTINUED d1 d2 task2 pr=- tries=1/${STOP_LIMIT}`)
  assert.deepEqual(sent()[0], ['--dispatch', 'd1', '--spec', join(repo, 'spec-x.md'), '--note', stoppedNote(null), '--origin', 'stopped', '--run', 'R'])
  assert.match(stoppedNote(null), /^앞 턴이 보고 없이 끝났다\. 이 턴에서 바로 지시서의 남은 할 일을 이어 한다.*아직 PR 이 없다/)
})
test('살아 있지만 턴을 끝낸 dispatch 에는 본문만 보낸다', () => {
  setup({ prs: [], status: 'dispatched', stage: { activity: 'done' }, sendOut: 'SENT d1 -' })
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, `CONTINUED d1 d1 - pr=- tries=1/${STOP_LIMIT}`)
  assert.deepEqual(sent()[0], ['--dispatch', 'd1', '--no-reply', '--body', stoppedNote(null), '--run', 'R'])
})
test('열린 PR 이 있고 턴을 끝낸 살아 있는 dispatch 에는 머지까지 맡으라고 보낸다', () => {
  setup({ status: 'dispatched', stage: { activity: 'done' }, sendOut: 'SENT d1 -' })
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, `CONTINUED d1 d1 - pr=#7 tries=1/${STOP_LIMIT}`)
  assert.deepEqual(sent()[0].slice(0, 4), ['--dispatch', 'd1', '--no-reply', '--body'])
  assert.match(sent()[0][4], /PR #7 이 열려 있다\. 머지될 때까지 맡고/)
})
test('같은 브랜치와 단계에 상한만큼 보냈으면 더 보내지 않고, PR 이 열리면 다시 센다', () => {
  setup({ prs: [] })
  for (let i = 0; i < STOP_LIMIT; i++) assert.equal(run('--dispatch', 'd1').code, 0)
  const over = run('--dispatch', 'd1')
  assert.equal(over.code, 3, over.stdout)
  assert.match(over.stdout, new RegExp(`^CONTINUE-SKIP d1 feat/x 에 이미 ${STOP_LIMIT}번 이어 보냈다`))
  assert.equal(sent().length, STOP_LIMIT)
  setup({ status: 'dispatched', stage: { activity: 'done' }, sendOut: 'SENT d1 -' })
  assert.equal(run('--dispatch', 'd1').stdout, `CONTINUED d1 d1 - pr=#7 tries=1/${STOP_LIMIT}`)
})
test('보내기가 실패하면 횟수를 올리지 않는다', () => {
  setup({ prs: [], sendCode: 1 })
  assert.equal(run('--dispatch', 'd1').code, 1)
  setup({ prs: [] })
  assert.match(run('--dispatch', 'd1').stdout, /tries=1\//)
})
test('같은 브랜치 이름의 PR 이 이 worker 를 띄우기 전에 머지됐으면 PR 없는 대상으로 이어 보낸다', () => {
  setup({ prs: [], at: '2026-11-27T00:00:00Z', merged: [{ number: 6, headRefName: 'feat/x', mergedAt: '2026-11-20T00:00:00Z' }] })
  const r = run('--dispatch', 'd1')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(r.stdout, `CONTINUED d1 d2 task2 pr=- tries=1/${STOP_LIMIT}`)
})
