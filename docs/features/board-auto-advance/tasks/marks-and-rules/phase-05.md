# Phase 05. `[auto]` 단계를 띄울 때 기록을 남긴다

**Execution profile**: standard

## 목표

worker 를 띄울 때, 지시서의 `보드 항목 id:` 줄이 가리키는 항목의 첫 미완료 단계가 `[auto]` 면 띄운 기록 한 줄을 남긴다. phase 04 의 `auto-check` 가 이 기록을 읽어 같은 단계를 두 번 자동으로 띄우지 못하게 한다(스펙 REQ9). 다음 PR 의 멈춘 단계 판정도 이 기록을 읽는다(스펙 REQ5).

**범위 외**: 기록을 읽는 루프 쪽(다음 PR). 띄우기 이력(`state/launch-history.jsonl`)의 필드는 바꾸지 않는다. 그 파일의 계약은 `docs/features/orch-routing/design.md` 가 소유한다. 보드에 항목을 잇는 `registerBoard`(`skills/orch/scripts/lib/board.ts`)는 고치지 않는다.

## 컨텍스트

- 띄우는 곳은 둘이다.
  - `skills/orch/scripts/worker/launch-worker.ts`: `LAUNCHED` 를 낸 뒤 `recordLaunch`, `recordHistory`, `registerBoard`, `worker-launched` 이벤트 순서로 부른다. 지시서 글은 그 자리의 `specText`(변수 `text`), dispatch id 는 `dispatch` 다. 시작 확인이 늦은 경우(`stalled`)에도 `recordLaunch` 와 `registerBoard` 는 불린다. worker 가 끝났다고 단정할 수 없기 때문이다.
  - `skills/orch/scripts/worker/send-to-worker.ts`: 후속 지시서(`--spec`)를 보낸 뒤 `recordLaunch`, `recordHistory`, `registerBoard` 순서로 부른다. 지시서 글은 `spec.text`, 새 dispatch id 는 `dispatch` 다.
- 두 곳 모두 기록과 보드 쓰기의 실패를 stderr 한 줄로만 남기고 종료 코드를 바꾸지 않는다. 종료 코드를 바꾸면 코디네이터가 띄우기 실패로 읽고 같은 일을 다시 띄운다.
- 지시서의 `보드 항목 id:` 줄은 `skills/orch/scripts/lib/spec.ts` 의 `boardIdOf(text)` 가 읽는다(`{ id, note }` 나 `null`).
- 한 줄을 덧붙이는 함수는 phase 04 의 `skills/orch/scripts/lib/step-launches.ts`(`appendStepLaunch`), 첫 미완료 단계는 `skills/orch/scripts/lib/auto-advance.ts`(`firstPendingStep`)다. `auto-advance.ts` 가 `step-launches.ts` 를 가져온다.
- `launch-worker.ts` 통합 테스트는 `skills/orch/tests/launch-worker.spec.ts` 다. 가짜 `orca` 로 띄우고 워크트리의 `.omc/board.json` 을 확인한다(「LAUNCHED 뒤 지시서의 id, 제목과 마일스톤 단계로 항목을 만들고 …」 테스트의 방식). 후속 지시서 테스트는 `skills/orch/tests/send-to-worker.spec.ts` 다.

**요구사항**: REQ9

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md` 「띄운 기록 `state/step-launches.jsonl`」

## 의도 메모

- 기록을 보드 쓰기(`registerBoard`)의 결과에 기대지 않는다. 보드 명령 구현이 잠금을 넣으면 5초 안에 못 잡아 보드 쓰기가 실패하는 일이 생긴다. 그때 기록까지 빠지면 「한 번만」 과 멈춤 알림을 함께 잃는다.
- 코디네이터가 「띄웠다」 를 따로 적게 하지 않는다. 지시서에 `보드 항목 id:` 줄이 있으면 저절로 남는다. 그 줄이 없는 지시서는 기록하지 않는다. 어느 항목의 단계인지 알 수 없다.
- `중간 과정:` 지시서(CI 고침, 리뷰 반영)로 같은 항목에 다시 띄워도 한 줄이 더 남는다. 같은 단계가 이미 띄워진 것이라 판정은 달라지지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/auto-advance.ts` 에 `recordStepLaunch` 를 더한다

```ts
// 그 항목의 첫 미완료 단계가 [auto] 면 한 줄을 남기고 true. 아니면 남기지 않고 false
export function recordStepLaunch(repo: string, item: string, dispatch: string, branch: string | null): boolean
```

`step-launches.ts` 가 아니라 `auto-advance.ts` 에 둔다. `auto-advance.ts` 가 이미 `step-launches.ts` 를 가져오므로 반대 방향으로 가져오면 두 파일이 서로를 가져오게 된다.

보드 파일(`boardPath(repo)`)이 없으면 `false` 다. 있으면 `readBoard` 로 읽어 항목을 찾고 `firstPendingStep` 을 구한다. 표시가 `'auto'` 면 `appendStepLaunch(repo, { item, number: <단계 번호>, step: <단계의 key>, dispatch, branch })` 를 부른다. 항목이 없거나 단계가 없거나 표시가 다르면 `false` 다. 읽기나 쓰기가 실패하면 던진다.

### 2. `launch-worker.ts` 와 `send-to-worker.ts` 가 기록을 남긴다

두 곳 모두 `registerBoard` 를 부르는 `try` **앞에** 따로 `try` 를 두고 아래를 한다.

- `boardIdOf(<지시서 글>)?.id` 가 있으면 `recordStepLaunch(repo, id, dispatch, <브랜치>)` 를 부른다. 브랜치는 `launch-worker.ts` 에서 `common.branch`, `send-to-worker.ts` 에서 `launch.branch` 이고 비었으면 `null` 이다. 보드 잇기가 실패해 항목의 필드가 비어도 이 브랜치로 그 단계의 열린 PR 을 찾는다.
- 던지면 stderr 에 `<스크립트 이름>: 띄운 단계 기록을 남기지 못했다: <이유>` 한 줄을 남긴다. 종료 코드는 바꾸지 않고 다음 일(`registerBoard`)을 그대로 한다.
- `launch-worker.ts` 는 시작 확인이 늦은 경우(`stalled`)에도 남긴다. `registerBoard` 와 같은 조건이다.

### 3. 이 phase 를 검증하는 테스트

`skills/orch/tests/launch-worker.spec.ts` 수정:

- 보드에 `{ id: 'board-id', status: 'doing', details: [{ text: '1. PR1', done: true }, { text: '2. [auto] PR2 (계획: docs/p)', done: false }] }` 를 두고 `보드 항목 id: \`board-id\`` 지시서로 띄우면, 상태 폴더의 `step-launches.jsonl` 에 `item` 이 `board-id`, `number` 가 2, `step` 이 `2. [auto] PR2 (계획: docs/p)`, `dispatch` 가 `ctx_1`, `branch` 가 그 worker 의 브랜치인 줄이 하나 생긴다.
- 첫 미완료 단계에 표시가 없거나 `[ask]` 인 항목으로 띄우면 파일이 생기지 않는다.
- 지시서에 `보드 항목 id:` 줄이 없으면 파일이 생기지 않는다.
- 보드 파일이 없는 저장소에서 띄워도 종료 코드가 0 이고 파일이 생기지 않는다.
- 보드 잇기 실패: 보드 명령이 실패하게 해도(환경 변수 `BOARD_BIN` 에 0 이 아닌 코드로 끝나는 가짜 명령을 준다. 단계 목록 읽기 `steps` 만 실제 도구로 넘긴다) 띄운 기록은 남는다.
- 기록 실패: 상태 폴더에 `step-launches.jsonl` 이라는 이름의 폴더를 미리 만들어 덧붙이기가 실패하게 한다. 종료 코드가 0 이고 `LAUNCHED` 줄이 나오며 stderr 에 `띄운 단계 기록을 남기지 못했다` 가 있고, 보드 항목은 지금처럼 doing 으로 이어진다.

`skills/orch/tests/lib-step-launches.spec.ts` 수정: `recordStepLaunch` 가 `[auto]` 항목에서 `true` 와 한 줄을 남긴다. 그 줄 끝에 `(#700 merge)` 꼬리표가 있으면 `step` 에 꼬리표를 뗀 글이 남는다. 표시 없는 항목과 없는 항목에서 `false` 다.

`skills/orch/tests/send-to-worker.spec.ts` 수정: 후속 지시서(`--spec`)의 `보드 항목 id:` 가 가리키는 항목의 첫 미완료 단계가 `[auto]` 면 새 dispatch 로 한 줄이 남는다. 이 파일에 후속 지시서로 보드 항목을 갱신하는 기존 사례가 있으면 그 사례의 보드에 `[auto]` 줄을 둔 사례를 옆에 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/lib-step-launches.spec.ts skills/orch/tests/board-auto-check.spec.ts
node scripts/run-tests.ts --tsc-only
```

두 명령 모두 종료 코드 0 이어야 한다. `board-auto-check.spec.ts` 는 고치지 않고 통과해야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/auto-advance.ts` | 수정 (`recordStepLaunch`) |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 (띄운 기록 남기기) |
| `skills/orch/scripts/worker/send-to-worker.ts` | 수정 (띄운 기록 남기기) |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 (새 사례) |
| `skills/orch/tests/send-to-worker.spec.ts` | 수정 (새 사례) |
| `skills/orch/tests/lib-step-launches.spec.ts` | 수정 (새 사례) |
