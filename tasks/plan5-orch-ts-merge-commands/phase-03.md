# Phase 03. 머지 뒤 마무리를 옮기고 after-deploy 를 내며 지시서 삭제를 한 경로로 모은다

**Execution profile**: deep

## 목표

`merge-with-finish` 와 `finish-pr` 를 TypeScript 로 옮긴다. 업무 완료를 `after-deploy` 이벤트로 바꾸고, `finish-pr` 의 지시서 삭제가 살아 있는 dispatch 를 확인하게 한다.

**범위 외**: `cleanup-sweep`(정리 명령 plan). `finish-pr.ts` 는 `cleanup-sweep.py` 를 `scriptCommand` 로 부른다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/merge-with-finish.py` | `orch/scripts/merge-with-finish.ts` | `orch/tests/test_merge_with_finish.py` → `orch/tests/merge-with-finish.spec.ts` |
| `orch/scripts/finish-pr.py` | `orch/scripts/finish-pr.ts` | `orch/tests/test_finish_pr.py` → `orch/tests/finish-pr.spec.ts` |

옵션, 종료 코드, 출력 줄(`FINISH-DONE`, `FINISH-FAIL`), `finish-<PR>.out` 과 `.pid` 파일은 원본 머리 주석과 같다. 설정 읽기는 `lib/config.ts` 다.
고칠 결함 둘(원본 위치는 `grep -n` 으로 찾는다):

| 결함 | 원본 | 고친 동작 |
| --- | --- | --- |
| `--complete` 일 때 `브랜치:` 가 같은 지시서를 살아 있는 dispatch 확인 없이 지운다 | `finish-pr.py` 의 `def delete_specs` | `lib/spec.ts` 의 `deleteSpecs` 에 `liveSpecPaths(run)` 결과를 넘긴다. 목록이 null 이면 지우지 않는다 |
| 마무리 pid 확인이 EPERM 을 죽음으로 본다 | `merge-with-finish.py` 의 `def finish_running` | `lib/process.ts` 의 `alive` 를 쓴다 |

업무 완료(`finish.complete_cmd`, `finish.task_pattern`)는 `after-deploy` 의 `legacy` 로 넘긴다. legacy 실행은 원본처럼 셸을 거치지 않고 `{number}` 를 바꾼 인자 목록으로 돈다. `lib/events.ts` 의 `legacy` 에 `args` 를 주는 경로다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `merge-with-finish.py`, `finish-pr.py` 에 둔다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `after-deploy` 줄과 「갈래」, `docs/data-schema.md`, `docs/code-architecture.md` 의 「공통 안전 장치」 의 지시서 삭제 줄

## 의도 메모

- `after-deploy` 는 배포가 실패해도 낸다(`deploy: failure`). 원본은 배포 실패면 업무 완료를 돌리지 않았다. legacy 실행도 `deploy` 가 `success` 나 `none` 이고 `last_of_task` 일 때만 돈다. 핸들러는 입력으로 스스로 판단한다.
- 보드 done 은 코어 동작이라 핸들러 뒤에 그대로 돈다.

## 작업 항목

### 1. 위 표의 명령을 옮기고 두 결함을 고친다

### 2. `after-deploy`

배포 확인이 끝난 뒤(배포 워크플로가 없으면 정리 직후) 낸다. 실패는 `HOOK-FAIL` 줄을 남기고 마지막 줄을 `FINISH-FAIL` 로 한다. 사람이 볼 실패라 조용히 넘기지 않는다.

### 3. 테스트를 옮긴다

`orch/tests/merge-with-finish.spec.ts`, `orch/tests/finish-pr.spec.ts` 를 만든다.
표의 사례를 모두 옮기고 원본을 지운다.
더할 사례: 같은 브랜치의 지시서를 살아 있는 dispatch 가 쓰면 `--complete` 에서도 남긴다. dispatch 목록 조회가 실패하면 남긴다. EPERM 을 내는 pid 의 마무리는 다시 걸지 않는다. `hooks/after-deploy.ts` 가 받은 `last_of_task` 와 `deploy`.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/merge-with-finish.spec.ts orch/tests/finish-pr.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/merge-with-finish.ts` | 신규 |
| `orch/scripts/finish-pr.ts` | 신규 |
| `orch/scripts/merge-with-finish.py` | 수정 |
| `orch/scripts/finish-pr.py` | 수정 |
| `orch/tests/merge-with-finish.spec.ts` | 신규 |
| `orch/tests/finish-pr.spec.ts` | 신규 |
| `orch/tests/test_merge_with_finish.py` | 삭제 |
| `orch/tests/test_finish_pr.py` | 삭제 |
