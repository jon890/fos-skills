// 멈춤 확인: 맡은 Run 마다 그 Run 의 worker-list(shared.ts 머리 주석의 「worker 찾기」 와 같은 조회)에서 살아 있는 dispatch(LIVE_DISPATCH)의 터미널 화면을
//     `orca terminal read --screen` 으로 읽고 lib/screen.ts 의 readScreen 으로 판정한다. 등록되지 않은 Run 의 worker 화면은 읽지 않는다.
//     구조화 worker(터미널 handle 이 structworker_ 로 시작하거나 startOptions.mode.mode 가 structured)는 화면이 없어 읽지 않는다.
//     `orca orchestration worker-show` 의 worker.stage 와 worker.lastError 로 판정한다(lib/sessions.ts 의 structuredScreen).
//     lastError 가 있으면 error 멈춤이고, 한도 문구면 사용 한도다. 움직임 확인에 넘길 화면은 없다. worker-show 를 읽지 못하면 화면을 읽지 못한 것과 같다.
//     입력하지 않는다. 다시 시도시키는 일과 그 횟수 상한은 저장소의 worker-stalled 핸들러가 정한다(references/hooks.md, ADR-013).
//     사용 한도 화면은 stall_ticks 와 무관하게 dispatch 마다 WORKER-LIMITED 알림을 한 번 쓴다. 터미널 worker 는 사용자에게 계정 전환을 요청한 뒤
//     `orch worker resume --dispatch <id>` 를 부르고, 바꿀 계정이 없거나 resume 이 실패하면 agent-selection.md 의 한도 복구로 가라고 안내한다.
//     구조화 worker 는 resume 대상이 아니라 agent-selection.md 의 한도 복구만 안내한다. 루프는 입력하지 않는다.
//     멈춤은 error(모델 오류로 멈춘 화면)와 idle(입력란이 빈 화면)이다. pipeline.stall_ticks 가 상태마다 기준 틱 수를 정하고, 0 이면 보지 않는다.
//     interrupted(사람이 Esc 로 끊은 화면)는 멈춤이 아니다. 사람이 일부러 멈춘 작업을 핸들러가 다시 돌리지 않게 한다.
//     기본은 error 2, idle 0 이다. idle 은 백그라운드 에이전트를 기다리는 정상 화면과 구분되지 않아 기본으로 끈다.
//     idle 을 켜도 그 dispatch(또는 그 터미널)가 보낸 미답변 질문(질문 확인의 poll 이 본 question, escalation)이 있으면 세지 않는다.
//     화면에 백그라운드 작업 표시(lib/screen.ts 의 backgroundWork)가 있는 idle 도 세지 않는다. 그 작업이 끝나면 하네스가 worker 를 깨운다.
//     그 Run 의 질문을 읽지 못한 틱은 질문을 기다리는지 모르므로 idle 항목을 세지도 지우지도 않는다.
//     멈춤 항목(loop.json 의 stalls[<dispatch>]): run, terminal, state, hash(lib/screen.ts 의 stallHash), errors(그 멈춤에서 본 가장 많은
//     오류 줄 수), since(그 상태를 처음 본 틱의 ISO 8601 UTC 시각), ticks(같은 상태와 같은 hash 를 본 틱 수. 핸들러가 처리한 뒤로 다시 센다),
//     fired(코디네이터에게 알렸는지), limitedNotified(선택. 이 dispatch 의 사용 한도를 이미 알렸는지).
//     한도 알림을 쓰지 못하면 다음 틱에 다시 시도한다.
//     사용 한도를 알린 뒤에는 회복한 화면에서도 limitedNotified 를 보존한다. 일반 멈춤이 없으면 state=limited 인 항목으로 기록만 둔다.
//     입력란 아래 상태 줄(경과 시간, 컨텍스트 사용량)은 hash 에 들지 않아 그 줄만 바뀐 화면은 같은 멈춤이다.
//     상태나 터미널이 바뀌면 새 항목이다. 같은 상태에서 hash 만 바뀌면 since 는 두고 ticks 1 로 다시 센다.
//     fired 는 오류 줄 수가 errors 보다 늘 때만 false 로 되돌린다. 코디네이터가 이어 가게 한 worker 가 같은 오류로 다시 끝나면
//     화면에 오류 줄이 늘어 다시 알린다. 창 크기가 바뀌어 오류 줄이 화면 위로 밀려났다 돌아온 화면은 같은 멈춤을 다시 알리지 않는다.
//     처음 본 창보다 크게 늘려 밀려나 있던 오류 줄이 보이면 늘어난 것과 구분하지 못해 다시 알린다.
//     ticks 가 기준에 닿은 틱에 worker-stalled 를 그 Run 으로 낸다.
//     핸들러가 0 으로 끝나면(pass) Run 메시지를 보내지 않고 ticks 를 0 으로 되돌린다. 다시 시도시킨 worker 의 화면이 그대로면 hash 가 같다.
//     그래서 같은 화면이 기준 틱 수만큼 더 이어지면 핸들러를 다시 부른다. 횟수 상한은 핸들러가 since 로 센다.
//     핸들러가 없거나 0 이 아니면(10 은 넘김이다) 그 Run 에 Orca 메시지로 WORKER-STALLED 를 쓰고 fired 를 true 로 둔다. 같은 hash 가 이어지는 동안 다시 내지 않는다.
//     text 는 `<dispatch> <state> <ticks>틱 <terminal>` 이다.
//     작업 중이거나 멈춤이 아니면 일반 멈춤 항목은 빠지되 한도 알림 기록은 남긴다. dispatch 가 끝났거나 등록에서 빠진 Run 의 항목은 결과에서 빠진다.
//     worker-list 를 읽지 못한 Run 의 항목과 화면을 읽지 못한 dispatch 의 항목은 그대로 옮기고, 그 Run 의 errors 의 stalls@<Run> 에 이유를 둔다.
//     같은 틱에 그 Run 의 질문 확인도 실패했으면 stalls@<Run> 은 로그에만 쓰고 비워 둔다. Orca 가 꺼진 틱에 같은 원인으로 두 번 깨우지 않는다.
//     멈춤 확인 전체가 예외로 끝나면 주 Run 의 stalls 키에 이유를 둔다.

import { isObject } from '../../core/json.ts'
import { orchWord } from '../../lib/commands.ts'
import { fire } from '../../lib/events.ts'
import { defaultBase } from '../../lib/git.ts'
import { orcaJson } from '../../lib/orca.ts'
import { shQuote } from '../../lib/py.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import { backgroundWork, readScreen, screenLines, screenTail, stallHash } from '../../lib/screen.ts'
import { isStructured, limitedScreen, structuredScreen } from '../../lib/sessions.ts'
import { recordWorkerLimited } from '../../lib/worker-limited.ts'
import { LIVE_DISPATCH } from '../../lib/workers.ts'
import type { Context, StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { iso, log, oneLine, rowsOf, stallEntries } from './shared.ts'
import type { Lookup, Stall, StallState, Waiting } from './shared.ts'

// 머리 주석의 「멈춤 확인」. stalls 는 결과 줄에 담을 값, errors 는 Run 마다 errors 의 stalls@<Run> 에 둘 이유다
async function watchStalls(
  ctx: Context,
  lookup: Lookup,
  previous: Record<string, Stall>,
  waiting: Map<string, Waiting>,
  base: string,
  tails: Map<string, string[]> = new Map(),
): Promise<{ stalls: Record<string, Stall>; errors: Map<string, string | null> }> {
  const stalls: Record<string, Stall> = {}
  const errors = new Map<string, string | null>()
  const keep = (dispatch: string) => {
    if (previous[dispatch]) stalls[dispatch] = previous[dispatch]
  }
  for (const { run } of lookup.runs) {
    if (!run) continue
    const rows = rowsOf(run, lookup)
    if (!rows.ok) {
      // 읽지 못한 Run 의 멈춤은 그대로 둔다. 다음 틱이 이어서 센다
      for (const [dispatch, entry] of Object.entries(previous)) if (entry.run === run) keep(dispatch)
      errors.set(run, `worker 목록을 읽지 못했다: ${oneLine(rows.error)}`)
      continue
    }
    const failed: string[] = []
    for (const row of rows.rows) {
      const dispatch = String(row.dispatchId ?? '')
      const terminal = String(row.agentTerminalHandle ?? '')
      if (!dispatch || !terminal || !LIVE_DISPATCH.has(String(row.dispatchStatus))) continue
      let lines: string[]
      let limited: boolean
      let screen: ReturnType<typeof readScreen>
      if (isStructured(terminal, row.startOptions)) {
        // 구조화 worker 는 화면이 없다. worker-show 의 단계와 마지막 오류로 판정한다(lib/sessions.ts 의 structuredScreen)
        const shown = orcaJson<Record<string, unknown>>(['orchestration', 'worker-show', '--dispatch', dispatch])
        if (!shown.ok || !isObject(shown.data)) {
          keep(dispatch)
          failed.push(`${dispatch} worker-show 를 읽지 못했다: ${oneLine(shown.ok ? '결과가 객체가 아니다' : shown.error)}`)
          continue
        }
        ;({ lines, limited, screen } = structuredScreen(shown.data))
      } else {
        const read = orcaJson<Record<string, unknown>>(['terminal', 'read', '--terminal', terminal, '--screen'])
        if (!read.ok || !isObject(read.data)) {
          keep(dispatch)
          failed.push(`${terminal} 화면을 읽지 못했다: ${oneLine(read.ok ? '결과가 객체가 아니다' : read.error)}`)
          continue
        }
        lines = screenLines(read.data)
        // 움직임 확인이 화면이 바뀌었는지 본다. 화면을 두 번 읽지 않으려고 여기서 넘긴다
        tails.set(dispatch, screenTail(lines))
        limited = limitedScreen(lines)
        screen = readScreen(lines)
      }
      // 사용 한도는 설정과 관계없이 dispatch 생애에 한 번 알린다. 회복한 화면에서도 기록을 유지한다.
      let limitedNotified = previous[dispatch]?.limitedNotified === true
      if (limited && !limitedNotified) {
        // 터미널 worker 는 계정을 바꾼 뒤 resume 으로 같은 세션을 잇는다. 구조화 worker 는 터미널이 없어 resume 대상이 아니다
        const text = isStructured(terminal, row.startOptions)
          ? `사용 한도 ${dispatch} ${terminal}: references/agent-selection.md 의 「사용 한도에 걸렸을 때」에 따라 제공자나 모델을 바꿔 이어받는다`
          : `사용 한도 ${dispatch} ${terminal}: 사용자에게 계정 전환을 요청하고, 바꾼 뒤 ${orchWord()} worker resume --dispatch ${shQuote(dispatch)}. resume 이 실패하면 출력의 NEXT 를 먼저 따르고, 바꿀 계정이 없거나 그래도 안 되면 references/agent-selection.md 의 「사용 한도에 걸렸을 때」`
        try {
          const projection = isObject(row.projection) ? row.projection : {}
          const provider = isObject(projection.provider) && typeof projection.provider.id === 'string' ? projection.provider.id.trim() : ''
          sendNotice('WORKER-LIMITED', null, text, run)
          if (provider) recordWorkerLimited(Date.now(), { run, provider })
          limitedNotified = true
          log(text)
        } catch (e) {
          log(`orch-loop: 사용 한도 알림을 쓰지 못했다: ${oneLine(e)}`)
        }
      }
      // 정상 화면으로 돌아와도 한도 알림 기록은 두되 일반 오류 감시는 계속한다.
      if (limited || limitedNotified) {
        stalls[dispatch] = { run, terminal, state: 'limited', hash: '', errors: 0, since: iso(), ticks: 0, fired: limitedNotified, limitedNotified }
      }
      if (limited) continue
      if (screen.state !== 'error' && screen.state !== 'idle') continue
      const state: StallState = screen.state
      const limit = ctx.stallTicks[state]
      if (limit === 0) continue
      if (state === 'idle') {
        const asked = waiting.get(run) ?? null
        // 질문을 읽지 못했으면 질문을 기다리는지 모른다. 세지도 지우지도 않는다
        if (asked === null) {
          keep(dispatch)
          continue
        }
        if (asked.dispatches.has(dispatch) || asked.terminals.has(terminal)) continue
        // 백그라운드 셸이나 모니터를 기다리는 빈 입력란이다. 끝나면 하네스가 턴을 깨운다(lib/screen.ts 의 「백그라운드 작업」)
        if (backgroundWork(lines)) continue
      }
      const hash = stallHash(screen)
      const before = previous[dispatch]
      const continued = before && before.state === state && before.terminal === terminal
      // 화면만 바뀐 멈춤(다시 시도한 worker 가 같은 오류로 끝남)은 since 를 두고 새 멈춤으로 센다. 핸들러가 since 로 횟수를 센다.
      // 알린 뒤 다시 알리는 것은 오류 줄 수가 이제까지 본 수보다 늘 때뿐이다. 창 크기가 바뀌어 줄 수가 줄거나 되돌아온 화면은 같은 멈춤이다
      const grew = continued && screen.errors > before.errors
      const entry: Stall = !continued
        ? { run, terminal, state, hash, errors: screen.errors, since: iso(), ticks: 1, fired: false }
        : before.hash === hash
          ? { ...before, run, ticks: before.ticks + 1 }
          : { ...before, run, hash, errors: Math.max(before.errors, screen.errors), ticks: 1, fired: before.fired && !grew }
      if (limitedNotified) entry.limitedNotified = true
      stalls[dispatch] = entry
      if (entry.ticks < limit || entry.fired) continue
      const notified = await notifyStall(ctx, run, row, entry, screenTail(lines), base)
      if (notified === true) {
        // 핸들러가 처리했다. 다시 시도한 뒤에도 화면이 그대로면 해시가 같으므로, 처음부터 다시 세 핸들러를 다시 부른다
        entry.ticks = 0
      } else if (notified === false) {
        entry.fired = true
      }
    }
    errors.set(run, failed.length > 0 ? failed.join('; ') : null)
  }
  return { stalls, errors }
}

// worker-stalled 를 내고, 핸들러가 0 으로 끝나지 않았으면 그 Run 에 Orca 메시지로 WORKER-STALLED 를 쓴다(머리 주석의 「멈춤 확인」).
// 핸들러가 0 으로 끝났으면 true 다
async function notifyStall(ctx: Context, run: string, row: Record<string, unknown>, entry: Stall, lines: string[], base: string): Promise<boolean | null> {
  const dispatch = String(row.dispatchId)
  const resource = isObject(row.resource) ? row.resource : {}
  const id = String(resource.worktreeId ?? '')
  const worktree = id.includes('::') ? id.slice(id.indexOf('::') + 2) : null
  const text = `${dispatch} ${entry.state} ${entry.ticks}틱 ${entry.terminal}`
  log(`WORKER-STALLED ${text}`)
  let handled = false
  try {
    const fired = await fire(
      'worker-stalled',
      {
        worker: { task: row.taskId ?? null, dispatch, terminal: entry.terminal, worktree, spec: null },
        state: entry.state,
        since: entry.since,
        ticks: entry.ticks,
        lines,
      },
      { repo: ctx.repo, base, run },
    )
    handled = fired.result === 'pass'
  } catch (e) {
    log(`orch-loop: worker-stalled 를 내지 못했다: ${oneLine(e)}`)
  }
  if (handled) return true
  try {
    sendNotice('WORKER-STALLED', null, text, run)
  } catch (e) {
    log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
    entry.fired = false
    return null
  }
  return false
}

export async function checkStalls(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { loaded, lookup, primary } = ctx
  const { waiting } = state
  const { report, errors } = reporter(ctx)
  // 6. 멈춤 확인. Run 마다 그 Run 의 살아 있는 dispatch 화면만 본다. 실패하면 결과에 stalls 를 넣지 않아 부모가 이전 값을 둔다
  const base = defaultBase(ctx.repo) ?? ''
  let stalls: Record<string, Stall> | undefined
  // 움직임 확인(6-1)이 화면이 바뀌었는지 보려고 받는다
  const tails = new Map<string, string[]>()
  try {
    const watched = await watchStalls(ctx, lookup, stallEntries(loaded?.stalls), waiting, base, tails)
    stalls = watched.stalls
    for (const [run, reason] of watched.errors) {
      // 같은 틱에 그 Run 의 질문 확인도 실패했으면(Orca 꺼짐) 그 알림 하나로 둔다. 질문 확인이 살아난 뒤에도 실패하면 그때 알린다
      if (reason !== null && waiting.get(run) === null) {
        log(`WATCH-ERROR stalls: ${reason}`)
        report('stalls', null, { run })
      } else {
        report('stalls', reason, { run })
      }
    }
    // Run 없는 루프는 위에서 키를 쓰지 않는다. 아래 catch 가 남긴 이유를 지운다
    if (!primary) report('stalls', null)
  } catch (e) {
    // 조용히 멈춤 확인을 잃지 않게 주 Run 에 알린다
    report('stalls', `멈춤 확인을 하지 못했다: ${oneLine(e)}`)
  }
  return { errors, base, ...(stalls ? { stalls } : {}), tails }
}
