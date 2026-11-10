// 자리 보유 확인: 무거운 검사 대기열(HEAVY_SLOT_DIR, 없으면 lib/paths.ts 의 heavy-slot)에서 상한(HEAVY_HOLD_MAX 초, 기본 1800)보다
//     오래 자리를 쥔 살아 있는 등록을 lib/heavy-hold.ts 의 overHeld 로 찾는다. 있으면 주 Run 에 Orca 메시지로 HEAVY-SLOT-HELD 를 쓴다.
//     text 는 등록마다 `pid <pid> <분>분 <명령줄>` 을 `; ` 로 이은 뒤 ` (상한 <분>분)` 을 붙인 것이다.
//     오류 줄 억제와 같은 규칙으로 errors 의 heavy-slot 에 `<pid>@<held_at>` 목록을 두고, 그 목록이 바뀔 때만 다시 쓴다.
//     같은 검사가 계속 쥐고 있으면 분이 늘어도 다시 깨우지 않는다. 자리를 내놓으면 지우고, 다른 검사가 넘기면 다시 쓴다.
//     알리기만 하고 프로세스를 끊거나 등록을 지우지 않는다. 끊을지는 사용자가 정한다

import { holdMaxSec, overHeld } from '../../lib/heavy-hold.ts'
import { pathOf } from '../../lib/paths.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import { reporter } from './errors.ts'
import { log, oneLine } from './shared.ts'

export async function checkHeavySlot(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { report, errors } = reporter(ctx)
  // 10. 자리 보유 확인. 저장소 공유 일이라 주 Run 에 알린다. 같은 등록 목록이면 다시 쓰지 않는다
  try {
    const maxSec = holdMaxSec()
    const held = overHeld(process.env.HEAVY_SLOT_DIR || pathOf('heavy-slot', ctx.repo), maxSec, Date.now())
    const minutes = (ms: number) => Math.floor(ms / 60_000)
    const text = `${held.map((h) => `pid ${h.pid} ${minutes(Date.now() - h.heldAt)}분 ${h.command}`.trim()).join('; ')} (상한 ${minutes(maxSec * 1000)}분)`
    report('heavy-slot', held.length > 0 ? held.map((h) => `${h.pid}@${h.heldAt}`).join(',') : null, { kind: 'HEAVY-SLOT-HELD', text })
  } catch (e) {
    log(`orch-loop: 무거운 검사 자리를 읽지 못했다: ${oneLine(e)}`)
  }
  return { errors }
}
