// 완료 보고와 준비 상태를 따로 읽어 루프에서 확인한다. 메일을 소비하지 않는다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, context, payload } from '../lib/completion.ts'
import { orcaJson } from '../lib/orca.ts'
import { ghJson } from '../lib/gh.ts'
import { linkBoardPr } from '../lib/board.ts'
import { boardPath, makeParent, pathOf } from '../lib/paths.ts'
import { runKey } from '../lib/loop.ts'
import { reviewPrOfDispatch } from '../lib/review.ts'
import { readLaunch } from '../lib/launched.ts'
import { launchHistory } from '../lib/launch-history.ts'
import { fire } from '../lib/events.ts'
import { notifyRun } from '../lib/run-notice.ts'

type Json = Record<string, any>
type Seen = { ids: string[]; last: string; suspects: string[]; events: string[] }
function messages(args: string[]): Json[] {
  const got = orcaJson<Json>(['orchestration', ...args])
  if (!got.ok) throw new Error(got.error)
  if (!Array.isArray(got.data?.messages)) throw new Error('완료 보고 조회의 messages 가 목록이 아니다')
  return got.data.messages
}
const time = (m: Json): string => String(m.created_at ?? m.createdAt ?? '')

export async function watchCompletions(repo: string, run: string, base: string): Promise<void> {
  const file = join(pathOf('state', repo), 'done-seen', `${runKey(run)}.json`)
  let before: Seen | null = null
  if (existsSync(file)) before = JSON.parse(readFileSync(file, 'utf8'))
  let done = messages(['check', '--run', run, '--all', '--types', 'worker_done']).filter(m => m.type === 'worker_done')
  const oldest = (rows: Json[]) => rows.map(time).filter(Boolean).sort()[0] ?? ''
  if (done.length >= 100 && before && oldest(done) > before.last) {
    const inbox = messages(['inbox', '--terminal', `run:${run}`, '--limit', '3000'])
    const mine = inbox.filter(m => m.type === 'worker_done' && (m.run_id ?? m.runId) === run)
    if (!mine.length || oldest(mine) > before.last) throw new Error('완료 보고 일부를 읽지 못했다')
    done = [...new Map([...mine, ...done].map(m => [String(m.id), m])).values()]
  }
  done.sort((a, b) => time(a).localeCompare(time(b)))
  const seen: Seen = before ?? { ids: [], last: new Date().toISOString(), suspects: [], events: [] }
  seen.suspects ??= []; seen.events ??= []
  const save = () => {
    makeParent(file, repo)
    writeFileSync(`${file}.tmp`, JSON.stringify(seen))
    renameSync(`${file}.tmp`, file)
  }
  if (!before) {
    seen.ids = done.map(m => String(m.id))
    if (done.length) seen.last = time(done.at(-1)!) || seen.last
    save(); return
  }
  const fresh = done.filter(m => !seen.ids.includes(String(m.id)))
  if (!fresh.length) return
  const statuses = messages(['check', '--run', run, '--all', '--types', 'status'])
  const options = { isReview: (dispatch: string) => reviewPrOfDispatch(repo, dispatch) !== null }
  let classified = classify(fresh, statuses, options)
  if (classified.some(m => m.type === 'suspicious_worker_done')) {
    const inbox = messages(['inbox', '--terminal', `run:${run}`, '--limit', '3000'])
    const mine = inbox.filter(m => m.type === 'status' && (m.run_id ?? m.runId) === run)
    classified = classify(fresh, [...statuses, ...mine], options)
  }
  const history = launchHistory(repo)
  for (const message of classified) {
    const [task, dispatchValue] = context(message)
    const dispatch = String(dispatchValue ?? '')
    const id = String(message.id)
    const launch = readLaunch(repo, dispatch) ?? history.find(row => row.dispatch === dispatch)
    const verified = message.completionVerification as Json | undefined
    if (launch?.completion !== 'none' && (verified?.status === 'ready' || verified?.status === 'suspicious')) {
      let pr: Json | null = null
      if (verified.status === 'ready' && typeof verified.pr === 'number') {
        const got = ghJson<Json>(['pr', 'view', String(verified.pr), '--json', 'number,title,headRefName,headRefOid,author,isDraft,url'], { cwd: repo })
        if (!got.ok) throw new Error(got.error)
        const v = got.data
        pr = { number: v.number, title: v.title, branch: v.headRefName, head: v.headRefOid, author: v.author?.login ?? null, draft: v.isDraft, url: v.url }
        if (existsSync(boardPath(repo)) && typeof pr.branch === 'string') linkBoardPr(boardPath(repo), String(pr.number), pr.branch)
      }
      if (!seen.events.includes(id)) {
        await fire('worker-done', { worker: { task, dispatch, terminal: message.from_handle ?? message.fromHandle ?? null, worktree: null, spec: null }, outcome: message.outcome ?? payload(message).outcome ?? null, evidence: verified.status, pr }, { repo, run, base })
        seen.events.push(id); save()
      }
      if (verified.status === 'suspicious' && !seen.suspects.includes(dispatch)) {
        const sent = notifyRun(run, 'DONE-SUSPECT', `${dispatch} ${String(verified.reason)}`)
        if (!sent.ok) throw new Error(`NOTICE-FAIL DONE-SUSPECT ${sent.error}`)
        seen.suspects.push(dispatch)
      }
    }
    seen.ids.push(id)
    if (time(message) > seen.last) seen.last = time(message)
    save()
  }
}
