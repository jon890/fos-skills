// 열린 PR 의 충돌 찾기와 (PR, base SHA) 마다 한 번 알린 기록의 한 벌이다. notify-conflicts 와 상주 루프가 쓰고,
// PR HEAD 받기(fetchPrHead)와 base 받기(baseHead)는 ci-ready 도 쓴다. 충돌 판정은 lib/git.ts 의 conflicts(merge-tree) 한 벌이다.
// GitHub 의 mergeable 은 머지 직후 한동안 UNKNOWN 이라 쓰지 않는다.
//
// 실패는 예외 대신 { ok: false, error } 로 낸다. 부르는 쪽이 조회 실패(종료 코드 2)나 보류로 바꾼다.
//
// 알린 기록: <orch 루트>/state/notify-conflicts.json. 옛 notify-conflicts.py 와 같은 파일과 키(`<PR>@<base SHA>`)다.
//   값은 notified 와 resumed 면 dispatch id, orphan 이면 `orphan` 이다. base 가 움직이면 키가 달라져 다시 알린다.
//   파일이 없거나 깨졌으면 빈 기록이다. 쓰기는 lib/paths.ts 의 makeParent 로 부모 폴더를 만들고 git 이 무시하게 한 뒤 한다.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { conflicts, git } from './git.ts'
import { ghJson } from './gh.ts'
import { makeParent, pathOf } from './paths.ts'

export type OpenPr = {
  number: number
  title: string
  headRefName: string
  headRefOid: string
  isCrossRepository: boolean
  isDraft: boolean
  author: { login: string }
  url: string
}

export type Failure = { ok: false; error: string }

const PR_FIELDS = 'number,title,headRefName,headRefOid,isCrossRepository,isDraft,author,url'
export const ORPHAN = 'orphan'

// origin 을 받고 origin/<base> 의 SHA 를 낸다.
export function baseHead(repo: string, base: string): { ok: true; sha: string } | Failure {
  if (git(repo, ['fetch', '-q', 'origin']).code !== 0) return { ok: false, error: 'git fetch origin 실패' }
  const done = git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`])
  const sha = done.stdout.trim()
  if (done.code !== 0 || !sha) return { ok: false, error: `origin/${base} 가 없다` }
  return { ok: true, sha }
}

// PR HEAD 커밋을 로컬에 둔다. 이미 있으면 받지 않는다. cross repo PR 은 refs/pull/<번호>/head 를, 아니면 headRefName 을 origin 에서 받는다.
// 받은 뒤에도 그 커밋이 없으면 ok: false 다.
export function fetchPrHead(repo: string, pr: Pick<OpenPr, 'number' | 'headRefName' | 'headRefOid' | 'isCrossRepository'>): { ok: true } | Failure {
  const has = () => git(repo, ['cat-file', '-e', `${pr.headRefOid}^{commit}`]).code === 0
  if (has()) return { ok: true }
  const ref = pr.isCrossRepository ? `refs/pull/${pr.number}/head` : pr.headRefName
  const done = git(repo, ['fetch', '-q', 'origin', ref])
  if (has()) return { ok: true }
  const why = done.code !== 0 ? `: ${done.stderr.trim() || `종료 코드 ${done.code}`}` : ''
  return { ok: false, error: `#${pr.number} 의 HEAD ${pr.headRefOid} 를 받지 못했다(origin ${ref})${why}` }
}

// base 와 충돌하는 열린 PR 과 충돌 파일. 작성자로 고르지 않는다. 내 PR 판정은 부르는 쪽이 lib/gh.ts 로 한다.
export function findConflicts(repo: string, base: string): { ok: true; baseSha: string; found: { pr: OpenPr; files: string[] }[] } | Failure {
  const head = baseHead(repo, base)
  if (!head.ok) return head
  const listed = ghJson<OpenPr[]>(['pr', 'list', '--state', 'open', '--base', base, '--limit', '200', '--json', PR_FIELDS], { cwd: repo })
  if (!listed.ok) return listed
  if (!Array.isArray(listed.data)) return { ok: false, error: 'gh pr list 의 출력이 목록이 아니다' }
  const found: { pr: OpenPr; files: string[] }[] = []
  for (const pr of listed.data) {
    const fetched = fetchPrHead(repo, pr)
    if (!fetched.ok) return { ok: false, error: `#${pr.number} 를 base 와 합쳐 보지 못했다: ${fetched.error}` }
    const merged = conflicts(repo, head.sha, pr.headRefOid)
    if (!merged.ok) return { ok: false, error: `#${pr.number} 를 base 와 합쳐 보지 못했다: ${merged.error}` }
    if (merged.conflict) found.push({ pr, files: merged.files })
  }
  return { ok: true, baseSha: head.sha, found }
}

export function notifiedFile(repo: string): string {
  return join(pathOf('state', repo), 'notify-conflicts.json')
}

export function notifiedKey(pr: number, baseSha: string): string {
  return `${pr}@${baseSha}`
}

export function loadNotified(file: string): Record<string, string> {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, string>) : {}
}

// 기록에 key 를 더해 파일 전체를 다시 쓴다. 옛 명령과 같이 키를 정렬하고 두 칸 들여 쓴다.
export function recordNotified(file: string, repo: string, key: string, value: string): void {
  const state = loadNotified(file)
  state[key] = value
  const sorted = Object.fromEntries(Object.keys(state).sort().map((name) => [name, state[name]]))
  makeParent(file, repo)
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}
