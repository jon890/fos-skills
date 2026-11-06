// is-main.ts 의 isMainModule. import.meta.main 이 없는 Node 24.0·24.1 에서도 심볼릭 링크로 부른 진입이 일을 해야 한다.
// 이 Node 에는 import.meta.main 이 있어 플래그를 false 로 넘겨 없는 상태를 흉내 낸다.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isMainModule } from '../is-main.ts'

describe('isMainModule', () => {
  const real = realpathSync(join(import.meta.dirname, '..', 'sync-kit.ts'))
  const url = pathToFileURL(real).href
  const withArgv = (value: string | undefined, fn: () => void) => {
    const saved = process.argv[1]
    process.argv[1] = value as string
    try {
      fn()
    } finally {
      process.argv[1] = saved
    }
  }

  test('플래그가 true 면 true', () => assert.equal(isMainModule(url, true), true))
  test('플래그가 없어도 실체 경로로 부르면 true', () => withArgv(real, () => assert.equal(isMainModule(url, undefined), true)))
  test('플래그가 없어도 심볼릭 링크로 부르면 true', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')))
    try {
      const link = join(dir, 'sync-kit.ts')
      symlinkSync(real, link)
      withArgv(link, () => assert.equal(isMainModule(url, false), true))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('다른 파일이 진입이면 false', () => withArgv(join(import.meta.dirname, '..', 'is-main.ts'), () => assert.equal(isMainModule(url, false), false)))
  test('진입 경로가 없으면 false', () => withArgv(undefined, () => assert.equal(isMainModule(url, false), false)))
  test('진입 경로가 없는 파일이면 false', () => withArgv('/no/such/entry.ts', () => assert.equal(isMainModule(url, false), false)))
})
