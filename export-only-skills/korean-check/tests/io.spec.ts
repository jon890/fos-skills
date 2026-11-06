// io.ts 의 isMain. import.meta.main 이 없는 Node 24.0·24.1 에서도 심볼릭 링크로 부른 새 .ts 진입이 검사를 돌아야 한다.
// 이 Node 에는 import.meta.main 이 있어 플래그를 false 로 넘겨 없는 상태를 흉내 낸다.

import assert from 'node:assert/strict'
import { realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { isMain } from '../scripts/io.ts'
import { SCRIPTS_DIR, tempDir } from './helpers.ts'

describe('isMain', () => {
  const real = realpathSync(join(SCRIPTS_DIR, 'korean-style-check.ts'))
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

  test('플래그가 true 면 true', () => assert.equal(isMain(url, true), true))
  test('플래그가 없어도 실체 경로로 부르면 true', () => withArgv(real, () => assert.equal(isMain(url, undefined), true)))
  test('플래그가 없어도 심볼릭 링크로 부르면 true', () => {
    const link = join(tempDir(), 'korean-style-check.ts')
    symlinkSync(real, link)
    withArgv(link, () => assert.equal(isMain(url, false), true))
  })
  test('다른 파일이 진입이면 false', () => withArgv(join(SCRIPTS_DIR, 'check.ts'), () => assert.equal(isMain(url, false), false)))
  test('진입 경로가 없으면 false', () => withArgv(undefined, () => assert.equal(isMain(url, false), false)))
})
