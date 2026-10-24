# Phase 02. 정리 명령을 동작 그대로 옮기고 정리 이벤트를 낸다

**Execution profile**: deep

## 목표

`cleanup-sweep` 를 판정과 출력을 바꾸지 않고 TypeScript 로 옮기고 `before-cleanup`, `after-cleanup` 을 낸다. `terminal_ownership.py` 를 지운다.
동작을 더하는 phase 03 의 회귀 원인을 이 이전과 가르기 위해 따로 커밋한다.

**범위 외**: `--remote-branches` 와 머지 없이 CLOSED 가 된 PR 의 터미널 정리(phase 03). 상주 루프가 이 명령을 틱마다 부르는 일은 상주 루프 plan 이 한다. 문서의 실행 예시(`python3 "$SKILL_DIR/scripts/cleanup-sweep.py"`)를 `.ts` 로 바꾸는 일은 phase 06 이 한다.

## 컨텍스트

시작 조건: `orch/scripts/lib/ownership.ts` 와 `orch/scripts/remove-worktree.ts` 가 있다. 없으면 `PHASE_BLOCKED: phase 01 커밋 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/cleanup-sweep.py` | `orch/scripts/cleanup-sweep.ts` | `orch/tests/test_cleanup_sweep.py` → `orch/tests/cleanup-sweep.spec.ts`, `orch/tests/test_cleanup_wait.py` → `orch/tests/cleanup-wait.spec.ts` |
| `orch/scripts/terminal_ownership.py` | 지운다. phase 01 의 `lib/ownership.ts` 가 대신한다 | `orch/tests/test_terminal_ownership.py` 를 지운다. 사례는 phase 01 의 `ownership.spec.ts` 가 옮겼다 |

옵션, dry-run 기본, 출력 줄(`남김`, `건너뜀`, `빈 셸을 닫았다`, `원격 브랜치 …`), 종료 코드(0, 2)는 원본 머리 주석과 같다. 머리 주석은 원본을 옮기되 `terminal_ownership.all_workers` 는 `lib/ownership.ts` 로, `live_specs.py` 는 `lib/spec.ts` 의 `liveSpecPaths` 로, `orch_paths.py 「옛 구조」` 는 `lib/paths.ts` 의 `requireMigrated` 로, `remove-worktree.py` 는 `remove-worktree.ts` 로 이름을 바꾼다.
PR #190 의 판정(모든 Run 의 소유 상태를 한 번 정리에 한 번만 읽는다)도 같다. 워크트리 지우기는 `lib/proc.ts` 의 `scriptCommand` 로 같은 폴더의 `remove-worktree.ts` 를 부른다.

지시서와 PR 본문 삭제는 `lib/spec.ts` 의 `specCandidates` 와 `deleteSpecs` 다. 원본 `def delete_specs` 의 이름 규칙을 `specCandidates` 가, 살아 있는 지시서 판정을 `deleteSpecs` 가 이미 한다.
`deleteSpecs` 의 `root` 는 `finish-pr.ts` 의 `deleteBranchSpecs` 처럼 지시서 폴더 실경로의 부모(`dirname(realPath(specsDir))`)다. `deleteSpecs` 는 root 밖의 파일을 남기는데, 원본은 지시서 폴더가 orch 루트 밖이어도 지웠다. 지시서와 PR 본문은 그 부모 아래에 있으므로 늘 root 안이다. `mode` 는 `'delete'`, `apply` 는 `--apply` 다. log 에는 원본처럼 두 칸 들여쓰기를 붙인다.
남기는 이유 문장은 `lib/spec.ts` 의 것을 그대로 쓴다. 원본과 다른 곳은 아래 둘이다. phase 06 의 CHANGELOG 호환성 절이 적는다.

- 목록을 읽지 못했을 때 원본은 `살아 있는 dispatch 의 지시서 목록을 읽지 못했다`, 새 문장은 `살아 있는 지시서 목록을 읽지 못했다` 다
- 원본은 목록을 읽지 못해도 PR 본문을 지웠다. `deleteSpecs` 는 그때 PR 본문도 남긴다(`PR 본문을 남긴다 …`)

이벤트 실행기는 `lib/events.ts` 의 `fire(event, input, ctx)` 다. 입력 필드는 `docs/data-schema.md` 「이벤트별 필드」 의 `before-cleanup`, `after-cleanup` 이다. `ctx` 는 `{ repo: <주 checkout>, base: <그 저장소의 기준 브랜치>, run: --run 값 또는 null }` 이다.
`pr` 객체(`number`, `title`, `branch`, `head`, `author`, `draft`, `url`)를 채우려고 PR 찾기의 `gh pr list --head` 필드에 `title,author,isDraft,url` 을 더한다. 판정에는 쓰지 않는다.

이 phase 는 기본 정리 명령을 부르는 두 명령의 경로도 바꾼다.

- `orch/scripts/finish-pr.ts`: `cleanupWorker` 의 기본 `join(HERE, 'cleanup-sweep.py')` 를 `cleanup-sweep.ts` 로 바꾼다. 머리 주석(10, 12, 48, 49행)과 `정리 남음: … cleanup-sweep.py 출력을 본다` 줄의 이름도 `.ts` 로 바꾼다
- `orch/scripts/merge_queue.ts`: 기본 `` `${HERE}/cleanup-sweep.py` `` 를 `cleanup-sweep.ts` 로, `경고: cleanup-sweep.py 가 실패했다` 줄과 머리 주석(123, 125, 127행)의 이름을 `.ts` 로 바꾼다. 852행 주석의 `remove-worktree.py` 도 `remove-worktree.ts` 로 바꾼다

두 명령의 테스트는 `CLEANUP_SWEEP` 로 가짜 정리 명령을 주므로 기본값이 바뀌어도 그대로 통과해야 한다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/ci-ready.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 를 부른다. node 22.18 미만이면 `NODE-TOO-OLD` 줄과 종료 코드 127 로 멈추고, 아니면 stderr 에 `DEPRECATED` 줄을 내고 같은 이름의 `.ts` 로 exec 한다(`orch/scripts/ts_shim.py` 머리 주석). `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `cleanup-sweep.py` 다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다. 같은 이름의 `.ts` 가 있는 `.py` 는 대조하지 않는다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-cleanup`, `after-cleanup` 줄, `docs/data-schema.md` 의 「종료 코드」 와 「이벤트별 필드」, `docs/code-architecture.md` 의 「공통 안전 장치」 의 지시서 삭제 줄과 「배치」 의 명령끼리 import 하지 않는 규칙

## 의도 메모

- `before-cleanup` 은 그 워크트리가 지울 대상으로 판정되고(소유, 미커밋 변경, 원격에 없는 커밋 확인을 통과) `정리` 줄 직후, 그 dispatch 의 터미널을 닫기(원본 `close_terminals`) 앞에서 낸다. 원본은 그보다 앞에서 빈 셸 터미널을 닫는데(`빈 셸을 닫았다`), 그 순서는 바꾸지 않는다. 터미널을 닫고 dispatch 를 반납한 뒤에 거부되면 터미널 없는 워크트리가 남는다. 입력의 `worker` 는 그 경로의 worker 행 가운데 `dispatchId` 가 있는 첫 행이고, 없으면 넣지 않는다(`docs/data-schema.md` 의 「있으면」).
- `before-cleanup` 이 거부(10)하면 `HOOK-REJECT` 줄에 더해 `남김 <경로>: 저장소 핸들러 거부` 를 내고 다음 항목으로 간다. 실패나 시간 초과도 `HOOK-FAIL` 줄과 같은 `남김` 줄로 그 워크트리를 남긴다(`docs/flow.md` 「갈래」 의 거부할 수 있는 이벤트 줄).
- 브랜치가 없는 저장소 밖 detached 워크트리와 워크트리 없는 로컬 브랜치에는 `before-cleanup` 을 내지 않는다. 입력의 `worktree` 와 `branch` 를 채울 수 없다.
- `after-cleanup` 핸들러의 실패와 시간 초과는 `HOOK-FAIL` 줄만 내고 종료 코드에 반영하지 않는다. cleanup-sweep 의 종료 코드는 0 과 2(사용법 오류)뿐이라, 알림 실패를 2 로 내면 부르는 쪽(머지 큐, finish-pr)이 사용법 오류로 읽는다. `docs/flow.md` 「갈래」 의 반영하지 않는 명령 목록에 정리 명령을 더한다.
- `--apply` 가 없으면 두 이벤트 모두 내지 않는다. 핸들러가 바깥에 부작용을 낼 수 있어서다(`ci-ready` 의 `--dry-run` 과 같다).

## 작업 항목

### 1. `orch/scripts/cleanup-sweep.ts` 와 shim

원본 판정과 출력을 그대로 옮긴다. `--wait`, `--poll-interval` 의 기본(5초, 1초)과 검사도 같다. `cleanup-sweep.py` 를 위 꼴의 shim 으로 바꾼다.

### 2. 이벤트

| 이벤트 | 시점 | 입력 |
| --- | --- | --- |
| `before-cleanup` | 위 「의도 메모」 의 자리. `--apply` 일 때만 | `worktree`(절대경로), `branch`, `pr`(찾았으면), `worker`(그 경로의 dispatch 를 찾았으면 `task`, `dispatch`, `terminal`, `worktree`, `spec`) |
| `after-cleanup` | `--repo` 하나의 정리가 끝난 뒤. `--apply` 일 때만 | `removed`(그 저장소에서 지운 워크트리 경로 목록), `skipped`(그 저장소에서 `남김` 이나 `건너뜀` 으로 남긴 워크트리의 `{ path, reason }` 목록) |

### 3. 지울 Python 과 함께 바꿀 명령

- `orch/scripts/terminal_ownership.py` 를 지운다. 이 phase 뒤로 import 하거나 부르는 쪽이 없다
- 위 「컨텍스트」 대로 `finish-pr.ts` 와 `merge_queue.ts` 의 기본 정리 명령과 주석을 바꾼다

### 4. 문서

- `docs/flow.md` 「갈래」 의 「나머지 이벤트의 핸들러가 실패하거나 시간을 넘긴다」 줄: 반영하지 않는 명령 목록에 정리 명령(`cleanup-sweep`)을 더하고 위 의도 메모의 이유를 한 문장으로 적는다
- `orch/README.md`: `scripts/cleanup-sweep.py` 줄을 `scripts/cleanup-sweep.ts` 로 바꾸고 `before-cleanup`, `after-cleanup` 을 낸다는 문장을 더한다. `scripts/terminal_ownership.py` 줄을 지운다. `scripts/live_specs.py` 줄의 「`cleanup-sweep.py` 와 `handoff-cleanup.py` 가 import 한다」 를 「`handoff-cleanup.py` 가 import 한다」 로 바꾼다. 「옛 경로. 다음 major 에서 지운다」 줄에 `scripts/cleanup-sweep.py` 를 더한다. 테스트 절의 「`cleanup-sweep.py` 테스트는 …」 를 `cleanup-sweep.spec.ts` 로 바꾼다
- `orch/references/cleanup.md`: 「`terminal_ownership.py` 머리 주석이 소유한다」 두 곳(5, 8행)을 `scripts/lib/ownership.ts` 로 바꾼다. `cleanup-sweep.py` 머리 주석을 소유자로 가리키는 두 문장(13행의 「넘겨받은 터미널」 문장과 231행)을 `cleanup-sweep.ts` 로 바꾼다. 그 밖의 명령 이름과 실행 예시는 phase 06 이 바꾼다

### 5. 테스트

`orch/tests/cleanup-sweep.spec.ts`, `orch/tests/cleanup-wait.spec.ts` 를 만들고 `test_cleanup_sweep.py`, `test_cleanup_wait.py` 의 사례를 모두 옮긴다. 원본 두 파일과 `test_terminal_ownership.py` 를 지운다. 대기는 원본처럼 `--wait 0.01 --poll-interval 0.01` 로 줄인다.

더할 사례(핸들러가 받은 입력은 핸들러가 stdin 을 파일에 적게 해서 본다):

- `hooks/before-cleanup.ts` 가 10 이면 `HOOK-REJECT` 줄과 `남김 <경로>: 저장소 핸들러 거부` 가 나고 워크트리와 그 터미널이 남는다. `remove-worktree.ts` 와 `orca terminal close` 를 부르지 않는다
- `hooks/before-cleanup.ts` 가 1 이면 `HOOK-FAIL` 줄과 같은 `남김` 줄이 나고 워크트리가 남는다
- `before-cleanup` 입력의 `worktree`, `branch`, `pr.number` 가 지운 워크트리의 값이다
- `after-cleanup` 입력의 `removed` 에 지운 워크트리 경로가, `skipped` 에 미커밋 변경으로 남긴 워크트리의 경로와 이유가 든다
- `--apply` 가 없으면 두 핸들러 모두 불리지 않는다(핸들러가 남기는 파일이 생기지 않는다)
- `--specs-dir` 를 주고 살아 있는 지시서 목록을 읽지 못하면 지시서와 PR 본문이 모두 남고 `살아 있는 지시서 목록을 읽지 못했다` 줄이 난다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/cleanup-sweep.spec.ts orch/tests/cleanup-wait.spec.ts orch/tests/ownership.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 orch/tests/finish-pr.spec.ts orch/tests/merge-queue.spec.ts orch/tests/merge-with-finish.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
! test -e orch/scripts/terminal_ownership.py
python3 korean-check/scripts/korean-style-check.py orch/README.md orch/references/cleanup.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/cleanup-sweep.ts` | 신규 |
| `orch/scripts/cleanup-sweep.py` | 수정 |
| `orch/scripts/terminal_ownership.py` | 삭제 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/tests/cleanup-sweep.spec.ts` | 신규 |
| `orch/tests/cleanup-wait.spec.ts` | 신규 |
| `orch/tests/test_cleanup_sweep.py` | 삭제 |
| `orch/tests/test_cleanup_wait.py` | 삭제 |
| `orch/tests/test_terminal_ownership.py` | 삭제 |
| `orch/README.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `docs/flow.md` | 수정 |
