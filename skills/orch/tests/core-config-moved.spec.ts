// 설정 값 판정을 core 로 옮긴 함수가 core 경로에서 지금과 같이 동작하는지 대표 입력으로 본다.
// 호출자(lib, slot, loop)의 동작은 지금 테스트가 보증하고, 여기서는 core 경로의 정상 하나와 ConfigError 하나를 본다.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError } from '../scripts/core/config.ts'
import { contractSettings } from '../scripts/core/contracts.ts'
import { dockerRules } from '../scripts/core/docker.ts'
import { compileHeavy } from '../scripts/core/heavy.ts'
import { DEFAULT_STALL_TICKS, stallTicks } from '../scripts/core/loop.ts'
import { adrDirs } from '../scripts/core/reservations.ts'

test('contractSettings: 두 키가 있으면 명령과 정규식을 낸다. 하나만 있으면 ConfigError', () => {
  const settings = contractSettings({ contracts: { merge_command: 'make merge', paths: ['a/.*\\.yaml', 'b/.*'] } })
  assert.equal(settings?.command, 'make merge')
  assert.ok(settings?.paths.test('b/x'))
  assert.equal(contractSettings({}), null)
  assert.throws(() => contractSettings({ contracts: { merge_command: 'make merge' } }), ConfigError)
})

test('dockerRules: 규칙을 정규식으로 바꾸고 틀린 정규식은 ConfigError', () => {
  const rules = dockerRules({ docker: { containers: [{ name: 'job-(?<pid>\\d+)' }], images: [{ repository: 'app/.*', keep: 2 }] } })
  assert.equal(rules.containers.length, 1)
  assert.equal(rules.images[0].keep, 2)
  assert.deepEqual(dockerRules({}), { containers: [], images: [] })
  assert.throws(() => dockerRules({ docker: { images: [{ repository: '(' }] } }), ConfigError)
})

test('adrDirs: 끝의 슬래시를 떼고 빈 값은 ConfigError', () => {
  assert.deepEqual(adrDirs({ adr: { dirs: { core: 'docs/adr/' } } }), { core: 'docs/adr' })
  assert.deepEqual(adrDirs({}), {})
  assert.throws(() => adrDirs({ adr: { dirs: { core: '' } } }), ConfigError)
})

test('compileHeavy: 정규식 목록을 만들고 badRegex 를 넘기면 그 오류를 던진다', () => {
  assert.ok(compileHeavy({ light: ['^ls'] }).light[0].test('ls -la'))
  assert.throws(() => compileHeavy({ light: 'x' }), ConfigError)
  assert.throws(() => compileHeavy({ normal: ['('] }), ConfigError)
  class Mine extends Error {}
  assert.throws(() => compileHeavy({ normal: ['('] }, (message) => new Mine(message)), Mine)
})

test('stallTicks: 기본값, 부분 값, 틀린 값', () => {
  assert.deepEqual(stallTicks(undefined), { ...DEFAULT_STALL_TICKS })
  assert.deepEqual(stallTicks({ idle: 3 }), { error: 2, idle: 3 })
  assert.throws(() => stallTicks({ error: -1 }), ConfigError)
  assert.throws(() => stallTicks({ other: 1 }), ConfigError)
})
