# Phase 01. 보드 경로와 통째 저장 호출자

**Execution profile**: deep

## 목표

orch 호출자가 설정한 보드를 함께 쓰고, 읽은 뒤 바뀐 줄 목록을 덮어쓰지 않는다.

**범위 외**: 새 명령, 머지 판정 변경, 보드 창과 board.ts 직접 호출의 설정 읽기.

## 컨텍스트

**요구사항**: REQ2, REQ11

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md` 의 PR2.
`lib/config.ts` 는 paths 를 읽으므로 새 `lib/board-file.ts` 가 설정을 읽는다.
`board.ts` 의 `linesRev` 와 `set --if-rev` 를 재사용한다. 보드 형식과 기존 명령의 인자 뜻을 보존한다.

## 의도 메모

- 명시 경로, finish.board, 기본 위치 순서로 고른다. 잘못된 설정은 오류로 올린다.
- sync/release 의 명시 경로는 현재 폴더 기준을 유지한다. goal 은 현재 폴더에서 찾는다.
- 지문은 lib 가 계산해 core 에 넘긴다. core 는 work-board 를 import 하지 않는다.
- 설정 읽기의 ConfigError 와 기존 보드 명령의 stderr 를 그대로 전달한다.

## 작업 항목

### 1. 경로 모듈과 호출자

`lib/paths.ts` 의 boardPath 를 `lib/board-file.ts` 로 옮기고 finish.board 를 읽는다. 설계의 호출자 표 전체를 옮긴다.
status 의 경로 계산은 SKIP-BOARD 를 내는 try 안에 둔다. cleanup.board 가 있으면 우선한다.

### 2. 통째 저장과 거절 뒤 처리

core/board.ts 에 명령 묶음의 detail 저장을 마지막 목록 하나로 합쳐 맨 앞에 두고 --if-rev 를 붙이는 순수 함수를 둔다.
sync 와 release 는 거절된 항목의 나머지 명령을 실행하지 않고 다음 항목을 처리한다. sync 는 0, release 는 1 로 끝낸다.
registerBoard 는 중간 과정과 다시 열기의 거절에서 보드를 다시 읽어 한 번만 재시도한다.
finish-pr 의 중간 PR 과 마일스톤 반영도 항목과 단계를 다시 읽어 한 번 재시도한다. 그 밖의 오류는 재시도하지 않는다. lib/board.ts 의 staleBoardWrite 는 --if-rev 를 준 명령의 종료 코드 1 과 stderr 의 `읽은 뒤 <id> 의 줄이 바뀌어 저장하지 않았다. 다시 읽어 판정한다` 문장이 함께 있을 때만 거절로 본다.

### 3. 테스트와 문서

`skills/orch/tests/lib-board-file.spec.ts` 와 `skills/orch/tests/board-path-callers.spec.ts` 에 경로와 호출자 테스트를 작성한다.

경로 우선순위, 빈 값, 잘못된 값, 워크트리, ORCH_DIR, 옛 기본 위치를 검사한다.
임시 보드와 실제 board.ts, 가짜 gh 로 지정 보드 사용과 쓰기 사이 수정 경쟁을 재현한다.
거절 뒤 다음 항목 처리, 재시도 성공과 반복 거절, 일반 실패를 검사한다.
board.md 에 기존 명시 경로 예외와 창의 한계를 적고 변경 조각을 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-board-file.spec.ts skills/orch/tests/board-path-callers.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/board-release.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/completion-watch.spec.ts skills/orch/tests/decisions.spec.ts skills/orch/tests/handoff-cleanup.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts
claude plugin test .
```

전체 테스트는 지시서에 따라 CI 의 Tests 결과를 확인한다. 고정 입력 기록은 변경하지 않고 기존 기록 테스트로 동작 보존을 확인한다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ2 | 기본 보드와 finish.board 가 다른 임시 저장소 | lib-board-file 및 지정 보드 통합 테스트로 sync/release/goal/루프/조회/등록/마무리를 실행 | 설정 보드만 읽거나 바꾸고 기본 파일은 같다. 기본 파일이 없어도 루프 동기화 실행 | 로컬 임시 저장소 | worker | 없음 | PR 전 |
| REQ2 | 설정 없는 저장소와 워크트리, 빈 값과 깨진 설정 | 경로 테스트와 기존 회귀 테스트 실행 | 기존 기본 위치와 명시 경로 뜻 보존, 오류에서 기본 파일을 고치지 않음 | 로컬 임시 저장소 | worker | 없음 | PR 전 |
| REQ11 | 읽기 후 detail 저장 전에 단계 글을 고치는 가짜 실행 파일 | sync/release/register/finish 의 경쟁 회귀 테스트 실행 | 새 글 보존, 항목 건너뛰기 또는 한 번 재시도, 반복 거절 실패 | 로컬 임시 보드 | worker | 없음 | PR 전 |
| REQ11 | 옛 자동 줄과 남은 일 줄이 함께 있는 항목 | 명령 합치기 및 sync 회귀 테스트 실행 | 통째 저장 하나가 첫 명령이며 지문을 전달, 단계 완료 값 보존 | 로컬 임시 보드 | worker | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/board/board-sync.ts` | 수정 |
| `skills/orch/scripts/board/board-release.ts` | 수정 |
| `skills/orch/scripts/board/goal-progress.ts` | 수정 |
| `skills/orch/scripts/loop/steps/board.ts` | 수정 |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 수정 |
| `skills/orch/scripts/loop/completion-watch.ts` | 수정 |
| `skills/orch/scripts/lib/movement.ts` | 수정 |
| `skills/orch/scripts/lib/decisions.ts` | 수정 |
| `skills/orch/scripts/lib/board.ts` | 수정 |
| `skills/orch/scripts/lib/paths.ts` | 수정 |
| `skills/orch/scripts/core/board.ts` | 수정 |
| `skills/orch/scripts/status/orch-status.ts` | 수정 |
| `skills/orch/scripts/paths/orch_paths.ts` | 수정 |
| `skills/orch/scripts/queue/finish-pr.ts` | 수정 |
| `skills/orch/scripts/cleanup/handoff-cleanup.ts` | 수정 |
| `skills/orch/scripts/lib/board-file.ts` | 신규 |
| `skills/orch/tests/lib-paths.spec.ts` | 수정 |
| `skills/orch/tests/lib-board.spec.ts` | 수정 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/lib-board-file.spec.ts` | 신규 |
| `skills/orch/tests/fixtures/board-race.ts` | 신규 |
| `skills/orch/tests/board-path-callers.spec.ts` | 신규 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/changes/board-path.minor.md` | 신규 |

| `skills/orch/tests/completion-watch.spec.ts` | 수정 |
| `skills/orch/tests/decisions.spec.ts` | 수정 |
| `skills/orch/tests/handoff-cleanup.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `docs/features/orch-board-cli/design.md` | 수정 |
| `extensions/work-board/bin/board.ts` | 수정 |
