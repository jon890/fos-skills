// 보드 프로세스 호출 경계와 표시 후보의 사전 검사를 함께 확인한다.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { boardReadySteps } from '../scripts/lib/step-ready.ts'
import { collectStages } from '../scripts/lib/movement.ts'

function setup(t: TestContext) {
  const saved = { ...process.env }, repo = tempDir('lib-step-ready-', t)
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) })
  mkdirSync(join(repo, '.omc')); mkdirSync(join(repo, '.orch'))
  process.env.ORCH_DIR = join(repo, '.orch')
  process.env.GIT_CEILING_DIRECTORIES = repo
  const calls = join(repo, 'calls.json'), wrapper = join(repo, 'board.ts')
  writeFileSync(calls, '[]')
  const actual = fileURLToPath(new URL('../../../extensions/work-board/bin/board.ts', import.meta.url))
  writeFileSync(wrapper, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); const file=${JSON.stringify(calls)}; const calls=JSON.parse(fs.readFileSync(file,'utf8')); calls.push(args); fs.writeFileSync(file,JSON.stringify(calls)); const result=spawnSync(process.execPath,[${JSON.stringify(actual)},...args],{stdio:'inherit'}); process.exitCode=result.status;`)
  process.env.BOARD_BIN = wrapper
  const put = (items: unknown[]) => writeFileSync(join(repo, '.omc/board.json'), JSON.stringify({ items }))
  const read = () => JSON.parse(readFileSync(calls, 'utf8')) as string[][]
  const live = { paths: new Set<string>(), dispatches: new Set<string>() }
  return { repo, put, read, live }
}

test('표시 없는 보드는 다음 단계 알림과 멈춤 확인에서 단계 프로세스를 띄우지 않는다', t => {
  const c = setup(t)
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `plain-${i}`, status: 'doing', branch: `branch-${i}`, details: [{ text: '1. 다음', done: false }] }))
  c.put(items)
  assert.equal(boardReadySteps(c.repo, c.live, new Map(), []).every(row => row.mark === null), true)
  const stages = collectStages(c.repo, new Set(), { idleMin: 30, exited: false }, Date.now(), { branches: new Map() })
  assert.deepEqual(stages.map(row => [row.id, row.step]), items.map(item => [item.id, '1. 다음']))
  assert.deepEqual(c.read(), [])
})

test('표시는 details·next 와 문자열·객체에서 찾되 첫 단계 선택은 보드 도구에 맡긴다', t => {
  const c = setup(t)
  c.put([
    { id: 'auto', status: 'doing', details: ['참고: 설명', '1. [auto] 다음'] },
    { id: 'ask', status: 'doing', details: [{ text: '1. [ask] 결정', done: false }] },
    { id: 'wait', status: 'wait', next: ['1. [wait: 조건] 대기'] },
    { id: 'later', status: 'doing', details: ['1. 먼저', '2. [auto] 나중'] },
    { id: 'plain', status: 'doing', next: ['1. 일반 단계'] },
    { id: 'done', status: 'done', details: ['1. [auto] 끝난 항목'] },
  ])
  const ready = boardReadySteps(c.repo, c.live, new Map(), [])
  assert.deepEqual(ready.map(row => [row.id, row.mark]), [['auto', 'auto'], ['ask', 'ask'], ['wait', 'wait'], ['later', null], ['plain', null], ['done', null]])
  assert.deepEqual(c.read().map(args => args.slice(0, 2)), [['steps', 'auto'], ['steps', 'ask'], ['steps', 'wait'], ['steps', 'later']])
})
