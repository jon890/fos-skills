// core 의 의존과 순수 테스트의 실행 환경 경계를 소스에서 검사한다.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const tests = dirname(fileURLToPath(import.meta.url))
const core = resolve(tests, '../scripts/core')
function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(root, entry.name)) : entry.name.endsWith('.ts') ? [join(root, entry.name)] : [])
}
function issues(file: string, root = core): string[] {
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  const report = (at: number, reason: string) => found.push(`${file}:${source.slice(0, at).split('\n').length}: ${reason}`)
  // import type, 부수 효과 import 와 재수출도 같은 의존이다.
  const dependencies = /\b(?:import|export)\s+(?:(?:type\s+)?[^;]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g
  for (const match of source.matchAll(dependencies)) {
    const name = match[1]
    const rel = relative(root, resolve(dirname(file), name))
    const local = name.startsWith('.') && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
    // zod 는 설정 검사표(config-schema.ts) 하나만 쓴다(docs/adr/030-plugin-npm-dependencies.md)
    const schemaZod = name === 'zod' && basename(file) === 'config-schema.ts'
    if (!local && name !== 'node:path' && name !== 'node:crypto' && !schemaZod) report(match.index, `금지 import: ${name}`)
  }
  for (const rule of [/\bprocess\s*\./g, /\bDate\s*\.\s*now\s*\(/g, /\bnew\s+Date\s*\(\s*\)/g, /\brequire\s*\(/g, /\bimport\s*\(/g, /\bglobalThis\b/g]) {
    for (const match of source.matchAll(rule)) report(match.index, `외부 상태 접근: ${match[0]}`)
  }
  return found
}
function testIssues(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const found: string[] = []
  const fakeImport = /(?:import|export)[^;]*?from\s*['"][^'"]*fixtures\/fake-bin\.ts['"]/g
  // core 테스트는 이 실행 파일 선택 환경에 기대지 않는다. 점 표기와 대괄호 표기를 함께 본다.
  const environment = /\b(?:process\s*\.\s*env|env)\s*(?:\.\s*(?:ORCA|GH|PATH)\b|\[\s*['"](?:ORCA|GH|PATH)['"]\s*\])/g
  const environmentMap = /[,{]\s*(?:ORCA|GH|PATH|['"](?:ORCA|GH|PATH)['"])\s*:/g
  for (const rule of [fakeImport, environment, environmentMap]) for (const match of source.matchAll(rule)) found.push(`${file}:${source.slice(0, match.index).split('\n').length}: 순수 테스트의 외부 실행 환경`)
  return found
}

test('core 는 허용한 순수 의존과 입력 값만 쓴다', () => {
  const files = sources(core)
  assert.ok(files.length > 0)
  assert.deepEqual(files.flatMap(file => issues(file)), [])
  const specs = readdirSync(tests).filter(name => /^core-.*\.spec\.ts$/.test(name))
  assert.deepEqual(specs.flatMap(name => testIssues(join(tests, name))), [])
})
test('금지 import 와 외부 상태 접근은 임시 파일의 줄 번호로 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-boundary-'))
  const file = join(dir, 'bad.ts')
  try {
    for (const source of ["import type { Value } from '../lib/value.ts'", "import { readFile } from 'node:fs'", "export * from '../lib/value.ts'", "import 'node:fs'", 'pro' + 'cess.env.X', 'Date' + '.now()', 'new ' + 'Date()', 'requ' + 'ire("x")', 'imp' + 'ort("x")', 'global' + 'This']) {
      writeFileSync(file, '// 첫 줄\n' + source + '\n')
      assert.match(issues(file, dir).join('\n'), /bad\.ts:2:/, source)
    }
    writeFileSync(file, "import type { Value } from './value.ts'\nimport { basename } from 'node:path'\nimport { createHash } from 'node:crypto'\n")
    assert.deepEqual(issues(file, dir), [])
    // zod 는 config-schema.ts 만 가져올 수 있다
    writeFileSync(file, "import * as z from 'zod'\n")
    assert.match(issues(file, dir).join('\n'), /bad\.ts:1: 금지 import: zod/)
    const schema = join(dir, 'config-schema.ts')
    writeFileSync(schema, "import * as z from 'zod'\n")
    assert.deepEqual(issues(schema, dir), [])
    writeFileSync(file, "import { fakeBin } from './fixtures/" + "fake-bin.ts'\n")
    assert.equal(testIssues(file).length, 1)
    writeFileSync(file, 'const settings = {' + 'ORCA' + ': \"fake\"}\n')
    assert.equal(testIssues(file).length, 1)
    for (const expression of ['pro' + 'cess.env.' + 'ORCA', 'env["' + 'GH' + '"]', 'pro' + 'cess.env["' + 'PATH' + '"]']) {
      writeFileSync(file, expression + ' = "fake"\n')
      assert.equal(testIssues(file).length, 1, expression)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
