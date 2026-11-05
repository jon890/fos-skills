# Phase 03. `adopt-sessions` 와 상주 루프의 안내 줄

**Execution profile**: standard

## 목표

한도나 재부팅으로 멈춘 worker 를 알리는 두 곳(`orch worker adopt` 의 `LIMITED`·`RESTART`, 상주 루프의 `WORKER-LIMITED`)이 새 명령을 안내하게 한다.

**범위 외**: 명령 자체(phase-02), 참조 문서(phase-04).

## 컨텍스트

**요구사항**: REQ5

**근거 문서**: `docs/features/limit-resume/spec.md`(DECISION5, DECISION13), `docs/features/limit-resume/design.md`(「책임과 경계」 의 `lib/sessions.ts`, `orch-loop.ts`)

- 경로: phase-01 컨텍스트의 「스크립트 폴더」 표를 따른다.
- 기존 출력 계약: `adopt-sessions` 의 판정 줄(`LIMITED <터미널> dispatch=… task=… run=… branch=…`, `RESTART …`)은 그대로다. 들여 쓴 명령 줄만 바뀐다. `--json` 의 `limited`, `restartable` 항목도 `commands` 배열 내용만 바뀐다.
- `skills/orch/scripts/lib/sessions.ts`: `startCommand`, `limitedWorkers`, `restartable`, `discoverAll`, `adoptHint`(앞 낱말을 `orchWord()` 로 내는 선례). `skills/orch/scripts/lib/commands.ts` 의 `orchWord`, `skills/orch/scripts/lib/py.ts` 의 `shQuote`.
- `skills/orch/scripts/orch-loop.ts` 의 `WORKER-LIMITED` 문구는 `limited && !limitedNotified` 갈래(1511줄 근처)에 있다. 같은 갈래가 구조화 worker(`isStructured`)에도 돈다.

## 작업 항목

### 1. `skills/orch/scripts/lib/sessions.ts`

- `limitedWorkers`, `restartable` 의 `commands` 를 `` [`${orchWord()} worker resume --dispatch ${shQuote(dispatch)}`] `` 하나로 바꾼다. 쓰지 않게 된 `startCommand` 는 지운다.
- `restartable` 에 「그 dispatch 의 터미널(`rowHandles`)이 열려 있지 않음」 조건을 더한다. `discoverAll` 이 이미 읽은 `terminals` 를 넘긴다.
- 머리 주석의 다시 띄우기 설명을 고친다.

### 2. `skills/orch/scripts/adopt-sessions.ts`

머리 주석의 `LIMITED`, `RESTART` 설명(5~7줄)을 「아래 줄의 `orch worker resume` 을 부른다」 로 고친다. 코드는 바뀌지 않는다.

### 3. `skills/orch/scripts/orch-loop.ts`

터미널 worker 의 문구를 `사용 한도 ${dispatch} ${terminal}: 사용자에게 계정 전환을 요청하고, 바꾼 뒤 ${orchWord()} worker resume --dispatch ${dispatch}. 바꿀 계정이 없거나 resume 이 실패하면 references/agent-selection.md 의 「사용 한도에 걸렸을 때」` 로 바꾼다. 구조화 worker 는 지금 문구를 그대로 둔다. 머리 주석(170줄 근처)도 맞춘다.

### 4. 테스트

- `skills/orch/tests/adopt-sessions.spec.ts`: 「살아 있는 dispatch 의 화면이 사용 한도 안내면 LIMITED 와 다시 띄울 명령을 낸다」, 「Task 가 ready 이고 마지막 dispatch 가 failed 면 RESTART …」 의 기대 줄을 `  <orchWord()> worker resume --dispatch <id>` 한 줄로 바꾼다(테스트의 PATH 에서 `orchWord()` 가 내는 값을 그대로 쓴다). 터미널이 열린 failed dispatch 는 `RESTART` 로 내지 않는 사례를 더한다.
- `skills/orch/tests/orch-loop-stall.spec.ts`: 터미널 worker 의 `사용 한도` 알림 본문에 `worker resume --dispatch` 와 `계정 전환` 이 들고, 「세션 한도 오류는 사용 한도로 한 번 알린다」(구조화 worker) 사례의 본문에는 `worker resume` 이 없음을 본다.

## 검증

```bash
node scripts/run-node-tests.ts skills/orch/tests/adopt-sessions.spec.ts skills/orch/tests/orch-loop-stall.spec.ts skills/orch/tests/resume-worker.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/sessions.ts` | 수정 |
| `skills/orch/scripts/adopt-sessions.ts` | 수정 |
| `skills/orch/scripts/orch-loop.ts` | 수정 |
| `skills/orch/tests/adopt-sessions.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-stall.spec.ts` | 수정 |
