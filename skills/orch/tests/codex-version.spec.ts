// orch doctor 의 낡은 Codex CLI 판정(scripts/doctor/codex-version.ts). 실제 codex 와 네트워크는 부르지 않는다.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import { linkBin } from '../../../modules/testkit/fake-bin.ts'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { codexOutdatedLines, compareVersion, findCodex, versionOf } from '../scripts/doctor/codex-version.ts'

let tmp: string
let saved: NodeJS.ProcessEnv
beforeEach(() => {
  tmp = tempDir('codex-version-')
  saved = { ...process.env }
  process.env.ORCH_MACHINE_DIR = join(tmp, 'machine')
})
afterEach(() => { process.env = saved })

function installed(version: string): void {
  process.env.CODEX_BIN = linkBin(tmp, 'codex', `console.log('codex-cli ${version}')`)
}
function latest(body: string): void {
  const file = join(tmp, 'latest.json')
  writeFileSync(file, body)
  process.env.ORCH_CODEX_LATEST_URL = pathToFileURL(file).href
}

test('설치 버전이 최신 릴리스보다 낮으면 CODEX-OUTDATED 와 갱신 명령을 낸다', async () => {
  installed('0.155.1')
  latest(JSON.stringify({ tag_name: 'rust-v0.166.0' }))
  assert.deepEqual(await codexOutdatedLines(), ['CODEX-OUTDATED 0.155.1 0.166.0', '  codex update'])
})

test('최신이거나 더 높으면 아무 줄도 내지 않는다', async () => {
  installed('0.166.0')
  latest(JSON.stringify({ tag_name: 'rust-v0.166.0' }))
  assert.deepEqual(await codexOutdatedLines(), [])
})

test('codex 명령이 없으면 확인하지 않는다', async () => {
  delete process.env.CODEX_BIN
  process.env.PATH = join(tmp, 'empty')
  latest('this file must not matter')
  assert.equal(findCodex(), null)
  assert.deepEqual(await codexOutdatedLines(), [])
})

test('최신 버전이나 설치 버전을 읽지 못하면 줄을 내지 않는다', async () => {
  installed('0.155.1')
  latest('{')
  assert.deepEqual(await codexOutdatedLines(), [])
  latest(JSON.stringify({ tag_name: 'nightly' }))
  assert.deepEqual(await codexOutdatedLines(), [])
  process.env.ORCH_CODEX_LATEST_URL = pathToFileURL(join(tmp, 'missing.json')).href
  assert.deepEqual(await codexOutdatedLines(), [])
  process.env.CODEX_BIN = linkBin(tmp, 'codex2', `console.log('unknown'); process.exit(0)`)
  latest(JSON.stringify({ tag_name: 'rust-v0.166.0' }))
  assert.deepEqual(await codexOutdatedLines(), [])
})

test('PATH 에서 처음 찾은 codex 를 쓰고 버전은 x.y.z 로 비교한다', () => {
  delete process.env.CODEX_BIN
  const bin = linkBin(join(tmp, 'bin'), 'codex', `console.log('codex-cli 1.0.0')`)
  process.env.PATH = [join(tmp, 'none'), join(tmp, 'bin')].join(':')
  assert.equal(findCodex(), bin)
  assert.equal(versionOf('codex-cli 0.166.0'), '0.166.0')
  assert.ok(compareVersion('0.155.1', '0.166.0') < 0)
  assert.ok(compareVersion('0.166.10', '0.166.9') > 0)
})
