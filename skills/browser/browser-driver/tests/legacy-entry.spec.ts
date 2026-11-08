// 옛 이름 진입 tools/browser-driver/browser_driver.py (node shebang JS)를 본다.
// 이 진입은 이 저장소에만 있고 팀 사본에는 실리지 않는다. 팀 사본에서는 이 파일의 사례가 건너뛴다.
// 새 명령과 stdout, 종료 코드가 같고 stderr 맨 앞에 새 명령을 알리는 한 줄이 붙는다.

import assert from 'node:assert/strict'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { Box, COMMAND, DRIVER_DIR, write, type T } from './helpers.ts'

const SHIM = join(DRIVER_DIR, '..', '..', '..', 'tools', 'browser-driver', 'browser_driver.py')
const NOTICE = /^이 경로는 다음 major 에 없어진다\. 새 명령: node .*browser_driver\.ts\n/
const shim = (box: Box, args: string[], extra = {}, command = [process.execPath, SHIM]) => box.run(args, extra, { command })

function setup(t: T) {
  const box = new Box(t)
  box.fake('orca', [{ stdout: '{"ok":true,"result":{"result":"x"}}\n' }])
  box.env.BROWSER_DRIVER = 'orca'
  return box
}

describe('옛 이름 진입', () => {
  test('새 명령과 stdout 과 종료 코드가 같고 stderr 에 안내가 붙는다', (t) => {
    if (!existsSync(SHIM)) return t.skip('옛 이름 진입은 이 저장소에만 있다')
    const box = setup(t)
    const cases: string[][] = [['help'], ['config-path'], ['driver'], ['js', 'tab1', '1'], ['js', 'tab1', '1', '--timeout', '5'], ['nope'], ['click', 'tab1', '1', '2'], ['doctor'], []]
    for (const args of cases) {
      const fresh = box.run(args)
      const old = shim(box, args)
      assert.equal(old.stdout, fresh.stdout, args.join(' '))
      assert.equal(old.code, fresh.code, args.join(' '))
      const match = NOTICE.exec(old.stderr)
      assert.ok(match, `${args.join(' ')}: ${old.stderr}`)
      assert.equal(old.stderr.slice(match[0].length), fresh.stderr, args.join(' '))
    }
  })

  test('실패 종료 코드 1 도 그대로 전한다', (t) => {
    if (!existsSync(SHIM)) return t.skip('옛 이름 진입은 이 저장소에만 있다')
    const box = new Box(t)
    box.env.BROWSER_DRIVER = 'orca'
    box.fake('orca', [{ stdout: '{"ok":false,"error":{"code":"E","message":"m"}}\n' }])
    const done = shim(box, ['url', 'P'])
    assert.equal(done.code, 1)
    assert.ok(done.stderr.endsWith('orca 실패 [E] m\n'))
  })

  test('링크로 불려도 실체 옆의 새 구현을 찾는다', (t) => {
    if (!existsSync(SHIM)) return t.skip('옛 이름 진입은 이 저장소에만 있다')
    const box = setup(t)
    const link = join(box.root, 'browser-driver.py')
    symlinkSync(SHIM, link)
    const done = box.run(['driver'], {}, { command: [process.execPath, link] })
    assert.deepEqual([done.code, done.stdout], [0, 'orca\n'])
    assert.match(done.stderr, NOTICE)
  })

  test('낮은 node 에서는 건너뛰었다는 한 줄을 내고 127 로 끝난다', (t) => {
    if (!existsSync(SHIM)) return t.skip('옛 이름 진입은 이 저장소에만 있다')
    const box = setup(t)
    // process.versions.node 는 단순 대입으로 바뀌지 않아 defineProperty 로 덮는다
    const lower = write(join(box.root, 'low-node.cjs'), "Object.defineProperty(process.versions, 'node', { value: '22.1.0' })\n")
    const done = shim(box, ['help'], {}, [process.execPath, '--require', lower, SHIM])
    assert.deepEqual([done.code, done.stdout], [127, ''])
    assert.equal(done.stderr, 'browser_driver.py: Node 24 이상이 필요해 브라우저 드라이버를 건너뛰었다\n')
  })

  test('새 명령과 같은 환경이면 새 구현이 그대로 돈다', (t) => {
    const box = setup(t)
    assert.equal(box.run(['driver']).stdout, 'orca\n')
    assert.ok(COMMAND.length >= 2)
  })
})
