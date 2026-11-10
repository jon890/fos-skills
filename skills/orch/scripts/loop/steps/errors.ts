// 틱의 오류 이유를 출처마다 기록하고, 이유가 바뀔 때만 Run 에 알린다. 단계는 reporter 로 기록기를 만들어 쓰고 모은 이유를 결과로 돌려준다.
//
// 오류 줄 억제: errors 는 출처마다 마지막 오류 이유다. Run 마다 도는 출처(questions, cleanup, hook, stalls)는 `<출처>@<Run>` 키다
//     (Run 없는 한 칸이면 출처 이름 그대로). 주 Run 이 바뀌어도 다른 Run 의 이전 값과 비교하지 않게 하려는 것이다.
//     공유 출처(SHARED_SOURCES: prs, board, ci, merged, movement, auto-merge, conflicts, refresh, queue-turn, tick, heavy-slot)는 `<출처>@<주 Run>` 키다. 알림이 주 Run 에 가므로, 주 Run 이 바뀌면
//     진행 중인 실패가 새 주 Run 에 한 번 가야 한다. 출처 이름만 키로 두면 앞 주 Run 이 받은 값에 막혀 새 주 Run 에 오지 않는다.
//     부모는 등록에서 빠진 Run 의 키, 주 Run 이 아닌 Run 의 공유 키, 주 Run 이 있을 때의 `@` 없는 공유 키(Run 없던 루프나 옛 루프가
//     남긴 값)를 지운다. 다시 등록된 Run 의 첫 실패가 지난 값에 막히지 않게 한다. 출처는 questions(질문 조회), cleanup(정리 명령이 0 이 아닌 종료),
//     board(보드 동기화가 0 이 아닌 종료), prs(열린 PR 조회), ci(필수 체크 규칙 조회), hook(tick 핸들러), stalls(멈춤 확인의 worker 목록과 화면 읽기), movement(움직임 확인의 보드 읽기와 기록 쓰기), auto-merge(자동 머지), conflicts(충돌 처리), refresh(최신화), queue-turn(큐 기록),
//     tick(틱 자식이 0 이 아니거나 결과 줄 없이 끝남), heavy-slot(자리 보유 확인. 알림의 kind 는 HEAVY-SLOT-HELD)이다.
//     tick 만 부모가 판정한다. 출처의 이유가 이전과 다를 때만 Run 에 Orca 메시지로 쓴다. hook 은 `HOOK-FAIL tick <종료 코드, timeout, lock>`,
//     나머지는 `WATCH-ERROR <출처>: <이유>` 다. 메시지 본문은 이 줄에서 kind 를 뺀 나머지(`tick 1`, `questions: offline`)다.
//     한 번 성공하면 이유를 지우고, 다시 실패하면 다시 쓴다. loop.log 에는 실패할 때마다 쓴다.
//     하네스는 백그라운드 명령의 stderr 를 알리지 않으므로 실패도 Run 메시지로 보낸다. 틱마다 같은 실패로 코디네이터를 깨우지 않으려고 억제한다.
//     Run 메시지의 HOOK-FAIL 은 tick 핸들러의 것만이다. worker-question 핸들러의 실패는 loop.log 의 HOOK-FAIL 줄로만 남는다.

import { markStreakSent, watchStreak } from '../../lib/notice-digest.ts'
import { sendNotice } from '../../lib/run-notice.ts'
import type { StepContext } from './context.ts'
import { log, oneLine } from './shared.ts'

// 저장소 공유 일의 오류 출처. 알림이 주 Run 에 가므로 키에 주 Run 을 붙인다(머리 주석의 「오류 줄 억제」)
const SHARED_SOURCES: ReadonlySet<string> = new Set(['prs', 'board', 'ci', 'merged', 'movement', 'auto-merge', 'conflicts', 'refresh', 'queue-turn', 'tick', 'heavy-slot'])

// 지난 오류 키를 지운다(머리 주석의 「오류 줄 억제」). runs 는 등록된 Run, primary 는 주 Run 이다
export function dropStaleErrors(errors: Record<string, string | null>, runs: string[], primary: string | null): void {
  for (const key of Object.keys(errors)) {
    const at = key.indexOf('@')
    const source = at > 0 ? key.slice(0, at) : key
    const run = at > 0 ? key.slice(at + 1) : null
    if (run !== null && !runs.includes(run)) delete errors[key]
    else if (SHARED_SOURCES.has(source) && primary && run !== primary) delete errors[key]
  }
}

export type Report = (source: string, reason: string | null, opts?: { run?: string | null; kind?: string; text?: string; logged?: boolean }) => void

// 단계 하나가 쓰는 기록기. report 는 그 자리에서 로그와 알림을 내고, errors 는 그 단계가 결과로 돌려줄 오류 이유다.
// 출처 하나는 단계 하나만 쓴다. 그래서 단계 결과를 차례로 합친 errors 의 키 순서가 기록한 순서와 같다
export function reporter(ctx: StepContext): { report: Report; errors: Record<string, string | null> } {
  const { primary, previous } = ctx
  const errors: Record<string, string | null> = {}
  // errors 키는 `<출처>@<Run>` 이다. 공유 출처는 주 Run 이 Run 이다. Run 없는 한 칸이면 출처 이름 그대로다(머리 주석의 「오류 줄 억제」)
  const keyOf = (source: string, run: string | null) => (run ? `${source}@${run}` : source)
  // 출처의 실패를 기록한다. 이유가 이전과 다를 때만 그 Run 에 Orca 메시지로 쓴다(머리 주석의 「오류 줄 억제」).
  // 로그 줄은 `<kind> <text>` 이고 메시지 본문은 kind 를 뺀 나머지다. logged 면 그 줄은 이미 stdout 에 나갔다(fire 의 HOOK-FAIL 줄)
  const report = (source: string, reason: string | null, opts: { run?: string | null; kind?: string; text?: string; logged?: boolean } = {}) => {
    const run = opts.run === undefined ? primary : opts.run
    const key = keyOf(source, run)
    const kind = opts.kind ?? 'WATCH-ERROR'
    const text = opts.text ?? `${source}: ${reason}`
    // 같은 WATCH-ERROR 가 연속 세 틱 넘게 이어지면 모으지 않고 바로 보낸다(lib/notice-digest.ts)
    const streak = kind === 'WATCH-ERROR' && run ? watchStreak(ctx.repo, key, reason) : false
    if (reason === null) { errors[key] = null; return }
    errors[key] = previous[key] === reason ? reason : null
    if (!opts.logged) log(`${kind} ${text}`)
    if (previous[key] === reason && !streak) return
    try {
      sendNotice(kind, null, text, run, ctx.repo, streak)
      if (streak) markStreakSent(ctx.repo, key)
      errors[key] = reason
    } catch (e) {
      log(`orch-loop: Orca 알림을 보내지 못했다: ${oneLine(e)}`)
    }
  }
  return { report, errors }
}
