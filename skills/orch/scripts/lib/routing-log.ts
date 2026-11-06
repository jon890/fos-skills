// PR 종료 시 남기는 관측 기록. 본문·질문·금액은 저장하지 않는다.
// 수집기 실패는 해당 값만 null, 쓰기 실패는 ROUTING-LOG-FAIL 한 줄이며 정리를 막지 않는다.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadConfig, ROUTING_KEYS, section } from './config.ts'
import { context, payload, readyOf } from './completion.ts'
import { finishStarted } from './finish-marks.ts'
import { acquireLock, releaseLock } from './events.ts'
import { apiTarget, FAILED_CONCLUSIONS, ghJson } from './gh.ts'
import { launchHistory, type LaunchHistory } from './launch-history.ts'
import { orcaJson } from './orca.ts'
import { ensure, pathOf } from './paths.ts'
import { isQuietStop } from './stop-reports.ts'

type Json = Record<string, any>
type Outcome = 'merged' | 'closed'
type Tokens = { input: number; output: number; cache_read: number; cache_write: number }
export type RoutingRecord = {
  version: 1; recorded_at: string; pr: number; repo: string; branch: string
  merged_at: string | null; closed_at: string | null; outcome: Outcome
  dispatches: Array<{ dispatch: string; at: string; agent: string | null; model: string | null; effort: string | null;
    effective: LaunchHistory['effective']; experiment: string | null; row: string | null; retry_of: string | null; opened_pr: boolean }>
  task_row: string | null; size_grade: string | null; first_review: Record<string, number> | null
  fix_commits_after_review: number | null; ci_failures: number | null
  questions: number | null; escalations: number | null; coordinator_messages: number | null
  minutes_to_ready: number | null; minutes_waiting_user: number | null; tokens: Tokens | null
}

const FIELDS = 'number,url,headRefName,headRefOid,createdAt,closedAt,mergedAt,state'
const MESSAGE_LIMIT = 200
const ms = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN
const attempt = <T>(fn: () => T): T | null => { try { return fn() } catch { return null } }
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function github<T>(repo: string, args: string[]): T {
  const got = ghJson<T>(args, { cwd: repo, timeoutMs: 10_000, cache: false })
  if (!got.ok) throw new Error(got.error)
  return got.data
}

// --slurp의 페이지를 합친다. 형식이 다르면 빈 목록으로 보지 않는다.
function pages(repo: string, host: string, endpoint: string, key?: string): Json[] {
  const data = github<unknown>(repo, ['api', '--hostname', host, endpoint, '--paginate', '--slurp'])
  if (!Array.isArray(data)) throw new Error('GitHub 페이지 형식 오류')
  return data.flatMap(page => {
    if (key === 'workflow_runs' && page?.total_count > 1000) throw new Error('CI 조회 한도 도달')
    const rows = key ? page?.[key] : page
    if (!Array.isArray(rows) || !rows.every(object)) throw new Error('GitHub 목록 형식 오류')
    return rows
  })
}

export function routingRecords(repo: string): RoutingRecord[] {
  let text: string
  try { text = readFileSync(join(pathOf('state', repo), 'routing-log.jsonl'), 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return text.split('\n').filter(line => line.trim()).map(line => {
    const row = JSON.parse(line)
    if (!object(row) || !Number.isInteger(row.pr) || !['merged', 'closed'].includes(row.outcome)) throw new Error('routing 기록 형식 오류')
    return row as RoutingRecord
  })
}

// 같은 outcome은 보존하고 closed → merged만 바꾼다. 잠금 뒤 다시 읽어 동시 PR도 보존한다.
export async function writeRoutingRecord(repo: string, record: RoutingRecord): Promise<void> {
  const dir = ensure('state', repo)
  const file = join(dir, 'routing-log.jsonl')
  const lock = join(dir, 'routing-log.lock')
  if (!await acquireLock(lock, Date.now() + 5000)) throw new Error('기록 잠금 시간 초과')
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const rows = routingRecords(repo)
    const index = rows.findIndex(row => row.pr === record.pr)
    if (index >= 0 && (rows[index].outcome === record.outcome || rows[index].outcome === 'merged')) return
    if (index < 0) rows.push(record)
    else rows[index] = record
    writeFileSync(temp, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    renameSync(temp, file)
  } finally {
    attempt(() => unlinkSync(temp))
    releaseLock(lock)
  }
}

// 같은 브랜치의 앞 PR과 종료 뒤 띄운 dispatch를 뺀다.
export function dispatchesFor(pr: Json, siblings: Json[], history: LaunchHistory[]): LaunchHistory[] {
  const created = ms(pr.createdAt)
  const ended = ms(pr.mergedAt ?? pr.closedAt)
  if (!Number.isFinite(created) || !Number.isFinite(ended)) throw new Error('PR 시각 누락')
  const previous = siblings.filter(row => row.number !== pr.number && row.headRefName === pr.headRefName && ms(row.createdAt) < created)
  if (previous.some(row => !Number.isFinite(ms(row.mergedAt ?? row.closedAt)))) throw new Error('앞 PR 종료 시각 누락')
  const after = Math.max(-Infinity, ...previous.map(row => ms(row.mergedAt ?? row.closedAt)))
  const rows = history.filter(row => row.branch === pr.headRefName && ms(row.at) > after && ms(row.at) < ended)
    .sort((a, b) => ms(a.at) - ms(b.at))
  return rows.some(row => ms(row.at) <= created) ? rows : []
}

export function reviewCounts(body: string, pattern?: string): Record<string, number> | null {
  let values: string[] | undefined
  if (pattern) values = new RegExp(pattern, 'm').exec(body)?.slice(1, 6)
  else {
    const lines = body.split('\n').map(line => line.split('|').slice(1, -1).map(cell => cell.trim().replace(/\*\*/g, '')))
    const index = lines.findIndex(cells => cells.join('|') === 'P1|P2|P3|P4|P5')
    if (index >= 0 && lines[index + 1]?.every(cell => /^:?-+:?$/.test(cell))) values = lines[index + 2]
  }
  if (!values || values.length !== 5 || !values.every(value => /^\d+$/.test(value))) return null
  return Object.fromEntries(values.map((value, i) => [`P${i + 1}`, Number(value)]))
}

function reviews(repo: string, target: { host: string; slug: string }, pr: number) {
  const settings = section<{ review_author?: string; review_pattern?: string; size_pattern?: string }>(loadConfig(repo), 'routing', ROUTING_KEYS)
  if (!settings.review_author) return { first_review: null, size_grade: null, at: null }
  const endpoint = `repos/${target.slug}`
  const rows = [...pages(repo, target.host, `${endpoint}/issues/${pr}/comments?per_page=100`),
    ...pages(repo, target.host, `${endpoint}/pulls/${pr}/reviews?per_page=100`)]
    .filter(row => String(row.user?.login).toLowerCase() === settings.review_author!.toLowerCase())
    .map(row => ({ body: String(row.body ?? ''), at: row.submitted_at ?? row.created_at }))
    .filter(row => Number.isFinite(ms(row.at))).sort((a, b) => ms(a.at) - ms(b.at))
  for (const row of rows) {
    const counts = attempt(() => reviewCounts(row.body, settings.review_pattern))
    const size = settings.size_pattern ? attempt(() => new RegExp(settings.size_pattern!, 'm').exec(row.body)?.[1] ?? null) : null
    if (counts || size) return { first_review: counts, size_grade: size, at: row.at as string }
  }
  return { first_review: null, size_grade: null, at: null }
}

function inbox(handle: string): Json[] {
  const got = orcaJson<Json>(['orchestration', 'inbox', '--terminal', handle, '--limit', String(MESSAGE_LIMIT)], { timeoutMs: 10_000 })
  if (!got.ok || !Array.isArray(got.data.messages) || !got.data.messages.every(object) || got.data.messages.length >= MESSAGE_LIMIT) {
    throw new Error('메시지 조회 실패 또는 조회 한도 도달')
  }
  return got.data.messages
}

type MessageMetrics = Pick<RoutingRecord, 'questions' | 'escalations' | 'coordinator_messages' | 'minutes_to_ready' | 'minutes_waiting_user'> & { opener: string | null }
function messages(pr: number, rows: LaunchHistory[], ended: number): MessageMetrics {
  const all = new Map<string, Json>()
  const runs = new Map<string, Json[]>()
  for (const row of rows) {
    if (!row.run) throw new Error('dispatch Run 누락')
    if (!runs.has(row.run)) runs.set(row.run, inbox(`run:${row.run}`))
    for (const m of [...runs.get(row.run)!, ...inbox(`dispatch:${row.dispatch}`)]) {
      if (typeof m.id !== 'string' || !Number.isFinite(ms(m.created_at))) throw new Error('메시지 필수 값 누락')
      if (ms(m.created_at) >= ms(rows[0].at) && ms(m.created_at) <= ended) all.set(m.id, m)
    }
  }
  const list = [...all.values()]
  const from = (m: Json) => rows.find(row => context(m)[1] === row.dispatch && (m.from_handle === row.terminal || m.from_handle === `dispatch:${row.dispatch}`))
  const sent = list.filter(m => from(m))
  const questions = sent.filter(m => m.type === 'question')
  const escalation = sent.filter(m => m.type === 'escalation' && !isQuietStop(m))
  const ready = sent.filter(m => m.type === 'status' && readyOf(m)?.pr === pr).sort((a, b) => ms(a.created_at) - ms(b.created_at))[0]
  const commands = list.filter(m => rows.some(row => m.to_handle === `dispatch:${row.dispatch}` || m.to_handle === row.terminal)
    && !from(m) && !['heartbeat', 'worker_done'].includes(m.type) && !payload(m).broadcast &&
    !(Array.isArray(payload(m).recipients) && (payload(m).recipients as unknown[]).length > 1))
  // 겹친 대기 구간은 한 번만 센다. 준비 뒤의 질문은 준비까지의 대기에 넣지 않는다.
  const until = ready ? ms(ready.created_at) : NaN
  const intervals: Array<[number, number]> = []
  let waitingKnown = !!ready
  for (const question of [...questions, ...escalation].filter(m => ms(m.created_at) < until)) {
    const row = from(question)!
    const reply = list.filter(m => m.thread_id === question.id && m.id !== question.id &&
      (m.to_handle === `dispatch:${row.dispatch}` || m.to_handle === row.terminal) && ms(m.created_at) >= ms(question.created_at))
      .sort((a, b) => ms(a.created_at) - ms(b.created_at))[0]
    if (!reply) { waitingKnown = false; continue }
    intervals.push([ms(question.created_at), Math.min(ms(reply.created_at), until)])
  }
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0, end = -Infinity
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop) }
  return { questions: questions.length, escalations: escalation.length, coordinator_messages: commands.length,
    minutes_to_ready: ready ? (until - ms(rows[0].at)) / 60_000 : null,
    minutes_waiting_user: waitingKnown ? total / 60_000 : null, opener: ready ? from(ready)!.dispatch : null }
}

// Orca usage schema 7의 세션을 시작 시각으로 dispatch에 잇는다. 형식이나 위치가 모호하면 null.
function tokens(rows: LaunchHistory[], history: LaunchHistory[], ended: number): Tokens | null {
  const dir = process.env.ORCA_USAGE_DIR ?? join(homedir(), 'Library', 'Application Support', 'Orca')
  const total: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  let found = false
  const worktrees = attempt(() => {
    const got = orcaJson<Json>(['worktree', 'list'], { timeoutMs: 10_000 })
    if (!got.ok || !Array.isArray(got.data.worktrees) || got.data.truncated) throw new Error('워크트리 조회 실패')
    return got.data.worktrees as Json[]
  })
  for (const agent of new Set(rows.map(row => row.effective?.agent ?? row.agent))) {
    if (agent !== 'claude' && agent !== 'codex') return null
    const data = JSON.parse(readFileSync(join(dir, `orca-${agent}-usage.json`), 'utf8'))
    if (data.schemaVersion !== 7 || !Array.isArray(data.sessions)) return null
    for (const session of data.sessions) {
      if (!object(session) || !Number.isFinite(ms(session.firstTimestamp))) return null
      const row = rows.find(row => (row.effective?.agent ?? row.agent) === agent &&
        ms(session.firstTimestamp) >= ms(row.at) && ms(session.firstTimestamp) < Math.min(ended,
          ...history.filter(next => next.worktree === row.worktree && ms(next.at) > ms(row.at)).map(next => ms(next.at))) &&
        (session.lastCwd === row.worktree || worktrees?.some(wt => wt.id === session.primaryWorktreeId && resolve(wt.path) === resolve(row.worktree))))
      if (!row) continue
      // 위치가 섞인 세션 전체를 더하면 다른 PR의 토큰이 들어가므로 쓰지 않는다.
      if (session.hasMixedLocations || (Array.isArray(session.locationBreakdown) && session.locationBreakdown.length > 1)) return null
      const counts = agent === 'claude'
        ? [session.totalInputTokens, session.totalOutputTokens, session.totalCacheReadTokens, session.totalCacheWriteTokens]
        : [session.totalInputTokens - session.totalCachedInputTokens, session.totalOutputTokens, session.totalCachedInputTokens, 0]
      if (!counts.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null
      found = true
      for (const [i, key] of (['input', 'output', 'cache_read', 'cache_write'] as const).entries()) total[key] += counts[i]
    }
  }
  return found ? total : null
}

async function collect(repo: string, pr: number, outcome: Outcome): Promise<void> {
  const history = launchHistory(repo)
  if (!history.length) return
  if (routingRecords(repo).some(row => row.pr === pr && (row.outcome === outcome || row.outcome === 'merged'))) return
  const info = github<Json>(repo, ['pr', 'view', String(pr), '--json', FIELDS])
  if (info.state !== outcome.toUpperCase()) throw new Error('PR 결과 불일치')
  const target = apiTarget(info.url)
  if (!target) throw new Error('PR URL 형식 오류')
  const siblings = github<Json[]>(repo, ['pr', 'list', '--head', info.headRefName, '--state', 'all', '--limit', '1000', '--json', FIELDS])
  if (!Array.isArray(siblings) || siblings.length >= 1000) throw new Error('PR 브랜치 조회 한도 도달')
  const rows = dispatchesFor(info, siblings, history)
  if (!rows.length) return
  const review = attempt(() => reviews(repo, target, pr))
  const commits = attempt(() => {
    const found = pages(repo, target.host, `repos/${target.slug}/pulls/${pr}/commits?per_page=100`)
    // 이 endpoint는 최대 250건이다. 한도에서 완전성을 증명하지 못하면 null이다.
    // https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request
    if (found.length >= 250 || found.some(c => !Number.isFinite(ms(c.commit?.committer?.date)))) throw new Error('커밋 조회 범위 또는 형식 오류')
    return found
  })
  const ci = attempt(() => {
    // 현재 커밋 목록에서 사라진 force-push head도 브랜치 실행 이력에는 남는다.
    const created = `${rows[0].at}..${info.mergedAt ?? info.closedAt}`
    const runs = pages(repo, target.host, `repos/${target.slug}/actions/runs?branch=${encodeURIComponent(info.headRefName)}&created=${encodeURIComponent(created)}&per_page=100`, 'workflow_runs')
    let failures = 0
    const seen = new Set<string>()
    for (const run of runs) {
      if (!Number.isInteger(run.id)) throw new Error('CI 실행 id 누락')
      const attempts = run.run_attempt ?? 1
      if (!Number.isInteger(attempts) || attempts < 1) throw new Error('CI 시도 번호 오류')
      for (let n = 1; n <= attempts; n++) {
        const key = `${run.id}:${n}`
        if (seen.has(key)) continue
        seen.add(key)
        const result = n === attempts ? run : github<Json>(repo, ['api', '--hostname', target.host, `repos/${target.slug}/actions/runs/${run.id}/attempts/${n}`])
        if (!Object.hasOwn(result, 'conclusion') || result.conclusion !== null && typeof result.conclusion !== 'string') throw new Error('CI 판정 누락')
        if (FAILED_CONCLUSIONS.includes(String(result.conclusion).toUpperCase())) failures++
      }
    }
    return failures
  })
  const ended = ms(info.mergedAt ?? info.closedAt)
  const message = attempt(() => messages(pr, rows, ended))
  const opener = rows.find(row => row.dispatch === message?.opener) ?? rows.filter(row => ms(row.at) <= ms(info.createdAt)).at(-1)!
  await writeRoutingRecord(repo, {
    version: 1, recorded_at: new Date().toISOString(), pr, repo: target.slug, branch: info.headRefName,
    merged_at: outcome === 'merged' ? info.mergedAt : null, closed_at: outcome === 'closed' ? info.closedAt : null, outcome,
    dispatches: rows.map(row => ({ dispatch: row.dispatch, at: row.at, agent: row.agent ?? null, model: row.model ?? null,
      effort: row.effort ?? null, effective: row.effective ? { agent: row.effective.agent ?? null, model: row.effective.model ?? null, effort: row.effective.effort ?? null } : null, experiment: row.experiment ?? null, row: row.row ?? null,
      retry_of: row.retry_of ?? null, opened_pr: row.dispatch === opener.dispatch })),
    task_row: opener.row ?? null, first_review: review?.first_review ?? null, size_grade: review?.size_grade ?? null,
    fix_commits_after_review: review?.at && commits ? commits.filter(c => ms(c.commit?.committer?.date) > ms(review.at)).length : null,
    ci_failures: ci, questions: message?.questions ?? null, escalations: message?.escalations ?? null,
    coordinator_messages: message?.coordinator_messages ?? null, minutes_to_ready: message?.minutes_to_ready ?? null,
    minutes_waiting_user: message?.minutes_waiting_user ?? null, tokens: attempt(() => tokens(rows, history, ended)),
  })
}

export async function recordRouting(repo: string, pr: number, outcome: Outcome): Promise<void> {
  try { await collect(repo, pr, outcome) }
  catch (e) { process.stderr.write(`ROUTING-LOG-FAIL ${pr} ${String((e as Error).message).replace(/\s+/g, ' ')}\n`) }
}

// run 지정과 무관하다. 기록 뒤의 새 이력이 있으면 재사용한 브랜치도 다시 조회한다.
export async function sweepRouting(repo: string, now = Date.now()): Promise<void> {
  try {
    const records = routingRecords(repo)
    const allHistory = launchHistory(repo)
    const history = allHistory.filter(row => row.branch && ms(row.at) >= now - 30 * 86400_000)
    const branches = new Set(history.filter(row => !records.some(record => record.branch === row.branch &&
      record.dispatches.some(dispatch => dispatch.dispatch === row.dispatch))).map(row => row.branch!))
    for (const branch of branches) {
      const prs = github<Json[]>(repo, ['pr', 'list', '--head', branch, '--state', 'closed', '--limit', '1000', '--json', FIELDS])
      if (!Array.isArray(prs) || prs.length >= 1000) throw new Error('종료 PR 조회 한도 도달')
      for (const pr of prs) {
        if (pr.state !== 'CLOSED' && pr.state !== 'MERGED') continue
        if (pr.state === 'MERGED' && finishStarted(repo, pr.number)) continue
        if (!dispatchesFor(pr, prs, allHistory).length) continue
        await recordRouting(repo, pr.number, pr.state === 'MERGED' ? 'merged' : 'closed')
      }
    }
  } catch (e) { process.stderr.write(`ROUTING-LOG-FAIL sweep ${String((e as Error).message).replace(/\s+/g, ' ')}\n`) }
}
