// 워크트리 단위 git 설정(`git config --worktree`)을 쓰기 위한 판정과 쓰기 한 벌이다. lib/ssh-agent.ts 와 lib/commit-check.ts 가 쓴다.
//
//     enableWorktreeConfig(worktree)   공유 설정의 extensions.worktreeConfig 를 켠다. 이미 켜져 있으면 그대로 둔다
//     setGitConfig(worktree, args)     `git config <args>` 를 쓴다. 설정 파일 잠금이 겹치면 다시 한다
//
// 워크트리 단위 설정은 `extensions.worktreeConfig` 가 켜져 있어야 해서, 꺼져 있으면 공유 설정(.git/config)에서 켠다.
// 공유 설정에 core.worktree 가 있거나 core.bare 가 true 면 켜지 않고 건너뛴다. 켜면 그 두 값을 주 checkout 의 설정으로 옮겨야 한다.
// 이 확장은 core.repositoryFormatVersion 을 올리지 않는다. git 이 0 에서도 읽는다.
//
// 잠금: worker 여럿을 함께 띄우면 공유 설정 파일의 잠금(config.lock)이 겹쳐 git 이 `could not lock config file` 로 실패한다.
//     setGitConfig 는 그 문구가 있을 때만 LOCK_WAIT_MS 쉬고 다시 해 모두 LOCK_TRIES 번까지 한다. 다른 실패는 다시 하지 않는다.

import { git } from './git.ts'
import type { RunResult } from './proc.ts'

export type WorktreeConfigResult = { ok: true } | { ok: false; status: 'skipped' | 'failed'; reason: string }

const LOCK_TRIES = 3
const LOCK_WAIT_MS = 100
const LOCKED = /could not lock config file/

export function setGitConfig(worktree: string, args: string[]): RunResult {
  let done = git(worktree, ['config', ...args])
  for (let tried = 1; tried < LOCK_TRIES && done.code !== 0 && LOCKED.test(done.stderr); tried++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS)
    done = git(worktree, ['config', ...args])
  }
  return done
}

export function enableWorktreeConfig(worktree: string): WorktreeConfigResult {
  const enabled = git(worktree, ['config', '--local', '--type=bool', '--get', 'extensions.worktreeConfig'])
  if (enabled.stdout.trim() === 'true') return { ok: true }
  for (const key of ['core.worktree']) {
    if (git(worktree, ['config', '--local', '--get', key]).code === 0) return { ok: false, status: 'skipped', reason: `공유 설정에 ${key} 가 있어 worktreeConfig 를 켜지 않는다` }
  }
  if (git(worktree, ['config', '--local', '--type=bool', '--get', 'core.bare']).stdout.trim() === 'true') {
    return { ok: false, status: 'skipped', reason: '공유 설정의 core.bare 가 true 라 worktreeConfig 를 켜지 않는다' }
  }
  const on = setGitConfig(worktree, ['--local', 'extensions.worktreeConfig', 'true'])
  if (on.code !== 0) return { ok: false, status: 'failed', reason: `extensions.worktreeConfig 를 켜지 못했다: ${on.stderr.trim()}` }
  return { ok: true }
}
