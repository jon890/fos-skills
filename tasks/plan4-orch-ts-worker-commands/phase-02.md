# Phase 02. 지시서와 띄우기 명령을 옮기고 before-launch, worker-launched 를 낸다

**Execution profile**: deep

## 목표

지시서 검사부터 worker 를 띄우기까지의 명령을 TypeScript 로 옮긴다. `launch-worker` 가 워크트리를 만든 뒤 `before-launch` 를, `LAUNCHED` 뒤 `worker-launched` 를 낸다.
옛 `.py` 경로가 node 로 넘어가는 shim 의 공통 처리를 이 phase 에서 끝낸다.

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

공통 모듈: `lib/spec.ts`(`branchesOf`, `permissionsOf`), `lib/paths.ts`, `lib/orca.ts`, `lib/git.ts`(`mainCheckout`, `defaultBase`), `lib/proc.ts`(`scriptCommand`), `lib/events.ts`(`fire`).
명령 이름, 옵션, 종료 코드, 출력 줄은 각 원본 머리 주석과 같게 둔다. 환경 변수(`ORCA`, `SPEC_LINE`, `MAKE_WORKTREE`, `LAUNCH_POLL`, `LAUNCH_WT_WAIT`, `LAUNCH_WT_POLL`)도 같다.

`fire` 의 시그니처는 `fire(event, input, ctx: { repo, base: string, run: string | null, cwd?, out? })` 이고 `Promise<FireResult>` 를 돌려준다(`lib/events.ts`).
`FireResult.result` 는 `none`, `pass`, `reject`, `fail`, `timeout` 가운데 하나다. 잠금을 얻지 못하면 `fail` 이고 `code` 가 null 이다.
핸들러 파일과 옛 설정 칸이 함께 있으면 `ConfigError` 를 던진다. 명령은 사용법 오류(종료 코드 2)로 바꾼다.

### shim

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
공통 처리는 새 모듈 `orch/scripts/ts_shim.py` 하나에 두고, 이 plan 의 뒤 phase 는 이 모듈을 고치지 않는다.

| 함수 | 동작 |
| --- | --- |
| `node_too_old(text: str) -> bool` | `node --version` 출력(`v22.18.0`)의 (major, minor) 가 (22, 18) 보다 작으면 True. 읽지 못하는 문자열도 True |
| `exec_ts(shim_file: str, deprecated: bool = True) -> None` | 아래 차례로 실행한다 |

`exec_ts` 의 차례:

1. 대상은 `shim_file` 과 같은 폴더의 같은 이름 `.ts` 다
2. `node --version` 을 10초 제한으로 부른다. node 가 없으면(`FileNotFoundError`) stderr 에 `node 22.18 이상이 PATH 에 필요하다` 를 내고 종료 코드 127 로 끝낸다
3. `node_too_old` 가 True 면 exec 하지 않는다. stdout 에 `NODE-TOO-OLD <버전> 22.18 이상이 필요하다` 한 줄을 내고 종료 코드 127 로 끝낸다. 22.18 보다 낮은 node 는 `.ts` 를 플래그 없이 실행하지 못해 `ERR_UNKNOWN_FILE_EXTENSION` 으로 죽기 때문이다
4. `deprecated` 가 True 면 stderr 에 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <절대경로>/<이름>.ts` 한 줄을 낸다
5. `os.execvp("node", ["node", "--disable-warning=ExperimentalWarning", <대상>, *sys.argv[1:]])`. 여기서 `FileNotFoundError` 가 나도 2 와 같이 127 이다

shim 파일은 아래 꼴이다. exec 는 `if __name__ == "__main__":` 안에서만 한다. 테스트가 `importlib` 로 shim 을 읽을 때 테스트 프로세스가 node 로 바뀌지 않게 하기 위해서다.
`sys.path.insert(0, <shim 폴더>)` 를 두어 `PYTHONSAFEPATH` 가 켜져 있어도 `ts_shim` 을 찾게 한다.

```python
#!/usr/bin/env python3
"""옛 경로다. 같은 이름의 .ts 로 넘긴다. 다음 major 에서 지운다."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ts_shim  # noqa: E402

if __name__ == "__main__":
    ts_shim.exec_ts(__file__)
```

23.0 부터 23.5 까지는 22.18 보다 크지만 타입 제거가 플래그 뒤에 있다. 지원이 끝난 홀수 버전이라 판정에 넣지 않는다.
shim 은 `spec-line.py`, `spec-lint.py`, `make-worktree.py`, `worktree-deny.py`, `launch-worker.py` 에 둔다. `orca_repo.py` 는 모듈이라 import 하는 쪽이 모두 옮겨지므로 지운다.

이 phase 부터 Python 테스트가 shim 을 거쳐 node 를 부른다. `orch/tests/test_orch_paths.py` 가 `spec-lint.py`, `spec-line.py`, `make-worktree.py`, `launch-worker.py` 를 `python3` 으로 부른다.
그래서 CI 의 `Python tests` job 에도 node 22.18 이상이 있어야 한다. ubuntu 이미지의 기본 node 는 22.18 보다 낮을 수 있다.

### fire ctx 와 입력

`launch-worker.ts` 가 `fire` 에 넘기는 ctx:

| 칸 | 값 |
| --- | --- |
| `repo` | `--repo`. `--worktree` 로 불렀으면 그 경로의 `mainCheckout` |
| `base` | `--base`. 없으면 `defaultBase(repo)`. 그것도 null 이면 빈 문자열 `""` |
| `run` | `--run`. 없으면 null. 이 명령은 `run-current` 를 부르지 않는다 |
| `cwd` | 주지 않는다(주 checkout) |

입력 필드(`docs/data-schema.md` 의 「이벤트별 필드」 가 소유한다)를 채우는 값:

| 필드 | `before-launch` | `worker-launched` |
| --- | --- | --- |
| `worker.task` | `--` 뒤 인자의 `--task` 값, 없으면 null | `worker-start` 결과에서 원본 `jget` 의 `dispatch.taskId\|taskId\|task.id` 로 읽은 값, 없으면 null |
| `worker.dispatch` | null | `LAUNCHED` 줄의 dispatch id |
| `worker.terminal` | `--` 뒤 인자의 `--terminal` 값, 없으면 null | 마지막 `worker-show` 결과의 `worker.agentTerminalHandle`, 없으면 `dispatch.assigneeHandle`, 없으면 `--` 뒤 인자의 `--terminal` 값, 없으면 null. 이 키들은 `send-to-worker.py` 가 읽는 키다 |
| `worker.worktree` | 워크트리 절대경로 | 같다 |
| `worker.spec` | `--spec` 의 절대경로 | 같다 |
| `branch` | `git -C <워크트리> branch --show-current` 의 결과, 비면 null | 같다 |
| `agent`, `model`, `effort` | `--` 뒤 인자의 `--agent`, `--model`, `--effort` 값, 없으면 null | 같다 |

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-launch`, `worker-launched` 줄과 「갈래」, `docs/data-schema.md` 의 「공통 필드」 와 「종료 코드」, `docs/code-architecture.md` 의 「실행 규칙」

## 의도 메모

- `launch-worker.py` 에는 이유 주석이 없는 함정이 있다. 결과 JSON 의 키 후보를 여럿 읽는 것(`jget` 의 `|`), `selector_not_found` 에서 다시 부르는 것, `worktree_creating` 에서 abandon 하고 한 번 다시 띄우는 것이다. 옮기면서 각 자리에 왜 그렇게 하는지 주석을 단다. 이유를 모르면 `git log -S` 로 그 줄을 넣은 커밋을 찾아 읽는다.
- `before-launch` 의 결과가 `pass` 나 `none` 이 아니면(`reject`, `fail`, `timeout`, 잠금 실패) 종료 코드 1 로 끝내고 `worker-start` 를 부르지 않는다. `reject` 는 `HOOK-REJECT` 줄, 나머지는 `HOOK-FAIL` 줄이다(`fire` 가 낸다). `docs/flow.md` 「갈래」 의 「거부처럼 멈춘다」 를 따른다. `result === 'reject'` 만 보면 죽은 핸들러를 지나쳐 띄우게 된다.
- 멈출 때 워크트리는 남긴다. 원본의 「워크트리는 남아 있다」 안내도 그대로 낸다. 워크트리를 지우면 지시서의 브랜치 이름을 다시 쓸 때 사람이 판단할 근거가 사라진다.
- `worker-launched` 의 실패는 종료 코드를 바꾸지 않는다. 이미 worker 가 떠 있어 `LAUNCHED` 를 믿고 다음 단계로 가야 한다. 이 예외를 `docs/flow.md` 「갈래」 에 적는다(작업 항목 4).
- `허락:` 줄은 늘 요구한다. 지시서 문서와 맞춘 규칙이다.

## 작업 항목

### 1. 위 표의 명령과 모듈을 옮기고 shim 을 만든다

`orch/scripts/ts_shim.py` 를 만들고, 표의 `.py` 를 위 shim 꼴로 바꾼다.

### 2. `launch-worker.ts` 에서 이벤트를 낸다

- 워크트리를 만들거나 확인한 뒤, Orca 가 워크트리를 알아보기를 기다리기 전에 `await fire('before-launch', { worker, branch, agent, model, effort }, ctx)` 를 부른다. 결과 처리는 「의도 메모」 대로다
- `LAUNCHED` 줄을 낸 뒤 `await fire('worker-launched', { worker, branch, agent, model, effort }, ctx)` 를 부른다. 결과와 무관하게 종료 코드는 0 이다
- `fire` 가 `ConfigError` 를 던지면 종료 코드 2 다

### 3. 테스트를 옮긴다

위 표의 테스트 사례를 모두 옮기고 원본 Python 테스트(`test_launch_send.py` 는 `LaunchWorkerTest` 클래스만)를 지운다.
`launch-worker.spec.ts` 에 더할 사례. 핸들러는 임시 저장소의 `.orch/hooks/<이벤트>.ts` 에 둔다.

| 핸들러 | 기대 |
| --- | --- |
| 없음 | 지금과 같은 호출 순서. 종료 코드 0 |
| `before-launch.ts` 가 10 으로 끝난다 | `worker-start` 가 불리지 않는다. 종료 코드 1, `HOOK-REJECT before-launch` 줄, 워크트리가 남는다 |
| `before-launch.ts` 가 1 로 끝난다 | `worker-start` 가 불리지 않는다. 종료 코드 1, `HOOK-FAIL before-launch 1` 줄 |
| `before-launch.ts` 가 잡지 않은 예외로 죽는다 | `worker-start` 가 불리지 않는다. 종료 코드 1, `HOOK-FAIL before-launch 1` 줄 |
| `before-launch.ts` 가 stdin 을 파일에 쓰고 0 으로 끝난다 | 입력의 `worker.worktree`, `worker.spec`, `branch`, `agent` 가 위 표대로다. `worker.dispatch` 는 null 이다. `base` 는 `--base` 값이다 |
| `worker-launched.ts` 가 stdin 을 파일에 쓰고 1 로 끝난다 | 종료 코드 0, `LAUNCHED` 줄과 `HOOK-FAIL worker-launched 1` 줄. 입력의 `worker.dispatch` 가 `LAUNCHED` 의 dispatch id 다 |
| `--base` 없이 `origin/HEAD` 가 없는 임시 저장소 | 핸들러 입력의 `base` 가 `""` 다 |

shim 은 새 Python 테스트 `orch/tests/test_ts_shim.py` 가 본다.

| 사례 | 기대 |
| --- | --- |
| `node_too_old` 에 `v22.18.0`, `v24.1.0` | False |
| `node_too_old` 에 `v22.17.9`, `v20.19.0`, `garbage` | True |
| PATH 앞의 가짜 `node` 가 `--version` 에 `v22.17.0` 을 낸다 | `python3 orch/scripts/launch-worker.py --help` 가 127, stdout 에 `NODE-TOO-OLD v22.17.0` 으로 시작하는 줄 |
| 가짜 `node` 가 `v22.18.0` 을 내고 받은 인자를 출력한다 | 인자가 `--disable-warning=ExperimentalWarning <절대경로>/launch-worker.ts --help` 다. stderr 에 `DEPRECATED` 줄 |
| PATH 에 node 가 없다(`python3` 은 `sys.executable` 절대경로로 부른다) | 127, stderr 에 `node 22.18 이상이 PATH 에 필요하다` |
| `importlib` 로 `launch-worker.py` 를 읽는다 | 예외 없이 돌아오고 테스트 프로세스가 이어진다 |

### 4. 문서

- `docs/flow.md` 「갈래」 의 「나머지 이벤트의 핸들러가 실패하거나 시간을 넘긴다」 줄에 다음 문장을 더한다: 「띄우기와 대기 명령은 알림 이벤트의 실패를 종료 코드에 반영하지 않는다. 대기의 종료 코드는 코디네이터의 다음 동작을 고르는 계약이기 때문이다」
- `docs/data-schema.md` 「공통 필드」 표의 `base` 줄에 「명령이 `--base` 를 받지 않았고 `origin/HEAD` 도 읽지 못하면 빈 문자열이다」 를 더한다
- `docs/code-architecture.md` 「배치」 에 `orch/scripts/ts_shim.py` 줄(shim 의 node 확인과 exec 한 벌)을 더한다
- `orch/README.md` 스크립트 목록에 `scripts/ts_shim.py` 를 더한다. `orch/tests/test_readme_script_list.py` 가 `orch/scripts/` 의 모든 `.py` 를 README 에서 찾기 때문이다. 지운 `scripts/orca_repo.py` 줄은 뺀다

### 5. CI

`.github/workflows/ci.yml` 의 `python` job 에서 `actions/setup-python@v5` 뒤에 `actions/setup-node@v4` 단계(`node-version: '22'`, `check-latest: true`)를 더한다. `plugin` job 의 같은 단계와 같은 값이다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/spec-line.spec.ts orch/tests/spec-lint.spec.ts orch/tests/make-worktree.spec.ts orch/tests/launch-worker.spec.ts orch/tests/lib-orca.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_ts_shim.py
python3 -m unittest orch/tests/test_launch_send.py
python3 -m unittest orch/tests/test_readme_script_list.py
python3 scripts/run-orch-tests.py --jobs 4
grep -n "setup-node" .github/workflows/ci.yml
python3 korean-check/scripts/korean-style-check.py docs/flow.md docs/data-schema.md docs/code-architecture.md orch/README.md
```

`grep -n "setup-node"` 은 `plugin` 과 `python` job 의 줄이 모두 나와야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/ts_shim.py` | 신규 |
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
| `orch/tests/test_ts_shim.py` | 신규 |
| `orch/tests/spec-line.spec.ts` | 신규 |
| `orch/tests/spec-lint.spec.ts` | 신규 |
| `orch/tests/make-worktree.spec.ts` | 신규 |
| `orch/tests/launch-worker.spec.ts` | 신규 |
| `orch/tests/lib-orca.spec.ts` | 수정 |
| `orch/tests/test_spec_line.py` | 삭제 |
| `orch/tests/test_spec_lint.py` | 삭제 |
| `orch/tests/test_make_worktree.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 수정 |
| `.github/workflows/ci.yml` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/README.md` | 수정 |
