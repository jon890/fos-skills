import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { checkPluginUpdates, pluginUpdateNoticeSuffix } from '../scripts/loop/lifecycle.ts'
import type { UpdateReport } from '../scripts/loop/plugin-auto-update.ts'

test('저장소 설정이 false 면 확인을 부르지 않고 비불리언 값은 거부한다', async t => {
  const repo = tempDir('plugin-update-setting-', t)
  const orch = join(repo, '.orch')
  mkdirSync(orch)
  const calls: string[] = []
  const update = async () => { calls.push('update'); return null }
  const notify = () => { calls.push('notify') }
  const config = (value: unknown) => writeFileSync(join(orch, 'config.json'), JSON.stringify({ plugin: { auto_update: value } }))
  config(false)
  await checkPluginUpdates(repo, notify, update)
  assert.deepEqual(calls, [])
  config('false')
  await assert.rejects(checkPluginUpdates(repo, notify, update), /true 나 false/)
  assert.deepEqual(calls, [])
  config(true)
  await checkPluginUpdates(repo, notify, update)
  assert.deepEqual(calls, ['update'])
})

test('설치 실패 알림과 다시 뜨기 알림의 결과 꼬리를 연결한다', async t => {
  const repo = tempDir('plugin-update-notice-', t)
  const report: UpdateReport = { version: '1.2.0', checkedAt: 1000, notifyFailure: true,
    results: [{ configDir: join(repo, 'claude'), scope: 'user', oldVersion: '1.0.0', result: 'failed', reason: '실패' }],
  }
  const notices: UpdateReport[] = []
  await checkPluginUpdates(repo, value => notices.push(value), async () => report)
  assert.deepEqual(notices, [report])
  assert.match(pluginUpdateNoticeSuffix(report, '1.2.0'), /fos-skills 1\.2\.0 설치 실패/)
  assert.equal(pluginUpdateNoticeSuffix(report, '1.3.0'), '')
  assert.equal(pluginUpdateNoticeSuffix(null, '1.2.0'), '')
})
