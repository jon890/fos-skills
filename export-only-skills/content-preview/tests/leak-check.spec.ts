// content-preview 의 leak-check 테스트. 고침 지시 문구는 잡고 정상 문장은 통과시키는지 본다.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { copyScripts, run, tempDir, write } from './helpers.ts'

function exec(body: string, t: { after(fn: () => void): void }) {
  const root = tempDir('leak-check-', t)
  const scripts = copyScripts(root)
  const file = write(join(root, 'body.md'), body)
  return run([process.execPath, join(scripts, 'leak-check.ts'), file], { cwd: root })
}

describe('leak-check', () => {
  for (const line of [
    '| 1 | 지금 본문 그대로 | 완료 |',
    '표를 아래로 바꾼다.',
    '아래 행을 더한다.',
    '여기에 처리 단계 표를 넣는다.',
    '## 실행 방식 (고침)',
    '현재 본문 그대로 유지',
  ]) {
    test(`걸린다: ${line}`, (t) => {
      const done = exec(`제목\n\n${line}\n`, t)
      assert.equal(done.code, 1)
      assert.ok(done.stdout.includes(':3: '), done.stdout)
      assert.ok(done.stdout.includes(line))
    })
  }

  for (const line of [
    '지금 본문을 읽으면 원인이 보인다.',
    '기존 내용을 그대로 두면 오류가 난다.',
    '표를 만들어 비교했다.',
    '여기에서 문제가 생겼다.',
    '아래 행은 로그 예시다.',
    '코드는 `지금 본문 그대로` 를 찾는다.',
  ]) {
    test(`걸리지 않는다: ${line}`, (t) => {
      const done = exec(`${line}\n`, t)
      assert.equal(done.code, 0, done.stdout)
    })
  }

  test('코드 블록 안은 건너뛴다', (t) => {
    assert.equal(exec('```\n지금 본문 그대로\n```\n', t).code, 0)
  })

  test('인자가 없으면 2', (t) => {
    const scripts = copyScripts(tempDir('leak-check-', t))
    assert.equal(run([process.execPath, join(scripts, 'leak-check.ts')]).code, 2)
  })
})
