# Phase 02. 창 전용 스크립트와 Bash 호출 차단 hook

**Execution profile**: standard

## 목표

창이 부르는 스크립트 `where`, `self`, `press` 를 만들고, 에이전트가 Bash 도구로 `press` 를 부르면 거부하는 hook 을 더한다. 승인 기록을 쓰는 가장 쉬운 길을 에이전트에게서 막으려는 것이다.

**범위 외**: 창 그리기와 버튼(phase 03). orch 명령 표에는 넣지 않는다.

## 컨텍스트

**요구사항**: REQ4, REQ6, REQ9

**근거 문서**: `docs/features/board-approval/design.md` 「창이 부르는 스크립트」, 「막는 것과 막지 못하는 것」, 「worker 판정 꼴」

- 창은 TypeScript 와 `node:fs` 를 import 하지 못한다. 그래서 `extensions/work-board/bin/worker-marks.ts` 처럼 창이 `$.process.run` 으로 부르는 명령을 둔다. 이 명령은 orch 의 `lib/approvals.ts` 를 import 한다(`bin/worker-marks.ts` 가 `lib/movement.ts` 를 쓰는 것과 같은 방향).
- hook 은 `skills/orch/hooks/block-git-after-cd.ts` 꼴이다. 입력은 stdin 의 hook JSON, 거부할 때만 deny 결정을 낸다, 읽지 못한 입력은 통과시킨다. 따옴표와 heredoc 안의 글은 `hooks/shell-text.ts` 의 `mask`, `stripHeredocs` 로 가린다. 등록은 `skills/orch/hooks/hooks.json`.
- `self` 판정은 승인 쪽 「approval 꼴」(released 까지)이다. `lib/worker-terminal.ts` 의 `APPROVAL_STATES`, `LIVE_STATES`, `ACTIVE_STATE` 를 쓴다. `--live` 는 active 와 남은 터미널 상태만 읽어 60초마다 다시 읽는 비용을 줄인다.

## 의도 메모

- `self` 의 `worker` 가 `null`(조회 실패)이면 창은 `true` 와 같게 보고 버튼을 숨긴다. 숨기는 쪽이 안전하다(스펙 REQ6, 설계 DECISION8).
- hook 이 막지 못하는 것(스크립트 파일 안의 호출, 다른 이름의 사본)은 설계의 「막지 못함」 으로 둔다. 문서에만 적고 코드로 더 막지 않는다.

## 작업 항목

### 1. `extensions/work-board/bin/approvals.ts` 신규

```text
node approvals.ts where --repo <주 checkout>                         → 승인 파일 절대경로 한 줄
node approvals.ts self [--live]                                       → {"terminal":"term_…"|null,"worker":true|false|null} 한 줄
node approvals.ts press <id> <버전> approve|revise [--note=<글>] --origin <kind> --repo <주 checkout>
                                                                       → 0 이면 stdout 에 PRESS-OK <메시지 id>, 1 이면 stderr 한 줄 이유
```

- `where`: `approvalsFile(repo)`. 종료 코드 0.
- `self`: `terminal` 은 `ORCA_TERMINAL_HANDLE`(없으면 `null`). 변수가 없으면 `worker` 는 `false`. 있으면 조회한다. 기본은 `selfIsWorker()`, `--live` 는 `lookupWorkerTerminals` 에 `states: [ACTIVE_STATE, ...LIVE_STATES]` 를 준다. 조회가 실패하면 `worker: null`. 종료 코드는 늘 0.
- `press`: 버전은 양의 정수, 동작은 `approve`, `revise` 둘, `--origin` 은 필수. 맞지 않으면 종료 코드 2 와 stderr 사용법. 그다음 `recordPress` 를 부르고 결과를 출력한다. 실패 이유는 stderr 한 줄, 종료 코드 1.
- 머리 주석에 사용법, 출력, 종료 코드, 「에이전트의 Bash 도구로 부르지 않는다(hook 이 거부한다)」 를 적는다.

### 2. `skills/orch/hooks/block-approval-press.ts` 신규와 `hooks.json` 등록

- 가린 글(`mask(stripHeredocs(command))`)에 `/approvals\.ts\s+press(?![\w-])/` 가 있으면 deny. 따옴표 안의 글, 커밋 메시지, `lib/approvals.ts` 를 여는 명령(`cat`, `grep press`)은 통과한다.
- 거부 문구: 승인 기록은 사람이 보드 창에서 누른 버튼만 쓴다, 창 전용 스크립트를 부르지 않는다, 승인이 필요하면 `orch board approval add` 로 올리고 사용자에게 누르게 한다.
- `skills/orch/hooks/hooks.json` 의 `PreToolUse` Bash 목록에 같은 꼴로 더하고 맨 위 `description` 에 한 구절을 더한다.

### 3. 테스트

- `extensions/work-board/tests/approvals-bin.spec.ts` 신규: 임시 저장소와 가짜 orca 로 `where`(경로가 `<ORCH_DIR>/state/approvals.json`), `self`(변수 없음 → `{"terminal":null,"worker":false}`, worker 목록에 있는 터미널 → `true`, 조회 실패 → `null`), `press`(성공 `PRESS-OK` 와 종료 코드 0과 기록, 잘못된 동작 2, 지금 버전이 아니면 종료 코드 1과 「내용이 바뀌었어요」 이고 가짜 orca 의 `send` 가 불리지 않음).
- `skills/orch/tests/coordinator-hooks.spec.ts` 에 `block-approval-press.ts` 사례를 더한다: `node X/extensions/work-board/bin/approvals.ts press a 1 approve --origin x` 거부, 앞에 `cd`·`&&` 가 붙어도 거부, `grep press skills/orch/scripts/lib/approvals.ts`, `echo "approvals.ts press"`, 커밋 메시지 heredoc 안의 같은 글, `approvals.ts where` 는 통과.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/approvals-bin.spec.ts skills/orch/tests/coordinator-hooks.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/approvals.ts` | 신규 |
| `skills/orch/hooks/block-approval-press.ts` | 신규 |
| `skills/orch/hooks/hooks.json` | 수정 |
| `extensions/work-board/tests/approvals-bin.spec.ts` | 신규 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
