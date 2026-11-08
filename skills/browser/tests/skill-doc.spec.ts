// browser 스킬 문서가 부르는 말, 소유 경계, 드라이버 경로를 잃지 않았는지 본다.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const SKILL = join(import.meta.dirname, '..')
const TEXT = readFileSync(join(SKILL, 'SKILL.md'), 'utf8')
const DESCRIPTION = TEXT.split('description:')[1].split('metadata:')[0].split(/\s+/).filter(Boolean).join(' ')

// browser-driver 의 진입점. 스킬 폴더 안에 있다. 구현 언어를 바꾸면 이 경로만 고친다
const DRIVER_ENTRY = join(SKILL, 'browser-driver', 'browser_driver.ts')

describe('browser SKILL.md', () => {
  test('description 이 부르는 말을 갖는다', () => {
    for (const phrase of ['브라우저로', '콘솔에서', '웹 화면에서 확인', '화면으로 해야 하는 작업', 'CLI 나 API 로 안 되는 작업']) {
      assert.ok(DESCRIPTION.includes(phrase), phrase)
    }
  })

  test('description 은 소유자를 가리키고 내용을 되풀이하지 않는다', () => {
    for (const phrase of ['browser-driver help', 'browser-driver/README.md', '사람이 할 일']) {
      assert.ok(DESCRIPTION.includes(phrase), phrase)
    }
  })

  test('번들 드라이버 경로가 스킬 폴더에서 진입점을 가리킨다', () => {
    assert.ok(TEXT.includes('"$SKILL_DIR/browser-driver/browser_driver.ts"'))
    assert.ok(existsSync(DRIVER_ENTRY))
  })

  test('본문이 공간 분리와 로그인 규칙을 지킨다', () => {
    for (const rule of ['BROWSER_EGO_SPACE', 'BROWSER_EGO_PURPOSE=personal', 'reset', '자격 증명을 넣지 않는다', '.claude/browser-overlay.md']) {
      assert.ok(TEXT.includes(rule), rule)
    }
  })
})
