import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { decisionEntries, notifyDecisions } from '../scripts/lib/decisions.ts'
import { questionLocations } from '../scripts/lib/questions.ts'
import { fire, handlerFile } from '../scripts/lib/events.ts'
import { registerRun } from '../scripts/lib/loop.ts'

const active = [{ dispatchId: 'd', agentTerminalHandle: 'term_w', dispatchStatus: 'dispatched' }]
const question = (id = 'q', text = '결정: 저장 형식\n권장: JSON') => ({ id, run_id: 'r', type: 'question', from_handle: 'term_w',
  payload: { dispatchId: 'd', question: text }, created_at: id })
let repo: string
const saved = { ...process.env }
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'decision-pending-')))
  mkdirSync(join(repo, '.orch', 'hooks'), { recursive: true })
  mkdirSync(join(repo, '.omc'), { recursive: true })
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
  delete process.env.ORCH_DIR
  const orca = join(repo, 'orca')
  writeFileSync(orca, `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes('send')) { require('node:fs').appendFileSync(process.env.RECEIVED, JSON.stringify(args)+'\\n'); console.log(JSON.stringify({ok:true,result:{message:{id:'notice'}}})); process.exit(0) }
const result = args.includes('worker-list') ? { workers: ${JSON.stringify(active)}, page: {} }
  : args.includes('run-show') ? { run: { coordinator_handle: 'term_stale' } } : {}
console.log(JSON.stringify({ ok: true, result }))
`)
  chmodSync(orca, 0o755)
  process.env.ORCA = orca
  process.env.ORCH_REAL_ORCA = orca
  process.env.RECEIVED = join(repo, 'received.jsonl')
  // 사용자 입력 기록(lib/user-active.ts)을 이 머신의 폴더에서 읽지 않는다
  process.env.ORCH_MACHINE_DIR = join(repo, 'machine')
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  rmSync(repo, { force: true, recursive: true })
})
const received = () => existsSync(process.env.RECEIVED!) ? readFileSync(process.env.RECEIVED!, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
function hook(code = 0): void {
  writeFileSync(join(repo, '.orch', 'hooks', 'decision-pending.ts'), `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(process.env.RECEIVED, readFileSync(0, 'utf8') + '\\n')
process.exitCode = ${code}
`)
}
function board(items: unknown[]): void { writeFileSync(join(repo, '.omc', 'board.json'), JSON.stringify({ items })) }

test('최신 사용자 결정만 고르고 inactive 와 기술 질문은 제외한다', () => {
  const pending = [question('a'), question('b'), question('c', '기술 질문'), { ...question('z'), payload: { dispatchId: 'closed', question: '결정: 이전\n권장: A' } }]
  assert.deepEqual(decisionEntries(pending, [], active), [])
  const found = decisionEntries(pending.slice(0, 2), [], active)
  assert.equal(found.length, 1)
  assert.equal(found[0].question?.id, 'b')
  assert.equal(found[0].key, decisionEntries([question('retry')], [], active)[0].key)
})

test('완료된 줄을 뺀 보드 결정만 고르고 줄 없는 항목은 제목으로 묻는다', () => {
  const items = [
    { id: 'done', status: 'decide', details: [{ text: '끝', done: true }, '✓ 끝난 줄', '[x] 완료'] },
    { id: 'open', status: 'decide', details: [{ text: '남은 결정', done: false }], next: '✓ 끝\n ' },
    { id: 'empty', status: 'decide', title: '정할 제목' },
    { id: 'work', status: 'doing', details: ['구현'] },
  ]
  assert.deepEqual(decisionEntries([], items, []).map((e) => e.item), [{ id: 'open', text: '남은 결정' }, { id: 'empty', text: '정할 제목' }])
})

test('재전송 질문과 미완료 보드 줄은 한 번 알리고 새 결정과 해결 뒤 재등장만 다시 알린다', async () => {
  hook()
  board([{ id: 'b', status: 'decide', details: ['A', 'B'] }])
  await notifyDecisions(repo, 'r', [question()], true)
  await notifyDecisions(repo, 'r', [question('retry')], true)
  assert.equal(received().length, 1)
  assert.equal(received()[0].questions[0].id, 'q')
  board([{ id: 'b', status: 'decide', details: [{ text: 'A', done: true }, 'B'] }])
  await notifyDecisions(repo, 'r', [question()], true)
  assert.equal(received().length, 1)
  await notifyDecisions(repo, 'r', [], false)
  await notifyDecisions(repo, 'r', [question()], false)
  assert.equal(received().length, 2)
  assert.equal(existsSync(join(repo, '.orch', 'state', 'loop-events')), false)
})

test('핸들러 실패 뒤에는 기다렸다 다시 보내고 알림 파일에는 같은 결정을 쌓지 않는다', async () => {
  process.env.ORCH_DECISION_RETRY_SEC = '600'
  const t = Date.parse('2026-11-04T09:00:00Z')
  hook(1)
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t), /전달 실패: 종료 코드 1/)
  hook()
  // 기다리는 동안에는 핸들러를 부르지 않고 같은 이유로 던진다. 루프가 같은 WATCH-ERROR 를 다시 쓰지 않는다
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t + 300_000), /전달 실패: 종료 코드 1/)
  assert.equal(received().length, 1)
  await notifyDecisions(repo, 'r', [question()], false, t + 600_000)
  await notifyDecisions(repo, 'r', [question()], false, t + 700_000)
  assert.equal(received().length, 2)
  assert.equal(existsSync(join(repo, '.orch', 'state', 'loop-events')), false)
})

test('거듭 실패하면 기다리는 시간이 두 배씩 늘고 새 결정이 생기면 바로 보낸다', async () => {
  process.env.ORCH_DECISION_RETRY_SEC = '600'
  const t = Date.parse('2026-11-04T09:00:00Z')
  hook(1)
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t))
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t + 600_000))
  assert.equal(received().length, 2)
  // 두 번째 실패 뒤에는 1200초를 기다린다
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t + 1_700_000))
  assert.equal(received().length, 2)
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false, t + 1_800_000))
  assert.equal(received().length, 3)
  // 묶음이 바뀌면 기다리지 않는다
  board([{ id: 'b', status: 'decide', details: ['새 결정'] }])
  await assert.rejects(notifyDecisions(repo, 'r', [question()], true, t + 1_800_001))
  assert.equal(received().length, 4)
})

test('보드 decide 항목의 참고: 줄은 결정으로 세지 않고, 참고 줄만 있으면 제목으로 묻는다', () => {
  const items = [
    { id: 'mixed', status: 'decide', details: ['참고: 배경 설명', '정할 것', { text: '참고 : 링크', done: false }] },
    { id: 'notes', status: 'decide', title: '제목 결정', details: ['참고: 배경'] },
    { id: 'settled', status: 'decide', details: [{ text: '끝난 결정', done: true }, '참고: 남은 배경'] },
  ]
  assert.deepEqual(decisionEntries([], items, []).map((e) => e.item), [{ id: 'mixed', text: '정할 것' }, { id: 'notes', text: '제목 결정' }])
})

test('코디네이터가 사용자와 대화 중이어도 즉시 전달한다', async () => {
  hook()
  process.env.ORCH_USER_ACTIVE_SEC = '600'
  registerRun(repo, 'r', null, false, 'term_coordinator')
  const t = Date.parse('2026-11-04T09:00:00Z')
  mkdirSync(join(repo, 'machine', 'user-input'), { recursive: true })
  writeFileSync(join(repo, 'machine', 'user-input', 'term_coordinator.json'), JSON.stringify({ at: t }))
  await notifyDecisions(repo, 'r', [question()], false, t + 60_000)
  assert.equal(received().length, 1)
  await notifyDecisions(repo, 'r', [question()], false, t + 600_000)
  assert.equal(received().length, 1)
})

test('다른 Run 은 주 Run 의 보드 결정을 가져가지 않는다', async () => {
  hook()
  board([{ id: 'b', status: 'decide' }])
  await notifyDecisions(repo, 'other', [], false)
  assert.equal(received().length, 0)
  await notifyDecisions(repo, 'r', [], true)
  assert.equal(received().length, 1)
})

test('새 코디네이터로 등록하면 남아 있는 결정을 새 세션에 한 번 전달한다', async () => {
  hook()
  registerRun(repo, 'r', null, false, 'term_old')
  await notifyDecisions(repo, 'r', [question()], false)
  registerRun(repo, 'r', null, false, 'term_new')
  await notifyDecisions(repo, 'r', [question()], false)
  await notifyDecisions(repo, 'r', [question()], false)
  assert.equal(received().length, 2)
})

test('저장소 핸들러가 없으면 기본 핸들러가 그 Run 의 코디네이터를 깨운다', async () => {
  assert.match(handlerFile('decision-pending', repo)!, /scripts\/handlers\/decision-pending.ts$/)
  registerRun(repo, 'r', null, false, 'term_coordinator')
  const result = await fire('decision-pending', { questions: [{ id: 'q', dispatch: 'd' }], items: [] }, { repo, run: 'r', base: 'main' })
  assert.equal(result.result, 'pass', result.reason)
  const args = JSON.parse(readFileSync(process.env.RECEIVED!, 'utf8'))
  assert.equal(args[args.indexOf('--to') + 1], 'run:r')
  assert.match(args[args.indexOf('--body') + 1], /questions=q@dispatch:d/)
  hook()
  assert.equal(handlerFile('decision-pending', repo), join(repo, '.orch', 'hooks', 'decision-pending.ts'))
})

test('기본 핸들러는 터미널 미등록 Run 에도 메시지를 보낸다', async () => {
  const result = await fire('decision-pending', { questions: [], items: [] }, { repo, run: 'r', base: 'main' })
  assert.equal(result.result, 'pass', result.reason)
})

test('질문 위치는 앞 5개와 나머지 수를 내고 dispatch 가 없으면 터미널을 낸다', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, dispatch: `d${i}` }))
  assert.equal(questionLocations(rows), 'questions=q0@dispatch:d0,q1@dispatch:d1,q2@dispatch:d2,q3@dispatch:d3,q4@dispatch:d4 (외 3개)')
  assert.equal(questionLocations([]), 'questions=-')
  assert.equal(questionLocations([{ id: 'q', from_handle: 'term_w' }]), 'questions=q@term_w')
})

test('기본 핸들러는 다른 저장소의 루프가 같은 결정 알림을 이미 보냈으면 다시 보내지 않는다', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'decision-pending-peer-')))
  try {
    mkdirSync(join(other, '.orch'), { recursive: true })
    registerRun(repo, 'r', null, false, 'term_coordinator')
    const input = { questions: [{ id: 'q', dispatch: 'd' }], items: [] }
    assert.equal((await fire('decision-pending', input, { repo, run: 'r', base: 'main' })).result, 'pass')
    assert.equal((await fire('decision-pending', input, { repo: other, run: 'r', base: 'main' })).result, 'pass')
    assert.equal(received().length, 1)
  } finally { rmSync(other, { force: true, recursive: true }) }
})

test('저장소마다 다른 보드 결정은 중복으로 버리지 않고 각각 보낸다', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'decision-pending-peer-')))
  try {
    mkdirSync(join(other, '.orch'), { recursive: true })
    registerRun(repo, 'r', null, false, 'term_coordinator')
    await fire('decision-pending', { questions: [], items: [{ id: 'a', text: '결정 A' }] }, { repo, run: 'r', base: 'main' })
    await fire('decision-pending', { questions: [], items: [{ id: 'b', text: '결정 B' }] }, { repo: other, run: 'r', base: 'main' })
    assert.equal(received().length, 2)
  } finally { rmSync(other, { force: true, recursive: true }) }
})
