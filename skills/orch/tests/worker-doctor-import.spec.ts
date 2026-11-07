// 운영 main 을 import 해도 CLI 를 실행하지 않고, 실제 진입은 기존 출력을 낸다.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

for (const entry of ['worker/launch-worker', 'doctor/orch-doctor']) {
  const url = new URL(`../scripts/${entry}.ts`, import.meta.url)
  test(`${entry} import 는 출력과 종료 코드 변경이 없다`, () => {
    const done = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url.href)}); if (typeof m.main !== 'function' || typeof m.reportError !== 'function') throw Error('exports'); console.log('imported')`], { encoding: 'utf8' })
    assert.equal(done.status, 0, done.stderr)
    assert.equal(done.stdout, 'imported\n')
    assert.equal(done.stderr, '')
  })
  test(`${entry} 실제 CLI 의 help 와 사용법 오류`, () => {
    for (const [arg, code] of [['--help', 0], ['--unknown-option', 2]] as const) {
      const done = spawnSync(process.execPath, [fileURLToPath(url), arg], { encoding: 'utf8' })
      assert.equal(done.status, code, done.stderr)
      assert.match(code ? done.stderr : done.stdout, /사용법:/)
    }
  })
}
