# Phase 03. 승인 파일 저장과 `orch board approval` 명령

**Execution profile**: standard

## 목표

`orch board approval add`, `list`, `cancel`, `check` 를 부를 수 있게 하고, 승인 파일을 잠금 안에서 읽고 쓴다. 승인·고쳐 달라를 쓰는 명령은 만들지 않는다.

**범위 외**: 창 전용 스크립트 `bin/approvals.ts` 와 `recordPress`(PR2), 규칙 문서(phase 04).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ10, REQ11

**근거 문서**: `docs/features/board-approval/spec.md` REQ1~4, REQ10, REQ11, `docs/features/board-approval/design.md` 「명령」, 「신호와 `check` 의 판정」, 「실패와 일관성」, `docs/features/orch-board-cli/spec.md` REQ11(잠금)

- 명령 표는 `skills/orch/scripts/lib/commands.ts` 다. 두 낱말 동작은 `queue reserve prune` 행과 같은 꼴(`verb: 'approval add'`, `prepend: ['add']`)로 쓴다. `add` 행은 `context: ['repo', 'run']` 과 `runFrom: 'run-current'` 를 쓰되 `required` 에 `run` 을 넣지 않는다. 필수 문맥을 채우지 못하면 진입점이 종료 코드 2 로 끝나(`lib/context.ts`, `bin/orch.ts`) 스펙 REQ1 의 「지금 Run 을 찾지 못하면 1」 과 어긋나기 때문이다. `--run` 이 비면 스크립트가 1 로 끝낸다.
- `--full` 은 진입점이 떼고 `ORCH_OUTPUT=full` 로 넘긴다(`bin/orch.ts` 의 `stripFull`). `list` 는 `lib/output.ts` 의 `fullAsked()` 로 읽는다. 스크립트를 직접 부를 때를 위해 `--full` 인자도 받는다.
- 인자 풀이는 `skills/orch/scripts/board/goal-progress.ts` 처럼 `node:util` 의 `parseArgs` 와 `lib/args.ts` 의 `expandArgs` 를 쓴다. 종료 코드는 0 반영·통과, 1 거절, 2 사용법 오류다.
- 승인 파일 경로는 `lib/paths.ts` 의 `pathOf('state', repo)` 아래 `approvals.json` 이다. 옆 파일에 쓴 뒤 `renameSync` 로 바꾸는 방식은 `lib/reservations.ts` 를 따른다.
- 잠금은 보드 명령 구현 PR1 이 더한 `extensions/work-board/bin/file-lock.ts` 의 `withFileLock(approvalsFile, 할 일)` 이다. 기본값(5초 기다림, 30초 넘은 잠금 넘겨받기)을 그대로 쓴다. 설계 DECISION13. 그 함수의 실제 이름과 옵션은 머지된 코드에서 읽는다. 테스트가 5초를 기다리지 않게 하는 방법(옵션이나 환경 변수)도 그 모듈의 것을 쓴다.
- Orca 호출은 `lib/orca.ts` 의 `orcaJson` 을 쓴다. 메시지 필드는 `core/message-fields.ts` 의 `senderOf`, `subjectOf`, `payloadOf` 로 읽는다.

## 의도 메모

- `check` 의 Orca 조회는 잠금 밖에서 하고, 잠금 안에서는 `core/approvals.ts` 의 `applyUsed` 로 다시 대조만 한다(설계 DECISION7).
- 승인 상태(`approved`, `revise`)를 만드는 `applyPress`, `revertPress` 는 설계상 core 에 있지만 PR2 가 더한다. PR1 에 승인 상태를 쓰는 길을 두지 않으려는 것이다. 그래서 정적 테스트(작업 4)는 「core 밖에서 승인 상태를 쓰지 않는다」 를 본다. 설계 REQ4 의 「`recordPress` 호출 자리 하나」 는 PR2 가 이 테스트에 더한다.
- PR1 만 머지된 동안은 기록이 늘 `open` 이라 `check` 는 「아직 누르지 않음」 에서 끝나고 Orca 를 부르지 않는다.
- `--preview` 상대경로는 부른 폴더 기준으로 절대경로로 바꿔 저장한다. 워크트리에서 만든 미리보기도 경로가 맞게 남는다.

## Blocked 조건

- `extensions/work-board/bin/file-lock.ts` 가 `origin/main` 에 없다 → `PHASE_BLOCKED: 보드 명령 구현 PR1(file-lock.ts)이 아직 머지되지 않았다`. 계획 전체의 선행 조건이라 phase 01 을 시작하기 전에 먼저 확인한다
- 인수 검증 계획의 「PR1 첫 실측」 결과가 `docs/features/board-approval/tasks/approval-store/verification-plan.md` 아래 「실측 결과」 에 없다 → `PHASE_BLOCKED: 신호 메시지 찾기 명령과 from_handle 실측이 없다`. 코디네이터가 실측을 마치고 결과를 적은 뒤 이어 간다

## 작업 항목

### 0. worker 판정 시간 재기

phase 02 의 `lookupWorkerTerminals(['term_none'], { states: APPROVAL_STATES })` 를 부르는 일회 스크립트를 세션 임시 폴더에 두고, 코디네이터 Run 에 묶인 이 worker 터미널에서 세 번 돌려 걸린 시간을 잰다. 이 조회는 읽기만 한다. `check`, `add`, `cancel` 의 판정 기한은 잰 값의 세 배와 30초 가운데 큰 값으로 정하고 `lib/approvals.ts` 상수 `WORKER_LOOKUP_MS` 에 근거(잰 날과 값)를 주석으로 남긴다. 잰 값을 인수 검증 계획 「실측 결과」 에 적는다.

### 1. `skills/orch/scripts/lib/approvals.ts` 신규

```ts
export function approvalsFile(repo: string): string
export function readApprovals(repo: string): ApprovalFile                       // 없으면 emptyFile, 깨졌으면 throw(경로 포함)
export function moveBroken(repo: string, now: Date): string                      // add 만 부른다. 옆 이름으로 옮기고 그 경로
export function updateApprovals<T>(repo: string, change: (file: ApprovalFile, now: Date) => { file: ApprovalFile; result: T }): T
                                                                                  // 잠금 → 읽기 → change → prune → 옆 파일 쓰기 → rename → 잠금 풀기
export function previewSha(path: string): string | null                          // 파일이 없으면 null
export function readSignal(entry: Approval): CheckFacts['message']               // payload 가 signalMatches 인 메시지
export async function signalWorkers(handles: string[]): Promise<CheckFacts['workers']>
export async function selfIsWorker(): Promise<boolean | null>                     // ORCA_TERMINAL_HANDLE 의 approval 꼴 판정. 변수가 없으면 false
```

- `readSignal`: 기록의 Run 메일함을 「실측 결과」 가 고른 명령으로 읽고 `payloadOf(message)` 가 `signalMatches` 인 메시지를 찾는다. 제목은 보지 않고 payload 만 본다(설계 「신호와 `check` 의 판정」 5단계). `orcaJson` 이 `--json` 과 `--full` 을 스스로 붙이므로 인자에 넣지 않는다. 조회 실패도 `found: false` 다.
- `signalWorkers`: phase 02 의 `lookupWorkerTerminals(handles, { states: APPROVAL_STATES, deadline })`. 기한은 「실측 결과」 의 판정 시간으로 정한다.
- 잠금을 쥔 동안 Orca 와 git 을 부르지 않는다.

### 2. `skills/orch/scripts/board/board-approval.ts` 신규

첫 인자가 동작(`add`, `list`, `cancel`, `check`)이다. `--repo` 는 진입점이 채운다(스크립트를 직접 부르면 기본은 작업 폴더). id 는 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 꼴만 받고 아니면 종료 코드 2 다. 공백이나 `:` 가 든 id 는 한 줄 출력과 PR2 의 버튼 키(`approval:<id>:<버전>:…`)를 깬다. `add`, `cancel` 은 먼저 `selfIsWorker()` 를 부르고 true 나 null 이면 「worker 터미널에서는 승인 대기를 올리거나 거두지 않는다」 와 종료 코드 1 이다. 파일 머리 주석에 사용법, 출력 줄, 종료 코드를 적는다. 승인·고쳐 달라 동작은 없다.

- `add <id> --title --kind [--preview] [--item] [--step] [--then] [--target] [--change] [--rollback] [--command] [--keep-open] --run <Run>`: `validateAdd` 의 `missing` 이 있으면 「필수 인자가 빠졌다: --target, --rollback」 과 종료 코드 2. 미리보기 파일이 없거나 `--run` 이 비면 종료 코드 1, 저장하지 않는다. `command` 종류인데 `ORCA_TERMINAL_HANDLE` 이 없으면 종료 코드 1(설계 REQ9 의 버튼이 그 터미널을 쓴다). 성공은 `APPROVAL-ADD <id> <kind> <버전>`, 바꿨으면 끝에 ` replaced`, `--keep-open` 으로 그대로 뒀으면 ` kept`. 승인 파일이 깨졌으면 `moveBroken` 뒤 새 파일에 올리고 stderr 에 옮긴 경로를 낸다.
- `list [--full]`: 열린 대기는 만든 순서로 `formatLine`. `--full` 은 끝난 기록도 낸다.
- `cancel <id> [--reason]`: `APPROVAL-CANCEL <id>`. 열린 대기가 없으면 종료 코드 1.
- `check <id> [--version <버전>]`: 설계 「신호와 `check` 의 판정」 1~7단계. 통과는 `APPROVAL-OK <id>` 와 0, 거절은 `APPROVAL-REJECT <id> <이유>` 와 1.
- 잠금을 5초 안에 못 잡으면 종료 코드 1 과 stderr 이유.

### 3. `skills/orch/scripts/lib/commands.ts` 에 네 행과 앞 낱말 도움말

설계 「명령」 표대로. `add` 행은 `context: ['repo', 'run']`, `runFrom: 'run-current'` 이고 `required` 는 두지 않는다. 나머지 셋은 `context: ['repo']` 다.

지금 `orch board approval --help` 는 `approval` 을 동작으로 보지 않아 「모르는 동작이다」 와 종료 코드 2 로 끝난다(`bin/orch.ts` 의 `resolveNew`, 221~227행). 두 낱말 동작의 앞 낱말 뒤 `--help` 를 받게 한다: `commands.ts` 에 `helpText(group, lead?)` 를 넓혀 `lead` 로 시작하는 동작의 usage 만 내고, `bin/orch.ts` 가 `<묶음> <앞 낱말> --help` 꼴이면 그것을 내고 0 으로 끝난다. `queue reserve --help` 도 같은 길을 탄다.

### 4. 테스트

- `skills/orch/tests/board-approval.spec.ts` 신규. 임시 저장소(`git init`)와 `ORCH_DIR`, 가짜 `orca`(`tests/fixtures/fake-bin.ts` 와 `ORCA` 환경 변수)로 자식 프로세스를 부른다. 사례 대부분은 스크립트를 직접 부르고, 아래 「진입점 경유」 사례는 `node skills/orch/bin/orch.ts board approval …` 로 부른다.
  - REQ1: 종류마다 성공 출력과 저장 내용(해시, 터미널, Run, 버전). 필수 인자 빠짐은 2 와 이름. 없는 미리보기와 빈 Run 은 1 이고 파일이 생기지 않는다.
  - REQ2: 열린 대기를 다시 올리면 ` replaced`. 승인된 기록(테스트가 파일에 `approved` 와 `press` 를 직접 써 둔다)을 다시 올린 뒤 `check` 가 「아직 누르지 않음」. `revise` 기록을 다시 올린 뒤 `list --full` 에 `revise` 줄이 남는다.
  - REQ3: 열린 둘이면 `list` 두 줄. `cancel` 뒤 빠진다. 없는 id 의 `cancel` 은 1.
  - 진입점 경유: `orch board approval list --full` 이 끝난 기록을 낸다(`--full` 이 `ORCH_OUTPUT=full` 로 오는 길). 가짜 orca 의 `run-current` 가 Run 을 내지 않을 때 `orch board approval add` 가 종료 코드 1 이다(2 가 아니다). `orch board approval --help` 가 네 동작의 usage 만 내고 0 이다.
  - id 꼴: `a b`, `a:b` 는 2. `command` 종류인데 `ORCA_TERMINAL_HANDLE` 이 없으면 1.
  - REQ12: `--keep-open` 으로 같은 `step-x-2` 를 두 번 올린 뒤 `list` 가 한 줄이다.
  - REQ10: 테스트가 파일에 `approved` 기록(nonce 포함)을 써 두고, 가짜 orca 가 그 nonce 를 담은 메시지와 worker 목록을 낸다. 통과 하나, 「기록 없음」, 「고쳐 달라」, 「취소됨」, 「미리보기가 바뀜」(승인 뒤 파일 고침), 「worker 가 보냄」(보낸 쪽이 released worker), 「신호를 읽지 못함」(nonce 가 다른 메시지만 있음), 「버전이 다름」(`--version` 이 다름), 둘째 `check` 의 「이미 사용함」.
  - DECISION14: 가짜 orca 의 worker 목록에 `ORCA_TERMINAL_HANDLE` 이 있으면 `add`, `cancel` 이 1 이고 파일이 그대로다.
  - `--keep-open`: 열린 대기에 다시 부르면 ` kept` 와 같은 버전.
  - 깨진 파일: `add` 가 `approvals.json.broken-*` 을 남기고 새 파일에 올린다. `list` 는 1.
  - REQ11: 8일 전에 끝난 기록이 다음 `add` 뒤 `list --full` 에 없고, 30시간 열린 기록은 남는다.
  - 잠금: 잠금 파일을 미리 둔 채 부르면 기다림 끝에 1(기다리는 시간은 `file-lock.ts` 가 주는 테스트용 방법으로 줄인다). `utimesSync` 로 나이를 30초 넘게 옮긴 잠금 파일은 넘겨받고 돈다.
- `skills/orch/tests/lib-commands.spec.ts` 에 사례: `orch board approval add` 가 `board/board-approval.ts add` 로 풀리고, `board` 묶음에 `approve`, `revise` 가 든 동작이 없다(REQ4). 이 파일의 「스크립트가 받는 문맥 인자는 문맥 칸에 있다」 테스트(36~61행)는 같은 스크립트의 행마다 소스의 `run` 옵션을 본다. `approval list`, `approval cancel`, `approval check` 는 기록의 `run` 을 쓰므로 `run` 문맥이 없다. 그 테스트의 `omitted` 에 세 키와 이유 「기록의 run 을 쓴다」 를 더한다.
- `skills/orch/tests/board-approval-static.spec.ts` 신규(REQ4): `skills/orch/scripts`, `skills/orch/hooks`, `extensions/work-board/bin`, `extensions/work-board/hooks` 아래 `.ts`, `.js` 파일(테스트 폴더 제외)에서 정규식 `state\s*[:=]\s*['"](approved|revise)['"]` 에 맞는 줄이 `core/approvals.ts` 에만 있다. 비교(`===`)는 이 정규식에 걸리지 않는다. 주석 줄(`//` 로 시작)은 뺀다.

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
| `skills/orch/scripts/lib/commands.ts` | 수정 (네 행, `helpText` 의 앞 낱말) |
| `skills/orch/bin/orch.ts` | 수정 (`<묶음> <앞 낱말> --help`) |
| `skills/orch/tests/board-approval.spec.ts` | 신규 |
| `skills/orch/tests/board-approval-static.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
