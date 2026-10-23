# Phase 03. 이벤트 실행기와 핸들러용 가드 shim 을 만든다

**Execution profile**: deep

## 목표

명령이 `await fire('before-merge', input, ctx)` 한 줄로 저장소의 핸들러를 부르게 하는 실행기를 만든다.
핸들러 찾기, 잠금, 시간 제한, 실행 기록, 종료 코드 해석, 가드 환경을 이 모듈 한 곳이 소유한다.

**범위 외**: 명령에서 이벤트를 내는 일. 그 일은 명령을 전환하는 plan 들이 한다. 옛 설정 칸을 핸들러로 돌리는 어댑터(`legacy`)는 여기서 만들지만, 그 칸을 읽어 argv 로 넘기는 일은 머지 명령 plan 이 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다. `lib/proc.ts`, `lib/paths.ts`, `lib/config.ts`, `lib/process.ts` 를 쓴다.

핸들러 계약(위치, 이벤트당 한 파일, 실행 명령, 작업 디렉터리, stdin JSON, 환경, 출력 접두, 거부 이유, 시간 제한 기본값, 잠금과 대기, 종료 코드 0·10·그 밖, 공통 필드, 기록 파일과 회전)은 `docs/data-schema.md` 의 「orch 이벤트 핸들러 입력」 이 소유한다. 그 표의 값을 그대로 구현한다.
이벤트 이름, 거부할 수 있는지, 실패 때의 갈래는 `docs/flow.md` 의 「이벤트 목록」 과 「갈래」 가 소유한다.
가드 shim 이 거부할 호출은 `docs/code-architecture.md` 의 「공통 안전 장치」 가 정하고, 이 phase 가 그 표를 아래 거부 표에 맞게 고친다.

옛 설정 칸의 원본 실행 방식은 서로 다르다. `queue.before`, `queue.verify_merged`, `queue.after_merged` 는 `bash -c` 로 돌고(`orch/scripts/merge_queue.py`), `finish.complete_cmd` 는 셸 없이 `shlex.split` 으로 나눠 돈다(`orch/scripts/finish-pr.py` 의 `complete_argv`). 그래서 `legacy` 는 문자열이 아니라 argv 를 받는다.

**근거 문서**: `docs/data-schema.md` 의 「orch 이벤트 핸들러 입력」 과 「orch 루트에 더하는 파일」, `docs/flow.md` 의 「orch 이벤트」, `docs/code-architecture.md` 의 「공통 안전 장치」, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 거부를 10 으로 둔 이유: node 는 잡지 않은 예외에 1 을 낸다. 1 을 거부로 읽으면 죽은 핸들러를 의도한 거부로 보고하게 된다.
- 거부할 수 있는 이벤트의 실패는 거부처럼 멈춘다. 모르는 실패로 머지하거나 지우는 것보다 멈추는 쪽이 안전하다.
- `fire` 는 비동기(`spawn`)다. 동기 `spawnSync` 로는 계약을 지킬 수 없다(Node 22.18 실측).
  TERM 을 무시하는 자식이 있으면 `spawnSync` 는 시간 제한이 지나도 자식이 스스로 끝날 때까지 돌아오지 않아 「TERM, 10초 뒤 KILL」 을 구현할 수 없다.
  출력 한도(`maxBuffer`)를 넘으면 자식이 죽는다. 1800초짜리 `verify-merged` 의 로컬 CI 출력은 이 한도를 쉽게 넘는다. 줄을 그때그때 `out` 으로 옮길 수도 없다.
- 핸들러는 `detached: true` 로 띄워 새 프로세스 그룹을 만들고, 시간을 넘기면 `process.kill(-pid, 'SIGTERM')` 으로 그룹 전체에 TERM 을 보낸다. 10초 뒤에도 그룹이 살아 있으면 `process.kill(-pid, 'SIGKILL')` 이다. 핸들러가 띄운 `bash -c` 의 손자 프로세스가 남지 않게 하기 위해서다.
- 출력은 메모리에 모으지 않는다. stdout 과 stderr 를 줄 단위로 나눠 바로 `out` 으로 흘리고, 출력 크기에 한도를 두지 않는다. 부르는 명령이 그 줄을 자기 기록 파일에 쓴다. 거부 이유를 위해 stdout 의 마지막 빈 줄 아닌 줄만 기억한다.
- 가드 shim 은 PATH 앞 폴더의 확장자 없는 파일이다. Node 는 확장자 없는 파일을 CommonJS 로 읽어 타입 문법을 지우지 않는다. shim 은 타입 문법 없이 `import()` 로 `guard.ts` 를 부른다.
- 가드는 실수를 막는 장치이고 보안 경계가 아니다. 진짜 실행 파일의 경로(`ORCH_REAL_ORCA`, `ORCH_REAL_GH`)가 핸들러 환경에 보이므로, 핸들러가 일부러 그 경로를 부르면 우회된다. 막는 것은 핸들러 작성자가 `gh pr merge` 같은 코어 전용 호출을 모르고 쓰는 경우다. `docs/adr/009-orch-event-handlers.md` 의 「우회하지 못한다」 문장을 이 뜻으로 고친다.
- 진짜 실행 파일은 실행기가 가드 폴더를 PATH 앞에 넣기 전에 찾아 둔다. `orcaBin()`, `ghBin()` 의 기본값 `orca`, `gh` 는 경로가 아니라 이름이라, 그대로 넘기면 shim 이 PATH 맨 앞의 자기 자신을 다시 불러 node 프로세스가 끝없이 생긴다.
  `/` 가 든 값은 절대경로로 바꾸고, 이름이면 지금의 PATH 를 앞에서부터 보며 가드 폴더가 아닌 곳의 실행 파일을 고른다. 찾지 못하면 그 변수를 넘기지 않는다. shim 은 `ORCH_REAL_*` 가 없거나, 절대경로가 아니거나, realpath 가 가드 폴더 안이면 126 으로 거부한다.
- `terminal send` 는 핸들러에서 대상과 무관하게 모두 거부한다. 핸들러는 worker 에게 쓸 일이 없다. worker 에게 보내는 일은 코어 명령(`send-to-worker`)이 한다. 또 대상이 worker 터미널인지 판정하려면 shim 안에서 orca 를 다시 조회해야 하고, 그 조회가 실패하면 결국 거부해야 한다. PreToolUse hook 은 코디네이터가 쓰는 자리라 대상을 보고 판정한다. 두 자리의 규칙이 다른 것은 이 때문이다.
- `unknownHandlers` 는 `hooks/` 바로 아래 파일만 본다. 하위 폴더는 보지 않는다. 핸들러가 import 하는 모듈은 하위 폴더(예: `hooks/lib/`)에 두는 자리라, 그 파일에 `UNKNOWN-HOOK` 경고를 내면 안 된다.

## 작업 항목

### 1. `orch/scripts/lib/events.ts`

```ts
export const EVENTS: Readonly<Record<string, { rejectable: boolean; timeoutSec: number }>>
export type FireResult = { result: 'none' | 'pass' | 'reject' | 'fail' | 'timeout'; code: number | null; reason: string; durationMs: number }
export type FireContext = {
  repo: string; base: string; run: string | null; cwd?: string;
  legacy?: { key: string; argv: string[]; env: Record<string, string> };
  out?: (line: string) => void
}
export function fire(event: string, input: Record<string, unknown>, ctx: FireContext): Promise<FireResult>
export function unknownHandlers(repo: string): string[]
```

핸들러 찾기와 실행:

- `EVENTS` 는 `docs/flow.md` 의 이벤트 목록 전부다. 시간 제한 기본값은 `docs/data-schema.md` 의 값이고 `config.json` 의 `hooks.timeouts` 가 덮는다(`lib/config.ts` 의 `HOOKS_KEYS` 로 읽는다)
- 핸들러는 `pathOf('hooks', repo)/<이벤트>.ts` 다. `node --disable-warning=ExperimentalWarning <파일>` 로 띄우고 stdin 에 `input` 을 JSON 으로 쓴다. 작업 디렉터리는 `ctx.cwd`, 없으면 주 checkout 이다
- 핸들러 파일과 `legacy` 가 함께 있으면 `ConfigError` 를 던진다. 명령은 사용법 오류(종료 코드 2)로 바꾼다
- 핸들러가 없고 `legacy` 도 없으면 `none` 이다
- 핸들러가 없고 `legacy` 가 있으면 `legacy.argv` 를 셸 없이 그대로 띄운다. 셸이 필요한 옛 칸은 부르는 쪽이 `['bash', '-c', 명령]` 을 넘기고, `finish.complete_cmd` 는 `shlex` 식으로 나눈 argv 를 넘긴다. PR 제목에서 뽑은 값이 셸에 들어가지 않게 하기 위해서다
  - `legacy.env` 를 핸들러 환경 위에 덮는다. 가드 PATH, `ORCA`, `GH` 도 핸들러와 같다
  - 시간 제한, 잠금, 기록, 종료 코드 해석, 출력 접두가 핸들러와 같다
  - 실행 전에 `DEPRECATED <legacy.key> → hooks/<이벤트>.ts` 한 줄을 `out` 으로 낸다. `key` 는 설정 키 이름(예: `queue.before`, `finish.complete_cmd`)이다. `after-deploy` 처럼 한 이벤트에 키가 여럿이어도 부르는 쪽이 실제로 쓴 키를 넘긴다

핸들러 환경:

- `process.env` 위에 `ORCH_EVENT`, `ORCH_REPO`(주 checkout), `ORCH_DIR`(orch 루트 절대경로)을 둔다
- `PATH` 맨 앞에 가드 폴더(`orch/scripts/lib/guard` 의 절대경로)를 넣는다. 넣기 전에 진짜 `orca`, `gh` 의 절대경로를 찾아 `ORCH_REAL_ORCA`, `ORCH_REAL_GH` 로 준다(찾는 규칙은 「의도 메모」)
- `ORCA`, `GH` 는 가드 폴더의 `orca`, `gh` shim 의 절대경로다

시간 제한과 출력:

- 자식은 `detached: true` 로 띄운다. 시간을 넘기면 그룹에 TERM(`process.kill(-pid, 'SIGTERM')`), 10초 뒤에도 살아 있으면 그룹에 KILL 이다. 결과는 `timeout`, `code` 는 null 이다
- 출력 줄은 `out` 으로 보낸다. 기본은 `process.stdout` 에 한 줄씩 쓴다. 핸들러의 stdout 과 stderr 줄에 `[hook <이벤트>] ` 를 붙인다. 출력을 메모리에 모으지 않는다
- 결과마다 `HOOK-REJECT <이벤트> <이유>` 나 `HOOK-FAIL <이벤트> <종료 코드|timeout|lock>` 줄을 낸다. `pass` 와 `none` 은 줄을 내지 않는다
- 거부 이유는 stdout 의 마지막 빈 줄 아닌 줄이다

잠금(값은 `docs/data-schema.md` 의 「위치와 실행」 의 「동시 실행」 줄):

- 잠금 파일은 `pathOf('hooks-state', repo)/<이벤트>.lock` 이다. `fs.openSync(path, 'wx')` 로 배타 생성하고 자기 pid 를 쓴다
- 이미 있으면 안의 pid 를 읽는다. `alive` 가 false(죽은 pid, 깨진 내용 포함)면 회수한다. 회수는 다시 읽은 pid 가 처음 읽은 값과 같을 때만 지우고, 지운 뒤 다시 `wx` 로 만든다. 두 실행이 함께 회수해도 `wx` 가 한쪽만 통과시킨다
- 살아 있으면 0.5초 간격으로 다시 보며, 그 이벤트의 시간 제한에 15초를 더한 만큼 기다린다. 넘으면 `fail`(이유: 잠금을 얻지 못했다)과 `HOOK-FAIL <이벤트> lock` 이다
- 실행이 끝나면(예외를 포함해 `finally` 에서) 자기 pid 가 든 잠금만 지운다

기록:

- `pathOf('state', repo)/hooks.jsonl` 에 결과마다 한 줄(`time`, `event`, `handler`, `exit`, `result`, `duration_ms`, `reason`)을 더한다. `none` 은 적지 않는다. `legacy` 실행의 `handler` 는 `legacy:<key>` 다
- 더하기 전에 파일이 1MB(1048576바이트)를 넘으면 `hooks.jsonl.1` 로 옮긴다(있던 `.1` 은 덮는다)

`unknownHandlers`:

- `hooks/` 바로 아래의 `.ts` 파일 가운데 이름이 `EVENTS` 에 없는 것의 경로를 낸다. 하위 폴더와 그 안의 파일은 보지 않는다. doctor 가 `UNKNOWN-HOOK` 경고에 쓴다

### 2. 가드 shim `orch/scripts/lib/guard/orca`, `orch/scripts/lib/guard/gh`, `orch/scripts/lib/guard/guard.ts`

`guard.ts` 의 `check(tool: 'orca' | 'gh', argv: string[]): string | null` 이 거부 이유나 null 을 낸다.

하위 명령 찾기:

- argv 에서 플래그를 건너뛰고 위치 인자(positional)만 모아 하위 명령을 정한다. `gh pr -R o/r merge 1` 과 `gh -R o/r pr merge 1` 이 모두 `pr merge` 다
- `-` 로 시작하는 낱말은 플래그다. `--name=value` 꼴은 한 낱말이다. 값을 받는 플래그는 다음 낱말도 건너뛴다. gh 는 `-R`, `--repo`, `--hostname`, api 의 `-X`, `--method`, `-H`, `--header`, `-f`, `--raw-field`, `-F`, `--field`, `-q`, `--jq`, `-t`, `--template`, `--input`, `-p`, `--preview`, `--cache` 를 값 받는 플래그로 본다
- orca 는 위치 인자 가운데 `terminal` 바로 뒤에 `send` 가 오면 거부한다. 앞에 다른 위치 인자가 와도 같다

| 도구 | 거부 |
| --- | --- |
| orca | `terminal send`. 대상과 무관하다 |
| gh | `pr merge`, `pr update-branch` |
| gh | `api` 의 경로가 `repos/<o>/<r>/pulls/<번호>/update-branch` 다. 메서드와 무관하다 |
| gh | `api` 의 경로가 `repos/<o>/<r>/pulls/<번호>/merge` 이고 메서드가 GET 이 아니다(PUT 이 PR 머지다). 메서드는 `-X`/`--method` 값이고, 없으면 `-f`/`-F`/`--field`/`--raw-field`/`--input` 이 있을 때 POST, 아니면 GET 이다(gh api 의 규칙) |
| gh | `api` 의 경로가 `/merges` 로 끝난다(브랜치 merge API) |
| gh | `api graphql` 의 인자에 `mergePullRequest`, `updatePullRequestBranch`, `enablePullRequestAutoMerge` 가 든다. `--input` 을 주면 내용을 확인할 수 없어 거부한다 |

api 경로는 앞의 `/` 를 떼고 비교한다. 경로에 `{owner}` 같은 gh 자리 표시자가 있어도 같은 꼴로 본다.

거부하면 stderr 에 이유와 「코어 명령을 쓴다」 를 내고 종료 코드 126 이다.
`ORCH_REAL_ORCA` 나 `ORCH_REAL_GH` 가 없거나, 절대경로가 아니거나, realpath 가 가드 폴더 안이면 이유와 함께 126 이다.
통과면 그 진짜 실행 파일을 같은 인자와 stdin 으로 실행하고 그 종료 코드를 낸다.
두 shim 파일은 실행 권한을 준다(`git update-index --chmod=+x`).

### 3. 근거 문서 고치기

- `docs/adr/009-orch-event-handlers.md` 의 「결과」 의 「핸들러는 가드 shim 을 거친 `orca` 와 `gh` 만 받아, 코어의 보호 장치를 우회하지 못한다」 를 아래 뜻으로 바꾼다. 핸들러가 부르는 `orca` 와 `gh` 는 가드 shim 을 거쳐 머지, base 합치기, 터미널 입력 같은 코어 전용 호출을 실수로 부르지 못한다. 가드는 실수 방지 장치이고 보안 경계가 아니다. 진짜 실행 파일의 경로가 핸들러 환경에 보인다
- `docs/code-architecture.md` 의 「공통 안전 장치」 표를 고친다
  - 「worker 터미널 직접 입력 금지」 줄: PreToolUse hook 은 대상이 worker 터미널이면 거부하고, 가드 shim 은 핸들러의 `terminal send` 를 대상과 무관하게 거부한다고 나눠 적는다
  - 「머지와 base 합치기는 코어만」 줄: 가드가 거부하는 호출에 PR 머지 API(`pulls/<번호>/merge`)와 GraphQL 의 머지, 브랜치 갱신, 자동 머지 mutation 을 더한다

### 4. 이 phase 의 테스트

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `orch/tests/lib-events.spec.ts` | 핸들러 없음은 `none`. 0 은 `pass`, 입력 JSON 이 핸들러 stdin 에 간다. 기록 한 줄 | 거부할 수 있는 이벤트의 10 은 `reject` 와 마지막 stdout 줄이 이유. 거부할 수 없는 이벤트의 10 은 `fail`. 핸들러와 `legacy` 가 함께면 `ConfigError`. 모르는 핸들러 이름 |
| `orch/tests/lib-events.spec.ts`(시간 제한) | TERM 에 끝나는 핸들러가 1초 제한에 `timeout` | TERM 을 무시하는 핸들러(`process.on('SIGTERM', () => {})`)가 1초 제한 뒤 KILL 로 끝나 `timeout`. 그 핸들러가 띄운 손자 프로세스(`sleep 60`)도 `alive` 가 false |
| `orch/tests/lib-events.spec.ts`(잠금) | 죽은 pid 가 든 잠금 파일을 회수하고 바로 돈다. 실행 뒤 잠금 파일이 없다 | 살아 있는 자식 pid 가 든 잠금이 있으면 기다린다. 테스트가 그 잠금을 지우면 그 뒤에 핸들러가 돈다(핸들러 시작 시각이 지운 시각보다 늦다) |
| `orch/tests/lib-events.spec.ts`(기록과 출력) | 핸들러의 stdout 줄과 stderr 줄이 모두 `[hook <이벤트>] ` 로 시작해 `out` 에 온다 | 미리 1MB 를 넘게 채운 `hooks.jsonl` 이 `hooks.jsonl.1` 로 옮겨지고 새 파일에 한 줄만 있다 |
| `orch/tests/lib-events.spec.ts`(환경과 legacy) | 핸들러 환경의 `PATH` 첫 폴더가 가드 폴더, `ORCA` 와 `GH` 가 shim 의 절대경로, `ORCH_REAL_*` 가 가드 폴더 밖의 절대경로, `ORCH_EVENT`·`ORCH_REPO`·`ORCH_DIR` | 핸들러 없이 `legacy` 만 주면 `DEPRECATED <key> → hooks/<이벤트>.ts` 줄, `legacy.env` 가 자식에 보이고, 1초 제한을 넘기면 `timeout` |
| `orch/tests/lib-guard.spec.ts` | 허용 호출(`gh pr view 1`, `gh api repos/o/r/pulls/1/merge`(GET), `gh api graphql -f query={viewer{login}}`, `orca terminal list`)이 진짜 실행 파일(가짜 bin)에 그대로 간다 | 거부 표의 호출마다 126 과 진짜 실행 파일이 불리지 않음. `gh pr -R o/r merge 1`, `gh api -X PUT repos/o/r/pulls/1/merge`, `mergePullRequest` 를 담은 `api graphql` 이 거부된다. `ORCH_REAL_GH` 가 상대경로이거나 가드 폴더의 `gh` 를 가리키면 126 |

시간 제한 테스트는 `hooks.timeouts` 로 1초를 준다. TERM 을 무시하는 사례는 KILL 유예 10초를 기다리므로 그 테스트의 timeout 을 30초로 둔다.
가짜 `orca`, `gh` 는 phase 01 의 `orch/tests/fixtures/fake-bin.ts` 로 만들고 PATH 와 `ORCA`, `GH` 로 준다.

### 5. `orch/CHANGELOG.md` 와 `orch/SKILL.md` 의 `metadata.version`

이 plan 의 phase 들을 한 항목으로 적는다. 코디네이터 지시가 바뀌지 않으므로 patch 를 올린다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-events.spec.ts orch/tests/lib-guard.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
test -x orch/scripts/lib/guard/orca && test -x orch/scripts/lib/guard/gh
! grep -n "우회하지 못한다" docs/adr/009-orch-event-handlers.md
claude plugin test .
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/events.ts` | 신규 |
| `orch/scripts/lib/guard/orca` | 신규 |
| `orch/scripts/lib/guard/gh` | 신규 |
| `orch/scripts/lib/guard/guard.ts` | 신규 |
| `orch/tests/lib-events.spec.ts` | 신규 |
| `orch/tests/lib-guard.spec.ts` | 신규 |
| `docs/adr/009-orch-event-handlers.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/SKILL.md` | 수정 |
