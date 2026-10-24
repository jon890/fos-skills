# Phase 05. 무거운 검사 대기열, 경로 명령, 보드 명령을 옮기고 남은 Python 모듈을 지운다

**Execution profile**: deep

## 목표

`heavy-slot`, `mem-gate`, `orch_paths` 명령, `work-board/bin/board.py` 를 TypeScript 로 옮긴다.
무거운 검사 분류 정규식을 코드에서 빼 `config.json` 의 `heavy` 절로 옮긴다. 더는 import 하는 쪽이 없는 Python 모듈을 지운다.

**범위 외**: 테스트 러너와 CI 정리, 문서의 실행 예시, CHANGELOG(phase 06).

## 컨텍스트

시작 조건: `orch/scripts/handoff-cleanup.ts`, `orch/scripts/board-sync.ts`, `orch/scripts/goal-progress.ts` 가 있다. 없으면 `PHASE_BLOCKED: phase 04 커밋 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/heavy-slot.py` | `orch/scripts/heavy-slot.ts` | `orch/tests/test_heavy_slot.py` → `orch/tests/heavy-slot.spec.ts` |
| `orch/scripts/mem-gate.py` | `orch/scripts/mem-gate.ts` | `orch/tests/test_mem_gate.py` → `orch/tests/mem-gate.spec.ts` |
| `orch/scripts/orch_paths.py` | 명령 `orch/scripts/orch_paths.ts`. 경로 규칙은 `lib/paths.ts` 가 이미 갖고 있다 | `orch/tests/test_orch_paths.py` → `orch/tests/orch-paths.spec.ts` |
| `orch/scripts/live_specs.py` | 지운다. `lib/spec.ts` 의 `liveSpecPaths` 가 대신한다 | `orch/tests/test_live_specs.py` 를 지운다. `lib-spec.spec.ts` 가 다룬다 |
| `orch/scripts/orch_process.py` | 지운다. `lib/proc.ts` 가 대신한다 | 없음 |
| `work-board/bin/board.py` | `work-board/bin/board.ts` | `work-board/tests/test_board.py` → `work-board/tests/board.spec.ts` |

옵션, 출력, 종료 코드는 원본 머리 주석과 같다. `orch_paths.ts` 의 이름 목록은 `lib/paths.ts` 의 `NAMES` 에 `root`, `board`, `check` 를 더한 것이다. 원본에 없던 `hooks`, `hooks-state` 도 받는다.
`orch_paths.py` 는 지우지 않고 shim 으로 둔다. 다른 저장소의 포장 스크립트와 문서가 `orch_paths.py specs`, `orch_paths.py check` 를 부른다.

이 phase 에서 지우거나 shim 으로 바꾸는 Python 끼리의 import 는 아래뿐이다. 모두 이 커밋 안에서 끊긴다.

- `orch_paths.py` 는 `board_path` 에서 `work-board/bin/board.py` 를 importlib 로 읽는다. 두 파일을 함께 shim 으로 바꾸므로 그 import 가 남지 않는다
- `heavy-slot.py` 는 `orch_process`, `orch_paths` 를, `mem-gate.py` 는 `orch_process` 를 import 한다. 둘을 shim 으로 바꾼 뒤 `orch_process.py` 를 지운다
- `live_specs.py` 는 phase 04 뒤로 import 하는 쪽이 없다

이 phase 가 끝나면 `orch/scripts/` 의 `.py` 는 `ts_shim.py` 를 빼고 모두 `ts_shim.exec_ts(__file__` 를 부르며 같은 이름의 `.ts` 가 있다.

**보드 경로 규칙은 `work-board/bin/board.ts` 한 곳이 소유한다.** 보드는 work-board 의 것이고(`lib/paths.ts` 머리 주석), orch 는 이미 `BOARD_BIN` 기본값으로 work-board 를 가리킨다. 의존 방향을 orch 에서 work-board 로 하나만 둔다.

- `board.ts` 는 `export function defaultBoardPath(cwd: string): string` 를 둔다. `git rev-parse --show-toplevel`(실패하면 cwd)의 `.omc/handoffs/board.json` 이 있으면 그것, 없으면 `.omc/board.json` 이다. 명령 실행은 `if (import.meta.main)` 안에만 둔다(`orch/scripts/triage-messages.ts` 와 같은 꼴). import 할 때 명령이 돌지 않게 하기 위해서다
- `lib/paths.ts` 의 `boardPath` 는 명시한 값을 주 checkout 기준으로 푸는 규칙만 갖고, 기본 위치는 `../../../work-board/bin/board.ts` 의 `defaultBoardPath(real(repo))` 를 부른다. 지금 88-101행에 옮겨 둔 규칙과 「그 규칙이 바뀌면 여기도 같이 고친다」 주석을 지운다. 19행 주석도 import 한다는 말로 바꾼다
- `work-board/hooks/register.js` 의 `BOARD_PATHS` 는 mod 가 읽는 JS 라 `.ts` 를 import 하지 못한다. 이 phase 에서는 고치지 않는다

`heavy-slot.py` 의 `classify` 와 `LIGHT` 정규식은 한 저장소의 명령 이름을 담는다. 그 값은 코드에 남기지 않는다. 분류는 `docs/data-schema.md` 의 `heavy` 절을 따른다. 설정이 없으면 모든 명령이 `normal` 이다. `--exclusive` 와 `HEAVY_EXCLUSIVE=1` 은 그대로 `exclusive` 로 만든다.
`heavy` 절은 `lib/config.ts` 에 `HEAVY_KEYS`(`exclusive`, `normal`, `light`, `wait_idle`)를 더하고 `section(loadConfig(<현재 디렉터리>), 'heavy', HEAVY_KEYS)` 로 읽는다. 값이 정규식 문자열 목록이 아니면 ConfigError 이고 사용법 오류(2)다.
자리를 잡은 뒤 부르는 메모리 대기의 기본 경로(`MEM_GATE` 가 없을 때)는 같은 폴더의 `mem-gate.ts` 다.

보드 명령의 기본 경로(`BOARD_BIN` 이 없을 때)를 `work-board/bin/board.ts` 로 바꾸는 곳은 `board-sync.ts`, `goal-progress.ts`, `finish-pr.ts`(289행)다. 같은 이름을 적은 주석과 테스트 이름도 바꾼다.

- `finish-pr.ts` 머리 주석 59행의 `work-board 의 board.py 가 정한 위치` 와 61행의 `work-board/bin/board.py`
- `merge-with-finish.ts` 64행 머리 주석의 `work-board 의 board.py 가 정한 위치`
- `handoff-cleanup.ts`, `board-sync.ts`, `goal-progress.ts` 머리 주석의 같은 문장
- `orch/tests/finish-pr.spec.ts` 359행의 테스트 이름 `BOARD_BIN 이 없으면 저장소의 work-board/bin/board.py 가 …` 와 phase 04 가 만든 `board-sync.spec.ts` 의 같은 사례 이름

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 `orch/scripts/ci-ready.py` 와 같은 꼴이다. `ts_shim` 을 import 하고 `if __name__ == "__main__":` 안에서 `ts_shim.exec_ts(__file__)` 를 부른다. node 22.18 미만이면 `NODE-TOO-OLD` 줄과 종료 코드 127 로 멈추고, 아니면 stderr 에 `DEPRECATED` 줄을 내고 같은 이름의 `.ts` 로 exec 한다(`orch/scripts/ts_shim.py` 머리 주석). `ts_shim.py` 는 고치지 않는다.
아직 Python 인 다른 명령과 다른 저장소가 옛 `.py` 경로를 부르므로 shim 이 없으면 그쪽이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
이 phase 의 shim 은 `heavy-slot.py`, `mem-gate.py`, `orch_paths.py`, `work-board/bin/board.py` 다. `work-board/bin/board.py` 는 `orch/scripts/ts_shim.py` 를 경로로 import 한다(`sys.path` 에 `../../orch/scripts` 를 더한다).

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다. 같은 이름의 `.ts` 가 있는 `.py` 는 대조하지 않는다.

**근거 문서**: `docs/data-schema.md` 의 「config.json 에 더하는 절」 의 `heavy` 줄, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 의 무거운 검사 줄, `docs/adr/006-work-board-in-plugin.md`

## 의도 메모

- 분류 설정이 없는 저장소는 모든 명령이 `normal` 이다(`docs/data-schema.md`). 가벼운 명령까지 자리를 기다리지만 잘못 분류해 전체 검사를 동시에 돌리는 것보다 안전하다.
- `wait_idle` 은 대기열에 등록한 뒤, 자리를 잡기(claim) 전에 기다린다. 등록 전에 기다리면 뒤에 온 검사가 먼저 등록해 FIFO 가 깨진다.
- `mem-gate` 의 기본값(`EASY_FREE_PCT=37`, `MIN_FREE_PCT=35`, `MAX_SWAP_MB=10240`, `MAX_WAIT=3600`, `POLL=30`)에 이유 주석이 없다. `git log -S` 로 그 값을 넣은 커밋을 읽고 이유가 있으면 주석으로 단다. 찾지 못하면 이력을 지어내지 않고 그 값이 무엇을 막는지(실제 동작)만 적는다. 예: free 가 37% 이상이면 swap 과 관계없이 통과한다.

## 작업 항목

### 1. 위 표의 명령, shim, 지울 모듈

`heavy-slot.ts`, `mem-gate.ts`, `orch_paths.ts`, `work-board/bin/board.ts` 를 만들고 네 `.py` 를 shim 으로 바꾼다. `live_specs.py`, `orch_process.py` 를 지운다. 위 「컨텍스트」 의 보드 경로 규칙과 `BOARD_BIN` 기본값을 바꾼다.

### 2. `heavy-slot.ts` 의 분류

1. 명령줄이 `bash -c` 나 `sh -c` 면 그 본문을, 아니면 인자를 공백으로 이은 글자를 본다
2. `&&`, `||`, `;`, `|` 로 조각을 나누고, 조각마다 앞의 `time`, `/usr/bin/time`, `/usr/bin/time -l` 과 앞뒤 괄호를 뗀다. 빈 조각은 버린다. 원본 `def classify` 와 같다
3. 조각 하나라도 `exclusive` 의 정규식에 맞으면 `exclusive`
4. 아니면 조각 하나라도 `normal` 에 맞으면 `normal`
5. 아니면 모든 조각이 `light` 의 정규식 가운데 하나에 맞을 때만 `light`
6. 그 밖은 `normal`

정규식은 JS `RegExp` 로 읽는다(플래그 없음). 하나라도 `new RegExp` 가 거부하면 등록하기 전에 `heavy-slot: heavy.<키> 의 정규식이 틀렸다: <원문>: <이유>` 를 stderr 에 내고 종료 코드 2 다.
`light` 는 원본처럼 대기열을 거치지 않고 바로 실행한다. 중첩 호출(`HEAVY_SLOT_HELD`)도 원본처럼 대기열을 건너뛴다.

### 3. `heavy-slot.ts` 의 `wait_idle`

- 대기열에 등록한 뒤, 자리를 잡기 전에 명령줄이 `heavy.wait_idle` 의 정규식 가운데 하나에 맞는 프로세스가 없을 때까지 `HEAVY_POLL`(기본 5초) 간격으로 다시 본다. 목록이 비어 있으면 기다리지 않는다
- 프로세스 목록은 `ps -axo pid=,ppid=,command=` 다. 읽지 못하면 원본의 대기열 검사 실패처럼 등록을 지우고 종료 코드 1 이다
- 대상에서 빼는 프로세스: 자기 pid 와 그 조상, slot 폴더에 등록된 heavy-slot 프로세스와 그 자손. 자기 명령줄이나 이미 자리를 쥔 검사가 정규식에 맞아 서로를 기다리지 않게 한다
- 최대 대기는 `HEAVY_IDLE_WAIT` 초다(기본 1800). 넘으면 stdout 에 `heavy-slot: wait_idle 대기가 <초>초를 넘었다: <맞은 명령줄 하나>` 한 줄을 내고, 등록을 지우고, 종료 코드 124 로 끝난다. 이름은 `HEAVY_POLL`, `HEAVY_SLOTS`, `HEAVY_EXCLUSIVE` 와 같은 `HEAVY_` 접두를 따랐다. `git grep -n "HEAVY_IDLE"` 로 겹치는 이름이 없음을 확인했다
- 머리 주석의 사용법, 환경 변수, 종료 코드에 위를 더한다

### 4. 문서

- `orch/README.md`: `scripts/heavy-slot.py`, `scripts/mem-gate.py`, `scripts/orch_paths.py` 줄을 `.ts` 로 바꾼다. `heavy-slot.ts` 줄에 분류를 `.orch/config.json` 의 `heavy` 절에서 읽고 `wait_idle` 로 대기열 밖의 무거운 프로세스를 기다린다는 문장을 더한다. `orch_paths.ts` 줄은 「셸에서 `orch_paths.ts specs` 처럼 이름으로 경로를 받는다. 경로 규칙은 `lib/paths.ts` 가 소유한다」 로 쓴다. `scripts/live_specs.py`, `scripts/orch_process.py` 줄을 지운다. 「옛 경로. 다음 major 에서 지운다」 줄에 세 `.py` 를 더한다
- `orch/references/heavy-checks.md`: 12-13행의 「타입 검사, lint, 파일을 지정한 단위 검사는 대기열을 거치지 않는다. 시나리오 검사와 빌드는 자리를 사용한다. 자동 분류가 맞지 않는 전체 검사는 `--exclusive` 로 지정한다」 를 바꾼다. 분류는 `.orch/config.json` 의 `heavy` 절이 정하고, 설정이 없으면 모든 명령이 자리를 쓰며(`normal`), `wait_idle` 은 대기열 밖의 무거운 프로세스(이미지 빌드 같은 것)가 끝날 때까지 기다린다는 것을 적는다. 규칙의 차례와 시간 초과는 `heavy-slot.ts` 머리 주석이 소유한다고 적는다. 실행 예시는 phase 06 이 바꾼다
- `docs/code-architecture.md` 「배치」: `work-board/bin/board.ts` 줄을 「보드 편집 명령. 옛 board.py. 기본 보드 위치 규칙 한 벌(`defaultBoardPath`)을 두고 `lib/paths.ts` 가 import 한다」 로 바꾼다. `lib/paths.ts` 줄의 「옛 orch_paths.py 의 역할」 뒤에 「셸에서 부르는 명령은 `orch_paths.ts`」 를 더한다. 「`orch/scripts/` 의 명령은 `lib/` 만 import 한다」 문장 뒤에 `lib/paths.ts` 가 보드 위치 하나만 work-board 에서 import 한다는 예외를 적는다
- `docs/code-architecture.md` 「디렉터리 배치」: `work-board/` 줄의 `bin/board.py` 를 `bin/board.ts` 로 바꾼다

### 5. 테스트

`orch/tests/heavy-slot.spec.ts`, `orch/tests/mem-gate.spec.ts`, `orch/tests/orch-paths.spec.ts`, `work-board/tests/board.spec.ts` 를 만들고 원본 사례를 모두 옮긴 뒤 원본을 지운다. `test_orch_paths.py` 의 `LaunchPrepWithoutOmcTest` 는 `spec-lint.ts`, `spec-line.ts`, `make-worktree.ts` 를 직접 부르게 옮긴다.

`heavy-slot.spec.ts` 의 분류 사례: 원본 `test_classification` 은 한 저장소의 명령 이름을 쓴다. 같은 꼴의 일반 명령과, 그 사례를 담은 `heavy` 설정(`exclusive`: `local-ci`, `playwright`, `browser` / `normal`: `scenario`, `baseline` / `light`: 원본 `LIGHT` 와 같은 꼴의 `tsc`, `oxlint`, `type-check`, `lint`, 파일을 지정한 `test`, `node --check`, `cd`, `git`, `echo` 정규식)로 옮긴다.

- `pnpm type-check` 는 light
- `bash -c 'cd /x && pnpm exec tsc -p tsconfig.json && pnpm exec oxlint src'` 는 light
- `pnpm test tests/unit/a.test.cjs` 는 light, `pnpm test` 와 `pnpm build` 는 normal
- `pnpm lint && pnpm build` 는 light 가 아니다(normal)
- `bash scripts/local-ci.sh`, `node tools/browser-check.ts` 는 exclusive
- `pnpm exec vitest run tests/scenario-region.test.cjs` 는 light 에도 맞지만 normal
- `heavy` 설정이 없으면 `pnpm type-check` 도 normal
- `exclusive` 와 `light` 에 함께 맞으면 exclusive
- `heavy.light` 에 `(` 같은 틀린 정규식이 있으면 종료 코드 2 이고 slot 폴더에 등록이 남지 않는다

`wait_idle` 사례(가짜 프로세스는 명령줄에 고유한 표지를 넣은 `node -e` 자식이다):

- 정규식에 맞는 프로세스가 끝날 때까지 자리를 잡지 않고, 끝나면 명령을 실행한다
- 자기 명령줄이 `wait_idle` 에 맞아도 기다리지 않는다
- 다른 heavy-slot 이 자리를 쥐고 정규식에 맞는 명령을 돌려도 그것을 기다리지 않는다
- `HEAVY_IDLE_WAIT=1` 이고 맞는 프로세스가 끝나지 않으면 대기 초과 줄과 종료 코드 124 이고 등록이 지워진다

`orch/tests/lib-config.spec.ts` 에 더한다: `heavy` 절에 네 키가 있으면 `section` 이 통과하고, 모르는 키(`exclusiv`)는 ConfigError 다.
`orch/tests/lib-paths.spec.ts` 의 `boardPath` 사례(기본 위치, 명시한 값, `.omc/handoffs/board.json` 이 있을 때)는 고치지 않고 `defaultBoardPath` 를 거쳐 그대로 통과해야 한다.
`work-board/tests/board.spec.ts` 에 더한다: `defaultBoardPath` 를 import 해도 명령이 돌지 않는다(보드 파일이 생기지 않고 stdout 이 비어 있다). git 밖의 폴더면 그 폴더의 `.omc/board.json` 이다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/heavy-slot.spec.ts orch/tests/mem-gate.spec.ts orch/tests/orch-paths.spec.ts orch/tests/lib-config.spec.ts orch/tests/lib-paths.spec.ts orch/tests/finish-pr.spec.ts orch/tests/board-sync.spec.ts orch/tests/readme-script-list.spec.ts work-board/tests/board.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
claude plugin test .
python3 scripts/run-orch-tests.py --jobs 4
! test -e orch/scripts/live_specs.py
! test -e orch/scripts/orch_process.py
python3 korean-check/scripts/korean-style-check.py orch/README.md orch/references/heavy-checks.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/heavy-slot.ts` | 신규 |
| `orch/scripts/mem-gate.ts` | 신규 |
| `orch/scripts/orch_paths.ts` | 신규 |
| `orch/scripts/heavy-slot.py` | 수정 |
| `orch/scripts/mem-gate.py` | 수정 |
| `orch/scripts/orch_paths.py` | 수정 |
| `orch/scripts/live_specs.py` | 삭제 |
| `orch/scripts/orch_process.py` | 삭제 |
| `orch/scripts/lib/config.ts` | 수정 |
| `orch/scripts/lib/paths.ts` | 수정 |
| `orch/scripts/board-sync.ts` | 수정 |
| `orch/scripts/goal-progress.ts` | 수정 |
| `orch/scripts/handoff-cleanup.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/scripts/merge-with-finish.ts` | 수정 |
| `work-board/bin/board.ts` | 신규 |
| `work-board/bin/board.py` | 수정 |
| `orch/tests/heavy-slot.spec.ts` | 신규 |
| `orch/tests/mem-gate.spec.ts` | 신규 |
| `orch/tests/orch-paths.spec.ts` | 신규 |
| `orch/tests/lib-config.spec.ts` | 수정 |
| `orch/tests/finish-pr.spec.ts` | 수정 |
| `orch/tests/board-sync.spec.ts` | 수정 |
| `work-board/tests/board.spec.ts` | 신규 |
| `orch/tests/test_heavy_slot.py` | 삭제 |
| `orch/tests/test_mem_gate.py` | 삭제 |
| `orch/tests/test_orch_paths.py` | 삭제 |
| `orch/tests/test_live_specs.py` | 삭제 |
| `work-board/tests/test_board.py` | 삭제 |
| `orch/README.md` | 수정 |
| `orch/references/heavy-checks.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/scripts/lib/proc.ts` | 수정 |

## 구현 중 정한 것

- heavy-slot 과 mem-gate 가 함께 쓰는 execvp 대체 `execCommand` 를 `lib/proc.ts` 에 둔다. 실패한 `process.execve` 는 abort 하므로 PATH 에서 먼저 찾고 실행 권한을 확인해 127 과 126 을 낸다.
- `queue.lock` 잠금은 perl 자식이 flock 을 쥐게 한다. Node 에는 flock 이 없다. 옛 heavy-slot.py 와 같은 파일에 같은 종류의 잠금을 걸어, 옮기는 동안 두 버전이 같은 slot 폴더를 써도 서로를 막는다.
- `wait_idle` 은 등록한 뒤 자리를 잡으려 할 때마다 먼저 본다. 시간 초과는 맞는 프로세스를 기다린 시간의 합이다. `HEAVY_POLL` 과 `HEAVY_IDLE_WAIT` 값은 등록 전에 검사해 틀리면 1 이다.
- board.ts 의 단계 번호는 ASCII 숫자만 받는다(register.js 의 STEP 과 같다).
