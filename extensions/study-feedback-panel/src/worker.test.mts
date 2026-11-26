import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker.ts'
import { AUTOMATION_ID, exampleSummary, studyChoice } from '../tests/fixtures.ts'

test('publishes changes and serializes choices across panels, keeping the lock on restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'study-panel-worker-'))
  const stateDir = join(home, 'state')
  const executable = join(home, 'fake-orca')
  const summary = exampleSummary()
  const host = mockHost({
    settings: { botHome: home, panelAutomationId: AUTOMATION_ID, orcaExecutable: executable }
  })
  await mkdir(stateDir)
  const file = join(stateDir, 'study-panel-summary.json')
  await writeFile(file, JSON.stringify(summary))
  await writeFile(executable, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n', { mode: 0o700 })
  let worker = await mountWorker(main, { host })
  try {
    const initial = await worker.request('studyPanel.get')
    assert.equal(initial.status, 'ready')
    assert.deepEqual(initial.summary, summary)
    const choose = () => worker.request('studyPanel.choose', { ...studyChoice, reason: 'UI에서 쓰지 않는 값' })
    const answers = await Promise.all([choose(), choose()])
    assert.equal(answers.filter((answer) => 'sentAt' in answer).length, 1)
    const [other] = answers.filter((answer) => 'error' in answer)
    assert.ok(other?.error === 'locked' || other?.error === 'duplicate')
    assert.ok(worker.posts.some((post) => post.event === 'studyPanel.changed'))
    const queue = join(home, 'inbox-study-panel')
    const files = (await readdir(queue)).filter((entry) => entry.endsWith('.json'))
    assert.equal(files.length, 1)
    const message = JSON.parse(await readFile(join(queue, files[0]), 'utf8'))
    assert.equal(message.round, 2)
    assert.ok(!Object.hasOwn(message, 'reason'))
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    const restored = await worker.request('studyPanel.get')
    assert.equal(restored.cards[0]?.status, 'sent')
    const duplicate = await choose()
    assert.equal('error' in duplicate && duplicate.error, 'duplicate')
    summary.study[0].revision = 2
    await writeFile(file, JSON.stringify(summary))
    const staleChoice = await choose()
    assert.equal('error' in staleChoice && staleChoice.error, 'changed')
    assert.deepEqual(staleChoice.screen.cards, [])
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    await rm(home, { recursive: true, force: true })
  }
})
