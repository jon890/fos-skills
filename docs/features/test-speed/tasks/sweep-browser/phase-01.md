# Phase 01. 반복 기동을 줄이고 명령 경계를 보존한다

**Execution profile**: standard

## 목표

함수 main과 같은 본문의 가짜로 browser-driver의 반복 기동을 줄인다. cleanup-sweep는 실제 git·삭제·pid 경계를 보존하면서 남은 준비 비용을 확인한다.

**범위 외**: 실행기와 CI, 다른 상위 테스트 파일.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ6, REQ9

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`의 PR11 절.

## 의도 메모

전역 env·fs monkey patch는 쓰지 않는다. 비동기 ego 스크립트와 삭제는 실제 자식에 남긴다. 독립 검토는 지시서에 따라 PR 뒤 코디네이터에게 넘긴다.

## 작업 항목

### 1. runtime 범위에 env·write·spawn을 주입하고 기본 CLI 경로의 동작을 확인한다. 설정의 호출별 경로를 보존한다.
### 2. 폴더 안에 FunctionBox를 두고 동기 가짜의 같은 본문을 평가한다. prelude는 실제 자식으로 넘긴다.
### 3. `skills/browser/browser-driver/tests/function-box.spec.ts`와 대상 테스트의 반복 사례를 옮기고 옵션·stdout·stderr·종료 코드와 백엔드마다 대표 CLI 사례를 남긴다.
### 4. cleanup-sweep 준비를 읽고 실제 상태를 보존하는 절감만 반영한다. 같은 머신에서 전후를 번갈아 측정하고 전체 실행 결과를 남긴다.

## 검증

```bash
node scripts/run-tests.ts skills/browser/browser-driver/tests
node scripts/run-tests.ts 'skills/orch/tests/cleanup-sweep-*.spec.ts'
node skills/orch/bin/orch.ts slot heavy --exclusive -- node scripts/run-tests.ts --concurrency 8
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 같은 규칙의 함수/CLI Box | 대표 명령의 출력·종료·호출 기록 대조와 기존 테스트 | 판정과 출력 유지 | 임시 홈·가짜 백엔드 | 없음 | PR 전 |
| REQ2 | 같은 규칙의 함수/CLI Box | function-box.spec.ts 출력·종료 대조 | 출력·종료 보존 | 로컬 Node | 없음 | PR 전 |
| REQ3 | 기준/구현 커밋 | testkit measure로 대상 파일 교대 실행 | 시간·preload 기동 수와 load 기록 | heavy exclusive slot | 없음 | PR 전 |
| REQ4 | 전체 저장소 | 동시 8 전체 실행 | 실패 없음, 끝 줄과 파일 합 기록 | heavy exclusive slot | 없음 | PR 전 |
| REQ6 | 함수 helper와 배포 폴더 | browser 테스트와 전체 검사 | inode 재사용, 폴더 밖 import 없음 | 로컬 Node | 없음 | PR 전 |

| REQ9 | 배포 폴더 | 전체 실행의 외부 import 검사 | 폴더 밖 import 없음 | 로컬 Node | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/browser/browser-driver/driver/runtime.ts` | 신규 |
| `skills/browser/browser-driver/browser_driver.ts` | 수정 |
| `skills/browser/browser-driver/driver/config.ts` | 수정 |
| `skills/browser/browser-driver/driver/io.ts` | 수정 |
| `skills/browser/browser-driver/driver/shell.ts` | 수정 |
| `skills/browser/browser-driver/driver/pylike.ts` | 수정 |
| `skills/browser/browser-driver/driver/admin.ts` | 수정 |
| `skills/browser/browser-driver/driver/backends/index.ts` | 수정 |
| `skills/browser/browser-driver/driver/backends/orca.ts` | 수정 |
| `skills/browser/browser-driver/driver/backends/cmux.ts` | 수정 |
| `skills/browser/browser-driver/driver/backends/ego.ts` | 수정 |
| `skills/browser/browser-driver/driver/backends/agent_browser.ts` | 수정 |
| `skills/browser/browser-driver/tests/function-box.ts` | 신규 |
| `skills/browser/browser-driver/tests/function-box.spec.ts` | 신규 |
| `skills/browser/browser-driver/tests/backends.spec.ts` | 수정 |
| `skills/browser/browser-driver/tests/input-and-output.spec.ts` | 수정 |
| `skills/browser/browser-driver/tests/ego-space.spec.ts` | 수정 |
| `docs/features/test-speed/design.md` | 수정 |
| `skills/browser/changes/test-speed.patch.md` | 신규 |
| `skills/orch/scripts/cleanup/remove-worktree.ts` | 수정 |
| `skills/orch/tests/fixtures/cleanup-stateful-run.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-run.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/remove-worktree-run.ts` | 신규 |
| `skills/orch/changes/test-speed-sweep.patch.md` | 신규 |
