# Phase 01. PreToolUse hook 을 TypeScript 로 옮기고 터미널 직접 입력 금지를 fail-closed 로 바꾼다

**Execution profile**: deep

## 목표

`orch/hooks/` 의 Python hook 과 `shell_text.py` 를 TypeScript 로 옮기고 `hooks.json` 이 node 로 부르게 한다.
worker 터미널 직접 입력 금지 hook 은 모든 Run 의 worker 를 보고, 대상을 확인하지 못하면 거부한다.

**범위 외**: hook 이 안내하는 명령(`send-to-worker`, `spec-line`)의 전환. 거부 이유에 적힌 명령 경로를 `.ts` 로 바꾸는 일은 phase 05 가 한다.

## 컨텍스트

시작 조건: `plan3-orch-ts-core` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: plan3 머지 전` 을 내고 멈춘다.
실행 규칙은 `docs/code-architecture.md` 의 「실행 규칙」 이 소유한다. 공통 모듈은 `orch/scripts/lib/` 에 있다(`proc.ts` 의 `run`, `runAsync`, `orca.ts` 의 `orcaBin`).

옮길 파일과 판정의 원본은 각 파일 머리 주석이다.

| 원본 | 새 파일 |
| --- | --- |
| `orch/hooks/shell_text.py` | `orch/hooks/shell-text.ts` |
| `orch/hooks/block-background-wait.py` | `orch/hooks/block-background-wait.ts` |
| `orch/hooks/block-git-after-cd.py` | `orch/hooks/block-git-after-cd.ts` |
| `orch/hooks/block-worker-terminal-send.py` | `orch/hooks/block-worker-terminal-send.ts` |
| `orch/hooks/require-spec-line.py` | `orch/hooks/require-spec-line.ts` |

hook 은 다른 스크립트가 부르지 않고 `orch/hooks/hooks.json` 만 부른다. 그래서 `.py` shim 을 두지 않고 지운다.

`worker-list` 의 조회 범위는 `orch/scripts/lib/orca.ts` 머리 주석이 정한다.
`--run` 없이 부르면 부른 터미널에 묶인 Run 의 worker 만 오고(`scope.source` 가 `bound`), 묶인 Run 이 없을 때만 모든 Run 이 온다(`all`).
`ORCA_TERMINAL_HANDLE` 을 환경에서 빼도 범위는 넓어지지 않는다. 한 번에 100행까지 오고 `page.nextCursor` 로 이어 읽는다.
원본 hook 은 그 변수를 빼고 첫 페이지만 읽어, 다른 Run 의 worker 와 둘째 페이지의 worker 를 worker 가 아닌 터미널로 보고 통과시켰다.

`orca orchestration run-list` 는 `--limit <n>` 과 `--cursor <값>` 을 받는다(`orca orchestration run-list --help`).
응답의 `result.runs` 가 Run 목록이고 각 행의 `id` 가 Run id 다. 다음 페이지는 `result.nextCursor` 이고 끝이면 없다(`page` 객체가 아니다).
2026-10-24 실측: 이 머신에 Run 이 251개 있고 `worker-list --run` 한 번이 약 0.11초다. 차례로 부르면 약 28초, 동시 16개로 부르면 약 4.5초가 걸렸다.

**근거 문서**: `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 터미널 직접 입력 금지 줄과 「공통 안전 장치」, `docs/adr/005-plugin-hooks-under-skill.md`, `docs/adr/010-orch-typescript.md`

## 의도 메모

- hook 의 orca 호출은 모두 합쳐 7초 안에 끝낸다. `hooks.json` 의 `timeout` 이 10초이고, hook 이 시간을 넘겨 죽으면 Claude Code 는 막지 않고 명령을 실행한다. 그러면 fail-closed 가 반대로 동작한다. 첫 화면 경로의 `worker-list` 와 `worker-show` 도 이 7초 안에 든다.
- 7초는 hook 시작 시각에서 잰 마감 시각 하나다. 호출마다 남은 시간을 `timeoutMs` 로 넘기고, 남은 시간이 없으면 부르지 않고 거부한다.
- 전체 Run 조회는 작업 항목 1 의 「worker 판정 범위」 4단계에서만 한다. Run 마다의 `worker-list --run` 은 `runAsync` 로 동시 16개까지 부른다. 위 실측처럼 차례로 부르면 Run 이 많은 머신에서 늘 한도를 넘는다. Run 이 늘면 동시 호출로도 한도를 넘을 수 있고, 그때는 거부된다. 이것은 fail-closed 의 의도된 비용이다.
- `ORCA_TERMINAL_HANDLE` 을 빼고 부르지 않는다. 효과가 없다(컨텍스트의 조회 범위).
- hook 이 node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다. node 버전 확인은 옛 `.py` 진입점이 맡는다(phase 02, 05). 이 phase 에서는 `hooks.json` 의 명령이 `node` 를 PATH 에서 찾는다는 사실을 각 hook 머리 주석에 적는다.

## 작업 항목

### 1. 위 표의 파일을 옮긴다

판정, 오탐을 피하는 기준, 출력 형식(거부할 때만 deny 결정 JSON 을 stdout 으로)은 원본과 같게 둔다. 바꾸는 것은 `block-worker-terminal-send.ts` 의 아래 판정뿐이다. 바뀐 판정은 그 파일 머리 주석에 적는다.

worker 판정 범위:

1. `worker-list --terminal-state active --limit 100 --json` 을 `page.nextCursor` 가 없을 때까지 `--cursor` 로 이어 읽는다. 행의 `agentTerminalHandle` 이 대상과 같으면 worker 터미널이고, 그 행의 `dispatchId` 를 첫 화면 판정에 쓴다. 찾았으면 여기서 판정한다.
2. 찾지 못했고 첫 응답의 `scope.source` 가 `all` 이면 worker 가 아니다.
3. 찾지 못했고 `scope.source` 가 `all` 이 아니면(묶인 Run 만 봤다) `orca terminal show --terminal <대상> --json` 으로 그 터미널의 `agentIdentity` 를 본다. 비어 있으면(에이전트가 돌지 않는 셸) worker 가 아니므로 통과한다.
4. `agentIdentity` 가 있으면 다른 Run 의 worker 일 수 있다. `run-list --limit 100 --json` 을 `result.nextCursor` 끝까지 읽어 `updated_at` 이 최근인 순서로 놓고, Run 마다 `worker-list --run <id> --terminal-state active --limit 100 --json` 을 `page.nextCursor` 끝까지 읽는다. `runAsync` 로 동시 16개까지 부른다. 대상을 찾으면 그 행으로 판정하고 남은 호출은 기다리지 않는다. 모두 읽고도 없으면 worker 가 아니다.
5. 어느 호출이든 종료 코드가 0 이 아니거나, JSON 이 아니거나, `result.workers`(또는 `result.runs`)가 배열이 아니면 조회 실패다. 조회 실패와 7초 초과는 거부한다.

이 순서를 고른 이유: 이 머신에는 Run 이 수백 개 쌓여 있어(2026-10-24 실측 251개, `worker-list --run` 한 번 약 0.11초) 모든 Run 을 늘 읽으면 7초 한도에 자주 닿는다. 자기 Run 의 worker 와 에이전트가 없는 셸은 앞 단계에서 끝나므로, 전체 조회는 다른 Run 일 수 있는 에이전트 터미널로 보낼 때만 한다. Run 이 더 늘어 그 경우에 한도를 넘으면 거부되는 것은 fail-closed 의 의도된 비용이다.

판정 표:

| 입력 | 결과 | 거부 이유에 넣는 안내 |
| --- | --- | --- |
| `--terminal` 값이 모든 Run 의 active worker 터미널이다 | 거부 | `send-to-worker` 로 보낸다. 깨우기만 하려면 `nudge-worker` |
| `--terminal` 값이 어느 Run 의 worker 도 아니다 | 통과 | |
| `--terminal "$T"` 처럼 값이 `term_` 로 시작하는 낱말이 아니다(변수, 명령 치환) | 거부 | worker 가 아니면 handle 을 그대로 적어 다시 부른다 |
| `--terminal` 이 없는 `orca terminal send` | 거부 | 대상을 모른다. `--terminal <handle>` 을 그대로 적는다 |
| `--environment` 나 `--pairing-code` 가 든 `orca terminal send` | 거부 | 원격 서버의 터미널은 이 hook 이 확인할 수 없다. worker 면 `send-to-worker` 로, 아니면 그 서버의 셸에서 보낸다 |
| 조회가 실패한다(`{"workers": null}`, `not json`, 종료 코드 1 포함) | 거부 | 조회 실패 이유 한 줄. worker 가 아니면 handle 을 그대로 적어 다시 부른다 |
| 조회가 7초 안에 끝나지 않는다 | 거부 | 시간 초과. worker 가 아니면 handle 을 그대로 적어 다시 부른다 |
| 첫 화면 승인(본문 없이 `--enter` 만, `worker-show --dispatch` 가 첫 화면 대기) | 통과 | |
| 첫 화면 승인 꼴인데 `worker-show` 를 읽지 못하거나 일하는 단계다 | 거부 | 첫 화면 승인이면 handle 을 그대로 적어 다시 부른다 |

`--terminal` 값을 변수로 준 호출은 첫 화면 승인이어도 거부한다. 대상을 정적으로 알 수 없어서다. 거부 이유에 「첫 화면 승인이면 handle 을 그대로 적어 다시 부른다」 를 넣는다.
따옴표 안, heredoc 본문, 주석에 든 `orca terminal send` 문구는 지금처럼 보지 않고 orca 를 조회하지도 않는다.

### 2. `orch/hooks/hooks.json`

각 명령을 `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/orch/hooks/<이름>.ts"` 로 바꾼다. `timeout` 은 그대로 10 이다. `description` 을 새 판정에 맞춘다.

### 3. 테스트를 옮긴다

`orch/tests/test_block_background_wait.py` 를 `orch/tests/block-background-wait.spec.ts` 로, `orch/tests/test_coordinator_hooks.py` 를 `orch/tests/coordinator-hooks.spec.ts` 로 옮기고 Python 파일을 지운다.
가짜 orca 의 `worker-list` 응답에는 `scope` 를 넣는다. 원본 가짜는 `scope` 가 없어 새 판정에서는 범위 확인으로 빠진다.

원본 사례 가운데 결과가 뒤집히는 것:

| 원본 사례(`WorkerTerminalSendTest`) | 원본 | 새 기대 |
| --- | --- | --- |
| `orca terminal send --terminal "$T" --text x` | 통과 | 거부 |
| 가짜 orca 가 `{"result": {"workers": null}}` 를 낸다 | 통과 | 조회 실패로 거부 |
| 가짜 orca 가 `not json` 을 내고 종료 코드 1 | 통과 | 거부 |
| 조회에서 `ORCA_TERMINAL_HANDLE` 이 비어 있다(로그의 `\|orchestration worker-list` 로 시작) | 단언 | 이 단언을 지우고 아래 범위 판정 사례로 바꾼다 |

나머지 원본 사례(worker 가 아닌 `term_dev-server`, `terminal read`, `send-to-worker.py` 호출, 따옴표 안의 문구, 첫 화면 승인 사례)는 결과가 같다.

더할 사례:

| 입력 | 기대 |
| --- | --- |
| `worker-list` 가 `scope.source: bound` 와 빈 목록을 내고, `terminal show` 의 `agentIdentity` 가 있고, `run-list` 둘째 페이지의 Run 에 대상 worker 가 있다 | 거부. 가짜 orca 기록에 `run-list --cursor` 와 `worker-list --run <그 Run>` 이 있다 |
| `scope.source: bound` 이고 묶인 Run 에 대상이 없고 `terminal show` 의 `agentIdentity` 가 비어 있다 | 통과. `run-list` 를 부르지 않는다 |
| `scope.source: bound` 이고 `terminal show` 가 종료 코드 1 | 거부 |
| `scope.source: all` 이고 대상 worker 가 `worker-list` 둘째 페이지에 있다 | 거부. `run-list` 를 부르지 않는다 |
| `scope.source: bound`, `agentIdentity` 가 있고 `run-list` 가 종료 코드 1 | 거부 |
| `orca terminal send --text x --enter`(`--terminal` 없음) | 거부 |
| `orca terminal send --environment srv --terminal term_abc --text x` | 거부. 이유에 원격 안내가 있다 |
| 가짜 orca 가 호출마다 잠든다 | 거부. hook 이 10초 안에 끝난다 |

시간 한도 사례는 7초를 그대로 기다리지 않게, 한도를 `ORCH_SEND_HOOK_BUDGET_MS` 환경 변수로 줄일 수 있게 둔다. 이 변수는 테스트만 쓰고 머리 주석에 그렇게 적는다.

### 4. 지워질 hook 이름과 첫 화면 승인 문서

- `orch/references/launch.md` 「첫 화면에서 멈춤」 1단계의 `terminal send --terminal "$TERMINAL_HANDLE" --enter` 를 `orca terminal send --terminal term_... --enter` 처럼 handle 을 글자 그대로 적는 꼴로 바꾸고, 변수로 주면 hook 이 거부한다는 문장을 더한다. 같은 줄의 `block-worker-terminal-send.py` 를 `block-worker-terminal-send.ts` 로 고친다
- `orch/references/waiting.md` 의 `hooks/block-background-wait.py` 를 `hooks/block-background-wait.ts` 로 고친다
- `orch/scripts/wait-important.py` 머리 주석의 `hooks/block-background-wait.py` 줄을 `.ts` 로 고친다
- `orch/README.md` 의 hook 목록과 `docs/code-architecture.md` 「모듈 책임」 표의 `orch/hooks/` 줄을 새 파일 이름과 판정에 맞춘다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/block-background-wait.spec.ts orch/tests/coordinator-hooks.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
claude plugin test .
! ls orch/hooks/*.py
! git grep -n "block-background-wait\.py\|block-git-after-cd\.py\|block-worker-terminal-send\.py\|require-spec-line\.py\|shell_text\.py" -- orch/references orch/README.md orch/scripts docs
python3 korean-check/scripts/korean-style-check.py orch/references/launch.md orch/references/waiting.md orch/README.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/hooks/shell_text.py` | 삭제 |
| `orch/hooks/block-background-wait.py` | 삭제 |
| `orch/hooks/block-git-after-cd.py` | 삭제 |
| `orch/hooks/block-worker-terminal-send.py` | 삭제 |
| `orch/hooks/require-spec-line.py` | 삭제 |
| `orch/hooks/shell-text.ts` | 신규 |
| `orch/hooks/block-background-wait.ts` | 신규 |
| `orch/hooks/block-git-after-cd.ts` | 신규 |
| `orch/hooks/block-worker-terminal-send.ts` | 신규 |
| `orch/hooks/require-spec-line.ts` | 신규 |
| `orch/hooks/hooks.json` | 수정 |
| `orch/tests/test_block_background_wait.py` | 삭제 |
| `orch/tests/test_coordinator_hooks.py` | 삭제 |
| `orch/tests/block-background-wait.spec.ts` | 신규 |
| `orch/tests/coordinator-hooks.spec.ts` | 신규 |
| `orch/references/launch.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/scripts/wait-important.py` | 수정 |
| `orch/README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
