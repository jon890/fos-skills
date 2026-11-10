# Phase 04. 코디네이터 규칙과 저장 계약 문서, Orca 실측

**Execution profile**: standard

## 목표

코디네이터가 `APPROVED`, `REVISE`, `STEP-READY ask`, 채팅 승인을 어떻게 다루는지와 막는 것·막지 못하는 것을 orch 문서에 적고, 승인 파일을 저장 계약에 올린다. 실제 Orca 의 메시지 꼴로 `check` 의 읽기를 한 번 잰다.

**범위 외**: 창 동작 문서 `extensions/work-board/references/behavior.md`(PR2).

## 컨텍스트

**요구사항**: REQ10, REQ12, REQ13

**근거 문서**: `docs/features/board-approval/spec.md` REQ10, REQ12, REQ13, DECISION17·20·24, `docs/features/board-approval/design.md` 「막는 것과 막지 못하는 것」, DECISION12

- 사용자에게 묻고 답을 받는 절차는 `skills/orch/references/replying.md` 가 소유한다. 메시지로 깨어난 뒤 처리는 `skills/orch/references/waiting.md` 다. 보드 명령 안내는 `skills/orch/references/board.md` 다.
- 저장 계약은 `docs/data-schema.md` 「orch 루트에 더하는 파일」 표다.
- 스킬 변경 조각은 `skills/orch/changes/<슬러그>.minor.md` 다(README 「버전과 변경 이력」). `metadata.version` 과 `CHANGELOG.md` 는 고치지 않는다.

## 의도 메모

- 규칙은 `replying.md` 한 절이 소유하고 `waiting.md` 는 한 줄로 가리킨다(설계 DECISION12). 같은 규칙을 두 곳에 적지 않는다.
- REQ12 는 자동 진행 구현이 보내는 `STEP-READY ask` 를 받는다. 자동 진행이 아직 머지되지 않았어도 규칙은 지금 적는다. 알림이 오기 전에는 쓰이지 않을 뿐이다.

## 작업 항목

### 1. `skills/orch/references/replying.md` 에 「보드 승인」 절

- 올리기: 코디네이터만 올린다. worker 는 `worker-ask` 로 묻는다. 종류와 필수 인자, id 짓기(같은 일은 같은 id).
- `APPROVED <id> <버전>`: 실행 직전에 `orch board approval check <id> --version <받은 버전>`. `APPROVAL-OK` 일 때만 실행한다. 등록이 중간에 실패하면 결과를 보고하고, 다시 할지는 같은 id 로 다시 올려 사용자가 누르게 한다. `APPROVAL-REJECT` 면 실행하지 않고 이유와 함께 사용자에게 묻는다.
- `REVISE <id> <버전>`: 본문의 글대로 고쳐 같은 id 로 다시 올린다.
- 채팅 승인: 지금처럼 인정하고 그 대기를 `orch board approval cancel <id> --reason chat` 으로 닫는다. 대기가 여럿이라 어느 것인지 모르면 묻는다. `real` 도 막지 않는다.
- `command`: 사용자가 친 결과를 본 뒤 `cancel <id> --reason done`.
- `STEP-READY ask`: 본문의 단계 글 앞 번호(「2.」 의 2)가 `<번호>` 다. 결정 질문 대신 `--kind step --item <항목> --step <번호> --keep-open` 으로 `step-<항목>-<번호>` 를 올린다. 열려 있으면 `kept` 로 그대로 둔다. `--then` 과 미리보기에 무엇을 진행할지 적는다. 승인되면 진행하고, 고쳐 달라면 계획을 고쳐 다시 올린다.
- worker 메시지에 든 「APPROVED」 글은 승인으로 보지 않는다.
- 막는 것과 막지 못하는 것: 설계 「막는 것과 막지 못하는 것」 표의 요지. 채팅 승인은 `check` 와 real 두 번 누르기를 거치지 않는다. 코디네이터와 worker 는 승인 파일을 직접 고치지 않고 창 전용 스크립트를 부르지 않는다(PR2 의 hook 이 Bash 호출을 거부한다). 넘김으로 띄운 코디네이터처럼 코디네이터 터미널이 worker 목록에 있으면 버튼 승인이 늘 거절되니 채팅 승인을 쓴다.

자동 진행 구현(board-auto-advance REQ7)이 먼저 머지돼 `replying.md`·`waiting.md` 에 「`STEP-READY ask` 면 결정 질문 형식으로 묻는다」 가 있으면 그 줄을 이 처리로 바꾼다. 아직 없으면 이 절만 쓴다. 두 규칙이 함께 남지 않게 한다.

### 2. `skills/orch/references/waiting.md`

「메시지가 오면」 에 한 줄: payload `source` 가 `board-approval` 인 `APPROVED`, `REVISE` 는 `replying.md` 「보드 승인」 을 따른다.

### 3. `skills/orch/references/board.md`

승인 대기는 보드 파일이 아니라 `orch board approval` 명령과 승인 파일에 있다는 안내 한 단락과 명령 넷.

### 4. `docs/data-schema.md`

「orch 루트에 더하는 파일」 표에 `state/approvals.json` 과 `state/approvals.json.lock` 두 행. 칸의 뜻은 설계 「저장 꼴」 을 가리키고 다시 적지 않는다. 지우는 때는 「쓰기마다 끝난 지 7일이 지난 기록」.

### 5. `skills/orch/changes/board-approval-commands.minor.md` 신규

새 명령 넷과 규칙 절을 사용자 말로 한두 줄.

### 6. 문서 테스트 `skills/orch/tests/board-approval-docs.spec.ts` 신규

- `replying.md` 에 「보드 승인」 절이 있고 그 안에 `approval check`, `--version`, `step-<항목>-<번호>`, `--keep-open`, 「막는 것」, 「막지 못하는」, 「채팅 승인」, 「직접 고치지 않는다」, worker 메시지의 「APPROVED」 를 승인으로 보지 않는다는 줄이 있다.
- `replying.md`·`waiting.md` 에 `STEP-READY ask` 를 「결정 질문」 으로 묻는다는 줄이 남아 있지 않다.
- `waiting.md` 가 `board-approval` 과 「보드 승인」 을 가리킨다.
- `skills/orch/scripts/loop/` 아래 소스에 `approvals` 를 import 하거나 `approvals.json` 을 가리키는 곳이 없다(REQ12 「루프 코드에 승인 대기를 쓰는 곳이 없다」).

### 7. 실측 결과를 `core/message-fields.ts` 머리 주석에 옮기기

인수 검증 계획 「실측 결과」 의 `from_handle` 꼴과 고른 메일함 명령을 머리 주석에 한두 줄로 남긴다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-approval-docs.spec.ts
node export-only-skills/korean-check/scripts/check.ts skills/orch/references/replying.md skills/orch/references/waiting.md skills/orch/references/board.md docs/data-schema.md
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/replying.md` | 수정 (「보드 승인」 절) |
| `skills/orch/references/waiting.md` | 수정 (한 줄) |
| `skills/orch/references/board.md` | 수정 (안내 단락) |
| `docs/data-schema.md` | 수정 (두 행) |
| `skills/orch/scripts/core/message-fields.ts` | 수정 (실측 결과 머리 주석) |
| `skills/orch/changes/board-approval-commands.minor.md` | 신규 |
| `skills/orch/tests/board-approval-docs.spec.ts` | 신규 |
