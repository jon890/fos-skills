import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { configureSshAgent, sshCommandFor } from '../scripts/lib/ssh-agent.ts'

// 전역 설정과 작성자를 고정한다. 프로세스가 파일마다 나뉘어 다른 파일에 새지 않는다.
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const saved: Record<string, string | undefined> = {}

let tmp: string
let proj: string
let wt: string

function g(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

before(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-agent-')))
  proj = join(tmp, 'proj')
  wt = join(tmp, 'wt')
  spawnSync('git', ['init', '-q', '-b', 'main', proj])
  g(proj, 'commit', '-q', '--allow-empty', '-m', 'init')
  g(proj, 'worktree', 'add', '-q', '-b', 'feature/x', wt)
})

describe('sshCommandFor', () => {
  test('평범한 경로는 따옴표 없이 쓴다', () => {
    assert.equal(sshCommandFor('/private/tmp/com.apple.launchd.AbC/Listeners'), 'ssh -o IdentityAgent=/private/tmp/com.apple.launchd.AbC/Listeners')
  })
  test('공백이 든 경로는 ssh 쪽 큰따옴표와 셸 쪽 작은따옴표를 입힌다', () => {
    assert.equal(sshCommandFor('/tmp/a b/agent.sock'), `ssh -o 'IdentityAgent="/tmp/a b/agent.sock"'`)
  })
  test('작은따옴표가 든 경로는 셸 인용으로 풀어 쓴다', () => {
    assert.equal(sshCommandFor("/tmp/it's/s"), `ssh -o 'IdentityAgent=/tmp/it'"'"'s/s'`)
  })
  test('큰따옴표나 줄바꿈이 든 경로, 빈 값은 만들지 않는다', () => {
    assert.equal(sshCommandFor('/tmp/a"b'), null)
    assert.equal(sshCommandFor('/tmp/a\nb'), null)
    assert.equal(sshCommandFor(''), null)
  })
})

describe('configureSshAgent', () => {
  test('워크트리 설정에만 두고 공유 설정과 주 checkout 은 그대로다', () => {
    const r = configureSshAgent(wt, '/tmp/agent.sock')
    assert.deepEqual(r, { status: 'set', command: 'ssh -o IdentityAgent=/tmp/agent.sock' })
    assert.equal(g(wt, 'config', '--worktree', '--get', 'core.sshCommand').stdout.trim(), 'ssh -o IdentityAgent=/tmp/agent.sock')
    assert.equal(g(proj, 'config', '--local', '--get', 'core.sshCommand').status, 1)
    assert.equal(g(proj, 'config', '--get', 'core.sshCommand').status, 1)
    assert.equal(g(proj, 'config', '--local', '--get', 'extensions.worktreeConfig').stdout.trim(), 'true')
  })

  test('공백이 든 소켓 경로도 ssh 가 읽는 한 낱말이 된다', () => {
    configureSshAgent(wt, '/tmp/a b/agent.sock')
    const cmd = g(wt, 'config', '--get', 'core.sshCommand').stdout.trim()
    const words = spawnSync('sh', ['-c', `printf '%s\\n' ${cmd}`], { encoding: 'utf8' }).stdout.trim().split('\n')
    assert.deepEqual(words, ['ssh', '-o', 'IdentityAgent="/tmp/a b/agent.sock"'])
  })

  test('사용자가 정한 core.sshCommand 는 어느 범위든 덮지 않는다', () => {
    g(proj, 'config', '--local', 'core.sshCommand', 'ssh -i /my/key')
    const r = configureSshAgent(wt, '/tmp/agent.sock')
    assert.equal(r.status, 'skipped')
    assert.equal(g(wt, 'config', '--get', 'core.sshCommand').stdout.trim(), 'ssh -i /my/key')
    assert.equal(g(proj, 'config', '--local', '--get', 'extensions.worktreeConfig').status, 1)
  })

  test('앞서 둔 값은 새 소켓으로 갱신한다', () => {
    configureSshAgent(wt, '/tmp/old.sock')
    const r = configureSshAgent(wt, '/tmp/new.sock')
    assert.equal(r.status, 'set')
    assert.equal(g(wt, 'config', '--get', 'core.sshCommand').stdout.trim(), 'ssh -o IdentityAgent=/tmp/new.sock')
  })

  test('소켓이 없거나 git 작업 트리가 아니면 건너뛴다', () => {
    assert.equal(configureSshAgent(wt, undefined).status, 'skipped')
    assert.equal(configureSshAgent(wt, '').status, 'skipped')
    assert.equal(configureSshAgent(tmp, '/tmp/agent.sock').status, 'skipped')
  })

  test('다른 워크트리에는 번지지 않는다', () => {
    const other = join(tmp, 'other')
    g(proj, 'worktree', 'add', '-q', '-b', 'feature/y', other)
    configureSshAgent(wt, '/tmp/agent.sock')
    assert.equal(g(other, 'config', '--get', 'core.sshCommand').status, 1)
  })
})
