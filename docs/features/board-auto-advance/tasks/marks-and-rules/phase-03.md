# Phase 03. 띄워도 되는지의 판정과 켜고 끄는 설정

**Execution profile**: standard

## 목표

`[auto]` 단계를 띄워도 되는지 판정하는 순수 함수를 만든다. 앞 사건이 끝났는지, 그 항목에 이미 worker 나 열린 PR 이 있는지, 거절 이유의 순서가 여기 있다. 저장소 전체를 끄는 설정 `board.auto_advance` 도 읽는다. 보드와 파일, worker 목록을 읽는 일은 phase 04 가 한다.

**범위 외**: 파일과 Orca, gh 읽기, 명령. 사용 한도 확인(다음 PR). `judgeAdvance` 에 한도 입력을 미리 만들지 않는다.

## 컨텍스트

- `core/` 의 규칙은 `skills/orch/tests/core-boundary.spec.ts` 가 검사한다. `core/` 안의 파일과 `node:path`, `node:crypto` 만 가져올 수 있다. 줄의 표시와 줄 끝 사건 꼬리표를 읽는 파일(`extensions/work-board/hooks/`)은 가져올 수 없으므로, 호출자가 미리 읽은 값을 받는다.
- 사건 이름과 `stages` 필드의 타입은 `skills/orch/scripts/core/milestones.ts` 의 `StageKind`, `Stages` 다.
- 「그 항목에 살아 있는 worker 가 있는가」 는 지금 `skills/orch/scripts/core/movement.ts` 의 `stalledStages` 안에 있다. 살아 있는 dispatch 의 워크트리 경로 집합(`live`)과 `{브랜치: 워크트리 경로}`(`branches`)를 받아, 항목의 `worktree` 필드(이름이나 경로의 끝 이름)가 살아 있는 워크트리의 끝 이름과 같거나 `branch` 필드의 워크트리 경로가 `live` 에 있으면 worker 가 있는 것으로 본다(`liveNames`, `byBranch` 를 쓰는 줄).
- 설정 절의 아는 키는 `skills/orch/scripts/core/config.ts` 의 `BOARD_KEYS` 이고, 절은 같은 파일의 `section(config, 'board', BOARD_KEYS)` 로 꺼낸다. 모르는 키가 있으면 `ConfigError` 다. board 절의 다른 값은 `core/milestones.ts` 의 `boardSettingsFromConfig` 가 읽는다. 이 함수와 `BoardSettings` 타입은 고치지 않는다.

**요구사항**: REQ3, REQ9, REQ11

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md` 「`orch board auto-check <항목>`」, 「설정」

## 의도 메모

- `board.auto_advance` 를 `boardSettingsFromConfig` 에 넣지 않는다. 넣으면 이 값 하나가 틀렸을 때 보드 동기화의 머지 반영과 띄울 때의 보드 잇기까지 함께 실패한다(설계 DECISION16).
- 근거가 여럿이면 모두 맞아야 한다. 하나라도 틀리면 그 이유로 거절한다.
- 거절 이유는 고정된 글이다. 코디네이터 규칙 문서(phase 06)가 이유마다 할 일을 적고 문서 테스트가 이 상수를 읽으므로, 글을 바꾸면 문서도 함께 바꾼다.
- 진행 중인지를 띄운 기록보다 먼저 본다. 띄운 worker 가 일하는 동안에는 「진행 중」 이 맞는 답이고, 「이미 띄웠다」 는 worker 도 PR 도 없을 때만 나와야 한다.

## 작업 항목

### 1. `skills/orch/scripts/core/movement.ts` 에서 worker 고르기를 함수로 뗀다

`stalledStages` 안의 「그 항목의 워크트리에 살아 있는 dispatch 가 있는가」 판정을 아래 함수로 떼고 `stalledStages` 가 그것을 부르게 한다. 동작은 그대로다.

```ts
// 항목의 worktree(이름)나 branch 의 워크트리에 살아 있는 dispatch 가 있는가
export function liveWorkerOn(item: { worktree: string | null; branch: string | null }, live: ReadonlySet<string>, branches: ReadonlyMap<string, string>): boolean
```

### 2. `skills/orch/scripts/core/auto-advance.ts` 신규

```ts
import type { StageKind, Stages } from './milestones.ts'

export type BoardView = {
  pr: string[]        // pr 필드의 PR 번호들
  mergedPr: string[]  // merged-pr 필드의 PR 번호들
  stages: Stages | null
  steps: Array<{ number: number; done: boolean; tag: { pr: string; event: string } | null }>
}

// 보드의 어느 항목에든 그 PR 의 그 사건이 끝났다는 줄이 있는가
export function eventDone(items: BoardView[], pr: string, event: StageKind): boolean
```

`eventDone` 은 어느 항목에서든 아래 중 하나면 참이다.

- `done` 이고 `tag` 가 그 `pr` 과 `event` 인 단계가 있다(사건 넷 모두).
- `event` 가 `'merge'`: `mergedPr` 에 그 `pr` 이 있다. `stages` 는 보지 않는다. `merged-pr` 필드는 스크립트가 gh 로 머지를 확인한 뒤에만 쓴다.
- `event` 가 `'pr'`: `pr` 이나 `mergedPr` 에 그 `pr` 이 있고 `stages.pr` 번호 단계가 `done` 이다.
- `event` 가 `'deploy'` 나 `'release'`: `pr` 과 `mergedPr` 을 합친 번호가 그 `pr` 하나뿐이고 `stages[event]` 번호 단계가 `done` 이다. PR 이 여럿인 항목은 이 길로 참이 되지 않는다.

```ts
// 그 항목의 그 단계가 진행 중인가(살아 있는 worker 나 열린 PR). launches 는 그 단계의 띄운 기록, openPrs 는 열린 PR 의 번호와 head 브랜치다
export function itemBusy(
  item: { worktree: string | null; branch: string | null; pr: string[] },
  launches: ReadonlyArray<{ dispatch: string; branch: string | null }>,
  live: { paths: ReadonlySet<string>; dispatches: ReadonlySet<string> },
  branches: ReadonlyMap<string, string>,
  openPrs: ReadonlyArray<{ number: string; branch: string }>,
): boolean
```

`itemBusy` 는 아래 중 하나면 참이다.

- `liveWorkerOn(item, live.paths, branches)` 가 참이다.
- `launches` 가운데 `dispatch` 가 `live.dispatches` 에 있는 것이 있다. 보드 잇기가 실패해 항목의 worktree·branch 필드가 비어 있어도 띄운 worker 가 살아 있으면 진행 중이다.
- 열린 PR 가운데 번호가 항목의 `pr` 에 있는 것이 있다.
- 열린 PR 가운데 head 브랜치가 항목의 `branch`, 항목의 `worktree` 이름으로 알 수 있는 브랜치(`branches` 의 값 가운데 끝 이름이 같은 경로의 키), `launches` 의 `branch` 가운데 하나와 같은 것이 있다.

```ts
export const ADVANCE_REASONS = {
  off: '자동 진행이 꺼져 있다',
  noItem: '항목이 없다',
  status: '상태가 doing 이나 wait 가 아니다',
  notAuto: '첫 미완료 단계가 [auto] 가 아니다',
  busy: 'worker 나 열린 PR 이 있다',
  unknownBusy: 'worker 나 PR 을 확인하지 못했다',
  launched: '이미 한 번 띄웠다',
  noEvidence: '근거가 없다',
  noSpec: '스펙 파일이 없다',
  unconfirmed: '스펙에 확인 줄이 없다',
  noPlan: '계획 파일이 없다',
  eventPending: '앞 사건이 끝나지 않았다',
} as const

export type AdvanceInput = {
  autoAdvance: boolean
  status: string | null   // 항목이 없으면 null
  step: { number: number; mark: 'auto' | 'ask' | 'wait' | null } | null   // 첫 미완료 단계. 없으면 null
  busy: boolean | null    // itemBusy 의 결과. 확인하지 못했으면 null
  launched: boolean       // 같은 항목, 같은 단계 글로 띄운 기록이 하나 이상 있는가
  evidence: Array<{ text: string; problem: string | null }>   // 근거마다의 확인 결과
}
export type AdvanceVerdict =
  | { ok: true; number: number; evidence: string }
  | { ok: false; number: number | null; reason: string }

export function judgeAdvance(input: AdvanceInput): AdvanceVerdict
```

`judgeAdvance` 는 아래 순서로 처음 걸린 이유를 낸다.

| 순서 | 조건 | `reason` | `number` |
| --- | --- | --- | --- |
| 1 | `autoAdvance` 가 `false` | `off` | `null` |
| 2 | `status` 가 `null` | `noItem` | `null` |
| 3 | `status` 가 `doing` 도 `wait` 도 아니다 | `status` | `null` |
| 4 | `step` 이 `null` 이거나 `mark` 가 `'auto'` 가 아니다 | `notAuto` | 단계 번호 또는 `null` |
| 5 | `busy` 가 `null` | `unknownBusy` | 단계 번호 |
| 6 | `busy` 가 `true` | `busy` | 단계 번호 |
| 7 | `launched` | `launched` | 단계 번호 |
| 8 | `evidence` 가 비었다 | `noEvidence` | 단계 번호 |
| 9 | `problem` 이 있는 근거가 있다 | 처음 걸린 근거의 `problem` | 단계 번호 |

모두 지나면 `{ ok: true, number, evidence: <근거 text 를 ', ' 로 이은 글> }` 이다.

```ts
import type { Config } from './config.ts'
// board.auto_advance. 없으면 true. boolean 이 아니면 ConfigError('설정 파일의 board.auto_advance 는 true 나 false 다')
export function autoAdvanceOf(config: Config): boolean
```

### 3. `skills/orch/scripts/core/config.ts` 의 `BOARD_KEYS`

`'auto_advance'` 를 더한다. 이 키가 없으면 `section` 이 「모르는 키」 로 거절한다.

### 4. 이 phase 를 검증하는 `skills/orch/tests/core-auto-advance.spec.ts` 신규

- `eventDone`
  - 끝난 꼬리표 줄이 있으면 참, 같은 줄이 끝나지 않았으면 거짓. 다른 항목의 줄로도 참이 된다.
  - `mergedPr` 에 `665` 가 있으면 `stages` 가 `null` 이어도 `merge` 가 참. `665` 가 `pr` 필드에만 있으면 `merge` 는 거짓이다. 그 항목의 `stages` 가 `{ pr: 1, merge: 2 }` 이고 1번이 끝났으면 `pr` 은 참.
  - `stages` 가 `{ merge: 2, deploy: 3 }` 이고 3번이 끝난 항목: `mergedPr` 이 `['665']` 뿐이면 `deploy` 가 참, `['664', '665']` 면 거짓.
- `itemBusy`: worktree 이름이 살아 있는 경로의 끝 이름과 같으면 참, branch 의 워크트리 경로가 `live.paths` 에 있으면 참, 열린 PR 번호가 `pr` 에 있으면 참, 열린 PR 의 head 브랜치가 `branch` 와 같으면 참. worktree 와 branch 가 모두 `null` 이고 `pr` 이 빈 항목(보드 잇기가 실패한 꼴)은 `launches` 가 비었으면 거짓, `launches` 의 dispatch 가 `live.dispatches` 에 있으면 참, `launches` 의 브랜치에 열린 PR 이 있으면 참이다.
- `judgeAdvance`: 표의 아홉 줄을 한 사례씩, 앞 조건이 뒤 조건보다 먼저 걸리는 사례 셋(꺼져 있으면서 근거도 없음 → `off`, 진행 중이면서 이미 띄움 → `busy`, 이미 띄웠으면서 근거가 틀림 → `launched`), 통과 사례 하나(`evidence` 글이 `계획: a, 앞 사건: #665 merge`).
- `autoAdvanceOf`: 절이 없으면 `true`, `{ board: { auto_advance: false } }` 는 `false`, `'no'` 와 `0` 은 `ConfigError`.

`skills/orch/tests/lib-movement.spec.ts` 는 고치지 않고 통과해야 한다(함수를 뗐을 뿐이다).

### 5. `skills/orch/tests/lib-milestones.spec.ts` 에 사례 하나를 더한다

`board: { auto_advance: 'no' }` 인 설정에서도 `boardSettings(repo)` 가 던지지 않고 지금과 같은 값을 돌려준다. `board: { auto_advance: false }` 도 같다. 이 값의 검사를 `boardSettingsFromConfig` 에 넣으면 이 사례가 깨진다(설계 DECISION16). 기존 사례는 고치지 않는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-auto-advance.spec.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/lib-milestones.spec.ts skills/orch/tests/lib-config.spec.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/stalled-workers.spec.ts
node scripts/run-tests.ts --tsc-only
```

두 명령 모두 종료 코드 0 이어야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/auto-advance.ts` | 신규 |
| `skills/orch/tests/core-auto-advance.spec.ts` | 신규 |
| `skills/orch/scripts/core/movement.ts` | 수정 (`liveWorkerOn` 을 떼어 내보낸다) |
| `skills/orch/scripts/core/config.ts` | 수정 (`BOARD_KEYS` 에 `auto_advance`) |
| `skills/orch/tests/lib-milestones.spec.ts` | 수정 (새 키가 board 절의 다른 값 읽기를 깨지 않는 사례) |
