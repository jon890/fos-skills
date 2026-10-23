# Phase 02. 지시서와 띄우기 명령을 옮기고 before-launch, worker-launched 를 낸다

**Execution profile**: deep

## 목표

지시서 검사부터 worker 를 띄우기까지의 명령을 TypeScript 로 옮긴다. `launch-worker` 가 워크트리를 만든 뒤 `before-launch` 를, `LAUNCHED` 뒤 `worker-launched` 를 낸다.

**범위 외**: `send-to-worker` 와 `nudge-worker`(phase 03). 그 명령은 아직 Python 이고 `launch-worker.py` 경로를 부른다. 그래서 이 phase 의 shim 이 필요하다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/spec-line.py` | `orch/scripts/spec-line.ts` | `orch/tests/test_spec_line.py` → `orch/tests/spec-line.spec.ts` |
| `orch/scripts/spec-lint.py` | `orch/scripts/spec-lint.ts` | `orch/tests/test_spec_lint.py` → `orch/tests/spec-lint.spec.ts` |
| `orch/scripts/make-worktree.py` | `orch/scripts/make-worktree.ts` | `orch/tests/test_make_worktree.py` → `orch/tests/make-worktree.spec.ts` |
| `orch/scripts/worktree-deny.py` | `orch/scripts/worktree-deny.ts` | `make-worktree.spec.ts` 가 함께 다룬다 |
| `orch/scripts/orca_repo.py`(모듈) | `lib/orca.ts` 의 `repoVisibility(repo)` | `orch/tests/lib-orca.spec.ts` 에 사례를 더한다 |
| `orch/scripts/launch-worker.py` | `orch/scripts/launch-worker.ts` | `orch/tests/test_launch_send.py` 의 `LaunchWorkerTest` → `orch/tests/launch-worker.spec.ts` |

공통 모듈: `lib/spec.ts`(`branchesOf`, `permissionsOf`), `lib/paths.ts`, `lib/orca.ts`, `lib/git.ts`, `lib/proc.ts`(`scriptCommand`), `lib/events.ts`(`fire`).
명령 이름, 옵션, 종료 코드, 출력 줄은 각 원본 머리 주석과 같게 둔다. 환경 변수(`ORCA`, `SPEC_LINE`, `MAKE_WORKTREE`, `LAUNCH_POLL`, `LAUNCH_WT_WAIT`, `LAUNCH_WT_POLL`)도 같다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `spec-line.py`, `spec-lint.py`, `make-worktree.py`, `worktree-deny.py`, `launch-worker.py` 에 둔다. `orca_repo.py` 는 모듈이라 import 하는 쪽이 모두 옮겨지므로 지운다.

이벤트 입력 필드는 `docs/data-schema.md` 의 「이벤트별 필드」 표가 소유한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-launch`, `worker-launched` 줄, `docs/data-schema.md`, `docs/code-architecture.md` 의 「실행 규칙」

## 의도 메모

- `launch-worker.py` 에는 이유 주석이 없는 함정이 셋 있다. 결과 JSON 의 키 후보를 여럿 읽는 것(`jget` 의 `|`), `selector_not_found` 에서 다시 부르는 것, `worktree_creating` 에서 abandon 하고 한 번 다시 띄우는 것이다. 옮기면서 각 자리에 왜 그렇게 하는지 주석을 단다. 이유를 모르면 `git log -S` 로 그 줄을 넣은 커밋을 찾아 읽는다.
- `before-launch` 가 거부하면 워크트리는 남기고 `worker-start` 를 부르지 않는다. 종료 코드 1 과 `HOOK-REJECT` 줄이다. 워크트리를 지우면 지시서의 브랜치 이름을 다시 쓸 때 사람이 판단할 근거가 사라진다.
- `허락:` 줄은 늘 요구한다. 지시서 문서와 맞춘 규칙이다.

## 작업 항목

### 1. 위 표의 명령과 모듈을 옮긴다

### 2. `launch-worker.ts` 에서 이벤트를 낸다

- 워크트리를 만들거나 확인한 뒤, `worker-start` 전에 `fire('before-launch', { worker, branch, agent, model, effort })`
- `LAUNCHED` 를 낸 뒤 `fire('worker-launched', ...)`. 실패해도 종료 코드는 0 이고 `HOOK-FAIL` 줄만 남긴다

`agent`, `model`, `effort` 는 `--` 뒤 worker 인자에서 읽는다. 없으면 null 이다.

### 3. 테스트를 옮긴다

위 표의 테스트 사례를 모두 옮기고 원본 Python 테스트(`test_launch_send.py` 는 `LaunchWorkerTest` 클래스만)를 지운다.
`launch-worker.spec.ts` 에 더할 사례: 저장소에 `.orch/hooks/before-launch.ts` 가 10 으로 끝나면 `worker-start` 가 불리지 않고 종료 코드 1, 핸들러가 없으면 지금과 같은 호출 순서.
shim 사례 하나: `python3 orch/scripts/launch-worker.py --help` 가 `DEPRECATED` 줄과 함께 `.ts` 의 사용법을 낸다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/spec-line.spec.ts orch/tests/spec-lint.spec.ts orch/tests/make-worktree.spec.ts orch/tests/launch-worker.spec.ts orch/tests/lib-orca.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_launch_send.py
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/spec-line.ts` | 신규 |
| `orch/scripts/spec-lint.ts` | 신규 |
| `orch/scripts/make-worktree.ts` | 신규 |
| `orch/scripts/worktree-deny.ts` | 신규 |
| `orch/scripts/launch-worker.ts` | 신규 |
| `orch/scripts/spec-line.py` | 수정 |
| `orch/scripts/spec-lint.py` | 수정 |
| `orch/scripts/make-worktree.py` | 수정 |
| `orch/scripts/worktree-deny.py` | 수정 |
| `orch/scripts/launch-worker.py` | 수정 |
| `orch/scripts/orca_repo.py` | 삭제 |
| `orch/scripts/lib/orca.ts` | 수정 |
| `orch/tests/spec-line.spec.ts` | 신규 |
| `orch/tests/spec-lint.spec.ts` | 신규 |
| `orch/tests/make-worktree.spec.ts` | 신규 |
| `orch/tests/launch-worker.spec.ts` | 신규 |
| `orch/tests/lib-orca.spec.ts` | 수정 |
| `orch/tests/test_spec_line.py` | 삭제 |
| `orch/tests/test_spec_lint.py` | 삭제 |
| `orch/tests/test_make_worktree.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 수정 |
