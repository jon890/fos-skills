# Phase 02. 근거 괄호를 읽고, 근거의 PR 번호가 줄을 끝내지 않게 한다

**Execution profile**: standard

## 목표

`[auto]` 단계 줄에 적는 근거 괄호(`(스펙: …)`, `(계획: …)`, `(앞 사건: #N 사건)`)를 읽는 순수 함수를 만든다. 그리고 줄 글의 `#N` 으로 줄을 끝내는 기존 함수가 근거 괄호 안의 번호를 세지 않게 고친다. 고치지 않으면 `4. [auto] PR4 (앞 사건: #665 merge)` 가 #665 머지 때 띄우기도 전에 끝난다(스펙 REQ2 의 인수 조건).

**범위 외**: 근거가 맞는지 확인하는 일(phase 03 의 판정, phase 04 의 파일 읽기). 줄 끝 사건 꼬리표 `(#N 사건)` 의 동작은 바꾸지 않는다.

## 컨텍스트

- orch 의 `skills/orch/scripts/core/` 는 순수 계층이다. `core/` 안의 파일과 `node:path`, `node:crypto` 만 가져올 수 있고 `process`, `Date.now()`, 인자 없는 `new Date()` 를 쓰지 못한다. `skills/orch/tests/core-boundary.spec.ts` 가 검사하고, `core-*.spec.ts` 이름의 테스트도 실행 환경에 기대지 못한다.
- 줄 글의 PR 번호로 줄을 고르는 함수는 `skills/orch/scripts/core/board.ts` 의 `prSteps(steps, pr)` 다. 끝나지 않은 단계 가운데 글에 `#<pr>`(뒤에 숫자가 이어지지 않는 것)가 있는 단계의 번호를 낸다. 같은 파일의 `intermediateCommands` 와 `skills/orch/scripts/board/board-sync.ts` 의 직접 쓴 항목(`stages` 필드가 없다) 처리가 부른다. `skills/orch/scripts/queue/finish-pr.ts` 의 `setBoardIntermediate` 는 `intermediateCommands` 를 거친다.
- 사건 이름 타입은 `skills/orch/scripts/core/milestones.ts` 의 `StageKind`(`'pr' | 'merge' | 'deploy' | 'release'`)이고 값 목록은 `STAGE_KINDS` 다. `core/milestones.ts` 가 `core/board.ts` 를 가져오므로, 새 파일이 `milestones.ts` 의 값을 가져오고 `board.ts` 가 새 파일을 가져오면 서로를 가져오게 된다. 새 파일은 `milestones.ts` 에서 타입만 가져온다(`import type`).
- 보드 동기화 테스트는 `skills/orch/tests/board-sync.spec.ts`, 마무리 테스트는 `skills/orch/tests/finish-pr.spec.ts` 다. 둘 다 임시 보드와 가짜 `gh` 로 스크립트를 돌린다. 직접 쓴 항목의 중간 PR 사례가 이미 있으니 그 사례의 꼴을 따른다.

**선행 조건**: 보드 명령 구현(`docs/features/orch-board-cli/` 의 설계가 정한 「마지막 PR 과 남은 단계」)이 직접 쓴 항목의 마지막 PR 처리를 「그 PR 번호가 적힌 줄만 끝낸다」 로 바꾼 뒤에 시작한다. 이 phase 를 시작할 때 `core/board.ts`, `board-sync.ts`, `finish-pr.ts` 의 지금 모습을 다시 읽는다. 보드 명령 구현이 「머지가 가리키는 줄」 을 고르는 함수를 새로 만들었으면 그 함수도 아래 `withoutEvidence` 를 거치게 한다(설계 「보드 명령 설계와 맞출 것」 11번).

**요구사항**: REQ2, REQ10

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md` 「근거 괄호의 PR 번호」

## 의도 메모

- 근거 괄호가 없는 줄은 `prSteps` 의 결과가 지금과 같아야 한다. 기존 테스트를 고치지 않고 통과시킨다.
- 괄호 안에 괄호가 든 경로는 받지 않는다. 경로에 괄호가 필요하면 근거로 읽히지 않고, `auto-check` 가 「근거가 없다」 로 거절한다.

## 작업 항목

### 1. `skills/orch/scripts/core/evidence.ts` 신규

```ts
import type { StageKind } from './milestones.ts'

export type Evidence =
  | { kind: 'spec' | 'plan'; path: string; text: string }
  | { kind: 'event'; pr: string; event: StageKind; text: string }

// 단계 글에서 근거 괄호를 모두 읽는다. 적힌 순서대로 낸다. text 는 괄호 안 글 그대로다(`계획: docs/a`)
export function parseEvidence(body: string): Evidence[]
// 근거 괄호를 모두 뗀 글. 근거 괄호가 없으면 받은 글 그대로다
export function withoutEvidence(text: string): string
```

- `(스펙: <경로>)`, `(계획: <경로>)`: 콜론 앞뒤 공백을 받는다. 경로는 괄호가 없는 글이고 앞뒤 공백을 뗀다. 빈 경로는 근거가 아니다.
- `(앞 사건: #665 merge)`: `#` 은 없어도 된다. 번호는 0 으로 시작하지 않는 수, 사건은 `pr`, `merge`, `deploy`, `release` 중 하나다. 사건 목록은 이 파일에 글자로 적는다(`milestones.ts` 의 값을 가져오지 않는다).
- 줄 끝 사건 꼬리표 `(#665 merge)` 는 근거가 아니다. `withoutEvidence` 가 떼지 않는다.
- `withoutEvidence` 는 `parseEvidence` 가 근거로 읽는 괄호만 뗀다. 두 함수가 같은 정규식을 쓴다.

### 2. `skills/orch/scripts/core/board.ts` 의 `prSteps` 수정

`pattern.test(step.text)` 를 `pattern.test(withoutEvidence(step.text))` 로 바꾼다. `withoutEvidence` 는 `./evidence.ts` 에서 가져온다. 함수의 인자와 반환은 그대로다.

### 3. 이 phase 를 검증하는 테스트

`skills/orch/tests/core-evidence.spec.ts` 신규:

- `parseEvidence`: `PR4 (계획: docs/a/tasks/pr4)` 는 계획 하나, `x (스펙: /abs/spec.md) (앞 사건: #665 merge)` 는 스펙과 앞 사건 둘, `x (앞 사건: 665 deploy)` 는 `#` 없이 읽는다. `x (#665 merge)`, `x (계획: )`, `x (앞 사건: #665 build)`, `x (앞 사건: #0 merge)`, `x (메모: y)` 는 빈 목록이다.
- `withoutEvidence`: `4. [auto] PR4 (앞 사건: #665 merge)` 에서 괄호가 빠지고 `#665` 가 남지 않는다. `3. 머지 (#665 merge)` 와 `2. PR #665 리뷰 반영` 은 그대로다.

같은 파일에 `prSteps`(`core/board.ts`) 사례를 더한다. 지금 이 함수를 직접 부르는 테스트가 없다. `prSteps` 가 `[{ number: 1, done: false, text: '1. PR #665 구현' }, { number: 2, done: false, text: '2. [auto] PR4 (앞 사건: #665 merge)' }]` 에서 `[1]` 만 낸다. 근거 괄호가 없는 줄 `2. PR4 (#665 이어서)` 는 지금처럼 고른다.

`skills/orch/tests/board-sync.spec.ts` 수정: `stages` 필드가 없고 `pr` 필드가 665 인 doing 항목에 위 두 줄을 두고 #665 를 머지된 것으로 답하게 한 뒤 동기화를 돌린다. 1번 줄만 끝나고 2번 `[auto]` 줄은 끝나지 않은 채 남으며 항목이 done 이 되지 않는다.

`skills/orch/tests/finish-pr.spec.ts` 수정: 같은 보드로 중간 PR 마무리(`--intermediate`)를 돌려 2번 줄이 끝나지 않는 것을 본다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-evidence.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

두 명령 모두 종료 코드 0 이어야 한다. `core-boundary.spec.ts` 는 새 core 파일이 금지된 것을 가져오지 않는지 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/evidence.ts` | 신규 |
| `skills/orch/tests/core-evidence.spec.ts` | 신규 |
| `skills/orch/scripts/core/board.ts` | 수정 (`prSteps` 가 근거 괄호를 뗀 글을 본다) |
| `skills/orch/tests/board-sync.spec.ts` | 수정 (새 사례) |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 (새 사례) |
