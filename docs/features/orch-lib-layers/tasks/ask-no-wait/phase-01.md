# Phase 01. worker-ask 를 보내고 바로 끝나게 바꾸기

**Execution profile**: standard

## 목표

`orch worker ask` 가 질문을 보내고 답을 기다리지 않고 끝난다. worker 는 턴을 끝내고 Orca 가 답과 함께 깨운다. 답을 기다리는 동안 worker 가 막히거나, 대기가 끊겨 `--resume` 을 다시 거는 일을 없앤다.

**범위 외**: `send-to-worker` 의 깨우기(다음 계획 send-wake), `orch wait` 과 명령 표의 `retired` 칸(계획 orca-wake). 이 phase 는 `--resume` 을 worker-ask 안에서만 거절한다.

## 컨텍스트

**요구사항**: REQ7, REQ8. REQ8 은 `orch worker ask --resume` 부분만 맡는다

**근거 문서**: `docs/features/orch-lib-layers/spec.md`(REQ7, REQ8, DECISION5, DECISION6, DECISION14), `docs/features/orch-lib-layers/design.md`(「worker 질문(PR1)」, DECISION4, DECISION5, DECISION6)

- 지금 `skills/orch/scripts/worker/worker-ask.ts` 는 ask 가 `pending: true` 로 바로 돌아오면 그 질문 id 로 `--resume` 해 답을 기다린다(머리 주석 「바로 돌아온 ask」). 기다리는 동안 `ORCH_ASK_POLL_MS` 마다 `check --peek` 으로 status 답도 찾는다. 이 둘이 없어진다.
- 남길 것(설계 표): `--decision` 형식 검사(`decisionProblems`, `blockProblems`), 읽지 않은 메시지 확인(`unreadOf`, 종료 코드 5, `--force`, `ORCH_ASK_SEEN`), 바쁨 재시도(`BUSY_CODES`, `BUSY_TRIES`, `ORCH_ASK_BUSY_MS`), 끝난 dispatch 의 Run 메일함 대신 보내기(`DISPATCH_GONE`, `SENT-RUN`, 3), `--full` 을 붙이는 `withFull`, 짧은 출력(`lib/output.ts` 의 `short`).
- Orca 1.4.254 `orca orchestration ask --help`: worker 의 새 질문은 바로 돌아온다. 끝난 worker 의 ask 는 답을 기다린다. `--timeout-ms` 는 1 부터 1800000. 시간 초과는 질문을 남긴다.
- 테스트는 `skills/orch/tests/worker-ask.spec.ts` 가 가짜 orca 로 돈다. 이 파일의 사례 묶음(`묻고 답 받기`, `바로 돌아온 ask`, `시간 제한`, `기다리는 동안 status 답`, `짧은 출력` 등)을 새 동작에 맞춘다. 동작을 바꾸는 PR 이므로 바뀐 동작의 기대값을 고친다(설계 「동작 같음 확인」 마지막 줄).
- `skills/orch/tests/spec-lint.spec.ts` 의 「표지는 있지만 본문이 틀과 다른 규칙」 사례가 틀의 `--max-wait` 안내 문장을 찾아 지운 사본을 만든다. 틀에서 그 문장이 사라지므로 이 사례가 지울 문장을 새 규칙의 다른 문장으로 바꾼다. 검사 동작의 기대값(경고 줄과 건수)은 그대로다.

## 의도 메모

- 기각: ask 에 `--wait` 를 주는 꼴을 옵션으로 남기기. 스펙 DECISION5 가 기다리는 옵션을 두지 않기로 했다.
- 기각: `--timeout-ms` 를 주지 않기. 끝난 worker 의 ask 가 기본 10분을 막는다(설계 DECISION4).
- `--timeout-ms`, `--max-wait` 는 값 형식도 보지 않는다. 옛 규칙대로 도는 worker 가 어떤 값을 넘겨도 멈추지 않게 하려는 것이다.
- 이 저장소 주 checkout 의 `.orch/specs/spec-common.md` 사본은 이 PR 이 고치지 않는다(git 이 추적하지 않는다). 머지 뒤 코디네이터가 `orch spec sync-common --apply` 로 맞춘다. PR 본문 「남은 일」 에 적는다.
- `lib/proc.ts` 의 `signal` 옵션은 worker-ask 만 쓰더라도 지우지 않는다. 머리 주석의 예시 문구만 고친다.

## 작업 항목

### 1. `skills/orch/scripts/worker/worker-ask.ts`

- 머리 주석을 새 흐름으로 다시 쓴다. 사용법 줄의 옵션은 `--from HANDLE --question TEXT [--options CSV] [--run ID] [--force] [--decision]` 이다. 종료 코드는 0(보냈다, 또는 바로 답을 받았다), 2(사용법·실행 오류, `--decision` 위반, `--resume`, 바쁨 지속, 닿았는지 모름), 3(Run 메일함으로 대신 보냄), 5(읽지 않은 메시지). 4 를 지운다.
- 옵션: `resume`, `timeout-ms`, `max-wait` 는 parseArgs 에 남긴다(모르는 옵션 오류가 나지 않게). `--resume` 이 있으면 orca 를 부르지 않고 stderr 에 `worker-ask: --resume 은 없어졌다. 질문을 보낸 뒤 턴을 끝내면 Orca 가 답과 함께 깨운다. 읽을 문서: 공통 지시서의 worker-ask 규칙` 한 줄과 2. `--timeout-ms` 나 `--max-wait` 가 있으면 stderr 에 `worker-ask: --timeout-ms, --max-wait 는 없어진 옵션이라 무시했다` 한 줄을 내고 계속한다. 값 검사(`양의 정수`)와 `ORCA_MAX_TIMEOUT_MS` 줄이기를 지운다.
- ask 호출: `['orchestration', 'ask', '--from', sender, '--question', question, '--timeout-ms', String(ASK_RETURN_MS), '--json']` 에 `--options` 를 더하고 `withFull` 을 붙인다. `ASK_RETURN_MS` 는 5000, `ORCH_ASK_RETURN_MS` 로 바꿀 수 있다(테스트용). `run`(동기)으로 부르고 제한 시간은 `ASK_RETURN_MS + ASK_SLACK_MS`.
- 결과 처리(설계 표 순서): 답이 있으면 `answered`(지금 함수) 후 0. 그 밖에 `messageIdOf` 가 있으면(pending, timedOut 모두) 짧은 출력 `ASKED <id>`, 긴 출력 `ASKED <id>` 뒤에 ask 출력, 0. stderr 에 `worker-ask: 질문 <id> 를 보냈다. 턴을 끝낸다. 답이 오면 Orca 가 깨우고, 깬 뒤 orca orchestration check 로 읽는다`. 0 인데 둘 다 없으면 `NO-ANSWER -` 와 2. 실패는 지금의 바쁨, 끝난 dispatch, 그 밖의 코드 분기를 그대로 쓴다. `if (resume)` 분기는 지운다.
- 지울 것: `POLL_MS`, `replyOf`, `idsOf`, 기다리는 루프의 `AbortController` 감시, 시간 초과 분기, `TIMEOUT` 출력, `DEFAULT_TIMEOUT_MS`, `ORCA_MAX_TIMEOUT_MS`. `runAsync` import 가 남지 않으면 지운다. 바쁨 대기는 `setTimeout` 프로미스로 남는다.

### 2. `skills/orch/tests/worker-ask.spec.ts`

- 지울 사례: 「바로 돌아온 ask」 의 `--resume` 으로 기다리기, 「시간 제한」 전체, 「기다리는 동안 status 답」 전체, max-wait 두 사례, timeout 줄이기 사례, 「잘못된 대기 시간」, 짧은 출력의 `TIMEOUT`·status 답 사례, `--resume 으로 재개할 때는 형식을 보지 않는다`, `--resume 이 실패하면`.
- 더할 사례:
  - pending 과 질문 id 를 내면 `ASKED <id>` 와 0 이고 ask 를 한 번만 부른다(가짜 orca 의 호출 기록으로 센다). ask 인자에 `--wait` 가 없고 `--timeout-ms 5000` 이 있다.
  - 시간 초과(`timedOut: true`)에 질문 id 가 있어도 `ASKED <id>` 와 0 이다.
  - `--resume m1` 은 orca 를 부르지 않고 안내 한 줄과 2 다.
  - `--timeout-ms 600000 --max-wait 3600000` 을 줘도 안내 한 줄을 내고 묻는다. `--timeout-ms abc` 같은 값도 거절하지 않는다.
  - 짧은 출력에서 `ASKED <id>` 한 줄만 낸다.
- 남길 사례: 답 받기(`answer:`), 결정 질문 형식, 읽지 않은 메시지, 대신 보내기, 바쁜 Orca, 사용법.

### 3. `skills/orch/templates/spec-common.md` 의 `worker-ask` 규칙

72번 줄의 이어지는 설명을 아래 뜻으로 바꾼다. 앞 두 문장(`FROM`, `QUESTION` 채우기와 사용법 오류)은 그대로 둔다.

- 명령은 전경으로 돌린다. 질문을 보내고 바로 끝난다.
- 0 이고 첫 줄이 `ASKED <질문 id>` 면 턴을 끝낸다. 답이 오면 Orca 가 깨운다. 깬 뒤 `orca orchestration check` 로 답을 읽는다.
- 0 이고 첫 줄이 `answer: ` 면 그 뒤가 답이다.
- 5 면 읽지 않은 코디네이터 메시지가 출력에 있으니 먼저 읽고, 그래도 물어야 하면 같은 명령을 다시 부른다(지금 문장).
- 3 이고 `SENT-RUN <id>` 면 Run 메일함으로 대신 보낸 것이다. 같은 방식으로 턴을 끝내고 깬 뒤 `check` 로 읽는다.
- 지울 문장: `run_in_background`, `--timeout-ms` 를 도구 시간 제한보다 짧게, 「3 이면 첫 줄이 `answer:` 일 때는 status 답」, 「4 면 `TIMEOUT`」, `--max-wait`, 「호출별 대기 시간」.

### 4. `skills/orch/tests/spec-lint.spec.ts`

「표지는 있지만 본문이 틀과 다른 규칙을 표지마다 그 항목 머리 줄로 경고한다」 사례의 `sentence` 를 새 규칙의 「`SENT-RUN <id>` 면 …」 문장으로 바꾼다. 주석의 「--max-wait 안내가 없고」 도 그 문장으로 고친다. 단언문은 그대로다.

### 5. 문서와 주석

- `skills/orch/scripts/worker/send-to-worker.ts` 머리 주석의 「worker-ask 가 이 status 의 본문을 답으로 읽는다」 를 「worker 는 이 status 로도 깨고 `check` 로 본문을 읽는다」 로 고친다. 코드는 바꾸지 않는다.
- `skills/orch/scripts/lib/proc.ts` 16번 줄 주석의 「worker-ask 가 status 답을 먼저 받은 경우」 를 일반 예시로 고친다.
- `skills/orch/references/replying.md` 13번 줄의 「ask 가 한 번에 한 답을 기다리므로」 를 「worker 가 한 번에 한 답을 받으므로」 로 고친다.
- `grep -rn -E 'max-wait|worker-ask.*--resume|TIMEOUT <질문' skills docs --include='*.md'` 로 남은 기다림 설명을 찾아 고친다. `docs/features/` 의 지난 기능 문서와 `CHANGELOG.md` 는 기록이라 고치지 않는다.

### 6. `skills/orch/changes/ask-no-wait.minor.md`

```markdown
- `orch worker ask` 는 질문을 보내고 바로 끝난다(`ASKED <질문 id>`). worker 는 턴을 끝내고 Orca 가 답과 함께 깨운다. `--resume` 은 없어졌고 `--timeout-ms`, `--max-wait` 는 받되 무시한다
```

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/worker-ask.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/sync-common.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/docs-contract.spec.ts
node scripts/run-tests.ts
node scripts/check-skill-docs.ts orch
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/templates/spec-common.md skills/orch/references/replying.md skills/orch/changes/ask-no-wait.minor.md
grep -c -E 'POLL_MS|replyOf|max-wait 가 끝나|TIMEOUT ' skills/orch/scripts/worker/worker-ask.ts
grep -c -E 'run_in_background|--max-wait|TIMEOUT' skills/orch/templates/spec-common.md
```

- 앞 세 줄은 종료 코드 0 이다.
- 끝 두 줄은 `0` 을 낸다(grep 은 찾은 줄이 없어 종료 코드 1 이다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/worker/worker-ask.ts` | 수정 |
| `skills/orch/tests/worker-ask.spec.ts` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `skills/orch/tests/spec-lint.spec.ts` | 수정 |
| `skills/orch/scripts/worker/send-to-worker.ts` | 수정 |
| `skills/orch/scripts/lib/proc.ts` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/changes/ask-no-wait.minor.md` | 신규 |
