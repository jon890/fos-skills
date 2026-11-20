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
  assert.match(step('Run repository test runner'), /run: node scripts\/run-tests\.ts .*--out "\$RUNNER_TEMP\/run-tests"/)
})

test('전체 테스트는 matrix 의 shard 마다 자기 몫을 돌고, 이름이 Tests 인 job 이 모든 shard 의 통과를 확인한다', () => {
  // shard 인자는 matrix 길이에서 만든다. 목록만 늘리면 shard 수가 바뀐다
  assert.match(step('Run repository test runner'), /--shard "\$\(\(\$\{\{ strategy\.job-index \}\} \+ 1\)\)\/\$\{\{ strategy\.job-total \}\}"/)
  assert.match(workflow, /^ {6}fail-fast: false$/m)
  // 머지 게이트의 필수 검사 이름(queue.required 의 Tests)은 모으는 job 이 갖는다
  const summary = workflow.slice(workflow.indexOf('\n  tests:'))
  assert.match(summary, /^ {4}name: Tests$/m)
  assert.match(summary, /^ {4}needs: shard$/m)
  assert.match(summary, /^ {4}if: \$\{\{ !cancelled\(\) \}\}$/m)
  assert.match(summary, /needs\.shard\.result \}\}" = success/)
})

test('실패해도 결과 폴더의 node.log 를 짧은 보존 기간으로 artifact 에 올린다', () => {
  const upload = step('Upload test logs')
  assert.match(upload, /if: \$\{\{ (failure\(\)|always\(\)) \}\}/)
  assert.match(upload, /uses: actions\/upload-artifact@v\d+/)
  assert.match(upload, /name: run-tests-logs-\$\{\{ matrix\.shard \}\}/)
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/run-tests\/node\.log/)
  const days = Number(/retention-days: (\d+)/.exec(upload)?.[1])
  assert.ok(days >= 1 && days <= 14, `보존 기간이 짧다: ${days}`)
})

test('npm ci 단계가 두 테스트 단계보다 앞에 있다', () => {
  assert.match(step('Install npm dependencies'), /run: npm ci --ignore-scripts/)
  const at = (name: string) => workflow.indexOf(`- name: ${name}`)
  assert.ok(at('Install npm dependencies') < at('Run plugin tests from repository root'))
  assert.ok(at('Install npm dependencies') < at('Run repository test runner'))
})
