// orch worker continue: 머지 전에 worker_done 을 보낸 worker 를 같은 워크트리에서 이어 맡기는 명령을 가짜 orca, gh, send-to-worker 로 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { fakeBin, type FakeBin } from './fixtures/fake-bin.ts'
import { continueNote } from '../scripts/lib/continue-worker.ts'
import { recordLaunch } from '../scripts/lib/launched.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/worker/continue-worker.ts', import.meta.url))
let repo: string, orca: FakeBin, gh: FakeBin, env: NodeJS.ProcessEnv
const saved = { ...process.env }
const result = (value: unknown) => JSON.stringify({ ok: true, result: value })
const PR = [{ number: 7, title: '제목', url: 'https://x/7', headRefName: 'feat/x' }]

function setup(options: { status?: string; prs?: unknown[]; spec?: string; completion?: 'none'; sendCode?: number; branch?: false } = {}) {
  const spec = join(repo, 'spec-x.md')
  writeFileSync(spec, options.spec ?? '# 작업\n\n브랜치: `feat/x`\n허락: PR 생성까지 허락했다.\n')
  recordLaunch(repo, { dispatch: 'd1', terminal: 'worker', worktree: repo, run: 'R', spec, ...(options.branch === false ? {} : { branch: 'feat/x' }), ...(options.completion ? { completion: options.completion } : {}) })
  orca.setRules([{ args: ['worker-show'], stdout: result({ dispatch: { id: 'd1', status: options.status ?? 'completed' } }) }])
  gh.setRules([{ args: ['list'], stdout: JSON.stringify(options.prs ?? PR) }])
  const send = join(repo, 'send.ts')
  writeFileSync(send, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(repo, 'send.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n')\nconsole.log('FOLLOW-UP d1 d2 task2')\nprocess.exitCode = ${options.sendCode ?? 0}\n`)
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
  assert.deepEqual(args, ['--dispatch', 'd1', '--spec', join(repo, 'spec-x.md'), '--note', continueNote(7), '--run', 'R'])
  assert.match(continueNote(7), /PR #7 이 아직 열려 있다.*머지될 때까지 이 worker 가 맡는다/)
})
test('--run 을 주면 그 Run 으로 보낸다', () => {
  setup()
  assert.equal(run('--dispatch', 'd1', '--run', 'R2').code, 0)
  assert.deepEqual(sent()[0].slice(-2), ['--run', 'R2'])
})
for (const [name, options, reason] of [
  ['열린 PR 이 없으면', { prs: [] }, /열린 PR 이 없다/],
  ['dispatch 가 아직 살아 있으면', { status: 'running' }, /아직 살아 있다/],
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
