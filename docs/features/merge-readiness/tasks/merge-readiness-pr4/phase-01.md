# Phase 01. draft 로 CI 를 미루는 옵션을 걷어낸다

**Execution profile**: deep

## 목표

draft 로 CI 를 미루던 저장소 옵션을 제거한다. 옛 설정 파일은 계속 열 수 있고, doctor 가 지울 자리를 알려 준다.

**범위 외** 관문과 머지 큐의 draft 거부 규칙은 PR5에서 건다. 체크가 없는 PR 판단은 PR6, 스펙 DECISION15의 리뷰 등급 적용과 HEAD 대조는 PR7에서 다룬다.

## 컨텍스트

**요구사항** REQ3의 선행 작업(스펙 DECISION12)

**근거 문서**: `docs/features/merge-readiness/spec.md`, `docs/features/merge-readiness/technical-design.md`의 「draft 로 CI 를 미루는 옵션 제거」, 「검증 전략」, 「커밋과 PR 순서」

## 작업 항목

### 1. 명령과 이벤트 제거

`lib/commands.ts`에서 `orch queue ready`를 retired로 표시하고 CLI가 안내 한 줄과 종료 코드 2를 내게 한다. `queue/ci-ready.ts` 및 전용 테스트를 제거한다. `before-ready`, `pr-ready`를 `lib/events.ts`의 이벤트와 `core/config.ts`의 이름 목록에서 걷어내고, 일반 이벤트 동작을 보는 테스트는 남은 이벤트로 옮긴다.
### 2. 옛 설정과 doctor 경고

`core/config.ts`와 `core/config-schema.ts`에서 `queue.skipped_is_missing`, `pipeline.ready_slots`, `hooks.timeouts.before-ready`, `hooks.timeouts.pr-ready`를 읽지 않는 키로 남긴다. doctor는 해당 키와 옛 이벤트 핸들러 파일, `.orch/overlay.md`에 남은 두 명령을 `DRAFT-CI-RETIRED`로 알려 준다. 경고만으로는 실패하지 않는다. 테스트는 옛 키와 핸들러가 남은 저장소에서 doctor의 종료 코드 0, 정상 이벤트 핸들러 실행, 머지 성공을 확인한다.
### 3. 체크 판단과 호출부 정리

관문 및 큐 옵션에서 `--skipped-is-missing`을 제거한다. 설정 전달, `checkReadiness`의 정책, `checkSnapshot`의 캐시 키, 루프 CI 감시와 자동 머지 및 최신화에서도 불필요해진 인자를 뺀다. 루프도 `currentChecks`로 같은 HEAD의 체크를 고른다. 캐시 만료 검증은 실제로 필수 체크가 빠진 경우로 유지한다.
### 4. 동작 검증

`skills/orch/tests/core-checks.spec.ts`, `skills/orch/tests/merge-queue.spec.ts`, `skills/orch/tests/queue-gate.spec.ts`, `skills/orch/tests/orch-loop-ci.spec.ts`, `skills/orch/tests/orch-doctor.spec.ts`, `skills/orch/tests/retired.spec.ts`를 고친다. 필수 체크가 SKIPPED면 이름이 집계되고 통과하는지 값 테스트, 큐, 루프에서 확인한다. 폐기된 플래그가 거절되는지 관문과 큐에서 확인한다.
### 5. 문서와 변경 이력

worker 지시서와 현재 동작 문서에서 옛 안내를 걷어낸다. 명령과 이벤트의 호환성이 바뀌므로 저장소 버전 규칙에 따라 orch 스킬의 major 버전을 올리고 변경 이력을 남긴다. 기술 설계 표에 스펙 DECISION15를 PR7에 적용한다고 적는다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `docs/code-architecture.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/features/merge-readiness/technical-design.md` | 수정 |
| `skills/orch/references/cleanup.md` | 수정 |
| `skills/orch/references/hooks.md` | 수정 |
| `skills/orch/references/overlay.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/orch/scripts/core/checks.ts` | 수정 |
| `skills/orch/scripts/core/config-schema.ts` | 수정 |
| `skills/orch/scripts/core/config.ts` | 수정 |
| `skills/orch/scripts/core/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/core/queue-options.ts` | 수정 |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/scripts/lib/conflicts.ts` | 수정 |
| `skills/orch/scripts/lib/events.ts` | 수정 |
| `skills/orch/scripts/lib/gh.ts` | 수정 |
| `skills/orch/scripts/lib/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/lib/retired.ts` | 수정 |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 수정 |
| `skills/orch/scripts/loop/steps/ci.ts` | 수정 |
| `skills/orch/scripts/loop/steps/context.ts` | 수정 |
| `skills/orch/scripts/loop/steps/movement.ts` | 수정 |
| `skills/orch/scripts/queue/gate.ts` | 수정 |
| `skills/orch/scripts/queue/merge-with-finish.ts` | 수정 |
| `skills/orch/scripts/queue/merge_queue.ts` | 수정 |
| `skills/orch/scripts/queue/steps/checks.ts` | 수정 |
| `skills/orch/scripts/queue/steps/gate.ts` | 수정 |
| `skills/orch/scripts/queue/steps/model.ts` | 수정 |
| `skills/orch/scripts/queue/steps/options.ts` | 수정 |
| `skills/orch/scripts/queue/steps/pr.ts` | 수정 |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/tests/config-docs.spec.ts` | 수정 |
| `skills/orch/tests/config-schema-readers.spec.ts` | 수정 |
| `skills/orch/tests/core-checks.spec.ts` | 수정 |
| `skills/orch/tests/core-config-schema.spec.ts` | 수정 |
| `skills/orch/tests/core-merge-readiness.spec.ts` | 수정 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
| `skills/orch/tests/lib-config.spec.ts` | 수정 |
| `skills/orch/tests/lib-events.spec.ts` | 수정 |
| `skills/orch/tests/lib-gh.spec.ts` | 수정 |
| `skills/orch/tests/main-guard.spec.ts` | 수정 |
| `skills/orch/tests/merge-queue.spec.ts` | 수정 |
| `skills/orch/tests/merge-with-finish.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-ci.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/retired.spec.ts` | 수정 |
| `skills/orch/tests/queue-gate.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/config-samples.ts` | 수정 |
| `skills/orch/scripts/queue/ci-ready.ts` | 삭제 |
| `skills/orch/tests/ci-ready.spec.ts` | 삭제 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/CHANGELOG.md` | 수정 |

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ3 | 폐기된 설정이 들어 있는 임시 저장소 | `lib-config.spec.ts`, `orch-doctor.spec.ts`, `retired.spec.ts` 실행 | 설정을 열 수 있다. doctor가 키·핸들러·오버레이를 경고하고 성공한다. 옛 명령은 안내 한 줄과 종료 코드 2를 낸다 | 로컬 임시 저장소 | worker | 없음 | PR 전 |
| REQ3 | 필수 체크가 SKIPPED인 PR | `node scripts/run-tests.ts --concurrency 2 skills/orch/tests` | 필수 체크가 등장한 것으로 판단한다. 머지 큐와 루프에서 옛 설정을 적용하지 않는다 | 로컬 가짜 gh | worker | 없음 | PR 전 |
| REQ3 | PR 생성 | GitHub Actions의 Tests 결과 확인 | 저장소 전체 검사 통과 | GitHub Actions | 코디네이터 | push | PR 뒤 |
