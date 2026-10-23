# Phase 01. 프로세스 실행과 orca, gh, git 호출 모듈을 TypeScript 로 만들고 node:test 를 CI 에 붙인다

**Execution profile**: deep

## 목표

orch 스크립트마다 복사돼 있던 `run()` 래퍼, orca 와 gh 호출 helper, pid 생존 확인, 작업 디렉터리 점유 프로세스 찾기, 기준 브랜치 판정, 충돌 판정을 `orch/scripts/lib/` 의 한 벌로 만든다.
뒤 plan 의 명령 전환이 이 모듈만 import 하게 한다.

**범위 외**: 명령 스크립트 전환. 기존 Python 스크립트는 그대로 두고 고치지 않는다. 경로, 설정, 지시서 모듈은 phase 02, 이벤트 실행기는 phase 03 이다.

## 컨텍스트

시작 조건: PR #190(`fix/orch-sweep-bound-scope`)과 `plan2-orch-docs-conflicts` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: 선행 PR 머지 전` 을 내고 멈춘다.

실행 규칙(Node 22.18 이상, 타입 제거 실행, 내장 모듈만, `import type`, 상대 import 에 `.ts`, `enum`·`namespace`·생성자 매개변수 속성 금지, 한국어 주석)은 `docs/code-architecture.md` 의 「orch 코어와 핸들러」 의 「실행 규칙」 표가 소유한다. 그대로 따른다.
테스트 파일 이름은 `*.spec.ts` 다. `claude plugin test .` 는 저장소 아래 모든 `*.test.ts` 를 `claude-code/testing` 환경에서 돌리므로 `*.test.ts` 로 두면 그쪽에 섞인다([ADR-010](../../docs/adr/010-orch-typescript.md)).

옮길 원본(동작을 읽고 같은 판정을 만든다):

| 새 모듈 | 원본 |
| --- | --- |
| `lib/proc.ts` | 스크립트마다 있는 `run()` 과 `subprocess.run` 호출. 예: `orch/scripts/cleanup-sweep.py`, `finish-pr.py`, `merge_queue.py` |
| `lib/orca.ts` | `ORCA = os.environ.get("ORCA", "orca")` 와 orca 호출 helper. `orch/scripts/terminal_ownership.py`, `questions.py`(이 파일만 `ORCA_CLI_COMMAND` 를 읽는다), `triage-messages.py`(실행 파일 고정), `merge_queue.py`(실행 파일 고정) |
| `lib/gh.ts` | `GH = os.environ.get("GH", "gh")` 와 gh 호출. `ci-ready.py`, `finish-pr.py`, `merge_queue.py` |
| `lib/git.ts` | `default_base` 두 벌(`cleanup-sweep.py`, `handoff-cleanup.py` 에서 `grep -n "def default_base"` 로 찾는다), `orch_paths.py` 의 `git_root`, `notify-conflicts.py` 의 merge-tree 충돌 판정 |
| `lib/process.ts` | pid 생존 확인 세 벌(`heavy-slot.py` 의 `alive`, `merge-with-finish.py` 의 `finish_running`, `merge_queue.py`), 작업 디렉터리 점유 프로세스 찾기 두 벌(`remove-worktree.py`, `cleanup-sweep.py`) |

**근거 문서**: `docs/code-architecture.md` 의 「배치」, 「실행 규칙」, 「공통 안전 장치」, `docs/adr/010-orch-typescript.md`

## 의도 메모

- 실행 파일 고르기는 `ORCA`, 없으면 `orca` 하나다. `ORCA_CLI_COMMAND` 는 읽지 않는다. 테스트는 `ORCA` 와 `GH` 에 가짜 실행 파일을 준다.
- `alive(pid)` 는 `process.kill(pid, 0)` 이 EPERM 을 내면 살아 있다고 본다. 옛 `finish_running` 이 EPERM 을 죽음으로 읽어 같은 PR 의 마무리를 겹쳐 걸 수 있었다.
- 충돌 판정은 merge-tree 한 벌만 둔다. `ci-ready.py` 가 쓰던 GitHub `mergeable` 은 계산이 늦어 `UNKNOWN` 이 자주 나온다.
- `run` 은 동기(`spawnSync`)다. 명령들이 대부분 순서대로 부른다. 병렬이 필요한 곳은 `runAsync` 를 쓴다.

## 작업 항목

### 1. `orch/scripts/lib/proc.ts`

```ts
export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type RunOptions = { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }
export function run(argv: string[], opts?: RunOptions): RunResult
export function runAsync(argv: string[], opts?: RunOptions): Promise<RunResult>
```

`scriptCommand(script: string, args: string[]): string[]` 도 둔다. 확장자가 `.ts` 면 `node --disable-warning=ExperimentalWarning`, `.py` 면 `python3`, `.sh` 면 `bash`, `.zsh` 면 `zsh` 로 감싼다. 옛 `orch/scripts/orch_process.py` 의 `script_command` 를 옮긴 것이다. 명령끼리는 이 함수로 서로 부른다.

기본 timeout 은 60000ms 다. 실행 파일이 없으면 `code` 127 과 그 이유를 `stderr` 에 담는다. 시간을 넘기면 TERM 을 보내고 `timedOut: true`, `code` 124 다. 예외를 던지지 않는다.

### 2. `orch/scripts/lib/orca.ts`

`orcaBin()`, `orca(args, opts)`, `orcaJson<T>(args, opts): { ok: true; data: T } | { ok: false; error: string }` 를 둔다. `orcaJson` 은 `--json` 을 붙이고 JSON 해석 실패도 `ok: false` 로 낸다.

### 3. `orch/scripts/lib/gh.ts`

`ghBin()`, `gh(args, { host?, cwd? })`, `ghJson<T>`, `currentUser(host?)`, `isOwnPr(pr: { author: { login: string } }, authors: string[])`, `updateBranch(repo, pr, reason: 'merge-turn' | 'behind-draft')` 를 둔다.
`host` 가 있으면 `GH_HOST` 를 그 값으로 준다.
`updateBranch` 는 base 를 합치는 유일한 경로다. `reason` 을 받는 것은 호출 이유를 출력과 기록에 남기기 위해서다. ready PR 에 `behind-draft` 로 부르면 거부한다.

### 4. `orch/scripts/lib/git.ts`

`git(repo, args, opts)`, `mainCheckout(repo)`(git-common-dir 의 부모), `defaultBase(repo)`(`origin/HEAD` 가 가리키는 브랜치, 없으면 null), `conflicts(repo, base, head): { ok: true; conflict: boolean; files: string[] } | { ok: false; error: string }`(`git merge-tree --write-tree`) 를 둔다.

### 5. `orch/scripts/lib/process.ts`

`alive(pid): boolean`(EPERM 은 true), `cwdHolders(dir): { pid: number; command: string }[]`(lsof). 원본 두 벌의 판정 차이를 읽고 더 보수적인 쪽(쥔 것으로 보는 쪽)을 고른다. 그 선택을 이유 주석으로 남긴다.

### 6. 가짜 실행 파일 helper `orch/tests/fixtures/fake-bin.ts`

임시 폴더에 `orca`, `gh` 같은 이름의 실행 파일을 만들고, 받은 argv 를 JSONL 로 기록하고, 인자 패턴마다 정한 stdout 과 종료 코드를 내는 helper 다. 확장자 없는 실행 파일은 `#!/usr/bin/env node` 로 시작하고 타입 문법을 쓰지 않는다.

### 7. 이 phase 의 테스트

`orch/tests/lib-proc.spec.ts`, `lib-orca.spec.ts`, `lib-gh.spec.ts`, `lib-git.spec.ts`, `lib-process.spec.ts` 를 만든다.

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `lib-proc.spec.ts` | 종료 코드와 출력 | 없는 실행 파일이 127, 시간 초과가 124 와 `timedOut` |
| `lib-orca.spec.ts` | `ORCA` 의 가짜 실행 파일을 부르고 JSON 을 읽는다 | 깨진 JSON 이 `ok: false` |
| `lib-gh.spec.ts` | `host` 가 `GH_HOST` 로 간다. 작성자 판정 | ready PR 에 `behind-draft` 로 부른 `updateBranch` 가 gh 를 부르지 않고 거부 |
| `lib-git.spec.ts` | 임시 저장소의 `defaultBase`, 충돌 없는 merge-tree | 같은 줄을 고친 두 브랜치가 `conflict: true` 와 파일 목록 |
| `lib-process.spec.ts` | 자기 pid 가 살아 있다 | 끝난 자식 pid 가 죽었다. EPERM 을 내는 `process.kill` 대역이 true |

### 8. CI 와 저장소 문서

- `.github/workflows/ci.yml` 의 `Plugin tests` job 에 `node --test --test-concurrency=4 "orch/tests/*.spec.ts"` 단계를 더한다. job 이름은 바꾸지 않는다. 필수 체크 이름이다
- `README.md` 「기여」 와 `.orch/overlay.md` 의 로컬 검증에 같은 명령을 더한다

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-proc.spec.ts orch/tests/lib-orca.spec.ts orch/tests/lib-gh.spec.ts orch/tests/lib-git.spec.ts orch/tests/lib-process.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
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
