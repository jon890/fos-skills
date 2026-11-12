// 실제 틱과 보드 도구를 돌린다. 외부 CLI 와 시간만 격리한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { loopRepo } from './fixtures/orch-loop-repo.ts'
import { writeNodeBin } from './fixtures/merge-queue-fakes.ts'

const script = fileURLToPath(new URL('../scripts/loop/orch-loop.ts', import.meta.url))
const NOW = new Date(2026, 10, 12, 12).getTime()
const MIN = 60_000
type Json = Record<string, any>
function setup(t: TestContext) {
  const root = tempDir('loop-step-ready-', t), repo = join(root, 'repo'), bin = join(root, 'bin')
  loopRepo(repo)
  mkdirSync(bin)
  mkdirSync(join(repo, '.omc'), { recursive: true })
  mkdirSync(join(repo, '.orch/state'), { recursive: true })
  const state = join(root, 'fake.json'), calls = join(root, 'calls.jsonl'), clock = join(root, 'clock.mjs')
  writeFileSync(clock, 'Date.now = () => Number(process.env.TEST_NOW)\n')
  writeFileSync(join(bin, 'sweep.ts'), 'process.exitCode = 0\n')
  const common = `const fs=require('node:fs'); const args=process.argv.slice(2); const st=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')); const flag=n=>args[args.indexOf(n)+1]; `
  writeNodeBin(bin, 'orca', common + `fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); const reply=result=>fs.writeSync(1,JSON.stringify({ok:true,result}));
if(args[1]==='send'){ if((st.sendFail && flag('--subject').startsWith('STEP-READY')) || (st.limitFail && flag('--subject').startsWith('LIMIT-CHECK')))process.exit(1); reply({message:{id:'m'}}) }
else if(args[1]==='worker-list'){ if(st.workerFail)process.exit(1); reply(st.rawWorkers || {workers:st.workers||[],page:{}}) }
else if(args[0]==='terminal' && args[1]==='read') reply({terminal:{tail:st.screen?st.screen.split('\\n'):[]}})
else reply({messages:[]});`)
  writeNodeBin(bin, 'gh', common + `if(st.prFail)process.exit(1); if(args[0]==='api')fs.writeSync(1,'me'); else if(args[1]==='list')fs.writeSync(1,JSON.stringify(st.prs||[])); else if(args[1]==='view' && args.includes('state'))fs.writeSync(1,st.prState||'OPEN'); else fs.writeSync(1,'{}');`)
  let config: Json = { pipeline: { idle_min: 0, idle_exited: false, authors: ['me'] } }
  const configure = (extra: Json = {}) => { config = { ...config, ...extra }; writeFileSync(join(repo, '.orch/config.json'), JSON.stringify(config)) }
  configure()
  const put = (items: Json[]) => writeFileSync(join(repo, '.omc/board.json'), JSON.stringify({ items }))
  const fake = (value: Json) => writeFileSync(state, JSON.stringify(value))
  fake({})
  let tickNumber = 0
  const tick = (now = NOW, expected = 0) => {
    const done = spawnSync(process.execPath, [script, '--repo', repo, '--run', 'R', '--tick', '--tick-number', String(++tickNumber)], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, ORCH_DIR: join(repo, '.orch'), ORCH_MACHINE_DIR: join(root, 'machine'),
        ORCH_SCRIPTS_DIR: fileURLToPath(new URL('../scripts', import.meta.url)), ORCA: join(bin, 'orca'), GH: join(bin, 'gh'),
        ORCH_GH_CACHE: '0', BOARD_BIN: '', BOARD_SYNC: '', CLEANUP_SWEEP: join(bin, 'sweep.ts'), ORCH_OUTPUT: '',
        NODE_OPTIONS: `--import=${pathToFileURL(clock).href}`, TEST_NOW: String(now) }, timeout: 30_000,
    })
    assert.equal(done.status, expected, done.stderr + done.stdout)
    if (expected !== 0) return { ...done, result: null }
    const line = done.stdout.split('\n').find(line => line.startsWith('{"tick_at":'))
    assert.ok(line, done.stdout)
    const result = JSON.parse(line)
    writeFileSync(join(repo, '.orch/state/loop.json'), JSON.stringify(result))
    return { ...done, result }
  }
  const sent = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]).filter(args => args[1] === 'send' && args[args.indexOf('--subject') + 1].startsWith('STEP-READY')) : []
  const records = () => JSON.parse(readFileSync(join(repo, '.orch/state/step-ready.json'), 'utf8')).notices
  const item = (text = '2. [auto] 다음', extra: Json = {}) => ({ id: 'a', status: 'doing', details: [{ text: '1. 앞 단계', done: true }, { text, done: false }], ...extra })
  const launch = (text = '2. [auto] 다음', extra: Json = {}) => writeFileSync(join(repo, '.orch/state/step-launches.jsonl'), JSON.stringify({ item: 'a', step: text, dispatch: 'd', branch: 'feat/a', ...extra }) + '\n')
  return { root, repo, calls, config: configure, put, fake, tick, sent, records, item, launch }
}
const worker = (extra: Json = {}) => ({ taskId: 't', dispatchId: 'd', dispatchStatus: 'running', workerState: 'working', agentTerminalHandle: 'term_d', resource: { worktreeId: 'repo::/work/a', ownershipState: 'owned' }, ...extra })
const pr = (extra: Json = {}) => ({ number: 7, headRefName: 'feat/a', headRefOid: 'a'.repeat(40), title: 'PR', author: { login: 'me' }, url: 'https://github.com/test/repo/pull/7', baseRefName: 'main', statusCheckRollup: [], ...extra })

test('idle_min=0 에서 알림을 바로 보내고 재시작·꼬리표 변경·worker 실행 뒤에도 중복을 막는다', t => {
  const c = setup(t)
  c.put([c.item()])
  c.tick()
  assert.equal(c.sent().length, 1)
  const args = c.sent()[0], value = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(value('--to'), 'run:R')
  assert.equal(value('--subject'), 'STEP-READY a auto 2. [auto] 다음')
  assert.equal(value('--body'), 'a auto 2. [auto] 다음')
  assert.deepEqual(JSON.parse(value('--payload')), { source: 'orch-loop', kind: 'STEP-READY', pr: null, repo: c.repo })
  c.tick()
  c.put([c.item('2. [auto] 다음 (#700 merge)')]); c.tick()
  c.fake({ workers: [worker()] }); c.put([c.item(undefined, { worktree: 'a' })]); c.tick()
  c.fake({}); c.tick()
  assert.equal(c.sent().length, 1)
  c.put([c.item('2. [auto] 바뀐 일')]); c.tick()
  assert.equal(c.sent().length, 2)
  c.put([c.item(undefined, { status: 'done' })]); c.tick()
  assert.deepEqual(c.records(), {})
})

test('auto 는 worker·PR·조회 실패 때 보류하고 ask 는 바로 알린다', t => {
  const c = setup(t)
  for (const fake of [{ workers: [worker({ resource: { worktreeId: `repo::${c.repo}`, ownershipState: 'owned' } })] }, { prs: [pr({ headRefName: 'main' })] }, { workerFail: true }, { prFail: true }, { rawWorkers: { workers: [{ dispatchId: 'd' }] } }, { rawWorkers: {} }, { rawWorkers: { workers: null } }]) {
    c.put([c.item(undefined, { worktree: 'repo', branch: 'main' })]); c.fake(fake); c.tick()
    assert.equal(c.sent().length, 0)
  }
  c.put([c.item('2. [ask] 결정', { pr: 7, branch: 'feat/a' })]); c.fake({ prs: [pr()], workers: [worker()] }); c.tick()
  assert.equal(c.sent().length, 1)
  c.put([c.item('2. [ask] 다른 결정')]); c.fake({ workerFail: true, prFail: true }); c.tick()
  assert.equal(c.sent().length, 2)
})

test('실패 전송을 기록하지 않아 다음 틱에 재시도하고 목록 실패 때 기존 기록은 유지한다', t => {
  const c = setup(t)
  c.put([c.item()]); c.fake({ sendFail: true }); c.tick()
  assert.deepEqual(c.records(), {})
  c.fake({}); c.tick()
  const before = c.records()
  assert.ok(before.a)
  c.fake({ workerFail: true }); c.tick()
  assert.deepEqual(c.records(), before)
  c.fake({}); c.tick()
  assert.equal(c.sent().length, 2) // 실패 요청과 성공 요청
})

test('지난 시각 wait 는 같은 틱에 끝나고 다음 auto 를 알리며 wait 항목 상태는 유지한다', t => {
  const c = setup(t)
  c.put([c.item(undefined, { status: 'wait', details: [{ text: '1. [wait: 2020-01-01 00:00] 시간', done: false }, { text: '2. [auto] 다음', done: false }] })])
  c.tick()
  const item = JSON.parse(readFileSync(join(c.repo, '.omc/board.json'), 'utf8')).items[0]
  assert.equal(item.details[0].done, true)
  assert.equal(item.status, 'wait')
  assert.equal(c.sent().length, 1)
})

test('false 면 알림을 끄고 시각 wait 는 끝낸다. 잘못된 설정은 시작을 거절한다', t => {
  const c = setup(t)
  c.config({ board: { auto_advance: false } })
  c.put([c.item(undefined, { status: 'wait', details: ['1. [wait: 2020-01-01 00:00] 시간', '2. [auto] 다음'] })])
  c.tick()
  assert.equal(c.sent().length, 0)
  assert.equal(JSON.parse(readFileSync(join(c.repo, '.omc/board.json'), 'utf8')).items[0].details[0].done, true)
  c.config({ board: { auto_advance: 'no' } })
  assert.match(c.tick(NOW, 2).stderr, /board.auto_advance/)
})

test('한도 알림의 최초 전이 시각을 기록하고 30분 뒤 미실행 auto 만 한 번 더 알린다', t => {
  const c = setup(t)
  c.put([c.item()]); c.tick()
  const screen = `• 작업 중\nYou've hit your usage limit\n› Ask Codex to do anything\n  ? for shortcuts`
  c.fake({ workers: [worker()], screen }); c.tick(NOW + MIN)
  const limited = join(c.root, 'machine/worker-limited.json')
  assert.ok(existsSync(limited), 'WORKER-LIMITED 시각 기록 없음')
  const at = JSON.parse(readFileSync(limited, 'utf8')).at
  assert.equal(at, NOW + MIN)
  c.tick(NOW + 2 * MIN)
  assert.equal(JSON.parse(readFileSync(limited, 'utf8')).at, at)
  c.fake({}); c.tick(at + 30 * MIN - 1)
  assert.equal(c.sent().length, 1)
  c.tick(at + 30 * MIN)
  assert.equal(c.sent().length, 2)
  c.tick(at + 31 * MIN)
  assert.equal(c.sent().length, 2)
})

test('실행한 auto 는 연결 필드가 빈 wait 항목이어도 worker 가 끝난 뒤 30분에 멈춤을 알린다', t => {
  const c = setup(t)
  c.config({ pipeline: { idle_min: 30, idle_exited: false, authors: ['me'] } })
  c.put([c.item(undefined, { status: 'wait' })]); c.launch()
  c.fake({ workers: [worker()] }); c.tick()
  c.fake({}); c.tick(NOW + MIN)
  const later = c.tick(NOW + 31 * MIN)
  assert.match(later.stdout, /STAGE-STALLED a - 30분 2\. \[auto\] 다음/)
  const again = c.tick(NOW + 61 * MIN)
  assert.doesNotMatch(again.stdout, /STAGE-STALLED a /)
})


test('번호 없는 참고 줄 앞에서도 wait 는 깨우지 않고 false 의 auto·ask 는 표시 줄의 멈춤을 알린다', t => {
  const c = setup(t)
  c.config({ board: { auto_advance: false }, pipeline: { idle_min: 30, idle_exited: false, authors: ['me'] } })
  c.put(['auto', 'ask', 'wait'].flatMap(mark => ['string', 'object'].map(format => {
    const details = ['참고: 설명', `1. [${mark}] 다음`]
    return c.item(undefined, { id: `${mark}-${format}`, branch: 'gone', details: format === 'string' ? details : details.map(text => ({ text, done: false })) })
  })))
  c.tick()
  const later = c.tick(NOW + 30 * MIN)
  for (const format of ['string', 'object']) {
    assert.match(later.stdout, new RegExp(`STAGE-STALLED auto-${format} gone 30분 1\\. \\[auto\\] 다음`))
    assert.match(later.stdout, new RegExp(`STAGE-STALLED ask-${format} gone 30분 1\\. \\[ask\\] 다음`))
  }
  assert.doesNotMatch(later.stdout, /STAGE-STALLED wait-/)
  assert.doesNotMatch(later.stdout, /STAGE-STALLED .*참고:/)
  assert.equal(c.sent().length, 0)
})

test('한도 확인은 보드 설정 없이 제공자를 읽어 한 시간 뒤 보내고 새 틱 프로세스에서도 중복하지 않는다', t => {
  const c = setup(t)
  c.config({ board: { auto_advance: false } })
  c.fake({ workers: [worker({ projection: { provider: { id: 'claude' } } })], screen: "You've hit your usage limit" })
  c.tick()
  c.fake({})
  const notices = () => readFileSync(c.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    .filter(args => args[1] === 'send' && args[args.indexOf('--subject') + 1].startsWith('LIMIT-CHECK'))
  c.tick(NOW + 60 * MIN - 1)
  assert.equal(notices().length, 0)
  c.tick(NOW + 60 * MIN)
  assert.equal(notices().length, 1)
  const args = notices()[0]
  assert.equal(args[args.indexOf('--to') + 1], 'run:R')
  assert.match(args[args.indexOf('--body') + 1], /claude:.*새로 띄우는 일부터 모델 표의 후보로 돌아온다/)
  c.tick(NOW + 61 * MIN)
  assert.equal(notices().length, 1)
  c.tick(NOW + 120 * MIN)
  assert.equal(notices().length, 2)
})

test('한도 확인 전송이 실패해도 같은 틱의 다음 단계 알림을 보내고 확인 알림은 재시도한다', t => {
  const c = setup(t)
  c.fake({ workers: [worker({ projection: { provider: { id: 'claude' } } })], screen: "You've hit your usage limit" })
  c.tick()
  c.put([c.item()]); c.fake({ limitFail: true })
  c.tick(NOW + 60 * MIN)
  assert.equal(c.sent().length, 1)
  const file = join(c.root, 'machine/worker-limited.json')
  assert.equal(Object.values(JSON.parse(readFileSync(file, 'utf8')).checks).some((row: any) => row.checkedAt), false)
  c.fake({}); c.tick(NOW + 61 * MIN)
  assert.equal(Object.values(JSON.parse(readFileSync(file, 'utf8')).checks).some((row: any) => row.checkedAt), true)
})
