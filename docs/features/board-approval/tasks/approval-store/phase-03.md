# Phase 03. 승인 파일 저장과 `orch board approval` 명령

**Execution profile**: standard

## 목표

`orch board approval add`, `list`, `cancel`, `check` 를 부를 수 있게 하고, 승인 파일을 잠금 안에서 읽고 쓴다. 승인·고쳐 달라를 쓰는 명령은 만들지 않는다.

**범위 외**: 창 전용 스크립트 `bin/approvals.ts` 와 `recordPress`(PR2), 규칙 문서(phase 04).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ10, REQ11

**근거 문서**: `docs/features/board-approval/spec.md` REQ1~4, REQ10, REQ11, `docs/features/board-approval/design.md` 「명령」, 「신호와 `check` 의 판정」, 「실패와 일관성」, `docs/features/orch-board-cli/spec.md` REQ11(잠금)

- 명령 표는 `skills/orch/scripts/lib/commands.ts` 다. 두 낱말 동작은 `queue reserve prune` 행과 같은 꼴(`verb: 'approval add'`, `prepend: ['add']`)로 쓴다. `run` 문맥은 `context: ['repo', 'run']` 과 `runFrom: 'run-current'` 를 쓰는 다른 행을 보고 같게 쓴다.
- 인자 풀이는 `skills/orch/scripts/board/goal-progress.ts` 처럼 `node:util` 의 `parseArgs` 와 `lib/args.ts` 의 `expandArgs` 를 쓴다. 종료 코드는 0 반영·통과, 1 거절, 2 사용법 오류다.
- 승인 파일 경로는 `lib/paths.ts` 의 `pathOf('state', repo)` 아래 `approvals.json` 이다. 옆 파일에 쓴 뒤 `renameSync` 로 바꾸는 방식은 `lib/reservations.ts` 를 따른다.
- 잠금은 보드 명령 구현이 `extensions/work-board/bin/board.ts` 에 더한 잠금 함수(5초 기다림, 30초 넘은 잠금 무시)를 쓴다. 그 함수가 보드 파일 전용이라 내보내지 않으면 동작을 바꾸지 않고 export 만 더한다. 새 잠금 꼴을 만들지 않는다.
- Orca 호출은 `lib/orca.ts` 의 `orcaJson` 을 쓴다. 메시지 필드는 `core/message-fields.ts` 의 `senderOf`, `subjectOf`, `payloadOf` 로 읽는다.

## 의도 메모

- `check` 의 Orca 조회는 잠금 밖에서 하고, 잠금 안에서는 `core/approvals.ts` 의 `applyUsed` 로 다시 대조만 한다(설계 DECISION7).
- `check` 는 `press.message` 가 없으면 Orca 를 부르지 않고 「신호를 읽지 못함」 을 낸다. PR1 만 머지된 동안은 기록이 늘 `open` 이라 「아직 누르지 않음」 에서 끝난다.
- `--preview` 상대경로는 부른 폴더 기준으로 절대경로로 바꿔 저장한다. 워크트리에서 만든 미리보기도 경로가 맞게 남는다.

## Blocked 조건

- 보드 명령 구현의 잠금 함수가 `origin/main` 에 없다 → `PHASE_BLOCKED: 보드 명령 구현(orch-board-cli REQ11 잠금)이 아직 머지되지 않았다`

## 작업 항목

### 1. `skills/orch/scripts/lib/approvals.ts` 신규

```ts
export function approvalsFile(repo: string): string
export function readApprovals(repo: string): ApprovalFile                       // 없으면 emptyFile, 깨졌으면 throw(경로 포함)
export function updateApprovals<T>(repo: string, change: (file: ApprovalFile, now: Date) => { file: ApprovalFile; result: T }): T
                                                                                  // 잠금 → 읽기 → change → prune → 옆 파일 쓰기 → rename → 잠금 풀기
export function previewSha(path: string): string | null                          // 파일이 없으면 null
export function readSignal(run: string, messageId: string): { found: false } | { found: true; version: number | null; sender: string }
export async function signalWorkers(handles: string[]): Promise<CheckFacts['workers']>
```

- `readSignal`: `orca orchestration check --run <run> --all --types status --json` 결과에서 `id` 가 `messageId` 인 메시지를 찾는다. 버전은 `payloadOf(message).version`, 없으면 제목 `APPROVED <id> <버전>` 의 셋째 낱말이다. 조회 실패도 `found: false` 다.
- `signalWorkers`: phase 02 의 `lookupWorkerTerminals(handles, { states: [ACTIVE_STATE, ...LIVE_STATES, 'released'] })`.
- 잠금을 쥔 동안 Orca 와 git 을 부르지 않는다.

### 2. `skills/orch/scripts/board/board-approval.ts` 신규

첫 인자가 동작(`add`, `list`, `cancel`, `check`)이다. 파일 머리 주석에 사용법, 출력 줄, 종료 코드를 적는다. 승인·고쳐 달라 동작은 없다.

- `add <id> --title --kind [--preview] [--item] [--step] [--then] [--target] [--change] [--rollback] [--command] --run <Run>`: `validateAdd` 의 `missing` 이 있으면 「필수 인자가 빠졌다: --target, --rollback」 과 종료 코드 2. 미리보기 파일이 없거나 `--run` 이 비면 종료 코드 1, 저장하지 않는다. `command` 종류인데 `ORCA_TERMINAL_HANDLE` 이 없으면 종료 코드 1(설계 REQ9 의 버튼이 그 터미널을 쓴다). 성공은 `APPROVAL-ADD <id> <kind> <버전>`, 바꿨으면 끝에 ` replaced`.
- `list [--full]`: 열린 대기는 만든 순서로 `formatLine`. `--full` 은 끝난 기록도 낸다.
- `cancel <id> [--reason]`: `APPROVAL-CANCEL <id>`. 열린 대기가 없으면 종료 코드 1.
- `check <id>`: 설계 「신호와 `check` 의 판정」 1~7단계. 통과는 `APPROVAL-OK <id>` 와 0, 거절은 `APPROVAL-REJECT <id> <이유>` 와 1.
- 잠금을 5초 안에 못 잡으면 종료 코드 1 과 stderr 이유.

### 3. `skills/orch/scripts/lib/commands.ts` 에 네 행

설계 「명령」 표대로. `add` 만 `run` 문맥이 필수다.

### 4. 테스트

- `skills/orch/tests/board-approval.spec.ts` 신규. 임시 저장소(`git init`)와 `ORCH_DIR`, `PATH` 앞의 가짜 `orca` 로 자식 프로세스를 부른다.
  - REQ1: 종류마다 성공 출력과 저장 내용(해시, 터미널, Run, 버전). 필수 인자 빠짐은 2 와 이름. 없는 미리보기와 빈 Run 은 1 이고 파일이 생기지 않는다.
  - REQ2: 열린 대기를 다시 올리면 ` replaced`. 승인된 기록(테스트가 파일에 `approved` 와 `press` 를 직접 써 둔다)을 다시 올린 뒤 `check` 가 「아직 누르지 않음」. `revise` 기록을 다시 올린 뒤 `list --full` 에 `revise` 줄이 남는다.
  - REQ3: 열린 둘이면 `list` 두 줄. `cancel` 뒤 빠진다. 없는 id 의 `cancel` 은 1.
  - REQ10: 가짜 orca 가 낸 메시지와 worker 목록으로 통과 하나, 「미리보기가 바뀜」(승인 뒤 파일 고침), 「worker 가 보냄」, 「신호를 읽지 못함」(메시지 없음), 「버전이 다름」, 둘째 `check` 의 「이미 사용함」.
  - REQ11: 8일 전에 끝난 기록이 다음 `add` 뒤 `list --full` 에 없고, 30시간 열린 기록은 남는다.
  - 잠금: 테스트가 잠금 파일을 만들어 둔 채 부르면 5초 뒤 1. 31초 전 시각의 잠금 파일은 무시하고 돈다(`utimesSync` 로 시각을 바꾼다).
- `skills/orch/tests/lib-commands.spec.ts` 에 사례: `orch board approval add` 가 `board/board-approval.ts add` 로 풀리고, `board` 묶음에 `approve`, `revise` 가 든 동작이 없다(REQ4).
- `skills/orch/tests/board-approval-static.spec.ts` 신규(REQ4): `skills/orch/scripts` 와 `extensions/work-board` 의 소스에서 승인 파일에 `approved` 나 `revise` 상태를 쓰는 곳이 `core/approvals.ts` 밖에 없다. PR2 가 `applyPress` 를 더하면 이 테스트에 허용 자리(`bin/approvals.ts`)를 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-approval.spec.ts skills/orch/tests/board-approval-static.spec.ts skills/orch/tests/lib-commands.spec.ts
node scripts/run-tests.ts --tsc-only
node skills/orch/bin/orch.ts board approval --help
```

마지막 줄은 `add`, `list`, `cancel`, `check` 만 보인다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/approvals.ts` | 신규 |
| `skills/orch/scripts/board/board-approval.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 (네 행) |
| `skills/orch/tests/board-approval.spec.ts` | 신규 |
| `skills/orch/tests/board-approval-static.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
| `extensions/work-board/bin/board.ts` | 수정 (잠금 함수 export 만, 이미 내보내면 바꾸지 않는다) |
