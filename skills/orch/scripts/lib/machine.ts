// 저장소가 아니라 이 머신의 orch 상태를 두는 폴더다. 루트는 ORCH_MACHINE_DIR, 없으면 `~/.cache/orch` 다.
// 사용처: lib/user-active.ts(user-input/), lib/questions.ts(questions-dismissed.json), hooks/block-worker-terminal-send.ts(send-hook-cache.json).
//
// 터미널 handle 과 메시지 id 는 Orca 전체에서 하나라 저장소마다 나눌 까닭이 없다. 코디네이터 하나가 여러 저장소의 루프에 등록되고,
// 명령을 부른 폴더가 루프의 저장소가 아닐 수도 있다. 하네스의 TMPDIR 은 세션마다 달라 쓰지 않는다.
// 잃어도 되는 값만 둔다. 지워지면 예전 동작(대화 중이 아님, 다시 조회, 다시 알림)으로 돌아갈 뿐이다.

import { homedir } from 'node:os'
import { join } from 'node:path'

export function machineDir(): string {
  return process.env.ORCH_MACHINE_DIR || join(homedir(), '.cache', 'orch')
}
