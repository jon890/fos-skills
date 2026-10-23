# Phase 04. 무거운 검사 대기열, 경로 명령, 보드 명령을 옮기고 남은 Python 모듈을 지운다

**Execution profile**: deep

## 목표

`heavy-slot`, `mem-gate`, `orch_paths` 명령, `work-board/bin/board.py` 를 TypeScript 로 옮긴다.
무거운 검사 분류 정규식을 코드에서 빼 `config.json` 의 `heavy` 절로 옮긴다. 더는 import 하는 쪽이 없는 Python 모듈을 지운다.

**범위 외**: 테스트 러너와 CI 정리, 문서(phase 05).

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/heavy-slot.py` | `orch/scripts/heavy-slot.ts` | `orch/tests/test_heavy_slot.py` → `orch/tests/heavy-slot.spec.ts` |
| `orch/scripts/mem-gate.py` | `orch/scripts/mem-gate.ts` | `orch/tests/test_mem_gate.py` → `orch/tests/mem-gate.spec.ts` |
| `orch/scripts/orch_paths.py` | 명령 `orch/scripts/orch_paths.ts`. 판정은 `lib/paths.ts` | `orch/tests/test_orch_paths.py` → `orch/tests/orch-paths.spec.ts` |
| `orch/scripts/live_specs.py` | 지운다. `lib/spec.ts` 가 대신한다 | `orch/tests/test_live_specs.py` 를 지운다. `lib-spec.spec.ts` 가 다룬다 |
| `orch/scripts/orch_process.py` | 지운다. `lib/proc.ts` 가 대신한다 | |
| `work-board/bin/board.py` | `work-board/bin/board.ts` | `work-board/tests/test_board.py` → `work-board/tests/board.spec.ts` |

`orch_paths.py` 는 `work-board/bin/board.py` 를 import 하므로, `orch_paths.py` 를 먼저 지운 뒤 board 를 옮긴다. 이 phase 가 끝나면 `orch/scripts/` 의 `.py` 는 모두 shim 이다.
`heavy-slot.py` 의 `classify` 와 `LIGHT` 정규식은 한 저장소의 명령 이름을 담는다. 그 값은 코드에 남기지 않는다. 새 분류는 `config.json` 의 `heavy.exclusive`, `heavy.normal`, `heavy.light` 를 앞에서부터 맞춰 보고, 어디에도 맞지 않으면 `normal` 이다(`docs/data-schema.md`). `--exclusive` 와 `HEAVY_EXCLUSIVE` 는 그대로다.
`heavy.wait_idle` 은 자리를 잡기 전에 명령줄이 그 정규식에 맞는 프로세스가 없을 때까지 `HEAVY_POLL` 간격으로 기다린다.
보드 명령을 부르던 `board-sync.ts`, `goal-progress.ts`, `finish-pr.ts` 의 기본 `BOARD_BIN` 을 `work-board/bin/board.ts` 로 바꾼다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `heavy-slot.py`, `mem-gate.py`, `orch_paths.py`, `work-board/bin/board.py` 에 둔다. 다른 저장소의 포장 스크립트와 문서가 `orch_paths.py specs` 와 `heavy-slot.py --` 를 부른다.

**근거 문서**: `docs/data-schema.md` 의 「config.json 에 더하는 절」 의 `heavy` 줄, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 의 무거운 검사 줄, `docs/adr/006-work-board-in-plugin.md`

## 의도 메모

- 분류 설정이 없는 저장소는 모든 명령이 `normal` 이다. 가벼운 명령까지 자리를 기다리지만 잘못 분류해 전체 검사를 동시에 돌리는 것보다 안전하다.
- `mem-gate` 의 기본값(메모리와 swap 기준)에 이유 주석이 없다. 옮기면서 그 값을 고른 이유를 `git log -S` 로 찾아 주석으로 단다.

## 작업 항목

### 1. 위 표의 명령을 옮기고 원본 모듈을 지운다

### 2. `heavy-slot.ts` 의 설정 분류와 `wait_idle`

### 3. 테스트를 옮긴다

`orch/tests/heavy-slot.spec.ts`, `orch/tests/mem-gate.spec.ts`, `orch/tests/orch-paths.spec.ts`, `work-board/tests/board.spec.ts` 를 만들고 원본 사례를 모두 옮긴 뒤 원본을 지운다. 원본의 분류 사례는 한 저장소의 명령 이름을 쓰므로, 같은 꼴의 일반 명령과 그 사례를 담은 `heavy` 설정으로 바꿔 옮긴다.
더할 사례: `heavy` 설정이 없으면 `normal`. `exclusive` 와 `light` 둘 다 맞으면 앞의 `exclusive`. `wait_idle` 에 맞는 가짜 프로세스가 끝날 때까지 자리를 잡지 않는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/heavy-slot.spec.ts orch/tests/mem-gate.spec.ts orch/tests/orch-paths.spec.ts work-board/tests/board.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
claude plugin test .
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/heavy-slot.ts` | 신규 |
| `orch/scripts/mem-gate.ts` | 신규 |
| `orch/scripts/orch_paths.ts` | 신규 |
| `orch/scripts/heavy-slot.py` | 수정 |
| `orch/scripts/mem-gate.py` | 수정 |
| `orch/scripts/orch_paths.py` | 수정 |
| `orch/scripts/live_specs.py` | 삭제 |
| `orch/scripts/orch_process.py` | 삭제 |
| `orch/scripts/board-sync.ts` | 수정 |
| `orch/scripts/goal-progress.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `work-board/bin/board.ts` | 신규 |
| `work-board/bin/board.py` | 수정 |
| `orch/tests/heavy-slot.spec.ts` | 신규 |
| `orch/tests/mem-gate.spec.ts` | 신규 |
| `orch/tests/orch-paths.spec.ts` | 신규 |
| `work-board/tests/board.spec.ts` | 신규 |
| `orch/tests/test_heavy_slot.py` | 삭제 |
| `orch/tests/test_mem_gate.py` | 삭제 |
| `orch/tests/test_orch_paths.py` | 삭제 |
| `orch/tests/test_live_specs.py` | 삭제 |
| `work-board/tests/test_board.py` | 삭제 |
