# Phase 01. 프로세스 실행과 orca, gh, git 호출 모듈을 TypeScript 로 만들고 node:test 를 CI 에 붙인다

**Execution profile**: deep

## 목표

orch 스크립트마다 복사돼 있던 `run()` 래퍼, orca 와 gh 호출 helper, pid 생존 확인, 작업 디렉터리 점유 프로세스 찾기, 기준 브랜치 판정, 충돌 판정을 `orch/scripts/lib/` 의 한 벌로 만든다.
뒤 plan 의 명령 전환이 이 모듈만 import 하게 한다.

**범위 외**: 명령 스크립트 전환. 기존 Python 스크립트는 그대로 두고 고치지 않는다. 경로, 설정, 지시서 모듈은 phase 02, 이벤트 실행기는 phase 03 이다.
`cleanup-sweep.py` 와 `terminal_ownership.py` 의 소유 판정을 옮기는 일도 이 plan 밖이다.

## 컨텍스트

시작 조건: 작업 공간이 최신 main 기준이다. 다른 PR 의 머지를 기다리지 않는다.
이 plan 이 기대는 Orca CLI 의 `worker-list` 동작은 아래 「의도 메모」 에 사실로 적었다. 원본 Python 코드가 이 사실과 어긋나는 곳(`ORCA_TERMINAL_HANDLE` 을 빼서 범위를 넓히려는 코드)은 옮기지 않는다.

실행 규칙(Node 22.18 이상, 타입 제거 실행, 내장 모듈만, `import type`, 상대 import 에 `.ts`, `enum`·`namespace`·생성자 매개변수 속성 금지, 한국어 주석)은 `docs/code-architecture.md` 의 「orch 코어와 핸들러」 의 「실행 규칙」 표가 소유한다. 그대로 따른다.
테스트 파일 이름은 `*.spec.ts` 다. `claude plugin test .` 는 저장소 아래 모든 `*.test.ts` 를 `claude-code/testing` 환경에서 돌리므로 `*.test.ts` 로 두면 그쪽에 섞인다([ADR-010](../../docs/adr/010-orch-typescript.md)).

옮길 원본(동작을 읽고 같은 판정을 만든다. 경로는 모두 `orch/scripts/` 아래다):

| 새 모듈 | 원본 |
| --- | --- |
| `lib/proc.ts` | 스크립트마다 있는 `run()` 과 `subprocess.run` 호출(예: `cleanup-sweep.py`, `finish-pr.py`, `merge_queue.py`), `orch_process.py` 의 `script_command` |
| `lib/orca.ts` | `ORCA = os.environ.get("ORCA", "orca")` 와 orca 호출 helper. `terminal_ownership.py` 의 `query`, `live_specs.py` 의 `_orca`, `questions.py`(이 파일만 `ORCA_CLI_COMMAND` 를 읽는다), `triage-messages.py`(실행 파일을 `"orca"` 로 고정). `merge_queue.py` 는 orca 를 부르지 않는다 |
| `lib/gh.ts` | `GH = os.environ.get("GH", "gh")` 와 gh 호출(`ci-ready.py`, `finish-pr.py`, `notify-conflicts.py`). `merge_queue.py` 는 `GH` 를 읽지 않고 `"gh"` 로 고정한다(`grep -n '"gh"' orch/scripts/merge_queue.py`). update-branch 원본은 `merge_queue.py` 의 `pulls/{n}/update-branch` 호출이다 |
| `lib/git.ts` | `default_base` 함수(`cleanup-sweep.py`, `notify-conflicts.py`. `grep -n "def default_base" orch/scripts/*.py` 로 찾는다)와 `make-worktree.py` 의 인라인 사본(`grep -n "origin/HEAD" orch/scripts/make-worktree.py`), `orch_paths.py` 의 `git_root`, `notify-conflicts.py` 의 merge-tree 충돌 판정 |
| `lib/process.ts` | pid 생존 확인(`heavy-slot.py` 의 `alive`, `merge-with-finish.py` 의 `finish_running`, `merge_queue.py` 의 `pid_alive`), 작업 디렉터리 점유 프로세스 찾기(`remove-worktree.py` 의 lsof 호출, `cleanup-sweep.py` 의 `holder_cwds`) |

`script_command` 원본은 `.zsh` 는 `zsh`, `.sh` 는 `bash`, 그 밖은 모두 `sys.executable` 로 돌린다. 새 함수는 `.py` 만 `python3` 으로 돌리고 `.ts` 를 더한다.

**근거 문서**: `docs/code-architecture.md` 의 「배치」, 「실행 규칙」, 「공통 안전 장치」, `docs/adr/010-orch-typescript.md`

## 의도 메모

- 실행 파일 고르기는 `ORCA`, 없으면 `orca` 하나다. `ORCA_CLI_COMMAND` 는 읽지 않는다. 테스트는 `ORCA` 와 `GH` 에 가짜 실행 파일을 준다.
- `lib/orca.ts` 를 쓰는 쪽이 알아야 할 `orca orchestration worker-list` 의 동작이다. 모두 `worker-list --help` 와 실제 Orca 에서 확인한 사실이다.
  - 범위 플래그(`--run`) 없이 부르면 부른 터미널에 묶인 Run 의 worker 만 준다. 이때 응답의 `scope.source` 는 `bound` 다. 모든 Run 을 받았을 때만 `all` 이고, `--run` 을 주면 `flag` 다.
  - `ORCA_TERMINAL_HANDLE` 을 환경에서 빼도 범위는 넓어지지 않는다. Orca CLI 는 그 변수가 없으면 작업 디렉터리의 활성 터미널로 호출자를 정한다. 그래서 `lib/orca.ts` 는 이 변수를 빼는 방식으로 범위를 다루지 않는다.
  - 결과는 한 번에 100행까지 온다. `--limit 100` 으로 부르고, 응답의 `page.nextCursor` 가 있으면 `--cursor <값>` 으로 이어 읽어 끝까지 모은다. 첫 페이지만 읽으면 다른 worker 를 놓친다.
- `alive(pid)` 는 `process.kill(pid, 0)` 이 EPERM 을 내면 살아 있다고 본다. 옛 `finish_running` 이 EPERM 을 죽음으로 읽어 같은 PR 의 마무리를 겹쳐 걸 수 있었다.
  정수가 아니거나 1 미만인 pid 는 `process.kill` 을 부르지 않고 false 다. `process.kill(0, 0)` 은 자기 프로세스 그룹에 보내져 늘 성공하므로, 깨진 pid 파일이 살아 있는 것으로 읽혀 잠금이 회수되지 않는다.
- `cwdHolders` 가 조회에 실패하면 `ok: false` 를 낸다. 부르는 쪽은 이것을 「누군가 쥐고 있다」 로 본다. 원본은 둘로 갈렸다. `remove-worktree.py` 는 lsof 종료 코드가 0, 1 이 아니면 거부하고, `cleanup-sweep.py` 의 `holder_cwds` 는 실패를 무시해 빈 목록을 냈다. 빈 목록을 내면 쓰는 중인 워크트리를 지울 수 있어 앞쪽(보수적인 쪽)을 고른다. 이 선택을 `process.ts` 에 이유 주석으로 남긴다.
- 충돌 판정은 merge-tree 한 벌만 둔다. `ci-ready.py` 가 쓰던 GitHub `mergeable` 은 계산이 늦어 `UNKNOWN` 이 자주 나온다.
- `defaultBase` 는 값이 없으면 null 을 내고, 그때 무엇을 쓸지는 부르는 쪽이 정한다. 옛 코드는 없으면 `main` 으로 가정했다. 기본 브랜치가 main 이 아닌 저장소에서 `origin/HEAD` 를 읽지 못하면 엉뚱한 브랜치와 비교하게 된다. null 이면 부르는 쪽이 `--base` 를 요구하거나 설정값을 쓴다.
- `run` 은 동기(`spawnSync`)다. 명령들이 대부분 순서대로 부른다. 병렬이 필요하거나 TERM 을 무시할 수 있는 자식을 부를 때는 `runAsync` 를 쓴다. `spawnSync` 는 시간을 넘긴 자식이 TERM 을 무시하면 그 자식이 스스로 끝날 때까지 돌아오지 않는다(Node 22.18 실측: 500ms 제한에 4초 넘게 걸렸다).
- `maxBuffer` 를 256MB 로 둔다. `spawnSync` 의 기본값 1MB 를 넘으면 자식이 SIGTERM 으로 죽고 `ENOBUFS` 가 난다. orca 조회 출력이 수십 MB 까지 간 기록이 있다(`orch/CHANGELOG.md` 의 2.5.2).

## 작업 항목

### 1. `orch/scripts/lib/proc.ts`

```ts
export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }
export function run(argv: string[], opts?: RunOptions): RunResult
export function runAsync(argv: string[], opts?: RunOptions): Promise<RunResult>
export function scriptCommand(script: string, args: string[]): string[]
```

- `env` 는 `process.env` 를 통째로 대체하지 않고 그 위에 덮는다. 값이 `undefined` 인 키는 자식 환경에서 지운다. `env` 가 없으면 `process.env` 그대로다.
- 기본 timeout 은 60000ms 다. 예외를 던지지 않는다. 결과의 `code` 는 아래로 정한다.

| 경우 | `code` | 그 밖 |
| --- | --- | --- |
| 정상 종료 | 자식의 종료 코드 | |
| 실행 파일이 없다(ENOENT) | 127 | 이유를 `stderr` 에 담는다 |
| 시간을 넘겼다 | 124 | `timedOut: true` |
| 출력이 `maxBuffer`(256MB)를 넘었다 | 1 | 이유(`ENOBUFS`, 출력 한도 초과)를 `stderr` 에 담는다 |
| 시그널로 죽었다 | 128 + 신호 번호(`os.constants.signals`) | 예: SIGKILL 은 137 |

- `run` 은 시간을 넘기면 TERM 을 보낸다. `runAsync` 는 시간을 넘기면 TERM 을 보내고, 10초 뒤에도 살아 있으면 KILL 을 보낸다.
- `scriptCommand` 는 확장자가 `.ts` 면 `node --disable-warning=ExperimentalWarning`, `.py` 면 `python3`, `.sh` 면 `bash`, `.zsh` 면 `zsh` 로 감싼다. 그 밖의 확장자는 감싸지 않고 `[script, ...args]` 다. 명령끼리는 이 함수로 서로 부른다.

### 2. `orch/scripts/lib/orca.ts`

```ts
export function orcaBin(): string
export function orca(args: string[], opts?: RunOptions): RunResult
export function orcaJson<T>(args: string[], opts?: RunOptions): { ok: true; data: T } | { ok: false; error: string }
```

- `orcaJson` 은 `--json` 을 붙여 부르고, 응답 봉투의 `result` 를 `data` 로 낸다. 봉투 전체가 아니다.
- 아래는 모두 `ok: false` 와 이유다. 종료 코드가 0 이 아니다. stdout 이 JSON 으로 해석되지 않는다. 봉투의 `ok` 가 false 다. 봉투에 `result` 가 없다.
  원본 `terminal_ownership.py` 의 `query` 와 `live_specs.py` 의 `_orca` 가 이 조건을 확인한다.

### 3. `orch/scripts/lib/gh.ts`

```ts
export function ghBin(): string
export function gh(args: string[], opts?: { host?: string; cwd?: string }): RunResult
export function ghJson<T>(args: string[], opts?: { host?: string; cwd?: string }): { ok: true; data: T } | { ok: false; error: string }
export function currentUser(host?: string): string | null
export function isOwnPr(pr: { author: { login: string } }, authors: string[]): boolean
export function updateBranch(repo: string, pr: { number: number; isDraft: boolean }, reason: 'merge-turn' | 'behind-draft'): RunResult
```

- `host` 가 있으면 `RunOptions.env` 로 `GH_HOST` 를 그 값으로 준다.
- `repo` 는 `owner/name` 이다. `updateBranch` 는 `gh api -X PUT repos/<repo>/pulls/<number>/update-branch` 를 부른다. 원본은 `merge_queue.py` 의 update-branch 호출이다.
- `updateBranch` 는 base 를 합치는 유일한 경로다. `reason` 을 받는 것은 호출 이유를 출력과 기록에 남기기 위해서다.
  `reason` 이 `behind-draft` 인데 `pr.isDraft` 가 false 면 gh 를 부르지 않고 거부한다(`code` 2, 이유는 `stderr`). draft 여부는 부르는 쪽이 `gh pr view --json isDraft` 나 목록 조회에서 받아 넘긴다.

### 4. `orch/scripts/lib/git.ts`

```ts
export function git(repo: string, args: string[], opts?: RunOptions): RunResult
export function mainCheckout(repo: string): string
export function defaultBase(repo: string): string | null
export function conflicts(repo: string, base: string, head: string): { ok: true; conflict: boolean; files: string[] } | { ok: false; error: string }
```

- `mainCheckout` 은 `orch_paths.py` 의 `git_root` 분기를 그대로 옮긴다.
  `git rev-parse --path-format=absolute --git-common-dir` 이 실패하면 받은 폴더(realpath)다. common dir 의 이름이 `.git` 이면 그 부모다. 아니면(bare 저장소 등) `git rev-parse --show-toplevel` 이고, 그것도 실패하면 받은 폴더다.
- `defaultBase` 는 `git symbolic-ref --short refs/remotes/origin/HEAD` 의 값에서 `origin/` 을 뗀 브랜치 이름(예: `main`)을 낸다. 명령이 실패하거나 값이 `origin/` 으로 시작하지 않으면 null 이다. 그 이유는 「의도 메모」 에 있다.
- `conflicts` 는 `git merge-tree --write-tree --name-only --no-messages <base> <head>` 다. 종료 코드 0 은 충돌 없음, 1 은 충돌이고 첫 줄(트리 id)을 뺀 줄이 파일 목록이다. 그 밖은 `ok: false` 다(`notify-conflicts.py` 와 같은 판정).

### 5. `orch/scripts/lib/process.ts`

```ts
export function alive(pid: number): boolean
export function cwdHolders(dir: string): { ok: true; holders: { pid: number; cwd: string }[] } | { ok: false; error: string }
```

- `alive` 는 정수가 아니거나 1 미만이면 false 다. 아니면 `process.kill(pid, 0)` 이 성공하거나 EPERM 이면 true, ESRCH 면 false 다.
- `cwdHolders` 는 PATH 의 `lsof` 를 `lsof -d cwd -Fpn` 으로 부른다. 종료 코드 0, 1 은 성공이다(1 은 맞는 프로세스가 없다). 그 밖이거나 실행하지 못하면 `ok: false` 다.
  `p` 줄의 pid 와 그다음 `n` 줄의 경로를 짝지어, 경로가 `dir` 과 같거나 `dir + '/'` 로 시작하면 담는다. `dir` 은 realpath 로 바꿔 비교한다. macOS 의 임시 폴더는 `/var` 와 `/private/var` 로 갈리고 lsof 는 실경로를 낸다.
  `cwd` 를 함께 내는 것은 `cleanup-sweep.py` 의 `targets()` 처럼 중첩 워크트리 안의 프로세스를 빼려면 pid 마다 작업 디렉터리가 필요해서다.

### 6. 가짜 실행 파일 helper `orch/tests/fixtures/fake-bin.ts`

임시 폴더에 `orca`, `gh`, `lsof` 같은 이름의 실행 파일을 만들고, 받은 argv 를 JSONL 로 기록하고, 인자 패턴마다 정한 stdout 과 종료 코드를 내는 helper 다. 확장자 없는 실행 파일은 `#!/usr/bin/env node` 로 시작하고 타입 문법을 쓰지 않는다.

### 7. 이 phase 의 테스트

`orch/tests/lib-proc.spec.ts`, `lib-orca.spec.ts`, `lib-gh.spec.ts`, `lib-git.spec.ts`, `lib-process.spec.ts` 를 만든다.

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `lib-proc.spec.ts` | 종료 코드와 출력. `env` 가 `process.env` 위에 덮이고 `undefined` 키가 자식 환경에서 빠진다 | 없는 실행 파일이 127. 시간 초과가 124 와 `timedOut`. 자기에게 SIGKILL 을 보낸 자식이 137. `maxBuffer` 를 넘는 출력이 1 과 이유. `runAsync` 에서 TERM 을 무시하는 자식이 10초 뒤 KILL 로 끝난다 |
| `lib-orca.spec.ts` | `ORCA` 의 가짜 실행 파일을 부르고 봉투의 `result` 를 `data` 로 읽는다 | 깨진 JSON, 0 이 아닌 종료 코드, 봉투의 `ok: false` 가 모두 `ok: false` |
| `lib-gh.spec.ts` | `host` 가 `GH_HOST` 로 간다. 작성자 판정. `updateBranch` 가 `api -X PUT repos/o/r/pulls/7/update-branch` 를 부른다 | `isDraft: false` 인 PR 에 `behind-draft` 로 부른 `updateBranch` 가 gh 를 부르지 않고 거부 |
| `lib-git.spec.ts` | 임시 저장소의 `defaultBase` 가 `main` 처럼 `origin/` 을 뗀 이름. 워크트리에서 부른 `mainCheckout` 이 주 checkout. 충돌 없는 merge-tree | `origin/HEAD` 가 없는 저장소의 `defaultBase` 가 null. git 밖 폴더의 `mainCheckout` 이 그 폴더. 같은 줄을 고친 두 브랜치가 `conflict: true` 와 파일 목록 |
| `lib-process.spec.ts` | 자기 pid 가 살아 있다. 임시 폴더를 작업 디렉터리로 띄운 자식이 `cwdHolders` 의 `holders` 에 pid 와 cwd 로 나온다 | 끝난 자식 pid 가 죽었다. EPERM 을 내는 `process.kill` 대역이 true. pid 0, -1, 1.5, NaN 이 false. 종료 코드 2 를 내는 가짜 `lsof` 를 PATH 앞에 두면 `ok: false` |

`lib-git.spec.ts` 는 git 을 부를 때마다 `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` 을 준다. CI 에는 git 작성자 설정이 없어 커밋이 실패한다(`orch/tests/test_cleanup_sweep.py` 의 `setUp` 과 같은 값).
`lib-process.spec.ts` 의 가짜 `lsof` 사례는 그 테스트 안에서만 `process.env.PATH` 를 바꾸고 끝나면 되돌린다. 테스트 파일마다 프로세스가 나뉘어 다른 파일에 새지 않는다.

### 8. CI 와 저장소 문서

- `.github/workflows/ci.yml` 의 `Plugin tests` job 에 `node --test --test-concurrency=4 "orch/tests/*.spec.ts"` 단계를 더한다. job 이름은 바꾸지 않는다. 필수 체크 이름이다
- 같은 job 의 `actions/setup-node` 에 `check-latest: true` 를 더하고 `node-version: '22'` 는 그대로 둔다. `check-latest` 가 있으면 cache 에 든 옛 22.x 대신 그때의 최신 22.x 를 받는다. 최신 22.x 는 22.18 이상이라, 「실행 규칙」 의 Node 하한(22.18)을 CI 가 보장한다
- `README.md` 「기여」 와 `.orch/overlay.md` 의 로컬 검증에 같은 테스트 명령을 더한다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-proc.spec.ts orch/tests/lib-orca.spec.ts orch/tests/lib-gh.spec.ts orch/tests/lib-git.spec.ts orch/tests/lib-process.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
grep -n "check-latest: true" .github/workflows/ci.yml
claude plugin test .
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/proc.ts` | 신규 |
| `orch/scripts/lib/orca.ts` | 신규 |
| `orch/scripts/lib/gh.ts` | 신규 |
| `orch/scripts/lib/git.ts` | 신규 |
| `orch/scripts/lib/process.ts` | 신규 |
| `orch/tests/fixtures/fake-bin.ts` | 신규 |
| `orch/tests/lib-proc.spec.ts` | 신규 |
| `orch/tests/lib-orca.spec.ts` | 신규 |
| `orch/tests/lib-gh.spec.ts` | 신규 |
| `orch/tests/lib-git.spec.ts` | 신규 |
| `orch/tests/lib-process.spec.ts` | 신규 |
| `.github/workflows/ci.yml` | 수정 |
| `README.md` | 수정 |
| `.orch/overlay.md` | 수정 |

## 구현 중 정한 것

- `RunOptions` 에 테스트용 내부 칸 `maxBuffer` 를 둔다. 256MB 출력을 테스트가 실제로 만들지 않게 하기 위해서다.
- `runAsync` 는 자식이 끝난 뒤 손자가 파이프를 쥐면 짧은 유예 뒤 파이프를 닫고 자식의 종료 코드를 낸다.
- 파일 helper(실경로, 파일 여부, 하위 경로 판정)는 `lib/fs.ts`, 128+신호 번호 계산은 `proc.ts` 한 곳에 둔다.
- `cwdHolders` 의 실제 lsof 사례는 lsof 가 없으면 건너뛰지 않고 실패한다.
