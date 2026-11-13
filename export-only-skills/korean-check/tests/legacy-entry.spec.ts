// 옛 이름 진입 korean-style-check.py, check-readability.py 는 3.0.0 에서 지웠다(node-runtime 스펙 DECISION17).
// 루트 package.json 의 "type": "module" 아래에서 확장자 .py 는 실행되지 않아, 남겨 두면 깨진 진입이 된다.
// 새 이름(.ts)은 지금 그대로 돌고, 옛 이름이 다시 생기지 않는지 본다.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { SCRIPTS_DIR } from './helpers.ts'

describe('옛 이름 진입', () => {
  for (const name of ['korean-style-check', 'check-readability']) {
    test(`${name}.py 가 없고 ${name}.ts 가 있다`, () => {
      assert.equal(existsSync(join(SCRIPTS_DIR, `${name}.py`)), false)
      assert.equal(existsSync(join(SCRIPTS_DIR, `${name}.ts`)), true)
    })
  }
})
