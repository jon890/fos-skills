# Phase 02. 루프 자동 머지가 checkReadiness 를 쓴다

**Execution profile**: standard

## 목표

`loop/steps/auto-merge.ts` 의 `judgeTarget` 을 `checkReadiness(light, auto, stopAtFirst, skip: migration)` 호출로 바꾼다. 스레드 기본 명령은 `lib/merge-readiness.ts` 한 곳에 둔다.

**범위 외** 마이그레이션 겹침 판단(루프 4단계, DECISION5), 큐 띄우기와 기록, 루프의 PR 조회 캐시 끄기와 HEAD 붙이기(PR7).

## 컨텍스트

**요구사항** REQ1

**근거 문서**: `docs/features/merge-readiness/technical-design.md` 의 「호출부가 바뀌는 모양」, 「snapshot」 의 루프 줄, 「루프의 대기 문구」, 「커밋과 PR 순서」 의 PR3 행과 「임시로 남기는 것」

## 의도 메모

- 바뀌는 동작은 하나다. 루프는 체크를 CI 감시가 남긴 `ci` 기록이 아니라 그 틱의 롤업(`OwnPr.rollup`)과 CI 감시가 읽은 필수 체크 이름으로 판단한다. CI 실패 알림 전송이 실패해 기록이 이전 값으로 되돌아간 틱에만 결과가 다르다(사용자 2026-11-24 수용).
- CI 감시는 이번 틱에 판단한 PR 마다 필수 체크 이름을 `StepState.ciNames` 로 넘긴다. 규칙을 읽지 못한 PR(`ciStale`)은 `checks` 값이 `ok: false`, wait `CI 규칙을 읽지 못했다` 다. 이름이 없으면(감시 실패, 판단하지 않은 PR) wait `CI 없음` 이다.
- 루프는 틱에서 이미 읽은 값과 루프의 읽기 함수를 `known` 으로 넘긴다. HEAD 는 붙이지 않는다(PR7).
  - `checks`: `loopChecks(pr.rollup, skippedIsMissing, pr.head)` 행. 위 두 조회 실패는 `ok: false` 와 wait 다.
  - `specHold`: 지금처럼 비공개 낱말을 위치로 바꾼 지시서 보류.
  - `boardItems`: 틱에 한 번 읽어 `isObject` 인 항목만 남긴 목록. 파일이 없으면 빈 목록이다. 읽지 못하면 지금처럼 `보드를 읽지 못했다: <이유>` 를 errors 에 넣고 그 틱의 자동 머지 전체를 건너뛴다(PR 마다 묻지 않는다).
  - `threads`: 지금 명령(`THREADS_CMD` 나 기본 명령)을 지금처럼 `cwd: ctx.repo`, env `OWNER, REPO, PR, GH_HOST` 로 돌리는 함수다. 출력을 trim 해 `/^\d+$/` 가 아니거나 종료 코드가 0 이 아니면 `fail(#<PR> 의 미해결 스레드를 읽지 못했다(종료 코드 <n>): <한 줄>)`, 숫자면 `String(Number(count))` 를 돌려준다. `ReadOptions.threadsCmd` 는 넘기지 않는다(넘기면 lib 의 읽기 함수와 섞인다).
  - `holdBody`, `reviewRollup`: `gh pr view --json statusCheckRollup,files,body,headRefOid` 한 번을 기억해 나눠 쓰는 함수다. 실패는 `fail(#<PR> 의 리뷰와 파일을 읽지 못했다: <한 줄>)` 이다. `holdBody` 는 `prHold(body)` 를 `redactLine(…, 'PR 본문', body)` 로 바꾼 값이다.
  - `receipts` 는 lib 의 읽기 함수를 쓴다. 스레드 → PR 조회 → 봇 조회로 gh 호출 수와 순서가 지금과 같다.
- 첫 이유에 `wait` 가 있으면 `AUTO-MERGE-WAIT #<PR> <wait>` 다. `wait` 가 없는 조회 실패는 errors 에 넣는다. 이때 문구는 `checkReadiness` 가 가린(mask) `text` 가 아니라 루프의 읽기 함수가 만든 원문이다(읽기 함수가 실패 문구를 기억해 두고 그것을 쓴다). 지금 출력과 글자가 같아야 하기 때문이다.
- `review-missing` 이면 지금처럼 `AUTO-MERGE-NO-REVIEW` 를 HEAD 마다 한 번 보낸다.
- 통과한 PR 의 근거는 `Readiness.basis`, 리뷰 설정이 없으면 `queue.auto_review 없음` 이다. 마이그레이션 판단에 쓸 파일은 PR 조회 함수가 읽은 값에서 꺼낸다.
- `lib/review-judgement.ts` 는 쓰는 곳이 없어져 지운다. 같은 판단은 조건 표의 `review` 조건이 한다.

## 작업 항목

### 1. CI 감시

`loop/steps/ci.ts` 가 판단한 PR 의 필수 체크 이름을 `ciNames` 로 낸다. `StepState` 에 칸을 더한다.

### 2. 자동 머지 연결

`judgeTarget` 을 지우고 `checkReadiness` 를 부른다. `known`, `required`(CI 감시가 읽은 이름), `skippedIsMissing`, `allowNoChecks: false` 를 넘긴다. `auto.attempted` 는 tried 에 `<PR>@<HEAD>` 가 있는지, `compat.featureOnly.feature` 는 지시서의 `featureLoopRequested` 다. 결과를 지금의 대기, 오류, 통과 세 갈래로 옮긴다.

### 3. 스레드 기본 명령

`lib/merge-readiness.ts` 에 `defaultThreadsCmd(dir)` 를 두고 `queue/steps/setup.ts` 와 루프가 쓴다. 옛 명령과 같은 글자로 잇는다.

### 4. 테스트

`tests/orch-loop-auto-merge.spec.ts` 에 CI 실패 알림 전송이 실패한 틱에도 그 틱의 롤업으로 `AUTO-MERGE-WAIT #<PR> CI failed` 를 쓰고 걸지 않는 사례를 더한다. 스레드 명령이 실패하거나 숫자가 아닌 것을 낼 때와 PR 조회가 실패할 때 `WATCH-ERROR auto-merge` 의 문구가 지금 글자 그대로인 사례를 더한다. 나머지 루프 사례는 기대값을 바꾸지 않고 통과해야 한다.
`tests/lib-merge-readiness.spec.ts` 에 `defaultThreadsCmd` 가 옛 명령과 같은 글자를 내는지 본다.

### 5. 문서

`loop/steps/auto-merge.ts` 와 `loop/steps/ci.ts` 의 파일 맨 위 설명, ADR-016 의 「적용 범위」 줄, `docs/flow.md` 의 자동 머지 절, `docs/code-architecture.md` 의 자동 머지 행이 판단의 원본으로 조건 표를 가리키게 고친다. `core/auto-merge.ts` 설명과 `tests/fixtures/merge-queue-fakes.ts` 주석의 `lib/review-judgement.ts` 참조를 고친다. `skills/orch/changes/` 에 patch 조각을 더한다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests/orch-loop-auto-merge.spec.ts skills/orch/tests/orch-loop-ci.spec.ts skills/orch/tests/lib-merge-readiness.spec.ts skills/orch/tests/queue-gate.spec.ts
node scripts/run-tests.ts --concurrency 2 skills/orch/tests
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/loop/steps/auto-merge.ts` | 수정 |
| `skills/orch/scripts/loop/steps/ci.ts` | 수정 |
| `skills/orch/scripts/loop/steps/context.ts` | 수정 |
| `skills/orch/scripts/lib/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/lib/review-judgement.ts` | 삭제 |
| `skills/orch/scripts/queue/steps/setup.ts` | 수정 |
| `skills/orch/scripts/core/auto-merge.ts` | 수정(설명) |
| `skills/orch/tests/orch-loop-auto-merge.spec.ts` | 수정(롤업으로 판단하는 사례) |
| `skills/orch/tests/lib-merge-readiness.spec.ts` | 수정 |
| `skills/orch/tests/fixtures/merge-queue-fakes.ts` | 수정(주석) |
| `docs/adr/016-orch-auto-merge.md` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `skills/orch/changes/merge-readiness-pr3.patch.md` | 신규 |

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 저장소 의존 설치 | `node scripts/run-tests.ts --concurrency 2 skills/orch/tests` | 루프, 관문, 머지 큐 테스트와 고정 입력 기록이 기대값을 바꾸지 않고 통과. 새 사례가 CI 실패 알림 전송이 실패한 틱에도 그 틱의 롤업으로 `CI failed` 를 쓰는지 확인 | 로컬 가짜 gh | worker | 없음 | PR 전 |
| REQ1 | PR 생성 | GitHub Actions 의 Tests 결과 확인 | 저장소 전체 테스트 통과 | GitHub Actions | 코디네이터 | push | PR 뒤 |
