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
- `check` 는 끝난 worker 도 거절해야 한다(스펙 DECISION21). 그래서 읽을 터미널 상태 목록을 인자로 받는다. hook 은 `active` 와 `LIVE_STATES`, `check` 는 여기에 `released` 를 더한다.

## 의도 메모

- 기각: `check` 에서 `worker-list` 를 Run 없이 한 번만 부르기. `worker-list --help` 에 따르면 Run 에 묶인 터미널(코디네이터)에서 부르면 그 Run 만 본다. 다른 Run 의 worker 를 놓친다.
- 기각: hook 을 그대로 두고 `check` 에 조회 사본을 두기. 같은 규칙 두 벌이 어긋난다.
- released 행은 많다(머리 주석의 실측: 2243행). `check` 는 hook 처럼 7초 한도가 없지만 오래 걸릴 수 있다. phase 04 의 실측에서 걸린 시간을 잰다.

## 작업 항목

### 1. `skills/orch/scripts/lib/worker-terminal.ts` 신규

```ts
export const ACTIVE_STATE = 'active'
export const LIVE_STATES = ['reclaimable', 'release_unknown', 'release_pending', 'retained'] as const
export type WorkerHit = { handle: string; dispatchId: string | null; run: string | null }
export type LookupOptions = { states: readonly string[]; deadline?: number; cache?: WorkerRunCache }
export async function lookupWorkerTerminals(handles: string[], options: LookupOptions):
  Promise<{ ok: true; found: Map<string, WorkerHit> } | { ok: false; error: string }>
```

판정 차례와 실패 분류(종료 코드, JSON 꼴, `result.workers`/`result.runs` 꼴)는 hook 머리 주석 그대로다. `runAsync` 만 쓴다(머리 주석 「조회는 runAsync 로만 한다」). 파일 머리 주석에 판정 범위를 옮기고 hook 머리 주석은 이 파일을 가리키게 줄인다.

### 2. `skills/orch/hooks/block-worker-terminal-send.ts` 수정

조회 함수를 지우고 `lookupWorkerTerminals(handles, { states: [ACTIVE_STATE, ...LIVE_STATES], deadline })` 를 부른다. `hasAgent`, 기억 파일, 첫 화면 승인, 거부 문구는 그대로다.

### 3. 테스트

- `skills/orch/tests/coordinator-hooks.spec.ts` 는 고치지 않고 통과해야 한다(hook 판정이 같다는 증거).
- `skills/orch/tests/lib-worker-terminal.spec.ts` 신규: `PATH` 앞에 가짜 `orca` 를 두는 `coordinator-hooks.spec.ts` 의 방식으로 본다. released 상태에만 있는 터미널을 `states` 에 released 를 넣었을 때만 찾는다. 다른 Run 에 묶인 worker 를 `run-list` 뒤 Run 마다 조회로 찾는다. `worker-list` 가 0 이 아닌 코드로 끝나면 `ok: false`.

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
