# Phase 04. 공통 함수 중복 제거

**Execution profile**: standard

## 목표

공통 함수 중복 제거로 기존 동작을 지킨다.

**범위 외**: 외부 동작과 후속 단계 분리.

## 컨텍스트

**요구사항**: REQ10, REQ11

**근거 문서**: `docs/features/orch-lib-layers/spec.md`, `docs/features/orch-lib-layers/design.md`

## 작업 항목

### 1. 함수 이동과 테스트

core/json.ts 에 isObject, objectOr 를 정의하고 모든 scripts 의 isObject 와 obj 를 바꾼다. null 이 기본인 obj 는 objectOr(value,null) 로, 빈 객체 기본은 objectOr(value) 로 원래 동작을 지킨다. worker 목록은 doctor/migrate-orch-dir.ts 가 lib/workers.ts 의 workerRows 를 부르게 한다. orcaJsonOrThrow 는 lib/orca.ts 에 더하고 worker/send-to-worker.ts 의 자체 봉투 읽기만 합친다. worker/nudge-worker.ts 는 이미 공통 orcaJson 을 부르므로 현재 경로와 오류 줄·종료 코드 5 를 유지한다. 기존 오류 줄과 종료 코드는 호환 래퍼에서 보존한다. closeTerminal 은 lib/orca.ts 로 옮기고 idle-shells 재수출과 cleanup/resume 호출을 합친다. docker, queue-logs, resume 의 pid 확인은 lib/process.ts alive 로 합친다. gitBin 은 lib/git.ts 에 두고 doctor/migrate-orch-dir.ts, queue/finish-pr.ts, cleanup/handoff-cleanup.ts 가 부르게 한다. core-dedup.spec.ts 는 이 정의들이 한 곳인지와 객체 기본값을 검증한다.

### 2. 공통 함수 테스트

`skills/orch/tests/core-dedup.spec.ts` 에 정의 중복과 객체 기본값 테스트를 구현한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/core-dedup.spec.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/questions.spec.ts skills/orch/tests/decisions.spec.ts skills/orch/tests/lib-refresh.spec.ts skills/orch/tests/migrate-orch-dir.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/nudge-worker.spec.ts skills/orch/tests/cleanup-sweep-merge.spec.ts skills/orch/tests/cleanup-sweep-run.spec.ts skills/orch/tests/resume-worker.spec.ts skills/orch/tests/lib-docker.spec.ts skills/orch/tests/lib-queue-logs.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/handoff-cleanup.spec.ts
node skills/orch/tests/fixtures/golden-run.ts
GOLDEN_COMMIT=$(git log --reverse --format=%H origin/main..HEAD -- skills/orch/tests/golden | head -1)
git diff --exit-code "$GOLDEN_COMMIT" HEAD -- skills/orch/tests/golden
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/**/*.ts` | 수정 |
| `skills/orch/scripts/core/*.ts` | 신규 |
| `skills/orch/tests/core-boundary.spec.ts` | 수정 |
| `skills/orch/tests/core-dedup.spec.ts` | 신규 |
