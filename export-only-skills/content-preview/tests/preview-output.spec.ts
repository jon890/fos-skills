// 생성기가 이전 산출물을 스스로 지우고 원자적으로 덮어쓰는지 본다. 두 생성기의 명령 경계 테스트다.
// 내보내는 스킬의 테스트라 Node 내장 모듈만 쓴다.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { generate } from './generator.ts'
import { SCRIPTS_DIR, tempDir } from './helpers.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const GENERATORS: Record<string, string[]> = {
  dooray: [process.execPath, join(SCRIPTS_DIR, 'dooray-preview', 'generate.ts'), '--mode', 'comment'],
  github: [process.execPath, join(SCRIPTS_DIR, 'github-preview', 'generate.ts'), '--type', 'pr'],
}
// ──

const STALE = 'STALE-PREVIEW'

describe('preview_output', () => {
  for (const [name, command] of Object.entries(GENERATORS)) {
    test(`${name}: 이전 산출물을 덮어쓰고 임시 파일을 남기지 않는다`, () => {
      const done = generate(command, ['--title', 'example', '--md-file', '-'], { input: 'new body', stale: STALE })
      assert.equal(done.code, 0)
      assert.ok(done.html.includes('new body'))
      assert.ok(!done.html.includes(STALE))
      assert.deepEqual(readdirSync(done.dir), ['preview.html'])
    })

    test(`${name}: 실패하면 이전 산출물을 지운다`, () => {
      const done = generate(command, ['--title', 'example', '--md-file', '-'], { input: 'bad </script> body', stale: STALE })
      assert.equal(done.code, 1)
      assert.deepEqual(readdirSync(done.dir), [])
    })

    test(`${name}: 본문 파일이 없어도 이전 산출물을 지운다`, () => {
      const dir = tempDir('content-preview-')
      const done = generate(command, ['--title', 'example', '--md-file', join(dir, 'missing.md')], { dir, stale: STALE })
      assert.notEqual(done.code, 0)
      assert.deepEqual(readdirSync(dir), [])
    })

    test(`${name}: 산출물이 없던 자리에도 새로 쓴다`, () => {
      const done = generate(command, ['--title', 'example', '--md-file', '-'], { input: 'fresh' })
      assert.equal(done.code, 0)
      assert.ok(readFileSync(done.out, 'utf8').includes('fresh'))
    })

    test(`${name}: 출력 폴더가 없으면 실패한다`, () => {
      const dir = tempDir('content-preview-')
      const out = join(dir, 'missing', 'preview.html')
      const done = generate(command, ['--title', 'example', '--md-file', '-', '--out', out], { input: 'x', dir })
      assert.notEqual(done.code, 0)
      assert.deepEqual(readdirSync(dir), [])
    })

    test(`${name}: 읽기 전용 폴더에는 쓰지 못하고 반쪽 파일을 남기지 않는다`, (t) => {
      if (process.getuid?.() === 0) return t.skip('root 는 읽기 전용 폴더에도 쓴다')
      const dir = tempDir('content-preview-')
      const sub = join(dir, 'ro')
      mkdirSync(sub)
      chmodSync(sub, 0o500)
      try {
        const done = generate(command, ['--title', 'example', '--md-file', '-', '--out', join(sub, 'preview.html')], { input: 'x', dir })
        assert.notEqual(done.code, 0)
        assert.deepEqual(readdirSync(sub), [])
      } finally {
        chmodSync(sub, 0o700)
      }
    })
  }
})
