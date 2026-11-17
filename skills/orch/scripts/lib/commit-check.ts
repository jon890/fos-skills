// worker 워크트리에 한국어 커밋 검사 훅을 건다. launch-worker 가 worker 를 띄우기 전에 부른다.
// 선택 이유는 docs/adr/036-worker-commit-korean-check.md, 훅이 하는 일은 skills/orch/githooks/dispatch.mjs 머리 주석이 소유한다.
//
//     installCommitCheck(worktree)   그 워크트리에만 걸리는 core.hooksPath 를 훅 폴더로 둔다. 몇 번을 불러도 결과가 같다
//
// 훅 폴더: <그 워크트리의 git 관리 폴더>/orch-hooks. 연결된 워크트리의 git 관리 폴더는 <공통 git 폴더>/worktrees/<id> 라서
//     작업 트리에 추적하지 않는 파일이 생기지 않고, `git worktree remove` 가 폴더째 지운다.
//         dispatch.mjs            훅 본체(githooks/dispatch.mjs 의 사본)
//         package.json            {"type":"module"}. 검사기 사본(.ts)이 대상 저장소 package.json 의 type 을 따라가지 않게 한다.
//                                 없으면 type 이 commonjs 인 저장소에서 검사기가 문법 오류로 죽는다
//         <훅 이름>               HOOK_NAMES 마다 dispatch.mjs 를 가리키는 심볼릭 링크
//         korean-check/scripts    같은 번들의 export-only-skills/korean-check/scripts 사본
//         korean-check/references 같은 번들의 references 사본. 폴더째 복사해 검사기가 읽는 파일이 늘어도 이 목록을 고치지 않는다
//     검사기를 번들 경로로 가리키지 않고 복사한다. 플러그인 설치 경로에는 버전이 들어 있어 갱신하면 없어지고,
//     끊긴 경로의 훅은 git 이 없는 훅으로 보고 조용히 지나간다. 사본은 다시 띄울 때(launch-worker --worktree) 새로 만든다.
//
// 걸지 않는 경우(skipped): quiet 가 true 면 부르는 쪽이 알리지 않는다.
//     git 작업 트리가 아니다(quiet). 주 checkout 이다(사용자가 직접 하는 커밋을 바꾸지 않는다).
//     검사기 번들이나 훅 본체가 없다. 워크트리 설정에 사용자가 둔 다른 core.hooksPath 가 있다(덮지 않는다).
//     값이 훅 폴더 이름(orch-hooks)으로 끝나면 이 함수가 둔 값으로 보고 지금 경로로 바꾼다. 저장소를 옮기면 박아 둔 절대경로가 낡는다.
//     공유 설정 때문에 워크트리 단위 설정을 켤 수 없다(lib/worktree-config.ts 의 enableWorktreeConfig).
// 실패(failed): 폴더나 설정을 쓰지 못했다. 설정 파일 잠금이 겹치면 setGitConfig 가 다시 한 뒤의 실패다.
//
// 훅 이름(HOOK_NAMES): 커밋, 머지, 리베이스, 체크아웃, push 때 불리는 클라이언트 훅이다. 훅 본체가 저장소의 원래 훅을 이어 부르므로,
//     이 목록에 없는 훅은 worker 워크트리에서 불리지 않는다. reference-transaction, post-index-change, fsmonitor-watchman 은 넣지 않는다.
//     ref 나 인덱스가 바뀔 때마다 불려 그때마다 node 가 뜬다.
//
// 푸는 법: 그 워크트리에서 `git config --worktree --unset core.hooksPath`. 저장소의 원래 훅 폴더로 돌아간다.
// 한계: `git commit --no-verify` 는 막지 못한다. `git rev-parse --git-path hooks` 가 이 훅 폴더를 가리키므로, 그 값으로 훅을 설치하는 도구가
//     worker 워크트리에서 설치를 돌리면 링크를 덮을 수 있다. 다시 띄우면 훅 폴더를 새로 만든다.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isFile, real } from './fs.ts'
import { git } from './git.ts'
import { enableWorktreeConfig, setGitConfig } from './worktree-config.ts'

export const HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'pre-auto-gc',
] as const

export type CommitCheckResult =
  | { status: 'set'; hooks: string }
  | { status: 'skipped'; reason: string; quiet: boolean }
  | { status: 'failed'; reason: string }

const HOOKS_DIR = 'orch-hooks'
const BUNDLE = join(import.meta.dirname, '..', '..', '..', '..')
const CHECKER = join(BUNDLE, 'export-only-skills', 'korean-check')
const DISPATCH = join(BUNDLE, 'skills', 'orch', 'githooks', 'dispatch.mjs')

function skipped(reason: string, quiet = false): CommitCheckResult {
  return { status: 'skipped', reason, quiet }
}

// source 는 테스트가 없는 경로를 넣어 건너뜀을 보는 자리다. 기본값은 이 번들의 검사기와 훅 본체다
export function installCommitCheck(worktree: string, source: { checker?: string; dispatch?: string } = {}): CommitCheckResult {
  const checker = source.checker ?? CHECKER
  const dispatch = source.dispatch ?? DISPATCH
  const inside = git(worktree, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return skipped('git 작업 트리가 아니다', true)
  const gitDir = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']).stdout.trim()
  const common = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim()
  if (!gitDir || !common) return skipped('git 작업 트리가 아니다', true)
  if (real(gitDir) === real(common)) return skipped('주 checkout 이라 걸지 않는다')
  for (const needed of [join(checker, 'scripts', 'check.ts'), join(checker, 'references', 'korean-style.md'), dispatch]) {
    if (!isFile(needed)) return skipped(`한국어 검사기 번들이 없다: ${needed}`)
  }

  const hooks = join(gitDir, HOOKS_DIR)
  // 확장이 꺼져 있으면 --worktree 읽기는 실패한다. 그때는 워크트리 단위 값이 없는 것이다
  const existing = git(worktree, ['config', '--worktree', '--get', 'core.hooksPath'])
  const current = existing.stdout.trim()
  // 이 함수가 둔 값은 훅 폴더 이름으로 끝난다. 저장소를 옮겨 경로가 달라진 옛 값이면 새 경로로 바꾼다
  if (existing.code === 0 && current && current !== hooks && basename(current) !== HOOKS_DIR) return skipped(`워크트리에 core.hooksPath 가 이미 있다: ${current}`)

  const enabled = enableWorktreeConfig(worktree)
  if (!enabled.ok) return enabled.status === 'skipped' ? skipped(enabled.reason) : { status: 'failed', reason: enabled.reason }

  const fresh = join(gitDir, `${HOOKS_DIR}.tmp-${process.pid}`)
  const old = join(gitDir, `${HOOKS_DIR}.old-${process.pid}`)
  try {
    rmSync(fresh, { recursive: true, force: true })
    mkdirSync(fresh, { recursive: true })
    copyFileSync(dispatch, join(fresh, 'dispatch.mjs'))
    chmodSync(join(fresh, 'dispatch.mjs'), 0o755)
    writeFileSync(join(fresh, 'package.json'), '{"type":"module"}\n')
    cpSync(join(checker, 'scripts'), join(fresh, 'korean-check', 'scripts'), { recursive: true })
    cpSync(join(checker, 'references'), join(fresh, 'korean-check', 'references'), { recursive: true })
    for (const name of HOOK_NAMES) symlinkSync('dispatch.mjs', join(fresh, name))
    // 옛 폴더를 지우는 동안 훅 폴더가 없으면 git 이 훅을 부르지 않는다. 옆 이름으로 옮긴 뒤 바꿔 넣어 그 틈을 이름 바꾸기 두 번 사이로 줄인다
    rmSync(old, { recursive: true, force: true })
    if (existsSync(hooks)) renameSync(hooks, old)
    renameSync(fresh, hooks)
    rmSync(old, { recursive: true, force: true })
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true })
    // 바꿔 넣지 못했으면 옛 폴더를 되돌린다. 훅 폴더가 없는 채로 남으면 저장소의 원래 훅까지 불리지 않는다
    try {
      if (!existsSync(hooks) && existsSync(old)) renameSync(old, hooks)
    } catch {
      // 되돌리지 못해도 아래 실패 이유는 그대로 알린다
    }
    return { status: 'failed', reason: `훅 폴더를 만들지 못했다: ${(e as Error).message}` }
  }
  const done = setGitConfig(worktree, ['--worktree', 'core.hooksPath', hooks])
  if (done.code !== 0) return { status: 'failed', reason: `core.hooksPath 를 쓰지 못했다: ${done.stderr.trim()}` }
  return { status: 'set', hooks }
}
