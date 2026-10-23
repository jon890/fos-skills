# Phase 04. 대기와 질문 감시 명령을 옮기고 worker-question, worker-done, worker-lost 를 낸다

**Execution profile**: deep

## 목표

`wait-important`, `triage-messages`, `watch-questions` 와 그 모듈(`questions`, `completion_evidence`)을 TypeScript 로 옮긴다.
코디네이터가 알아야 하는 조회 실패를 stderr 가 아니라 stdout 의 `WATCH-ERROR` 줄로 내, 하네스의 출력 알림이 받게 한다. worker 단계의 이벤트(`worker-question`, `worker-done`, `worker-lost`)를 낸다.

**범위 외**: 상주 루프(`orch-loop`)가 질문 확인을 틱으로 하는 일. 그 일은 상주 루프 plan 이 한다. 이 phase 의 `watch-questions` 는 Monitor 이벤트 소스로 그대로 쓴다. shim 의 공통 처리(`orch/scripts/ts_shim.py`)는 고치지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/questions.py`(모듈) | `orch/scripts/lib/questions.ts` | `orch/tests/test_questions.py` → `orch/tests/questions.spec.ts`. doctor 사례는 `orch/tests/test_orch_doctor.py` 로 옮긴다 |
| `orch/scripts/completion_evidence.py`(모듈) | `orch/scripts/lib/completion.ts` | `orch/tests/test_completion_evidence.py` → `orch/tests/completion.spec.ts` |
| `orch/scripts/watch-questions.py` | `orch/scripts/watch-questions.ts` | `questions.spec.ts` 가 함께 다룬다 |
| `orch/scripts/wait-important.py` | `orch/scripts/wait-important.ts` | `orch/tests/test_wait_important.py` → `orch/tests/wait-important.spec.ts` |
| `orch/scripts/triage-messages.py` | `orch/scripts/triage-messages.ts` | `orch/tests/test_scripts.py` 의 `TriageTest` → `orch/tests/triage-messages.spec.ts` |

`orch-doctor.py` 는 아직 Python 이고 `questions` 모듈을 import 한다. 그래서 `questions.py` 는 phase 05 에서 doctor 를 옮긴 뒤 지운다. 이 phase 에서는 남긴다.
`completion_evidence.py` 는 `wait-important` 와 `triage-messages` 만 import 하므로 이 phase 에서 지운다.

가짜 orca 를 넣는 환경 변수가 바뀐다. `questions.py` 는 `ORCA_CLI_COMMAND` 를 읽었고, `lib/orca.ts` 는 `ORCA` 만 읽는다(그 파일 머리 주석).
그래서 `watch-questions.ts` 는 `ORCA` 를 따르고, `test_questions.py` 의 CLI 사례가 넣던 `ORCA_CLI_COMMAND` 는 `questions.spec.ts` 에서 `ORCA` 로 바꾼다.
`triage-messages.py` 는 `orca` 를 고정해 부른다. `lib/orca.ts` 로 바꿔 `ORCA` 를 따르게 한다. `wait-important` 는 지금도 `ORCA` 와 `PS` 를 읽는다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 파일은 `orch/scripts/ts_shim.py` 의 `exec_ts(__file__)` 를 `if __name__ == "__main__":` 안에서 부르는 꼴이다. `orch/scripts/launch-worker.py` 가 그 꼴의 예다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `wait-important.py`, `triage-messages.py`, `watch-questions.py` 에 둔다.

`orch/hooks/block-background-wait.ts` 의 판정 정규식은 `\bwait-important\b` 라 이미 `wait-important.ts` 에도 맞는다. 바꿀 곳은 거부 이유(`REASON`)의 `wait-important.py` 문구뿐이다.

`fire` 의 시그니처는 `fire(event, input, ctx: { repo, base: string, run: string | null, cwd?, out? })` 이다(`lib/events.ts`). ctx 는 아래 값이다.

| 명령 | `repo` | `base` | `run` |
| --- | --- | --- | --- |
| `watch-questions` | `--repo`. 없으면 작업 디렉터리의 `mainCheckout` | `defaultBase(repo)`. null 이면 `""` | `--run`. 없으면 질문 조회가 `run-current` 로 찾은 Run |
| `wait-important` | 작업 디렉터리의 `mainCheckout`. 이 명령에는 `--repo` 옵션이 없다 | `defaultBase(repo)`. null 이면 `""` | `--run`(필수) |

이벤트 입력 필드는 `docs/data-schema.md` 의 「이벤트별 필드」 표가 소유한다. 채우는 값은 아래와 같다. `worker` 의 `task`, `dispatch` 는 `completion_evidence.py` 의 `context` 와 같은 키(`task_id`, `taskId`, payload 안의 같은 키)로 메시지에서 읽는다.

| 이벤트 | `worker` | 나머지 필드 |
| --- | --- | --- |
| `worker-question` | `task`, `dispatch` 는 질문 메시지에서. `terminal` 은 `from_handle`. `worktree`, `spec` 은 null | `message`: 메시지의 `id`, `type`, `subject`, `body`. `reminder`: `REMINDER` 줄이면 true. `age_sec`: 지금과 `created_at` 의 차(초, 정수) |
| `worker-done` | `task`, `dispatch` 는 `worker_done` 메시지에서. `terminal` 은 `from_handle` 또는 `fromHandle`. `worktree`, `spec` 은 null | `outcome`: 메시지나 payload 의 `outcome`, 없으면 null. `evidence`, `pr` 은 아래 표 |
| `worker-lost` | `worker-list` 행의 `taskId`, `dispatchId`, `agentTerminalHandle`. `worktree`, `spec` 은 null | `stage`: `WORKER_LOST` 줄의 `stage=` 값 |

`worker-done` 의 판정별 처리:

| 판정 | 처리 |
| --- | --- |
| `classify` 가 `ready` | `evidence: 'ready'`. `pr` 은 아래 방법으로 채운다 |
| `classify` 가 `suspicious` | `evidence: 'suspicious'`. `pr` 은 null |
| `classify` 가 `failure_report` | `worker-done` 을 내지 않는다 |
| `--completion-contract none` | 판정하지 않으므로 `worker-done` 을 내지 않는다 |

`pr` 은 `completionVerification.pr` 번호로 `gh pr view <번호> --json number,title,headRefName,headRefOid,author,isDraft,url` 을 저장소(`repo`)에서 읽어 스키마 필드(`number`, `title`, `branch`, `head`, `author`, `draft`, `url`)로 옮긴다. `author` 는 `author.login` 이다. 읽지 못하면 `pr` 은 null 이다. `lib/gh.ts` 의 `ghJson` 을 쓴다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」, 「운영 공백을 막는 곳」, 「갈래」, `docs/data-schema.md`, `docs/code-architecture.md` 의 「실행 규칙」 의 오류 출력 줄

## 의도 메모

- 하네스는 백그라운드 명령과 Monitor 의 stderr 를 알림으로 보내지 않는다. 조회가 계속 실패해도 코디네이터가 모르고 질문이 쌓였다. 그래서 코디네이터가 알아야 하는 실패는 stdout 줄이다.
- `HISTORY_LIMIT` 의 조회 범위 안내(질문 100건 이상)는 `WATCH-ERROR` 가 아니다. 그 Run 에서는 조회마다 나오므로 stdout 으로 내면 Monitor 가 조회 간격마다 코디네이터를 깨운다. 지금처럼 stderr 로만 낸다.
- `worker-done` 은 완료 근거 판정 뒤, 묶음의 JSON 줄을 내기 전에 낸다. 핸들러 출력(`[hook worker-done] ...`)과 `HOOK-FAIL` 줄이 JSON 줄 앞에 오고, `LAST_DELIVERY` 가 마지막 줄이라는 계약이 그대로 남는다.
- 이 phase 가 내는 이벤트는 모두 거부할 수 없다. 핸들러 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다. 근거는 `docs/flow.md` 「갈래」 의 「띄우기와 대기 명령은 알림 이벤트의 실패를 종료 코드에 반영하지 않는다」 문장이다.
- 영어로 된 머리 주석과 주석(`questions.py`, `watch-questions.py`)은 옮기면서 한국어로 쓴다.

## 작업 항목

### 1. 위 표의 명령과 모듈을 옮긴다

종료 코드, `LAST_DELIVERY`, `WORKER_LOST`, `QUESTION`, `REMINDER` 줄, `state/questions-seen.json` 과 `state/wait-important-lost.json` 의 형식은 원본과 같다.

### 2. `WATCH-ERROR` 줄

`WATCH-ERROR <이유>` 한 줄을 stdout 에 내고 stderr 에도 같은 내용을 남긴다. 이유는 줄바꿈을 공백으로 바꾼 한 줄이다.

| 명령 | 내는 경우 |
| --- | --- |
| `watch-questions` | `check` 실패, 질문 기록 읽기 실패. 질문 조회(`lib/questions.ts` 의 snapshot)가 던지는 오류 전부와 `state/questions-seen.json` 을 읽거나 쓰지 못한 경우다. 답변 기록 한도에 닿아 답변 여부를 확인하지 못한 오류도 여기 든다 |
| `wait-important` | `check --wait` 가 실패해 종료 코드 1 로 끝나는 경우. 끊긴 worker 확인용 `worker-list` 가 실패한 경우(대기 시작 때와 대기 중 확인 모두) |

내지 않는 경우: `HISTORY_LIMIT` 조회 범위 안내, `waiter_exists`(종료 코드 4 와 stderr 의 프로세스 목록이 맡는다), 완료 근거용 `check --all` 실패(이미 의심스러운 worker_done 줄과 종료 코드 6 으로 알린다).

같은 이유는 이유가 바뀌거나 조회가 한 번 성공할 때까지 다시 내지 않는다. 한 프로세스 안에서 마지막으로 낸 이유를 기억한다. `--once` 는 한 번만 조회하므로 실패하면 늘 낸다.
`wait-important` 의 `WATCH-ERROR` 줄은 `LAST_DELIVERY` 줄보다 앞에 둔다. `LAST_DELIVERY` 가 마지막 줄이라는 계약 때문이다.

### 3. 이벤트

| 이벤트 | 내는 곳 | 시점 |
| --- | --- | --- |
| `worker-question` | `watch-questions.ts` | `QUESTION` 이나 `REMINDER` 줄을 낸 직후 |
| `worker-done` | `wait-important.ts` | 묶음 안의 `worker_done` 마다, 완료 근거를 판정한 뒤 JSON 줄을 내기 전. 위 판정별 처리 표대로 |
| `worker-lost` | `wait-important.ts` | `WORKER_LOST` 줄을 처음 낼 때. `LAST_DELIVERY` 줄 앞 |

### 4. 문서, 거부 이유, 테스트 정리

- `docs/data-schema.md` 「이벤트별 필드」 표의 `worker-done` 줄에 「`worker_done --outcome failed` 같은 실패 보고와 `--completion-contract none` 의 대기에서는 내지 않는다」 를 더한다
- `orch/README.md` 에서 지운 `scripts/completion_evidence.py` 줄을 뺀다
- `orch/hooks/block-background-wait.ts` 의 `REASON` 의 `wait-important.py` 를 `wait-important` 로 바꾼다. 정규식은 바꾸지 않는다
- `orch/tests/test_scripts.py` 맨 위의 `tm = load("triage-messages")` 줄을 `TriageTest` 와 함께 지운다. 남기면 shim 을 import 해 `tm` 을 쓰는 곳 없이 남는다
- `orch/tests/test_questions.py` 의 `test_doctor_warns_only_for_overdue_unanswered` 와 `test_orca_errors_and_timeout` 의 doctor 부분(질문 조회가 `TimeoutExpired` 나 `RuntimeError` 면 `check_questions` 가 종료 코드 0)을 `orch/tests/test_orch_doctor.py` 로 옮긴다. doctor 는 아직 Python 이라 TS 테스트로는 볼 수 없다

### 5. 테스트를 옮긴다

표의 사례를 모두 옮기고 원본 테스트를 지운다(`test_scripts.py` 는 `TriageTest` 만).
더할 사례:

| 입력 | 기대 |
| --- | --- |
| 가짜 orca 의 `check` 가 실패한다. `watch-questions.ts --once` | stdout 에 `WATCH-ERROR` 줄, 종료 코드 1 |
| 같은 실패가 두 번 이어진 뒤 한 번 성공하고 다시 실패한다. 반복 모드를 짧은 `--interval` 로 돌린다 | `WATCH-ERROR` 가 두 번 나온다(처음과 회복 뒤) |
| 질문이 100건인 Run | stdout 에 `WATCH-ERROR` 가 없고 stderr 에 조회 범위 안내 |
| `.orch/hooks/worker-question.ts` 가 stdin 을 파일에 쓴다 | 입력의 `message.id`, `reminder`, `worker.terminal` |
| `wait-important.ts` 의 끊긴 worker 확인용 `worker-list` 가 실패하고 그 뒤 처리할 묶음이 온다 | `WATCH-ERROR` 줄이 `LAST_DELIVERY` 줄보다 앞, 종료 코드 0 |
| 준비 상태가 있는 `worker_done` 과 `.orch/hooks/worker-done.ts` | 입력의 `evidence` 가 `ready`, `pr.number` 와 `pr.head` 가 가짜 gh 의 값. 핸들러 출력 줄이 JSON 줄보다 앞 |
| 준비 상태가 없는 `worker_done` | 입력의 `evidence` 가 `suspicious`, `pr` 이 null, 종료 코드 6 |
| `--outcome failed` 의 `worker_done`, `--completion-contract none` | 핸들러가 불리지 않는다 |
| `worker-done.ts` 가 1 로 끝난다 | 종료 코드는 핸들러가 없을 때와 같다. `HOOK-FAIL worker-done 1` 줄 |
| `block-background-wait.spec.ts`: `node .../wait-important.ts --run r &` | 거부 |

## 검증

```bash
node --test --test-concurrency=4 orch/tests/questions.spec.ts orch/tests/completion.spec.ts orch/tests/wait-important.spec.ts orch/tests/triage-messages.spec.ts orch/tests/block-background-wait.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_scripts.py
python3 -m unittest orch/tests/test_orch_doctor.py
python3 scripts/run-orch-tests.py --jobs 4
! grep -n "completion_evidence" orch/README.md
python3 korean-check/scripts/korean-style-check.py docs/data-schema.md orch/README.md
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
| `orch/README.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `orch/tests/questions.spec.ts` | 신규 |
| `orch/tests/completion.spec.ts` | 신규 |
| `orch/tests/wait-important.spec.ts` | 신규 |
| `orch/tests/triage-messages.spec.ts` | 신규 |
| `orch/tests/block-background-wait.spec.ts` | 수정 |
| `orch/tests/test_questions.py` | 삭제 |
| `orch/tests/test_completion_evidence.py` | 삭제 |
| `orch/tests/test_wait_important.py` | 삭제 |
| `orch/tests/test_scripts.py` | 수정 |
| `orch/tests/test_orch_doctor.py` | 수정 |
