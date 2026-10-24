# Phase 02. 머지 큐를 동작 그대로 TypeScript 로 옮긴다

**Execution profile**: deep

## 목표

`merge_queue` 를 동작을 바꾸지 않고 TypeScript 로 옮기고, `merge_queue.py` 와 `overlap_units.py` 를 shim 으로 바꾼다. 이벤트를 더하는 다음 phase 의 회귀 원인을 이 이전과 가르기 위해 따로 커밋한다.

**범위 외**: `before-merge`, `verify-merged`, `after-merge`, `after-queue` 이벤트, 옛 칸의 legacy 실행, 쌓인 PR 의 base 옮기기(phase 03). `merge-with-finish` 와 `finish-pr` 의 이전(phase 04). 두 명령은 아직 Python 이고 `merge_queue.py` 경로를 부르므로 shim 이 필요하다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다(`orch/scripts/lib/overlap.ts` 와 `orch/scripts/overlap_units.ts` 가 있다).

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/merge_queue.py` | `orch/scripts/merge_queue.ts`. 값을 받는 옵션 목록은 `orch/scripts/lib/queue-options.ts` | `orch/tests/test_scripts.py` 의 `MergeQueueTest`, `CiLookupTest` → `orch/tests/merge-queue.spec.ts`, `MergeQueueOverlapTest` → `orch/tests/merge-queue-overlap.spec.ts` |
| `orch/scripts/overlap_units.py` | shim 으로 바꾼다. 판정은 phase 01 의 `lib/overlap.ts` 와 `overlap_units.ts` 가 한다 | `orch/tests/test_overlap_units.py` 는 지운다. 사례는 phase 01 의 `overlap-units.spec.ts` 가 옮겼다 |
| `orch/scripts/merge-queue.sh` | 지우지 않는다. 다음 major 까지 남긴다 | `MergeQueueTest.test_old_merge_queue_sh_path_still_runs_the_python_queue` → `merge-queue.spec.ts` |

옵션, 종료 코드(0, 1, 2, 3), 출력 줄(`STOP`, `QUEUE-DONE`, `QUEUE-HELD`, `AFTER-MERGED-FAILED`, 판정 줄)은 원본 머리 주석과 같다.
머지 전 명령, `--threads-cmd`, `--verify-merged`, `--after-merged`, `PR:명령` 은 이 phase 에서 원본처럼 `bash -c` 로 돈다. 이벤트 실행기로 옮기는 일은 phase 03 이 한다.
원본은 `gh` 를 이름으로 고정해 부른다. `lib/gh.ts` 의 `gh`, `ghJson` 으로 바꿔 `GH` 환경 변수를 따르게 한다. PATH 앞에 가짜 `gh` 를 두는 옮긴 테스트도 그대로 돈다.
`OVERLAP_UNITS`, `CLEANUP_SWEEP` 환경 변수와 기본 경로(`overlap_units.ts`, `cleanup-sweep.py`)는 `lib/proc.ts` 의 `scriptCommand` 로 부른다. 확장자로 인터프리터를 고르므로 테스트의 가짜 `overlap_units.py` 도 python3 로 돈다.

`lib/gh.ts` 의 `updateBranch` 는 `api -X PUT repos/<repo>/pulls/<n>/update-branch` 만 부른다. 원본은 PR URL 의 호스트를 `--hostname` 으로, 검사한 HEAD 를 `-f expected_head_sha=<SHA>` 로 넘긴다(`merge_queue.py` 의 `def api` 와 `def bring_up_to_date`). 옮길 사례가 둘을 단언한다. 그래서 이 phase 에서 `updateBranch` 에 호스트와 검사한 HEAD 인자를 더한다.

`orch/tests/test_merge_with_finish.py` 의 `test_value_options_match_merge_queue` 는 `merge_queue.py` 를 importlib 로 읽어 `VALUE_OPTIONS` 를 본다. shim 은 그 속성이 없으므로 이 phase 에서 고친다. 명령끼리는 import 하지 않으므로(docs/code-architecture.md 「배치」) 값을 받는 옵션 목록은 lib 공용 상수로 둔다.
`test_scripts.py` 는 이 phase 가 표의 클래스를 옮기면 `GoalProgressTest` 만 남는다. 그 클래스는 이 plan 의 범위가 아니다.

`merge-queue.sh` 는 `exec python3 "$(dirname "$0")/merge_queue.py" "$@"` 한 줄이다. 그 `.py` 가 shim 이 되므로 고치지 않아도 node 버전 확인을 거쳐 `merge_queue.ts` 로 넘어간다. 다른 저장소의 포장 스크립트가 이 경로를 부를 수 있어 지우지 않는다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/send-to-worker.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 만 부른다. node 22.18 확인(낮으면 `NODE-TOO-OLD` 줄과 종료 코드 127), stderr 의 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <대상>` 줄, exec 는 `orch/scripts/ts_shim.py` 가 맡는다. `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `merge_queue.py`, `overlap_units.py` 다. `overlap_units` 는 문서가 명령으로도 안내한다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다.

**근거 문서**: `docs/flow.md` 의 「운영 공백을 막는 곳」 의 CI 재시작 줄, `docs/code-architecture.md` 의 「배치」, 「공통 안전 장치」 의 머지와 base 합치기 줄, `docs/adr/010-orch-typescript.md`

## 의도 메모

- 동작을 바꾸는 일은 이 phase 에 넣지 않는다. 옮긴 테스트가 통과하는 것으로 이전이 맞는지 판정한다.
- base 를 합치는 `update-branch` 는 `updateBranch(…, 'merge-turn', { host, expectedHead })` 한 경로만 부른다. 차례가 온 PR 에만 합치므로 다른 ready PR 의 CI 가 다시 시작되지 않는다.

## 작업 항목

### 1. `orch/scripts/lib/gh.ts` 의 `updateBranch`

시그니처를 `updateBranch(repo, pr, reason, opts: { host?: string; expectedHead?: string } = {})` 로 바꾼다.
`host` 가 있으면 `api --hostname <host> -X PUT repos/<repo>/pulls/<n>/update-branch`, `expectedHead` 가 있으면 끝에 `-f expected_head_sha=<SHA>` 를 붙인다. 인자 순서는 원본과 같다. `behind-draft` 의 draft 확인은 그대로다.
`orch/tests/lib-gh.spec.ts` 에 `host` 와 `expectedHead` 를 준 argv 와 주지 않은 argv 사례를 더한다.

### 2. `orch/scripts/lib/queue-options.ts`

`export const QUEUE_VALUE_OPTIONS: readonly string[]` 에 원본 `merge_queue.py` 의 `VALUE_OPTIONS` 를 옮긴다. 머지 큐가 값을 받는 옵션이고, 머리 주석에 「`merge_queue.ts` 와 `merge-with-finish` 가 함께 import 한다. 바꾸면 값이 숫자여도 PR 번호로 읽지 않는 판정이 함께 바뀐다」 를 적는다.

### 3. `orch/scripts/merge_queue.ts`

원본 판정과 출력을 옮긴다. 옵션 해석은 `QUEUE_VALUE_OPTIONS` 를 쓴다. `bring_up_to_date` 의 base 합치기는 작업 항목 1 의 `updateBranch` 에 PR URL 의 호스트와 고정한 HEAD 를 넘긴다.
pid 생존 확인(원본 `def pid_alive`)은 `lib/process.ts` 의 `alive` 를 쓴다. SIGTERM 이면 원본처럼 사본을 지우고 143 으로 끝난다.

### 4. shim 과 옛 경로

- `merge_queue.py`, `overlap_units.py` 를 위 꼴의 shim 으로 바꾼다
- `merge-queue.sh` 의 둘째 줄 주석을 「다음 major 에서 지운다. `merge_queue.py` shim 을 거쳐 `merge_queue.ts` 로 넘긴다」 로 바꾼다. exec 줄은 그대로 둔다

### 5. `orch/tests/test_merge_with_finish.py` 의 옵션 대조

`test_value_options_match_merge_queue` 가 `merge_queue.py` 대신 `lib/queue-options.ts` 를 본다. `node --disable-warning=ExperimentalWarning` 으로 그 파일을 import 해 `QUEUE_VALUE_OPTIONS` 를 JSON 으로 받아 `mwf.VALUE_OPTIONS` 와 집합으로 비교한다. node 를 찾지 못하면 실패한다(건너뛰지 않는다).

### 6. 문서

- `orch/README.md`: `scripts/merge_queue.py` 줄을 `scripts/merge_queue.ts` 로 바꾸고 판정 소유자를 `scripts/overlap_units.ts` 로 고친다. `scripts/merge-queue.sh` 줄을 「옛 경로. 다음 major 에서 지운다. `merge_queue.py` 를 거쳐 `merge_queue.ts` 로 넘긴다」 로 고친다. 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/merge_queue.py`, `scripts/overlap_units.py` 를 더한다
- `orch/references/cleanup.md`: 「`merge_queue.py` 와 `overlap_units.py` 머리 주석이 소유한다」 를 `.ts` 이름으로 바꾼다. 실행 예시는 phase 05 가 바꾼다
- `docs/code-architecture.md` 「배치」: `orch/scripts/lib/queue-options.ts` 줄(머지 큐가 값을 받는 옵션 목록. `merge_queue` 와 `merge-with-finish` 가 함께 쓴다)을 더한다

### 7. 테스트를 옮긴다

`orch/tests/merge-queue.spec.ts`, `orch/tests/merge-queue-overlap.spec.ts` 를 만든다. 표의 클래스 사례를 모두 옮기고 `test_scripts.py` 에서 그 클래스와 그 클래스만 쓰던 helper 를 지운다. `test_overlap_units.py` 를 지운다.
옛 경로 사례는 `merge-queue.sh` 가 실행 가능하고, exec 줄이 그대로이며, 다른 디렉터리에서 불러도 `QUEUE-DONE` 이고, 인자 없이 부르면 종료 코드 2 인 것을 본다.
`--require-up-to-date` 사례가 `api --hostname <호스트> -X PUT repos/owner/repo/pulls/1/update-branch` 와 `expected_head_sha=<검사한 HEAD>` 를 단언하는 것을 그대로 옮긴다.
`CiLookupTest` 는 `orch/scripts/` 의 `.py`, `.sh` 만 훑는다. 옮긴 사례는 `.ts` 와 `lib/` 아래 `.ts` 도 본다. 명령이 `.ts` 로 옮겨 가면 원본 범위로는 아무것도 보지 않게 되기 때문이다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-gh.spec.ts orch/tests/merge-queue.spec.ts orch/tests/merge-queue-overlap.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_scripts.py orch/tests/test_merge_with_finish.py
python3 scripts/run-orch-tests.py --jobs 4
python3 korean-check/scripts/korean-style-check.py orch/README.md orch/references/cleanup.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/gh.ts` | 수정 |
| `orch/scripts/lib/queue-options.ts` | 신규 |
| `orch/scripts/merge_queue.ts` | 신규 |
| `orch/scripts/merge_queue.py` | 수정 |
| `orch/scripts/overlap_units.py` | 수정 |
| `orch/scripts/merge-queue.sh` | 수정 |
| `orch/tests/lib-gh.spec.ts` | 수정 |
| `orch/tests/merge-queue.spec.ts` | 신규 |
| `orch/tests/merge-queue-overlap.spec.ts` | 신규 |
| `orch/tests/fixtures/merge-queue-fakes.ts` | 신규 |
| `orch/tests/test_scripts.py` | 수정 |
| `orch/tests/test_overlap_units.py` | 삭제 |
| `orch/tests/test_merge_with_finish.py` | 수정 |
| `orch/README.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
