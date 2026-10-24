# Phase 01. 터미널 소유 확인과 워크트리 지우기를 옮긴다

**Execution profile**: deep

## 목표

`terminal_ownership` 모듈과 `remove-worktree` 명령을 TypeScript 로 옮긴다. 이유 주석이 없던 함정에 주석을 단다.

**범위 외**: `cleanup-sweep`(phase 02). 그 명령은 아직 Python 이고 `terminal_ownership.py` 를 import 하며 `remove-worktree.py` 경로를 부른다. 그래서 `terminal_ownership.py` 는 phase 02 까지 남기고, `remove-worktree.py` 는 shim 으로 둔다.

## 컨텍스트

시작 조건: `plan5-orch-ts-merge-commands` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: plan5 머지 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/terminal_ownership.py`(모듈) | `orch/scripts/lib/ownership.ts` | `orch/tests/test_terminal_ownership.py` → `orch/tests/ownership.spec.ts` |
| `orch/scripts/remove-worktree.py` | `orch/scripts/remove-worktree.ts` | `orch/tests/test_remove_worktree.py` → `orch/tests/remove-worktree.spec.ts` |

`terminal_ownership.py` 는 PR #190 이 크게 바꿨다. 범위가 `all` 이 아니면 `run-list` 와 Run 마다 `worker-list --run` 을 병렬로 읽어 합치고, 60초 동안 읽은 결과를 다시 쓰고, 한 행의 `resource.terminalHandle` 과 `agentTerminalHandle` 을 모두 본다. 그 판정을 그대로 옮긴다. 병렬 읽기는 `lib/proc.ts` 의 `runAsync` 다.
점유 프로세스 찾기와 pid 확인은 `lib/process.ts` 다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `remove-worktree.py` 에 둔다.

**근거 문서**: `docs/code-architecture.md` 의 「배치」, 「실행 규칙」 의 주석 줄, `orch/references/cleanup.md` 의 「워크트리 지우기」

## 의도 메모

- `remove-worktree.py` 의 이유 주석이 없는 함정: 원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보는 `--grep` 규칙, 터미널 소유 상태를 두 번 확인하는 것. 옮기면서 왜 그런지 주석을 단다. 모르면 `git log -S` 로 그 줄을 넣은 커밋을 읽는다.
- 테스트가 Orca 터미널 안에서 돌 때 `ORCA_TERMINAL_HANDLE` 이 가짜 orca 로 새지 않게 테스트 환경에서 뺀다. PR #190 이 Python 테스트에서 한 처리다.

## 작업 항목

### 1. 위 표의 모듈과 명령을 옮긴다

### 2. 테스트를 옮긴다

`orch/tests/ownership.spec.ts`, `orch/tests/remove-worktree.spec.ts` 를 만들고 원본 사례를 모두 옮긴다. `test_remove_worktree.py` 는 지운다. `test_terminal_ownership.py` 는 `cleanup-sweep.py` 가 아직 원본 모듈을 쓰므로 phase 02 에서 지운다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/ownership.spec.ts orch/tests/remove-worktree.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/ownership.ts` | 신규 |
| `orch/scripts/remove-worktree.ts` | 신규 |
| `orch/scripts/remove-worktree.py` | 수정 |
| `orch/tests/ownership.spec.ts` | 신규 |
| `orch/tests/remove-worktree.spec.ts` | 신규 |
| `orch/tests/test_remove_worktree.py` | 삭제 |
