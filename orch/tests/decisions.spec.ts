import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { decisionEntries, notifyDecisions } from '../scripts/lib/decisions.ts'
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
const result = args.includes('worker-list') ? { workers: ${JSON.stringify(active)}, page: {} }
  : args.includes('run-show') ? { run: { coordinator_handle: 'term_stale' } } : {}
console.log(JSON.stringify({ ok: true, result }))
`)
  chmodSync(orca, 0o755)
  process.env.ORCA = orca
  process.env.ORCH_REAL_ORCA = orca
  process.env.RECEIVED = join(repo, 'received.jsonl')
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
  const events = readFileSync(join(repo, '.orch', 'state', 'loop-events', 'r.jsonl'), 'utf8').trim().split('\n')
  assert.equal(events.length, 2)
  assert.equal(JSON.parse(events[0]).kind, 'DECISION-PENDING')
})

test('핸들러 실패는 다음 틱에 다시 보내고 알림 파일에는 같은 결정을 쌓지 않는다', async () => {
  hook(1)
  await assert.rejects(notifyDecisions(repo, 'r', [question()], false), /전달 실패/)
  hook()
  await notifyDecisions(repo, 'r', [question()], false)
  await notifyDecisions(repo, 'r', [question()], false)
  assert.equal(received().length, 2)
  const events = readFileSync(join(repo, '.orch', 'state', 'loop-events', 'r.jsonl'), 'utf8').trim().split('\n')
  assert.equal(events.length, 1)
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
  const nudge = join(repo, 'nudge.ts')
  writeFileSync(nudge, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.RECEIVED, JSON.stringify(process.argv.slice(2)))`)
  process.env.NUDGE_WORKER = nudge
  registerRun(repo, 'r', null, false, 'term_coordinator')
  const result = await fire('decision-pending', { questions: [], items: [] }, { repo, run: 'r', base: 'main' })
  assert.equal(result.result, 'pass', result.reason)
  const args = JSON.parse(readFileSync(process.env.RECEIVED!, 'utf8'))
  assert.equal(args[1], 'term_coordinator')
  assert.match(args[3], /정할 것 묻기: Run r/)
  hook()
  assert.equal(handlerFile('decision-pending', repo), join(repo, '.orch', 'hooks', 'decision-pending.ts'))
})

test('기본 핸들러는 오래된 run-show를 읽지 않고 미등록 Run에는 재등록을 안내한다', async () => {
  const result = await fire('decision-pending', { questions: [], items: [] }, { repo, run: 'r', base: 'main' })
  assert.equal(result.result, 'fail')
  assert.equal(result.reason, '종료 코드 1')
})
