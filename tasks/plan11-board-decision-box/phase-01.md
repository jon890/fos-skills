# Phase 01. 결정 필요 상자에서 Orca 자동 알림 빼기와 요청문 강화

**Execution profile**: standard

## 목표

「결정 필요」 상자와 상태 줄의 결정 필요 수에 worker 의 `question` 과 worker 가 직접 보낸 `escalation` 만 남긴다(R1, R2, R3).
「정할 것 묻기」 요청문(`DECIDE_PROMPT`)에 막힘과 자동 알림을 다루는 지시를 더한다(R7).

**범위 외**: worker 줄의 멈춤·오류 표시(phase 02), 「worker 없음 · N시간」(phase 03). orch 의 질문 조회(`orch/scripts/lib/questions.ts`)는 고치지 않는다.

## 컨텍스트

- 스펙: `docs/features/board-decision-box/spec.md` 의 R1, R2, R3, R7 과 D1, D5, D7, D10.
- 상자는 `work-board/hooks/register.js` 의 `queryQuestions($, runId, active)` 결과(`questions`)를 그린다. 이 함수는 `check --all`, `check --peek` 의 `question,escalation` 을 모아 `candidates` 로 두고, 질문마다 handle 의 inbox 를 읽어 답(`replies`)을 모은 뒤 `parseQuestions(JSON.stringify({ messages: [...candidates, ...replies] }), runId, workerOf)` 로 미답변을 낸다.
- `parseQuestions` 는 같은 worker(`keyOf`)의 질문을 묶어 가장 늦은 미답변 하나만 낸다. 자동 알림을 보이는 후보로 두면 더 늦은 자동 알림이 worker 가 직접 올린 막힘을 가린다. 그래서 답 기준선은 모든 질문에서 정하고, 보이는 후보에서만 뺀다.
- Orca 자동 알림의 id 는 `msg_stop_<hex>`(「Worker stopped without reporting」 등)와 `msg_chaterr_<hex>`(「Agent hit an error: …」)다. 2026-11-02 inbox 실측에서 일반 메시지 id 는 `msg_<hex>` 다. 같은 제목을 worker 가 직접 보내면 id 가 `msg_<hex>` 라 자동 알림이 아니다(R2).
- R3 의 「해제·중지」 는 지금의 `alive(m)` 조건이 이미 맡는다(살아 있는 worker 의 질문만 후보로 남긴다). `active` 는 `parseWorkers` 가 고른 살아 있는 worker(`dispatchStatus` 가 `pending`, `dispatched`, `running`)다. 2026-11-02 실측에서 `worker-stop` 한 dispatch 는 `dispatchStatus: failed` 라 빠진다. `worker-release` 는 끝난(settled) worker 의 터미널만 놓으므로(`orca orchestration --help`) 해제된 worker 도 이미 살아 있는 상태가 아니다. 이 phase 는 그 동작을 테스트로 고정한다.
- 상태 줄의 수는 `statusLine(items, state)` 가 `state.questions.length` 로 센다. `questions` 에서 빠지면 수에서도 빠진다.
- 요청문 테스트는 `work-board/tests/prompts.spec.ts`(node test)가 본다. 상자 테스트는 새 node test 파일 `work-board/tests/decision-box.spec.ts` 에 둔다. `claude plugin test .` 가 도는 `*.test.ts` 는 planning 검사기가 실행기로 알아보지 못해 쓰지 않는다.

**근거 문서**: `docs/features/board-decision-box/spec.md` 의 R1~R3, R7

## 의도 메모

- 답 기준선은 지금처럼 자동 알림을 포함해 정한다. `parseQuestions` 는 같은 worker 묶음에서 가장 늦게 답한 메시지보다 이른 미답변을 푼 것으로 본다. 코디네이터가 더 늦은 자동 알림 thread 에 답했으면 그 worker 의 앞선 막힘도 푼다. 스펙 D5 의 「답장」 과 같은 뜻이고 orch `lib/questions.ts` 의 `unanswered` 와 같다. 자동 알림을 묶기 전에 지우면 이미 답한 Run 에서 닫힌 막힘이 상자에 되살아난다. 그래서 묶음에는 넣고, 보이는 미답변 후보에서만 뺀다.
- 제목(「Worker stopped without reporting」)으로 가리지 않는다. worker 가 같은 제목을 쓰면 사람이 답할 막힘이 사라진다(D10).
- 자동 알림을 `candidates` 에서 지우지 않고 별도 목록으로 남긴다. phase 02 가 그 목록으로 오류 표시와 답 기다림 판정을 만든다. 답을 읽을 handle 도 지금처럼 모든 후보에서 모은다.

## 작업 항목

### 1. `work-board/hooks/register.js` 의 자동 알림 가리기

- `export function autoAlertKind(m)` 를 더한다. `String(m.id || '')` 가 `msg_stop_` 로 시작하면 `'stop'`, `msg_chaterr_` 로 시작하면 `'error'`, 아니면 `null` 이다. 머리 주석에 스펙 D10 과 실측 id 꼴을 적는다.
- `parseQuestions(stdout, runId, keyOf = null, shown = null)` 에 넷째 인자 `shown`(메시지를 받아 참거짓을 내는 함수)을 더한다. 묶음 안의 답 기준선(`last`)은 지금처럼 모든 질문에서 정하고, 미답변 후보(`open`)만 `!shown || shown(원본 메시지)` 인 것으로 줄인다. `repeats` 도 줄인 후보로 센다. `shown` 이 없으면 지금과 같다. 원본 메시지는 `asked` 를 만들 때 `{ ..., message: m }` 로 붙여 두고 반환값에서는 뺀다(반환 모양은 그대로다).
- `queryQuestions` 에서 `candidates` 를 만든 뒤 `const alerts = candidates.filter((m) => autoAlertKind(m))` 를 둔다.
- 반환값 `questions` 는 `parseQuestions(JSON.stringify({ messages: [...candidates, ...replies] }), runId, workerOf, (m) => !autoAlertKind(m))` 로 만든다.
- 답변 기록 한도 판정(`unsure`)도 같은 `shown` 을 넘겨 자동 알림이 아닌 미답변이 남을 때만 오류로 본다.
- 반환 객체에 `alerts`(자동 알림 메시지 원본 목록)를 더한다. 이 phase 에서는 그리지 않는다.
- 파일 머리 주석의 「결정 필요」 설명과 `queryQuestions` 주석에 「Orca 자동 알림(id 접두 `msg_stop_`, `msg_chaterr_`)은 상자 후보에서 뺀다」 를 더한다.

### 2. `work-board/hooks/register.js` 의 `DECIDE_PROMPT`

기존 4줄 뒤에 아래 뜻의 줄을 더한다. 스펙 D7 의 (a)~(d) 를 모두 담는다.

- (a) worker 가 직접 올린 막힘은 먼저 확인해 처리할 수 있으면 처리하고, 사람이 정할 것만 결정으로 묻는다
- (b) Orca 자동 알림(「Worker stopped without reporting」 같은 멈춤, 「Agent hit an error」 같은 오류)은 묻지 않고 처리한 결과만 한 줄로 알린다
- (c) 처리한 막힘은 이어갈 일이 있는 worker 면 답장(`send-to-worker.ts`)으로 깨우고, 일이 끝난 worker 는 답장 대신 해제(`orca orchestration worker-release`)로 닫는다. 답장이 끝난 worker 를 다시 깨우기 때문이다
- (d) 자동 알림 가운데 계정 한도에 걸렸거나 터미널이 종료된 worker 는 묻지 않고 같은 워크트리에서 다시 띄우고, 멈춘 worker 는 상태를 확인해 필요하면 깨운다

### 3. 이 phase 를 검증하는 `work-board/tests/decision-box.spec.ts` 신규(node test)

`register.js` 의 순수 함수와 `queryQuestions` 를 node test 로 본다. `queryQuestions` 는 `{ process: { run: async (argv) => ({ exitCode: 0, stdout, stderr: '' }) } }` 꼴의 가짜 `$` 로 부른다(`work-board/tests/live.test.ts` 의 「끝난 dispatch 의 질문은 세지 않고…」 테스트와 같은 형태). `version.spec.ts` 처럼 `../hooks/register.js` 를 import 한다.

- R1: 살아 있는 worker `open` 의 메시지 넷. `msg_stop_aa`(escalation, 제목 「Worker stopped without reporting」), `msg_chaterr_bb`(escalation, 제목 「Agent hit an error: Claude hit its session limit.」), worker 의 question `msg_q1`, worker 의 escalation `msg_e1`. `questions` 의 id 는 `msg_q1`, `msg_e1` 을 묶은 결과(같은 worker 라 늦은 하나)뿐이고 자동 알림 id 가 없다. `alerts` 의 id 는 `msg_stop_aa`, `msg_chaterr_bb` 다.
- R1 묶음: 자동 알림이 worker 의 막힘보다 늦게 와도(`created_at` 이 더 늦다) worker 의 막힘이 `questions` 에 남는다.
- R1 수: `statusLine([], { questions: <위 결과>, errors: {} })` 가 「결정 필요 1」 을 담고, 자동 알림만 있으면 「결정 필요」 를 담지 않는다.
- R2: id 가 `msg_9f2c…` 이고 제목이 「Worker stopped without reporting」 인 worker 의 escalation 은 `questions` 에 남는다. `autoAlertKind` 가 `msg_stop_x` → `'stop'`, `msg_chaterr_x` → `'error'`, `msg_stopx` → `null`, `msg_x` → `null` 이다.
- R3: worker 가 직접 올린 escalation 에 그 thread 의 답(`to_handle: 'dispatch:open'`)이 있으면 빠진다. 같은 worker 의 더 늦은 `msg_stop_` 알림에 답이 있으면 앞선 막힘도 빠진다. 답이 없는 더 늦은 자동 알림은 앞선 막힘을 가리지 않는다. 같은 escalation 의 dispatch 가 `active` 에 없으면(해제·중지) 빠진다. `active` 에 있고 답이 없으면 남는다.

### 4. 이 phase 를 검증하는 `work-board/tests/prompts.spec.ts`

「정할 것 묻기 요청문」 테스트에 D7 의 핵심 구절 검사를 더한다. 「직접 올린 막힘」, 「사람이 정할 것만」, 「자동 알림」, 「한 줄로」, 「해제」, 「계정 한도」, 「터미널이 종료」, 「같은 워크트리」 가 모두 `DECIDE_PROMPT` 에 있다. 기존 구절 검사는 그대로 둔다.

## 검증

```bash
node --test work-board/tests/prompts.spec.ts work-board/tests/decision-box.spec.ts
claude plugin test .
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts" "inbox/tests/*.spec.ts"
```

세 명령 모두 종료 코드 0 이다. `claude plugin test .` 는 기존 `*.test.ts` 가 그대로 통과하는지 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/hooks/register.js` | 수정 |
| `work-board/tests/decision-box.spec.ts` | 신규 |
| `work-board/tests/prompts.spec.ts` | 수정 |
