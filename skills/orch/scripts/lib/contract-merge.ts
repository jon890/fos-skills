// 계약 파일 머리(버전, 변경 설명)만 충돌한 PR 에 base 를 로컬에서 합치고 push 하는 한 벌이다.
// 부르는 쪽: lib/conflicts.ts 의 resolveConflict(상주 루프의 충돌 처리와 notify-conflicts), queue/steps/update.ts(머지 차례의 update-branch 앞).
// 두 경로가 같은 판정과 같은 절차를 쓰게 하려고 여기 둔다. 근거는 ai-analysis PR 충돌 조사(계약 YAML 충돌 123회 중 118회가 info 안).
//
// 설정: config.json 의 contracts 절(docs/data-schema.md 「config.json 에 더하는 절」).
//   merge_command  bash 명령 문자열. 합치기가 충돌로 멈춘 임시 워크트리에서 돈다(MERGE_HEAD 가 base). 풀 수 있는 파일은 풀고 git add 한다.
//                  풀지 못한 파일이 있으면 0 이 아닌 코드로 끝내거나 그 파일을 unmerged 로 남긴다
//   paths          계약 파일 정규식 문자열이나 그 목록(Python 정규식. 목록은 `|` 로 잇는다)
//   둘 다 있어야 켜진다. 절이 없으면 null 이고 부르는 쪽은 지금 동작 그대로다. 하나만 있거나 타입이 틀리면 ConfigError 다.
//
// 판정(onlyContracts): 충돌 파일이 하나 이상이고 모두 paths 에 맞을 때만 합친다. 다른 파일이 하나라도 충돌하면 worker 에게 넘긴다.
//
// 절차(mergeContracts). 실패하면 원인을 reason 에 담아 낸다. 어느 경우에도 임시 워크트리는 지운다.
//   1. 주 checkout 에서 `git worktree add --detach <임시 폴더> <PR HEAD>`. 부르는 쪽이 PR HEAD 와 base 커밋을 로컬에 받아 둔다
//   2. `git merge --no-ff --no-commit <base SHA>`. 충돌 없이 끝나면 clean 이다(합치지 않고 지운다. 부르는 쪽이 하던 대로 한다)
//   3. unmerged 파일이 paths 밖에 있으면 other 다
//   4. merge_command 를 bash 로 돌린다. 환경에 ORCH_BASE(브랜치), ORCH_BASE_SHA, ORCH_PR(번호), ORCH_PR_BRANCH 를 둔다. 시간 제한은 MERGE_COMMAND_MS
//   5. 명령이 0 이 아니거나 unmerged 파일이 남았거나 충돌 표시 줄이 남았으면 failed 다
//   6. `git commit --no-verify -m <메시지>` 뒤 `git push --no-verify origin HEAD:refs/heads/<브랜치>`. 강제 push 는 하지 않는다.
//      그 사이 브랜치가 움직였으면 push 가 거부되어 failed 다. 훅을 건너뛰는 것은 임시 워크트리에 생성물이 없어 저장소 훅이 실패할 수 있어서다.
//      합친 결과의 검증은 PR CI 가 맡는다
//   pushed 의 head 는 push 한 merge 커밋 SHA 다.
//
// 머지 큐의 기능 완료 근거는 이 merge 커밋을 「base 합치기」 로 받아들인다(lib/feature-evidence.ts 의 baseMergesOnly 에 resolved 로 paths 를 준다).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './git.ts'
import { run } from './proc.ts'
import { contractSettings } from '../core/contracts.ts'
import type { ContractSettings } from '../core/contracts.ts'

export { contractSettings }
export type { ContractSettings }

export type ContractTarget = { number: number; branch: string; head: string; base: string; baseSha: string }

export type ContractMerge =
  | { kind: 'pushed'; head: string; output: string }
  | { kind: 'clean' }
  | { kind: 'other'; files: string[] }
  | { kind: 'failed'; reason: string; output: string }

export const MERGE_COMMAND_MS = 300_000
const MARKER = /^(?:<{7}|>{7}|\|{7})(?: |$)/m

export function onlyContracts(files: readonly string[], settings: ContractSettings): boolean {
  return files.length > 0 && files.every((file) => settings.paths.test(file))
}

function unmerged(dir: string): string[] | null {
  const done = git(dir, ['diff', '--name-only', '--diff-filter=U'])
  return done.code === 0 ? done.stdout.split('\n').filter((line) => line) : null
}

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-20).join('\n')
}

export function mergeContracts(repo: string, target: ContractTarget, settings: ContractSettings): ContractMerge {
  const dir = mkdtempSync(join(tmpdir(), 'orch-contract-'))
  let added = false
  try {
    const add = git(repo, ['worktree', 'add', '--detach', dir, target.head])
    if (add.code !== 0) return { kind: 'failed', reason: `임시 워크트리를 만들지 못했다: ${add.stderr.trim()}`, output: '' }
    added = true
    const merge = git(dir, ['merge', '--no-ff', '--no-commit', target.baseSha])
    if (merge.code === 0) return { kind: 'clean' }
    const before = unmerged(dir)
    if (before === null) return { kind: 'failed', reason: '충돌 파일을 읽지 못했다', output: '' }
    if (before.length === 0) return { kind: 'failed', reason: `git merge 가 충돌 없이 실패했다: ${merge.stderr.trim()}`, output: '' }
    if (!onlyContracts(before, settings)) return { kind: 'other', files: before }
    const done = run(['bash', '-c', settings.command], {
      cwd: dir,
      timeoutMs: MERGE_COMMAND_MS,
      env: { ORCH_BASE: target.base, ORCH_BASE_SHA: target.baseSha, ORCH_PR: String(target.number), ORCH_PR_BRANCH: target.branch },
    })
    const output = tail(done.stdout + done.stderr)
    if (done.code !== 0) return { kind: 'failed', reason: done.timedOut ? '합치기 명령이 시간 제한을 넘겼다' : `합치기 명령이 종료 코드 ${done.code} 로 끝났다`, output }
    const left = unmerged(dir)
    if (left === null || left.length > 0) return { kind: 'failed', reason: `풀리지 않은 파일이 남았다: ${(left ?? ['읽지 못함']).join(', ')}`, output }
    const marked = before.filter((file) => {
      try {
        return MARKER.test(readFileSync(join(dir, file), 'utf8'))
      } catch {
        return false
      }
    })
    if (marked.length > 0) return { kind: 'failed', reason: `충돌 표시가 남았다: ${marked.join(', ')}`, output }
    const message = `Merge ${target.base} into ${target.branch} (orch 계약 머리 자동 합치기)`
    const commit = git(dir, ['commit', '--no-verify', '-m', message])
    if (commit.code !== 0) return { kind: 'failed', reason: `merge 커밋을 만들지 못했다: ${commit.stderr.trim()}`, output }
    const head = git(dir, ['rev-parse', 'HEAD']).stdout.trim()
    const push = git(dir, ['push', '--no-verify', 'origin', `HEAD:refs/heads/${target.branch}`])
    if (push.code !== 0) return { kind: 'failed', reason: `push 가 거부됐다: ${tail(push.stderr).split('\n').pop() ?? ''}`, output }
    return { kind: 'pushed', head, output }
  } finally {
    if (added) git(repo, ['worktree', 'remove', '--force', dir])
    rmSync(dir, { recursive: true, force: true })
  }
}
