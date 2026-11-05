import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runCommand } from '../command.ts'
import { fakeBin } from '../fake-bin.ts'
import { tempDir } from '../temp.ts'

describe('fakeBin', () => {
  it('두 폴더의 같은 가짜는 같은 inode 다', () => {
    const a = fakeBin(tempDir(), 'gh', [])
    const b = fakeBin(tempDir(), 'gh', [{ stdout: 'x' }])
    assert.equal(statSync(a.path).ino, statSync(b.path).ino)
  })

  it('규칙과 기록은 폴더마다 따로다', () => {
    const a = fakeBin(tempDir(), 'gh', [{ stdout: 'A' }])
    const b = fakeBin(tempDir(), 'gh', [{ stdout: 'B' }])
    a.setRules([{ stdout: 'A2' }])
    assert.equal(runCommand([a.path]).stdout, 'A2')
    assert.equal(runCommand([b.path]).stdout, 'B')
    assert.equal(a.calls().length, 1)
    assert.equal(b.calls().length, 1)
  })

  it('규칙대로 stdout, stderr, 종료 코드를 내고 argv 를 기록한다', () => {
    const bin = fakeBin(tempDir(), 'orca', [{ args: ['bad'], stderr: 'no', code: 4 }, { args: ['ok'], stdout: 'yes' }])
    const r = runCommand([bin.path, 'ok', 'x'])
    assert.deepEqual([r.code, r.stdout], [0, 'yes'])
    const bad = runCommand([bin.path, 'bad'])
    assert.deepEqual([bad.code, bad.stderr], [4, 'no'])
    assert.deepEqual(bin.calls().map((c) => c.argv), [['ok', 'x'], ['bad']])
    assert.equal(runCommand([bin.path, 'none']).stdout, '')
  })

  it('recordEnv 로 고른 변수가 기록된다', () => {
    const bin = fakeBin(tempDir(), 'x', [], { recordEnv: ['FOO', 'MISSING_VAR'] })
    runCommand([bin.path], { env: { ...process.env, FOO: 'bar' } })
    assert.deepEqual(bin.calls()[0].env, { FOO: 'bar', MISSING_VAR: null })
    bin.setRules([{ stdout: 'z' }])
    runCommand([bin.path], { env: { ...process.env, FOO: 'baz' } })
    assert.equal(bin.calls()[1].env.FOO, 'baz')
  })

  it('같은 경로에 다시 만들면 새 규칙으로 답한다', () => {
    const dir = tempDir()
    const first = fakeBin(dir, 'gh', [{ stdout: 'one' }])
    const second = fakeBin(dir, 'gh', [{ stdout: 'two' }])
    assert.equal(first.path, second.path)
    assert.equal(runCommand([second.path]).stdout, 'two')
  })

  it('큰 출력도 끝까지 나온다', () => {
    const big = 'x'.repeat(300_000)
    const bin = fakeBin(join(tempDir(), 'sub'), 'big', [{ stdout: big }])
    assert.equal(runCommand([bin.path]).stdout.length, big.length)
  })
})
