// 보드 창 전용 명령 bin/approvals.ts 의 where, self, press 를 본다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyAdd, emptyFile } from '../../../skills/orch/scripts/core/approvals.ts'
import type { ApprovalFile } from '../../../skills/orch/scripts/core/approvals.ts'
import { fakeBin } from '../../../skills/orch/tests/fixtures/fake-bin.ts'

const script = fileURLToPath(new URL('../bin/approvals.ts', import.meta.url))
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const workers = (handles: string[] = []) => envelope({ workers: handles.map(agentTerminalHandle => ({ agentTerminalHandle, dispatchId: 'd' })), scope: { source: 'all' }, page: {} })

function fixture(rules: Parameters<typeof fakeBin>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'approvals-bin-'))
  spawnSync('git', ['init', '-q', root])
  const fake = fakeBin(root, 'orca', rules)
  const file = join(root, '.orch/state/approvals.json')
  mkdirSync(join(root, '.orch/state'), { recursive: true })
  const initial: ApprovalFile = applyAdd(emptyFile(), {
    id: 'demo', title: '제목', kind: 'post', run: 'R', terminal: 'term_c', preview: { path: '/p.html', sha256: 'x' },
    item: null, step: null, then: null, real: null, command: null,
  }, new Date()).file
  writeFileSync(file, JSON.stringify(initial))
  const run = (args: string[], terminal: string | null = 'term_c') => {
    const env: NodeJS.ProcessEnv = { ...process.env, ORCH_DIR: join(root, '.orch'), ORCA: fake.path }
    if (terminal === null) delete env.ORCA_TERMINAL_HANDLE; else env.ORCA_TERMINAL_HANDLE = terminal
    const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 })
    return { code: done.status, out: done.stdout.trim(), err: done.stderr.trim() }
  }
  return { root, fake, file, run, read: () => JSON.parse(readFileSync(file, 'utf8')) as ApprovalFile, clean: () => rmSync(root, { recursive: true, force: true }) }
}
const SENT = envelope({ message: { id: 'msg_1' } })
const sends = (f: ReturnType<typeof fixture>) => f.fake.calls().filter(c => c.argv.includes('send'))

test('where 는 orch 상태 폴더의 승인 파일 경로를 낸다', () => {
  const f = fixture([{ stdout: workers() }])
  try {
    const r = f.run(['where', '--repo', f.root])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out.endsWith('/.orch/state/approvals.json'), true)
    assert.equal(f.run(['where']).code, 2)
  } finally { f.clean() }
})

test('self: 터미널 변수가 없으면 worker 가 아니고, worker 목록에 있으면 true, 조회가 실패하면 null 이다', () => {
  const none = fixture([{ stdout: workers() }])
  try { assert.deepEqual(JSON.parse(none.run(['self'], null).out), { terminal: null, worker: false }) } finally { none.clean() }
  const coordinator = fixture([{ stdout: workers() }])
  try { assert.deepEqual(JSON.parse(coordinator.run(['self']).out), { terminal: 'term_c', worker: false }) } finally { coordinator.clean() }
  const worker = fixture([{ stdout: workers(['term_c']) }])
  try { assert.deepEqual(JSON.parse(worker.run(['self']).out), { terminal: 'term_c', worker: true }) } finally { worker.clean() }
  const broken = fixture([{ code: 1 }])
  try {
    const r = broken.run(['self'])
    assert.equal(r.code, 0)
    assert.deepEqual(JSON.parse(r.out), { terminal: 'term_c', worker: null })
  } finally { broken.clean() }
})

test('self --live 는 released 터미널을 읽지 않는다', () => {
  const f = fixture([{ stdout: workers() }])
  try {
    assert.equal(f.run(['self', '--live']).code, 0)
    const states = f.fake.calls().flatMap(c => c.argv.flatMap((a, i) => a === '--terminal-state' ? [c.argv[i + 1]] : []))
    assert.ok(states.includes('active'))
    assert.ok(!states.includes('released'))
    const full = fixture([{ stdout: workers() }])
    try {
      full.run(['self'])
      const all = full.fake.calls().flatMap(c => c.argv.flatMap((a, i) => a === '--terminal-state' ? [c.argv[i + 1]] : []))
      assert.ok(all.includes('released'))
    } finally { full.clean() }
  } finally { f.clean() }
})

test('press: 성공하면 PRESS-OK 와 기록과 신호, 지금 버전이 아니면 종료 코드 1 이고 신호가 없다', () => {
  const f = fixture([{ args: ['send'], stdout: SENT }, { stdout: workers() }])
  try {
    const stale = f.run(['press', 'demo', '9', 'approve', '--origin', 'person', '--repo', f.root])
    assert.deepEqual({ code: stale.code, err: stale.err }, { code: 1, err: '내용이 바뀌었어요' })
    assert.equal(sends(f).length, 0)
    const ok = f.run(['press', 'demo', '1', 'revise', '--note=-제목을 짧게', '--origin', 'person', '--repo', f.root])
    assert.deepEqual({ code: ok.code, out: ok.out }, { code: 0, out: 'PRESS-OK msg_1' })
    const entry = f.read().entries[0]
    assert.equal(entry.note, '-제목을 짧게')
    assert.equal(entry.press?.origin, 'person')
    assert.equal(sends(f).length, 1)
  } finally { f.clean() }
})

test('press: 잘못된 동작과 버전, origin 누락은 종료 코드 2 다', () => {
  const f = fixture([{ stdout: workers() }])
  try {
    for (const args of [
      ['press', 'demo', '1', 'approved', '--origin', 'x', '--repo', f.root],
      ['press', 'demo', 'x', 'approve', '--origin', 'x', '--repo', f.root],
      ['press', 'demo', '0', 'approve', '--origin', 'x', '--repo', f.root],
      ['press', 'demo', '1', 'approve', '--repo', f.root],
      ['press', 'demo', '1', 'approve', '--origin', 'x'],
      ['nothing'],
    ]) assert.equal(f.run(args).code, 2, args.join(' '))
    assert.equal(f.read().entries[0].state, 'open')
  } finally { f.clean() }
})

test('press: worker 터미널은 종료 코드 1 이고 기록이 그대로다', () => {
  const f = fixture([{ args: ['send'], stdout: SENT }, { stdout: workers(['term_c']) }])
  try {
    const r = f.run(['press', 'demo', '1', 'approve', '--origin', 'person', '--repo', f.root])
    assert.equal(r.code, 1)
    assert.match(r.err, /worker 터미널/)
    assert.equal(f.read().entries[0].state, 'open')
  } finally { f.clean() }
})
