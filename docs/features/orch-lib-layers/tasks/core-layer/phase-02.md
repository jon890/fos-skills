# Phase 02. 순수 함수와 실행 코드 분리

**Execution profile**: standard

## 목표

순수 함수와 실행 코드 분리로 기존 동작을 유지한다.

**범위 외**: loop-steps, queue-steps, cleanup-steps 구현.

## 컨텍스트

**요구사항**: REQ10, REQ11

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`

## 의도 메모

새 의존 없이 폴더와 소스 검사로 경계를 지킨다.

## 작업 항목

### 1. 순수 모듈과 의존 함수 이동

core 의 의존은 위 표의 순수 함수끼리만 연결하고 lib 는 기존 이름을 재수출한다. py.ts 파일은 실행 도우미로 남긴다. completion 은 core 에 JSON 값 비교기를 두되 lib classify 가 기존 isDeepStrictEqual 을 인자로 넘겨 기존 호출자의 동작을 지킨다.

| 원본 | core 로 옮길 값·함수 | lib 에 남길 부분 | 검증 |
| --- | --- | --- | --- |
| completion | 전체 판정, classify 의 equality 인자 | node:util 비교기를 주는 classify 호환 래퍼 | completion.spec.ts |
| auto-merge, screen, overlap, stop-reports, deploy, finish-options, queue-options | 전체 | 호환 재수출 | lib-auto-merge.spec.ts, lib-screen.spec.ts, overlap-units.spec.ts, lib-stop-reports.spec.ts, finish-pr.spec.ts, board-sync.spec.ts |
| milestones | boardSettingsFromConfig 와 전체 값 판정 | boardSettings(repo): loadConfig 후 순수 함수 호출 | lib-milestones.spec.ts |
| config | 타입·상수·오류 클래스·section | loadConfig 와 파일 접근 | lib-config.spec.ts |
| board | detailText, detailArgs, prNumbers, noteLine, withNote, prSteps, intermediateCommands 와 관련 타입·상수 | 조회·쓰기 | lib-board.spec.ts |
| py | pyRegExp 만 core/regexp.ts 로 이동 | 나머지 실행 도우미와 pyRegExp 재수출 | lib-py.spec.ts |
| spec | LINE_BREAK 를 core/text.ts 로 이동 | 다른 함수와 LINE_BREAK 재수출 | lib-spec.spec.ts |

### 2. 순수 함수 테스트

`skills/orch/tests/core-values.spec.ts` 는 core 를 직접 import 해서 deploy, 옵션 표, JSON 비교, 설정의 성공·실패 입력을 검증한다. 기존 테스트 파일은 이름과 기대값을 유지하고 lib 호환 경로를 그대로 확인한다. core-*.spec.ts 는 fake-bin 을 가져오거나 ORCA/GH/PATH 를 바꾸지 않는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/completion.spec.ts skills/orch/tests/lib-auto-merge.spec.ts skills/orch/tests/lib-screen.spec.ts skills/orch/tests/overlap-units.spec.ts skills/orch/tests/lib-stop-reports.spec.ts skills/orch/tests/lib-milestones.spec.ts skills/orch/tests/lib-config.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/lib-py.spec.ts skills/orch/tests/lib-spec.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/core-values.spec.ts
node skills/orch/tests/fixtures/golden-run.ts
GOLDEN_COMMIT=$(git log --reverse --format=%H origin/main..HEAD -- skills/orch/tests/golden | head -1)
git diff --exit-code "$GOLDEN_COMMIT" HEAD -- skills/orch/tests/golden
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/*.ts` | 수정 |
| `skills/orch/scripts/core/*.ts` | 신규 |
| `skills/orch/tests/completion.spec.ts` | 수정 |
| `skills/orch/tests/lib-auto-merge.spec.ts` | 수정 |
| `skills/orch/tests/lib-screen.spec.ts` | 수정 |
| `skills/orch/tests/overlap-units.spec.ts` | 수정 |
| `skills/orch/tests/core-values.spec.ts` | 신규 |
