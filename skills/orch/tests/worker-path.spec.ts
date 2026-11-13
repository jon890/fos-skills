// lib/worker-path.ts 가 worker 셸의 PATH 에서 orch 실행기를 찾는지 본다. 가짜 셸과 임시 HOME 만 쓴다.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { LAUNCHER_MARK } from '../scripts/lib/commands.ts'
import { checkWorkerOrch, installedLauncherDir, workerShellPath } from '../scripts/lib/worker-path.ts'
import { workerPathWithOrch } from './fixtures/worker-orch.ts'

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'worker-path-')))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

// 받은 인자와 PATH 환경 변수를 기록하고 정한 PATH 를 내는 가짜 셸. 이름이 셸 종류를 정한다
function fakeShell(name: string, printed: string, exit = 0): { shell: string; record: string } {
  const dir = join(tmp, `sh-${name}`)
  mkdirSync(dir, { recursive: true })
  const shell = join(dir, name)
  const record = join(tmp, `record-${name}`)
  writeFileSync(shell, `#!/bin/sh\nprintf '%s|%s' "$*" "\${PATH-unset}" > '${record}'\n[ ${exit} -eq 0 ] && printf %s '${printed}'\nexit ${exit}\n`)
  chmodSync(shell, 0o755)
  return { shell, record }
}

function home(withCopy: boolean): string {
  const h = join(tmp, 'home')
  mkdirSync(join(h, '.local', 'bin'), { recursive: true })
  if (withCopy) writeFileSync(join(h, '.local', 'bin', 'orch'), `#!/usr/bin/env node\n// ${LAUNCHER_MARK}\n`)
  return h
}

describe('workerShellPath', () => {
  test('ORCH_WORKER_PATH 가 있으면 셸을 열지 않고 그 값을 낸다', () => {
    assert.equal(workerShellPath({ ORCH_WORKER_PATH: '/a:/b', ORCH_WORKER_SHELL: join(tmp, 'none') }), '/a:/b')
  })

  test('zsh 는 -c 로, 다른 셸은 -lc 로 PATH 없이 띄워 출력한 PATH 를 읽는다', () => {
    const zsh = fakeShell('zsh', '/z/bin:/usr/bin')
    assert.equal(workerShellPath({ ORCH_WORKER_SHELL: zsh.shell, PATH: '/coordinator/only' }), '/z/bin:/usr/bin')
    // 셸이 PATH 가 없을 때 스스로 정하는 기본값은 막지 못한다. 코디네이터의 PATH 가 새지 않았는지만 본다
    assert.match(readFileSync(zsh.record, 'utf8'), /^-c printf %s "\$PATH"\|(?!.*coordinator)/)
    const bash = fakeShell('bash', '/b/bin')
    assert.equal(workerShellPath({ ORCH_WORKER_SHELL: bash.shell }), '/b/bin')
    assert.match(readFileSync(bash.record, 'utf8'), /^-lc /)
  })

  test('셸이 실패하거나 없으면 null 이다', () => {
    assert.equal(workerShellPath({ ORCH_WORKER_SHELL: fakeShell('zsh', '', 1).shell }), null)
    assert.equal(workerShellPath({ ORCH_WORKER_SHELL: join(tmp, 'none') }), null)
  })
})

describe('checkWorkerOrch', () => {
  test('worker PATH 의 첫 orch 가 실행기면 통과하고 그 파일을 낸다', () => {
    const r = checkWorkerOrch({ ORCH_WORKER_PATH: workerPathWithOrch(tmp) }, home(false))
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.file, join(tmp, 'worker-bin', 'orch'))
  })

  test('코디네이터 프로세스의 PATH 에 실행기가 있어도 worker 셸에 없으면 막는다', () => {
    const coordinator = workerPathWithOrch(tmp)
    const shell = fakeShell('zsh', '/usr/bin:/bin')
    const r = checkWorkerOrch({ PATH: coordinator, ORCH_WORKER_SHELL: shell.shell }, home(false))
    assert.equal(r.ok, false)
  })

  test('못 찾았고 ~/.local/bin 사본도 없으면 install-cli 와 PATH 설정을 안내한다', () => {
    const h = home(false)
    const r = checkWorkerOrch({ ORCH_WORKER_PATH: '/usr/bin:/bin', ORCH_WORKER_SHELL: '/bin/zsh' }, h)
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /PATH=\/usr\/bin:\/bin/)
    assert.equal(r.fix[0], 'orch doctor install-cli')
    assert.match(r.fix[1], new RegExp(`~/\\.zshenv에 export PATH="${join(h, '.local', 'bin')}:\\$PATH"`))
  })

  test('사본은 깔렸는데 PATH 에 없으면 PATH 설정만 안내한다', () => {
    const r = checkWorkerOrch({ ORCH_WORKER_PATH: '/usr/bin:/bin' }, home(true))
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.fix.length, 1)
    assert.match(r.fix[0], /export PATH=/)
  })

  test('PATH 의 첫 orch 가 표지 없는 다른 파일이면 막는다', () => {
    const other = join(tmp, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'orch'), '#!/bin/sh\n')
    const r = checkWorkerOrch({ ORCH_WORKER_PATH: `${other}:${workerPathWithOrch(tmp)}` }, home(false))
    assert.equal(r.ok, false)
  })

  test('셸을 열지 못하면 그 이유를 낸다', () => {
    const r = checkWorkerOrch({ ORCH_WORKER_SHELL: join(tmp, 'none') }, home(false))
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.reason : '', /PATH 를 읽지 못했다/)
  })
})

test('installedLauncherDir: 표지 있는 사본이 있을 때만 폴더를 낸다', () => {
  assert.equal(installedLauncherDir(home(false)), null)
  assert.equal(installedLauncherDir(home(true)), join(tmp, 'home', '.local', 'bin'))
})
