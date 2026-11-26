import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { deliver } from '../src/delivery.ts'
import { DUPLICATE_MS, LOCK_MS, PanelState, parseChoice } from '../src/state.ts'
import { parseSummary, readSummary, staleAfter, SummaryWatch } from '../src/summary.ts'
import { at, AUTOMATION_ID, exampleSummary, studyChoice } from './fixtures.ts'

async function isolated(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'study-panel-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('validates timestamps, version, actions, nested data and required fields', () => {
  const summary = exampleSummary()
  assert.equal(parseSummary({ ...summary, extra: true }).status, 'ready')
  assert.deepEqual(parseSummary({ schemaVersion: 2, curatedAt: summary.curatedAt }),
    { status: 'unsupported', curatedAt: summary.curatedAt })
  for (const malformed of [
    { ...summary, updatedAt: '2026-11-27T09:00:00' },
    { ...summary, updatedAt: '2026-02-30T00:00:00Z' },
    { ...summary, study: [{ ...summary.study[0], revision: 0 }] },
    { ...summary, study: [{ ...summary.study[0], question: null }] },
    { ...summary, inProgress: [{ ...summary.inProgress[0], item: { id: 'example' } }] },
    { ...summary, feedbackTotals: { rejected: -1, held: 0 } },
    { ...summary, inProgress: [{ ...summary.inProgress[0], pr: { number: 12, state: 'closed' } }] },
    { ...summary, repositories: undefined }
  ]) assert.equal(parseSummary(malformed).status, 'read_failed')
  assert.equal(parseChoice({ ...studyChoice, answer: 'apply' }), 'invalid_choice')
  assert.equal(parseChoice({ ...studyChoice, answer: 'drop', reason: '둘\n사이' }), 'invalid_reason')
  assert.equal(parseChoice({ ...studyChoice, answer: 'drop', reason: '  ' }), 'invalid_reason')
  assert.deepEqual(parseChoice({ ...studyChoice, answer: 'drop', reason: ' 겹치는 주제 ' }),
    { ...studyChoice, answer: 'drop', reason: '겹치는 주제' })
  assert.deepEqual(parseChoice({ ...studyChoice, reason: '버릴 값', command: '무시' }), studyChoice)
})

test('keeps last good data for broken JSON and uses the latest validated curation time', async (t) => {
  const home = await isolated(t)
  const file = join(home, 'summary.json')
  const summary = exampleSummary()
  const state = new PanelState()
  state.accept(await readSummary(file))
  assert.equal(state.screen(at, true, []).status, 'missing')
  await writeFile(file, JSON.stringify(summary))
  state.accept(await readSummary(file))
  await writeFile(file, '{"broken":')
  state.accept(await readSummary(file))
  const failed = state.screen(at, true, [])
  assert.equal(failed.status, 'read_failed')
  assert.deepEqual(failed.summary, summary)
  const newTime = '2026-11-30T00:00:00Z'
  await writeFile(file, JSON.stringify({ schemaVersion: 2, curatedAt: newTime }))
  state.accept(await readSummary(file))
  assert.equal(state.screen(at, true, []).curatedAt, newTime)
  assert.equal(state.screen(at, true, []).summary, null)
  await rm(file)
  state.accept(await readSummary(file))
  assert.equal(state.screen(at, true, []).curatedAt, summary.curatedAt)
})

test('counts one weekday in Seoul time including the exact weekend boundary', () => {
  const state = new PanelState()
  const summary = exampleSummary()
  state.accept(parseSummary(summary))
  const mondayNine = Date.parse('2026-11-30T09:00:00+09:00')
  assert.equal(staleAfter(summary.curatedAt!), mondayNine)
  assert.equal(state.nextBoundary(at, summary.curatedAt), mondayNine + 1)
  assert.equal(state.screen(mondayNine, true, []).stale, false)
  assert.equal(state.screen(mondayNine + 1, true, []).stale, true)
  assert.equal(staleAfter('2026-11-29T09:00:00+09:00'), Date.parse('2026-12-01T00:00:00+09:00'))
})

test('watches a missing state directory and notices consecutive atomic replacements', { timeout: 10_000 }, async (t) => {
  const home = await isolated(t)
  const watcher = new SummaryWatch()
  t.after(() => watcher.close())
  const directory = join(home, 'state')
  const file = join(directory, 'summary.json')
  let notify: () => void
  const onChange = () => notify()
  async function expectChange(change: () => Promise<unknown>) {
    const noticed = new Promise<void>((resolve) => { notify = resolve })
    watcher.sync(file, onChange)
    await change()
    await noticed
  }
  await expectChange(() => mkdir(directory))
  for (const revision of [1, 2]) {
    const summary = exampleSummary()
    summary.study[0].revision = revision
    const staging = join(directory, 'summary.tmp')
    await expectChange(async () => {
      await writeFile(staging, JSON.stringify(summary))
      await rename(staging, file)
    })
    const latest = await readSummary(file)
    assert.equal(latest.status === 'ready' && latest.summary.study[0].revision, revision)
  }
})

test('releases a lock on a changed card or after ten minutes and deduplicates across revisions', () => {
  const state = new PanelState()
  const summary = exampleSummary()
  state.accept(parseSummary(summary))
  state.record({ ...studyChoice, at, sentAt: new Date(at).toISOString() })
  assert.equal(state.screen(at, true, []).cards[0].status, 'sent')
  assert.equal(state.block(studyChoice, at + DUPLICATE_MS - 1), 'duplicate')
  assert.equal(state.block(studyChoice, at + DUPLICATE_MS), 'locked')
  assert.equal(state.screen(at + LOCK_MS, true, []).cards[0].status, 'waiting')
  assert.equal(state.block(studyChoice, at + LOCK_MS), undefined)
  state.accept(parseSummary({ ...summary, study: [{ ...summary.study[0], revision: 2 }] }))
  assert.deepEqual(state.screen(at, true, []).cards, [])
  assert.equal(state.block({ ...studyChoice, revision: 2 }, at + 1), 'duplicate')
  assert.equal(state.block({ ...studyChoice, revision: 2, answer: 'later' }, at + 1), undefined)
})

test('publishes only after the CLI accepts and cleans up both forms of delivery failure', async (t) => {
  const home = await isolated(t)
  const executable = join(home, 'orca-stand-in')
  const queue = join(home, 'inbox-study-panel')
  const staging = join(queue, '.staging')
  const settings = { botHome: home, automationId: AUTOMATION_ID, executable }
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
const assert = require('node:assert/strict')
assert.deepEqual(process.argv.slice(2), ['automations', 'run', '${AUTOMATION_ID}', '--json'])
assert.ok(Object.keys(process.env).every(key => !key.startsWith('ORCA_')))
assert.deepEqual(fs.readdirSync(${JSON.stringify(queue)}).filter(file => file.endsWith('.json')), [])
assert.equal(fs.readdirSync(${JSON.stringify(staging)}).length, 1)
process.stdout.write('{"ok":false}')
`, { mode: 0o700 })
  assert.deepEqual(await deliver(settings, studyChoice, 2, at), { error: 'wake_failed' })
  assert.deepEqual(await readdir(queue), ['.staging'])
  assert.deepEqual(await readdir(staging), [])
  const script = await readFile(executable, 'utf8')
  await writeFile(executable, script.replace('{"ok":false}', '{"ok":true}'))
  const choice = { ...studyChoice, answer: 'drop', reason: '겹치는 주제' } as const
  const result = await deliver(settings, choice, 2, at)
  const sentAt = new Date(at).toISOString()
  assert.deepEqual(result, { sentAt })
  const [file] = (await readdir(queue)).filter((name) => name.endsWith('.json'))
  const message = JSON.parse(await readFile(join(queue, file), 'utf8'))
  assert.match(message.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(file, sentAt.replace(/[:.]/g, '-') + '-' + message.requestId + '.json')
  assert.deepEqual(message, { ...choice, round: 2, sentAt, requestId: message.requestId })
  assert.equal((await stat(queue)).mode & 0o777, 0o700)
  assert.equal((await stat(join(queue, file))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(staging), [])
  await rm(queue, { recursive: true })
  await writeFile(queue, 'blocked path')
  assert.deepEqual(await deliver(settings, studyChoice, 2, at), { error: 'queue_write_failed' })
})
