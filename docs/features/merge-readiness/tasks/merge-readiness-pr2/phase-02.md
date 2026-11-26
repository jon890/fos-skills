# Phase 02. 관문과 머지 큐가 checkReadiness 를 쓴다

**Execution profile**: standard

## 목표

`lib/merge-readiness.ts` 의 `checkReadiness` 가 core 가 달라는 값만 읽어 판단을 돌려준다. `orch queue gate` 와 머지 큐는 이 함수를 부르고 범위만 고른다. 장기 결정을 ADR-037 로 남긴다.

**범위 외** 루프 자동 머지 연결(PR3), 체크 대기(`waitChecks`)와 앞지르기 판단의 변경, 출력 문구·종료 코드·gh 호출 순서의 변경.

## 컨텍스트

**요구사항** REQ1

**근거 문서**: `docs/features/merge-readiness/technical-design.md` 의 「호출부가 바뀌는 모양」, 「snapshot」, 「실패와 일관성」, 「커밋과 PR 순서」, 「장기 결정」

## 의도 메모

- 읽기 순서는 지금 `gateReasons` 의 gh 호출 순서다. lib 는 core 가 달라는 값 가운데 이 순서로 가장 앞의 값 하나를 읽고 다시 묻는다. 앞 값에 따라 생기는 값(영수증, 인정 커밋, base 마이그레이션)이 지금 자리에서 읽힌다.
- HEAD 가 다른 값을 읽으면 뒤 값을 읽지 않는다. 지금 `HeadChanged` 를 던져 멈추던 자리와 같다. 머지 큐는 `head` 이유를 `HeadChanged` 로, compat `checkHeadStop` 의 체크 HEAD 변경은 일반 보류로 바꾼다.
- lib 는 queue 를 import 하지 않는다. 읽기 함수는 `PrTarget` 과 `ReadOptions` 만 받는다. gh 와 git 의 인자, cwd, 캐시 옵션은 지금 호출과 글자 그대로 둔다. 테스트의 가짜 실행기가 인자로 응답을 고른다.
- 관문은 머지 전 조건과 보류를 지금처럼 두 번 묻는다(`skip: hold` 뒤에 `only: hold`). 조건 검사 도중 멈춰도 보류 줄을 내던 지금 동작을 지키려는 것이고, 한 번으로 합치는 일은 PR5 가 보류 출력을 바꿀 때 한다.
- 머지 직전 확인에서 마이그레이션만 `only: migration` 으로 묻는다. 체크 재확인은 지금 코드(캐시 없이 한 번, 캐시로 두 번 읽기)로 둔다. 고정 입력 기록이 gh 캐시를 끈 채 세 번의 읽기를 모두 남기기 때문이다. 옮기는 일은 PR7 이 하고 설계의 임시로 남기는 것 표에 적었다(코디네이터 2026-11-26).
- 지시서 찾기(`specTargets`)는 lib 가 읽으므로 `lib/spec-targets.ts` 로 옮기고 `queue/steps/spec-hold.ts` 는 다시 내보낸다. 비공개 낱말 댓글 읽기(`commentRows`)도 lib 로 옮긴다.

## 작업 항목

### 1. 값 읽기와 checkReadiness

`checks`, `threads`, `mergeable`, `reviewRollup`, `receipts`, `body`, `integrationFiles`, `acceptedCommits`, `files`, `baseMigrations`, `privateWords`, `holdBody`, `specHold`, `boardItems` 를 읽는 함수를 둔다. 재시도 횟수와 간격, mergeable `UNKNOWN` 재시도, 스레드 명령의 환경, 보류 줄의 비공개 낱말 위치 바꾸기, 이유 문구 가리기(`mask`)를 지금 그대로 옮긴다. 모르는 값 이름은 `ok: false` 다.

### 2. 호출부 연결

`gateReasons` 는 `checkReadiness(full)` 를 부르는 얇은 함수가 된다. `holdWith` 는 남는다. `refuseSpecHold` 는 `checkReadiness(full, only: hold·draft)` 로, 관문의 `HOLD` 줄은 `only: hold` 로 묻는다. 머지 직전 확인과 체크 대기 실패 뒤 확인은 위 「의도 메모」 대로 바꾼다. `migrationReasons`, `privateReasons`, `mergeHold` 는 지운다.

### 3. adapter 테스트

`tests/lib-merge-readiness.spec.ts` 에서 값 읽기만 가짜 실행기로 본다. 읽지 않아도 되는 값을 건너뛰는지, HEAD 가 다른 값 뒤로는 읽지 않는지, 본문 보류를 읽지 못하면 merge 단계 조회 실패가 되는지, `known` 함수가 필요할 때만 불리는지, `fresh` 가 체크 캐시를 건너뛰는지 확인한다. 조건의 뜻은 다시 보지 않는다. 호출부 연결은 지금의 `queue-gate.spec.ts`, `merge-queue.spec.ts`, 고정 입력 기록이 기대값을 바꾸지 않고 통과하는 것으로 본다.

### 4. ADR 과 문서

`docs/adr/037-orch-merge-readiness.md` 를 쓰고 `adr-docs.ts write-index` 로 색인을 만든다. `queue/gate.ts`, `queue/steps/gate.ts` 의 파일 맨 위 설명이 조건의 원본으로 조건 표를 가리키게 고친다. `skills/orch/changes/` 에 patch 조각을 더한다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests
node skills/plan/scripts/adr-docs.ts check docs/adr
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/merge-readiness.ts` | 신규 |
| `skills/orch/scripts/lib/spec-targets.ts` | 신규 |
| `skills/orch/scripts/lib/private-words.ts` | 수정 |
| `skills/orch/scripts/queue/gate.ts` | 수정 |
| `skills/orch/scripts/queue/steps/gate.ts` | 수정 |
| `skills/orch/scripts/queue/steps/merge.ts` | 수정 |
| `skills/orch/scripts/queue/steps/migrations.ts` | 수정 |
| `skills/orch/scripts/queue/steps/private-words.ts` | 삭제 |
| `skills/orch/scripts/queue/steps/spec-hold.ts` | 수정 |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 수정(import 경로) |
| `skills/orch/tests/lib-private-words.spec.ts` | 수정(import 경로) |
| `skills/orch/tests/lib-merge-readiness.spec.ts` | 신규 |
| `docs/adr/037-orch-merge-readiness.md` | 신규 |
| `docs/features/merge-readiness/technical-design.md` | 수정(임시로 남기는 것 한 줄) |
| `docs/adr/INDEX.md` | 수정 |
| `skills/orch/changes/merge-readiness-pr2.patch.md` | 신규 |

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 저장소 의존 설치 | `node scripts/run-tests.ts --concurrency 2 skills/orch/tests` | 관문, 머지 큐, 루프 테스트와 고정 입력 기록이 기대값을 바꾸지 않고 통과. 새 core 값 테스트가 조건마다 통과·걸림·조회 실패와 범위 대조를 확인 | 로컬 가짜 gh | worker | 없음 | PR 전 |
| REQ1 | PR 생성 | GitHub Actions 의 Tests 결과 확인 | 저장소 전체 테스트 통과 | GitHub Actions | 코디네이터 | push | PR 뒤 |
