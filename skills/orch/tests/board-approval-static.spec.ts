import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const root = fileURLToPath(new URL('../../../', import.meta.url))
function sources(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? e.name === 'tests' ? [] : sources(join(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(dir, e.name)] : [])
}
function stateLiterals(source: string): number[] {
  return source.split('\n').flatMap((line, i) => !line.trimStart().startsWith('//') && /['"](?:approved|revise)['"]/.test(line) ? [i + 1] : [])
}
test('승인 상태 문자열은 core 밖에서 만들지 않는다', () => {
  const problems: string[] = []
  for (const dir of ['skills/orch/scripts', 'skills/orch/hooks', 'extensions/work-board/bin', 'extensions/work-board/hooks']) {
    for (const file of sources(join(root, dir))) {
      if (file.endsWith('/core/approvals.ts')) continue
      for (const line of stateLiterals(readFileSync(file, 'utf8'))) problems.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(problems, [])
})
test('조건식·대괄호·변수 초기화로 만든 승인 상태도 잡는다', () => {
  for (const source of ["state: action === 'approve' ? 'approved' : 'revise'", "entry['state'] = 'approved'", "const next = 'approved'; const entry = { state: next }"]) assert.deepEqual(stateLiterals(source), [1])
  assert.deepEqual(stateLiterals("// state: 'approved'\nconst state = fromCore()"), [])
})
