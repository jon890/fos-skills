// 스킬 문서의 rm -rf 예시가 빈 변수 방지 형식(${VAR:?})을 쓰는지 검증한다. 문서 텍스트만 읽는다.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

const SKILL_DIR = join(import.meta.dirname, '..')

// rm -rf 뒤의 대상이 $ 로 시작하는지 본다. 따옴표는 한 번만 허용한다
const RM_TARGET = /\brm -rf\s+"?(\$[^\s"]*)/g
// ${VAR:?} 로 시작하면 변수가 비었을 때 셸이 멈춘다
const GUARDED = /^\$\{[A-Za-z_][A-Za-z0-9_]*:\?\}/

// 코드 블록 안의 rm -rf 대상 중 ${VAR:?} 형식이 아닌 변수 대상을 [줄 번호, 줄] 목록으로 돌려준다
function unguardedRmTargets(text: string): [number, string][] {
  const found: [number, string][] = []
  let inBlock = false
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      inBlock = !inBlock
      return
    }
    if (!inBlock) return
    for (const match of line.matchAll(RM_TARGET)) if (!GUARDED.test(match[1])) found.push([index + 1, line.trim()])
  })
  return found
}

describe('문서의 rm -rf', () => {
  test('스킬 문서는 변수 대상을 ${VAR:?} 형식으로 보호한다', () => {
    const docs = ['SKILL.md', ...readdirSync(join(SKILL_DIR, 'references')).filter((n) => n.endsWith('.md')).sort().map((n) => join('references', n))]
    const violations: string[] = []
    for (const doc of docs) for (const [number, line] of unguardedRmTargets(readFileSync(join(SKILL_DIR, doc), 'utf8'))) violations.push(`${doc}:${number}: ${line}`)
    assert.deepEqual(violations, [])
  })
})

describe('검사 함수', () => {
  test('코드 블록 안의 보호되지 않은 변수를 낸다', () => {
    assert.deepEqual(unguardedRmTargets('```bash\nrm -rf "$DIR"\n```\n'), [[2, 'rm -rf "$DIR"']])
  })

  test('홈 변수와 경로 접미도 낸다', () => {
    assert.equal(unguardedRmTargets('```bash\nrm -rf "$HOME/Library/Cache"\nrm -rf $RELEASE\n```\n').length, 2)
  })

  test('보호된 변수는 통과한다', () => {
    assert.deepEqual(unguardedRmTargets('```bash\nrm -rf "${DIR:?}"\nrm -rf "${HOME:?}/Library/Application Support/Cursor/snapshots"\n```\n'), [])
  })

  test('리터럴 절대 경로와 홈 경로는 통과한다', () => {
    assert.deepEqual(unguardedRmTargets('```bash\nrm -rf /Users/me/tmp/out\nrm -rf ~/.cache/foo\n```\n'), [])
  })

  test('코드 블록 밖의 본문은 보지 않는다', () => {
    assert.deepEqual(unguardedRmTargets('본문에서 `rm -rf "$DIR"` 를 언급한다.\n'), [])
  })
})
