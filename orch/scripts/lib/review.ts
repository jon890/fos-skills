// 리뷰 worker 의 흔적(브랜치, 지시서, 워크트리)을 PR 번호로 알아보는 한 벌이다.
//
// 리뷰 worker 는 남의 PR 을 읽기만 하고 PR 을 열지 않는다. 그래서 cleanup-sweep 의 「PR 찾기」 로는 그 브랜치를 찾지 못한다.
// 10-31 에 `pr-N`, `review/pr-N` 브랜치와 `spec-review-pr-N*.md` 지시서가 26개 쌓였다. 여기서 이름과 지시서 줄로 PR 번호를 읽는다.
//
// 이름 규칙:
//     브랜치   `pr-<N>`(옛 리뷰 지시서가 `git fetch origin pull/N/head:pr-N` 으로 만든 것),
//              `review/pr-<N>` 과 그 뒤에 `-<꼬리>` 가 붙은 것(`review/pr-1123-3` 처럼 같은 PR 을 다시 리뷰한 것)
//     지시서   `spec-review-pr-<N>.md` 와 `spec-review-pr-<N>-<꼬리>.md`, 그리고 본문에 `리뷰 PR: #<N>` 줄이 있는 지시서
//     줄 머리의 `리뷰 PR: #N` 은 목록 기호와 굵은 글씨를 브랜치 줄(lib/spec.ts 의 BRANCH_LINE)처럼 받는다. `#` 는 없어도 된다
//
// 리뷰가 끝났는지(reviewKeepReason): PR 이 MERGED 나 CLOSED 이고, 모든 Run 의 살아 있는 dispatch 지시서(lib/spec.ts 의 allLiveSpecPaths)
//     가운데 같은 번호의 리뷰 지시서가 없어야 끝난 것이다. PR 을 읽지 못하거나 지시서 목록을 읽지 못하면 끝나지 않은 것으로 본다.
//     cleanup-sweep 의 리뷰 흔적 정리와 remove-worktree 의 detached 브랜치 삭제가 같은 판정을 쓴다.
//
// originBranch: detached 워크트리를 만든 브랜치. 리뷰 worker 는 `review/pr-N` 브랜치로 만든 워크트리에서 PR head 를 detached 로 꺼낸다.
//     그 뒤로 git 은 그 브랜치를 워크트리의 것으로 보지 않아 remove-worktree --delete-branch 가 지우지 못했다(10-31 실측).
//     워크트리 HEAD 의 reflog 에서 가장 오래된 `checkout: moving from <브랜치> to ` 줄의 <브랜치> 를 읽는다.
//     그 이름의 로컬 브랜치가 지금 있을 때만 낸다. reflog 가 없거나 checkout 줄이 없으면 null 이다.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ghJson } from './gh.ts'
import { git } from './git.ts'
import { allLiveSpecPaths, LINE_BREAK } from './spec.ts'

const BRANCH = /^(?:pr-(\d+)|review\/pr-(\d+)(?:-[A-Za-z0-9._-]+)?)$/
const SPEC_NAME = /^spec-review-pr-(\d+)(?:-[^/]*)?\.md$/
const REVIEW_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?리뷰 PR(?:\*\*)?\s*:(?:\*\*)?\s*#?(\d+)\b/
const CHECKOUT = /^checkout: moving from (\S+) to /

function number(text: string | undefined): number | null {
  const n = Number(text)
  return Number.isInteger(n) && n > 0 ? n : null
}

// 리뷰 브랜치 이름이면 그 PR 번호, 아니면 null
export function reviewPrOfBranch(branch: string): number | null {
  const m = BRANCH.exec(branch)
  return m ? number(m[1] ?? m[2]) : null
}

// 지시서 파일 이름(경로 아님)이 리뷰 지시서 꼴이면 그 PR 번호, 아니면 null
export function reviewPrOfSpecName(name: string): number | null {
  const m = SPEC_NAME.exec(name)
  return m ? number(m[1]) : null
}

// 지시서 본문의 첫 `리뷰 PR:` 줄의 번호. 없으면 null
export function reviewPrOfSpec(text: string): number | null {
  for (const line of text.split(LINE_BREAK)) {
    const m = REVIEW_LINE.exec(line)
    if (m) return number(m[1])
  }
  return null
}

// 지시서 하나의 리뷰 PR 번호. 본문 줄을 이름보다 먼저 본다
export function reviewPrOf(name: string, text: string | null): number | null {
  return (text === null ? null : reviewPrOfSpec(text)) ?? reviewPrOfSpecName(name)
}

// 워크트리를 만든 브랜치(머리 주석의 originBranch). 브랜치에 있는 워크트리면 그 브랜치를 낸다
export function originBranch(worktree: string): string | null {
  const current = git(worktree, ['branch', '--show-current'])
  if (current.code !== 0) return null
  if (current.stdout.trim()) return current.stdout.trim()
  const log = git(worktree, ['reflog', 'show', '--format=%gs', 'HEAD'])
  if (log.code !== 0) return null
  const lines = log.stdout.split('\n').filter((line) => line)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = CHECKOUT.exec(lines[i])
    if (!m) continue
    if (git(worktree, ['show-ref', '--verify', '--quiet', `refs/heads/${m[1]}`]).code !== 0) return null
    return m[1]
  }
  return null
}

export type ReviewPr = { state: string; head: string }

const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])

// `gh pr view <N> --json state,headRefOid`. 읽지 못하거나 state 를 모르면 null
export function reviewPrState(repo: string, n: number): ReviewPr | null {
  const view = ghJson<{ state?: unknown; headRefOid?: unknown }>(['pr', 'view', String(n), '--json', 'state,headRefOid'], { cwd: repo })
  if (!view.ok || typeof view.data !== 'object' || view.data === null) return null
  const state = String(view.data.state)
  if (!PR_STATES.has(state)) return null
  return { state, head: typeof view.data.headRefOid === 'string' ? view.data.headRefOid : '' }
}

// 살아 있는 지시서 경로 가운데 리뷰 지시서의 PR 번호. 목록이 null 이면 null
export function liveReviewPrs(live: Set<string> | null): Set<number> | null {
  if (live === null) return null
  const found = new Set<number>()
  for (const path of live) {
    let text: string | null
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      text = null
    }
    const n = reviewPrOf(basename(path), text)
    if (n !== null) found.add(n)
  }
  return found
}

// 머리 주석의 「리뷰가 끝났는지」. 끝났으면 null, 아니면 남길 이유다. live 는 liveReviewPrs 의 결과다
export function reviewKeepReason(pr: ReviewPr | null, n: number, live: Set<number> | null): string | null {
  if (pr === null) return 'PR 을 읽지 못했다'
  if (pr.state === 'OPEN') return 'PR 이 열려 있다'
  if (live === null) return '살아 있는 지시서 목록을 읽지 못했다'
  if (live.has(n)) return '리뷰 dispatch 가 살아 있다'
  return null
}

// 모든 Run 의 살아 있는 리뷰 PR 번호. 판정할 수 없으면 null
export function liveReviews(): Set<number> | null {
  return liveReviewPrs(allLiveSpecPaths())
}
