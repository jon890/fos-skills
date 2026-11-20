# orch: 끊긴 worker 와 후속 검증 대기의 워크트리를 남기는 기술 설계

스펙: [spec.md](spec.md)

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | `lib/worker-state.ts` 의 새 `heldDispatch` 가 경로의 가장 최근 dispatch 가 끊긴 것인지 정한다. `cleanup/steps/worktrees.ts` 가 삭제 직전 소유 확인에 쓰는 모든 Run 의 행으로 그것을 보고, 터미널 닫기와 dispatch 반납보다 먼저 `남김` 줄을 내고 돌아간다. 워크트리를 남기면 지시서 단계(`steps/specs.ts`)는 브랜치가 남아 있어 그 지시서를 지우지 않는다 |
| REQ2 | `heldDispatch` 는 가장 최근 행만 본다. resume 이나 새 dispatch 가 뜨면 그 행이 가장 앞이라 null 이 되고 지금 판정을 그대로 탄다 |
| REQ3 | `worktrees.ts` 의 `followUpPending` 이 MERGED 기능 PR 의 `featureCompletionProblem` 을 보고, 문제가 있으면 워크트리째 남긴다. 기능 PR 이 아니면 gh 를 부르지 않는다 |
| REQ4 | `failedKind` 가 `error` 면 `heldDispatch` 가 null 이라 지금처럼 정리한다 |
| REQ5 | `orch cleanup sweep --remove-kept <경로>` 가 그 경로만 REQ1·REQ3 의 남김을 넘는다. 그 뒤 커밋 안 된 변경, 원격에 없는 커밋, 살아 있는 worker, 터미널 소유 확인은 그대로다 |
| REQ6 | `doctor/orch-doctor.ts` 의 `checkHeldWorktrees` 가 `KEPT-LOST <경로> <dispatch> <끊긴 시각>` 과 REQ5 의 명령 한 줄을 낸다. 하루는 `HELD_NOTICE_MS` 다 |
| REQ7 | `failedKind` 가 `unknown`(detail 없음, 모르는 값)이면 `heldDispatch` 가 `lost` 처럼 남긴다 |

## 끊김을 알아내는 기록 (DECISION4)

**`worker-list --full` 행의 `projection.stage.detail` 이 `terminal_missing` 이고 `dispatchStatus` 가 `failed` 면 끊김이다.**
정리 도구가 이미 읽는 행이라 조회가 늘지 않는다.

2026-11-20 에 모든 Run(80개)의 행을 모아 확인했다.

| 행의 상태 | 표본 | `worker-show` 의 `lastFailure` | 분류 |
| --- | --- | --- | --- |
| `failed`, `abandoned`, `terminal_missing` | 48 | 모두 `The assigned worker terminal is no longer live after orchestration recovery.` | lost |
| `failed`, `failed`, `process_exited` | 74 | `Terminal closed by operator request` 68건, `Agent process ended; this host cannot report why` 6건 | error |
| `failed`, `failed`, `settled` | 22 | worker 가 `--outcome failed` 로 보고 | error |
| `failed`, `stopped`, `process_stopped` | 43 | `stopped` | error |
| `failed`, `abandoned`, `abandoned` | 31 | 버림 | error |
| `failed`, `failed`, `agent_readiness` 와 `dispatch_input` | 38 | 띄우기 실패 | error |

ai-analysis 의 16:06(07:06 UTC) 재부팅 표본은 `terminal_missing` 19건으로, 반납 시각이 모두 07:07:47 UTC 다.
같은 때 Run 에는 제목 `Worker lost without reporting`, payload `stopReason: lost` 인 멈춤 보고 10건이 왔다.
멈춤 보고는 메시지함을 따로 읽어야 하고 오래된 메시지는 목록에서 밀려나므로 쓰지 않았다.
`lastFailure` 문구는 `worker-show` 를 dispatch 마다 불러야 해서 쓰지 않았다.

끊긴 시각은 행의 `resource.releaseCompletedAt`(없으면 `releaseRequestedAt`)이다. Orca 가 복구에서 dispatch 를 닫을 때 같은 시각에 반납한다. 둘 다 없으면 doctor 만 `worker-show` 의 `dispatch.completedAt` 을 읽는다.

## 가장 최근 dispatch

worker-list 는 최신 dispatch 를 먼저 낸다(같은 Task 를 다시 띄운 실측: 성공한 새 dispatch 가 버린 옛 dispatch 앞에 왔다). resume 도 같은 Run 에 잇는다.
Run 사이의 순서는 확인하지 못했다. 그래서 Run 마다 첫 행을 보고 하나라도 끊겼으면 남긴다. 잘못 고르면 지우는 쪽이 아니라 남기는 쪽으로 틀린다.
살아 있지도 끝나지도 않은 마지막 행(dispatched 인데 workerState 가 abandoned 같은 것)도 끊김인지 몰라 남긴다(REQ7).

## 바뀌는 규칙

- 2026-10-30 의 「failed 는 끝남」 은 `judge` 에 그대로 둔다. `heldDispatch` 는 정리 도구와 doctor 만 쓴다. `judge` 를 바꾸면 끊긴 행이 하나라도 있는 경로가 모두 unknown 이 되어 REQ2 를 지키지 못한다.
- 2026-11-04 의 「후속 검증이 대기여도 워크트리와 브랜치는 지운다」 는 DECISION1 로 바뀐다. `references/feature-loop.md`, `references/cleanup.md`, `finish-pr.ts` 머리 주석을 같은 PR 에서 고친다.
- finish-pr 은 정리를 다섯 번까지 되풀이한다. 정리가 일부러 남긴 줄(끊긴 worker, 후속 검증 대기)을 내면 되풀이하지 않고 「정리 남음」 으로 넘어간다. handoff 산출물이 있으면 지금처럼 FINISH-FAIL 로 끝난다.
- 리뷰 워크트리와 저장소 밖 detached 워크트리는 보지 않는다. 브랜치가 없어 다시 만들기 쉽다.
- `docs/flow.md` 의 「워크트리와 브랜치는 머지 직후 지운다」 는 이 PR 의 허락 범위 밖이라 고치지 않았다. 코디네이터에게 알린다.

## 검증

- `skills/orch/tests/cleanup-keep-lost.spec.ts`: 가짜 orca·gh 와 임시 저장소로 REQ1~REQ7 을 본다.
- `skills/orch/tests/cleanup-sweep-merge.spec.ts`: 후속 검증 대기 테스트를 새 결정으로 바꾼다.
- 저장소 검증 명령 `claude plugin test .` 와 `node scripts/run-tests.ts`.
