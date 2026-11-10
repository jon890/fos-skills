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
test('승인 상태는 core 밖에서 쓰지 않는다', () => {
  const problems: string[] = []
  for (const dir of ['skills/orch/scripts', 'skills/orch/hooks', 'extensions/work-board/bin', 'extensions/work-board/hooks']) {
    for (const file of sources(join(root, dir))) {
      if (file.endsWith('/core/approvals.ts')) continue
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!line.trimStart().startsWith('//') && /state\s*[:=]\s*['"](approved|revise)['"]/.test(line)) problems.push(`${file}:${i + 1}`)
      })
    }
  }
  assert.deepEqual(problems, [])
})
