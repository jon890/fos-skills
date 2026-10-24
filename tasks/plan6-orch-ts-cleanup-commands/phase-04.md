# Phase 04. 산출물 정리와 보드 동기화 명령을 옮긴다

**Execution profile**: standard

## 목표

`handoff-cleanup`, `board-sync`, `goal-progress` 를 TypeScript 로 옮긴다.

**범위 외**: `work-board/bin/board.py`(phase 05). 이 phase 의 명령은 보드를 고칠 때 `BOARD_BIN`, 없으면 `work-board/bin/board.py` 를 `lib/proc.ts` 의 `scriptCommand` 로 부른다. phase 05 가 board 를 옮기면서 기본 경로를 `.ts` 로 바꾼다.

## 컨텍스트

시작 조건: `orch/scripts/cleanup-sweep.ts` 머리 주석에 `--remote-branches` 가 있다. 없으면 `PHASE_BLOCKED: phase 03 커밋 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/handoff-cleanup.py` | `orch/scripts/handoff-cleanup.ts` | `orch/tests/test_handoff_cleanup.py` → `orch/tests/handoff-cleanup.spec.ts` |
| `orch/scripts/board-sync.py` | `orch/scripts/board-sync.ts` | `orch/tests/test_board_sync.py` → `orch/tests/board-sync.spec.ts` |
| `orch/scripts/goal-progress.py` | `orch/scripts/goal-progress.ts` | `orch/tests/test_scripts.py` 의 `GoalProgressTest` → `orch/tests/goal-progress.spec.ts`. 이 클래스가 마지막이라 `test_scripts.py` 를 지운다 |

옵션, 종료 코드, 판정은 원본 머리 주석과 같다. 경로는 `lib/paths.ts`(`orchDir`, `pathOf`, `boardPath`, `requireMigrated`), 설정은 `lib/config.ts` 의 `loadConfig` 와 `section` 이다. `cleanup` 절은 원본처럼 옵션 이름의 하이픈을 밑줄로 바꾼 키를 받는다. 그 키 목록을 `section` 의 `known` 으로 넘긴다.
`board-sync.ts` 는 `--goal` 이면 같은 폴더의 `goal-progress.ts` 를 `scriptCommand` 로 부른다. 명령끼리 import 하지 않는다.

지시서 옮기기는 `lib/spec.ts` 의 `deleteSpecs` 를 `mode: { trash }` 로 부른다. `root` 는 orch 작업 폴더, `prBodies` 는 빈 목록, `live` 는 `liveSpecPaths(--run)` 이다. `deleteSpecs` 는 휴지통 안에 `<휴지통>/<root 의 폴더 이름>/<root 기준 상대경로>` 로 두고 같은 이름이 있으면 번호를 붙인다. 원본 `def move` 와 같은 자리다. 그래서 `lib/spec.ts` 는 고치지 않는다.
어느 지시서를 옮길지(보드 항목이 done, 브랜치가 원격과 워크트리에 없고 열린 PR 도 없음)는 원본 `def spec_finished` 를 `handoff-cleanup.ts` 에 옮긴다. 열린 PR 목록을 읽지 못하면 원본처럼 지시서를 하나도 넘기지 않는다. 큐 로그, 폴더, 데이터 파일은 원본처럼 `handoff-cleanup.ts` 가 옮긴다.
지시서 줄은 `deleteSpecs` 의 문구(`지시서를 휴지통으로 옮길 것 …`, `지시서 옮김 … -> …`, `지시서를 남긴다 …: 살아 있는 dispatch 가 쓴다`)로 바뀐다. 원본은 `후보 <상대경로>`, `옮김 <상대경로>` 와 stderr 의 `살아 있는 dispatch 가 쓰는 지시서라 남긴다` 였다. phase 06 의 CHANGELOG 호환성 절이 적는다.
`handoff-cleanup` 의 기본(미리보기)은 바꾸지 않는다. 사용자 결정(2026-10-24)은 코디네이터가 묻지 않고 `--apply` 로 부르는 것이고, 문서가 그렇게 지시한다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/ci-ready.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 를 부른다. node 22.18 미만이면 `NODE-TOO-OLD` 줄과 종료 코드 127 로 멈추고, 아니면 stderr 에 `DEPRECATED` 줄을 내고 같은 이름의 `.ts` 로 exec 한다(`orch/scripts/ts_shim.py` 머리 주석). `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `handoff-cleanup.py`, `board-sync.py`, `goal-progress.py` 다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다. 같은 이름의 `.ts` 가 있는 `.py` 는 대조하지 않는다.

**근거 문서**: `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 의 handoff 줄과 「공통 안전 장치」 의 지시서 삭제 줄

## 의도 메모

- 지시서 삭제와 옮기기의 판정이 세 벌로 갈라져 하나만 확인을 빠뜨린 것이 이 전환의 이유 가운데 하나다. 살아 있는 지시서 판정을 `handoff-cleanup.ts` 에 다시 쓰지 않는다.
- 원본 `test_board_sync.py` 의 `DefaultBoardBinTest` 는 importlib 로 `BOARD_BIN` 속성을 읽었다. shim 에는 그 속성이 없다. `board-sync.spec.ts` 는 `finish-pr.spec.ts` 의 `BOARD_BIN 이 없으면 …` 사례처럼 `BOARD_BIN` 없이 실제 보드 명령이 항목을 done 으로 바꾸는지로 본다.

## 작업 항목

### 1. 위 표의 명령과 shim

세 명령을 위 「컨텍스트」 대로 옮기고 세 `.py` 를 shim 으로 바꾼다. 기본 `BOARD_BIN` 은 이 phase 에서는 `work-board/bin/board.py` 그대로다.

### 2. 문서

- `orch/README.md`: `scripts/handoff-cleanup.py`, `scripts/board-sync.py`, `scripts/goal-progress.py` 줄을 `.ts` 로 바꾼다. 「옛 경로. 다음 major 에서 지운다」 줄에 세 `.py` 를 더한다. `scripts/live_specs.py` 줄을 「모듈. 같은 판정은 `lib/spec.ts` 의 `liveSpecPaths` 다. import 하는 명령이 없다」 로 바꾼다
- `merge-with-finish.ts` 33행 머리 주석의 `handoff-cleanup.py` 를 `handoff-cleanup.ts` 로 바꾼다

### 3. 테스트

`orch/tests/handoff-cleanup.spec.ts`, `orch/tests/board-sync.spec.ts`, `orch/tests/goal-progress.spec.ts` 를 만들고 원본 사례를 모두 옮긴 뒤 원본 테스트를 지운다.

`handoff-cleanup.spec.ts` 에 더한다:

- 끝난 지시서가 `--apply` 로 `<휴지통>/<orch 폴더 이름>/specs/spec-x.md` 로 옮겨진다. 휴지통에 같은 이름이 있으면 `.2` 가 붙는다
- 살아 있는 dispatch 가 쓰는 지시서는 남고 `지시서를 남긴다` 줄이 난다
- 살아 있는 지시서 목록을 읽지 못하면 지시서는 하나도 옮기지 않고 큐 로그는 옮긴다

`board-sync.spec.ts` 에 더한다: `BOARD_BIN` 이 없으면 `work-board/bin/board.py` 가 보드 항목을 done 으로 바꾼다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/handoff-cleanup.spec.ts orch/tests/board-sync.spec.ts orch/tests/goal-progress.spec.ts orch/tests/lib-spec.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md
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
| `orch/scripts/merge-with-finish.ts` | 수정 |
| `orch/tests/handoff-cleanup.spec.ts` | 신규 |
| `orch/tests/board-sync.spec.ts` | 신규 |
| `orch/tests/goal-progress.spec.ts` | 신규 |
| `orch/tests/test_handoff_cleanup.py` | 삭제 |
| `orch/tests/test_board_sync.py` | 삭제 |
| `orch/tests/test_scripts.py` | 삭제 |
| `orch/README.md` | 수정 |

## 구현 중 정한 것

- 지시서 줄은 `lib/spec.ts` 의 `deleteSpecs` 가 내는 꼴로 바뀐다(절대경로, `지시서를 휴지통으로 옮길 것`, `지시서 옮김 … -> …`, `지시서를 남긴다 …: <이유>`). 끝나지 않은 지시서는 `deleteSpecs` 로 넘기지 않아 「남긴다」 줄이 나지 않는다. 마지막 phase 의 CHANGELOG 호환성 절에 이 차이를 적는다.
- `drop_nested` 는 지시서가 아닌 후보에만 쓴다. 지시서는 예약 폴더 안이라 다른 후보와 겹치지 않는다.
