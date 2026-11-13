import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskAdapterOf, normalizeRef, urlFromLine, templateUrl, doorayParts } from '../scripts/core/task-adapters.ts'
const dooray = taskAdapterOf({ board: { task: { adapter: 'dooray', web_url: 'https://x.dooray.com/', project: 'P' } } })!
const template = taskAdapterOf({ board: { task: { adapter: 'url-template', url: 'https://x/browse/{number}' } } })!
test('어댑터 설정과 번호·주소 변환', () => {
  assert.equal(taskAdapterOf({}), null)
  assert.equal(dooray.name, '두레이')
  assert.equal(normalizeRef(dooray, '458'), 'P/458')
  for (const adapter of [dooray, template, null]) assert.equal(normalizeRef(adapter, 'X/458'), 'X/458')
  assert.equal(normalizeRef(template, '458'), '458')
  assert.equal(urlFromLine(dooray, '두레이 업무: X/458 https://x.dooray.com/project/tasks/1. https://x.dooray.com/wiki/2'), 'https://x.dooray.com/project/tasks/1')
  assert.equal(urlFromLine(dooray, 'https://other/x'), null)
  assert.equal(urlFromLine(null, 'https://x.dooray.com/x'), null)
  assert.equal(template.kind, 'url-template')
  if (template.kind === 'url-template') { assert.equal(templateUrl(template, 'PROJ-12'), 'https://x/browse/PROJ-12'); assert.equal(templateUrl(template, 'X/458'), 'https://x/browse/X/458') }
  assert.deepEqual(doorayParts('AI-스마트홈-AI/458'), { project: 'AI-스마트홈-AI', number: '458' })
  for (const ref of ['458', '/1', 'X/abc']) assert.equal(doorayParts(ref), null)
})
test('틀린 설정은 거절한다', () => {
  for (const task of [{}, 'dooray', { adapter: 'jira' }, { adapter: 'dooray', web_url: 'https://x' }, { adapter: 'url-template', url: 'https://x' }, { adapter: 'dooray', web_url: 'https://x', project: 'P', url: 'https://x' }, { adapter: 'dooray', web_url: 'ftp://x', project: 'P' }]) assert.throws(() => taskAdapterOf({ board: { task } }), /board.task/)
})
