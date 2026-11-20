import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../../../modules/testkit/temp.ts'
import { checkLaunchSettings } from '../scripts/lib/model-check.ts'

test('한 프로세스에서 모델 목록을 한 번만 조회하고 읽을 수 없는 항목만 건너뛴다', (t) => {
  const dir = tempDir('model-check-', t)
  const bin = join(dir, 'codex')
  const count = join(dir, 'calls')
  writeFileSync(bin, `#!/bin/sh\necho called >> '${count}'\nprintf '%s' '{"models":[{"slug":"bad","visibility":"hide"},{"slug":"gpt-6-sol","visibility":"list","supported_reasoning_levels":[{"effort":"low"}]}]}'\n`)
  chmodSync(bin, 0o755)
  const previous = process.env.CODEX_BIN
  process.env.CODEX_BIN = bin
  try {
    assert.equal(checkLaunchSettings({ agent: 'codex', model: 'gpt-6-sol', effort: 'low' }).reject, null)
    assert.equal(checkLaunchSettings({ agent: 'codex', model: 'gpt-6-sol', effort: 'high' }).reject?.includes('EFFORT-UNAVAILABLE'), true)
    assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 1)
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN
    else process.env.CODEX_BIN = previous
  }
})
