// 맥과 홈서버가 함께 쓰는 git 저장소 판정. 워크트리와 브랜치를 분류한다. 읽기 전용이다.
//
// 이 모듈은 orca 와 lsof 를 부르지 않는다. 워크트리 사용 여부(cwd 목록)와 Orca 정보는 부르는 쪽이 인자로 넘긴다.
// cwd 목록이 null 이면 사용 여부를 확인하지 못한 것이고, 워크트리의 in_use 는 '확인하지 못함' 이 되어 제거 후보에서 빠진다.

import { gitRun, runText, write } from '../io.ts'
import { pyHead, pySplitLines, pyStrCompare, pyStrip } from '../kit/py.ts'
import { expanduser, isDir, loadJson, osJoin, parsePyInt, pyResolve, pyTime, walk } from '../pylike.ts'

export const DEFAULT_GH_TIMEOUT = 20

const SKIP_DIRS = new Set(['node_modules', 'worktrees', '.orca-worktree-trash', '.git'])
const MAX_DEPTH = 3
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']
// 기준 브랜치가 아니어도 기본 브랜치나 배포 브랜치로 쓰는 이름이라 지우면 사람이 헷갈린다.
// alpha, beta 는 배포용 장수 브랜치다. PR 이 수십 개 머지돼 "PR 확인 필요" 후보로 올라오지만 지우면 안 된다.
const KEEP_BRANCHES = new Set(['main', 'master', 'develop', 'alpha', 'beta'])

type Json = Record<string, any>

export type Worktree = { path: string; branch: string | null; head: string | null; prunable: boolean; detached: boolean }

// `git worktree list --porcelain` 출력을 목록으로 만든다. 첫 항목이 메인 워크트리다
export function parseWorktrees(porcelain: string): Worktree[] {
  const items: Worktree[] = []
  let cur: Worktree | null = null
  for (const line of [...pySplitLines(porcelain), '']) {
    if (!pyStrip(line)) {
      if (cur) items.push(cur)
      cur = null
      continue
    }
    const at = line.indexOf(' ')
    const key = at < 0 ? line : line.slice(0, at)
    const value = at < 0 ? '' : line.slice(at + 1)
    if (key === 'worktree') cur = { path: value, branch: null, head: null, prunable: false, detached: false }
    else if (cur !== null) {
      if (key === 'HEAD') cur.head = value
      else if (key === 'branch') cur.branch = value.startsWith('refs/heads/') ? value.slice(11) : value
      else if (key === 'prunable') cur.prunable = true
      else if (key === 'detached') cur.detached = true
    }
  }
  return items
}

const STASH_RE = /^(?:WIP on|On) ([^\n]+?): /

// `git stash list --format=%gs` 출력에서 브랜치별 stash 수를 센다. 알아볼 수 없는 줄은 건너뛴다
export function parseStashBranches(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of pySplitLines(text)) {
    const m = STASH_RE.exec(line)
    if (m && m[1] !== '(no branch)') counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  return counts
}

// 로컬 브랜치 끝 커밋 tip 과 머지된 PR 목록(headRefOid 를 가진 객체)을 대조한다.
// 'merged': 머지된 PR 의 headRefOid 가 tip 과 같다. 'diverged': 머지된 PR 은 있으나 tip 이 다르다(PR 이후 로컬 커밋이 있다는 뜻이다).
// 'error': prs 가 null 이다. gh 호출이 실패해 확인하지 못했다. 분류에서는 판정 없음(null)과 같게 다룬다. null: 머지된 PR 이 없다
export function judgePr(tip: string, prs: Json[] | null): string | null {
  if (prs === null) return 'error'
  if (prs.length === 0) return null
  return prs.some((pr) => pr.headRefOid === tip) ? 'merged' : 'diverged'
}

// 워크트리 하나를 '제거 후보', '제거 후보(PR 머지됨)', '기록만 남음', 'PR 확인 필요', '유지' 로 나눈다
export function classifyWorktree(wt: Json, prState: string | null = null): string {
  if (wt.prunable) return '기록만 남음'
  const free = wt.dirty === 0 && wt.stash === 0 && !wt.in_use
  if (wt.merged) return free ? '제거 후보' : '유지'
  if (prState === 'merged') return free ? '제거 후보(PR 머지됨)' : '유지'
  if (prState === 'diverged' || wt.upstream_gone) return 'PR 확인 필요'
  return '유지'
}

// 브랜치 하나를 '삭제 후보(-d)', 'PR 머지됨(-D)', 'PR 확인 필요(-D)', '유지' 로 나눈다
export function classifyBranch(br: Json, base: string, checkedOut: Set<string>, prState: string | null = null): string {
  const name = br.name
  if (name === base || KEEP_BRANCHES.has(name) || name.startsWith('release/')) return '유지'
  if (checkedOut.has(name)) return '유지'
  if (br.merged) return '삭제 후보(-d)'
  if (prState === 'merged') return 'PR 머지됨(-D)'
  if (prState === 'diverged' || br.upstream_gone) return 'PR 확인 필요(-D)'
  return '유지'
}

// for-each-ref 출력(탭 구분: 이름, track, 커밋 시각, worktreepath, upstream, 끝 커밋)을 목록으로 만든다
export function parseBranches(output: string): Json[] {
  const rows: Json[] = []
  for (const line of pySplitLines(output)) {
    const parts = line.split('\t')
    if (parts.length < 4 || !parts[0]) continue
    rows.push({
      name: parts[0],
      upstream_gone: parts[1].includes('[gone]'),
      commit_ts: /^\p{Nd}+$/u.test(parts[2]) ? parsePyInt(parts[2]) : 0,
      worktreepath: parts[3],
      has_upstream: parts.length > 4 && Boolean(parts[4]),
      tip: parts.length > 5 && parts[5] ? parts[5] : null,
    })
  }
  return rows
}

const git = (repo: string, ...args: string[]) => gitRun(repo, args, { timeoutSec: 30 })

export function findRepos(roots: string[]): string[] {
  const repos: string[] = []
  for (const rawRoot of roots) {
    const root = expanduser(rawRoot)
    const baseDepth = root.replace(/\/+$/, '').split('/').length - 1
    for (const step of walk(root)) {
      const cur = step.current
      if (isDir(osJoin(cur, '.git'))) {
        repos.push(cur)
        step.directories.length = 0
        continue
      }
      if (cur.split('/').length - 1 - baseDepth >= MAX_DEPTH) {
        step.directories.length = 0
        continue
      }
      const kept = step.directories.filter((d) => !SKIP_DIRS.has(d))
      step.directories.splice(0, step.directories.length, ...kept)
    }
  }
  return [...new Set(repos)].sort(pyStrCompare)
}

export function baseRef(repo: string): string | null {
  const head = git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD')
  if (head.code === 0 && head.stdout.trim()) {
    const ref = head.stdout.trim()
    return ref.startsWith('refs/remotes/') ? ref.slice(13) : ref
  }
  for (const cand of BASE_CANDIDATES) {
    const full = cand.startsWith('origin/') ? `refs/remotes/${cand}` : `refs/heads/${cand}`
    if (git(repo, 'show-ref', '--verify', '-q', full).code === 0) return cand
  }
  return null
}

export function inUse(path: string, cwds: Set<string>): boolean {
  const real = pyResolve(path)
  for (const c of cwds) if (c === real || c.startsWith(`${real}/`)) return true
  return false
}

const BRANCH_FORMAT = '%(refname:short)\t%(upstream:track)\t%(committerdate:unix)\t%(worktreepath)\t%(upstream)\t%(objectname)'

// 머지된 PR 목록(number, headRefOid). gh 가 없거나 실패하면 null. 표준 입력을 닫지 않으면 gh 가 셸 반복문의 입력을 읽는다
export function mergedPrs(repo: string, branch: string, timeoutSec = DEFAULT_GH_TIMEOUT): Json[] | null {
  const done = runText(['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid'], { cwd: repo, timeoutSec, closeStdin: true })
  let message: string | null = null
  if (done.failure) message = done.message
  else if (done.code !== 0) message = pyHead(done.stderr.trim(), 120)
  else {
    try {
      const parsed = loadJson(done.stdout)
      if (Array.isArray(parsed)) return parsed
      message = 'JSON 이 목록이 아니다'
    } catch (error) {
      message = (error as Error).message
    }
  }
  write(2, `경고: gh 실패 ${repo} ${branch}: ${message}\n`)
  return null
}

export function surveyRepo(repo: string, cwds: Set<string> | null, orca: Set<string> | null, checkPrs = false, ghTimeout = DEFAULT_GH_TIMEOUT): Json | null {
  const base = baseRef(repo)
  if (!base) return null
  const wts = parseWorktrees(git(repo, 'worktree', 'list', '--porcelain').stdout)
  const allBranches = parseBranches(git(repo, 'for-each-ref', 'refs/heads', `--format=${BRANCH_FORMAT}`).stdout)
  const gone = new Set(allBranches.filter((b) => b.upstream_gone).map((b) => b.name))
  const hasUpstream = new Set(allBranches.filter((b) => b.has_upstream).map((b) => b.name))
  const stashes = parseStashBranches(git(repo, 'stash', 'list', '--format=%gs').stdout)
  const prCache = new Map<string, string | null>()

  // --check-prs 일 때 머지 판정이 안 됐고 upstream 이 있는 브랜치만 gh 로 묻고 끝 커밋을 대조한다. 결과는 저장소 안에서 재사용한다
  const prState = (name: string | null, merged: boolean): string | null => {
    if (!checkPrs || merged || !name || !hasUpstream.has(name)) return null
    if (!prCache.has(name)) {
      const prs = mergedPrs(repo, name, ghTimeout)
      const tip = git(repo, 'rev-parse', `refs/heads/${name}`).stdout.trim()
      prCache.set(name, judgePr(tip, prs))
    }
    return prCache.get(name)!
  }

  const now = pyTime()
  const worktrees: Json[] = []
  for (const wt of wts.slice(1)) {
    const entry: Json = { path: wt.path, branch: wt.branch, tip: wt.head, prunable: wt.prunable, orca: orca === null ? null : orca.has(pyResolve(wt.path)) }
    if (!wt.prunable) {
      entry.dirty = pySplitLines(git(wt.path, 'status', '--porcelain').stdout).filter((l) => l).length
      entry.stash = wt.branch ? (stashes.get(wt.branch) ?? 0) : 0
      entry.in_use = cwds === null ? '확인하지 못함' : inUse(wt.path, cwds)
      entry.merged = Boolean(wt.branch) && git(repo, 'merge-base', '--is-ancestor', wt.branch!, base).code === 0
      const ahead = wt.branch ? git(repo, 'rev-list', '--count', `${base}..${wt.branch}`) : null
      entry.ahead = ahead && ahead.code === 0 ? parsePyIntOrZero(ahead.stdout.trim()) : null
      const ts = git(wt.path, 'log', '-1', '--format=%ct').stdout.trim()
      entry.age_days = /^\p{Nd}+$/u.test(ts) ? Math.trunc((now - parsePyInt(ts)) / 86400) : null
      entry.upstream_gone = gone.has(wt.branch as string)
    } else {
      Object.assign(entry, { dirty: 0, stash: 0, in_use: false, merged: false, ahead: null, age_days: null, upstream_gone: false })
    }
    entry.pr_state = prState(wt.branch, entry.merged)
    entry.class = classifyWorktree(entry, entry.pr_state)
    worktrees.push(entry)
  }
  const checkedOut = new Set(wts.filter((w) => w.branch).map((w) => w.branch as string))
  const baseName = base.startsWith('origin/') ? base.slice(7) : base
  const branches: Json[] = []
  for (const br of allBranches) {
    br.merged = git(repo, 'merge-base', '--is-ancestor', br.name, base).code === 0
    br.pr_state = prState(br.name, br.merged)
    br.class = classifyBranch(br, baseName, checkedOut, br.pr_state)
    branches.push(br)
  }
  const ghErrors = [...prCache].filter(([, state]) => state === 'error').map(([name]) => name).sort(pyStrCompare)
  return { repo, base, gh_errors: ghErrors, worktrees, branches }
}

// int(text or 0)
const parsePyIntOrZero = (text: string): number => (text ? parsePyInt(text) : 0)

