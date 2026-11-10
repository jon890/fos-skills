# Phase 01. 승인 대기의 순수 규칙(core)

**Execution profile**: standard

## 목표

승인 파일의 꼴, 상태 바꾸기, `check` 판정, 7일 정리, 출력 줄을 파일과 프로세스를 모르는 순수 함수로 만든다. 뒤 phase 의 명령과 PR2 의 창 스크립트가 같은 규칙을 쓰게 하려는 것이다.

**범위 외**: 파일 읽기와 쓰기, 잠금, Orca 조회(phase 03), worker 터미널 판정(phase 02), 창(PR2).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ10, REQ11

**근거 문서**: `docs/features/board-approval/spec.md`, `docs/features/board-approval/design.md` 「인터페이스와 데이터」, 「신호와 `check` 의 판정」, `docs/adr/028-orch-core-layer.md`

- `skills/orch/scripts/core/` 는 순수 판정만 둔다(ADR-028). node 내장 모듈 가운데 파일, 프로세스, 네트워크를 쓰는 것은 import 하지 않는다. `skills/orch/tests/core-boundary.spec.ts` 가 이것을 본다.
- `core/message-fields.ts` 는 Orca 메시지 필드 이름이 명령마다 다른 것을 흡수한다(파일 머리 주석). 같은 방식으로 함수 둘을 더한다.

## 의도 메모

- 버전은 id 별 번호가 아니라 파일 전체의 `seq` 다(설계 DECISION2). id 별 최대값에 1을 더하는 방식은 7일 정리 뒤 1로 돌아간다.
- `checkVerdict` 는 Orca 조회 결과를 인자로 받는다. 조회 자체는 phase 03 이 한다.
- 시각은 인자(`now: Date`)로 받는다. 함수 안에서 `Date.now()` 를 부르지 않는다. 테스트가 7일 경계를 고정 시각으로 본다.

## 작업 항목

### 1. `skills/orch/scripts/core/approvals.ts` 신규

설계 「저장 꼴」 의 타입과 함수:

```ts
export type ApprovalKind = 'post' | 'spec' | 'step' | 'real' | 'command'
export type ApprovalState = 'open' | 'approved' | 'used' | 'revise' | 'cancelled' | 'replaced'
export type Press = { action: 'approve' | 'revise'; terminal: string; origin: string; at: string; nonce: string }
export type Approval = { id; version; kind; title; state; run; terminal: string | null; preview: { path: string; sha256: string } | null;
  item: string | null; step: number | null; then: string | null; real: { target; change; rollback } | null; command: string | null;
  createdAt: string; closedAt: string | null; press: Press | null; note: string | null; reason: string | null }
export type ApprovalFile = { seq: number; entries: Approval[] }

export const KEEP_DAYS = 7
export function emptyFile(): ApprovalFile
export function parseFile(text: string): ApprovalFile          // 꼴이 틀리면 throw. 빈 문자열은 emptyFile
export function validateAdd(input: AddInput): { ok: true } | { ok: false; missing: string[] } | { ok: false; error: string }
export function applyAdd(file, input, now): { file; entry: Approval; replaced: boolean; kept: boolean }   // input.keepOpen
export function applyCancel(file, id, reason, now): { file } | { error: '열린 대기가 없다' }
export function latest(file, id): Approval | null              // 그 id 의 가장 큰 버전
export function prune(file, now): ApprovalFile                 // closedAt 이 KEEP_DAYS 일 전보다 이른 기록을 뺀다
export type CheckFacts = { askedVersion: number | null; previewSha: string | null; message: { found: false } | { found: true; sender: string };
  workers: { ok: false } | { ok: true; workerHandles: Set<string> } }
export type CheckReason = '기록 없음' | '아직 누르지 않음' | '이미 사용함' | '고쳐 달라' | '취소됨' | '미리보기가 바뀜' | '버전이 다름' | 'worker 가 보냄' | '신호를 읽지 못함'
export function stateReason(entry: Approval | null): CheckReason | null   // approved 면 null
export function checkVerdict(entry, facts): { ok: true } | { ok: false; reason: CheckReason }
export function applyUsed(file, id, version, nonce, now): { file } | { reason: CheckReason }   // 잠금 안의 다시 대조
export function signalMatches(payload: Json, entry: Approval): boolean   // {source: board-approval, action: approve, id, version, nonce}
export function waitedText(createdAt, now): string             // N분, 60분부터 N시간, 하루부터 N일
export function formatLine(entry, now, full: boolean): string
```

- `validateAdd`: 종류별 필수 칸(REQ1). `real` 은 target, change, rollback. `command` 는 command. `step` 은 item 과 step. `command` 를 뺀 넷은 preview. 빠진 이름을 모두 모아 `missing` 으로 돌려준다(명령이 종료 코드 2 로 낸다). 종류가 다섯 밖이면 `error`.
- `applyAdd`: `seq + 1` 을 새 버전으로 쓴다. 같은 id 의 `open` 기록이 있으면 `replaced` 와 `closedAt` 을 쓰고 `replaced: true`. `keepOpen` 이면 열린 기록을 바꾸지 않고 `kept: true` 와 그 기록을 돌려준다(seq 도 늘리지 않는다). 끝난 기록은 그대로 둔다(스펙 DECISION22).
- `checkVerdict` 차례는 설계 「신호와 `check` 의 판정」 2~6단계다. `stateReason` → 미리보기(`facts.previewSha` 가 null 이거나 다르면 「미리보기가 바뀜」) → `askedVersion` 이 있고 기록 버전과 다르면 「버전이 다름」 → `message.found` false 면 「신호를 읽지 못함」 → `workers.ok` false 면 「신호를 읽지 못함」 → `sender`(빈 값은 뺀다), `press.terminal`, 기록의 `terminal` 가운데 하나라도 `workerHandles` 에 있으면 「worker 가 보냄」. `sender` 와 `press.terminal` 이 같은지는 보지 않는다.
- `applyUsed`: 같은 버전 기록이 `approved` 이고 `press.nonce` 가 같을 때만 `used`, `closedAt`. 아니면 그 기록의 `stateReason`(없으면 「기록 없음」).
- `formatLine`: 열린 대기 `APPROVAL <id> <kind> <기다린 시간> <제목>`, `full` 이고 끝난 기록 `APPROVAL <id> <kind> <state> v<버전> <제목>`.

### 2. `skills/orch/scripts/core/message-fields.ts` 에 함수 둘

`subjectOf(message)`: `subject`, `title` 순으로 첫 문자열. `payloadOf(message)`: `payload` 가 객체면 그대로, 문자열이면 `JSON.parse`(실패하면 `{}`), 없으면 `{}`.

### 3. `skills/orch/tests/core-approvals.spec.ts` 신규

표 테스트로 본다.

- `validateAdd`: 다섯 종류마다 필수 칸 하나씩 뺀 입력이 그 이름을 `missing` 에 낸다. `command` 는 preview 없이 통과한다.
- `applyAdd`: 열린 A(v1)를 같은 id 로 다시 올리면 A 는 `replaced`, 새 기록 v2 `open`, `replaced: true`. `revise` 로 끝난 기록을 다시 올리면 그 기록은 `revise` 그대로이고 `replaced: false`.
- 버전: 기록을 모두 `prune` 으로 지운 뒤 같은 id 로 올려도 버전이 앞 버전보다 크다.
- `applyCancel`: 열린 대기만 닫는다. `approved` 와 없는 id 는 `error`.
- `applyAdd` 의 `keepOpen`: 열린 기록이 있으면 버전과 파일이 그대로이고 `kept: true`. 열린 기록이 없으면 새로 연다.
- `checkVerdict`: 아홉 거절 이유를 하나씩 내는 사례와 통과 사례 하나. worker 가 같은 제목을 보냈지만 기록이 `open` 인 사례가 「아직 누르지 않음」 이다(REQ10 인수 조건). 올린 터미널만 worker 인 사례도 「worker 가 보냄」 이다. `sender` 가 비어 있고 나머지가 worker 가 아니면 통과한다.
- `signalMatches`: nonce 나 버전이 다른 payload 는 거짓.
- `applyUsed`: 통과 뒤 같은 기록에 다시 부르면 「이미 사용함」.
- `prune`: 8일 전에 끝난 기록은 빠지고, 6일 전에 끝난 기록과 30시간 열린 기록은 남는다(REQ11).
- `waitedText`, `formatLine`: 59분, 61분, 25시간, 2일.

### 4. `skills/orch/tests/message-fields.spec.ts` 에 사례 더하기

`subjectOf`, `payloadOf` 의 문자열 payload, 깨진 payload, 없는 필드.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-approvals.spec.ts skills/orch/tests/message-fields.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/approvals.ts` | 신규 |
| `skills/orch/scripts/core/message-fields.ts` | 수정 (`subjectOf`, `payloadOf`) |
| `skills/orch/tests/core-approvals.spec.ts` | 신규 |
| `skills/orch/tests/message-fields.spec.ts` | 수정 |
