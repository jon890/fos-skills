// 시작 폴더(startFolder)가 창 코드를 다시 읽고 /clear, 압축을 거쳐도 그대로인지 본다(docs/features/board-session-root/spec.md).
// 다시 로드는 register.js 를 새로 import 해 모듈 변수가 비는 것으로 흉내 낸다. 세션 상태는 그 사이에 남는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'

let moduleIndex = 0
async function freshStartFolder() {
  const module = await import('../hooks/register.js?session-root=' + ++moduleIndex)
  return { startFolder: module.startFolder }
}

// root 는 Claude 를 띄운 폴더, cwd 는 명령이 cd 한 지금 작업 폴더다
function session(stored: Map<string, unknown>, where: { root?: string | (() => never); cwd: string }) {
  return {
    state: {
      get: async (ref) => ({ value: stored.get(ref.plugin + '/' + ref.key), version: 1 }),
      set: async (ref, value) => { stored.set(ref.plugin + '/' + ref.key, value); return { isSet: true, version: 2 } },
    },
    session: {
      root: async () => typeof where.root === 'function' ? where.root() : where.root,
      cwd: async () => where.cwd,
    },
  }
}

test('처음에는 cd 한 작업 폴더가 아니라 띄운 폴더로 정하고 세션 상태에 둔다 (REQ1, DECISION6)', async () => {
  const { startFolder } = await freshStartFolder()
  const stored = new Map()
  assert.equal(await startFolder(session(stored, { root: '/a', cwd: '/b' })), '/a')
  assert.equal(stored.get('fos-skills/board-start'), '/a')
})

test('창 코드를 다시 읽으면 세션 상태의 값을 쓴다. 그 사이 root 가 옮겨 가도 따라가지 않는다 (REQ4)', async () => {
  const stored = new Map()
  await (await freshStartFolder()).startFolder(session(stored, { root: '/a', cwd: '/b' }))
  const reloaded = await freshStartFolder()
  assert.equal(await reloaded.startFolder(session(stored, { root: '/elsewhere', cwd: '/b' })), '/a')
})

test('/clear 나 압축으로 세션 상태가 비어도 cd 한 폴더가 아니라 띄운 폴더를 쓴다 (REQ5, DECISION5)', async () => {
  const { startFolder } = await freshStartFolder()
  assert.equal(await startFolder(session(new Map(), { root: '/a', cwd: '/b' })), '/a')
})

test('root 를 주지 않는 host 에서는 작업 폴더로 정한다', async () => {
  const { startFolder } = await freshStartFolder()
  const failing = () => { throw new TypeError('root is not a function') }
  assert.equal(await startFolder(session(new Map(), { root: failing, cwd: '/b' })), '/b')
})
