# Phase 03. 산출물 정리와 보드 동기화 명령을 옮긴다

**Execution profile**: standard

## 목표

`handoff-cleanup`, `board-sync`, `goal-progress` 를 TypeScript 로 옮긴다.

**범위 외**: `work-board/bin/board.py`(phase 04). 이 phase 의 명령은 보드를 고칠 때 `BOARD_BIN` 이나 `work-board/bin/board.py` 를 `lib/proc.ts` 의 `scriptCommand` 로 부른다. phase 04 가 board 를 옮기면 기본 경로를 `.ts` 로 바꾼다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/handoff-cleanup.py` | `orch/scripts/handoff-cleanup.ts` | `orch/tests/test_handoff_cleanup.py` → `orch/tests/handoff-cleanup.spec.ts` |
| `orch/scripts/board-sync.py` | `orch/scripts/board-sync.ts` | `orch/tests/test_board_sync.py` → `orch/tests/board-sync.spec.ts` |
| `orch/scripts/goal-progress.py` | `orch/scripts/goal-progress.ts` | `orch/tests/test_scripts.py` 의 `GoalProgressTest` → `orch/tests/goal-progress.spec.ts`. 이 클래스가 마지막이라 `test_scripts.py` 를 지운다 |

옵션, 종료 코드, 판정은 원본 머리 주석과 같다. 지시서 옮기기는 `lib/spec.ts` 의 `deleteSpecs` 와 같은 판정(살아 있는 지시서 목록, 읽지 못하면 옮기지 않음)을 쓴다. `handoff-cleanup` 은 지우지 않고 휴지통 폴더로 옮기므로, `deleteSpecs` 에 옮기기 동작을 받는 인자를 더하거나 판정 함수만 나눠 쓴다. 어느 쪽이든 판정이 한 곳에 남게 한다.
`handoff-cleanup` 의 기본(미리보기)은 바꾸지 않는다. 사용자 결정(2026-10-24)은 코디네이터가 묻지 않고 `--apply` 로 부르는 것이고, 문서가 그렇게 지시한다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `handoff-cleanup.py`, `board-sync.py`, `goal-progress.py` 에 둔다.

**근거 문서**: `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 handoff 줄과 「공통 안전 장치」 의 지시서 삭제 줄

## 의도 메모

- 지시서 삭제와 옮기기의 판정이 세 벌로 갈라져 하나만 확인을 빠뜨린 것이 이 전환의 이유 가운데 하나다. 판정 함수를 복사하지 않는다.

## 작업 항목

### 1. 위 표의 명령을 옮긴다

### 2. 테스트를 옮긴다

`orch/tests/handoff-cleanup.spec.ts`, `orch/tests/board-sync.spec.ts`, `orch/tests/goal-progress.spec.ts` 를 만들고 원본 사례를 모두 옮긴 뒤 원본 테스트를 지운다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/handoff-cleanup.spec.ts orch/tests/board-sync.spec.ts orch/tests/goal-progress.spec.ts orch/tests/lib-spec.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/handoff-cleanup.ts` | 신규 |
| `orch/scripts/board-sync.ts` | 신규 |
| `orch/scripts/goal-progress.ts` | 신규 |
| `orch/scripts/handoff-cleanup.py` | 수정 |
| `orch/scripts/board-sync.py` | 수정 |
| `orch/scripts/goal-progress.py` | 수정 |
| `orch/scripts/lib/spec.ts` | 수정 |
| `orch/tests/handoff-cleanup.spec.ts` | 신규 |
| `orch/tests/board-sync.spec.ts` | 신규 |
| `orch/tests/goal-progress.spec.ts` | 신규 |
| `orch/tests/test_handoff_cleanup.py` | 삭제 |
| `orch/tests/test_board_sync.py` | 삭제 |
| `orch/tests/test_scripts.py` | 삭제 |
