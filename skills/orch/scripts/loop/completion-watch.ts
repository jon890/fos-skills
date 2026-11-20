// 완료 보고와 준비 상태를 따로 읽어 루프에서 확인한다. 메일을 소비하지 않는다.
// 보낸 알림 기록: DONE-SUSPECT 는 state/done-seen/<runKey>.json 의 suspects(dispatch id 목록)에 남긴다. 키는 dispatch 이고 같은 dispatch 의
//   worker_done 이 또 와도 다시 보내지 않는다. 파일이 디스크에 있어 루프를 다시 띄워도 이어진다. WORKER-LOST 는 lib/lost-workers.ts 가
//   state/wait-important-lost.json 의 <Run>.<dispatch> 로 같은 방식으로 막는다. 전송이 성공한 뒤에만 기록해 실패는 다음 틱이 다시 보낸다.
// 머지 전 완료 보고: PR 이 열린 채 온 worker_done(근거 없는 보고, 또는 준비됨 뒤 아직 열린 PR)은 DONE-SUSPECT 로 알리기 전에
//   그 worker 를 같은 워크트리에서 이어 맡긴다(lib/continue-worker.ts). 이어 맡기면 DONE-RETURNED 를 알리고(실패하면 되돌리지 않고 알림만 다음 틱이 다시 보낸다) DONE-SUSPECT 는 보내지 않는다.
//   dispatch 는 이미 completed 로 닫혀 send 는 ENDED, resume 은 RESUME-FAIL 이었다. 같은 PR 은 한 번만 되돌린다(state 의 returned: dispatch 와 `pr:<번호>`).
//   이어 맡기지 못하면 이유와 `orch worker continue --dispatch <id>` 를 DONE-SUSPECT 에 적는다. 전송 기록은 되돌린 직후에 남겨 다음 틱이 다시 보내지 않는다.
// 리뷰 dispatch 는 띄우기 기록이 지워져도 영구 이력의 spec 으로 알아본다(lib/review.ts).
// 다른 저장소의 dispatch: 한 Run 에 저장소마다 루프가 있으면 모든 루프가 같은 worker_done 을 읽는다. 이 저장소에 띄우기 기록이 없고
//   Orca 의 worker 워크트리가 다른 저장소의 것이고 그 저장소에 이 Run 을 보는 살아 있는 루프가 있으면, 근거 없는 보고를 알리지 않고 본 것으로만 남긴다.
//   띄운 저장소의 루프가 맡는다. 그 저장소에 루프가 없으면 이 루프가 알린다. finish 가 워크트리를 지웠으면 worktreeId 앞부분의 Orca 저장소 id 로
//   `orca repo list` 에서 저장소를 찾는다.
//   띄운 루프는 지시서를 지운 뒤 「(지시서를 읽지 못했다)」 를 붙여 본문이 달라, Run 알림의 중복 억제(lib/run-notice.ts)를 지나 두 번 갔다(2026-11-19).
// 머지된 dispatch: 근거 없는 보고라도 띄우기 기록의 브랜치(없으면 지시서의 첫 `브랜치:` 줄)에 열린 PR 이 없고 MERGED PR 이 있으면
//   이미 끝난 일이라 DONE-SUSPECT 를 보내지 않는다. PR 조회가 실패하면 판단하지 않고 그대로 알린다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classify, context, noPrInstruction, payload } from '../lib/completion.ts'
import { senderOf } from '../core/message-fields.ts'
import { orcaJson } from '../lib/orca.ts'
import { ghJson } from '../lib/gh.ts'
import { linkBoardPr, prTaskRef } from '../lib/board.ts'
import { boardPath } from '../lib/board-file.ts'
import { makeParent, pathOf } from '../lib/paths.ts'
import { isRegistered, loopStatus, runKey } from '../lib/loop.ts'
import { reviewPrOfDispatch } from '../lib/review.ts'
import { readLaunch } from '../lib/launched.ts'
import { launchHistory } from '../lib/launch-history.ts'
import { git, mainCheckout } from '../lib/git.ts'
import { fire } from '../lib/events.ts'
import { notifyRun } from '../lib/run-notice.ts'
import { continueWorker, openPrOf } from '../lib/continue-worker.ts'
import { dispatchRepo } from '../lib/main-guard.ts'
import { branchesOf } from '../lib/spec.ts'

type Json = Record<string, any>
type Seen = { ids: string[]; last: string; suspects: string[]; events: string[]; returned?: string[]; returnNotes?: Record<string, string> }
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

// finish 가 워크트리를 지웠으면 worktreeId 의 앞부분(`<Orca 저장소 id>::<경로>`)으로 Orca 에 등록된 저장소를 찾는다. 모르면 null
function orcaRepoOf(dispatch: string): string | null {
  const shown = orcaJson<Json>(['orchestration', 'worker-show', '--dispatch', dispatch])
  const worker = shown.ok ? shown.data?.worker : null
  const id = String(worker?.worktreeId ?? worker?.startOptions?.resolvedWorktreeId ?? '')
  if (!id.includes('::')) return null
  const repoId = id.slice(0, id.indexOf('::'))
  const listed = orcaJson<Json>(['repo', 'list'])
  const repos = listed.ok && Array.isArray(listed.data?.repos) ? listed.data.repos : []
  const found = repos.find((row: Json) => row?.id === repoId)?.path
  return typeof found === 'string' && existsSync(found) ? mainCheckout(found) : null
}

// Orca 의 worker 워크트리가 다른 저장소의 것이고 그 저장소에 이 Run 을 보는 살아 있는 루프가 있는지.
// 워크트리가 지워졌으면 Orca 저장소 id 로 찾는다. 그래도 저장소를 알 수 없으면 모른다(false). 그 저장소에 루프가 없으면 어디서도 알리지 않게 되므로 false 다
function foreignDispatch(repo: string, run: string, dispatch: string): boolean {
  if (!dispatch) return false
  const found = dispatchRepo(repo, dispatch)
  const owner = found !== null && existsSync(found) ? found : orcaRepoOf(dispatch)
  if (owner === null) return false
  const mine = mainCheckout(repo)
  if (owner === mine || owner.startsWith(`${mine}/`)) return false
  return isRegistered(owner, run) && loopStatus(owner, Date.now()).alive
}

// dispatch 의 브랜치에 열린 PR 이 없고 MERGED PR 이 있는지. 브랜치를 모르거나 조회가 실패하면 false.
// 띄운 시각(since) 뒤에 머지된 PR 만 센다. 같은 이름의 옛 브랜치 PR 로 새 dispatch 의 경고를 숨기지 않으려는 것이다. 띄운 시각을 모르면 숨기지 않는다
function branchMerged(repo: string, launch: { branch?: string | null; spec?: string | null } | undefined, since: string | null): boolean {
  const after = since ? Date.parse(since) : NaN
  if (Number.isNaN(after)) return false
  let branch = launch?.branch ?? null
  if (!branch && launch?.spec) {
    try { branch = branchesOf(readFileSync(launch.spec, 'utf8'))[0] ?? null } catch { branch = null }
  }
  if (!branch) return false
  // 열린 PR 은 따로 조회한다. 머지된 PR 이 많으면 한 번의 --state all 목록에서 열린 PR 이 밀려날 수 있다
  const open = openPrOf(repo, branch)
  if (!open.ok || open.pr) return false
  const got = ghJson<Json[]>(['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,state,mergedAt', '--limit', '5'], { cwd: repo })
  if (!got.ok || !Array.isArray(got.data)) return false
  return got.data.some(pr => Date.parse(String(pr?.mergedAt ?? '')) >= after)
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
  const launchedInOtherRepo = (worktree: string) => {
    if (!existsSync(repo) || !existsSync(worktree)) return false
    const [current, target] = [repo, worktree].map(path => git(path, ['rev-parse', '--show-toplevel']))
    return current.code === 0 && target.code === 0 && mainCheckout(repo) !== mainCheckout(worktree)
  }
  const options = {
    isReview,
    isNoPr: (dispatch: string): boolean | 'unreadable' => {
      if (isReview(dispatch)) return false
      const launch = launchOf(dispatch)
      if (launch?.completion === 'none') return true
      if (launch?.worktree && launchedInOtherRepo(launch.worktree)) return true
      if (!launch?.spec) return false
      try { return noPrInstruction(readFileSync(launch.spec, 'utf8')) } catch { return 'unreadable' }
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
    if (!launch && verified?.status === 'suspicious' && foreignDispatch(repo, run, dispatch)) {
      seen.ids.push(id); if (time(message) > seen.last) seen.last = time(message); save(); continue
    }
    if (launch?.completion !== 'none' && (verified?.status === 'ready' || verified?.status === 'suspicious')) {
      let pr: Json | null = null
      let prState: string | null = null
      if (verified.status === 'ready' && typeof verified.pr === 'number') {
        const got = ghJson<Json>(['pr', 'view', String(verified.pr), '--json', 'number,title,headRefName,headRefOid,author,isDraft,url,state'], { cwd: repo })
        // 이 저장소가 띄우지 않은 dispatch(기록 없음)의 PR 번호는 다른 저장소의 것일 수 있다. 여러 저장소의 루프가 한 Run 에 있으면
        // 남의 PR 번호로 조회가 실패하므로, 그 dispatch 는 건너뛰고 띄운 저장소의 루프가 맡는다
        if (!got.ok && !launch) { seen.ids.push(id); if (time(message) > seen.last) seen.last = time(message); save(); continue }
        if (!got.ok) throw new Error(got.error)
        const v = got.data
        pr = { number: v.number, title: v.title, branch: v.headRefName, head: v.headRefOid, author: v.author?.login ?? null, draft: v.isDraft, url: v.url }
        prState = typeof v.state === 'string' ? v.state : null
        if (existsSync(boardPath(repo)) && typeof pr.branch === 'string') linkBoardPr(boardPath(repo), String(pr.number), pr.branch, prTaskRef(repo, String(pr.title ?? '')))
      }
      if (!seen.events.includes(id)) {
        await fire('worker-done', { worker: { task, dispatch, terminal: senderOf(message) || null, worktree: null, spec: null }, outcome: message.outcome ?? payload(message).outcome ?? null, evidence: verified.status, pr }, { repo, run, base })
        seen.events.push(id); save()
      }
      // PR 이 열린 채 온 완료 보고는 알리기 전에 그 worker 에게 되돌려 이어 맡긴다. notice 는 알릴 글이고 없으면 알리지 않는다
      let notice = verified.status === 'suspicious' ? String(verified.reason) : ''
      if ((verified.status === 'suspicious' || prState === 'OPEN') && !seen.suspects.includes(dispatch) && !seen.returned?.includes(dispatch)) {
        const exclude = (seen.returned ?? []).flatMap(key => /^pr:(\d+)$/.exec(key)?.[1] ?? []).map(Number)
        const back = await continueWorker(repo, dispatch, { run, knownPr: typeof pr?.number === 'number' ? pr.number : null, exclude })
        if (back.kind === 'ok') {
          // 되돌린 기록과 알릴 글을 함께 남긴다. 알림이 실패해도 다음 틱이 되돌리지 않고 알림만 다시 보낸다
          ;(seen.returned ??= []).push(dispatch, `pr:${back.target.pr.number}`)
          ;(seen.returnNotes ??= {})[dispatch] = `${dispatch} PR #${back.target.pr.number} 이 아직 열려 있어 같은 워크트리의 worker 에게 되돌렸다(새 dispatch ${back.dispatch || '-'}). 머지될 때까지 맡는다`
          save()
          notice = ''
        } else if (back.kind === 'fail') {
          notice = `${notice || 'PR 이 열린 채 완료 보고가 왔다'} (이어 맡기지 못했다: ${back.reason}. 고친 뒤 orch worker continue --dispatch ${dispatch})`
        } else if (verified.status === 'suspicious' && branchMerged(repo, launch, historyByDispatch.get(dispatch)?.at ?? null)) {
          notice = ''
        } else if (back.reason.includes('이미 한 번 되돌렸다')) {
          // 준비됨 뒤의 두 번째 조기 완료도 알린다. 근거 없는 보고의 이유가 없으면 PR 이 열려 있다는 사실이 이유다
          notice = `${notice || 'PR 이 열린 채 완료 보고가 왔다'} (${back.reason})`
        }
      }
      const pending = seen.returnNotes?.[dispatch]
      if (pending) {
        const sent = notifyRun(run, 'DONE-RETURNED', pending)
        if (!sent.ok) throw new Error(`NOTICE-FAIL DONE-RETURNED ${sent.error}`)
        delete seen.returnNotes![dispatch]; save()
      }
      if (notice && !seen.suspects.includes(dispatch) && !seen.returned?.includes(dispatch)) {
        const sent = notifyRun(run, 'DONE-SUSPECT', `${dispatch} ${notice}`)
        if (!sent.ok) throw new Error(`NOTICE-FAIL DONE-SUSPECT ${sent.error}`)
        seen.suspects.push(dispatch)
      }
    }
    seen.ids.push(id)
    if (time(message) > seen.last) seen.last = time(message)
    save()
  }
}
