// ego lite 를 먼저 권하는 안내 문구를 명령 경계에서 본다. 실제 브라우저는 열지 않는다.
// 설치된 백엔드는 PATH 의 가짜 실행 파일로 만들고 PATH 는 그 폴더 하나뿐이다.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Box, DRIVER_DIR, type T } from './helpers.ts'

const URL = 'https://lite.ego.app/'

function env(t: T, opts: { installed?: string[]; config?: unknown; driver?: string } = {}) {
  const box = new Box(t)
  for (const name of opts.installed ?? []) box.fake(name)
  if (opts.config !== undefined) box.setConfig(opts.config)
  box.env.BROWSER_DRIVER = opts.driver
  return box
}

describe('ego 안내', () => {
  test('설정 예시는 ego 를 권하고 미리보기는 orca 로 둔다', () => {
    const data = JSON.parse(readFileSync(join(DRIVER_DIR, 'browser.config.example.json'), 'utf8'))
    assert.equal(data.driver, 'ego')
    assert.equal(data.previewDriver, 'orca')
    assert.equal(Object.keys(data._drivers)[0], 'ego')
    assert.ok(data._drivers.ego.includes('권장'))
  })

  test('백엔드가 없으면 진단이 ego lite 를 먼저 권한다', (t) => {
    const done = env(t).run(['doctor'])
    assert.equal(done.code, 2)
    assert.ok(done.stdout.includes(URL))
    assert.ok(done.stdout.indexOf('ego lite') < done.stdout.indexOf('orca 나 agent-browser'))
  })

  test('백엔드가 없으면 명령도 같은 안내와 함께 멈춘다', (t) => {
    const done = env(t).run(['open', 'about:blank'])
    assert.equal(done.code, 2)
    assert.ok((done.stderr + done.stdout).includes(URL))
  })

  test('ego 가 없고 다른 백엔드가 잡히면 권고를 낸다', (t) => {
    const done = env(t, { installed: ['orca'] }).run(['doctor'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('판정: orca'))
    assert.ok(done.stdout.includes('권고:'))
    assert.ok(done.stdout.includes(URL))
  })

  test('ego 가 있어도 다른 백엔드로 고정했으면 권고를 낸다', (t) => {
    const done = env(t, { installed: ['ego-browser', 'orca'], config: { driver: 'orca' } }).run(['doctor'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('판정: orca'))
    assert.ok(done.stdout.includes('권고:'))
    assert.ok(!done.stdout.split('판정:')[1].includes(URL))
  })

  test('ego 가 잡히면 권고를 내지 않는다', (t) => {
    const done = env(t, { installed: ['ego-browser', 'orca'] }).run(['doctor'])
    assert.equal(done.code, 0)
    assert.ok(done.stdout.includes('판정: ego'))
    assert.ok(!done.stdout.includes('권고:'))
  })

  test('미리보기 백엔드 설정은 권고를 부르지 않는다', (t) => {
    const done = env(t, { installed: ['ego-browser', 'orca'], config: { previewDriver: 'orca' } }).run(['doctor'])
    assert.ok(done.stdout.includes('판정: ego'))
    assert.ok(!done.stdout.includes('권고:'))
  })
})
