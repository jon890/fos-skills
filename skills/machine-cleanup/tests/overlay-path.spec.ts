// overlay_path 의 명령 경계 테스트(스펙 REQ2). 임시 홈에 오버레이 자리를 조합해 두고 고른 경로와 종료 코드를 본다.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Sandbox, write } from './helpers.ts'

const NEW = '.claude/overlays/machine-cleanup.md'
const OLD = '.claude/overlays/mac-cleanup.md'
const OLDEST = '.claude/mac-cleanup-overlay.md'

function setup(files: string[]) {
  const box = new Sandbox('mc-overlay-', [])
  for (const rel of files) write(join(box.home, rel), `# ${rel}\n`)
  return { box, run: (args: string[] = []) => box.run('overlay_path', args) }
}

describe('개인 오버레이 자리 고르기', () => {
  test('새 자리만 있으면 그 경로를 내고 안내 줄이 없다', () => {
    const { box, run } = setup([NEW])
    const done = run()
    assert.equal(done.code, 0)
    assert.equal(done.stdout, `${join(box.home, NEW)}\n`)
    assert.equal(done.stderr, '')
  })

  for (const rel of [OLD, OLDEST]) {
    test(`옛 자리 ${rel} 에만 있으면 그 파일을 읽고 새 자리로 옮기라고 알린다`, () => {
      const { box, run } = setup([rel])
      const done = run()
      assert.equal(done.code, 0)
      assert.equal(done.stdout, `${join(box.home, rel)}\n`)
      assert.ok(done.stderr.includes(join(box.home, NEW)), done.stderr)
    })
  }

  test('새 자리와 옛 자리가 함께 있으면 새 자리가 먼저다', () => {
    const { box, run } = setup([NEW, OLD, OLDEST])
    assert.equal(run().stdout, `${join(box.home, NEW)}\n`)
  })

  test('옛 자리 둘이 함께 있으면 overlays 아래가 먼저다', () => {
    const { box, run } = setup([OLD, OLDEST])
    assert.equal(run().stdout, `${join(box.home, OLD)}\n`)
  })

  test('아무 자리에도 없으면 1 이고 아무것도 내지 않는다', () => {
    const done = setup([]).run()
    assert.equal(done.code, 1)
    assert.equal(done.stdout, '')
    assert.equal(done.stderr, '')
  })

  test('새 자리가 자기 자신을 가리키는 링크면 옛 자리가 있어도 3 으로 멈춘다', () => {
    const { box, run } = setup([OLD, OLDEST])
    mkdirSync(join(box.home, '.claude/overlays'), { recursive: true })
    symlinkSync(join(box.home, NEW), join(box.home, NEW))
    const done = run()
    assert.equal(done.code, 3)
    assert.equal(done.stdout, '')
    assert.ok(done.stderr.includes(join(box.home, NEW)) && done.stderr.includes('ELOOP'), done.stderr)
  })

  test('새 자리를 읽을 권한이 없으면 옛 자리가 있어도 3 으로 멈춘다', { skip: process.getuid?.() === 0 }, () => {
    const { box, run } = setup([NEW, OLDEST])
    chmodSync(join(box.home, NEW), 0o000)
    const done = run()
    assert.equal(done.code, 3)
    assert.equal(done.stdout, '')
    assert.ok(done.stderr.includes('EACCES'), done.stderr)
  })

  test('새 자리가 폴더면 옛 자리로 넘어가지 않고 3 이다', () => {
    const { box, run } = setup([`${NEW}/x`, OLDEST])
    const done = run()
    assert.equal(done.code, 3)
    assert.ok(done.stderr.includes('파일이 아니다'), done.stderr)
  })

  test('상위 폴더 자리에 파일이 있으면 없는 것으로 보고 다음 자리로 간다', () => {
    const { box, run } = setup(['.claude/overlays', OLDEST])
    assert.equal(run().stdout, `${join(box.home, OLDEST)}\n`)
  })

  test('인자를 주면 사용법 오류 2 다', () => {
    const done = setup([NEW]).run(['extra'])
    assert.equal(done.code, 2)
    assert.ok(done.stderr.startsWith('usage: overlay_path.ts'), done.stderr)
  })
})
