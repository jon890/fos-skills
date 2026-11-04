# Phase 03. loop 와 worker 묶음의 짧은 출력

**Execution profile**: standard

## 목표

`orch loop …` 과 `orch worker …` 의 짧은 출력이 설계 「짧은 출력 (PR2)」 표의 판정 줄만 내게 한다.

**범위 외**: queue·cleanup 묶음(phase 04), board·spec·doctor·status(phase 05), 문서(phase 06).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/orch-cli/spec.md` 의 「출력」, REQ4, DECISION20. `docs/features/orch-cli/design.md` 의 「짧은 출력 (PR2)」 표의 `loop …`, `worker …` 행, 결정 DECISION19, DECISION20, DECISION21.

- 스크립트마다 stdout 쓰기는 `out(line)`(`launch-worker.ts`, `send-to-worker.ts`, `nudge-worker.ts`, `make-worktree.ts`, `link-claude-profile.ts`), `log(line)`(`orch-loop.ts` 542줄 근처), `console.log`(`adopt-sessions.ts`), `process.stdout.write`(`worker-ask.ts`, `stalled-workers.ts`) 다.
- phase 01 의 `lib/output.ts` 의 `emit(text, rules, opts)`, `short()`, `shortEnv()`, `oneLine()` 을 쓴다. 규칙표가 없는 줄은 판정 줄만 남는다.
- `send-to-worker.ts` 는 `runInherit` 로 `nudge-worker.ts`(`nudge`)와 `launch-worker.ts`(`passThrough`)를 stdio 상속으로 부른다(`lib/proc.ts` 의 `runInherit` 는 `env` 옵션을 받는다).
- 직접 실행(신호 없음)의 출력은 바꾸지 않는다. 기존 테스트는 대부분 직접 실행이라 기대값이 그대로다.

## 작업 항목

### 1. `skills/orch/scripts/orch-loop.ts`

`log` 의 stdout 쓰기(`process.stdout.write`)만 `emit(line)` 으로 바꾼다. `state/loop.log` 쓰기는 그대로 전부다(`references/cleanup.md`, `waiting.md` 가 읽는다). 규칙표 없이 `LOOP-*` 줄이 남고 `안내:` 줄이 빠진다. 옛 루프 안내(`LEGACY_HINT`, 721줄 근처의 `LOOP-RUNNING` 뒤)는 짧은 출력이면 `LOOP-LEGACY <pid> run=<Run>` 판정 줄로 바꿔 낸다. 그래야 정상 루프의 `LOOP-RUNNING` 과 4 와 가릴 수 있다. `--stop` 의 옛 루프 안내(876줄 근처의 `LOOP-NOT-REGISTERED` 뒤)도 같다. `--tick` 의 JSON 줄(2851줄 근처)은 바꾸지 않는다(내부용이고 부모가 읽는다).

### 2. `skills/orch/scripts/stalled-workers.ts`

`--json` 이 아니고 `short()` 면 `MOVING` 줄을 내지 않는다.

### 3. `skills/orch/scripts/launch-worker.ts`

- `out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^거부: (.*)` → `REFUSED <첫 줄>`, `lint-ack: …`, `dirty-ack: …` 는 그대로.
- `LAUNCHED` 를 내기 전에 터미널을 구하고(지금 바로 뒤에서 `jget(lastShow, …)` 로 구한다), 짧은 출력이면 `LAUNCHED <dispatch> <터미널 또는 -> <워크트리>`, 아니면 지금 꼴이다.
- worker-start JSON(`out(result.stdout + result.stderr)`), `워크트리를 만들었다`, 단계 감시 줄은 판정 줄이 아니라 빠진다.

### 4. `skills/orch/scripts/send-to-worker.ts`

- `out` 이 `emit(line, RULES)` 를 부른다. 규칙: `replied: (\S+) 에 답했다 \((\S+)\)` → `REPLIED $1 $2`, `sent: .* dispatch:(\S+) 에 .*\((\S+)\)` → `SENT $1 $2`, `delivered: .* Orca 가 (\S+) 로` → `DELIVERED $1`, `relaunch: 끝난 (\S+) 의 터미널 (\S+)` → `RESUMED $1 $2`, `restart: (\S+) 을` → `RESTARTED $1`, `ended: (\S+) 가 끝났.*\((\S+)\)` → `ENDED $1 $2`, `(closed|retry|fallback|skipped|warning|note): (.*)` → `NOTE $2`, `send-to-worker: (.*)` → `FAIL $1`.
- `nudge` 와 `passThrough` 의 `runInherit` 에 `env: shortEnv()` 를 준다.

### 5. `skills/orch/scripts/nudge-worker.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^(nudged|permission|unobserved): .*\((\S+)\)` → `<첫 낱말 대문자> $2`(`None` 이면 `-`), `^(queued|working): ` → 대문자 첫 낱말, `^([a-z]+): 입력하지 않았다` → 대문자 상태 낱말, orca 오류 줄(77줄 근처, `out((done.stdout + done.stderr).trim() …)`)은 짧은 출력이면 `ORCA-ERROR <oneLine 200자>`. `--state`, `--classify` 의 상태 한 낱말(168, 174줄)은 `emit` 을 거치지 않고 그대로 낸다(데이터).

### 6. `skills/orch/scripts/worker-ask.ts`

`short()` 면: 답이 있는 세 자리(338, 347, 364줄 근처)는 `answer: <답 전체>`(여러 줄 답은 그대로, 뒤의 ask JSON 만 뺀다), 시간 초과(357줄 근처)는 `TIMEOUT <질문 id 또는 ->`, 빈 답(374줄 근처)은 `NO-ANSWER <질문 id 또는 ->`, Run 메일함으로 대신 보내기(412줄 근처의 `sent.stdout`)는 보낸 id 를 읽은 뒤 `SENT-RUN <id>` 를 낸다. 읽지 않은 메시지(295줄)는 그대로다.

### 7. `skills/orch/scripts/adopt-sessions.ts`

`--json` 이 아닐 때 `console.log` 대신 `emit(text, [], { fix: true })` 를 쓴다. 짧은 출력이면 `SESSION` 은 `SESSION <터미널> <state> <branch 또는 -> specs=<지시서 후보를 쉼표로 이은 것 또는 ->` 한 줄(JSON 빼고. `references/launch.md` 가 지시서 후보를 읽는다), `ADOPTED` 는 `ADOPTED <터미널> <지시서>` 한 줄, `ADOPT-MANUAL` 은 첫 줄만. `LIMITED`/`RESTART` 와 들여 쓴 명령 줄은 그대로.

### 8. `skills/orch/scripts/make-worktree.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^일치: (\S+) \(HEAD (\S+)\)` → `MATCH $1 $2`, `^불일치: (\S+) (.*), 지시서 (.*)` → `MISMATCH $1 $2 $3`. 워크트리 경로(135줄)는 `emit` 을 거치지 않는다(데이터).

### 9. `skills/orch/scripts/link-claude-profile.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^기준 \S+ → 대상 (\S+): (\d+)건` → 마지막에 낼 요약을 기억하고 버린다, `^  건너뜀 (\S+): ` → `SKIPPED $1 state`, `^  (링크|복사) (\S+) ←` → dry-run 이면 `WOULD-LINK`/`WOULD-COPY`, 적용이면 `LINK`/`COPY` 와 이름, `dry-run 이다` → `PROFILE <대상> <건수> dry-run`, `적용했다` → `PROFILE <대상> <건수> applied`. `--help` 의 `USAGE`, `HELP_NOTE` 는 `short()` 가 거짓이라 그대로다.

### 10. 테스트

각 스크립트의 기존 테스트 파일에 `ORCH_OUTPUT=short` 로 돌린 사례를 하나씩 더한다. 같은 입력의 직접 실행 출력이 지금과 같은지는 기존 사례가 본다.

- `skills/orch/tests/orch-loop.spec.ts`: 옛 루프(loop.json 에 runs 가 없다)에 다른 Run 으로 `--start` 하는 사례가 짧은 출력이면 `LOOP-RUNNING …` 과 `LOOP-LEGACY …` 이고 `안내:` 가 없다. 신호가 없으면 지금처럼 `안내:` 줄이다.
- `skills/orch/tests/stalled-workers.spec.ts`: 짧은 출력에 `MOVING` 이 없고 `STALLED` 는 있다.
- `skills/orch/tests/launch-worker.spec.ts`: 짧은 출력이 `LAUNCHED <dispatch> <터미널> <워크트리>` 와 판정 줄만이고 worker-start JSON 이 없다. 남은 터미널 거부가 `REFUSED …` 다.
- `skills/orch/tests/send-to-worker.spec.ts`: 살아 있는 dispatch 에 답한 사례가 `REPLIED …` 다. 가짜 자식 nudge 와 launch(`NUDGE_WORKER`, `LAUNCH_WORKER` 로 바꾼 가짜)가 받은 `ORCH_OUTPUT` 값을 찍게 하고, 짧은 출력이면 `short`, 아니면 빈 값인지 본다. 끝난 dispatch 가 `ENDED …` 다.
- `skills/orch/tests/nudge-worker.spec.ts`: `NUDGED <id>`, `WORKING`, `--state` 는 상태 낱말 그대로.
- `skills/orch/tests/worker-ask.spec.ts`: 답이 오면 stdout 이 `answer: <답 전체>` 이고 ask JSON 이 없다(여러 줄 답은 모든 줄이 남는다). 시간 초과가 `TIMEOUT <id>`.
- `skills/orch/tests/adopt-sessions.spec.ts`: `SESSION` 한 줄에 상태와 `specs=` 가 있고 JSON 이 없다.
- `skills/orch/tests/make-worktree.spec.ts`: `--check` 가 `MATCH`, `MISMATCH`.
- `skills/orch/tests/link-claude-profile.spec.ts`: dry-run 이 `WOULD-LINK` 와 `PROFILE … dry-run`.

## 검증

```bash
node --test skills/orch/tests/orch-loop.spec.ts skills/orch/tests/stalled-workers.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts skills/orch/tests/nudge-worker.spec.ts skills/orch/tests/worker-ask.spec.ts skills/orch/tests/adopt-sessions.spec.ts skills/orch/tests/make-worktree.spec.ts skills/orch/tests/link-claude-profile.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/orch-loop.ts` | 수정 |
| `skills/orch/scripts/stalled-workers.ts` | 수정 |
| `skills/orch/scripts/launch-worker.ts` | 수정 |
| `skills/orch/scripts/send-to-worker.ts` | 수정 |
| `skills/orch/scripts/nudge-worker.ts` | 수정 |
| `skills/orch/scripts/worker-ask.ts` | 수정 |
| `skills/orch/scripts/adopt-sessions.ts` | 수정 |
| `skills/orch/scripts/make-worktree.ts` | 수정 |
| `skills/orch/scripts/link-claude-profile.ts` | 수정 |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 |
| `skills/orch/tests/stalled-workers.spec.ts` | 수정 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/tests/send-to-worker.spec.ts` | 수정 |
| `skills/orch/tests/nudge-worker.spec.ts` | 수정 |
| `skills/orch/tests/worker-ask.spec.ts` | 수정 |
| `skills/orch/tests/adopt-sessions.spec.ts` | 수정 |
| `skills/orch/tests/make-worktree.spec.ts` | 수정 |
| `skills/orch/tests/link-claude-profile.spec.ts` | 수정 |
