# Phase 01. 누름 기록의 순수 규칙과 기록·신호 보내기

**Execution profile**: standard

## 목표

「승인」·「고쳐 달라」 를 눌렀을 때 승인 파일에 기록을 쓰고, 올린 Run 으로 신호를 보내고, 보내지 못하면 되돌리는 코드를 만든다. 승인 상태를 만드는 곳이 한 줄기로 이어지게 하려는 것이다.

**범위 외**: 창 전용 스크립트의 인자 풀이(phase 02), 창 그리기(phase 03), hook(phase 02).

## 컨텍스트

**요구사항**: REQ2(지금 버전이 아닌 버튼은 기록도 신호도 없다), REQ4(승인 기록을 쓰는 길), REQ6(신호와 되돌리기), REQ7(고쳐 달라 글)

**근거 문서**: `docs/features/board-approval/spec.md`, `docs/features/board-approval/design.md` 「창이 부르는 스크립트」 의 `press` 차례, 「실패와 일관성」, `docs/adr/028-orch-core-layer.md`

- `skills/orch/scripts/core/approvals.ts` 는 순수 함수만 둔다. 시각은 인자로 받는다. `Press` 타입은 이미 있다(`{ action, terminal, origin, at, nonce }`).
- `skills/orch/scripts/lib/approvals.ts` 의 `updateApprovals(repo, change)` 가 잠금 안에서 읽고 쓴다. `selfIsWorker()` 는 자기 `ORCA_TERMINAL_HANDLE` 을 released 까지 읽어 판정한다(변수가 없으면 `false`, 조회 실패는 `null`).
- 신호 보내기는 `lib/run-notice.ts` 의 `notifyRun` 과 같은 `orcaJson(['orchestration', 'send', '--to', 'run:<Run>', '--type', 'status', '--subject', ..., '--body', ..., '--payload', ...])` 꼴이다. `--from` 은 주지 않는다. Orca 가 보낸 쪽을 프로세스의 터미널로 정하고, 터미널에서는 `--from run:` 이 거부되기 때문이다(`core/message-fields.ts` 머리 주석의 2026-11-10 실측).
- `core/approvals.ts` 의 `signalMatches` 가 읽는 payload 꼴이 `{source: 'board-approval', action: 'approve', id, version, nonce}` 다. 승인 신호 payload 는 이 꼴을 그대로 쓴다. 고쳐 달라 신호는 `action: 'revise'` 로 같은 칸을 쓴다.

## 의도 메모

- 기록(2단계)을 먼저 쓰고 신호를 보낸다. 보낸 뒤 기록을 다시 쓰지 않는다(설계 DECISION4). 코디네이터가 신호를 받자마자 `check` 를 불러도 nonce 가 이미 있다.
- 되돌리기는 기록이 아직 자기가 쓴 `press.nonce` 일 때만 한다. 그 사이 다른 쓰기가 같은 기록을 바꿨으면 건드리지 않는다.
- 상태 값 `revise`, `approved` 는 `core/approvals.ts` 에서만 만든다(`board-approval-static.spec.ts`). 창과 스크립트는 동작 이름 `approve`, `revise` 만 다룬다. 정적 테스트는 `revise` 를 상태로 쓰는 줄(같은 줄에 `state` 가 있는 줄)만 잡도록 phase 04 에서 좁힌다.

## 작업 항목

### 1. `skills/orch/scripts/core/approvals.ts` 에 `applyPress`, `revertPress`

```ts
export type PressInput = { id: string; version: number; action: 'approve' | 'revise'; terminal: string | null; origin: string; nonce: string; note: string | null }
export type PressRefusal = '내용이 바뀌었어요' | '다른 창에서 이미 눌렀어요' | '코디네이터가 거뒀어요' | '대기가 없어요' | '고칠 내용이 비었어요' | '직접 실행하는 대기예요'
export function applyPress(file: ApprovalFile, input: PressInput, now: Date): { file: ApprovalFile; entry: Approval } | { refusal: PressRefusal }
export function revertPress(file: ApprovalFile, id: string, version: number, nonce: string): { file: ApprovalFile } | { skipped: true }
```

- `applyPress`: 그 id 의 가장 늦은 기록(`latest`)을 본다. 없으면 「대기가 없어요」. 버전이 다르면 「내용이 바뀌었어요」(스펙 REQ2 의 toast 글은 창이 붙인다). 버전이 같고 `open` 이 아니면 `cancelled` 는 「코디네이터가 거뒀어요」, 나머지는 「다른 창에서 이미 눌렀어요」. `command` 종류는 「직접 실행하는 대기예요」. 고쳐 달라이고 `note` 가 공백뿐이면 「고칠 내용이 비었어요」. 통과하면 `state`(승인 또는 고쳐 달라), `closedAt = now`, `press = { action, terminal, origin, at, nonce }`, `note`(고쳐 달라일 때 trim 한 글)를 쓴다.
- `revertPress`: 같은 버전 기록이 승인이나 고쳐 달라 상태이고 `press.nonce` 가 같을 때만 `open` 으로 되돌리고 `press`, `closedAt`, `note` 를 `null` 로 지운다. 아니면 `{ skipped: true }`.

### 2. `skills/orch/scripts/lib/approvals.ts` 에 `recordPress`

```ts
export type PressRequest = { id: string; version: number; action: 'approve' | 'revise'; note: string | null; origin: string }
export type PressOutcome = { ok: true; messageId: string } | { ok: false; reason: string }
export async function recordPress(repo: string, request: PressRequest): Promise<PressOutcome>
```

차례(설계 「창이 부르는 스크립트」 의 `press` 1~5단계):

1. 자기 `ORCA_TERMINAL_HANDLE` 이 있으면 `selfIsWorker()` 로 판정한다. `true` 면 「worker 터미널에서는 누를 수 없어요」, `null` 이면 「worker 터미널인지 확인하지 못했어요」 로 거절한다. 변수가 없으면 지나가고 `press.terminal` 은 `null` 이다.
2. `updateApprovals` 안에서 `applyPress`(nonce 는 `randomUUID()`)를 부른다. 거절이면 그 이유로 끝난다(기록도 신호도 없다).
3. 잠금 밖에서 `orcaJson` 으로 신호를 보낸다. 제목 `APPROVED <id> <버전>` 또는 `REVISE <id> <버전>`, 본문은 제목, `then`, 미리보기 경로, 고쳐 달라 글을 줄로 이은 글, payload 는 위 꼴이다. 받는 곳은 기록의 `run` 이다.
4. 보내기가 실패하면 `updateApprovals` 안에서 `revertPress` 를 부른다. 되돌리기도 실패(잠금 시간 초과 등)하면 이유를 「승인 기록을 되돌리지 못했어요. 코디네이터에게 다시 올려 달라고 하세요」 로 낸다.
5. 성공하면 기록을 다시 쓰지 않고 메시지 id 를 낸다. 영수증에서 메시지 id 를 읽는 방식은 `lib/run-notice.ts` 의 `notifyRun` 과 같다.

### 3. `skills/orch/tests/approval-press.spec.ts` 신규

- `applyPress`: 열린 v3 에 승인 → 승인 상태와 `press` 기록. 같은 id 의 v2 로 누르면 「내용이 바뀌었어요」이고 파일이 그대로다(REQ2). 이미 승인된 기록에 다시 누르면 「다른 창에서 이미 눌렀어요」. 취소된 기록은 「코디네이터가 거뒀어요」. `command` 는 「직접 실행하는 대기예요」. 공백 글의 고쳐 달라는 「고칠 내용이 비었어요」(REQ7).
- `revertPress`: nonce 가 같으면 `open` 으로 돌아오고 `press`, `note`, `closedAt` 이 비며, 다른 nonce 나 사용함 기록이면 건드리지 않는다.
- `recordPress` 를 임시 저장소와 가짜 orca(`fakeBin`, `board-approval.spec.ts` 방식)로 부른다. 가짜 orca 가 worker 목록을 비워 주면: 승인 → 기록이 승인 상태, 보낸 인자에 `--to run:<Run>`, 제목 `APPROVED <id> <버전>`, payload 의 nonce 가 기록의 nonce 와 같다. 고쳐 달라 → 제목 `REVISE`, 본문에 글. 가짜 orca 의 `send` 가 실패하면 기록이 `open` 으로 돌아온다. worker 터미널이면 거절하고 기록이 그대로다. 지금 버전이 아니면 `send` 를 한 번도 부르지 않는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/approval-press.spec.ts skills/orch/tests/core-approvals.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/approvals.ts` | 수정 (`applyPress`, `revertPress`) |
| `skills/orch/scripts/lib/approvals.ts` | 수정 (`recordPress`) |
| `skills/orch/tests/approval-press.spec.ts` | 신규 |
