# Phase 02. worker 터미널 판정을 공용 모듈로 옮기기

**Execution profile**: standard

## 목표

`hooks/block-worker-terminal-send.ts` 안의 「이 터미널이 어느 Run 의 worker 인가」 조회를 `lib/worker-terminal.ts` 로 옮겨, `check` 가 같은 규칙으로 승인 신호를 보낸 터미널을 판정하게 한다.

**범위 외**: hook 의 판정과 거부 문구 바꾸기, `check` 명령(phase 03), 창의 `self`(PR2).

## 컨텍스트

**요구사항**: REQ10

**근거 문서**: `docs/features/board-approval/design.md` 「책임과 경계」 의 `lib/worker-terminal.ts`, 결정 DECISION5, 스펙 DECISION21

- 지금 조회는 `skills/orch/hooks/block-worker-terminal-send.ts` 머리 주석 「worker 판정 범위」 1~5단계다. 관련 함수는 `orcaResult`, `nextCursor`, `workerPage`, `scanWorkers`, `runIds`, `scanRuns`, `lookupWorkers`, 상수 `LIVE_STATES` 이고 `lib/worker-run-cache.ts` 의 `WorkerRunCache` 를 쓴다. `hasAgent`(terminal show)와 `send-hook-cache.json` 기억, 첫 화면 승인(`firstScreenProblem`)은 hook 고유라 hook 에 남긴다.
- hook 은 7초 한도(`budgetMs`)를 호출마다 남은 시간으로 넘긴다. 옮긴 함수는 남은 시간을 인자로 받거나 기한(`deadline` epoch ms)을 받아, hook 의 시간 한도 동작이 그대로이게 한다.
- 판정 꼴이 둘이다(설계 「worker 판정 꼴」). hook 꼴은 `active` 와 `LIVE_STATES`, approval 꼴은 여기에 `released` 를 더한다. approval 꼴은 `agentIdentity` 지름길과 `send-hook-cache.json` 기억을 쓰지 않는다. 둘 다 hook 쪽에만 있는 것이라 이 모듈로 옮기지 않으면 저절로 그렇게 된다. `add`, `cancel`, `check`, 그리고 PR2 의 `self`, `press` 가 approval 꼴을 쓴다.

## 의도 메모

- 기각: `check` 에서 `worker-list` 를 Run 없이 한 번만 부르기. `worker-list --help` 에 따르면 Run 에 묶인 터미널(코디네이터)에서 부르면 그 Run 만 본다. 다른 Run 의 worker 를 놓친다.
- 기각: hook 을 그대로 두고 `check` 에 조회 사본을 두기. 같은 규칙 두 벌이 어긋난다.
- released 행은 많다(머리 주석의 실측: 2243행). `check` 는 hook 처럼 7초 한도가 없지만 오래 걸릴 수 있다. phase 04 의 실측에서 걸린 시간을 잰다.

## 작업 항목

### 1. `skills/orch/scripts/lib/worker-terminal.ts` 신규

지금 `lookupWorkers`(357~376행)는 active 조회 → hook 고유 단계(기억 파일로 건너뛰기, `hasAgent` 로 빼기) → 남은 상태 조회 → scope 가 `all` 이 아니면 Run 마다 조회 차례로 돈다. hook 고유 단계가 사이에 끼어 있으므로 공용 API 는 두 단계로 나눈다.

```ts
export const ACTIVE_STATE = 'active'
export const LIVE_STATES = ['reclaimable', 'release_unknown', 'release_pending', 'retained'] as const
export type WorkerHit = { handle: string; dispatchId: string | null; run: string | null }
export const APPROVAL_STATES = [ACTIVE_STATE, ...LIVE_STATES, 'released'] as const
export type LookupOptions = { states: readonly string[]; deadline?: number; cache?: WorkerRunCache }
export type LookupStats = { queries: number; completed: number; lastQuery: string; runTotal: number; runsRead: number }
export type LookupFailure = { ok: false; error: string; timeout: boolean; stats: LookupStats }
// 1단계: active 조회. scope.source(flag, bound, all)를 함께 낸다
export async function activeWorkers(handles: string[], options: { deadline?: number }):
  Promise<{ ok: true; found: Map<string, WorkerHit>; scope: string; stats: LookupStats } | LookupFailure>
// 남은 handle: states 의 상태별 조회(3단계), scope 가 all 이 아니면 Run 마다 조회(5단계)
export async function remainingWorkers(handles: string[], scope: string, options: LookupOptions):
  Promise<{ ok: true; found: Map<string, WorkerHit>; stats: LookupStats } | LookupFailure>
// approval 꼴: activeWorkers 뒤 남은 handle 전부를 remainingWorkers(states: APPROVAL_STATES)에 넘긴다
export async function lookupWorkerTerminals(handles: string[], options: LookupOptions):
  Promise<{ ok: true; found: Map<string, WorkerHit> } | LookupFailure>
```

- `states` 는 3단계의 상태별 조회에만 쓴다. 5단계의 `worker-list --run <id>` 는 지금처럼 상태로 고르지 않고 모든 행을 본다. 상태로 고르면 hook 동작이 바뀐다.
- `deadline` 이 없으면 기본 30초 뒤를 기한으로 둔다. 기한이 없는 조회가 멈춰 `check` 가 끝나지 않는 일을 막는다. hook 의 `budgetMs` 계산을 그대로 옮기면 기한이 없을 때 NaN 이 되므로 기본값을 먼저 정한다.
- `timeout` 과 `stats` 는 hook 의 `REASON.timeout`, `REASON.failed` 구분과 그 문구가 쓰는 카운터(`queries`, `completed`, `lastQuery`, `runTotal`, `runsRead`)를 그대로 옮긴 것이다. 지금 모듈 전역에 있는 카운터는 이 모듈의 호출별 값으로 바꾼다.

판정 차례와 실패 분류(종료 코드, JSON 꼴, `result.workers`/`result.runs` 꼴)는 hook 머리 주석 그대로다. `runAsync` 만 쓴다(머리 주석 「조회는 runAsync 로만 한다」). 파일 머리 주석에 판정 범위를 옮기고 hook 머리 주석은 이 파일을 가리키게 줄인다.

### 2. `skills/orch/hooks/block-worker-terminal-send.ts` 수정

조회 함수를 지우고 `activeWorkers` → (hook 고유: 기억 파일, `hasAgent`) → `remainingWorkers(남은 handle, scope, { states: LIVE_STATES, deadline })` 차례로 부른다. 실패의 `timeout` 과 `stats` 로 지금 거부 문구를 그대로 만든다. 첫 화면 승인과 거부 문구는 바꾸지 않는다.

### 3. 테스트

- `skills/orch/tests/coordinator-hooks.spec.ts` 는 고치지 않고 통과해야 한다(hook 판정이 같다는 증거).
- `skills/orch/tests/lib-worker-terminal.spec.ts` 신규: `PATH` 앞에 가짜 `orca` 를 두는 `coordinator-hooks.spec.ts` 의 방식으로 본다. 가짜 응답의 scope 를 `all` 로 두고, released 상태에만 있는 터미널을 `states` 에 released 를 넣었을 때만 찾는다. scope 가 `bound` 면 Run 마다 조회가 released 행도 찾는다(5단계는 상태로 고르지 않는다). 기한을 넘긴 가짜 orca 에는 `timeout: true` 다. 다른 Run 에 묶인 worker 를 `run-list` 뒤 Run 마다 조회로 찾는다. `worker-list` 가 0 이 아닌 코드로 끝나면 `ok: false`.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/coordinator-hooks.spec.ts skills/orch/tests/lib-worker-terminal.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/worker-terminal.ts` | 신규 |
| `skills/orch/hooks/block-worker-terminal-send.ts` | 수정 (조회를 옮김) |
| `skills/orch/tests/lib-worker-terminal.spec.ts` | 신규 |
