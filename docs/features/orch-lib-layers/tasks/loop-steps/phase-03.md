# Phase 03. 낡은 가리킴과 주석을 고친다

**Execution profile**: standard

## 목표

정리 쪼개기(#417) 뒤에도 옛 `cleanup-sweep.ts` 머리 주석을 가리키는 곳과, 루프에 남은 옛 「대기 확인」 주석을 지금 코드에 맞춘다. 읽는 사람이 없는 절을 찾아 헤매지 않게 하려는 것이다.

**범위 외**: 코드 동작, ADR 과 다른 기능 문서의 옛 경로, work-board 의 주석(PR 본문 「남은 일」 에 적는다).

## 컨텍스트

**요구사항**: REQ12

**근거 문서**: `docs/features/orch-lib-layers/design.md` 의 「단계 파일」 절. 「머리 주석도 단계 파일로 나눠 옮긴다」 고 정했다

- #417 이 `cleanup-sweep.ts` 의 머리 주석을 단계 파일로 옮겼다. 「PR 찾기」 는 `skills/orch/scripts/cleanup/steps/prs.ts` 맨 위에, 「일하는 중」 과 「마무리 빠짐」 은 `skills/orch/scripts/cleanup/steps/worktrees.ts` 에 있다.
- 「대기 확인」 은 PR3(#413)이 「미답변 질문 확인」 으로 바꿨다. 루프에 `NUDGE_WORKER`, `ORCH_NO_WAIT_SEC` 를 읽는 코드는 없다. `grep -rn "NUDGE_WORKER\|ORCH_NO_WAIT_SEC" skills/orch/scripts` 로 확인하고, 주석 밖에서 나오면 그 줄은 지우지 않고 멈춘다.
- phase 02 뒤의 파일 자리로 적는다. phase 02 가 「틱」 4 의 설명과 `relayFinishMissing` 을 `steps/cleanup.ts` 로, `watchUnanswered` 를 `steps/unanswered.ts` 로 옮겼다.
- `docs/features/orch-routing/design.md` 는 기능 문서지만 고친다. 이 PR 의 지시서가 #417 리뷰에서 넘겨받은 정리로 그 두 줄을 짚었다. phase 02 가 `docs/features/` 를 고치지 않는 기준의 예외다.

## 의도 메모

- phase 02 는 옮기기만 하고 이 phase 가 글을 고친다. 옮긴 것과 고친 것을 커밋으로 가르려는 것이다.

## 작업 항목

### 1. 옛 `cleanup-sweep.ts` 머리 주석 가리킴

| 파일 | 지금 | 고친 뒤 |
| --- | --- | --- |
| `skills/orch/scripts/loop/steps/cleanup.ts` | 머리 주석의 `cleanup-sweep 머리 주석의 「마무리 빠짐」` 과 `relayFinishMissing` 위 주석의 `머리 주석의 「마무리 빠짐」` | `cleanup/steps/worktrees.ts 의 「마무리 빠짐」` |
| `skills/orch/scripts/lib/review.ts` | `cleanup-sweep 의 「PR 찾기」` | `cleanup/steps/prs.ts 의 「PR 찾기」` |
| `docs/features/orch-routing/design.md` | `` `cleanup-sweep` 머리 주석 「PR 찾기」 `` | `` `cleanup/steps/prs.ts` 의 「PR 찾기」 `` |
| `docs/features/orch-routing/design.md` | `` `cleanup-sweep` 머리 주석 「일하는 중」 `` | `` `cleanup/steps/worktrees.ts` 의 「일하는 중」 `` |

### 2. 옛 「대기 확인」 주석

- `skills/orch/scripts/loop/orch-loop.ts`: 머리 주석 「환경 변수」 에서 `NUDGE_WORKER`, `ORCH_NO_WAIT_SEC` 항목을 지운다. `MODES` 위에 남은, 상수 없이 떠 있는 「대기 없음…」 주석 두 줄을 지운다. 「틱」 순서의 11번은 phase 02 가 새로 쓰면서 이미 「미답변 질문 확인」 으로 적었다.
- `skills/orch/scripts/loop/steps/unanswered.ts`: `watchUnanswered` 위 주석 「머리 주석의 「대기 확인」. 오류면 이유를, 아니면 null 을 낸다」 를 지금 동작(「미답변 질문 확인」, 반환값 없음)에 맞게 고친다.

### 3. 이 phase 를 검증하는 `skills/orch/tests/loop-steps.spec.ts`

`skills/orch/tests/loop-steps.spec.ts` 에 사례를 더한다. `skills/orch/scripts/loop` 아래와 `skills/orch/scripts/lib/review.ts` 에 `cleanup-sweep 머리 주석`, `cleanup-sweep 의 「`, `「대기 확인」` 이 없다. 정상 사례는 지금 파일이 통과하는 것이고, 옛 문구를 되돌리면 실패한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/orch-loop-import.spec.ts skills/orch/tests/script-folders.spec.ts skills/orch/tests/golden.spec.ts
node scripts/run-tests.ts scripts/tests
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 (머리 주석) |
| `skills/orch/scripts/loop/steps/cleanup.ts` | 수정 (주석) |
| `skills/orch/scripts/loop/steps/unanswered.ts` | 수정 (주석) |
| `skills/orch/scripts/lib/review.ts` | 수정 (주석) |
| `docs/features/orch-routing/design.md` | 수정 (가리킴) |
| `skills/orch/tests/loop-steps.spec.ts` | 수정 (사례 추가) |
