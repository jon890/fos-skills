// 플러그인 설치 점검 명령(scripts/test-plugin-install)의 실행 불가 경로를 본다. 설치 자체는 명령을 실행하는 것이 점검이다.

import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { runCommand } from '../../modules/testkit/command.ts'
import { tempDir } from '../../modules/testkit/temp.ts'
import { REPO_ROOT } from './boundary.ts'

// ── 명령 경계: 구현을 바꿀 때 이 묶음만 고친다 ──
const COMMAND = ['/bin/bash', join(REPO_ROOT, 'scripts/test-plugin-install.sh')]
// ──

function which(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const done = runCommand(['test', '-x', join(dir, name)])
    if (dir && done.code === 0) return join(dir, name)
  }
  throw new Error(`${name} 이 이 환경에 없다`)
}

describe('test-plugin-install 의 실행 불가 경로', () => {
  for (const args of [['--nope'], ['--keep', '--nope'], ['--nope', '--keep']]) {
    test(`모르는 인자(${args.join(' ')})는 2 다`, () => {
      const done = runCommand([...COMMAND, ...args])
      assert.equal(done.code, 2, done.stderr)
      assert.match(done.stderr, /알 수 없는 인자: --nope/)
    })
  }

  test('claude 가 없으면 2 다', (t) => {
    const bin = tempDir('plugin-install-bin-', t)
    for (const tool of ['git', 'tar', 'python3', 'dirname', 'mktemp']) symlinkSync(which(tool), join(bin, tool))
    const done = runCommand(COMMAND, { env: { ...process.env, PATH: bin } })
    assert.equal(done.code, 2, done.stderr)
    assert.match(done.stderr, /claude/)
  })
})
