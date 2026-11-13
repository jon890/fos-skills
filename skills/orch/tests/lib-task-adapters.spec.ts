import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskAdapter, resolveTaskUrl } from '../scripts/lib/task-adapters.ts'
import { taskAdapterOf } from '../scripts/core/task-adapters.ts'
test('가짜 CLI 의 성공·오류·응답 오류·시간 초과와 설정 파일', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-adapter-'))
  const cli = join(dir, 'dooray')
  const adapter = taskAdapterOf({ board: { task: { adapter: 'dooray', web_url: 'https://x.dooray.com', project: 'P' } } })!
  const fake = (body: string) => { writeFileSync(cli, '#!/usr/bin/env node\n' + body); chmodSync(cli, 0o755) }
  try {
    fake(`if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--json','post','get','한글','1'])) process.exit(2); console.log('{"id":"123"}')`)
    assert.equal(await resolveTaskUrl(adapter, '한글/1', { dooray: cli }), 'https://x.dooray.com/project/tasks/123')
    fake(`console.error('실패\\n둘째 줄'); process.exit(1)`)
    await assert.rejects(resolveTaskUrl(adapter, 'P/1', { dooray: cli }), /^Error: dooray post get: 실패$/)
    fake(`console.log('{}')`)
    await assert.rejects(resolveTaskUrl(adapter, 'P/1', { dooray: cli }), /응답에 id 가 없다/)
    await assert.rejects(resolveTaskUrl(adapter, 'P/1', { dooray: join(dir, 'missing') }), /명령을 찾지 못했다/)
    fake(`setInterval(() => {}, 1000)`)
    await assert.rejects(resolveTaskUrl(adapter, 'P/1', { dooray: cli, timeoutMs: 50 }), /dooray post get/)
    mkdirSync(join(dir, '.orch')); writeFileSync(join(dir, '.orch/config.json'), JSON.stringify({ board: { task: { adapter: 'url-template', url: 'https://x/{number}' } } }))
    assert.equal(taskAdapter(dir)?.kind, 'url-template')
    writeFileSync(join(dir, '.orch/config.json'), JSON.stringify({ board: { task: {} } }))
    assert.throws(() => taskAdapter(dir), /board.task/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
