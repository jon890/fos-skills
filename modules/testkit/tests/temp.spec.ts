import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'
import { runCommand } from '../command.ts'
import { tempDir } from '../temp.ts'


const TEMP = join(import.meta.dirname, '..', 'temp.ts')

describe('tempDir', () => {
  let made = ''
  beforeEach(() => {
    made = tempDir('testkit-spec-')
  })

  it('beforeEach 에서 만든 폴더가 테스트 본문에서 있다', () => {
    assert.ok(existsSync(made))
  })

  it('t 를 주면 그 테스트의 after 뒤 없다', async (t) => {
    let dir = ''
    await t.test('안쪽', (inner) => {
      dir = tempDir('testkit-spec-t-', inner)
      assert.ok(existsSync(dir))
    })
    assert.ok(dir && !existsSync(dir))
  })

  // 자식 node --test 로 작은 테스트 파일을 돌린다. 그 파일이 만든 폴더 경로를 stdout 에 낸다
  function child(env: NodeJS.ProcessEnv = {}) {
    const work = tempDir('testkit-spec-child-')
    const file = join(work, 'child.spec.ts')
    writeFileSync(
      file,
      `import { it } from 'node:test'\nimport { tempDir } from ${JSON.stringify(TEMP)}\nit('x', () => { console.log('DIR=' + tempDir('testkit-child-')) })\n`,
    )
    const done = runCommand([process.execPath, '--test', '--test-reporter=spec', file], { env: { ...process.env, ...env } })
    assert.equal(done.code, 0, done.stdout + done.stderr)
    const dir = /DIR=(\S+)/.exec(done.stdout)?.[1] ?? ''
    assert.ok(dir, done.stdout)
    // node --test 는 자식 파일의 stderr 를 reporter 출력(stdout)에 싣는다
    return { dir, stderr: done.stdout + done.stderr }
  }

  it('파일이 끝난 뒤 폴더가 없다', () => {
    const { dir } = child({ TESTKIT_KEEP: '' })
    assert.ok(!existsSync(dir))
  })

  it('TESTKIT_KEEP=1 이면 남고 stderr 에 경로가 있다', async (t) => {
    const { dir, stderr } = child({ TESTKIT_KEEP: '1' })
    t.after(() => runCommand(['rm', '-rf', dir]))
    assert.ok(existsSync(dir))
    assert.ok(stderr.includes(`testkit: 남긴 폴더 ${dir}`), stderr)
  })
})
