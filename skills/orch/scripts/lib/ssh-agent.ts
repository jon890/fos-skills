// Codex worker 의 워크트리가 코디네이터의 ssh-agent 를 쓰게 하는 git 설정이다.
//
// Codex 는 사용자의 `shell_environment_policy.inherit = "core"` 설정이 있으면 자식 셸의 환경 변수에서 SSH_AUTH_SOCK 을 뺀다.
// 그러면 worker 의 git fetch, push 가 `Permission denied (publickey)` 로 막힌다(2026-11-01 실측).
// Orca 의 worker-start 에는 Codex 실행 인자(-c)를 넘길 옵션이 없어 환경 변수로는 되돌릴 수 없다. 대신 그 워크트리에만 걸리는
// `core.sshCommand` 에 소켓 경로를 박는다. 환경 변수와 달리 git 이 설정 파일에서 읽으므로 Codex 의 환경 정책이 닿지 않는다.
//
//     configureSshAgent(worktree, sock)   워크트리 단위 설정(`git config --worktree`)에 core.sshCommand 를 둔다
//
// 공유 설정(.git/config)에는 sshCommand 를 쓰지 않는다. 다른 워크트리와 주 checkout 의 ssh 가 바뀌면 안 된다.
// 워크트리 단위 설정은 `extensions.worktreeConfig` 가 켜져 있어야 해서, 꺼져 있으면 공유 설정에서 켠다.
// 사용자가 이미 core.sshCommand 를 정했으면(어느 범위든) 덮지 않는다. 이 함수가 앞서 둔 값(`ssh -o IdentityAgent=` 로 시작)만 새 소켓으로 갱신한다.
// core.bare 나 core.worktree 가 공유 설정에 있으면 extensions.worktreeConfig 를 켜지 않고 건너뛴다. 켜면 그 두 값을 옮겨야 한다.

import { git } from './git.ts'
import { shQuote } from './py.ts'

export type SshAgentResult =
  | { status: 'set'; command: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

const OURS = /^ssh -o IdentityAgent=/

// `ssh -o IdentityAgent=<sock>` 한 줄. git 이 이 값을 셸로 풀고, ssh 는 -o 값을 설정 파일 문법으로 읽는다.
// 그래서 공백이 든 경로는 ssh 쪽 큰따옴표와 셸 쪽 작은따옴표를 모두 입힌다. 큰따옴표와 줄바꿈이 든 경로는 만들지 않는다(null).
export function sshCommandFor(sock: string): string | null {
  if (!sock || /["\r\n\0]/.test(sock)) return null
  const option = /\s/.test(sock) ? `IdentityAgent="${sock}"` : `IdentityAgent=${sock}`
  return `ssh -o ${shQuote(option)}`
}

export function configureSshAgent(worktree: string, sock: string | undefined): SshAgentResult {
  if (!sock) return { status: 'skipped', reason: 'SSH_AUTH_SOCK 이 없다' }
  const command = sshCommandFor(sock)
  if (command === null) return { status: 'skipped', reason: 'SSH_AUTH_SOCK 값에 큰따옴표나 줄바꿈이 있어 설정으로 옮길 수 없다' }
  const inside = git(worktree, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { status: 'skipped', reason: 'git 작업 트리가 아니다' }

  const existing = git(worktree, ['config', '--get', 'core.sshCommand'])
  const current = existing.stdout.trim()
  if (existing.code === 0 && current && !OURS.test(current)) return { status: 'skipped', reason: `core.sshCommand 가 이미 있다: ${current}` }

  const enabled = git(worktree, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'])
  if (enabled.stdout.trim() !== 'true') {
    for (const key of ['core.worktree']) {
      if (git(worktree, ['config', '--local', '--get', key]).code === 0) return { status: 'skipped', reason: `공유 설정에 ${key} 가 있어 worktreeConfig 를 켜지 않는다` }
    }
    if (git(worktree, ['config', '--local', '--type=bool', '--get', 'core.bare']).stdout.trim() === 'true') {
      return { status: 'skipped', reason: '공유 설정의 core.bare 가 true 라 worktreeConfig 를 켜지 않는다' }
    }
    const on = git(worktree, ['config', '--local', 'extensions.worktreeConfig', 'true'])
    if (on.code !== 0) return { status: 'failed', reason: `extensions.worktreeConfig 를 켜지 못했다: ${on.stderr.trim()}` }
  }
  const done = git(worktree, ['config', '--worktree', 'core.sshCommand', command])
  if (done.code !== 0) return { status: 'failed', reason: `core.sshCommand 를 쓰지 못했다: ${done.stderr.trim()}` }
  return { status: 'set', command }
}
