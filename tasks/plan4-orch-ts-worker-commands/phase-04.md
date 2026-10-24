# Phase 04. 대기와 질문 감시 명령을 옮기고 worker-question, worker-done, worker-lost 를 낸다

**Execution profile**: deep

## 목표

`wait-important`, `triage-messages`, `watch-questions` 와 그 모듈(`questions`, `completion_evidence`)을 TypeScript 로 옮긴다.
조회 실패를 stderr 가 아니라 stdout 의 `WATCH-ERROR` 줄로 내, 하네스의 출력 알림이 받게 한다. worker 단계의 세 이벤트를 낸다.

**범위 외**: 상주 루프(`orch-loop`)가 질문 확인을 틱으로 하는 일. 그 일은 상주 루프 plan 이 한다. 이 phase 의 `watch-questions` 는 Monitor 이벤트 소스로 그대로 쓴다.

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/questions.py`(모듈) | `orch/scripts/lib/questions.ts` | `orch/tests/test_questions.py` → `orch/tests/questions.spec.ts` |
| `orch/scripts/completion_evidence.py`(모듈) | `orch/scripts/lib/completion.ts` | `orch/tests/test_completion_evidence.py` → `orch/tests/completion.spec.ts` |
| `orch/scripts/watch-questions.py` | `orch/scripts/watch-questions.ts` | `questions.spec.ts` 가 함께 다룬다 |
| `orch/scripts/wait-important.py` | `orch/scripts/wait-important.ts` | `orch/tests/test_wait_important.py` → `orch/tests/wait-important.spec.ts` |
| `orch/scripts/triage-messages.py` | `orch/scripts/triage-messages.ts` | `orch/tests/test_scripts.py` 의 `TriageTest` → `orch/tests/triage-messages.spec.ts` |

`orch-doctor.py` 는 아직 Python 이고 `questions` 모듈을 import 한다. 그래서 `questions.py` 는 phase 05 에서 doctor 를 옮긴 뒤 지운다. 이 phase 에서는 남긴다.
`completion_evidence.py` 는 `wait-important` 와 `triage-messages` 만 import 하므로 이 phase 에서 지운다.
`triage-messages.py` 는 `orca` 를 고정해 부른다. `lib/orca.ts` 로 바꿔 `ORCA` 를 따르게 한다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `wait-important.py`, `triage-messages.py`, `watch-questions.py` 에 둔다.
`orch/hooks/block-background-wait.ts` 는 `wait-important.py` 이름을 본다. `wait-important.ts` 도 같은 판정에 들게 고치고 `block-background-wait.spec.ts` 에 사례를 더한다.

이벤트 입력 필드는 `docs/data-schema.md` 의 「이벤트별 필드」 표가 소유한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 과 「운영 공백을 막는 곳」, `docs/data-schema.md`, `docs/code-architecture.md` 의 「실행 규칙」 의 오류 출력 줄

## 의도 메모

- 하네스는 백그라운드 명령과 Monitor 의 stderr 를 알림으로 보내지 않는다. 조회가 계속 실패해도 코디네이터가 모르고 질문이 쌓였다. 그래서 코디네이터가 알아야 하는 실패는 stdout 줄이다.
- `worker-done` 은 완료 근거 판정 뒤에 낸다. 핸들러가 의심스러운 완료를 보고 저장소 고유 확인을 할 수 있게 `evidence` 를 넘긴다.
- 영어로 된 머리 주석과 주석(`questions.py`, `watch-questions.py`)은 옮기면서 한국어로 쓴다.

## 작업 항목

### 1. 위 표의 명령과 모듈을 옮긴다

종료 코드, `LAST_DELIVERY`, `WORKER_LOST`, `QUESTION`, `REMINDER` 줄, `state/questions-seen.json` 과 `state/wait-important-lost.json` 의 형식은 원본과 같다.

### 2. `WATCH-ERROR` 줄

`watch-questions.ts` 와 `wait-important.ts` 는 orca 조회 실패와 기록 한도 도달을 `WATCH-ERROR <이유>` 한 줄로 stdout 에 낸다. stderr 에도 같은 내용을 남긴다.

### 3. 이벤트

| 이벤트 | 내는 곳 | 시점 |
| --- | --- | --- |
| `worker-question` | `watch-questions.ts` | `QUESTION` 이나 `REMINDER` 줄을 낸 직후. `reminder` 는 `REMINDER` 일 때 true |
| `worker-done` | `wait-important.ts` | 묶음 안의 `worker_done` 마다 완료 근거를 판정한 뒤 |
| `worker-lost` | `wait-important.ts` | `WORKER_LOST` 줄을 처음 낼 때 |

세 이벤트 모두 거부할 수 없다. 핸들러 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다. 대기의 종료 코드는 코디네이터가 다음 동작을 고르는 신호라 핸들러 실패로 바꾸면 안 된다.

### 4. 테스트를 옮긴다

표의 사례를 모두 옮기고 원본 테스트를 지운다(`test_scripts.py` 는 `TriageTest` 만).
더할 사례: 가짜 orca 의 `check` 가 실패하면 `watch-questions.ts --once` 의 stdout 에 `WATCH-ERROR` 줄과 종료 코드 1. `.orch/hooks/worker-question.ts` 가 받은 입력의 `message.id` 와 `reminder`.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/questions.spec.ts orch/tests/completion.spec.ts orch/tests/wait-important.spec.ts orch/tests/triage-messages.spec.ts orch/tests/block-background-wait.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_scripts.py
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/questions.ts` | 신규 |
| `orch/scripts/lib/completion.ts` | 신규 |
| `orch/scripts/watch-questions.ts` | 신규 |
| `orch/scripts/wait-important.ts` | 신규 |
| `orch/scripts/triage-messages.ts` | 신규 |
| `orch/scripts/watch-questions.py` | 수정 |
| `orch/scripts/wait-important.py` | 수정 |
| `orch/scripts/triage-messages.py` | 수정 |
| `orch/scripts/completion_evidence.py` | 삭제 |
| `orch/hooks/block-background-wait.ts` | 수정 |
| `orch/tests/questions.spec.ts` | 신규 |
| `orch/tests/completion.spec.ts` | 신규 |
| `orch/tests/wait-important.spec.ts` | 신규 |
| `orch/tests/triage-messages.spec.ts` | 신규 |
| `orch/tests/block-background-wait.spec.ts` | 수정 |
| `orch/tests/test_questions.py` | 삭제 |
| `orch/tests/test_completion_evidence.py` | 삭제 |
| `orch/tests/test_wait_important.py` | 삭제 |
| `orch/tests/test_scripts.py` | 수정 |
