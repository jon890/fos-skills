// io.ts 의 isMain. import.meta.main 이 없는 Node 24.0·24.1 에서도 심볼릭 링크로 부른 진입이 일을 해야 한다.
// 이 Node 에는 import.meta.main 이 있어 플래그를 false 로 넘겨 없는 상태를 흉내 낸다.
// 같은 판정을 가진 다른 io.ts·text.ts 도 이 꼴이다.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isMain } from '../scripts/io.ts'

describe('isMain', () => {
  const real = realpathSync(join(import.meta.dirname, '..', 'scripts', 'io.ts'))
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

  test('플래그가 없어도 실체 경로로 부르면 true', () => withArgv(real, () => assert.equal(isMain(url, undefined), true)))
  test('플래그가 없어도 심볼릭 링크로 부르면 true', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-')))
    try {
      const link = join(dir, 'io.ts')
      symlinkSync(real, link)
      withArgv(link, () => assert.equal(isMain(url, false), true))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('진입 경로가 없으면 false', () => withArgv(undefined, () => assert.equal(isMain(url, false), false)))
})
