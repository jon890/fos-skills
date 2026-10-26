# Phase 01. 예약 라이브러리와 reserve-migration 명령

**Execution profile**: deep

## 목표

worker 가 마이그레이션 파일을 만들기 전에 다음 번호를 잠금을 걸고 예약하는 명령 `orch/scripts/reserve-migration.ts` 와, 예약 파일, 잠금, 번호 판정을 한 벌로 두는 `orch/scripts/lib/reservations.ts` 를 만든다.

**범위 외**: 상주 루프의 자동 머지가 예약을 읽는 일(phase 02). 스킬 문서와 버전(phase 03).

## 컨텍스트

- 마이그레이션 설정과 번호 읽기는 앞 PR 이 만든 `orch/scripts/lib/auto-merge.ts` 다. `autoMergeConfig(config).dirs`(모듈에서 폴더로), `migrationOf(path, dirs)`, `compareVersion(a, b)`, `maxByModule(paths, dirs)`, 타입 `Migration`(`module`, `version`, `label`, `path`)을 그대로 쓴다.
- 설정 읽기는 `lib/config.ts` 의 `loadConfig`, 오류는 `ConfigError` 다. 경로는 `lib/paths.ts` 의 `pathOf('state', repo)`, `makeParent`, 주 checkout 은 `lib/git.ts` 의 `mainCheckout`, 기준 브랜치는 `defaultBase`, git 호출은 `git(repo, args)` 다.
- gh 호출은 `lib/gh.ts` 의 `ghJson`. 옵션 파싱은 다른 명령처럼 `node:util` 의 `parseArgs` 와 `lib/args.ts` 의 `expandArgs` 다(예: `orch/scripts/orch-loop.ts` 의 `main`).
- 잠금은 `lib/events.ts` 의 핸들러 잠금과 같은 방식(wx 로 만들고 pid 를 적음, 죽은 pid 는 `reclaim` 으로 회수)이다. 그 파일의 `acquire(lock, deadline)` 와 `release(lock)` 은 지금 내보내지 않는다.
- 다른 브랜치가 더한 번호는 열린 PR 의 `files`(`gh pr list --state open --limit 200 --json number,headRefName,baseRefName,files`)에서 읽는다. 앞 PR 의 `orch-loop.ts` 의 `addedMigrations` 와 같은 규칙(`changeType` 이 `ADDED`, `RENAMED`, `COPIED` 이거나 없음)을 쓴다. 그 함수는 orch-loop.ts 안에 있으므로 같은 판정을 `lib/reservations.ts` 에 `addedPaths(files)` 로 두고, phase 02 가 orch-loop.ts 에서 이 함수로 바꾼다.
- 테스트 짜임 예: `orch/tests/orch-loop-auto-merge.spec.ts`(가짜 gh `tests/fixtures/fake-bin.ts`, 임시 git 저장소와 bare origin).

**근거 문서**: `docs/adr/017-orch-migration-reserve.md`, `docs/data-schema.md` 의 `state/migration-reservations.json` 과 `.lock` 행, `docs/flow.md` 의 「마이그레이션 번호 예약」.

## 의도 메모

- 번호는 최대값의 첫 자리에 1 을 더한다. `V1_2` 처럼 자리가 여럿인 저장소도 새 번호는 `V2` 다. Flyway 는 `V2` 를 `V1_2` 보다 뒤로 정렬한다.
- 파일은 만들지 않는다. 경로만 돌려주고 worker 가 그 이름으로 만든다. 명령이 파일을 만들면 다른 worktree 의 경로와 섞인다.
- 예약을 정하는 데 필요한 조회(fetch, ls-tree, gh pr list)가 하나라도 실패하면 예약하지 않는다. 모르는 번호를 피한 척 예약하면 겹친다.
- 정리(PR 이 MERGED, CLOSED 이거나 브랜치가 없음)의 조회가 실패한 항목은 지우지 않고 남긴다. 지우면 그 번호가 다시 나간다.

## 작업 항목

### 1. `orch/scripts/lib/events.ts` 의 잠금 내보내기

`acquire` 와 `release` 를 `export function acquireLock(lock: string, deadline: number): Promise<boolean>`, `export function releaseLock(lock: string): void` 로 이름을 바꿔 내보내고, 이 파일 안의 호출도 바꾼다. 머리 주석의 잠금 설명에 사용처(`lib/reservations.ts`)를 더한다. 동작은 바꾸지 않는다.

### 2. `orch/scripts/lib/reservations.ts` (신규)

머리 주석에 파일 형식(`docs/data-schema.md` 의 행), 잠금, 판정을 적는다. 내보내는 것:

```ts
export type Reservation = { module: string; version: number[]; label: string; branch: string; name: string; path: string; at: string }
export function reservationsFile(repo: string): string      // join(pathOf('state', repo), 'migration-reservations.json')
export function lockFile(repo: string): string              // 같은 폴더의 migration-reservations.lock
export function readReservations(repo: string): Reservation[]   // 파일이 없으면 []. JSON 이 깨졌거나 형식이 틀리면 Error(부르는 쪽이 LOOKUP-FAIL 로 다룬다). 형식이 맞지 않는 항목 하나는 건너뛴다
export function writeReservations(repo: string, list: Reservation[]): void  // makeParent, <file>.<pid>.tmp 에 쓰기, rename. {"reservations": list}
export function addedPaths(files: unknown): string[]         // gh 의 files 목록에서 changeType 이 ADDED, RENAMED, COPIED 이거나 없는 행의 path
export function slug(name: string): string                   // 설명을 파일 이름 조각으로. 공백과 - 는 _, 영문 소문자, 숫자, _ 밖의 글자는 지운다. 비면 Error
export function nextVersion(module: string, taken: Migration[]): { version: number[]; label: string }
```
`nextVersion` 은 `taken` 가운데 그 모듈 것의 `version[0]` 최대값에 1 을 더한 `[n]` 과 `V<n>` 이다. 없으면 `[1]`, `V1`.

```ts
export function choose(input: {
  module: string; name: string; branch: string; again: boolean; dir: string; at: string
  baseMax: Migration | null; open: { branch: string; migrations: Migration[] }[]; reservations: Reservation[]
}): { reservation: Reservation; reused: boolean; list: Reservation[] }
```
- 같은 (branch, module, slug(name)) 예약이 있고 `again` 이 false 면 그 예약을 돌려주고 `reused: true`, `list` 는 그대로다.
- 아니면 그 예약을 빼고, `taken` = base 최고 + 다른 브랜치(`open` 가운데 `branch` 가 다른 것)가 더한 그 모듈 마이그레이션 + 다른 브랜치의 예약으로 `nextVersion` 을 정한다. 같은 브랜치의 다른 예약(설명이 다름)도 `taken` 에 넣는다. 같은 브랜치에 같은 모듈 마이그레이션 둘을 예약할 수 있어야 하기 때문이다.
- `path` 는 `<dir>/<label>__<slug(name)>.sql` 이다.

```ts
export function prune(list: Reservation[], gone: (branch: string) => boolean | null): { kept: Reservation[]; removed: Reservation[] }
```
`gone(branch)` 가 true 인 항목만 지운다. null(판정 못 함)과 false 는 남긴다. 브랜치마다 한 번만 부른다.

### 3. `orch/scripts/reserve-migration.ts` (신규)

머리 주석이 사용법, 출력, 종료 코드를 소유한다.

```
reserve-migration.ts --repo DIR --module M --name TEXT [--branch B] [--base B] [--again]
reserve-migration.ts --repo DIR --prune
```
- `--repo` 는 `mainCheckout` 으로 바꿔 쓴다. `--branch` 기본은 `git branch --show-current`(부른 작업 디렉터리 기준. worker 는 자기 worktree 에서 부른다). 비면 사용법 오류.
- `--base` 기본은 `defaultBase(repo)`, 없으면 `main`.
- 설정의 `migrations.dirs` 에 `--module` 이 없으면 사용법 오류(종료 코드 2). 설정 오류(ConfigError)도 2.
- 순서: 잠금(`acquireLock(lockFile, now + 10초)`, 못 잡으면 `LOCK-TIMEOUT <lock 경로>` 와 종료 코드 4) → 예약 읽기 → 정리 → (`--prune` 이면 `PRUNED <지운 수>` 와 0) → `git fetch --quiet origin <base>` 와 `git ls-tree -r --name-only origin/<base> -- <dir>` 로 base 최고 → 열린 PR 목록 → `choose` → 바뀌었으면 쓰기 → `releaseLock`(finally).
- 정리의 `gone(branch)`: `gh pr list --state all --head <branch> --limit 20 --json state` 에 MERGED 나 CLOSED 가 있고 OPEN 이 없으면 true. PR 이 없으면 `git ls-remote --heads origin <branch>` 와 `git show-ref --verify --quiet refs/heads/<branch>` 가 둘 다 없음이면 true, 하나라도 있으면 false. 조회가 실패하면 null.
- 출력: 성공이면 `RESERVED <module> <label> <path>` 한 줄(재사용이면 끝에 ` reused`)과 0. 조회 실패면 `LOOKUP-FAIL <이유>` 와 1. 정리로 지운 항목마다 앞에 `PRUNED <module> <label> <branch>` 줄.
- 환경 변수 `GH` 는 `lib/gh.ts` 를 따른다.

### 4. 테스트

`orch/tests/lib-reservations.spec.ts`(신규, 순수 함수):
- `slug`: `Add user index` → `add_user_index`, `한글만` 은 Error.
- `nextVersion`: api 의 `[12]`, `[3]` 과 web 의 `[40]` 이면 api 다음은 `[13]`/`V13`. 없으면 `V1`. `[1, 2]` 만 있으면 `V2`.
- `choose`: base 최고 V12, 다른 브랜치 열린 PR 의 V13, 다른 브랜치 예약 V14 이면 V15 다. 같은 브랜치, 모듈, 설명이면 `reused: true` 로 같은 예약. `again: true` 면 그 예약을 빼고 새 번호(다른 것이 그대로면 같은 번호가 다시 나올 수 있다. 예: 자기 V15 를 빼면 V15). 같은 브랜치의 다른 설명 예약 V15 가 있으면 새 예약은 V16.
- `prune`: gone 이 true, false, null 인 브랜치 셋이면 true 인 것만 지운다.
- `addedPaths`: `changeType` 이 MODIFIED 인 행은 빠지고 없는 행은 든다.

`orch/tests/reserve-migration.spec.ts`(신규, 명령): 임시 git 저장소와 bare origin, `.orch/config.json` 의 `migrations.dirs` 에 `{"api": "db/api"}`, 가짜 gh.
- base 에 `db/api/V2__a.sql`, 열린 PR(다른 브랜치)이 `db/api/V3__b.sql` 을 더하면 `RESERVED api V4 db/api/V4__add_index.sql` 와 0. 예약 파일에 그 항목과 branch 가 있다.
- 같은 인자로 다시 부르면 같은 줄 끝에 ` reused`. `--again` 이면 새 번호를 받는다.
- 두 프로세스를 동시에 띄워 다른 브랜치로 예약하면 서로 다른 번호다(잠금).
- 잠금 파일에 살아 있는 다른 pid(테스트 프로세스 자신)를 적어 두면 10초 뒤 `LOCK-TIMEOUT` 와 4. 이 테스트는 `RESERVE_LOCK_WAIT_MS` 환경 변수(기본 10000)로 대기를 줄여 돌린다. 머리 주석에 이 변수를 적는다.
- 브랜치의 PR 이 MERGED 인 예약은 다음 호출이 `PRUNED` 로 지운다. gh 가 실패하면 그 예약을 남긴다.
- `--module web`(설정에 없음)은 2, gh pr list 실패는 `LOOKUP-FAIL` 과 1 이고 예약 파일이 바뀌지 않는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-reservations.spec.ts orch/tests/reserve-migration.spec.ts orch/tests/lib-events.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

기대값: 둘 다 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/events.ts` | 수정 |
| `orch/scripts/lib/reservations.ts` | 신규 |
| `orch/scripts/reserve-migration.ts` | 신규 |
| `orch/tests/lib-reservations.spec.ts` | 신규 |
| `orch/tests/reserve-migration.spec.ts` | 신규 |
