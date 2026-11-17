# Phase 01. 메인이 아닌 코디네이터의 쓰기를 막는다

**Execution profile**: standard

## 목표

저장소의 메인 외 Run 이 worker 와 머지·정리·보드를 겹쳐 다루지 않게 하고, 기존 worker 의 소유자가 일을 마칠 수 있게 한다.

**범위 외**: 메인 교체, 요청 저장 형식과 제품 결정 변경, 실제 머지.

## 컨텍스트

**요구사항**: REQ11, REQ12, REQ13

**근거 문서**: `docs/features/orch-main-coordinator/spec.md`, `docs/features/orch-main-coordinator/design.md`, `docs/adr/035-orch-main-coordinator.md`.

`lib/main-coordinator.ts` 의 `findMain(repo)` 가 메인·없음·조회 실패를 구분한다. `lib/context.ts` 의 Run 기본값에는 설정 fallback 이 있으므로 호출자 신원으로 쓰지 않는다. 실제 `run-current` 를 읽고, `--run` 으로 메인을 사칭할 수 없게 한다. `lib/launched.ts` 의 `Launch`, `recordLaunch`, `readLaunch`, `launchesAt` 은 worker 소유 기록이고 `lib/run-notice.ts` 의 `notifyRun` 은 메인 알림을 보낸다. `lib/commands.ts` 가 새 명령과 옛 이름을 해석하고 `bin/orch.ts` 가 자식을 실행한다.

정리는 `cleanup/steps/prepare.ts` 등에서 Run 과 관계없이 저장소 전체를 바꾸는 단계가 있으므로 기존 worker 예외로 전체 sweep 을 허용하지 않는다. 해당 worker 워크트리·PR 을 명시한 작업에서 소유를 확인한다. Run 별 sweep 에서 예외를 적용할 때는 그 소유 기록으로 정리 대상을 제한한다.

## 의도 메모

- 제한은 명령 진입점에 둔다. 보드 lib 를 막으면 요청이 양쪽 저장소의 보드를 쓰는 정상 경로까지 막힌다.
- 읽기, `request send`, Run 없는 셸, `/board` 는 통과한다. `--not-main` 은 첫 `--` 앞에서만 해석하고 공백 이유나 다음 옵션을 이유로 받지 않는다.
- 새 띄우기 기록에 메인 확인 여부와 당시 메인이 없었는지 및 우회 이유를 남긴다. 그 표지가 없는 기존 기록은 호환 대상이며 호출 Run 이 띄운 것만 예외로 인정한다.
- 조회 실패와 알림 실패는 성공으로 숨기지 않는다. 우회 이유는 worker 생성 전에 보존하고 알림에 명령과 호출 Run 을 넣는다.

## 작업 항목

### 1. 명령 경계와 쓰기 제한

새 `lib/main-guard.ts` 에 `callerIsMain(repo)` 와 `guardWrite` 를 둔다. 각 스크립트의 옵션 표에 공통 `MAIN_GUARD_OPTIONS` 의 `not-main` 문자열 옵션을 더한다. 실제 파서가 고유 접두와 옵션 값을 해석한 뒤, 도움말이 아닌 쓰기 분기에서 파싱한 repo·reason·dispatch/worktree/PR 을 `guardWrite` 에 넘긴다. 새/옛 CLI 는 같은 실제 스크립트로 가므로 진입점의 이중 검사나 환경 변수 허가 증표를 만들지 않는다. `bin/orch.ts` 는 변경하지 않는다. 다른 Run 이면 메인 Run 과 `orch request send --to <대상 저장소>` 를 출력하고 1 로 끝낸다. 우회 이유 형식 오류는 2, 메인/호출자 조회 실패는 1 이다. Run 조회에서 명시적으로 Run 없음이 확인된 셸은 통과한다.

| 명령 | 검사 분기 | 대상 저장소 | 기존 worker 예외 |
| --- | --- | --- | --- |
| worker launch/worktree | 새 worker·워크트리 생성 | repo 또는 worktree 의 mainCheckout | 새 생성은 없음, 기존 worktree 의 이어 띄우기만 소유 확인 |
| worker send/resume/continue | 전송·재개 전 | worker-show 의 worktree 또는 기록의 worktree, 명시 repo 가 다르면 실제 worktree 우선 | dispatch 와 호출 Run 일치 |
| worker adopt | apply | repo | 없음 |
| queue merge/run/finish | 시작 전 | repo | 모든 PR 의 headRefName 을 launch.branch 와 연결하고 호출 Run 일치 |
| queue ready/conflicts | dry-run 이 아닌 실행 | repo | ready 는 모든 지정 PR, conflicts 는 없음 |
| queue reserve/prune | 예약·정리 전 | repo | 없음 |
| cleanup worktree | 삭제 전 | 지정 worktree 의 mainCheckout | worktree 와 호출 Run 일치 |
| cleanup sweep | apply | 각 repo | run 이 실제 호출 Run 일 때 호환 launch 의 worktree 만, 저장소 전체 단계 생략 |
| cleanup handoff | 설정 포함 실제 apply | repo | 없음 |
| board set/step/add-step/del/sync/release, approval add/cancel/check | 쓰기 전(check 는 사용 처리 기록을 씀) | repo 또는 board 파일의 소유 저장소 | 없음 |
| request accept/hold/reject/done/fail | 답 전 | repo | 없음 |
| status/doctor, board show/get/list/approval list/auto-check, queue gate/overlap 및 ready/conflicts 의 dry-run, worker check/screen, cleanup dry-run, request send/list | 읽기와 기존 요청 경로 | 기존 동작 | 검사하지 않음 |

### 2. 우회와 기존 worker 호환

`Launch` 에 선택 필드 `main_guard`(`version: 1`, `main: string | null`, `caller_repo: string`, `target_repo: string`; 옛 기록에는 필드가 없을 수 있음), `not_main` 을 추가하고 읽기·후속 기록에서도 보존한다. launch 는 caller_repo 에 부른 작업 폴더의 주 checkout, target_repo 에 대상 주 checkout 을 채운다. 기존 worker 또는 `main_guard.main` 이 null 인 worker 는 기록의 Run 이 실제 호출자와 같고 이번 명령의 dispatch/worktree/PR 이 그 기록과 일치할 때 지시·머지·정리를 허용한다. 다른 worker 가 섞인 일괄 명령은 전체를 검사한다. 우회는 DECISION27 대로 `state/launched-workers/not-main/<id>.json` 에 기록한 뒤 메인에게 `notifyRun` 으로 알린다. 전송에 실패하면 기록은 남기고 실제 쓰기는 하지 않는다. 성공한 launch 는 dispatch 기록에도 이유를 남긴다.

### 3. doctor 와 사용자 문서

doctor 는 `registeredRuns(repo)` 와 `findMain(repo)` 로 비메인 등록 Run 을 알린다. `allLaunches(repo)` 로 대상 저장소 띄우기 기록을 전부 읽어 main 과 다른 Run 또는 `main_guard.caller_repo` 가 다른 저장소인 남은 기록의 dispatch·Run·worktree·spec 을 알린다. 끝난 Run 이라도 기록이 남으면 알리고 이미 정리된 기록은 제외한다. `--run` 이 없어도 실행한다. 메인 조회 실패는 `SKIP-MAIN` 으로 알리고 종료 코드는 바꾸지 않는다. 기록 폴더 조회 실패는 `SKIP-MAIN-WORKERS` 다. 테스트는 Run 옵션 없음, 비메인 복수 등록, 끝난 Run 기록, 다른 저장소 소유, 조회 실패를 각각 본다. 명령 사용법·띄우기 기록의 소유 문서와 변경 조각을 갱신한다. `docs-consolidate` 는 스펙·설계와 대조해 공통 후보 유무를 PR 본문에 남긴다.

### 4. 개발 테스트

새 `main-guard.spec.ts` 는 가짜 Orca 와 임시 저장소로 정상 메인, 비메인, Run 없음, 메인 없음, 조회 실패, 명시 Run 사칭, 이유 없는 우회, 이유 기록·알림, 대상 저장소와 기존 worker 예외를 검증한다. 새/옛 CLI 와 직접 스크립트 경로를 실행해 거절 전에 부수 효과가 없음을 확인한다. 기존 launch/send/cleanup/doctor 회귀도 실행한다.

## 검증

```bash
node --test skills/orch/tests/main-guard.spec.ts
node --test skills/orch/tests/core-main-coordinator.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/cleanup-sweep-launched.spec.ts
claude plugin test .
orch slot heavy --exclusive -- node scripts/run-tests.ts
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ11 | 임시 저장소에 메인과 둘째 Run, 가짜 Orca | `node --test skills/orch/tests/main-guard.spec.ts` 에서 쓰기 명령과 읽기·Run 없음·다른 저장소 사례 실행 | 비메인 쓰기는 비정상 코드와 메인 Run·요청 명령, 읽기와 비바인딩 셸은 통과, 거절 시 쓰기 없음 | 로컬 가짜 Orca | worker | 없음 | PR 전 |
| REQ12 | 메인과 비메인 및 전송 로그 | 같은 테스트에서 이유 없음·공백·옵션 값·정상 이유·알림 실패 실행 | 빈 이유 거절, 정상 이유 기록과 메인 알림, 알림 실패를 숨기지 않음 | 로컬 가짜 Orca | worker | 없음 | PR 전 |
| REQ13 | 옛 기록, 메인 없는 시점의 기록, 다른 소유자의 기록과 여러 등록 Run | 같은 테스트와 doctor 회귀에서 지시·PR 머지 경계·정리 경계 및 doctor 알림 실행 | 원래 Run 의 해당 worker 만 예외, 새 worker 와 남의 worker 는 차단, 남은 worker 경로·비메인 등록 알림 | 로컬 가짜 Orca | worker | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/main-guard.ts` | 신규 |
| `skills/orch/tests/main-guard.spec.ts` | 신규 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/continue-worker.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-launched.spec.ts` | 수정 |
| `skills/orch/tests/request.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `skills/orch/tests/queue-gate.spec.ts` | 수정 |
| `skills/orch/scripts/lib/launched.ts` | 수정 |
| `skills/orch/scripts/lib/continue-worker.ts` | 수정 |
| `skills/orch/scripts/worker/*.ts` | 수정 |
| `skills/orch/scripts/queue/*.ts` | 수정 |
| `skills/orch/scripts/queue/steps/*.ts` | 수정 |
| `skills/orch/scripts/cleanup/*.ts` | 수정 |
| `skills/orch/scripts/cleanup/steps/*.ts` | 수정 |
| `skills/orch/scripts/board/*.ts` | 수정 |
| `skills/orch/scripts/request/orch-request.ts` | 수정 |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 |
| `skills/orch/references/*.md` | 수정 |
| `skills/orch/README.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/features/orch-main-coordinator/spec.md` | 수정 |
| `docs/features/orch-main-coordinator/design.md` | 수정 |
| `skills/orch/changes/main-coordinator-guard.minor.md` | 신규 |
