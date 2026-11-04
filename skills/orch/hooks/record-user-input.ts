// UserPromptSubmit hook: 사용자가 이 Orca 터미널에 입력한 시각을 남긴다. 판정과 기록 위치는 scripts/lib/user-active.ts 가 소유한다.
//
// 상주 루프는 이 기록으로 코디네이터가 사용자와 대화 중인지 보고, 그동안 대기 없음 알림과 decision-pending 전달을 미룬다.
// Orca 터미널이 아니면(ORCA_TERMINAL_HANDLE 이 없으면) 쓰지 않는다. orch 가 넣은 자동 입력도 쓰지 않는다.
//
// 입력은 stdin 의 hook JSON 이다(prompt). 무엇이 실패해도 출력 없이 0 으로 끝난다. 입력을 막지 않는다.

import { readFileSync } from 'node:fs'
import { recordInput } from '../scripts/lib/user-active.ts'

try {
  const data = JSON.parse(readFileSync(0, 'utf8')) as { prompt?: unknown }
  recordInput(process.env.ORCA_TERMINAL_HANDLE, typeof data.prompt === 'string' ? data.prompt : '')
} catch {
  // 기록하지 못하면 대화 중이 아닌 것으로 보일 뿐이다(예전 동작)
}
