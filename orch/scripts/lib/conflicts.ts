// 열린 PR 의 충돌 찾기, PR 하나의 처리, (PR, base SHA) 마다 한 번 알린 기록의 한 벌이다.
// 사용처: notify-conflicts.ts(머지 직후 한 번 보기), orch-loop.ts(틱의 마지막 단계). PR HEAD 받기(fetchPrHead)와
// base 받기(baseHead)는 ci-ready 도 쓴다. 충돌 판정은 lib/git.ts 의 conflicts(merge-tree) 한 벌이다.
// GitHub 의 mergeable 은 머지 직후 한동안 UNKNOWN 이라 쓰지 않는다.
//
// 실패는 예외 대신 { ok: false, error } 로 낸다. 부르는 쪽이 조회 실패(종료 코드 2)나 보류로 바꾼다.
//
// 알린 기록: <orch 루트>/state/notify-conflicts.json. 옛 notify-conflicts.py 와 같은 파일과 키(`<PR>@<base SHA>`)다.
//   값은 notified 와 resumed 면 dispatch id, orphan 이면 `orphan` 이다. base 가 움직이면 키가 달라져 다시 알린다.
//   파일이 없거나 깨졌으면 빈 기록이다. 쓰기는 lib/paths.ts 의 makeParent 로 부모 폴더를 만들고 git 이 무시하게 한 뒤 한다.
//   notify-conflicts 와 루프가 같은 파일을 쓰므로, 머지 큐 뒤의 notify-conflicts 와 틱이 차례로 실행될 때 같은 충돌을 두 번 보내지 않는다.
//   둘이 겹쳐 돌면 둘 다 기록을 읽은 뒤 보내므로 두 번 보낼 수 있다. 기록 파일에는 잠금이 없다.
//
// PR 하나의 처리: 부르는 쪽이 기록을 보고, 브랜치의 워크트리와 worker 행을 찾은 뒤(lib/workers.ts) 두 함수를 이 순서로 부른다.
//   resolveConflict   찾은 worker 에게 보내고 결과를 낸다. 보내는 방법과 send-to-worker 종료 코드의 분류는
//                     notify-conflicts.ts 머리 주석의 표가 원본이다. 그 명령의 줄은 out 으로, 이유 줄은 stderr 로 같은 문구로 낸다.
//                     결과가 record 면 기록하고, skip 이면 기록하지 않고(다음 실행이 다시 본다), usage 면 부르는 쪽이 충돌 처리를 멈춘다
//   concludeConflict  기록한 뒤 pr-conflict 를 낸다. 이벤트를 내지 못한 오류는 stderr 에 한 줄 남기고 넘어간다
//   SEND_TO_WORKER 환경 변수가 send-to-worker 의 경로를 바꾼다. 기본은 이 폴더의 부모 폴더의 send-to-worker.ts 다.
//
// 후속 지시서 이름: <지시서 폴더>/spec-conflict-<PR>.md(conflictSpecPath). PR 마다 하나이고 base 가 움직이면 덮어쓴다(ADR-015).
//   앞 base 의 지시서는 다음 base 에서 쓸모가 없다. `중간 과정: PR #<PR>` 줄을 담아 launch-worker 가 보드에 새 항목을 만들지 않는다.
//   그 PR 의 마무리(finish-pr.ts)가 머지 뒤 conflictSpecFiles 로 찾아 지운다. 옛 이름 spec-conflict-<PR>-<base SHA 앞 8자리>.md 도 그 목록에 든다.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INTERIM } from './board.ts'
import { fire } from './events.ts'
import type { FireContext } from './events.ts'
import { conflicts, git } from './git.ts'
import { ghJson } from './gh.ts'
import { makeParent, pathOf } from './paths.ts'
import { runAsync, scriptCommand } from './proc.ts'
import { LIVE_DISPATCH } from './workers.ts'

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

// PR 의 충돌 후속 지시서 경로(머리 주석의 「후속 지시서 이름」)
export function conflictSpecPath(repo: string, pr: number): string {
  return join(pathOf('specs', repo), `spec-conflict-${pr}.md`)
}

// 지시서 폴더에서 그 PR 의 충돌 후속 지시서 경로들. 옛 이름(base SHA 앞 8자리를 붙인 것)도 든다. 폴더가 없으면 빈 목록이다
export function conflictSpecFiles(repo: string, pr: number): string[] {
  const dir = pathOf('specs', repo)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const legacy = new RegExp(`^spec-conflict-${pr}-[0-9a-f]{8}\\.md$`)
  return names
    .filter((name) => name === `spec-conflict-${pr}.md` || legacy.test(name))
    .sort()
    .map((name) => join(dir, name))
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

// send-to-worker 는 끝난 dispatch 를 이어 쓸 때 launch-worker 를 1시간까지, 살아 있는 worker 를 깨울 때 5분까지 기다린다
export const SEND_MS = 3_900_000
// 본문에 이름을 적는 충돌 파일 수
const SHOWN_FILES = 10
// 끝난 dispatch 의 send-to-worker 1 에서 worker-start 가 성공했다는 표시(notify-conflicts.ts 머리 주석의 「끝난 dispatch 의 1」)
const RELAUNCHED = /^LAUNCHED \S/m

export type Worker = { task: unknown; dispatch: string; terminal: unknown; worktree: string; spec: string | null }
export type WorkerRow = Record<string, unknown>
// 찾은 워크트리와 worker 행, 또는 orphan 이유
export type WorkerFound = { path: string; row: WorkerRow } | { orphan: string }
export type ConflictOutcome =
  | { kind: 'record'; value: string; action: 'notified' | 'resumed' | 'orphan'; worker: Worker | null; reason: string | null }
  | { kind: 'skip' }
  | { kind: 'usage' }

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

function message(number: number, base: string, baseSha: string, files: string[]): string {
  const shown = files.slice(0, SHOWN_FILES).join(', ') + (files.length > SHOWN_FILES ? ` 외 ${files.length - SHOWN_FILES}개` : '')
  return (
    `PR #${number} 이 base ${base}(${baseSha.slice(0, 8)}) 와 충돌한다. 충돌 파일: ${shown}. ` +
    `origin/${base} 를 합쳐 충돌을 풀고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.`
  )
}

function followUp(repo: string, pr: OpenPr, base: string, baseSha: string, files: string[], file: string): void {
  const common = join(pathOf('specs', repo), 'spec-common.md')
  const lines: string[] = []
  if (existsSync(common)) lines.push(`먼저 공통 지시서 ${common} 를 읽는다.`, '')
  else err(`notify-conflicts: 공통 지시서가 없어(${common}) 후속 지시서에 그 줄을 넣지 않는다`)
  lines.push(
    `# PR #${pr.number} 의 base 충돌 풀기`,
    '',
    `브랜치: \`${pr.headRefName}\``,
    `${INTERIM}PR #${pr.number}`,
    '허락: push 는 허락됐다. PR 은 이미 있으므로 새로 열지 않는다',
    '',
    `PR #${pr.number}(${pr.url}) 이 base ${base}(${baseSha.slice(0, 8)}) 와 충돌한다. 같은 워크트리에서 이어 받는다.`,
    '',
    '## 할 일',
    '',
    `1. \`origin/${base}\` 를 합쳐 아래 충돌 파일을 푼다`,
    '2. 저장소 검증 명령을 돌린다',
    '3. push 한 뒤 status 로 알린다',
    '',
    '## 충돌 파일',
    '',
    ...files.map((name) => `- ${name}`),
  )
  makeParent(file, repo)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function prInput(pr: OpenPr): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title ?? null,
    branch: pr.headRefName ?? null,
    head: pr.headRefOid ?? null,
    author: pr.author?.login ?? null,
    draft: pr.isDraft ?? null,
    url: pr.url ?? null,
  }
}

function orphaned(out: (line: string) => void, number: number, reason: string, worker: Worker | null, dryRun: boolean): ConflictOutcome {
  out(`CONFLICT-ORPHAN ${number} ${reason}`)
  return dryRun ? { kind: 'skip' } : { kind: 'record', value: ORPHAN, action: 'orphan', worker, reason }
}

// 충돌한 PR 하나를 찾은 worker 에게 보낸다(머리 주석의 「PR 하나의 처리」). found 는 찾은 워크트리와 worker 행, 또는 orphan 이유다.
// dryRun 이면 할 일만 out 으로 내고 skip 이다. 후속 지시서를 쓰지 않고 보내지 않는다.
export async function resolveConflict(args: {
  repo: string
  base: string
  baseSha: string
  pr: OpenPr
  files: string[]
  found: WorkerFound
  run: string | null
  dryRun: boolean
  out: (line: string) => void
}): Promise<ConflictOutcome> {
  const { repo, base, baseSha, pr, files, found, run, dryRun, out } = args
  const number = pr.number
  if ('orphan' in found) return orphaned(out, number, found.orphan, null, dryRun)
  const { path, row } = found
  const dispatch = String(row.dispatchId)
  const live = LIVE_DISPATCH.has(String(row.dispatchStatus))
  const worker: Worker = { task: row.taskId ?? null, dispatch, terminal: row.agentTerminalHandle ?? null, worktree: path, spec: null }
  const sendArgs = ['--dispatch', dispatch]
  if (live) {
    const body = message(number, base, baseSha, files)
    if (dryRun) {
      out(`  ${dispatch} 에 알릴 것: ${body}`)
      return { kind: 'skip' }
    }
    sendArgs.push('--body', body)
  } else {
    worker.spec = conflictSpecPath(repo, number)
    if (dryRun) {
      out(`  ${dispatch} 에 이어 쓸 것: ${worker.spec}`)
      return { kind: 'skip' }
    }
    followUp(repo, pr, base, baseSha, files, worker.spec)
    sendArgs.push('--spec', worker.spec)
  }
  if (run) sendArgs.push('--run', run)
  const send = process.env.SEND_TO_WORKER || join(dirname(dirname(fileURLToPath(import.meta.url))), 'send-to-worker.ts')
  const sent = await runAsync(scriptCommand(send, sendArgs), { timeoutMs: SEND_MS })
  const shown = (sent.stdout + sent.stderr).trim()
  if (shown) out(`  ${shown.replaceAll('\n', '\n  ')}`)
  if (sent.code === 2) {
    err('notify-conflicts: send-to-worker 가 사용법 오류(종료 코드 2)로 끝나 멈춘다')
    return { kind: 'usage' }
  }
  if (sent.code === 3) return orphaned(out, number, `${dispatch} 에 보낼 수 없다(send-to-worker 종료 코드 3). 새 worker 는 띄우지 않는다`, worker, false)
  const delivered = sent.code === 0 || sent.code === 4 || (sent.code === 1 && (live || RELAUNCHED.test(sent.stdout)))
  if (!delivered) {
    out(`  ${dispatch} 에 보내지 못했다(send-to-worker 종료 코드 ${sent.code})`)
    err(`notify-conflicts: #${number} 를 ${dispatch} 에 보내지 못해 기록하지 않는다. 다음 실행이 다시 본다`)
    return { kind: 'skip' }
  }
  const note = sent.code === 0 ? '' : live || sent.code === 4 ? `(깨우지 못했다, 종료 코드 ${sent.code})` : '(다시 띄운 뒤 종료 코드 1 로 끝났다)'
  out(`  ${dispatch} 에 알렸다${note}`)
  return { kind: 'record', value: dispatch, action: live ? 'notified' : 'resumed', worker, reason: null }
}

// resolveConflict 의 record 를 기록하고 pr-conflict 를 낸다(머리 주석의 「PR 하나의 처리」).
export async function concludeConflict(
  statePath: string,
  repo: string,
  ctx: FireContext,
  pr: OpenPr,
  files: string[],
  baseSha: string,
  outcome: Extract<ConflictOutcome, { kind: 'record' }>,
): Promise<void> {
  recordNotified(statePath, repo, notifiedKey(pr.number, baseSha), outcome.value)
  try {
    await fire('pr-conflict', { pr: prInput(pr), base_head: baseSha, files, worker: outcome.worker, action: outcome.action }, ctx)
  } catch (e) {
    // 알림과 기록은 이미 끝났다. 이벤트를 내지 못한 것은 결과를 바꾸지 않는다
    err(`notify-conflicts: pr-conflict 를 내지 못했다: ${(e as Error)?.message ?? String(e)}`)
  }
}
