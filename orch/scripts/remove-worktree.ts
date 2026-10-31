// 터미널 소유 상태와 작업 디렉터리 사용자를 확인하고 발행한 깨끗한 워크트리를 지운다.
//
// 사용: remove-worktree.ts DIR [--delete-branch] [--merged-head SHA] [--wait SEC]
// OMC session-end hook과 자손은 ORCH_HOOK_WAIT초(기본 180초)까지 기다린다.
// 원격 브랜치는 지우지 않는다. 종료: 0 삭제, 1 거부, 2 인자 오류.
// 거부하는 경우: 그 경로를 쓰는 프로세스가 --wait 초 뒤에도 남았다, 커밋 안 된 변경이 있다,
// 원격 어디에도 없는 커밋이 있다, HEAD 가 --merged-head 의 조상이 아니다. 이유를 출력한다.
// 원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보지만 squash 머지는 제목이 달라 원격에 없는 커밋으로 센다.
// 그때 --merged-head 를 주면 그 커밋의 조상은 원격에 있는 것으로 센다.
// 출력 줄: 경로가 디렉터리가 아니면 `없음: <경로>`, 거부하면 `거부: <이유>`, 사용자 보유 터미널이나 소유 상태 조회 실패면
// `남김: <이유> (<경로>)` 다. 소유 판정은 lib/ownership.ts 의 blocker 다.
// --delete-branch: 워크트리가 브랜치에 있으면 그 브랜치를 지운다. detached 면(리뷰 worker 가 PR head 를 FETCH_HEAD 로 꺼낸 경우)
// 그 워크트리를 만든 브랜치(lib/review.ts 의 originBranch)를 지운다. 그 브랜치는 워크트리를 지운 뒤에 판정한다.
// 원격에 없는 커밋(--merged-head 의 조상은 뺀다)이 있으면 지우지 않고 `브랜치 남김 <브랜치>: 원격에 없는 커밋 <n> 개` 를 낸다.
// 다른 워크트리가 그 브랜치에 있으면 git 이 거절해 남는다. 워크트리를 지웠으면 브랜치를 남겨도 종료 코드는 0 이다.
// 환경 변수 ORCA 로 orca 실행 파일을 바꾼다. PATH 의 lsof, ps, sleep 을 부르고 git 2.31 이상이 필요하다.
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { realPath } from './lib/fs.ts'
import { git as gitIn } from './lib/git.ts'
import { blocker } from './lib/ownership.ts'
import { originBranch } from './lib/review.ts'
import { NO_LIMIT_MS, run } from './lib/proc.ts'
import type { RunResult } from './lib/proc.ts'
import { cwdHolders } from './lib/process.ts'

const USAGE = '사용법: remove-worktree.ts DIR [--delete-branch] [--merged-head SHA] [--wait SEC]'
const HOOK = /--omc-session-end-worker|hooks\/session-end\/worker\.js/
// 조상을 따라 올라가는 최대 단계. ps 출력의 부모 고리가 꼬여도 끝나게 한다
const MAX_DEPTH = 50

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

// 옛 명령은 git 호출에 시간 제한을 두지 않았다. 큰 워크트리의 remove 가 기본 60초에 끊기지 않게 한다
function git(repo: string, args: string[]): RunResult {
  return gitIn(repo, args, { timeoutMs: NO_LIMIT_MS })
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

// 1초 쉰다. setTimeout 이 아니라 sleep 명령을 부른다. 테스트가 PATH 앞의 가짜 sleep 으로 시계를 넘기기 때문이다.
function pause(): void {
  const done = run(['sleep', '1'])
  if (done.code !== 0) throw new Error(`sleep 1 이 종료 코드 ${done.code} 로 끝났다: ${done.stderr.trim()}`)
}

// 그 경로를 쓰는 pid 마다 OMC session-end hook 이거나 그 자손인지. ps 를 읽지 못하면 null 이다.
function hookHolders(holders: string[]): string[] | null {
  const processes = run(['ps', '-axo', 'pid=,ppid=,command='])
  if (processes.code !== 0) return null
  const parents = new Map<string, string>()
  const hooks = new Set<string>()
  for (const line of processes.stdout.split('\n')) {
    const row = /^\s*(\S+)\s+(\S+)\s+(\S.*)$/.exec(line)
    if (!row) continue
    parents.set(row[1], row[2])
    if (HOOK.test(row[3])) hooks.add(row[1])
  }
  return holders.filter((holder) => {
    let ancestor: string | undefined = holder
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (hooks.has(ancestor)) return true
      ancestor = parents.get(ancestor)
      if (ancestor === undefined || ancestor === '0') return false
    }
    return false
  })
}

async function main(argv: string[]): Promise<number> {
  const options = {
    'delete-branch': { type: 'boolean', default: false },
    'merged-head': { type: 'string', default: '' },
    wait: { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  let positionals
  try {
    ;({ values, positionals } = parseArgs({ args: expandArgs(argv, options), options, allowPositionals: true }))
  } catch (e) {
    err(`${USAGE}\nremove-worktree: ${(e as Error).message}`)
    return 2
  }
  if (values.help) {
    out(USAGE)
    return 0
  }
  if (positionals.length !== 1) {
    err(`${USAGE}\nremove-worktree: 워크트리 경로 하나가 필요하다`)
    return 2
  }
  const hookWait = process.env.ORCH_HOOK_WAIT ?? '180'
  if (!/^\d+$/.test(values.wait) || !/^\d+$/.test(hookWait)) {
    err(`${USAGE}\nremove-worktree: --wait 와 ORCH_HOOK_WAIT 는 0 이상의 정수다`)
    return 2
  }
  const wait = Number(values.wait)
  const mergedHead = values['merged-head']
  const target = realPath(positionals[0])
  if (!isDir(target)) {
    out(`없음: ${target}`)
    return 1
  }
  const common = git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (common.code !== 0) {
    out(`git worktree 가 아니다: ${target}`)
    return 1
  }
  const repo = dirname(common.stdout.trim())
  const branch = git(target, ['branch', '--show-current']).stdout.trim()
  // detached 워크트리를 만든 브랜치. reflog 는 워크트리를 지우면 사라지므로 먼저 읽는다
  const origin = values['delete-branch'] && !branch ? originBranch(target) : null

  // 소유 상태는 프로세스 대기 앞과 git worktree remove 바로 앞에서 두 번 본다.
  // 앞의 확인은 사용자 보유 터미널이면 hook 을 기다리지 않고 바로 남기게 한다.
  // 뒤의 확인은 그 뒤의 대기(최대 ORCH_HOOK_WAIT 초)와 git 확인 사이에 사용자가 터미널을 넘겨받은 경우를 잡는다.
  // 앞의 확인만 있으면 그사이 넘겨받은 터미널의 워크트리를 지운다.
  const owned = async (): Promise<boolean> => {
    const reason = await blocker(target)
    if (reason) out(`남김: ${reason} (${target})`)
    return !reason
  }
  if (!(await owned())) return 1

  let waited = 0
  for (;;) {
    const listing = cwdHolders(target)
    if (!listing.ok) {
      out('거부: cwd 프로세스 조회 실패')
      return 1
    }
    const holders = [...new Set(listing.holders.map((h) => String(h.pid)))].sort()
    if (holders.length === 0) break
    const hooks = hookHolders(holders)
    if (hooks === null) {
      out('거부: hook 프로세스 조회 실패')
      return 1
    }
    const onlyHooks = hooks.length === holders.length
    const limit = onlyHooks ? Math.max(wait, Number(hookWait)) : wait
    const joined = holders.join(', ')
    if (waited >= limit) {
      const note = hooks.length ? ` 그중 OMC session-end hook ${hooks.join(', ')} 는 스스로 끝난다.` : ''
      out(
        `거부: ${target} 를 쓰는 프로세스 ${holders.length} 개 (pid ${joined}), ${waited}초 기다림.${note} ` +
          '끝난 dispatch 의 프로세스면 cleanup-sweep.ts --kill-holders 가 끈다',
      )
      return 1
    }
    if (!waited && onlyHooks) out(`대기: ${target} 에 OMC session-end hook ${joined} 만 남았다. 끝날 때까지 최대 ${limit}초 기다린다`)
    pause()
    waited++
  }

  const status = git(target, ['status', '--porcelain'])
  if (status.code !== 0 || status.stdout.trim()) {
    out(`거부: ${target} 에 커밋 안 된 변경 또는 상태 조회 실패`)
    return 1
  }
  if (mergedHead && git(target, ['merge-base', '--is-ancestor', 'HEAD', mergedHead]).code !== 0) {
    out(`거부: ${target} 의 HEAD 가 머지된 커밋 ${mergedHead} 와 같지도 그 조상도 아니다`)
    return 1
  }
  const commits = git(target, ['rev-list', 'HEAD', '--not', '--remotes'])
  if (commits.code !== 0) {
    out('거부: 원격에 없는 커밋 조회 실패')
    return 1
  }
  let lost = 0
  for (const commit of commits.stdout.split('\n').filter((line) => line)) {
    if (mergedHead && git(target, ['merge-base', '--is-ancestor', commit, mergedHead]).code === 0) continue
    // rebase 하면 해시가 바뀌어 옛 커밋이 rev-list --not --remotes 에 남는다. 원격 어느 커밋 메시지에든 그 제목이
    // 들어 있으면 같은 작업으로 보고 세지 않는다. -F 는 제목을 정규식이 아니라 글자 그대로 찾게 해 괄호나 점이 든 제목도 맞게 한다.
    // squash 머지는 원격 커밋의 제목이 PR 제목이라 맞지 않는다. 그때는 위의 --merged-head 가 조상 관계로 센다.
    const subject = git(target, ['log', '-1', '--format=%s', commit]).stdout.trim()
    if (!git(target, ['log', '--remotes', '--format=%H', '-F', `--grep=${subject}`, '-1']).stdout.trim()) lost++
  }
  if (lost) {
    out(`거부: ${target} 에 원격에 없는 커밋 ${lost} 개`)
    return 1
  }
  if (!(await owned())) return 1
  const removed = git(repo, ['worktree', 'remove', target])
  if (removed.code !== 0) {
    err(removed.stderr)
    return 1
  }
  git(repo, ['worktree', 'prune'])
  out(`removed ${target}`)
  if (values['delete-branch'] && branch && git(repo, ['branch', '-D', branch]).code === 0) out(`deleted branch ${branch}`)
  if (origin) {
    const left = git(repo, ['rev-list', `refs/heads/${origin}`, '--not', '--remotes'])
    const unique = left.stdout.split('\n').filter((commit) => commit && !(mergedHead && git(repo, ['merge-base', '--is-ancestor', commit, mergedHead]).code === 0))
    if (left.code !== 0) out(`브랜치 남김 ${origin}: 원격에 없는 커밋 조회 실패`)
    else if (unique.length) out(`브랜치 남김 ${origin}: 원격에 없는 커밋 ${unique.length} 개`)
    else if (git(repo, ['branch', '-D', origin]).code === 0) out(`deleted branch ${origin}`)
  }
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e: unknown) => {
    err(`remove-worktree: ${(e as Error)?.stack ?? String(e)}`)
    process.exitCode = 1
  },
)
