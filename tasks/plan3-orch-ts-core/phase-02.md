# Phase 02. 경로, 설정, 지시서 모듈을 TypeScript 로 만든다

**Execution profile**: deep

## 목표

`orch_paths.py` 의 경로 규칙, 스크립트 셋에 흩어진 `config.json` 읽기, 지시서의 `브랜치:` 줄 정규식 세 벌, 지시서 삭제 경로 세 벌을 `lib/` 의 한 벌로 만든다.
지시서 삭제는 살아 있는 dispatch 를 확인하는 경로 하나만 남긴다.

**범위 외**: 이 모듈을 쓰도록 명령을 바꾸는 일. `orch/scripts/orch_paths.py`, `live_specs.py` 는 아직 Python 명령이 import 하므로 지우지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다. `lib/proc.ts`, `lib/orca.ts`, `lib/git.ts` 를 쓴다.

옮길 원본:

| 새 모듈 | 원본 |
| --- | --- |
| `lib/paths.ts` | `orch/scripts/orch_paths.py` 전체. `NAMES`, `FILES`, `DEFAULT_MOVES`, `LEGACY_MARKERS`, `orch_dir`, `path`, `board_path`, `ensure_ignored`, `require_migrated` |
| `lib/config.ts` | `finish-pr.py` 의 `load_config`, `handoff-cleanup.py` 의 `load_config`, `merge-with-finish.py` 의 `load_config`. 절마다 아는 키와 모르는 키 거부 |
| `lib/spec.ts` | `브랜치:` 줄 정규식 세 벌(`finish-pr.py` 와 `handoff-cleanup.py` 의 `BRANCH_LINE`, `make-worktree.py` 의 `re.findall`), `spec-line.py` 의 `PERMISSION`, `live_specs.py` 전체, 지시서 삭제 세 벌(`finish-pr.py` 의 `delete_specs`, `cleanup-sweep.py` 의 `delete_specs`, `handoff-cleanup.py` 의 지시서 옮기기) |

`config.json` 의 지금 키는 `orch/references/overlay.md` 의 「마무리 설정 파일」 표가, 더할 절(`hooks`, `pipeline`, `heavy`)과 다음 major 에서 지울 키는 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다.

**근거 문서**: `docs/data-schema.md`, `docs/code-architecture.md` 의 「배치」 와 「공통 안전 장치」 의 지시서 삭제 줄, `docs/adr/008-orch-own-dir.md`

## 의도 메모

- 정규식 세 벌은 받는 꼴이 달랐다. `make-worktree.py` 만 `**브랜치**:` 를 받았다. 합친 정규식은 세 꼴(`브랜치:`, `**브랜치:**`, `**브랜치**:`)과 목록 기호를 모두 받는다. 어느 하나라도 놓치면 그 지시서는 지워지지 않거나 워크트리가 안 만들어진다.
- 옛 `finish-pr.py` 의 `delete_specs` 는 `--complete` 에서 살아 있는 지시서 목록을 보지 않고 지웠다. `deleteSpecs` 는 목록을 인자로 받고, 목록이 `null`(조회 실패)이면 아무것도 지우지 않는다. 부르는 쪽이 이 확인을 건너뛸 수 없게 시그니처가 강제한다.
- 설정 키의 하이픈과 밑줄 규칙(키 이름은 옵션 이름의 하이픈을 밑줄로 바꾼 것)은 그대로 둔다.

## 작업 항목

### 1. `orch/scripts/lib/paths.ts`

`orch_paths.py` 와 같은 이름과 판정을 낸다. `orchDir(repo)`, `pathOf(name, repo)`, `boardPath(repo, explicit)`, `ensure(name, repo)`, `requireMigrated(repo)`, `DEFAULT_MOVES`, `LEGACY_MARKERS` 를 export 한다.
`NAMES` 에 `hooks`(`hooks/`)와 `hooks-state`(`state/hooks/`)를 더한다. `boardPath` 는 지금처럼 work-board 의 규칙을 따르되 `work-board/bin/board.py` 를 import 하지 않고 그 규칙을 옮긴다. 옮긴 규칙의 원본 위치를 주석으로 남긴다.

### 2. `orch/scripts/lib/config.ts`

```ts
export type Section = 'finish' | 'cleanup' | 'queue' | 'hooks' | 'pipeline' | 'heavy'
export class ConfigError extends Error {}
export function loadConfig(repo: string, opts?: { file?: string }): Partial<Record<Section, Record<string, unknown>>>
export function section<T>(config, name: Section, known: readonly string[]): T
export const DEPRECATED_KEYS: ReadonlyArray<{ section: Section; key: string; event: string }>
```

파일이 없으면 빈 객체다. JSON 이 깨졌거나 모르는 키가 있으면 `ConfigError` 다. 명령은 이 오류를 사용법 오류(종료 코드 2)로 바꾼다.
`DEPRECATED_KEYS` 는 `docs/data-schema.md` 의 「다음 major 에서 지우는 키」 표와 같은 값이다.

### 3. `orch/scripts/lib/spec.ts`

```ts
export const BRANCH_LINE: RegExp
export function branchesOf(text: string): string[]
export function permissionsOf(text: string): string[]
export function liveSpecPaths(run: string | null): Set<string> | null
export function deleteSpecs(opts: { specsDir: string; names: string[]; live: Set<string> | null; apply: boolean; log: (line: string) => void }): { deleted: string[]; kept: { path: string; reason: string }[] }
```

`liveSpecPaths` 는 `live_specs.py` 와 같은 판정이다. 조회가 하나라도 실패하면 null 이다.
`deleteSpecs` 는 지시서 `<name>.md` 와 그 부모 폴더의 `pr-<name>.md` 를 다룬다. `live` 가 null 이면 모두 `kept`(이유: 살아 있는 지시서 목록을 읽지 못했다)다.

### 4. 이 phase 의 테스트

| 파일 | 정상 | 실패 |
| --- | --- | --- |
| `orch/tests/lib-paths.spec.ts` | 워크트리에서 불러도 주 checkout 의 `.orch` 다. `ORCH_DIR` 상대경로 | 옛 위치에 파일이 있으면 `requireMigrated` 가 옮기는 명령과 함께 실패 |
| `orch/tests/lib-config.spec.ts` | 세 절과 새 절을 읽는다. 파일이 없으면 빈 객체 | 모르는 키와 깨진 JSON 이 `ConfigError` |
| `orch/tests/lib-spec.spec.ts` | 세 꼴의 `브랜치:` 줄, 허락 줄 여러 개, 살아 있는 지시서를 빼고 지운다 | 목록이 null 이면 아무것도 지우지 않는다. 살아 있는 지시서는 `kept` |

`orch/tests/test_orch_paths.py`, `test_live_specs.py` 의 사례를 읽고 같은 입력을 옮긴다. Python 테스트는 지우지 않는다. 원본이 아직 쓰인다.

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
