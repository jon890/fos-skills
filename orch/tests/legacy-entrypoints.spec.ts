// orch/scripts 와 work-board/bin 에 옛 .py, .sh 진입점이 다시 생기지 않는지 본다.
// 옛 진입점은 5.0.0 에서 모두 지웠다. 명령은 `bin/orch.ts <이름>` 이나 같은 이름의 .ts 로 부른다.

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ORCH = fileURLToPath(new URL('..', import.meta.url))

function legacy(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => ['.py', '.sh'].includes(extname(name)))
    .sort()
}

describe('옛 진입점', () => {
  test('orch/scripts 에 .py, .sh 가 없다', () => {
    assert.deepEqual(legacy(join(ORCH, 'scripts')), [])
  })

  test('work-board/bin 에 .py, .sh 가 없다', () => {
    assert.deepEqual(legacy(join(ORCH, '..', 'work-board', 'bin')), [])
  })
})
