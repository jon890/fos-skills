# Phase 01. PreToolUse hook 을 TypeScript 로 옮기고 터미널 직접 입력 금지를 fail-closed 로 바꾼다

**Execution profile**: deep

## 목표

`orch/hooks/` 의 Python hook 과 `shell_text.py` 를 TypeScript 로 옮기고 `hooks.json` 이 node 로 부르게 한다.
worker 터미널 직접 입력 금지 hook 은 대상이 변수이거나 orca 조회가 실패해도 거부한다.

**범위 외**: hook 이 안내하는 명령(`send-to-worker`, `spec-line`)의 전환. 안내 문구의 명령 경로는 phase 05 가 `.ts` 로 바꾼다.

## 컨텍스트

시작 조건: `plan3-orch-ts-core` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: plan3 머지 전` 을 내고 멈춘다.
실행 규칙은 `docs/code-architecture.md` 의 「실행 규칙」 이 소유한다. 공통 모듈은 `orch/scripts/lib/` 에 있다(`proc.ts`, `orca.ts`).

옮길 파일과 판정의 원본은 각 파일 머리 주석이다.

| 원본 | 새 파일 |
| --- | --- |
| `orch/hooks/shell_text.py` | `orch/hooks/shell-text.ts` |
| `orch/hooks/block-background-wait.py` | `orch/hooks/block-background-wait.ts` |
| `orch/hooks/block-git-after-cd.py` | `orch/hooks/block-git-after-cd.ts` |
| `orch/hooks/block-worker-terminal-send.py` | `orch/hooks/block-worker-terminal-send.ts` |
| `orch/hooks/require-spec-line.py` | `orch/hooks/require-spec-line.ts` |

hook 은 다른 스크립트가 부르지 않고 `orch/hooks/hooks.json` 만 부른다. 그래서 `.py` shim 을 두지 않고 지운다.

**근거 문서**: `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 터미널 직접 입력 금지 줄과 「공통 안전 장치」, `docs/adr/005-plugin-hooks-under-skill.md`, `docs/adr/010-orch-typescript.md`

## 의도 메모

- fail-closed 로 바꾸는 판정: `--terminal` 값이 `term_` 로 시작하는 낱말이 아니면(변수, 명령 치환) 거부한다. orca 조회가 실패하거나 시간을 넘겨도 거부한다. 거부 이유에 `send-to-worker` 와, worker 가 아닌 터미널이면 handle 을 그대로 적어 다시 부르라는 안내를 넣는다.
- 첫 화면 승인 예외(본문 없이 `--enter` 만 보내고 `worker-show` 가 첫 화면 대기를 보이는 경우)는 그대로 둔다. 단계를 읽지 못하면 거부하는 지금 판정도 그대로다.
- hook 이 node 를 찾지 못하면 Claude Code 는 오류를 보이고 막지 않는다. 그래서 doctor 가 node 버전을 본다(phase 05). 이 phase 에서는 `hooks.json` 의 명령이 `node` 를 PATH 에서 찾는다는 사실을 머리 주석에 적는다.

## 작업 항목

### 1. 위 표의 파일을 옮긴다

판정, 오탐을 피하는 기준, 출력 형식(거부할 때만 deny 결정 JSON 을 stdout 으로)은 원본과 같게 둔다. 바꾸는 것은 위 「의도 메모」 의 fail-closed 판정뿐이다.

### 2. `orch/hooks/hooks.json`

각 명령을 `node --disable-warning=ExperimentalWarning "${CLAUDE_PLUGIN_ROOT}/orch/hooks/<이름>.ts"` 로 바꾼다. `timeout` 은 그대로 10 이다. `description` 을 새 판정에 맞춘다.

### 3. 테스트를 옮긴다

`orch/tests/test_block_background_wait.py` 를 `orch/tests/block-background-wait.spec.ts` 로, `orch/tests/test_coordinator_hooks.py` 를 `orch/tests/coordinator-hooks.spec.ts` 로 옮긴다. 사례를 모두 옮기고 Python 파일을 지운다.
`coordinator-hooks.spec.ts` 에 더할 사례:

| 입력 | 기대 |
| --- | --- |
| `orca terminal send --terminal "$T" --text x` | 거부 |
| 가짜 orca 가 worker-list 에 실패하는 상태의 `--terminal term_abc` | 거부 |
| 가짜 orca 가 worker 가 아닌 터미널이라고 답하는 `--terminal term_abc` | 통과 |

### 4. 문서

`orch/README.md` 의 hook 목록과 `docs/code-architecture.md` 「모듈 책임」 표의 `orch/hooks/` 줄을 새 판정에 맞춘다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/block-background-wait.spec.ts orch/tests/coordinator-hooks.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
claude plugin test .
! ls orch/hooks/*.py
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
| `orch/README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
