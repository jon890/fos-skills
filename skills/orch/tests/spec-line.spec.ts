// spec-line.ts 가 지시서의 `허락:` 줄을 첫 지시 줄에 붙이는지 본다.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/spec-line.ts', import.meta.url))

let tmp: string
let spec: string

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'spec-line-')))
  spec = join(tmp, 'spec-x.md')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

function run(...args: string[]) {
  const done = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { encoding: 'utf8' })
  return { code: done.status, stdout: done.stdout, stderr: done.stderr }
}

function line(body: string, ...args: string[]) {
  writeFileSync(spec, body)
  return run(spec, ...args)
}

describe('spec-line', () => {
  test('허락 줄을 첫 지시 줄에 넣는다', () => {
    const r = line('# 지시서\n브랜치: `feature/x`\n허락: push 와 draft PR 생성(base main)은 사용자가 허락했다.\n')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(
      r.stdout.trim(),
      `지시서 ${spec} 를 끝까지 읽고 수행한다. push 와 draft PR 생성(base main)은 사용자가 허락했다. 못 읽으면 escalation 으로 알린다.`,
    )
  })

  test('목록 기호와 굵은 글씨, 여러 줄을 받고 마침표가 없으면 붙인다', () => {
    const r = line('- **허락:** push 는 사용자가 허락했다\n* 허락: PR 생성은 사용자가 허락했다.\n')
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /push 는 사용자가 허락했다\. PR 생성은 사용자가 허락했다\. 못 읽으면/)
  })

  test('허락 줄이 없으면 문구 없이 내고, --require-permission 이면 1 이다', () => {
    const r = line('# 지시서\nPR 은 열지 않는다.\n')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout.trim(), `지시서 ${spec} 를 끝까지 읽고 수행한다. 못 읽으면 escalation 으로 알린다.`)
    const strict = line('# 지시서\n', '--require-permission')
    assert.equal(strict.code, 1, strict.stdout)
    assert.match(strict.stderr, /허락:/)
    assert.equal(strict.stdout, '')
  })

  test('경로는 실경로로 낸다', () => {
    writeFileSync(spec, '허락: push.\n')
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'spec-x.md'], { cwd: tmp, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.startsWith(`지시서 ${spec} 를`), r.stdout)
  })

  test('없는 지시서와 사용법 오류는 2 다', () => {
    assert.equal(run(join(tmp, 'none.md')).code, 2)
    assert.equal(run().code, 2)
    assert.equal(run(spec, spec).code, 2)
    assert.equal(run(spec, '--unknown').code, 2)
  })
})
