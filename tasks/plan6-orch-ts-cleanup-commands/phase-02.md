# Phase 02. 정리 명령을 옮기고 원격 브랜치 정리와 정리 이벤트를 더한다

**Execution profile**: deep

## 목표

`cleanup-sweep` 를 TypeScript 로 옮기고 `before-cleanup`, `after-cleanup` 을 낸다.
로컬 브랜치가 없어도 내 PR 의 원격 브랜치를 지우는 `--remote-branches` 를 더해, 직접 머지한 PR 과 다른 PR 에 합쳐 닫힌 PR 의 브랜치가 쌓이지 않게 한다.

**범위 외**: 상주 루프가 이 명령을 틱마다 부르는 일. 상주 루프 plan 이 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/cleanup-sweep.py` | `orch/scripts/cleanup-sweep.ts` | `orch/tests/test_cleanup_sweep.py` → `orch/tests/cleanup-sweep.spec.ts`, `orch/tests/test_cleanup_wait.py` → `orch/tests/cleanup-wait.spec.ts` |
| `orch/scripts/terminal_ownership.py` | 지운다. phase 01 의 `lib/ownership.ts` 가 대신한다 | `orch/tests/test_terminal_ownership.py` 를 지운다 |

옵션, dry-run 기본, 출력 줄(`남김`, `건너뜀`, `빈 셸을 닫았다`)은 원본 머리 주석과 같다. PR #190 의 판정(모든 Run 의 소유 상태를 읽어 한 번 정리에 한 번만 읽는다)도 같다.
지시서 삭제는 `lib/spec.ts` 의 `deleteSpecs` 다. 원본의 `def delete_specs` 가 하던 판정(살아 있는 지시서 목록, 그 목록을 읽지 못하면 지우지 않음)을 그 함수가 이미 한다.
「내 PR」 판정은 `lib/gh.ts` 의 `isOwnPr` 과 `config.json` 의 `pipeline.authors` 다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `cleanup-sweep.py` 에 둔다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-cleanup`, `after-cleanup` 줄과 「운영 공백을 막는 곳」 의 원격 브랜치 줄, `docs/data-schema.md`, `docs/code-architecture.md` 의 「공통 안전 장치」

## 의도 메모

- `--remote-branches` 가 지우는 조건: 작성자가 내 목록에 있는 PR 이고, MERGED 이거나, CLOSED 이면서 head 커밋이 base 에 들어 있다. 열린 PR 의 base 인 브랜치, `release/*`, fork 의 브랜치는 지우지 않는다. 머지 큐가 원격 브랜치를 지우는 조건과 같은 보호를 쓴다.
- CLOSED 이고 head 가 base 에 없으면 버린 작업일 수 있어 지우지 않는다.
- worker 터미널은 `worker_done` 뒤에도 그 PR 이 머지되거나 닫힐 때까지 남긴다(사용자 결정 2026-10-24). 충돌과 리뷰 반영을 같은 worker 가 이어 받기 위해서다. 원본은 머지된 PR 만 정리한다. 새 명령은 머지 없이 CLOSED 가 된 내 PR 의 worker 터미널도 닫고 dispatch 를 반납한다. 그 워크트리는 원본의 지우기 조건(미커밋 변경, 원격에 없는 커밋)을 그대로 따른다.
- `before-cleanup` 이 거부한 워크트리는 `남김: 저장소 핸들러 거부` 로 남기고 다음 항목으로 간다.

## 작업 항목

### 1. `cleanup-sweep.ts`

원본 판정을 옮기고 `--remote-branches` 를 더한다. 그 판정은 위 「의도 메모」 와 같다. `--apply` 가 없으면 지울 것만 보인다.

### 2. 이벤트

| 이벤트 | 시점 |
| --- | --- |
| `before-cleanup` | 워크트리 하나를 지우기 직전. 거부나 실패면 그 워크트리를 남긴다 |
| `after-cleanup` | 저장소 하나의 정리가 끝난 뒤. `removed` 와 `skipped` 를 넘긴다. dry-run 이면 내지 않는다 |

### 3. 테스트를 옮긴다

`orch/tests/cleanup-sweep.spec.ts`, `orch/tests/cleanup-wait.spec.ts` 를 만들고 원본 사례를 모두 옮긴 뒤 원본과 `test_terminal_ownership.py` 를 지운다.
더할 사례: 머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널을 닫는다. 열린 PR 의 끝난 dispatch 터미널은 남긴다. `--remote-branches` 가 내 MERGED PR 의 원격 브랜치를 지운다. 다른 작성자의 PR, 열린 PR 의 base 인 브랜치, head 가 base 에 없는 CLOSED PR 은 남긴다. `hooks/before-cleanup.ts` 가 10 이면 그 워크트리가 남는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/cleanup-sweep.spec.ts orch/tests/cleanup-wait.spec.ts orch/tests/ownership.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/cleanup-sweep.ts` | 신규 |
| `orch/scripts/cleanup-sweep.py` | 수정 |
| `orch/scripts/terminal_ownership.py` | 삭제 |
| `orch/tests/cleanup-sweep.spec.ts` | 신규 |
| `orch/tests/cleanup-wait.spec.ts` | 신규 |
| `orch/tests/test_cleanup_sweep.py` | 삭제 |
| `orch/tests/test_cleanup_wait.py` | 삭제 |
| `orch/tests/test_terminal_ownership.py` | 삭제 |
