# Phase 01. 정리 단계 분리

**Execution profile**: standard

## 목표

정리 단계마다 파일을 나누어 한 단계를 고칠 때 읽을 범위를 줄인다.

**범위 외**: 루프, 머지 큐, core 의 규칙 변경, 테스트 기대값과 golden 기록 변경.

## 컨텍스트

**요구사항**: REQ12, REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md` 의 「단계 파일」과 「동작 같음 확인」.

`cleanup-sweep.ts` 의 `sweepRepo` 가 워크트리, 로컬 브랜치, 리뷰, 남은 지시서, 원격 브랜치, 옛 상태, 큐 로그, PR 캐시, Docker 순으로 실행한다. `main`, `reportError`, `sweepLine`, `Host`, `waitFree`, `stopHolders` 는 기존 경로에서 계속 내보낸다. `PrLookup` 캐시와 반납한 dispatch 집합은 기존 수명을 유지한다. 기존 lib 호출의 로그와 파일 쓰기는 범위 안이며 시점과 순서를 바꾸지 않는다.

## 의도 메모

- 단계가 쓰는 도우미는 cleanup 아래에 두고 lib 의 외부 호출과 core 의 순수 함수를 재사용한다. 순수 규칙을 새로 만들지 않는다.
- 범용 단계 실행기나 플러그인 목록을 추가하지 않는다. 본 파일이 구체 단계를 순서대로 호출하고 결과를 합친다.
- 이 PR 의 파일 수는 같은 정리 명령을 나누는 데서 생긴다. 지시서가 정한 PR 하나의 범위를 유지한다.

## 작업 항목

### 1. cleanup-sweep.ts 와 단계 모듈

본 파일에는 옵션 준비와 단계 호출, 종료 코드 집계만 둔다. 옵션 처리와 짧은 출력 변환은 cli.ts 와 output.ts 로, 공통 타입과 외부 호출은 shared.ts 로 옮긴다. 프로세스·터미널·PR 조회 도우미는 각각 processes.ts, terminals.ts, prs.ts 로 옮긴다. 단계는 `StepContext`, `StepState` 를 받고 변경한 상태 조각과 종료 코드를 `StepResult` 로 반환한다. 결과의 report 와 remaining 을 다음 단계에 전달한다. 단계별 설명은 해당 파일로 옮기고 기존 공개 API 는 재수출한다.

함수와 상태의 소유 위치는 다음과 같다.

| 파일 | 옮길 함수와 책임 |
|---|---|
| shared.ts | Args, Json, Pr, Log, Report, RepoError, truthy, resourceOf, lines, run, git, worktrees, under, readText, err |
| prs.ts | lookupOf, prList 부터 unpushed 까지 PR 조회, protectedReason, remotePlan, deleteRemote, ownersOf, ownPr, hasCommit; lookups 는 모듈 수명 유지 |
| processes.ts | Host, REAL_HOST, holderPids, sessionEndHooks, onlyIdleShells, waitFree, stopHolders 와 프로세스 도우미 |
| terminals.ts | orcaResult 부터 closeTerminals, foreignHandles, foreignAt, workersAt, emptyShells, takenOverOwn, launchedOwn, closeForClosedPr, releaseDispatches; released 는 모듈 수명 유지 |
| cli.ts, output.ts | 옵션 준비와 worker 스냅샷, sweepLine 과 짧은 출력 집계 |
| steps/prepare.ts | sweepRepo 앞부분의 기준 브랜치·fetch·prune·owners·routing·PR 미리 읽기; report 와 listed 생성 |
| steps/worktrees.ts | sweepWorktree 와 detached/review 워크트리, noPrBlocker, closedOwnTerminals, prInput, workerInput; report 갱신 뒤 remaining 새로 읽기 |
| steps/branches.ts | sweepBranches |
| steps/reviews.ts | sweepReviews, reviewBranchGuard, reviewBranchKept |
| steps/specs.ts | sweepStaleSpecs, specsKept, deleteSpecFiles, trashLaunchedSpecs |
| steps/remote-branches.ts | sweepRemoteBranches 와 원격 조회 도우미 |
| steps/state.ts | migrateLegacyNotices → sweepQueueLogs → pruneMerged 순서를 유지 |
| steps/docker.ts | sweepDocker |
| cleanup-sweep.ts | 위 순서대로 호출하고 StepResult 의 report, remaining, code 를 합치며 after-cleanup 호출 |

StepContext 는 repo, Args, workers, terminals, log 를 가진다. StepState 는 report, listed, remaining, specsDir, owners, code 를 가진다. StepResult 는 바뀐 StepState 조각이다. owners 조회 실패는 state.code 를 2 로 바꿔 원래 지연 조회 효과를 유지하고 이후 성공 단계로 0 으로 덮지 않는다.

### 2. `skills/orch/tests/cleanup-steps.spec.ts` 와 기존 회귀 테스트 실행

`skills/orch/tests/cleanup-sweep-docker.spec.ts` 의 설명 원본 경로도 갱신한다.

신규 구조 테스트는 단계 모듈에서 단계 함수가 노출되는지 확인하고 진입 파일에 기존 정리 구현이 다시 들어오면 실패한다. 구현 전 기존 파일에서 실패하는지 확인한다.


`skills/orch/tests/cleanup-*.spec.ts` 는 실제 임시 git 저장소와 함수 대역으로 정상 정리, 살아 있는 worker 보호, 조회 실패, 후속 검증, 터미널과 프로세스 보호를 확인한다. `golden.spec.ts` 는 CLI 의 출력·종료 코드·파일 상태를 고정 기록과 비교한다. 기존 기대값은 고치지 않는다. 새 동작이 없어 중복 테스트를 추가하지 않는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/cleanup-*.spec.ts skills/orch/tests/golden.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
git diff --exit-code origin/main HEAD -- skills/orch/tests/golden
node scripts/check-skill-docs.ts
```

모두 종료 코드 0 을 기대한다. 전체 테스트는 PR CI 의 Tests 결과로 확인한다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
|---|---|---|---|---|---|---|
| REQ12 | 단계 분리 구현 완료 | 본 파일과 steps 의 호출 및 import 대조, core-boundary.spec.ts 실행 | 본 파일이 단계 순서와 결과 집계만 소유하고 core 경계 유지 | 로컬 Node 24 이상 | worker | 없음 | PR 전 |
| REQ13 | 기존 golden 기록 유지 | cleanup 회귀 테스트와 golden.spec.ts 실행, origin/main 과 golden diff 확인 | 정상·실패·보호 경로의 출력과 상태가 같고 diff 없음 | 로컬 Node 24 이상 | worker | 없음 | PR 전 |
| REQ13 | PR push | GitHub Tests 결과 확인 | 전체 테스트와 타입 검사 성공 | GitHub CI | worker | push | PR 뒤 |

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/cleanup/cleanup-sweep.ts` | 수정 |
| `skills/orch/scripts/cleanup/cli.ts` | 신규 |
| `skills/orch/scripts/cleanup/output.ts` | 신규 |
| `skills/orch/scripts/cleanup/shared.ts` | 신규 |
| `skills/orch/scripts/cleanup/processes.ts` | 신규 |
| `skills/orch/scripts/cleanup/terminals.ts` | 신규 |
| `skills/orch/scripts/cleanup/prs.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/context.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/prepare.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/worktrees.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/branches.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/reviews.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/specs.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/remote-branches.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/state.ts` | 신규 |
| `skills/orch/scripts/cleanup/steps/docker.ts` | 신규 |
| `skills/orch/changes/cleanup-steps.patch.md` | 신규 |
| `skills/orch/tests/cleanup-steps.spec.ts` | 신규 |
| `skills/orch/references/cleanup.md` | 수정 (설명 원본 경로 갱신) |
| `skills/orch/tests/cleanup-sweep-docker.spec.ts` | 수정 (파일 맨 위 설명의 참조만 갱신) |
