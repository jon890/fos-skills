import { isObject } from '../core/json.ts'
// 정리(cleanup-sweep.ts)의 PR 조회를 저장소마다 묶는 한 벌이다.
//
// 예전에는 브랜치마다 이름 변형까지 `gh pr list --head` 를 부르고, 열린 PR 의 base 인지 `gh pr list --base` 로 따로 물었다.
// 워크트리 10 개, 로컬 브랜치 22 개인 저장소에서 정리 한 번이 gh 를 69 번 불러 90 초 넘게 걸렸다(2026-11-04 실측).
//
//   이름별 PR    headRefName 마다 GraphQL `pullRequests(headRefName:)` 를 별칭으로 묶어 BATCH 개씩 한 번에 읽는다.
//                `gh pr list --head <이름> --state all --limit 5` 와 같은 조건(만든 시각 역순 5 개)이다.
//                묶음 조회가 실패하거나 저장소 주소를 읽지 못하면 그 이름은 list 가 이름마다 `gh pr list --head` 로 읽는다
//   열린 PR base `gh pr list --state open --limit 1000` 한 번이다. 실패하거나 1000 개가 다 찼으면 null 이고, 부르는 쪽이 이름마다 묻는다
//   머지된 PR    로컬 브랜치 끝 커밋이 그 PR 의 것으로 확인된 MERGED PR 을 <orch 루트>/state/merged-prs.json 에 남긴다(rememberMerged).
//                MERGED 는 다시 바뀌지 않는다. 같은 브랜치의 끝 커밋이 그대로면 다음 실행은 gh 를 부르지 않는다(cachedMerged).
//                끝 커밋이 바뀌면 쓰지 않는다. 같은 이름으로 새로 만든 브랜치를 옛 PR 로 읽지 않으려는 것이다.
//                로컬 브랜치가 사라진 항목은 pruneMerged 가 지운다
//
// 조회 결과의 PR 은 `gh pr list --json` 과 같은 꼴(author 는 { login })이다. 판정은 부르는 쪽이 한다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apiTarget, gh, ghJson } from './gh.ts'
import { ensure, pathOf } from './paths.ts'

export type Pr = Record<string, unknown> & { number: number; state: string }
export type Listed = { ok: boolean; prs: Pr[] }

export const BATCH = 40
export const OPEN_LIMIT = 1000
const PR_STATES = new Set(['MERGED', 'OPEN', 'CLOSED'])
const MERGED_FILE = 'merged-prs.json'
// GraphQL 로 읽는 필드. gh pr list 의 --json 이름과 같고 author 만 { login } 으로 고쳐 읽는다
const NODE_FIELDS = 'number state headRefOid headRefName baseRefName isCrossRepository title author { login } isDraft url body'

function validPrs(value: unknown): Pr[] | null {
  if (!Array.isArray(value)) return null
  for (const pr of value) if (!isObject(pr) || !PR_STATES.has(pr.state as string) || !Number.isInteger(pr.number)) return null
  return value as Pr[]
}

// 이름 목록으로 GraphQL 질의 하나를 만든다. 이름은 JSON 문자열로 넣는다. GraphQL 문자열의 탈출 규칙이 JSON 과 같다
export function headsQuery(owner: string, name: string, heads: readonly string[]): string {
  const parts = heads.map(
    (head, i) =>
      `h${i}: pullRequests(headRefName: ${JSON.stringify(head)}, first: 5, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${NODE_FIELDS} } }`,
  )
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${parts.join(' ')} } }`
}

// headsQuery 의 응답에서 이름마다 PR 목록. 그 이름의 별칭이 없거나 꼴이 다르면 그 이름은 담지 않는다
export function parseHeads(data: unknown, heads: readonly string[]): Map<string, Pr[]> {
  const found = new Map<string, Pr[]>()
  const repo = isObject(data) && isObject(data.data) && isObject(data.data.repository) ? data.data.repository : null
  if (!repo) return found
  heads.forEach((head, i) => {
    const field = repo[`h${i}`]
    if (!isObject(field)) return
    const prs = validPrs(field.nodes)
    if (prs) found.set(head, prs)
  })
  return found
}

export class PrLookup {
  private readonly heads = new Map<string, Listed>()
  private bases: Set<string> | null | undefined
  private target: { host: string; owner: string; name: string } | null | undefined

  private readonly repo: string
  // 이름마다 다시 읽을 때 쓰는 `gh pr list --json` 필드
  private readonly fields: string

  constructor(repo: string, fields: string) {
    this.repo = repo
    this.fields = fields
  }

  private repoTarget(): { host: string; owner: string; name: string } | null {
    if (this.target !== undefined) return this.target
    const view = ghJson<{ url?: unknown }>(['repo', 'view', '--json', 'url'], { cwd: this.repo })
    const found = view.ok && isObject(view.data) && typeof view.data.url === 'string' ? apiTarget(view.data.url) : null
    const [owner, name] = found ? found.slug.split('/') : []
    this.target = found && owner && name ? { host: found.host, owner, name } : null
    return this.target
  }

  // 아직 읽지 않은 이름을 묶어 읽는다. 읽지 못한 이름은 남겨 두고 list 가 이름마다 읽는다
  prefetch(names: Iterable<string>): void {
    const todo = [...new Set(names)].filter((name) => name && !this.heads.has(name))
    if (todo.length === 0) return
    const target = this.repoTarget()
    if (!target) return
    for (let at = 0; at < todo.length; at += BATCH) {
      const chunk = todo.slice(at, at + BATCH)
      const done = ghJson<unknown>(['api', 'graphql', '--hostname', target.host, '-f', `query=${headsQuery(target.owner, target.name, chunk)}`], { cwd: this.repo })
      if (!done.ok) continue
      for (const [head, prs] of parseHeads(done.data, chunk)) {
        this.heads.set(head, { ok: true, prs: prs.map((pr) => ({ ...pr, author: isObject(pr.author) ? pr.author : undefined })) })
      }
    }
  }

  // 그 이름을 head 로 둔 PR. 묶음으로 읽지 못한 이름은 `gh pr list --head` 로 읽는다.
  // 빈 목록은 ok 와 [] 다. JSON 이 아니거나 목록이 아니거나 state 가 모르는 값이면 ok 가 false 다
  list(name: string): Listed {
    const known = this.heads.get(name)
    if (known) return known
    const done = gh(['pr', 'list', '--head', name, '--state', 'all', '--limit', '5', '--json', this.fields], { cwd: this.repo })
    let listed: Listed = { ok: false, prs: [] }
    if (done.code === 0) {
      try {
        const prs = validPrs(done.stdout.trim() ? JSON.parse(done.stdout) : [])
        if (prs) listed = { ok: true, prs }
      } catch {
        // 아래 실패로 둔다
      }
    }
    // 실패는 기억하지 않는다. 같은 실행 안에서 다시 물으면 다시 읽는다
    if (listed.ok) this.heads.set(name, listed)
    return listed
  }

  // PR 번호마다 state. GraphQL `pullRequest(number:)` 를 묶어 읽고, 읽지 못한 번호는 `gh pr view` 로 하나씩 읽는다.
  // 끝내 읽지 못한 번호는 담지 않는다
  states(numbers: readonly number[]): Map<number, string> {
    const found = new Map<number, string>()
    const todo = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n > 0)
    const target = todo.length ? this.repoTarget() : null
    for (let at = 0; target && at < todo.length; at += BATCH) {
      const chunk = todo.slice(at, at + BATCH)
      const query = `query { repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(target.name)}) { ${chunk.map((n, i) => `n${i}: pullRequest(number: ${n}) { state }`).join(' ')} } }`
      const done = ghJson<unknown>(['api', 'graphql', '--hostname', target.host, '-f', `query=${query}`], { cwd: this.repo })
      const repo = done.ok && isObject(done.data) && isObject(done.data.data) && isObject(done.data.data.repository) ? done.data.data.repository : null
      chunk.forEach((n, i) => {
        const node = repo?.[`n${i}`]
        if (isObject(node) && PR_STATES.has(node.state as string)) found.set(n, node.state as string)
      })
    }
    for (const n of todo) {
      if (found.has(n)) continue
      const done = ghJson<{ state?: unknown }>(['pr', 'view', String(n), '--json', 'state'], { cwd: this.repo })
      if (done.ok && isObject(done.data) && PR_STATES.has(done.data.state as string)) found.set(n, done.data.state as string)
    }
    return found
  }

  // 열린 PR 의 base 이름 집합. 읽지 못했거나 목록이 잘렸으면 null 이다
  openBases(): Set<string> | null {
    if (this.bases !== undefined) return this.bases
    const done = ghJson<unknown>(['pr', 'list', '--state', 'open', '--limit', String(OPEN_LIMIT), '--json', 'baseRefName,headRefName'], { cwd: this.repo })
    this.bases = null
    if (done.ok && Array.isArray(done.data) && done.data.length < OPEN_LIMIT && done.data.every((pr) => isObject(pr) && typeof pr.baseRefName === 'string')) {
      this.bases = new Set(done.data.map((pr) => (pr as { baseRefName: string }).baseRefName))
    }
    return this.bases
  }
}

type MergedEntry = { tip: string; pr: Pr }

function mergedFile(repo: string): string {
  return join(pathOf('state', repo), MERGED_FILE)
}

function readMerged(repo: string): Record<string, MergedEntry> {
  try {
    const file = mergedFile(repo)
    if (!existsSync(file)) return {}
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(data) ? (data as Record<string, MergedEntry>) : {}
  } catch {
    return {}
  }
}

function writeMerged(repo: string, entries: Record<string, MergedEntry>): void {
  try {
    const dir = ensure('state', repo)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, MERGED_FILE)
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entries)}\n`)
    renameSync(temporary, file)
  } catch {
    // 캐시를 남기지 못하면 다음 실행이 gh 로 다시 읽을 뿐이다
  }
}

// 그 브랜치의 끝 커밋이 tip 일 때 남긴 MERGED PR. 없거나 끝 커밋이 다르면 null 이다
export function cachedMerged(repo: string, branch: string, tip: string): Pr | null {
  const entry = readMerged(repo)[branch]
  if (!entry || entry.tip !== tip || !isObject(entry.pr) || entry.pr.state !== 'MERGED' || !Number.isInteger(entry.pr.number)) return null
  return entry.pr
}

export function rememberMerged(repo: string, branch: string, tip: string, pr: Pr): void {
  if (pr.state !== 'MERGED' || !tip) return
  const entries = readMerged(repo)
  if (entries[branch]?.tip === tip) return
  // 본문은 크고 판정에 쓰지 않는다. 기능 근거는 부르는 쪽이 새로 읽는다(lib/feature-evidence.ts)
  const { body: _body, ...rest } = pr
  entries[branch] = { tip, pr: rest as Pr }
  writeMerged(repo, entries)
}

// 로컬 브랜치가 사라진 항목을 지운다
export function pruneMerged(repo: string, branches: ReadonlySet<string>): void {
  const entries = readMerged(repo)
  const kept = Object.fromEntries(Object.entries(entries).filter(([branch]) => branches.has(branch)))
  if (Object.keys(kept).length !== Object.keys(entries).length) writeMerged(repo, kept)
}
