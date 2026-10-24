# Phase 01. 터미널 소유 확인과 워크트리 지우기를 옮긴다

**Execution profile**: deep

## 목표

`terminal_ownership` 모듈과 `remove-worktree` 명령을 TypeScript 로 옮긴다. 이유 주석이 없던 함정에 주석을 단다.

**범위 외**: `cleanup-sweep`(phase 02). 그 명령은 아직 Python 이고 `terminal_ownership.py` 를 import 하며 `remove-worktree.py` 경로를 부른다. 그래서 `terminal_ownership.py` 와 그 테스트는 phase 02 까지 남기고, `remove-worktree.py` 는 shim 으로 둔다.

## 컨텍스트

시작 조건: `orch/scripts/finish-pr.ts` 와 `orch/scripts/merge_queue.ts` 가 있다(머지 단계 TS 전환, orch 3.1.0). 없으면 `PHASE_BLOCKED: 머지 단계 TS 전환 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/terminal_ownership.py`(모듈) | `orch/scripts/lib/ownership.ts` | `orch/tests/test_terminal_ownership.py` 의 사례 → `orch/tests/ownership.spec.ts`. 원본 테스트는 phase 02 에서 지운다 |
| `orch/scripts/remove-worktree.py` | `orch/scripts/remove-worktree.ts` | `orch/tests/test_remove_worktree.py` → `orch/tests/remove-worktree.spec.ts` |

`terminal_ownership.py` 는 PR #190 이 크게 바꿨다. 범위가 `all` 이 아니면 `run-list` 와 Run 마다 `worker-list --run` 을 병렬로 읽어 합치고, 60초 동안 읽은 결과를 다시 쓰고, 한 행의 `resource.terminalHandle` 과 `agentTerminalHandle` 을 모두 본다. 그 판정을 그대로 옮긴다. 병렬 읽기는 `lib/proc.ts` 의 `runAsync`, orca 호출은 `lib/orca.ts` 다.
점유 프로세스 찾기와 pid 확인은 `lib/process.ts` 의 `cwdHolders` 와 `alive` 다.
`lib/ownership.ts` 는 원본이 내보내던 것(`LOOKUP_ERRORS` 에 해당하는 실패 표현, `all_workers`, `run_workers`, `blocker`, `cached`, `row_handles`)을 같은 뜻의 함수로 내보낸다. phase 02 의 `cleanup-sweep.ts` 가 이것을 import 한다.

`remove-worktree.ts` 의 옵션, 출력 줄(`없음:`, `거부:`), 종료 코드(0 삭제, 1 거부, 2 인자 오류)는 원본 머리 주석과 같다. 원본은 소유 확인을 `terminal_ownership.py` 자식 프로세스로 불렀다. 새 명령은 `lib/ownership.ts` 를 import 한다. 머리 주석의 「Python 3.10 이상」 요구는 지운다.
환경 변수(`ORCA`, `ORCH_HOOK_WAIT`)와 PATH 의 `lsof`, `git` 은 원본처럼 쓴다. 아직 Python 인 `cleanup-sweep.py` 가 `remove-worktree.py` 경로를 부르고 `test_cleanup_sweep.py` 가 가짜 실행 파일을 PATH 앞에 둔다. 그래서 그 테스트가 shim 을 거쳐 새 명령을 함께 확인한다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/ci-ready.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 를 부른다. node 22.18 미만이면 `NODE-TOO-OLD` 줄과 종료 코드 127 로 멈추고, 아니면 stderr 에 `DEPRECATED` 줄을 내고 같은 이름의 `.ts` 로 exec 한다(`orch/scripts/ts_shim.py` 머리 주석). `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `remove-worktree.py` 다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다. 같은 이름의 `.ts` 가 있는 `.py` 는 대조하지 않는다.

**근거 문서**: `docs/code-architecture.md` 의 「배치」, 「실행 규칙」 의 주석 줄, `orch/references/cleanup.md` 의 「워크트리 지우기」

## 의도 메모

- `remove-worktree.py` 의 이유 주석이 없는 함정: 원격에 같은 제목의 커밋이 있으면 rebase 된 것으로 보는 `--grep` 규칙, 터미널 소유 상태를 두 번 확인하는 것. 옮기면서 왜 그런지 주석을 단다. 모르면 `git log -S` 로 그 줄을 넣은 커밋을 읽는다. 커밋에서도 이유를 찾지 못하면 이력을 지어내지 않고 그 줄이 무엇을 막는지(실제 동작)만 적는다.
- 테스트가 Orca 터미널 안에서 돌 때 `ORCA_TERMINAL_HANDLE` 이 가짜 orca 로 새지 않게 테스트 환경에서 뺀다. PR #190 이 Python 테스트에서 한 처리다.

## 작업 항목

### 1. `orch/scripts/lib/ownership.ts`

위 「컨텍스트」 의 판정을 옮긴다. 머리 주석은 원본 머리 주석의 상태별 표(owned, user_owned / user_takeover, released, external, identity_unproven)와 범위 읽기 규칙을 옮긴다. `JOBS = 16` 과 `MAX_AGE = 60` 의 이유 주석도 옮긴다.

### 2. `orch/scripts/remove-worktree.ts` 와 shim

원본 판정을 옮기고 소유 확인은 `lib/ownership.ts` 의 `blocker` 로 한다. `remove-worktree.py` 를 위 꼴의 shim 으로 바꾼다.

### 3. 문서

- `orch/README.md`: `scripts/remove-worktree.py` 줄을 `scripts/remove-worktree.ts` 로 바꾼다. 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/remove-worktree.py` 를 더한다. `scripts/terminal_ownership.py` 줄의 「`remove-worktree.py` 가 삭제 전에 실행한다」 를 「같은 판정의 TypeScript 는 `lib/ownership.ts` 다」 로 바꾼다
- `docs/code-architecture.md` 「배치」: `orch/scripts/lib/ownership.ts` 줄(터미널 소유 확인 한 벌. 모든 Run 의 worker 행을 읽어 60초 동안 다시 쓴다. 사용처는 머리 주석이 소유한다)을 `lib/process.ts` 줄 뒤에 더한다

### 4. 테스트

`orch/tests/ownership.spec.ts` 와 `orch/tests/remove-worktree.spec.ts` 를 만든다.

- `ownership.spec.ts`: `test_terminal_ownership.py` 의 사례를 모두 옮긴다. 가짜 orca 와 lsof 는 `orch/tests/fixtures/fake-bin.ts` 의 `fakeBin` 으로 만든다
- `remove-worktree.spec.ts`: `test_remove_worktree.py` 의 사례를 모두 옮긴다. 원격에 같은 제목의 커밋이 있으면 지우는 사례와, squash 머지라 제목이 달라 `--merged-head` 없이는 거부하는 사례가 함께 있어야 한다

`test_remove_worktree.py` 는 지운다. `test_terminal_ownership.py` 는 `cleanup-sweep.py` 가 아직 원본 모듈을 쓰므로 phase 02 에서 지운다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/ownership.spec.ts orch/tests/remove-worktree.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md docs/code-architecture.md
```

`run-orch-tests.py` 는 `test_cleanup_sweep.py`, `test_cleanup_wait.py`, `test_terminal_ownership.py` 를 돌린다. 앞의 둘이 shim 을 거쳐 `remove-worktree.ts` 를 부른다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/ownership.ts` | 신규 |
| `orch/scripts/remove-worktree.ts` | 신규 |
| `orch/scripts/remove-worktree.py` | 수정 |
| `orch/tests/ownership.spec.ts` | 신규 |
| `orch/tests/remove-worktree.spec.ts` | 신규 |
| `orch/tests/test_remove_worktree.py` | 삭제 |
| `orch/README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
