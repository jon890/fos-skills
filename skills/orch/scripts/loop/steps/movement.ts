// 움직임 확인: 화면 상태가 아니라 무엇이 바뀌었는지로 오래 움직이지 않은 worker 와, worker 없이 멈춘 보드 단계를 찾는다.
//     Orca 의 structured worker 는 화면이 대화 기록 꼴이라 멈춤 확인이 입력란을 찾지 못한다(늘 unknown). 판정과 기록 형식은 lib/movement.ts
//     머리 주석이 소유하고, 이 단계는 읽기, 기록, 알리기만 한다. 코디네이터가 지금 상태를 직접 볼 때는 stalled-workers.ts 가 같은 판정을 낸다.
//     pipeline.idle_min 이 0 이고 pipeline.idle_exited 가 false 면 돌지 않는다.
//     화면: 멈춤 확인이 이번 틱에 읽은 화면 끝 줄의 hash 를 state/movement.json 의 screens[<dispatch>] 에 바뀐 시각과 함께 둔다. 화면을 다시 읽지 않는다.
//     같은 화면의 백그라운드 작업 표시(lib/screen.ts 의 backgroundWork)도 background 로 둔다. 판정은 그 표시가 있으면 멈춤으로 보지 않는다(lib/movement.ts).
//     기다리는 이유: 그 Run 의 질문을 읽지 못했거나, 그 dispatch(또는 터미널)가 보낸 미답변 질문이 있거나, 그 워크트리 브랜치의 내 열린 PR 이
//     이번 틱의 CI 감시에서 지금 HEAD 로 passed 면 멈춤으로 보지 않는다. 코디네이터의 차례다. exited 는 이유가 있어도 알린다.
//     worker: 새로 멈춘 dispatch 마다 그 worker 를 띄운 Run 의 Run 에 Orca 메시지로 WORKER-IDLE(text `<dispatch> <idle 또는 exited> <움직임 뒤 분 또는 ->분
//     <워크트리 이름 또는 -> <터미널 또는 ->`)을 쓴다. 다시 알리는 때는 lib/movement.ts 의 「알림 기록」 이다.
//     단계: 맡은 Run 의 worker 목록을 모두 읽은 틱에만 본다. 새로 멈춘 단계마다 주 Run 에 Orca 메시지로 STAGE-STALLED(text `<보드 항목 id>
//     <worktree 칸, 없으면 branch 칸> <분>분 <끝나지 않은 첫 단계>`)를 쓴다. 못 읽은 Run 이 있으면 단계 기록을 그대로 둔다.
//     보드를 읽지 못했거나 movement.json 을 쓰지 못하면 errors 의 movement 에 이유를 둔다(errors.ts 머리 주석의 「오류 줄 억제」).

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { collectStages, collectWorkers, idleNotices, markScreen, readRecords, stageNotices, tailHash } from '../../lib/movement.ts'
import type { ScreenMark } from '../../lib/movement.ts'
import { makeParent, pathOf } from '../../lib/paths.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { backgroundWork } from '../../lib/screen.ts'
import { worktreePaths } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine, rowsOf } from './shared.ts'
import type { CiEntry, Lookup, Prs, Waiting } from './shared.ts'

// 머리 주석의 「움직임 확인」. tails 는 멈춤 확인이 이번 틱에 읽은 dispatch 마다의 화면 끝 줄이다. 결과는 errors 의 movement 에 둘 이유다
function watchMovement(
  ctx: Context,
  lookup: Lookup,
  tails: Map<string, string[]>,
  waiting: Map<string, Waiting>,
  prs: Prs,
  ci: Record<string, CiEntry> | undefined,
  primary: string | null,
): string | null {
  const settings = ctx.movement
  if (settings.idleMin === 0 && !settings.exited) return null
  const file = join(pathOf('state', ctx.repo), 'movement.json')
  let parsed: unknown = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 없거나 깨졌으면 빈 기록이다
  }
  const previous = readRecords(parsed)
  const now = Date.now()
  const screens: Record<string, ScreenMark> = { ...previous.screens }
  for (const [dispatch, tail] of tails) screens[dispatch] = markScreen(previous.screens[dispatch], tailHash(tail), now, backgroundWork(tail))
  lookup.paths ??= worktreePaths(ctx.repo)
  const branchOf = new Map([...lookup.paths].map(([branch, path]) => [path, branch]))
  // CI 를 통과한 내 열린 PR 의 브랜치. 이번 틱의 판정이 지금 HEAD 의 것일 때만 센다
  const passed = new Set(prs.ok ? prs.mine.filter((pr) => ci?.[String(pr.number)]?.state === 'passed' && ci[String(pr.number)].head === pr.head).map((pr) => pr.branch) : [])
  const waitingOf = (run: string, row: Record<string, unknown>, worktree: string | null): string | null => {
    const asked = waiting.get(run)
    // 질문을 읽지 못한 Run 은 질문을 기다리는지 모른다. 모르는 것을 멈춤으로 알리지 않는다
    if (!asked) return '질문을 읽지 못했다'
    if (asked.dispatches.has(String(row.dispatchId)) || asked.terminals.has(String(row.agentTerminalHandle ?? ''))) return '질문의 답을 기다린다'
    const branch = worktree ? branchOf.get(worktree) : undefined
    return branch && passed.has(branch) ? 'CI 를 통과해 머지를 기다린다' : null
  }
  const runs = lookup.runs.map((entry) => entry.run).filter((run): run is string => Boolean(run))
  const workers = collectWorkers({ runs, rowsOf: (run) => rowsOf(run, lookup), settings, now, screens, waiting: waitingOf })
  // 화면 기록은 열린 dispatch 의 것만 남긴다. 읽지 못한 Run 이 있으면 그 Run 의 dispatch 를 몰라 모두 둔다
  if (workers.errors.size === 0) {
    const open = new Set(workers.verdicts.map((v) => v.dispatch))
    for (const dispatch of Object.keys(screens)) if (!open.has(dispatch)) delete screens[dispatch]
  }
  const idle = idleNotices(previous.workers, workers.verdicts, workers.read)
  for (const v of idle.fire) {
    const text = `${v.dispatch} ${v.reason} ${v.idleMin ?? '-'}분 ${v.worktree ? basename(v.worktree) : '-'} ${v.terminal || '-'}`
    log(`WORKER-IDLE ${text}`)
    try {
      sendNotice('WORKER-IDLE', null, text, v.run)
    } catch (e) {
      if (previous.workers[v.dispatch]) idle.records[v.dispatch] = previous.workers[v.dispatch]
      else delete idle.records[v.dispatch]
      log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
    }
  }
  // 멈춘 단계는 모든 Run 의 worker 목록을 읽은 틱에만 본다. 하나라도 못 읽으면 살아 있는 worker 를 몰라 앞 기록을 그대로 둔다
  let stages = previous.stages
  let error: string | null = null
  if (workers.errors.size === 0) {
    try {
      const found = stageNotices(previous.stages, collectStages(ctx.repo, workers.live, settings, now), now, settings.idleMin)
      stages = found.records
      for (const stage of found.fire) {
        const text = `${stage.id} ${stage.worktree ?? stage.branch ?? '-'} ${stage.minutes}분 ${stage.step}`
        log(`STAGE-STALLED ${text}`)
        try {
          sendNotice('STAGE-STALLED', null, text, primary, ctx.repo)
        } catch (e) {
          found.records[stage.id].fired = false
          log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
        }
      }
    } catch (e) {
      error = `보드를 읽지 못했다: ${oneLine(e)}`
    }
  }
  try {
    makeParent(file, ctx.repo)
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ screens, workers: idle.records, stages })}\n`)
    renameSync(`${file}.tmp`, file)
  } catch (e) {
    error = [error, `${file} 에 쓰지 못했다: ${oneLine(e)}`].filter(Boolean).join('; ')
  }
  return error
}

export async function checkMovement(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { lookup, primary } = ctx
  const { tails, waiting, prs, ci } = state
  const { report, errors } = reporter(ctx)
  // 6-1. 움직임 확인. 멈춤 확인이 읽은 화면과 워크트리, 커밋, 보드로 오래 움직이지 않은 worker 와 worker 없이 멈춘 단계를 알린다
  try {
    report('movement', watchMovement(ctx, lookup, tails, waiting, prs, ci, primary))
  } catch (e) {
    report('movement', `움직임 확인을 하지 못했다: ${oneLine(e)}`)
  }
  return { errors }
}
