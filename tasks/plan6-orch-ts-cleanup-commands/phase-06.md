# Phase 06. Python 테스트 러너를 지우고 CI, 문서, CHANGELOG 를 TypeScript 명령에 맞춘다

**Execution profile**: standard

## 목표

마지막 Python 테스트 `orch/tests/test_ts_shim.py` 를 node:test 로 옮기고 orch 의 격리 테스트 러너를 지운다. `node --test` 하나로 orch 와 work-board 테스트를 돌린다.
문서가 부르는 남은 Python 명령을 `.ts` 로 바꾸고, 이 plan 의 변경과 호환성 변경을 CHANGELOG 에 적는다.

**범위 외**: 옛 `.py` shim 을 지우는 일. 다음 major 에서 한다. `docs/code-architecture.md` 「배치」 블록은 각 phase 가 이미 고쳤다.

## 컨텍스트

시작 조건: `orch/scripts/heavy-slot.ts` 와 `work-board/bin/board.ts` 가 있고 `orch/scripts/live_specs.py` 가 없다. 아니면 `PHASE_BLOCKED: phase 05 커밋 전` 을 내고 멈춘다.
이때 Python 테스트는 `orch/tests/test_ts_shim.py` 하나만 남아 있고 `work-board/tests/` 에는 없다. 이 phase 가 `test_ts_shim.py` 를 옮기면 `orch/tests/` 와 `work-board/tests/` 에 Python 테스트가 없다.

`scripts/run-orch-tests.py` 는 Python 테스트를 파일마다 다른 프로세스로 돌리던 러너다. `node --test` 는 파일마다 프로세스를 나누므로 필요 없다. 그 러너의 테스트 `scripts/tests/test_run_orch_tests.py` 도 지운다.
CI 의 `Python tests` job 은 `*/tests` 와 `tools/*/tests` 를 돌며 `python3 -m unittest discover` 를 부르고 `orch/tests` 만 건너뛴다. Python 3.12 의 unittest 는 테스트를 하나도 돌리지 않으면 종료 코드 5 로 실패한다. 그래서 `work-board/tests` 도 건너뛰게 한다.
`Plugin tests` job 의 node 테스트 단계(`node --test --test-concurrency=4 "orch/tests/*.spec.ts"`)에 `"work-board/tests/*.spec.ts"` 를 더한다. job 이름은 바꾸지 않는다. 필수 체크 이름이다.

`orch-doctor.py` 는 shim 이 아니라 공식 진입점이다(`orch/SKILL.md` 29행, `orch/references/waiting.md` 28행). 스킬을 열 때 node 버전을 그 진입점이 본다. 그래서 문서의 이 호출은 `.ts` 로 바꾸지 않는다.
`scripts/tests/test_doc_script_refs.py` 는 문서가 부르는 `$SKILL_DIR/scripts/*` 경로가 실제로 있는지 본다. 이 phase 가 문서의 호출을 `.ts` 로 바꾸므로 검증에 넣는다. `python3 -m unittest discover -s scripts/tests` 가 그 폴더의 `test_*.py` 를 모두 돌리고, 하나라도 실패하면 0 이 아닌 종료 코드를 낸다.

**근거 문서**: `docs/code-architecture.md` 의 「실행 규칙」 의 테스트 줄, `docs/adr/010-orch-typescript.md`, `docs/data-schema.md` 의 `heavy` 줄

## 의도 메모

- `docs/code-architecture.md` 의 「orch 코어와 핸들러」 절 머리의 「구현 PR 이 모두 머지되기 전」 문장은 상주 루프 plan 이 끝날 때 지운다. 이 phase 에서는 그대로 둔다.
- 남은 `.py` 호출 찾기는 `scripts/` 가 앞에 붙은 경로와 백틱 안의 이름(`` `heavy-slot.py` ``)을 함께 본다. 이름만 적은 곳이 많다(`orch/references/cleanup.md`, `verification.md`).

## 작업 항목

### 1. `orch/tests/ts-shim.spec.ts`

`test_ts_shim.py` 의 사례를 모두 옮기고 원본을 지운다. shim 은 `python3` 자식 프로세스로 띄우고, 가짜 node 는 원본처럼 `--version` 에 버전을 내고 그 밖에는 받은 인자를 한 줄씩 낸 뒤 7 로 끝나는 실행 파일을 PATH 앞에 둔다.

- `node_too_old` 의 판정(`v22.18.0`, `v24.1.0` 은 통과, `v22.17.9`, `v20.19.0`, 읽지 못하는 문자열은 낮음)은 `python3 -c` 로 `ts_shim` 을 import 해 본다
- 원본 `test_exec_os_error_is_127` 은 mock 으로 exec 실패를 만든다. 같은 mock 을 담은 `python3 -c` 스크립트를 자식 프로세스로 돌려 종료 코드 127 과 stderr 의 `node 22.18 이상이 PATH 에 필요하다` 를 본다
- `test_import_does_not_exec` 도 `python3 -c` 로 shim 을 importlib 로 읽어 가짜 node 가 불리지 않았음을 본다

### 2. 러너와 그 테스트를 지운다

`scripts/run-orch-tests.py`, `scripts/tests/test_run_orch_tests.py` 를 지운다.

### 3. `.github/workflows/ci.yml`

- `Python tests` job 의 「Run isolated orch tests」 단계를 지운다
- 같은 job 의 순회에서 `orch/tests` 와 `work-board/tests` 를 건너뛴다. 두 폴더에 Python 테스트가 없고, 빈 폴더에서 unittest 가 종료 코드 5 를 낸다는 이유를 주석으로 단다
- `Plugin tests` job 의 node 테스트 단계에 `"work-board/tests/*.spec.ts"` 를 더한다

### 4. 문서

- `README.md` 「기여」: 격리 러너 문장(122행)을 지우고 TypeScript 테스트 명령을 `node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"` 로 바꾼다. 42행의 `work-board/bin/board.py` 를 `.ts` 로 바꾼다
- `.orch/overlay.md`: 로컬 검증 줄에서 `python3 scripts/run-orch-tests.py --jobs 4` 를 빼고 node 테스트 명령을 위 명령으로 바꾼다. 5행의 `ci-ready.py` 를 `ci-ready.ts` 로 바꾼다
- `orch/README.md`: 테스트 절의 `python3 scripts/run-orch-tests.py --report …` 블록과 러너 설명 문단을 위 node 명령과 「파일마다 프로세스가 나뉜다」 로 바꾼다
- `orch/SKILL.md`, `orch/references/*.md`, `work-board/README.md` 에서 남은 Python 명령 호출을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<이름>.ts"` 로, 명령 이름을 `.ts` 로 바꾼다. `board.py` 는 `board.ts` 로, `python3 "$BOARD_BIN"` 은 `node --disable-warning=ExperimentalWarning "$BOARD_BIN"` 으로 바꾼다
- 남은 곳은 아래로 찾는다. CHANGELOG 의 지난 항목은 이력이라 고치지 않는다

  ```bash
  git grep -nE 'python3 [^`]*scripts/|scripts/[a-z_-]+\.py|`[a-z_-]+\.py`|board\.py' -- 'orch/*.md' 'work-board/*.md' README.md .orch/overlay.md docs/code-architecture.md ':!*CHANGELOG.md'
  ```

  문서만 찾는다. 테스트와 코드가 shim 호환을 위해 일부러 적은 옛 `.py` 경로(옛 경로를 부르는 테스트, `lib/paths.ts` 의 안내, `merge-queue.sh`)는 이 phase 에서 고치지 않는다. 남아도 되는 것은 `orch-doctor.py`(공식 진입점), `ts_shim.py`, `orch/README.md` 의 「옛 경로. 다음 major 에서 지운다」 줄과 각 shim 의 설명, 다른 스킬의 `review_threads.py`, 저장소 루트 `scripts/` 의 Python 도구(`check-shell-korean.py` 같은 것)와 `tools/` 의 것이다
- `orch/references/heavy-checks.md`: 실행 예시를 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/heavy-slot.ts"` 로 바꾸고, `.orch/config.json` 의 `heavy` 절 예시 하나(아래 CHANGELOG 의 예시와 같은 값)를 둔다
- `docs/adr/010-orch-typescript.md` 결정 줄의 「`scripts/run-orch-tests.py` 를 TypeScript 로 옮긴다」 를 「`node --test` 가 파일마다 프로세스를 나누므로 `scripts/run-orch-tests.py` 는 옮기지 않고 지운다」 로 고친다(`docs/code-architecture.md` 「실행 규칙」 과 맞춘다)
- `docs/code-architecture.md` 「검증」 표에 node 테스트 명령 줄(orch 와 work-board 의 `*.spec.ts`)을 더한다. 「모듈 책임」 표에 `work-board/bin/board.ts` 줄(보드 편집 명령과 기본 보드 위치. 부르는 쪽은 orch 의 `board-sync`, `goal-progress`, `finish-pr` 와 `lib/paths.ts`)을 더한다

### 5. CHANGELOG 와 버전

`orch/SKILL.md` frontmatter 의 `metadata.version` 을 `3.2.0` 으로 올리고 `orch/CHANGELOG.md` 에 이 plan 을 `## 3.2.0 (<날짜>)` 항목 하나로 적는다. work-board 에는 CHANGELOG 가 없다.
본문에는 옮긴 명령(`remove-worktree`, `cleanup-sweep`, `handoff-cleanup`, `board-sync`, `goal-progress`, `heavy-slot`, `mem-gate`, `orch_paths`, work-board 의 `board`), 새 이벤트(`before-cleanup`, `after-cleanup`), `cleanup-sweep --remote-branches`, `heavy` 절과 `wait_idle`, 지운 모듈(`terminal_ownership.py`, `live_specs.py`, `orch_process.py`)을 적는다.

「호환성」 절에는 아래를 모두 적는다.

- 무거운 검사의 자동 분류를 지웠다. `heavy-slot` 은 명령 이름을 보고 혼자 실행(`exclusive`)이나 대기열 건너뛰기(`light`)를 정하지 않는다. `.orch/config.json` 에 `heavy` 절이 없으면 모든 명령이 자리를 기다린다(`normal`). 옛 동작에 가까운 설정 예시를 둔다

  ```json
  {
    "heavy": {
      "exclusive": ["local-ci", "playwright", "browser"],
      "light": ["^(pnpm( -s)?( exec)? )?(tsc|oxlint)\\b", "^pnpm( -s)? (type-check|lint)\\b", "^(echo|cd|git|ls|cat|true|test)(\\s|$)"]
    }
  }
  ```

- `wait_idle` 대기가 `HEAVY_IDLE_WAIT`(기본 1800초)를 넘으면 `heavy-slot` 이 종료 코드 124 로 끝난다
- `cleanup-sweep` 의 지시서를 남기는 줄이 `살아 있는 지시서 목록을 읽지 못했다` 로 바뀌었다. 그 목록을 읽지 못하면 PR 본문 파일도 지우지 않는다
- `handoff-cleanup` 의 지시서 줄이 `지시서를 휴지통으로 옮길 것 …`, `지시서 옮김 … -> …`, `지시서를 남긴다 …` 로 바뀌었다. 큐 로그, 폴더, 데이터 파일의 `후보`, `옮김` 줄은 그대로다
- `cleanup-sweep` 은 `--run` 을 주면 머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널을 닫고 dispatch 를 반납한다. 워크트리를 지우는 조건은 바뀌지 않았다
- 보드 명령의 기본(`BOARD_BIN` 이 없을 때)이 `work-board/bin/board.ts` 다. `board.py` 는 shim 으로 남는다
- `--apply` 정리에서 `before-cleanup` 핸들러가 거부하거나 실패하면 그 워크트리를 남긴다

### 6. 남은 Python 을 확인하는 검사

`orch/tests/readme-script-list.spec.ts` 에 사례를 더한다.

- `orch/scripts/` 의 `.py` 가운데 `ts_shim.py` 를 뺀 파일은 모두 shim 이다. 판정은 파일 내용에 `ts_shim.exec_ts(__file__` 가 있고 같은 폴더에 같은 이름의 `.ts` 가 있는지다. `orch-doctor.py` 의 `ts_shim.exec_ts(__file__, deprecated=False)` 도 이 판정에 맞는다
- 임시 폴더에서: `.ts` 없는 `a.py`, `exec_ts` 를 부르지 않는 `b.py`(같은 이름의 `b.ts` 있음)는 shim 이 아니라고 알린다. `ts_shim.py` 는 알리지 않는다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/readme-script-list.spec.ts orch/tests/ts-shim.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
claude plugin test .
! test -e scripts/run-orch-tests.py
! test -e orch/tests/test_ts_shim.py
python3 -c "import glob, sys; sys.exit(1 if glob.glob('orch/tests/*.py') + glob.glob('work-board/tests/*.py') else 0)"
python3 korean-check/scripts/korean-style-check.py README.md orch/SKILL.md orch/README.md orch/CHANGELOG.md orch/references/*.md work-board/README.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/tests/ts-shim.spec.ts` | 신규 |
| `orch/tests/test_ts_shim.py` | 삭제 |
| `scripts/run-orch-tests.py` | 삭제 |
| `scripts/tests/test_run_orch_tests.py` | 삭제 |
| `.github/workflows/ci.yml` | 수정 |
| `README.md` | 수정 |
| `.orch/overlay.md` | 수정 |
| `orch/README.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/references/*.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `work-board/README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/tests/readme-script-list.spec.ts` | 수정 |
| `docs/adr/010-orch-typescript.md` | 수정 |
| `orch/scripts/cleanup-sweep.ts` | 수정 |
| `orch/scripts/remove-worktree.ts` | 수정 |
