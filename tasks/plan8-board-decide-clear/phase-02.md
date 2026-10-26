# Phase 02. 창이 남은 결정 줄과 답하지 않은 질문만 센다

**Execution profile**: standard

## 목표

창과 상태 줄의 결정 필요 수가 decide 항목의 남은 줄과 답하지 않은 질문만 센다. 코디네이터 터미널에서 `orca orchestration reply` 로 답한 질문이 빠지고, 같은 worker 가 다시 보낸 질문은 하나로 센다.

**범위 외**: `board.ts` 의 줄 명령(phase 01), orch(phase 03).

## 컨텍스트

실측한 회신 모양(2026-10-26, Orca inbox):

- 회신은 `type: status`, `thread_id` 가 질문 id, `to_handle` 이 `dispatch:<그 worker 터미널의 지금 dispatch>` 다. 질문 payload 의 `dispatchId` 와 다를 수 있다.
- 보낸 사람은 `run:<Run>` 이거나 코디네이터 터미널 `term_*` 이다.
- 질문 행은 `thread_id` 가 자기 id 이거나 null 이다.
- `inbox --terminal term_<worker>` 는 그 회신을 내지 않는다. `inbox --terminal dispatch:<id>` 는 낸다.

지금 `work-board/hooks/register.js` 의 `queryQuestions` 는 질문 발신자 handle 의 inbox 만 읽고 `from_handle === 'run:<Run>'` 인 회신만 남긴다. `parseQuestions` 도 같은 조건으로 답을 판정한다.

**근거 문서**: `docs/adr/015-board-decide-clear.md`

## 의도 메모

- 전체 inbox 를 읽지 않는다. 창이 45초마다 읽는다.
- 본문 비교로 다시 보낸 질문을 찾지 않는다. worker 가 본문을 바꿔 다시 보낸다.

## 작업 항목

### 0. 남은 결정 줄 세기

- `decideCount(items)` 를 export 한다. decide 항목마다 details 와 next 의 끝나지 않은 줄 수를 더하고, 줄이 없는 항목은 1 로 센다. 줄은 `normalizeLines` 로 읽는다.
- `statusLine` 과 `decideView` 의 수가 `count('decide')` 대신 `decideCount` 와 질문 수의 합을 쓴다.

### 1. `work-board/hooks/register.js` 의 `parseQuestions(stdout, runId, keyOf?)`

- 답 판정: 같은 Run 의 메시지 가운데 `thread_id` 가 질문 id 이고, id 가 질문 id 와 다르고, `to_handle` 이 `run:<Run>` 이 아닌 것이 있으면 답한 질문이다. 보낸 사람은 보지 않는다.
- 묶기: `keyOf(m)` 이 없으면 worker 열쇠는 질문의 dispatch(payload `dispatchId`, 없으면 `dispatch:` 를 뗀 발신자), 그것도 없으면 발신자다.
  열쇠마다 답한 질문 가운데 가장 늦은 `created_at` 보다 늦지 않은 미답변 질문은 뺀다. 남은 미답변 가운데 가장 늦은 것 하나만 내고 `repeats` 에 묶인 나머지 수를 둔다.
  `created_at` 이 같거나 없으면 입력 순서가 뒤인 것을 늦은 것으로 본다.
- 반환 행에 `repeats`(0 이상 정수)를 더한다.

### 2. `queryQuestions($, runId, active)`

- 질문마다 읽을 handle 은 발신자, `dispatch:<payload dispatchId>`, 그 질문이 붙은 살아 있는 worker 의 `dispatch:<id>` 다. 중복은 한 번만 읽고 네 개씩 읽는다.
- 회신 행을 `from_handle` 로 고르지 않는다. thread 가 후보 질문인 행을 모두 남긴다.
- 답변 기록 한도 판정은 그 handle 로 묶인 질문 기준으로 지금과 같이 한다.
- `parseQuestions` 에 살아 있는 worker 의 id 로 묶는 `keyOf` 를 넘긴다(질문의 dispatch 가 살아 있는 id 면 그것, 아니면 발신 터미널이 같은 worker 의 id).

### 3. 창

- `questionView` 머리 줄에 `repeats > 0` 이면 ` · 다시 보냄 <repeats>` 를 붙인다.

### 4. `work-board/README.md`

- 「결정 필요」 줄의 회신 판정과 조회 handle, 다시 보낸 질문 묶기, 남은 줄 세기를 고친다.

### 5. `work-board/tests/live.test.ts`

- `decideCount` 와 `statusLine` 이 끝난 줄을 빼고 센다. 줄이 없는 decide 항목은 1 이다.
- 코디네이터 터미널(`term_c`)이 `dispatch:open` 으로 보낸 회신이 있으면 `term_w` 가 보낸 질문이 빠진다. 조회한 handle 에 `dispatch:open` 이 든다.
- worker 의 후속 status(`to_handle: run:r`)는 답이 아니다.
- 같은 dispatch 의 미답변 질문 둘은 하나로 나오고 `repeats` 가 1 이다. 앞 질문이 미답변이고 뒤 질문이 답했으면 둘 다 빠진다.
- 기존 테스트 가운데 같은 dispatch 의 질문 여럿을 세는 기대값은 묶인 수로 고친다.

## 검증

```bash
claude plugin test work-board  # work-board/tests/live.test.ts 를 돌린다
```

기대값: 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/hooks/register.js` | 수정 |
| `work-board/README.md` | 수정 |
| `work-board/tests/live.test.ts` | 수정 |
