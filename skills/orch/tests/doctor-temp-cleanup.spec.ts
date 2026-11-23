import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { cleanupDoctorTemp } from './fixtures/doctor-temp-cleanup.ts'

const notEmpty = () => Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })

test('ENOTEMPTY 가 나면 남은 파일을 기록하고 최대 세 번 재시도한다', (t) => {
  const dir = tempDir('doctor-cleanup-', t)
  writeFileSync(join(dir, 'remaining.txt'), 'test')
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  const remove = t.mock.fn<typeof rmSync>((target, options) => {
    if (options?.maxRetries === undefined) throw notEmpty()
    rmSync(target, options)
  })

  cleanupDoctorTemp(dir, remove)

  assert.equal(existsSync(dir), false)
  assert.deepEqual(remove.mock.calls.map((call) => call.arguments[1]?.maxRetries), [undefined, 2])
  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /남은 파일: \["remaining\.txt"\]/)
})

test('재시도 후에도 지울 수 없으면 남은 파일을 다시 기록하고 삭제 오류를 던진다', (t) => {
  const dir = tempDir('doctor-cleanup-', t)
  const remaining = 'remaining-after-retry.txt'
  const stderr = t.mock.method(process.stderr, 'write', () => true)
  const failure = notEmpty()

  assert.throws(() => cleanupDoctorTemp(dir, (_target, options) => {
    if (options?.maxRetries !== undefined) writeFileSync(join(dir, remaining), 'test')
    throw failure
  }), (error) => error === failure)

  assert.match(String(stderr.mock.calls[0]?.arguments[0]), /재시도 전 ENOTEMPTY/)
  assert.match(String(stderr.mock.calls[1]?.arguments[0]), /재시도 후 실패.*\n남은 파일: \["remaining-after-retry\.txt"\]/)
})
