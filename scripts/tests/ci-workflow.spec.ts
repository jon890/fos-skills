// CI workflow 가 테스트 결과 폴더를 고정 경로로 두고, 실패하면 그 폴더의 node.log 를 artifact 로 올리는지 본다.
// 실패한 테스트의 상세 로그가 임시 경로에만 남아 사라지던 일을 막는다.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')

// `- name:` 으로 시작하는 단계 하나의 본문
function step(name: string): string {
  const parts = workflow.split(/^ {6}- /m)
  const found = parts.find((part) => part.startsWith(`name: ${name}`))
  assert.ok(found, `${name} 단계가 있다`)
  return found
}

test('전체 테스트는 결과 폴더를 runner 임시 폴더 아래 고정 경로로 둔다', () => {
  assert.match(step('Run repository test runner'), /run: node scripts\/run-tests\.ts --out "\$RUNNER_TEMP\/run-tests"/)
})

test('실패해도 결과 폴더의 node.log 를 짧은 보존 기간으로 artifact 에 올린다', () => {
  const upload = step('Upload test logs')
  assert.match(upload, /if: \$\{\{ (failure\(\)|always\(\)) \}\}/)
  assert.match(upload, /uses: actions\/upload-artifact@v\d+/)
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/run-tests\/node\.log/)
  const days = Number(/retention-days: (\d+)/.exec(upload)?.[1])
  assert.ok(days >= 1 && days <= 14, `보존 기간이 짧다: ${days}`)
})
