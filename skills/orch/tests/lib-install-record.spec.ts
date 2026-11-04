// 번들 고르기 규칙의 원본(lib/install-record.ts)이 사례 표(fixtures/install-records.json)대로 고르는지 본다.
// 같은 표를 실행기(orch-launcher.spec.ts)와 공통 지시서 틀(template-script-path.spec.ts)도 쓴다.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { selectBundle } from '../scripts/lib/install-record.ts'
import { CASES, layout } from './fixtures/install-records.ts'

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orch-record-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('selectBundle 사례 표', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { config, path } = layout(tmp, c)
      const got = selectBundle(config, path('own'))
      if ('error' in c.expect) {
        assert.ok('error' in got, `오류여야 한다: ${JSON.stringify(got)}`)
        assert.match((got as { error: string }).error, /claude plugin (update|install) fos-skills@fos-skills/)
      } else {
        assert.ok(!('error' in got), JSON.stringify(got))
        assert.equal((got as { bundle: string }).bundle, path(c.expect.bundle))
      }
    })
  }
})

test('user 범위 오류는 3.x 배치를 알아본다', () => {
  const c = CASES.find((x) => x.name.includes('3.x'))!
  const { config, path } = layout(tmp, c)
  const got = selectBundle(config, path('own'))
  assert.ok('error' in got)
  assert.match(got.error, /옛 배치\(orch\/scripts\)/)
  assert.match(got.error, /skills\/orch\/bin\/orch\.ts/)
})
