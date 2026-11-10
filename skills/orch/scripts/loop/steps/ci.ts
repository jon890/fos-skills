// CI 감시: 내 열린 PR 가운데 draft 가 아닌 것마다 필수 체크 상태를 정한다. 다른 사람의 PR 과 draft 는 보지 않는다.
//     필수 체크 이름은 lib/gh.ts 의 requiredNames(queue.required, 없으면 base 의 저장소 규칙. 같은 base 의 규칙은 틱마다 한 번 읽는다),
//     상태는 ciState(queue.skipped_is_missing 을 따른다)다. 머지 큐의 기본 판정(--allow-fail 없음)과 같다. 필수가 아닌 체크의 실패도
//     failed 이고, passed 는 실패가 없고 필수 체크가 모두 나타났고 롤업의 체크가 모두 끝난 때다. 필수 체크 목록이 비면 나타난 체크 전부로
//     판정한다. 루프는 --allow-fail 을 모른다. 머지 큐에 --allow-fail 을 주는 저장소에서는 루프가 실패로 알린 PR 도 큐는 머지할 수 있다.
//     base 조회가 실패하거나 예외가 나면 기존 worker 전달로 돌아간다.
//     같은 워크플로의 base 최신 실행도 실패하면 worker 에게 보내지 않고 CI-FAILED 에 `<base> 도 실패` 를 쓴다. 조회는 공유 캐시를 쓴다.
//     loop.json 의 ci[<PR>] 와 HEAD 와 상태가 같으면 넘어간다. 다르면 새 값을 결과의 ci 에 담고, passed 로 바뀌었으면 ci-passed 를,
//     failed 로 바뀌었으면 그 PR 의 worker 에게 보내고 Run 에 Orca 메시지로 CI-FAILED 를 쓴 뒤 ci-failed 를 낸다(입력은 lib/events.ts 머리 주석의
//     「이벤트별 필드」). 같은 HEAD 에서 다시 돌린 체크가 통과로 바뀌면 ci-passed 를 낸다. 새 HEAD 는 새로 판정한다.
//     처음 본 PR(이전 값이 없는 PR)은 지금 상태를 한 번 알린다. 루프를 처음 띄운 때 이미 실패해 있던 PR 도 알리려는 의도다.
//     결과의 ci 는 이번 틱에 본 내 열린 PR 의 값이라 닫힌 PR 의 항목은 빠진다. draft 와 규칙을 읽지 못한 base 의 PR 처럼 이번 틱에
//     판정하지 않은 PR 은 이전 값을 그대로 옮긴다. 지우면 다음 틱에 같은 HEAD 의 실패를 다시 알린다.
//     규칙을 읽지 못한 base 는 errors.ci 로 `WATCH-ERROR ci: …` 를 쓴다(errors.ts 머리 주석의 「오류 줄 억제」).
//     worker 에게 보내기: 맡은 Run 에 Run id 가 있고, 그 PR 브랜치의 워크트리(lib/workers.ts 의 worktreePaths)에 살아 있는 dispatch
//     (shared.ts 머리 주석의 「worker 찾기」, LIVE_DISPATCH)가 있을 때만 send-to-worker --dispatch <id> --body <본문> --run <그 worker 의 Run> 으로 보낸다. 끝난 dispatch 에 후속 지시서로
//     이어 쓰지 않는다. 그때는 CI-FAILED 로 코디네이터가 판단한다. CI-FAILED 의 text 는 `<실패한 체크 이름>: <worker 결과>` 이고 worker 결과는
//     `보냈다 <dispatch>`, `깨우지 못했다(종료 코드 4)`, `보내지 못했다(종료 코드 <n>)`, `살아 있는 dispatch 없음`, `Run id 없음`,
//     `worker 목록을 읽지 못했다` 가운데 하나다.
//     실패한 체크가 모두 CANCELLED 면 코디네이터가 일부러 취소한 CI 일 수 있어 worker 에게 보내지 않는다. worker 결과는 `취소만 있음` 이고
//     CI-FAILED 는 그 PR 의 worker 를 띄운 Run 에 쓴다. 같은 체크 이름과 워크플로에 더 늦게 시작한 실행이 있으면 옛 취소는 애초에 실패로 세지 않는다(lib/gh.ts 의 currentChecks).

import { scriptPath } from '../../lib/commands.ts'
import { SEND_MS } from '../../lib/conflicts.ts'
import { fire } from '../../lib/events.ts'
import { baseWorkflowFailed, cancelledOnly, ciState, failedCheck, requiredNames } from '../../lib/gh.ts'
import type { CiCheck, Names } from '../../lib/gh.ts'
import { runAsync, scriptCommand } from '../../lib/proc.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { LIVE_DISPATCH, worktreePaths } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { ciEntries, log, oneLine, ownerOf, primaryRun, relay } from './shared.ts'
import type { CiEntry, Lookup, OwnPr } from './shared.ts'

function prInput(pr: OwnPr): Record<string, unknown> {
  return { number: pr.number, title: pr.title, branch: pr.branch || null, head: pr.head || null, author: pr.author, draft: pr.draft, url: pr.url }
}

// 실패한 체크가 모두 CANCELLED 일 때 CI-FAILED 의 worker 결과(머리 주석의 「CI 감시」)
const CANCELLED_ONLY = '취소만 있음'

// 체크가 실패한 PR 의 살아 있는 dispatch 에 보낸다. text 는 CI-FAILED 의 text 에 붙일 말, run 은 그 worker 를 띄운 Run 이다
// (모르면 null. 알림은 주 Run 에 간다. 머리 주석의 「CI 감시」)
async function tellWorker(ctx: Context, pr: OwnPr, failed: CiCheck[], lookup: Lookup): Promise<{ text: string; run: string | null }> {
  if (!lookup.runs.some((entry) => entry.run)) return { text: 'Run id 없음', run: null }
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  if (!path) return { text: '살아 있는 dispatch 없음', run: null }
  const owner = ownerOf(path, lookup)
  if (!owner.ok) {
    log(`orch-loop: worker 목록을 읽지 못했다: ${oneLine(owner.error)}`)
    return { text: 'worker 목록을 읽지 못했다', run: null }
  }
  const found = owner.found
  if (!found || !found.run || !LIVE_DISPATCH.has(String(found.row.dispatchStatus))) return { text: '살아 있는 dispatch 없음', run: found?.run ?? null }
  const dispatch = String(found.row.dispatchId)
  const shown = failed.map((check) => (check.url ? `${check.name} ${check.url}` : check.name)).join(', ')
  const body = `PR #${pr.number} 의 체크가 실패했다: ${shown}. 실패를 고치고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.`
  const send = process.env.SEND_TO_WORKER || scriptPath('send-to-worker')
  const sent = await runAsync(scriptCommand(send, ['--dispatch', dispatch, '--body', body, '--run', found.run, '--no-reply']), { cwd: ctx.repo, timeoutMs: SEND_MS })
  relay(sent)
  if (sent.code === 0) return { text: `보냈다 ${dispatch}`, run: found.run }
  if (sent.code === 4) return { text: '깨우지 못했다(종료 코드 4)', run: found.run }
  return { text: `보내지 못했다(종료 코드 ${sent.code})`, run: found.run }
}

async function fireCi(event: 'ci-passed' | 'ci-failed', ctx: Context, pr: OwnPr, checks: CiCheck[], required: string[], run: string | null): Promise<void> {
  try {
    // 핸들러의 실패는 fire 가 낸 HOOK-FAIL 줄로만 남는다. Run 메시지의 HOOK-FAIL 은 tick 핸들러의 것만이다
    await fire(event, { pr: prInput(pr), checks, required }, { repo: ctx.repo, base: pr.base, run })
  } catch (e) {
    log(`orch-loop: ${event} 를 내지 못했다: ${oneLine(e)}`)
  }
}

// 그 PR 워크트리의 worker 를 띄운 Run. 모르거나 읽지 못하면 주 Run 이다
function runOfPr(ctx: Context, pr: OwnPr, lookup: Lookup): string | null {
  lookup.paths ??= worktreePaths(ctx.repo)
  const path = lookup.paths.get(pr.branch)
  const owner = path ? ownerOf(path, lookup) : null
  return (owner?.ok && owner.found?.run) || primaryRun(lookup)
}

// CI 감시(머리 주석의 「CI 감시」). ci 는 결과 줄에 담을 값, error 는 errors.ci 에 둘 이유다
// stale 은 규칙을 읽지 못해 이전 판정을 옮긴 PR 이다. 자동 머지가 옛 passed 로 걸지 않게 한다
async function watchCi(
  ctx: Context,
  mine: OwnPr[],
  previous: Record<string, CiEntry>,
  lookup: Lookup,
): Promise<{ ci: Record<string, CiEntry>; error: string | null; stale: Set<number> }> {
  const ci: Record<string, CiEntry> = {}
  const stale = new Set<number>()
  const rules = new Map<string, Names>()
  const errors: string[] = []
  for (const pr of mine) {
    const key = String(pr.number)
    const before = previous[key]
    if (pr.draft) {
      if (before) ci[key] = before
      continue
    }
    const where = `${pr.host} ${pr.slug} ${pr.base}`
    let names = rules.get(where)
    if (!names) {
      try {
        names = requiredNames(ctx.repo, pr.host, pr.slug, pr.base)
      } catch (e) {
        names = { ok: false, error: oneLine(e) }
      }
      rules.set(where, names)
      if (!names.ok) errors.push(`${pr.base} 의 필수 체크 규칙을 읽지 못했다: ${oneLine(names.error)}`)
    }
    if (!names.ok) {
      if (before) ci[key] = before
      stale.add(pr.number)
      continue
    }
    const judged = ciState(pr.rollup, names.names, ctx.skippedIsMissing, pr.head)
    const entry: CiEntry = { head: pr.head, state: judged.state }
    ci[key] = entry
    if (before && before.head === entry.head && before.state === entry.state) continue
    if (entry.state === 'passed') {
      log(`CI-PASSED #${pr.number} ${pr.head.slice(0, 8)}`)
      await fireCi('ci-passed', ctx, pr, judged.checks, names.names, runOfPr(ctx, pr, lookup))
    } else if (entry.state === 'failed') {
      const failed = judged.checks.filter(failedCheck)
      let told: { text: string; run: string | null }
      try {
        // 취소만 있으면 코드 실패가 아니다. worker 에게 고치라고 보내지 않고 코디네이터에게만 알린다
        const cancelled = cancelledOnly(failed)
        let baseFailed = false
        if (!cancelled) {
          try {
            baseFailed = baseWorkflowFailed(ctx.repo, pr.host, pr.slug, pr.base, failed)
          } catch (e) {
            log(`orch-loop: base CI 를 확인하지 못했다: ${oneLine(e)}`)
          }
        }
        told = cancelled ? { text: CANCELLED_ONLY, run: runOfPr(ctx, pr, lookup) }
          : baseFailed ? { text: `${pr.base} 도 실패`, run: runOfPr(ctx, pr, lookup) }
            : await tellWorker(ctx, pr, failed, lookup)
      } catch (e) {
        told = { text: `보내지 못했다(${oneLine(e)})`, run: null }
      }
      const text = `${failed.map((check) => check.name).join(', ')}: ${told.text}`
      const run = told.run ?? primaryRun(lookup)
      log(`CI-FAILED #${pr.number} ${text}`)
      try {
        sendNotice('CI-FAILED', pr.number, text, run)
      } catch (e) {
        if (before) ci[key] = before
        else delete ci[key]
        log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
      }
      await fireCi('ci-failed', ctx, pr, judged.checks, names.names, run)
    }
  }
  return { ci, error: errors.length > 0 ? errors.join('; ') : null, stale }
}

export async function checkCi(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { loaded, lookup } = ctx
  const { prs } = state
  const { report, errors } = reporter(ctx)
  // 5. CI 감시. 열린 PR 을 읽지 못한 틱은 결과에 ci 를 넣지 않아 부모가 이전 값을 둔다
  let ci: Record<string, CiEntry> | undefined
  let ciStale = new Set<number>()
  if (prs.ok) {
    try {
      const watched = await watchCi(ctx, prs.mine, ciEntries(loaded?.ci), lookup)
      ci = watched.ci
      ciStale = watched.stale
      report('ci', watched.error)
    } catch (e) {
      report('ci', oneLine(e))
    }
  }
  return { errors, ...(ci ? { ci } : {}), ciStale }
}
