# Phase 02. 머지 큐를 옮기고 before-merge, verify-merged, after-merge, after-queue 를 낸다

**Execution profile**: deep

## 목표

`merge_queue` 를 TypeScript 로 옮긴다. 머지 전 명령, 합친 사본 검사, 머지 뒤 명령을 이벤트 실행기로 돌리고, 머지를 확인한 자리에서 쌓인 PR 의 base 를 옮기고 원격 브랜치를 지운다.

**범위 외**: `merge-with-finish` 와 `finish-pr`(phase 03). 두 명령은 아직 Python 이고 `merge_queue.py` 경로를 부르므로 shim 이 필요하다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/merge_queue.py` | `orch/scripts/merge_queue.ts` | `orch/tests/test_scripts.py` 의 `MergeQueueTest`, `MergeQueueOverlapTest`, `CiLookupTest` → `orch/tests/merge-queue.spec.ts`, `orch/tests/merge-queue-overlap.spec.ts` |
| `orch/scripts/overlap_units.py` | shim 으로 바꾼다. 판정은 phase 01 의 `lib/overlap.ts` 와 `overlap_units.ts` 가 한다 | |
| `orch/scripts/merge-queue.sh` | 지운다. 약속한 제거 시점이 지났다(`orch/CHANGELOG.md` 에서 `merge-queue.sh` 를 찾는다) | |

옵션, 종료 코드, 출력 줄(`STOP`, `QUEUE-DONE`, `QUEUE-HELD`, `AFTER-MERGED-FAILED`, 판정 줄)은 원본 머리 주석과 같다. 원본은 `orca` 와 `gh` 를 고정해 부르는 곳이 있다. `lib/orca.ts`, `lib/gh.ts` 로 바꿔 환경 변수를 따르게 한다.
`test_scripts.py` 는 앞 phase 와 앞 plan 에서 다른 클래스를 옮겨, 이 phase 가 표의 클래스를 옮기면 `GoalProgressTest` 만 남는다. 그 클래스는 정리 명령 plan 이 옮긴다.

옛 설정 칸과 이벤트, 환경 변수와 입력 필드의 대응은 `docs/data-schema.md` 의 「이벤트별 필드」 아래 대응 표가 소유한다. 이벤트 실행기는 `lib/events.ts` 의 `fire` 이고, 옛 칸은 `legacy` 인자로 넘긴다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `merge_queue.py`, `overlap_units.py` 에 둔다. `overlap_units` 는 문서가 명령으로도 안내한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」, 「운영 공백을 막는 곳」 의 원격 브랜치 줄과 CI 재시작 줄, 「갈래」, `docs/data-schema.md`, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 명령줄 `--before`, `--verify-merged`, `--after-merged` 와 `queue` 절의 같은 키는 `legacy` 로 넘긴다. 같은 이벤트의 핸들러 파일과 함께 있으면 사용법 오류(종료 코드 2)로 큐를 시작하지 않는다. 큐 도중에 알게 되면 앞 PR 만 머지된 채 멈춘다.
- `PR번호:명령` 형식은 이벤트가 아니다. `before-merge` 핸들러(또는 legacy) 다음에 지금처럼 돈다.
- base 를 합치는 `update-branch` 는 `lib/gh.ts` 의 `updateBranch(…, 'merge-turn')` 만 부른다. 차례가 온 PR 에만 합치므로 다른 ready PR 의 CI 가 다시 시작되지 않는다.
- 쌓인 PR: 지우려는 브랜치를 base 로 둔 열린 PR 이 내 PR 이면, 머지한 PR 의 base 로 옮긴 뒤 브랜치를 지운다. 다른 사람의 PR 이 base 로 쓰면 원본처럼 지우지 않는다. GitHub 이 이미 base 를 옮긴 PR 은 건너뛴다.

## 작업 항목

### 1. `merge_queue.ts`

원본 판정을 옮기고 아래 자리에서 이벤트를 낸다.

| 이벤트 | 시점 | 거부와 실패 |
| --- | --- | --- |
| `before-merge` | PR HEAD 를 고정하고 체크를 확인한 뒤, 머지 직전 | 거부나 실패면 `STOP <PR> HOOK-REJECT` 또는 `STOP <PR> HOOK-FAIL` 로 멈춘다 |
| `verify-merged` | `--verify-merged-when` 이 맞아 합친 사본을 만든 뒤. 작업 디렉터리는 사본이다 | 거부나 실패면 원본의 검사 실패와 같이 멈춘다 |
| `after-merge` | PR 이 MERGED 인 것을 확인하고 원격 브랜치 처리를 마친 뒤 | 실패는 `HOOK-FAIL` 줄만 남기고 다음 PR 로 간다 |
| `after-queue` | 큐가 끝나거나 보류로 멈춘 뒤, 하나라도 머지했을 때 | 실패는 원본의 `AFTER-MERGED-FAILED` 와 같이 다룬다. 모두 머지했으면 종료 코드 3 |

`after-merge` 의 코어 동작은 위 「의도 메모」 의 쌓인 PR 옮기기와 원격 브랜치 삭제다. 입력의 `retargeted` 와 `remote_branch_deleted` 에 결과를 담는다.

### 2. 지우는 파일

`merge-queue.sh` 를 지운다. 문서에서 그 이름과 `overlap_units.py` 를 부르는 곳을 `git grep -n` 으로 찾아 `.ts` 로 바꾼다.

### 3. 테스트를 옮긴다

표의 사례를 모두 옮기고 `test_scripts.py` 에서 표의 클래스를 지운다.
더할 사례: `queue.before` 와 `hooks/before-merge.ts` 가 함께 있으면 종료 코드 2 와 gh 머지 호출 없음. `before-merge.ts` 가 10 이면 `STOP`. `queue.after_merged` 만 있으면 `DEPRECATED` 줄과 함께 옛 명령이 `MERGED_PRS` 를 받는다. 내 PR 이 머지한 브랜치를 base 로 두면 `gh pr edit --base` 가 불린 뒤 원격 브랜치가 지워진다. 다른 사람의 PR 이 base 로 두면 지우지 않는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/merge-queue.spec.ts orch/tests/merge-queue-overlap.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_scripts.py
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/merge_queue.ts` | 신규 |
| `orch/scripts/merge_queue.py` | 수정 |
| `orch/scripts/overlap_units.py` | 수정 |
| `orch/scripts/merge-queue.sh` | 삭제 |
| `orch/tests/merge-queue.spec.ts` | 신규 |
| `orch/tests/merge-queue-overlap.spec.ts` | 신규 |
| `orch/tests/test_scripts.py` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `orch/README.md` | 수정 |
