# Phase 01. 머지 조건 표와 판단을 core 에 둔다

**Execution profile**: standard

## 목표

관문과 머지 큐가 보는 머지 전 조건을 `core/merge-readiness.ts` 의 조건 표 하나에 둔다. 판단은 snapshot 값만 받고 gh, git, 파일을 읽지 않는다.

**범위 외** 호출부 연결(phase 2), 루프만 보는 조건(이미 건 HEAD, 리뷰 설정 없음. PR3), 동작 변경(PR4-PR7).

## 컨텍스트

**요구사항** REQ1

**근거 문서**: `docs/features/merge-readiness/technical-design.md` 의 「질문과 답」, 「판단과 읽기가 만나는 방식」, 「snapshot」, 「조건 표」, 「커밋과 PR 순서」

## 의도 메모

- 조건 표의 행은 이번 PR 에서 관문과 머지 큐가 쓰는 조건과, compat 로 꺼 둘 `draft`, `hold-board` 다. 루프만 보는 두 행은 루프가 처음 묻는 PR3 이 더한다.
- 동작이 그대로여야 한다. 지금 `gateReasons` 가 내는 이유 문구, 이유 순서, `summary`, `notes` 를 그대로 낸다. HEAD 변경 문구도 값마다 지금 글자 그대로다(하나로 모으는 일은 PR7).
- 조회 실패는 값마다 `lookup` 이유 하나다. 문구는 지금 문구를 값마다 둔다. 체크 조회 실패는 지금처럼 두 줄(`체크 조회 실패`, 진행 중·미등장 `?`)을 낸다. 머지 큐에서 `ci` 와 `lookup` 은 둘 다 일반 보류라 결과가 같다.
- 본문을 읽지 못해도 비공개 낱말 조건은 본문 없이 댓글을 본다(지금 동작). 값을 「필수」 와 「있으면 쓰는 값」 으로 나눠 표현한다.
- 통합 테스트 기록은 `integrationCandidates` 가 확인할 커밋을 고르고, lib 가 그 커밋만 git 으로 확인한 값(`acceptedCommits`)을 넘긴다.

## 작업 항목

### 1. 타입과 조건 표

`ReasonKind`(지금 `GateKind` 에 `draft`, `hold`, `head` 를 더함), `Reason`, `Fact`, `Facts`, `ReadinessSnapshot`, `ReadinessAsk`(scope, only, skip, stopAtFirst, fresh, compat), `ReadinessPolicy`(필수 체크, 허용한 실패, SKIPPED 옵션, allowNoChecks, 리뷰 설정, 통합 테스트 규칙, 마이그레이션 폴더, 비공개 낱말 검사 여부)를 정의한다.
조건 표는 행마다 code, kind, 단계, 범위, 평가 순서, 출력 순서, 필요한 값, 있으면 쓰는 값, 판단 함수를 둔다.

### 2. judgeReadiness

범위, `only`, `skip`, `stopAtFirst`, compat 를 적용해 조건을 평가 순서로 돈다. 없는 값은 `need` 로 돌려주고, 이유는 출력 순서로 정렬한다.
값의 `head` 가 `pr.head` 와 다르면 다른 이유를 버리고 `head` 이유 하나만 낸다. compat `checkHeadStop` 이면 체크 값의 HEAD 변경은 code `head-checks` 로 구분한다.
`blocksReady`, `blocksMerge` 를 둔다. 보드 항목 찾기(`matchBoardItems`)를 core 의 순수 함수로 옮기고 `lib/board.ts` 의 `findBoardItems` 가 그것을 부른다.

### 3. 값 테스트

`tests/core-merge-readiness.spec.ts` 에서 snapshot 값을 직접 만들어 조건마다 통과, 걸림, 조회 실패, `need` 를 본다. 범위 대조(light 이유는 full 이유 가운데 light 조건의 것과 같다), 두 단계(`blocksReady`, `blocksMerge`), HEAD 변경, compat 값도 본다.

## 검증

```bash
node scripts/run-tests.ts --concurrency 2 skills/orch/tests/core-merge-readiness.spec.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/core-checks.spec.ts
git diff --check
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/merge-readiness.ts` | 신규 |
| `skills/orch/scripts/core/integration-evidence.ts` | 수정 |
| `skills/orch/scripts/lib/board.ts` | 수정 |
| `skills/orch/tests/core-merge-readiness.spec.ts` | 신규 |
