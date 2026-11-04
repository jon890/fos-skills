// 환경 변수로 바꿀 수 있는 대기 시간의 한 벌이다.
// 운영은 기본값으로 돌고, 테스트는 짧은 값을 넣어 실제 시간 제한을 기다리지 않는다.
// 부를 때마다 읽으므로 같은 프로세스에서 import 한 테스트도 process.env 를 바꿔 쓸 수 있다.
//
//   ORCH_KILL_GRACE_SEC            TERM 뒤 KILL 을 보내기까지의 유예. 기본 10초. lib/proc.ts, lib/events.ts
//   ORCH_QUESTIONS_TIMEOUT_SEC     질문 조회에서 orca 호출 한 번의 시간 제한. 기본 30초. lib/questions.ts
//   ORCH_LOOP_ALIVE_SEC            루프 생존 타이머 간격. 기본 30초. lib/loop.ts
//   ORCH_LOOP_RECHECK_MARGIN_SEC   루프 생존을 다시 보기 전에 간격에 더하는 여유. 기본 5초. lib/loop.ts

// 양수 초를 담은 환경 변수를 ms 로 읽는다. 없거나 양수가 아니면 기본값이다.
export function envMs(name: string, defaultSec: number): number {
  const raw = Number(process.env[name])
  return (Number.isFinite(raw) && raw > 0 ? raw : defaultSec) * 1000
}

export function killGraceMs(): number {
  return envMs('ORCH_KILL_GRACE_SEC', 10)
}
