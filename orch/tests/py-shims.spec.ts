// orch/scripts 와 work-board/bin 에 남은 .py 가 모두 같은 이름의 .ts 로 넘기는 shim 인지 본다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ORCH = fileURLToPath(new URL('..', import.meta.url))

// 줄 머리(들여쓰기 뒤)에서 exec_ts(__file__ 를 부르는 줄. 주석이나 문서 문자열 안의 언급은 호출이 아니다
const EXEC_TS_CALL = /^\s*ts_shim\.exec_ts\(__file__[,)]/m

// ts_shim.py 를 뺀 .py 가운데 shim 이 아닌 파일 이름을 정렬해 돌려준다.
// shim 은 ts_shim.exec_ts(__file__ 를 실제로 부르고 같은 폴더에 같은 이름의 .ts 가 있는 .py 다.
function nonShimPython(scriptsDir: string): string[] {
  const names = new Set(readdirSync(scriptsDir))
  return [...names]
    .filter((name) => extname(name) === '.py' && name !== 'ts_shim.py')
    .filter((name) => !(names.has(`${name.slice(0, -3)}.ts`) && EXEC_TS_CALL.test(readFileSync(join(scriptsDir, name), 'utf8'))))
    .sort()
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'py-shims-'))
  mkdirSync(join(tmp, 'scripts'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('남은 Python', () => {
  test('orch/scripts 의 .py 는 ts_shim.py 를 빼고 모두 shim 이다', () => {
    const left = nonShimPython(join(ORCH, 'scripts'))
    assert.deepEqual(left, [], `shim 이 아닌 Python: ${left.join(', ')}`)
  })

  test('work-board/bin 의 .py 도 모두 shim 이다', () => {
    const left = nonShimPython(join(ORCH, '..', 'work-board', 'bin'))
    assert.deepEqual(left, [], `shim 이 아닌 Python: ${left.join(', ')}`)
  })

  test('주석이나 문서 문자열에만 exec_ts(__file__ 가 있는 .py 는 shim 이 아니다', () => {
    const dir = join(tmp, 'scripts')
    writeFileSync(join(dir, 'a.py'), '# ts_shim.exec_ts(__file__) 로 넘기던 옛 명령\nprint("x")\n')
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'b.py'), '"""ts_shim.exec_ts(__file__) 를 부르지 않는다.\n"""\nprint("x")\n')
    writeFileSync(join(dir, 'b.ts'), '')
    writeFileSync(join(dir, 'c.py'), 'import ts_shim\nif __name__ == "__main__":\n    ts_shim.exec_ts(__file__, deprecated=False)\n')
    writeFileSync(join(dir, 'c.ts'), '')
    assert.deepEqual(nonShimPython(dir), ['a.py', 'b.py'])
  })

  test('.ts 가 없거나 exec_ts 를 부르지 않는 .py 는 shim 이 아니라고 알린다', () => {
    const shim = 'import ts_shim\nif __name__ == "__main__":\n    ts_shim.exec_ts(__file__)\n'
    const dir = join(tmp, 'scripts')
    writeFileSync(join(dir, 'a.py'), shim)
    writeFileSync(join(dir, 'b.py'), 'print("x")\n')
    writeFileSync(join(dir, 'b.ts'), '')
    writeFileSync(join(dir, 'c.py'), shim)
    writeFileSync(join(dir, 'c.ts'), '')
    writeFileSync(join(dir, 'ts_shim.py'), 'def exec_ts(): pass\n')
    assert.deepEqual(nonShimPython(dir), ['a.py', 'b.py'])
  })
})
