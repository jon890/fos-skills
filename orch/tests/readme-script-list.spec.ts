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
