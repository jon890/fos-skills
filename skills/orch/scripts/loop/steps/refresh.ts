// 최신화(ADR-020): pipeline.refresh_slots 가 1 이상이고 열린 PR 을 읽은 틱에만 돈다. 머지 큐가 차례가 온 PR 에 할 update-branch 를 미리,
//     PR 마다 따로 걸어 뒤처진 PR 의 CI 가 함께 돌게 한다. 머지는 지금처럼 머지 큐가 하나씩 한다. 판정과 설정은 lib/refresh.ts 가 소유한다.
//     충돌 찾기가 실패한 틱은 건너뛰고 errors.refresh 를 그대로 둔다. 내 열린 PR 이 없으면 git fetch 없이 끝낸다.
//     queue.require_up_to_date 가 false 면 아무것도 하지 않고 `WATCH-ERROR refresh: pipeline.refresh_slots 를 켰지만 …` 을 낸다.
//     기록은 state/refresh.json 이다(lib/refresh.ts 의 「기록」). 이번 틱의 내 열린 PR 이 아닌 PR 의 항목은 지운다.
//     자리: 기록 가운데 lib/refresh.ts 의 inFlight 가 참인 것의 수가 쓴 자리다. 이번 틱에 건 것도 더한다.
//     대상은 내 열린 PR 가운데 번호 순으로, draft 가 아니고 base 가 기준 브랜치(충돌 처리와 같다)이고 충돌하지 않는 같은 저장소의 PR 이다.
//     충돌 찾기가 읽은 HEAD 와 열린 PR 조회의 HEAD 가 다르면 이 틱에는 넘어간다. PR 마다 아래를 차례로 보고, 처음 걸린 곳에서 그 PR 을 넘긴다.
//     1. 기록에 그 PR 의 같은 base SHA 가 있으면 넘어간다. 같은 (PR, base SHA) 에는 두 번 걸지 않는다
//     2. lib/refresh.ts 의 forkFiles 와 verdict 로 판정한다. 최신이거나 머지 큐가 바로 머지할 PR 은 조용히 넘어간다
//     3. 아래는 `REFRESH-WAIT #<PR> <이유>(<판정 이유>)` 를 로그에 쓰고 넘어간다. 도는 머지 큐(명령줄에 `merge_queue.` 가 든 프로세스의
//        차례 기록)의 차례 PR 이면 `머지 큐의 차례다`. 큐 밖에서 HEAD 가 바뀌면 그 PR 이 STOP 으로 멈추기 때문이다.
//        이번 틱의 CI 가 그 HEAD 에서 passed 가 아니면 `CI <상태 또는 없음>`. 도는 CI 를 끊거나 실패를 덮지 않으려는 것이다.
//        lib/refresh.ts 의 aheadInQueue 가 큐의 앞 PR 을 내면 `머지 큐의 앞 PR #<번호> 이 머지된 뒤 최신화한다`.
//        쓴 자리가 refresh_slots 이상이면 `최신화 자리 <쓴 수>/<상한> 가 찼다`. 부르기 직전에 차례 기록을 다시 읽어 차례 PR 이 되었으면 차례다
//     4. update: lib/gh.ts 의 updateBranch(이유 refresh, expected_head_sha 는 판정한 HEAD)를 부른다. 성공하면 기록의 value 가 updated 이고
//        `REFRESH #<PR> update-branch base <브랜치>(<SHA 앞 8자리>) HEAD <앞 8자리>: <판정 이유>` 를 로그에 쓴다.
//        실패하면 value 가 failed 이고 `#<PR> update-branch 실패: …` 를 오류 이유로 둔다. 같은 base 에는 다시 부르지 않는다
//     5. worker: 브랜치의 워크트리와 worker(shared.ts 머리 주석의 「worker 찾기」)가 살아 있는 dispatch 면 send-to-worker --dispatch <d> --body <글> --no-reply [--run <Run>] 으로
//        `PR #<PR> 이 base <브랜치>(<SHA 앞 8자리>) 에 뒤처졌다. <판정 이유>. origin/<브랜치> 를 합쳐 검증하고 한 번 push 한다. 끝나면 status 로 알린다.` 를 보낸다.
//        보냈으면(0, 1, 4) value 가 dispatch 이고 `REFRESH-WORKER #<PR> <dispatch> 에 합치기를 보냈다…` 를 로그에 쓴다.
//        워크트리나 살아 있는 dispatch 가 없거나 send-to-worker 가 3 이면 value 가 orphan 이고 `REFRESH-ORPHAN #<PR> <이유>: <판정 이유>` 를 로그에만 쓴다.
//        새 worker 는 띄우지 않는다. 2 면 그 틱의 최신화를 멈추고 `send-to-worker 사용법 오류`, 그 밖의 종료 코드와 worker 목록을 읽지 못한 것은
//        기록하지 않고 오류 이유로 둔다. 다음 틱이 다시 본다
//     충돌 처리(pr-conflict)와 메시지와 기록을 합치지 않는다. 충돌한 PR 은 충돌 찾기의 clean 에 없어 이 단계에 오지 않는다.
//     오류 이유는 `; ` 로 이어 errors 의 refresh 에 둔다(errors.ts 머리 주석의 「오류 줄 억제」)

import { scriptPath } from '../../lib/commands.ts'
import { SEND_MS } from '../../lib/conflicts.ts'
import type { Found } from '../../lib/conflicts.ts'
import { updateBranch } from '../../lib/gh.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { aheadInQueue, forkFiles, inFlight, readRefresh, refreshFile, verdict as refreshVerdict, writeRefresh } from '../../lib/refresh.ts'
import type { ForkFiles } from '../../lib/refresh.ts'
import { LIVE_DISPATCH, worktreePaths } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { processes, queueTurns } from './queue-turns.ts'
import { iso, log, oneLine, ownerOf, relay } from './shared.ts'
import type { CiEntry, Lookup, OwnPr } from './shared.ts'

// 머리 주석의 「최신화」. 오류가 있으면 이유를 `; ` 로 이어 내고, 없으면 null 이다
async function refreshBehind(ctx: Context, mine: OwnPr[], ci: Record<string, CiEntry>, base: string, found: Found, lookup: Lookup): Promise<string | null> {
  const settings = ctx.refresh
  if (!settings.upToDate) return 'pipeline.refresh_slots 를 켰지만 queue.require_up_to_date 가 false 라 머지 큐가 최신화하지 않는다. 최신화도 하지 않는다'
  const file = refreshFile(ctx.repo)
  const records = readRefresh(file)
  const byNumber = new Map(mine.map((pr) => [pr.number, pr]))
  for (const key of Object.keys(records)) if (!byNumber.has(Number(key))) delete records[key]
  const ciOf = (pr: OwnPr) => (ci[String(pr.number)]?.head === pr.head ? ci[String(pr.number)].state : null)
  const now = Date.now()
  let used = Object.entries(records).filter(([key, record]) => {
    const pr = byNumber.get(Number(key))
    return pr ? inFlight(record, pr.head, ciOf(pr), now) : false
  }).length
  const listed = processes()
  if (!listed) {
    writeRefresh(file, ctx.repo, records)
    return '프로세스 목록을 읽지 못했다'
  }
  const turns = queueTurns(ctx.repo, listed)
  const queue = turns.flatMap((turn) => turn.prs)
  const fresh = new Map(found.clean.map((pr) => [pr.number, pr]))
  const changed = new Map<number, string[] | null>()
  const filesOf = (n: number): string[] | null => {
    if (!changed.has(n)) {
      const head = fresh.get(n)?.headRefOid
      const got = head ? forkFiles(ctx.repo, found.baseSha, head) : null
      changed.set(n, got?.ok ? got.files.pr : null)
    }
    return changed.get(n) ?? null
  }
  const errors = new Set<string>()
  const wait = (pr: OwnPr, why: string) => log(`REFRESH-WAIT #${pr.number} ${why}`)
  for (const pr of [...mine].sort((a, b) => a.number - b.number)) {
    const seen = fresh.get(pr.number)
    // 충돌한 PR 과 다른 base 의 PR 은 충돌 찾기의 clean 에 없다. 충돌은 충돌 처리가 맡는다
    if (pr.draft || pr.base !== base || !seen || seen.isCrossRepository) continue
    if (seen.headRefOid !== pr.head) continue
    const record = records[String(pr.number)]
    if (record && record.base === found.baseSha) continue
    const got = forkFiles(ctx.repo, found.baseSha, pr.head)
    if (!got.ok) {
      errors.add(`#${pr.number} 의 변경을 읽지 못했다: ${oneLine(got.error)}`)
      continue
    }
    const files: ForkFiles = got.files
    const judged = refreshVerdict(files, settings)
    if (judged.action === 'skip') continue
    if (turns.some((turn) => turn.pr === pr.number)) {
      wait(pr, `머지 큐의 차례다(${judged.reason})`)
      continue
    }
    const state = ciOf(pr)
    if (state !== 'passed') {
      wait(pr, `CI ${state ?? '없음'}(${judged.reason})`)
      continue
    }
    const ahead = aheadInQueue(pr.number, files, queue, filesOf, settings)
    if (ahead !== null) {
      wait(pr, `머지 큐의 앞 PR #${ahead} 이 머지된 뒤 최신화한다(${judged.reason})`)
      continue
    }
    if (used >= settings.slots) {
      wait(pr, `최신화 자리 ${used}/${settings.slots} 가 찼다(${judged.reason})`)
      continue
    }
    // 판정하는 사이 큐가 이 PR 차례로 넘어왔을 수 있다. 차례 기록만 다시 읽는다
    if (queueTurns(ctx.repo, listed).some((turn) => turn.pr === pr.number)) {
      wait(pr, `머지 큐의 차례다(${judged.reason})`)
      continue
    }
    const at = iso()
    if (judged.action === 'update') {
      const done = updateBranch(pr.slug, { number: pr.number, isDraft: pr.draft }, 'refresh', { host: pr.host, expectedHead: pr.head })
      if (done.code === 0) {
        records[String(pr.number)] = { base: found.baseSha, from: pr.head, at, action: 'update', value: 'updated' }
        used += 1
        log(`REFRESH #${pr.number} update-branch base ${base}(${found.baseSha.slice(0, 8)}) HEAD ${pr.head.slice(0, 8)}: ${judged.reason}`)
      } else {
        records[String(pr.number)] = { base: found.baseSha, from: pr.head, at, action: 'update', value: 'failed' }
        errors.add(`#${pr.number} update-branch 실패: ${oneLine(done.stderr || done.stdout || `종료 코드 ${done.code}`)}`)
      }
      continue
    }
    const told = await tellRefresh(ctx, pr, base, found.baseSha, judged.reason, lookup)
    if (told.usage) {
      errors.add('send-to-worker 사용법 오류')
      break
    }
    if (told.error) {
      errors.add(told.error)
      continue
    }
    records[String(pr.number)] = { base: found.baseSha, from: pr.head, at, action: 'worker', value: told.value }
    if (told.value === 'orphan') {
      log(`REFRESH-ORPHAN #${pr.number} ${told.why}: ${judged.reason}`)
    } else {
      used += 1
      log(`REFRESH-WORKER #${pr.number} ${told.value} 에 합치기를 보냈다${told.why}: ${judged.reason}`)
    }
  }
  try {
    writeRefresh(file, ctx.repo, records)
  } catch (e) {
    errors.add(`state/refresh.json 을 쓰지 못했다: ${oneLine(e)}`)
  }
  return errors.size > 0 ? [...errors].join('; ') : null
}

// 최신화에 worker 판단이 필요한 PR 의 살아 있는 dispatch 에 base 합치기를 보낸다(머리 주석의 「최신화」).
// value 는 보낸 dispatch 이거나 orphan(worker 없음)이다. error 면 기록하지 않고 다음 틱이 다시 본다
async function tellRefresh(
  ctx: Context,
  pr: OwnPr,
  base: string,
  baseSha: string,
  reason: string,
  lookup: Lookup,
): Promise<{ usage?: true; error?: string; value: string; why: string }> {
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  if (!path) return { value: 'orphan', why: '워크트리 없음' }
  const owner = ownerOf(path, lookup)
  if (!owner.ok) return { error: `worker 목록을 읽지 못했다: ${oneLine(owner.error)}`, value: '', why: '' }
  const row = owner.found?.row
  if (!row || !LIVE_DISPATCH.has(String(row.dispatchStatus))) return { value: 'orphan', why: '살아 있는 dispatch 없음' }
  const dispatch = String(row.dispatchId)
  const body =
    `PR #${pr.number} 이 base ${base}(${baseSha.slice(0, 8)}) 에 뒤처졌다. ${reason}. ` +
    `origin/${base} 를 합쳐 검증하고 한 번 push 한다. 끝나면 status 로 알린다.`
  const args = ['--dispatch', dispatch, '--body', body, '--no-reply']
  if (owner.found?.run) args.push('--run', owner.found.run)
  const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
  const sent = await runAsync(scriptCommand(send, args), { cwd: ctx.repo, timeoutMs: SEND_MS })
  relay(sent)
  if (sent.code === 2) return { usage: true, value: '', why: '' }
  if (sent.code === 3) return { value: 'orphan', why: `${dispatch} 에 보낼 수 없다(send-to-worker 종료 코드 3)` }
  if (sent.code === 0) return { value: dispatch, why: '' }
  if (sent.code === 1 || sent.code === 4) return { value: dispatch, why: `(깨우지 못했다, 종료 코드 ${sent.code})` }
  return { error: `#${pr.number} 를 ${dispatch} 에 보내지 못했다(send-to-worker 종료 코드 ${sent.code})`, value: '', why: '' }
}

export async function refreshPrs(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { lookup } = ctx
  const { prs, ci, conflictBase, found } = state
  if (!prs.ok) return {}
  const { report, errors } = reporter(ctx)
  // 9-1. 최신화. 충돌 찾기가 받은 base 와 PR HEAD 를 쓴다. 충돌 찾기가 실패한 틱은 건너뛰고 errors.refresh 를 그대로 둔다
  if (ctx.refresh.slots > 0 && (found || prs.mine.length === 0)) {
    try {
      report('refresh', found ? await refreshBehind(ctx, prs.mine, ci ?? {}, conflictBase, found, lookup) : null)
    } catch (e) {
      report('refresh', oneLine(e))
    }
  }
  return { errors }
}
