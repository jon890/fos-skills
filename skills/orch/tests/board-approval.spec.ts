import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { fakeBin } from './fixtures/fake-bin.ts'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import type { ApprovalFile } from '../scripts/core/approvals.ts'
const script = fileURLToPath(new URL('../scripts/board/board-approval.ts', import.meta.url))
const cli = fileURLToPath(new URL('../bin/orch.ts', import.meta.url))
const envelope = (result: unknown) => JSON.stringify({ ok: true, result })
const workers = (handles: string[] = []) => envelope({ workers: handles.map(agentTerminalHandle => ({ agentTerminalHandle, dispatchId: 'd' })), scope: { source: 'all' }, page: {} })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'approval-'))
  spawnSync('git', ['init', '-q', root])
  const preview = join(root, 'preview.html'); writeFileSync(preview, '<p>확인</p>')
  const fake = fakeBin(root, 'orca', [{ stdout: workers() }])
  const env = { ...process.env, ORCH_DIR: join(root, '.orch'), ORCA: fake.path, ORCA_TERMINAL_HANDLE: 'term_c', ORCH_SCRIPTS_DIR: resolve(script, '../..') }
  const file = join(root, '.orch/state/approvals.json')
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as ApprovalFile
  const write = (value: ApprovalFile) => writeFileSync(file, JSON.stringify(value))
  function run(args: string[], entry = script, extra: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, [entry, ...args, '--repo', root], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 })
    return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() }
  }
  const add = (id = 'demo', kind = 'post', extra: string[] = []) => run(['add', id, '--title', '제목', '--kind', kind, '--preview', preview, '--run', 'R', ...extra])
  function approve() {
    const data = read(); const entry = data.entries.at(-1)!
    entry.state = 'approved'; entry.closedAt = new Date().toISOString()
    entry.press = { action: 'approve', terminal: 'term_p', origin: 'human', at: entry.closedAt, nonce: 'n' }
    write(data)
    const payload = { source: 'board-approval', action: 'approve', id: entry.id, version: entry.version, nonce: 'n' }
    fake.setRules([{ args: ['inbox'], stdout: envelope({ messages: [{ from_handle: 'term_sender', payload }] }) }, { stdout: workers() }])
    return payload
  }
  return { root, preview, env, file, fake, read, write, run, add, approve, clean: () => rmSync(root, { recursive: true, force: true }) }
}
test('종류별 필수 인자, 미리보기 해시와 Run·터미널 저장, 입력 거절', () => {
  const f = fixture()
  try {
    for (const [kind, extra] of [['post', []], ['spec', []], ['step', ['--item', 'item', '--step', '2']], ['real', ['--target', '대상', '--change', '변경', '--rollback', '복구']], ['command', ['--command', 'echo ok']]] as const) {
      const result = f.add(kind, kind, [...extra]); assert.equal(result.code, 0, result.err)
      assert.match(result.out, new RegExp(`^APPROVAL-ADD ${kind} ${kind} \\d+$`))
      const entry = f.read().entries.at(-1)!
      assert.equal(entry.run, 'R'); assert.equal(entry.terminal, 'term_c')
      assert.equal(entry.preview?.path ?? null, kind === 'command' ? null : f.preview)
      if (entry.preview) assert.match(entry.preview.sha256, /^[a-f0-9]{64}$/)
    }
    const bad = f.add('bad', 'real', ['--target', 'x']); assert.equal(bad.code, 2); assert.match(bad.err, /--change, --rollback/)
    assert.equal(f.add('bad', 'step').code, 2)
    const missingKind = f.run(['add', 'bad', '--preview', f.preview, '--run', 'R'])
    assert.equal(missingKind.code, 2); assert.match(missingKind.err, /--title, --kind/)
    for (const id of ['a b', 'a:b']) assert.equal(f.add(id).code, 2)
    assert.equal(f.run(['add', 'c', '--title', '명령', '--kind', 'command', '--command', 'echo x', '--run', 'R'], script, { ORCA_TERMINAL_HANDLE: '' }).code, 1)
  } finally { f.clean() }
})
test('없는 미리보기와 빈 Run 은 저장하지 않고 진입점도 Run 누락을 1로 낸다', () => {
  const f = fixture()
  try {
    assert.equal(f.run(['add', 'a', '--title', '제목', '--kind', 'post', '--preview', 'missing', '--run', 'R']).code, 1)
    assert.equal(existsSync(f.file), false)
    assert.equal(f.run(['add', 'a', '--title', '제목', '--kind', 'post', '--preview', f.preview]).code, 1)
    assert.equal(existsSync(f.file), false)
    assert.equal(f.run(['board', 'approval', 'add', 'a', '--title', '제목', '--kind', 'post', '--preview', f.preview], cli).code, 1)
    assert.equal(existsSync(f.file), false)
    const help = spawnSync(process.execPath, [cli, 'board', 'approval', '--help'], { encoding: 'utf8', env: f.env })
    assert.equal(help.status, 0); for (const verb of ['add', 'list', 'cancel', 'check']) assert.match(help.stdout, new RegExp(`approval ${verb}`))
    assert.doesNotMatch(help.stdout, /board sync|approval approve|approval revise/)
  } finally { f.clean() }
})
test('잘못된 인자는 Orca 없이 거절하고 worker 조회 실패는 구분해 안내한다', () => {
  const f = fixture()
  try {
    f.fake.setRules([{ code: 1 }])
    const missing = f.run(['add', 'demo'])
    assert.equal(missing.code, 2); assert.match(missing.err, /--title, --kind/)
    assert.equal(f.run(['add', 'a', '--title', '제목', '--kind', 'post', '--preview', 'missing', '--run', 'R']).code, 1)
    assert.equal(f.run(['add', 'a', '--title', '제목', '--kind', 'post', '--preview', f.preview]).code, 1)
    assert.equal(f.run(['add', 'a', '--step', 'bad']).code, 2)
    assert.equal(f.run(['cancel', 'bad:id']).code, 2)
    assert.equal(f.fake.calls().length, 0)
    for (const result of [f.add(), f.run(['cancel', 'demo'])]) {
      assert.equal(result.code, 1)
      assert.equal(result.err, 'worker 터미널인지 판정하지 못했다. 잠시 뒤 다시 부른다')
    }
    assert.equal(existsSync(f.file), false)
  } finally { f.clean() }
})
test('다시 올리기, 끝난 기록 보존, keep-open, list 와 cancel', () => {
  const f = fixture()
  try {
    assert.equal(f.add().code, 0)
    assert.match(f.add('demo', 'post', ['--keep-open']).out, /1 kept$/)
    assert.match(f.add().out, /2 replaced$/)
    f.approve()
    assert.equal(f.add().code, 0)
    assert.match(f.run(['check', 'demo']).out, /아직 누르지 않음$/)
    assert.equal(f.read().entries[1].state, 'approved')
    const file = f.read(); file.entries.at(-1)!.state = 'revise'; file.entries.at(-1)!.closedAt = new Date().toISOString(); f.write(file)
    assert.equal(f.add().code, 0)
    assert.match(f.run(['board', 'approval', 'list', '--full'], cli).out, /revise v3/)
    assert.equal(f.add('second').code, 0)
    assert.equal(f.run(['list']).out.split('\n').length, 2)
    assert.equal(f.run(['cancel', 'demo', '--reason', 'chat']).out, 'APPROVAL-CANCEL demo')
    assert.equal(f.run(['list']).out.split('\n').length, 1)
    assert.equal(f.run(['cancel', 'missing']).code, 1)
    assert.equal(f.read().entries.find(e => e.version === 4)?.reason, 'chat')
  } finally { f.clean() }
})
test('check 는 승인 신호·미리보기·버전을 대조하고 승인 한 번만 사용한다', () => {
  const f = fixture()
  try {
    assert.equal(f.run(['check', 'missing']).out, 'APPROVAL-REJECT missing 기록 없음')
    f.add(); assert.match(f.run(['check', 'demo']).out, /아직 누르지 않음$/)
    f.approve()
    assert.match(f.run(['check', 'demo', '--version', '2']).out, /버전이 다름$/)
    assert.equal(f.run(['check', 'demo', '--version', '1']).out, 'APPROVAL-OK demo')
    assert.equal(f.read().entries[0].state, 'used')
    assert.match(f.run(['check', 'demo']).out, /이미 사용함$/)
    for (const [state, reason] of [['revise', '고쳐 달라'], ['cancelled', '취소됨']] as const) {
      const data = f.read(); data.entries[0].state = state; f.write(data)
      assert.match(f.run(['check', 'demo']).out, new RegExp(reason + '$'))
    }
    const payload = f.approve()
    f.fake.setRules([{ args: ['inbox'], stdout: envelope({ messages: [{ from_handle: 'worker', payload }] }) }, { args: ['released'], stdout: workers(['worker']) }, { stdout: workers() }])
    assert.match(f.run(['check', 'demo']).out, /worker 가 보냄$/)
    f.fake.setRules([{ args: ['inbox'], stdout: envelope({ messages: [{ payload: { ...payload, nonce: 'other' } }] }) }, { stdout: workers() }])
    assert.match(f.run(['check', 'demo']).out, /신호를 읽지 못함$/)
    writeFileSync(f.preview, '바뀜')
    assert.match(f.run(['check', 'demo']).out, /미리보기가 바뀜$/)
  } finally { f.clean() }
})
test('worker 는 대기를 올리거나 거둘 수 없고 조회 실패도 거절한다', () => {
  const f = fixture()
  try {
    f.add(); const before = readFileSync(f.file, 'utf8')
    for (const rules of [[{ stdout: workers(['term_c']) }], [{ code: 1 }]]) {
      f.fake.setRules(rules)
      assert.equal(f.add().code, 1); assert.equal(f.run(['cancel', 'demo']).code, 1)
      assert.equal(readFileSync(f.file, 'utf8'), before)
    }
  } finally { f.clean() }
})
test('같은 단계의 keep-open 은 열린 대기를 하나만 남긴다', () => {
  const f = fixture()
  try {
    const args = ['--item', 'x', '--step', '2', '--keep-open']
    assert.equal(f.add('step-x-2', 'step', args).code, 0)
    assert.match(f.add('step-x-2', 'step', args).out, /1 kept$/)
    assert.equal(f.run(['list']).out.split('\n').length, 1)
    assert.equal(f.read().seq, 1)
  } finally { f.clean() }
})
test('check 호출자가 worker 이면 다른 세션의 승인을 소모하지 않는다', () => {
  const f = fixture()
  try {
    f.add(); const payload = f.approve()
    f.fake.setRules([{ args: ['inbox'], stdout: envelope({ messages: [{ from_handle: 'term_sender', payload }] }) }, { stdout: workers(['term_worker']) }])
    const result = f.run(['check', 'demo'], script, { ORCA_TERMINAL_HANDLE: 'term_worker' })
    assert.equal(result.code, 1); assert.match(result.out, /worker 가 보냄$/)
    assert.equal(f.read().entries[0].state, 'approved')
    f.fake.setRules([{ args: ['inbox'], stdout: envelope({ messages: [{ from_handle: 'term_sender', payload }] }) }, { code: 1 }])
    assert.match(f.run(['check', 'demo'], script, { ORCA_TERMINAL_HANDLE: 'term_worker' }).out, /신호를 읽지 못함$/)
    assert.equal(f.read().entries[0].state, 'approved')
  } finally { f.clean() }
})
test('깨진 파일은 add 만 옮겨 보존하고 쓰기 때 끝난 지 7일 넘은 기록만 정리한다', () => {
  const f = fixture()
  try {
    f.add(); writeFileSync(f.file, '{')
    assert.equal(f.run(['list']).code, 1)
    const result = f.add(); assert.equal(result.code, 0); assert.match(result.err, /broken-/)
    const broken = readdirSync(resolve(f.file, '..')).find(name => name.includes('.broken-'))!
    assert.equal(readFileSync(join(resolve(f.file, '..'), broken), 'utf8'), '{')
    assert.ok(f.read().seq > 1)
    const data = f.read(); const old = data.entries[0]
    old.createdAt = new Date(Date.now() - 30 * 3600000).toISOString()
    data.seq++; data.entries.push({ ...old, id: 'old', version: data.seq, state: 'used', closedAt: new Date(Date.now() - 8 * 86400000).toISOString() }); f.write(data)
    f.add('new')
    assert.deepEqual(f.read().entries.map(e => e.id), ['demo', 'new'])
  } finally { f.clean() }
})
test('잠금 기다림을 넘기면 1이고 30초 넘은 잠금은 넘겨받는다', () => {
  const f = fixture()
  try {
    f.add(); const lock = f.file + '.lock'; writeFileSync(lock, 'other')
    const result = f.add('locked'); assert.equal(result.code, 1); assert.match(result.err, /잠금을/)
    const old = new Date(Date.now() - 31000); utimesSync(lock, old, old)
    assert.equal(f.add('stale').code, 0)
  } finally { f.clean() }
})
test('신호 조회 중 같은 id 로 다시 올리면 이전 승인을 쓰지 않는다', () => {
  const f = fixture()
  try {
    f.add(); const payload = f.approve()
    const race = linkBin(f.root, 'orca-race', `const {spawnSync}=require('node:child_process'); const args=process.argv.slice(2); if(args.includes('inbox')) { const r=spawnSync(process.execPath, [${JSON.stringify(script)},'add','demo','--title','새 제목','--kind','post','--preview',${JSON.stringify(f.preview)},'--run','R','--repo',${JSON.stringify(f.root)}], {env:{...process.env,ORCA:${JSON.stringify(f.fake.path)}}}); if(r.status!==0) process.exit(2); console.log(${JSON.stringify(envelope({ messages: [{ from_handle: 'term_c', payload }] }))}); } else console.log(${JSON.stringify(workers())});`)
    const result = f.run(['check', 'demo'], script, { ORCA: race })
    assert.equal(result.code, 1, result.err); assert.match(result.out, /아직 누르지 않음$/)
    assert.deepEqual(f.read().entries.map(e => e.state), ['approved', 'open'])
  } finally { f.clean() }
})
