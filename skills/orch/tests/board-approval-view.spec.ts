import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardApprovalReader } from '../scripts/lib/board-queries/board-approval-view.ts'

test('보드 승인 조회는 표시할 열린 대기만 버전 순으로 내고 매번 파일을 새로 읽는다', async () => {
  const entry = { id: 'a', title: '제목', state: 'open', version: 2, preview: { path: '/tmp/a.html', sha256: 'hash' }, run: 'run', press: null }
  let exists = true
  let source = JSON.stringify({ seq: 9, entries: [
    { ...entry, id: 'b', version: 7 }, null, { id: 'broken' },
    { ...entry, state: 'approved', version: 5 }, { ...entry, version: '2' }, entry,
  ] })
  let pathLookups = 0
  let reads = 0
  const read = await boardApprovalReader('/repo', '/plugin', async () => {
    pathLookups++
    return '/state/approvals.json\n'
  }, {
    exists: async () => exists,
    read: async () => { reads++; return source },
  })
  const { open } = await read()
  assert.deepEqual(open?.map(e => e.id), ['a', 'b'])
  assert.deepEqual(open?.[0]?.preview, { path: '/tmp/a.html' })
  assert.ok(open && !('state' in open[0]) && !('run' in open[0]) && !('press' in open[0]))
  source = '  \n'
  assert.deepEqual(await read(), { open: [] })
  source = '{"seq":1}'
  assert.deepEqual(await read(), { error: '승인 파일 꼴이 틀려요' })
  source = '{깨짐'
  assert.ok((await read()).error)
  exists = false
  assert.deepEqual(await read(), { open: [] })
  assert.equal(pathLookups, 1)
  assert.equal(reads, 4)
})
