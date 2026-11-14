// 완료 보고와 준비 상태를 따로 읽어 루프에서 확인한다. 메일을 소비하지 않는다.
// 보낸 알림 기록: DONE-SUSPECT 는 state/done-seen/<runKey>.json 의 suspects(dispatch id 목록)에 남긴다. 키는 dispatch 이고 같은 dispatch 의
//   worker_done 이 또 와도 다시 보내지 않는다. 파일이 디스크에 있어 루프를 다시 띄워도 이어진다. WORKER-LOST 는 lib/lost-workers.ts 가
//   state/wait-important-lost.json 의 <Run>.<dispatch> 로 같은 방식으로 막는다. 전송이 성공한 뒤에만 기록해 실패는 다음 틱이 다시 보낸다.
// 리뷰 dispatch 는 띄우기 기록이 지워져도 영구 이력의 spec 으로 알아본다(lib/review.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, context, noPrInstruction, payload } from '../lib/completion.ts'
import { senderOf } from '../core/message-fields.ts'
import { orcaJson } from '../lib/orca.ts'
import { ghJson } from '../lib/gh.ts'
import { linkBoardPr, prTaskRef } from '../lib/board.ts'
import { boardPath } from '../lib/board-file.ts'
import { makeParent, pathOf } from '../lib/paths.ts'
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

export function completionMessages(run: string): Json[] {
  return messages(['check', '--run', run, '--all', '--types', 'worker_done']).filter(m => m.type === 'worker_done')
}

export async function watchCompletions(repo: string, run: string, base: string, completed?: Json[]): Promise<void> {
  const file = join(pathOf('state', repo), 'done-seen', `${runKey(run)}.json`)
  let before: Seen | null = null
  if (existsSync(file)) before = JSON.parse(readFileSync(file, 'utf8'))
  let done = completed ?? completionMessages(run)
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
  const history = launchHistory(repo)
  const historyByDispatch = new Map(history.map(row => [row.dispatch, row]))
  const launchOf = (dispatch: string) => readLaunch(repo, dispatch) ?? history.find(row => row.dispatch === dispatch)
  const isReview = (dispatch: string) => reviewPrOfDispatch(repo, dispatch, historyByDispatch) !== null
  const options = {
    isReview,
    isNoPr: (dispatch: string) => {
      if (isReview(dispatch)) return false
      const launch = launchOf(dispatch)
      if (launch?.completion === 'none') return true
      if (!launch?.spec) return false
      try { return noPrInstruction(readFileSync(launch.spec, 'utf8')) } catch { return false }
    },
  }
  let classified = classify(fresh, statuses, options)
  if (classified.some(m => m.type === 'suspicious_worker_done')) {
    const inbox = messages(['inbox', '--terminal', `run:${run}`, '--limit', '3000'])
    const mine = inbox.filter(m => m.type === 'status' && (m.run_id ?? m.runId) === run)
    classified = classify(fresh, [...statuses, ...mine], options)
  }
  for (const message of classified) {
    const [task, dispatchValue] = context(message)
    const dispatch = String(dispatchValue ?? '')
    const id = String(message.id)
    const launch = launchOf(dispatch)
    const verified = message.completionVerification as Json | undefined
    if (launch?.completion !== 'none' && (verified?.status === 'ready' || verified?.status === 'suspicious')) {
      let pr: Json | null = null
      if (verified.status === 'ready' && typeof verified.pr === 'number') {
        const got = ghJson<Json>(['pr', 'view', String(verified.pr), '--json', 'number,title,headRefName,headRefOid,author,isDraft,url'], { cwd: repo })
        // 이 저장소가 띄우지 않은 dispatch(기록 없음)의 PR 번호는 다른 저장소의 것일 수 있다. 여러 저장소의 루프가 한 Run 에 있으면
        // 남의 PR 번호로 조회가 실패하므로, 그 dispatch 는 건너뛰고 띄운 저장소의 루프가 맡는다
        if (!got.ok && !launch) { seen.ids.push(id); if (time(message) > seen.last) seen.last = time(message); save(); continue }
        if (!got.ok) throw new Error(got.error)
        const v = got.data
        pr = { number: v.number, title: v.title, branch: v.headRefName, head: v.headRefOid, author: v.author?.login ?? null, draft: v.isDraft, url: v.url }
        if (existsSync(boardPath(repo)) && typeof pr.branch === 'string') linkBoardPr(boardPath(repo), String(pr.number), pr.branch, prTaskRef(repo, String(pr.title ?? '')))
      }
      if (!seen.events.includes(id)) {
        await fire('worker-done', { worker: { task, dispatch, terminal: senderOf(message) || null, worktree: null, spec: null }, outcome: message.outcome ?? payload(message).outcome ?? null, evidence: verified.status, pr }, { repo, run, base })
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
