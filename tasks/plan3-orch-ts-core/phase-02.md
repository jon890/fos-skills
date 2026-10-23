# Phase 02. 경로, 설정, 지시서 모듈을 TypeScript 로 만든다

**Execution profile**: deep

## 목표

`orch_paths.py` 의 경로 규칙, 여러 스크립트에 흩어진 `config.json` 읽기, 지시서의 `브랜치:` 줄 정규식, 지시서 삭제 경로를 `lib/` 의 한 벌로 만든다.
지시서 삭제는 살아 있는 dispatch 를 확인하는 경로 하나만 남긴다.

**범위 외**: 이 모듈을 쓰도록 명령을 바꾸는 일. `orch/scripts/orch_paths.py`, `live_specs.py` 는 아직 Python 명령이 import 하므로 지우지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다. `lib/proc.ts`, `lib/orca.ts`, `lib/git.ts` 를 쓴다.

옮길 원본(경로는 모두 `orch/scripts/` 아래다):

| 새 모듈 | 원본 |
| --- | --- |
| `lib/paths.ts` | `orch_paths.py` 전체. `NAMES`, `FILES`, `DEFAULT_MOVES`, `LEGACY_MARKERS`, `orch_dir`, `path`, `board_path`, `ensure_ignored`, `ensure`, `make_parent`, `legacy_paths`, `require_migrated`, `warn_legacy`. `git_root` 는 phase 01 의 `mainCheckout` 을 쓴다 |
| `lib/config.ts` | `finish-pr.py` 의 `load_config`, `handoff-cleanup.py` 의 `load_config`, `merge-with-finish.py` 의 `load_config` 와 `queue_defaults`. 절마다 아는 키와 모르는 키 거부 |
| `lib/spec.ts` | `브랜치:` 줄 정규식(`finish-pr.py` 와 `handoff-cleanup.py` 의 `BRANCH_LINE`, `make-worktree.py` 의 `re.findall`), `spec-line.py` 의 `PERMISSION`, `live_specs.py` 전체, 지시서 삭제(`finish-pr.py` 의 `delete_specs`, `cleanup-sweep.py` 의 `delete_specs`, `handoff-cleanup.py` 의 `move`) |

`config.json` 의 지금 키는 `orch/references/overlay.md` 의 「마무리 설정 파일」 표가, 더할 절(`hooks`, `pipeline`, `heavy`)과 다음 major 에서 지울 키는 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다.

지시서 삭제 원본은 고르는 방법과 지우는 방법이 서로 다르다. 새 API 는 이 차이를 모두 담는다.

| 원본 | 고르는 방법 | 지우는 방법 |
| --- | --- | --- |
| `finish-pr.py` 의 `delete_specs` | `specs/spec-*.md` 를 읽어 본문의 `브랜치:` 줄에 그 브랜치가 있는 지시서 | 지운다. 살아 있는 dispatch 를 보지 않는다 |
| `cleanup-sweep.py` 의 `delete_specs` | 이름 규칙. 지시서는 `<name>.md`, `spec-<name>.md`. PR 본문은 지시서 폴더의 부모에 있는 `pr-<후보>.md` 이고, 후보는 `name`, 브랜치의 `/` 를 모두 `-` 로 바꾼 것, 브랜치에서 첫 `/` 앞을 뗀 나머지(`branch.split("/", 1)[-1]`), PR 번호다 | 지운다. 살아 있는 지시서는 남긴다 |
| `handoff-cleanup.py` | 오래된 산출물 | 휴지통 폴더로 옮긴다. `<휴지통>/<orch 루트 이름>/<루트 기준 상대경로>` 에 두고, 같은 이름이 있으면 번호를 붙여 덮어쓰지 않는다(`move`, `unique_dest`) |

휴지통으로 옮기는 것은 사용자 결정이다. 지우지 않으므로 되살릴 수 있다(`docs/code-architecture.md` 의 「사용자 결정」 표).

**근거 문서**: `docs/data-schema.md`, `docs/code-architecture.md` 의 「배치」 와 「공통 안전 장치」 의 지시서 삭제 줄, `docs/adr/008-orch-own-dir.md`

## 의도 메모

- 정규식 원본은 받는 꼴이 달랐다. `make-worktree.py` 만 `**브랜치**:` 를 받았다. 합친 정규식은 `브랜치:`, `**브랜치:**`, `**브랜치**:` 와 목록 기호(`-`, `*`)를 모두 받는다. 어느 하나라도 놓치면 그 지시서는 지워지지 않거나 워크트리가 안 만들어진다.
- `BRANCH_LINE` 은 `g` 플래그 없는 `RegExp` 로 export 한다. `g` 플래그가 있으면 `lastIndex` 가 남아 같은 줄을 두 번 검사할 때 결과가 달라진다. 여러 줄은 `branchesOf` 가 줄마다 나눠 검사한다.
- 옛 `finish-pr.py` 의 `delete_specs` 는 `--complete` 에서 살아 있는 지시서 목록을 보지 않고 지웠다. `deleteSpecs` 는 목록을 인자로 받고, 목록이 `null`(조회 실패)이면 지시서와 PR 본문 모두 아무것도 지우지 않는다. 부르는 쪽이 이 확인을 건너뛸 수 없게 시그니처가 강제한다.
  옛 `cleanup-sweep.py` 는 목록이 없어도 PR 본문은 지웠다. 새 함수는 PR 본문도 남긴다. 남은 파일은 다음 정리가 지운다.
- 고르는 일과 지우는 일을 나눈다. 고르는 방법은 원본마다 달라, 부르는 쪽이 `branchesOf` 나 `specCandidates` 로 경로를 정하고 `deleteSpecs` 는 받은 경로만 다룬다. `specCandidates` 는 파일 시스템을 보지 않는 순수 함수라 이름 규칙을 테스트로 고정할 수 있다.
- `mode` 의 휴지통은 handoff-cleanup 의 결정을 지키는 자리다. 뒤 plan 이 handoff-cleanup 을 이 API 로 옮길 때 `{ trash }` 를 주면 되살릴 수 없는 삭제가 되지 않는다.
- `liveSpecPaths` 는 `live_specs.py` 를 그대로 옮기지 않는다. 원본은 `worker-list` 의 첫 페이지(최대 100행)만 읽고, `run` 이 없으면 부른 터미널에 묶인 Run 만 본다. 지시서 폴더는 저장소마다 하나라 다른 Run 의 살아 있는 지시서를 지울 수 있다.
  `orca orchestration worker-list` 의 동작은 아래와 같다.
  - 범위 플래그 없이 부르면 부른 터미널에 묶인 Run 만 준다(`scope.source` 가 `bound`). 모든 Run 이면 `all`, `--run` 을 주면 `flag` 다.
  - `ORCA_TERMINAL_HANDLE` 을 환경에서 빼도 범위가 넓어지지 않는다.
  - 결과는 100행씩 나뉜다. `--limit 100` 으로 부르고 `page.nextCursor` 를 `--cursor` 로 넘겨 끝까지 읽는다.
- 설정 키의 하이픈과 밑줄 규칙(키 이름은 옵션 이름의 하이픈을 밑줄로 바꾼 것)은 그대로 둔다.
- 모르는 최상위 절도 `ConfigError` 다. 원본은 자기 절만 읽고 나머지 절을 보지 않아, 절 이름의 오타(`queu`)가 조용히 무시됐다.

## 작업 항목

### 1. `orch/scripts/lib/paths.ts`

`orch_paths.py` 와 같은 이름과 판정을 낸다. 아래를 export 한다.

| export | 원본 |
| --- | --- |
| `NAMES: Readonly<Record<string, string>>` | `NAMES`. `hooks`(`hooks`)와 `hooks-state`(`state/hooks`)를 더한다 |
| `FILES: ReadonlySet<string>` | `FILES`(폴더가 아니라 파일인 이름) |
| `DEFAULT_MOVES`, `LEGACY_MARKERS` | 같은 이름 |
| `orchDir(repo)` | `orch_dir`. `ORCH_DIR` 이 상대경로면 주 checkout 기준 |
| `pathOf(name, repo)` | `path`. 모르는 이름은 `Error` |
| `boardPath(repo, explicit?)` | `board_path` |
| `ensureIgnored(repo): string \| null` | `ensure_ignored`. 더한 줄이나 null |
| `ensure(name, repo): string` | `ensure` |
| `makeParent(target, repo): void` | `make_parent` |
| `legacyPaths(repo): string[]` | `legacy_paths`(안에 파일이 있는 폴더만 센다) |
| `requireMigrated(repo, script, bypass?): boolean` | `require_migrated`. 같은 안내 줄을 stderr 로 낸다 |
| `warnLegacy(repo, script): void` | `warn_legacy` |

`boardPath` 는 지금처럼 work-board 의 규칙을 따르되 `work-board/bin/board.py` 를 import 하지 않고 그 규칙을 옮긴다. 옮긴 규칙의 원본 위치를 주석으로 남긴다.
`requireMigrated` 가 안내하는 옮기는 명령은 지금처럼 `orch/scripts/migrate-orch-dir.py` 다.

### 2. `orch/scripts/lib/config.ts`

```ts
export type Section = 'finish' | 'cleanup' | 'queue' | 'hooks' | 'pipeline' | 'heavy'
export class ConfigError extends Error {}
export function loadConfig(repo: string, opts?: { file?: string }): Partial<Record<Section, Record<string, unknown>>>
export function section<T>(config: Partial<Record<Section, Record<string, unknown>>>, name: Section, known: readonly string[]): T
export const HOOKS_KEYS: readonly string[]
export const DEPRECATED_KEYS: ReadonlyArray<{ section: Section; key: string; event: string }>
```

- 파일이 없으면 빈 객체다. JSON 이 깨졌거나, 최상위가 객체가 아니거나, `Section` 에 없는 최상위 절이 있거나, 절이 객체가 아니면 `ConfigError` 다.
- `section` 은 `known` 에 없는 키가 있으면 `ConfigError` 다. `finish`, `cleanup`, `queue`, `pipeline`, `heavy` 의 아는 키는 그 절을 읽는 명령이 넘긴다(원본도 argparse 의 옵션 목록에서 만든다).
- `hooks` 절의 아는 키는 `config.ts` 의 `HOOKS_KEYS` 가 선언한다. 값은 `docs/data-schema.md` 의 「config.json 에 더하는 절」 의 `hooks` 줄과 같다. 이벤트 실행기가 이 값을 쓴다.
- 명령은 `ConfigError` 를 사용법 오류(종료 코드 2)로 바꾼다.
- `DEPRECATED_KEYS` 는 `docs/data-schema.md` 의 「다음 major 에서 지우는 키」 표와 같은 값이다.

### 3. `orch/scripts/lib/spec.ts`

```ts
export const BRANCH_LINE: RegExp
export function branchesOf(text: string): string[]
export function permissionsOf(text: string): string[]
export function liveSpecPaths(run: string | null): Set<string> | null
export function specCandidates(opts: { specsDir: string; name: string; branch?: string; prNumber?: number }): { specs: string[]; prBodies: string[] }
export function deleteSpecs(opts: {
  root: string; specs: string[]; prBodies: string[]; live: Set<string> | null;
  mode: 'delete' | { trash: string }; apply: boolean; log: (line: string) => void
}): { removed: string[]; kept: { path: string; reason: string }[] }
```

`liveSpecPaths`:

- 살아 있는 것의 판정은 `live_specs.py` 와 같다. `task-list` 의 status 가 pending, dispatched, running 인 Task 와, `worker-list` 의 dispatchStatus 가 그 셋인 dispatch 의 Task 다. 그 Task 의 spec 줄에서 `/` 로 시작하고 `.md` 로 끝나는 경로를 realpath 로 모은다.
- `worker-list` 는 `--limit 100` 으로 부르고 `page.nextCursor` 가 없을 때까지 `--cursor` 로 이어 읽는다. `task-list` 도 응답에 `page.nextCursor` 가 있으면 같은 방식으로 끝까지 읽는다.
- `run` 이 있으면 두 조회에 `--run <run>` 을 준다. `run` 이 null 이면 범위 없이 부르고, `worker-list` 응답의 `scope.source` 가 `all` 이 아니면 null 을 낸다(판정 불가). 부른 터미널에 묶인 Run 만 본 결과로는 다른 Run 의 지시서를 지켜 주지 못한다.
- 조회가 하나라도 실패하면(`orcaJson` 의 `ok: false`, 중간 페이지 실패 포함) null 이다.

`specCandidates` 는 `cleanup-sweep.py` 의 이름 규칙을 옮긴 순수 함수다. 파일이 있는지 보지 않는다.

- `specs` 는 `<specsDir>/<name>.md`, `<specsDir>/spec-<name>.md` 다.
- `prBodies` 는 `<specsDir 의 부모>/pr-<후보>.md` 이고, 후보는 `name`, `branch` 의 `/` 를 모두 `-` 로 바꾼 것(`replaceAll`), `branch` 에서 첫 `/` 앞을 뗀 나머지, `prNumber` 다. 겹치는 경로는 한 번만 낸다.

`deleteSpecs` 는 받은 경로만 다룬다. 어떤 파일을 고르는지는 부르는 쪽이 정한다. `finish-pr` 처럼 본문으로 고르면 `branchesOf`, `cleanup-sweep` 처럼 이름으로 고르면 `specCandidates` 를 쓴다.

- 없는 파일은 건너뛴다. `removed` 에도 `kept` 에도 넣지 않는다.
- `live` 가 null 이면 지시서와 PR 본문 모두 `kept`(이유: 살아 있는 지시서 목록을 읽지 못했다)다.
- realpath 가 `live` 에 든 지시서는 `kept`(이유: 살아 있는 dispatch 가 쓴다)다.
- `root` 는 orch 루트다. `root` 밖의 경로는 `kept`(이유: orch 루트 밖이다)다.
- `mode` 가 `'delete'` 면 지운다. `{ trash }` 면 `<trash>/<root 의 폴더 이름>/<root 기준 상대경로>` 로 옮기고, 같은 이름이 있으면 `<이름>.2`, `<이름>.3` 처럼 번호를 붙여 덮어쓰지 않는다(`handoff-cleanup.py` 의 `unique_dest` 와 같은 규칙).
- `apply` 가 false 면 파일을 건드리지 않고, 할 일을 `log` 로만 낸다. `removed` 에는 할 일의 경로가 든다.

### 4. 이 phase 의 테스트

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `orch/tests/lib-paths.spec.ts` | 워크트리에서 불러도 주 checkout 의 `.orch` 다. `ORCH_DIR` 상대경로. `ensure` 가 `info/exclude` 에 한 줄만 더한다. `makeParent` | 옛 위치에 파일이 있으면 `requireMigrated` 가 옮기는 명령과 함께 false. 빈 옛 폴더는 `legacyPaths` 에 없다 |
| `orch/tests/lib-config.spec.ts` | 지금 절(`finish`, `cleanup`, `queue`)과 새 절을 읽는다. 파일이 없으면 빈 객체. `hooks.timeouts` 가 `HOOKS_KEYS` 로 통과한다 | 모르는 키, 모르는 최상위 절, 깨진 JSON 이 `ConfigError` |
| `orch/tests/lib-spec.spec.ts` | 목록 기호와 굵은 글씨를 섞은 `브랜치:` 줄의 모든 꼴. `BRANCH_LINE` 을 같은 줄에 두 번 써도 같은 결과. 허락 줄 여러 개. `specCandidates` 가 `spec-<name>.md` 와 브랜치, PR 번호 후보를 낸다. `spec-<name>.md` 를 고른 `deleteSpecs` 가 살아 있는 지시서를 빼고 지운다. `{ trash }` 모드가 파일을 휴지통의 `<루트 이름>/<상대경로>` 로 옮기고 같은 이름에 번호를 붙인다 | `live` 가 null 이면 아무것도 지우지 않는다. 살아 있는 지시서는 `kept`. `worker-list` 가 `nextCursor` 로 두 페이지를 주면 둘째 페이지의 지시서도 살아 있다. 둘째 페이지 조회가 실패하면 null. `run` 이 null 이고 `scope.source` 가 `bound` 면 null |

`liveSpecPaths` 사례는 phase 01 의 `orch/tests/fixtures/fake-bin.ts` 로 가짜 `orca` 를 만들고 `ORCA` 로 준다. `lib-paths.spec.ts` 는 git 을 부를 때 `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` 을 준다.
`orch/tests/test_orch_paths.py`, `test_live_specs.py` 의 사례를 읽고 같은 입력을 옮긴다. 단 `live_specs.py` 의 첫 페이지만 읽는 동작과 범위 없는 조회를 믿는 동작은 옮기지 않는다. Python 테스트는 지우지 않는다. 원본이 아직 쓰인다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-paths.spec.ts orch/tests/lib-config.spec.ts orch/tests/lib-spec.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/paths.ts` | 신규 |
| `orch/scripts/lib/config.ts` | 신규 |
| `orch/scripts/lib/spec.ts` | 신규 |
| `orch/tests/lib-paths.spec.ts` | 신규 |
| `orch/tests/lib-config.spec.ts` | 신규 |
| `orch/tests/lib-spec.spec.ts` | 신규 |
