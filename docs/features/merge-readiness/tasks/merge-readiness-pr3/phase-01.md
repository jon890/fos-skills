# Phase 01. 루프만 보는 조건을 조건 표에 더한다

**Execution profile**: standard

## 목표

루프 자동 머지가 보는 조건을 `core/merge-readiness.ts` 의 조건 표에서 모두 고를 수 있게 한다. 관문과 머지 큐의 결과는 바뀌지 않는다.

**범위 외** 루프 호출부 연결(phase 2), 동작 변경(PR4-PR7). 리뷰 설정 없음 조건의 평가 순서 이동과 문구의 「기능」 빼기는 PR7 이다.

## 컨텍스트

**요구사항** REQ1

**근거 문서**: `docs/features/merge-readiness/technical-design.md` 의 「질문과 답」, 「조건 표」, 「체크 판단」, 「루프의 대기 문구」, 「커밋과 PR 순서」

## 의도 메모

- `ReadinessAsk.auto` 는 `{ attempted: boolean }` 이다. 있을 때만 `attempted`(평가 3), `review-config`(평가 8) 조건이 켜진다. 둘 다 merge 단계, light 범위다. 출력 순서는 관문·머지 큐가 쓰지 않으므로 표 끝에 둔다.
- `review-config` 는 리뷰 설정이 없을 때만 걸린다. PR3 은 compat `featureOnly` 로 기능 PR 에만 건다. 기능 PR 인지는 루프가 지시서로 정해 `compat.featureOnly: { feature }` 로 넘긴다(core 는 지시서를 읽지 않는다). 문구는 지금 그대로 `기능 자동 머지는 queue.auto_review 의 trusted_bots 나 review_checks 가 필요하다` 다.
- `ci` 조건에 `ci-none` 을 더한다. 남은 체크 행이 없고 `allowNoChecks` 가 false 면 `PR 에 CI 체크가 하나도 없다`, wait `CI pending` 이다. 관문과 머지 큐는 지금 `allowNoChecks: true` 라 결과가 같다. 루프의 `ciState` 는 이때 pending 이었다.
- 루프의 체크 행은 `skippedIsMissing` 이면 SKIPPED 행을 실패·진행 중 판단에서도 빼고 이름 없는 행을 빈 이름으로 본다(`core/checks.ts` 의 `loopCheckRows`). 루프가 같은 행을 넘기도록 이 함수를 `loopChecks` 로 내보낸다. PR4 가 `skippedIsMissing` 과 함께 지운다.

## 작업 항목

### 1. 조건 표

`ReadinessAsk` 에 `auto`, `ReadinessCompat` 에 `featureOnly` 를 더한다. `ConditionKind` 에 `attempted` 를 더하고, `review-config` 는 kind `review` 로 둔다. 표 맨 위 설명의 「루프만 보는 조건은 PR3 이 더한다」 를 지운다.

### 2. 체크

`ci` 조건에 `ci-none` 을 더하고 `core/checks.ts` 에서 `loopChecks` 를 내보낸다.

### 3. 값 테스트

`tests/core-merge-readiness.spec.ts` 에 `attempted`, `review-config`(리뷰 설정 있음·없음, featureOnly 의 기능·기능 아님, auto 없음), `ci-none`(allowNoChecks 참·거짓)과 stopAtFirst 로 물었을 때의 첫 이유 순서를 더한다.
조건 표의 `wait` 문구를 고정 목록과 대조하고, 그 목록이 work-board 의 `waitText` 로 옮겨지는지 본다. 정규식이 없어 그대로 보이는 문구(`PR 본문 보류: …`, `HEAD 가 바뀌었다`)는 따로 적은 목록과 대조한다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests/core-merge-readiness.spec.ts skills/orch/tests/core-checks.spec.ts skills/orch/tests/core-boundary.spec.ts
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/merge-readiness.ts` | 수정 |
| `skills/orch/scripts/core/checks.ts` | 수정 |
| `skills/orch/tests/core-merge-readiness.spec.ts` | 수정 |
