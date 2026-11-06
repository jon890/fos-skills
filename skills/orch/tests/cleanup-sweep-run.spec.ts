// 실제 CLI 의 인자·출력·종료 코드를 남기고 함수 가짜와 대응한다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fx, SCRIPT, save } from './fixtures/cleanup-sweep.ts'

function cli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: fx.env, encoding: 'utf8' })
}

test('실제 cleanup CLI 의 help 는 사용법과 종료 코드 0 이다', () => {
  const done = cli(['--help'])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /사용법:/)
})

test('실제 cleanup CLI 의 잘못된 인자는 종료 코드 2 다', () => {
  const done = cli(['--unknown-option'])
  assert.equal(done.status, 2)
  assert.match(done.stderr, /사용법:/)
})

test('실제 cleanup CLI 의 dry-run 은 저장소와 정리 요약을 낸다', () => {
  save()
  const done = cli(['--repo', fx.repo])
  assert.equal(done.status, 0, done.stderr)
  assert.match(done.stdout, /cleanup-sweep dry-run:/)
})

test('실제 cleanup CLI 의 조회 실패는 stderr 와 종료 코드 2 다', () => {
  fx.orcaFail = true
  save()
  const done = cli(['--repo', fx.repo])
  assert.equal(done.status, 2)
  assert.match(done.stderr, /orca terminal list/)
})
