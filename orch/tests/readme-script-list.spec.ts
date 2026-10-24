// orch/README.md 의 스크립트 목록이 orch/scripts/ 의 실제 파일과 어긋나지 않는지 본다.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ORCH = fileURLToPath(new URL('..', import.meta.url))
const SUFFIXES = new Set(['.py', '.sh', '.ts'])

// README 에 `scripts/<이름>` 으로 적히지 않은 스크립트 파일 이름을 정렬해 돌려준다.
// 같은 폴더에 같은 이름의 .ts 가 있는 .py 는 그 .ts 로 넘기는 shim 이라 대조하지 않는다.
function missingFromReadme(readme: string, scriptsDir: string): string[] {
  const text = readFileSync(readme, 'utf8')
  const files = readdirSync(scriptsDir).filter((name) => statSync(join(scriptsDir, name)).isFile())
  const names = new Set(files)
  return files
    .filter((name) => SUFFIXES.has(extname(name)))
    .filter((name) => !(extname(name) === '.py' && names.has(`${name.slice(0, -3)}.ts`)))
    .sort()
    .filter((name) => !text.includes(`\`scripts/${name}\``))
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'readme-script-list-'))
  mkdirSync(join(tmp, 'scripts'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function files(readme: string, names: string[]): void {
  writeFileSync(join(tmp, 'README.md'), readme)
  for (const name of names) writeFileSync(join(tmp, 'scripts', name), '')
}

describe('README 스크립트 목록', () => {
  test('orch/scripts 의 스크립트가 모두 README 에 있다', () => {
    const missing = missingFromReadme(join(ORCH, 'README.md'), join(ORCH, 'scripts'))
    assert.deepEqual(missing, [], `orch/README.md 에 없는 스크립트: ${missing.join(', ')}`)
  })

  test('목록에 없는 스크립트를 알린다', () => {
    files('- `scripts/a.py`: 첫째\n', ['a.py', 'b.sh'])
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), ['b.sh'])
  })

  test('적힌 이름으로 시작하기만 하는 이름은 알린다', () => {
    files('- `scripts/ab.py`: 둘째\n', ['a.py', 'ab.py'])
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), ['a.py'])
  })

  test('빈 폴더와 스크립트가 아닌 파일은 보지 않는다', () => {
    files('', [])
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), [])
    writeFileSync(join(tmp, 'scripts', 'notes.txt'), '')
    mkdirSync(join(tmp, 'scripts', '__pycache__'))
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), [])
  })

  test('같은 이름의 .ts 가 있는 .py 는 shim 이라 빠진다', () => {
    files('- `scripts/a.ts`: 첫째\n', ['a.py', 'a.ts'])
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), [])
  })

  test('.ts 가 목록에 없으면 알린다', () => {
    files('- `scripts/a.py`: 옛 경로\n', ['a.py', 'a.ts'])
    assert.deepEqual(missingFromReadme(join(tmp, 'README.md'), join(tmp, 'scripts')), ['a.ts'])
  })
})

// ts_shim.py 를 뺀 .py 가운데 shim 이 아닌 파일 이름을 정렬해 돌려준다.
// shim 은 ts_shim.exec_ts(__file__ 를 부르고 같은 폴더에 같은 이름의 .ts 가 있는 .py 다.
function nonShimPython(scriptsDir: string): string[] {
  const names = new Set(readdirSync(scriptsDir))
  return [...names]
    .filter((name) => extname(name) === '.py' && name !== 'ts_shim.py')
    .filter((name) => !(names.has(`${name.slice(0, -3)}.ts`) && readFileSync(join(scriptsDir, name), 'utf8').includes('ts_shim.exec_ts(__file__')))
    .sort()
}

describe('남은 Python', () => {
  test('orch/scripts 의 .py 는 ts_shim.py 를 빼고 모두 shim 이다', () => {
    const left = nonShimPython(join(ORCH, 'scripts'))
    assert.deepEqual(left, [], `shim 이 아닌 Python: ${left.join(', ')}`)
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
