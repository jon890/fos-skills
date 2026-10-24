# Phase 04. 머지 뒤 마무리를 옮기고 after-deploy 를 내며 지시서 삭제를 한 경로로 모은다

**Execution profile**: deep

## 목표

`merge-with-finish` 와 `finish-pr` 를 TypeScript 로 옮긴다. 업무 완료를 `after-deploy` 이벤트로 바꾸고, `finish-pr` 의 지시서 삭제가 살아 있는 dispatch 를 확인하게 한다.

**범위 외**: `cleanup-sweep` 의 이전. `finish-pr.ts` 는 `cleanup-sweep.py` 를 `scriptCommand` 로 부른다. 옛 칸을 핸들러 파일로 바꾸는 명령(phase 05).

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다(`merge_queue.ts` 가 `--last-of-task` 를 받는다).

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/merge-with-finish.py` | `orch/scripts/merge-with-finish.ts` | `orch/tests/test_merge_with_finish.py` → `orch/tests/merge-with-finish.spec.ts` |
| `orch/scripts/finish-pr.py` | `orch/scripts/finish-pr.ts` | `orch/tests/test_finish_pr.py` → `orch/tests/finish-pr.spec.ts` |

옵션, 종료 코드, 출력 줄(`FINISH-DONE`, `FINISH-FAIL`), `finish-<PR>.out` 과 `.pid` 파일은 원본 머리 주석과 같다. 설정 읽기는 `lib/config.ts` 다.
`MERGE_QUEUE`, `FINISH_PR`, `CLEANUP_SWEEP`, `BOARD_BIN` 환경 변수와 기본 경로(`merge_queue.ts`, `finish-pr.ts`, `cleanup-sweep.py`, `work-board/bin/board.py`)는 `lib/proc.ts` 의 `scriptCommand` 로 부른다.

고칠 결함(원본 위치는 `grep -n` 으로 찾는다):

| 결함 | 원본 | 고친 동작 |
| --- | --- | --- |
| `--complete` 일 때 `브랜치:` 가 같은 지시서를 살아 있는 dispatch 확인 없이 지운다 | `finish-pr.py` 의 `def delete_specs` | `lib/spec.ts` 의 `deleteSpecs` 에 `liveSpecPaths(run)` 결과를 넘긴다. 목록이 null 이면 지우지 않는다 |
| 마무리 pid 확인이 EPERM 을 죽음으로 본다 | `merge-with-finish.py` 의 `def finish_running` | `lib/process.ts` 의 `alive` 를 쓴다 |

`deleteSpecs` 는 실경로가 `root` 아래가 아닌 파일을 `orch 루트 밖이다` 로 남긴다(`lib/spec.ts` 의 `real === rootReal || !inside(real, rootReal)`). 원본은 `--specs-dir` 가 orch 루트 밖이어도 지웠다. 그래서 `root` 에는 orch 루트가 아니라 지시서 폴더 실경로의 부모 `dirname(realPath(specsDir))` 를 넘긴다. 지시서는 그 부모의 바로 아래 폴더에 있으므로 늘 `root` 안이다. 지시서 폴더가 링크여도 실경로로 비교하므로 같다.

업무 완료(`finish.complete_cmd`, `finish.task_pattern`, 명령줄 `--complete-cmd`, `--task-pattern`)는 `after-deploy` 의 legacy 로 넘긴다. `lib/events.ts` 의 legacy 칸은 `{ key, argv, env }` 이고 argv 를 셸 없이 띄운다.
원본은 `shlex.split` 으로 나눈 조각마다 `{number}` 를 바꿨다(`def complete_argv`). lib 에는 `shQuote` 만 있으므로 `lib/py.ts` 에 `shSplit` 을 더한다. `task_pattern` 은 Python 정규식이라 phase 01 의 `lib/py.ts` `pyRegExp` 로 읽는다. 업무 번호 안전 검사는 원본 `NUMBER_OK`(`^[A-Za-z0-9._/-]+$`)다.

`orch/tests/test_board_sync.py` 의 `DefaultBoardBinTest` 는 `board-sync.py`, `goal-progress.py`, `finish-pr.py` 를 importlib 로 읽어 `BOARD_BIN` 을 본다. shim 은 그 속성이 없으므로 이 phase 에서 고친다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/send-to-worker.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 만 부른다. node 22.18 확인(낮으면 `NODE-TOO-OLD` 줄과 종료 코드 127), stderr 의 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <대상>` 줄, exec 는 `orch/scripts/ts_shim.py` 가 맡는다. `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `merge-with-finish.py`, `finish-pr.py` 다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `after-deploy` 줄과 「갈래」, `docs/data-schema.md` 의 「이벤트별 필드」 와 대응 표, `docs/code-architecture.md` 의 「공통 안전 장치」 의 지시서 삭제 줄과 「배치」 의 명령끼리 import 하지 않는 규칙

## 의도 메모

- `after-deploy` 는 배포가 실패하거나 시간이 지나도 낸다. 핸들러는 입력의 `deploy` 로 스스로 판단한다. 보드 done 과 legacy 업무 완료는 원본처럼 배포가 실패하거나 시간이 지나면 하지 않는다.
- 업무 완료 명령과 `hooks/after-deploy.ts` 가 함께 있으면 `fire` 는 배포를 기다린 뒤에야 ConfigError 를 낸다. 그때는 이미 머지와 정리가 끝났다. 그래서 `finish-pr.ts` 와 `merge-with-finish.ts` 가 시작할 때 본다.
- 값을 받는 머지 큐 옵션은 `lib/queue-options.ts` 의 `QUEUE_VALUE_OPTIONS` 하나다. `merge-with-finish.ts` 와 `merge_queue.ts` 가 같은 상수를 import 하므로 두 목록을 대조하던 테스트는 필요 없다.

## 작업 항목

### 1. `orch/scripts/lib/py.ts` 의 `shSplit`

`shSplit(text: string): string[]` 를 더한다. POSIX 모드 `shlex.split` 과 같다. 공백으로 나누고, 작은따옴표 안은 글자 그대로, 큰따옴표 안은 `\"`, `\\`, `` \` ``, `\$`, 줄바꿈 앞의 역슬래시만 풀고, 따옴표 밖의 역슬래시는 다음 글자를 그대로 둔다. 닫히지 않은 따옴표나 끝의 역슬래시는 Error 다.
`orch/tests/lib-py.spec.ts` 에 더한다: 원본 `test_complete_argv_replaces_placeholder_without_a_shell` 의 입력, 따옴표 꼴마다 하나, 닫히지 않은 따옴표는 Error.

### 2. `orch/scripts/finish-pr.ts`

원본 순서를 옮기고 아래를 바꾼다.

1. 시작할 때 검사한다. `--complete-cmd` 를 `shSplit` 으로 나누지 못하거나 `{number}` 가 없으면, `--task-pattern` 을 `pyRegExp` 로 읽지 못하거나 그룹이 없으면 사용법 오류(2)다. 업무 완료 명령과 `handlerFile('after-deploy', repo)` 가 함께 있으면 `fire` 와 같은 문구로 2 다. 모두 머지를 기다리기 전이다
2. 지시서: `--specs-dir` 와 `--complete` 가 함께 있으면 `spec-*.md` 가운데 `branchesOf` 가 그 브랜치를 담은 것을 고른다. `deleteSpecs({ root: dirname(realPath(specsDir)), specs, prBodies: [], live: liveSpecPaths(run), mode: 'delete', apply: true, log })` 로 지운다. `run` 은 `--run`, 없으면 null 이다
3. 배포 판정은 `deploy` 값으로 바꾼다. `--deploy-workflow` 가 없으면 `none`, 있으면 `success`, `failure`, `timeout` 이다
4. `after-deploy` 를 낸다. 입력은 `pr`, `merge_commit`, `deploy`, `last_of_task`(`--complete`)다. legacy 는 `--complete` 이고, 업무 완료 명령이 있고, `deploy` 가 `success` 나 `none` 이고, 업무 번호를 찾았을 때만 넘긴다. `{ key: '--complete-cmd', argv: shSplit(명령).map((part) => part.replaceAll('{number}', 번호)), env: {} }` 다
5. `deploy` 가 `failure` 면 원본 문구 `배포 실패 <SHA>`, `timeout` 이면 `배포를 기다리다 시간이 지났다` 로 보드를 건드리지 않고 `FINISH-FAIL` 이다
6. 업무 번호를 찾지 못하면 원본처럼 `PR 제목에서 업무 번호를 찾지 못했다: <제목>` 을 문제로 남긴다. legacy 가 실패하거나 시간을 넘기면 `업무 <번호> 완료 명령이 실패했다(종료 코드 <코드>)`, 핸들러가 실패하면 `after-deploy 핸들러가 실패했다` 를 문제로 남긴다. 이 문제들이 있어도 보드 done 은 원본처럼 그대로 돌고 마지막 줄이 `FINISH-FAIL` 이다

### 3. `orch/scripts/merge-with-finish.ts`

- 옵션 해석은 `lib/queue-options.ts` 의 `QUEUE_VALUE_OPTIONS` 를 쓴다
- `!` 가 붙은 PR 은 `!` 를 떼기 전에 `--last-of-task <PR>` 로 머지 큐 인자 앞에 하나씩 넣는다
- `queue` 절을 명령줄 옵션으로 바꾸는 규칙(원본 `QUEUE_KEYS`, `def queue_defaults`)은 그대로 옮긴다. 그래서 `queue.before` 는 머지 큐의 legacy `--before` 가 된다
- 큐를 걸기 전에, 설정 `finish.complete_cmd` 나 `--finish-arg` 의 `--complete-cmd` 와 `<orch 루트>/hooks/after-deploy.ts` 가 함께 있으면 사용법 오류(2)로 멈춘다. 마무리도 머지 큐도 걸지 않는다
- 마무리 pid 확인은 `lib/process.ts` 의 `alive` 다

### 4. 테스트를 옮긴다

`orch/tests/merge-with-finish.spec.ts`, `orch/tests/finish-pr.spec.ts` 를 만든다. 표의 원본 테스트 사례를 모두 옮기고 원본 파일을 지운다.
원본이 importlib 로 부르던 함수 사례(`parse_queue_spec`, `split_args`, `deploy_verdict`, `extract_task_number`, `spec_branches`, `worktree_for_branch`)는 가짜 머지 큐, 가짜 gh 와 git 으로 명령을 돌려 같은 판정을 본다. `complete_argv` 는 작업 항목 1 의 `shSplit` 사례로 옮겼다. `test_value_options_match_merge_queue` 는 옮기지 않는다. 대신 `QUEUE_VALUE_OPTIONS` 의 옵션마다 숫자 값을 주면 그 값이 PR 로 읽히지 않고 머지 큐에 그대로 넘어가는 사례를 둔다.

`orch/tests/test_board_sync.py` 의 `DefaultBoardBinTest` 에서 `finish-pr.py` 를 뺀다. 대신 `finish-pr.spec.ts` 에서 `BOARD_BIN` 없이 `--board` 와 `--board-id` 로 돌려 임시 보드 파일의 항목이 done 으로 바뀌는지 본다. 저장소의 `work-board/bin/board.py` 를 실제로 부른다.

더할 사례:

- `merge-with-finish`: `449!` 면 머지 큐가 `--last-of-task 449` 와 `449` 를 받는다
- `merge-with-finish`: `MERGE_QUEUE` 를 바꾸지 않고 가짜 gh 로 돌린다. `queue.before` 와 `hooks/before-merge.ts` 가 함께 있으면 종료 코드 2 이고 gh 머지 호출이 없다
- `merge-with-finish`: 같은 방법으로 `queue.after_merged` 만 있으면 `DEPRECATED --after-merged → hooks/after-queue.ts` 줄과 함께 옛 명령이 `MERGED_PRS` 를 받는다
- `merge-with-finish`: `finish.complete_cmd` 와 `hooks/after-deploy.ts` 가 함께 있으면 종료 코드 2 이고 머지 큐 대역이 불리지 않는다
- `merge-with-finish`: EPERM 을 내는 pid 의 마무리는 다시 걸지 않는다
- `finish-pr`: 같은 브랜치의 지시서를 살아 있는 dispatch 가 쓰면 `--complete` 에서도 남긴다. dispatch 목록 조회가 실패하면 남긴다
- `finish-pr`: `--specs-dir` 가 orch 루트 밖의 임시 폴더여도 그 브랜치의 지시서를 지운다
- `finish-pr`: `hooks/after-deploy.ts` 가 받은 `last_of_task` 와 `deploy`. 배포가 실패하면 `deploy: failure` 이고 보드가 바뀌지 않고 `FINISH-FAIL` 이다
- `finish-pr`: 배포가 끝나지 않으면 `deploy: timeout` 이고 보드가 바뀌지 않고 `FINISH-FAIL` 이다
- `finish-pr`: legacy 업무 완료는 `DEPRECATED --complete-cmd → hooks/after-deploy.ts` 줄과 함께 `{number}` 를 바꾼 argv 로 돈다. `--task-pattern '(?P<n>PROJ-[0-9]+)'` 도 번호를 뽑는다
- `finish-pr`: `hooks/after-deploy.ts` 가 1 이면 `HOOK-FAIL` 줄, 보드 done, `FINISH-FAIL` 이다
- `finish-pr`: 업무 완료 명령과 `hooks/after-deploy.ts` 가 함께 있으면 머지를 기다리지 않고 종료 코드 2 다

### 5. 문서

- `orch/README.md`: `scripts/merge-with-finish.py`, `scripts/finish-pr.py` 줄을 `.ts` 로 바꾼다. 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/merge-with-finish.py`, `scripts/finish-pr.py` 를 더한다
- `docs/data-schema.md` 「이벤트별 필드」: `after-deploy` 의 `deploy` 값에 `timeout` 을 더한다. 대응 표의 `finish.complete_cmd` 줄에 명령줄 `--complete-cmd`, `--task-pattern` 을 더한다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-py.spec.ts orch/tests/merge-with-finish.spec.ts orch/tests/finish-pr.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_board_sync.py
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md docs/data-schema.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/py.ts` | 수정 |
| `orch/scripts/merge-with-finish.ts` | 신규 |
| `orch/scripts/finish-pr.ts` | 신규 |
| `orch/scripts/merge-with-finish.py` | 수정 |
| `orch/scripts/finish-pr.py` | 수정 |
| `orch/tests/lib-py.spec.ts` | 수정 |
| `orch/tests/merge-with-finish.spec.ts` | 신규 |
| `orch/tests/finish-pr.spec.ts` | 신규 |
| `orch/tests/test_merge_with_finish.py` | 삭제 |
| `orch/tests/test_finish_pr.py` | 삭제 |
| `orch/tests/test_board_sync.py` | 수정 |
| `orch/README.md` | 수정 |
| `docs/data-schema.md` | 수정 |
