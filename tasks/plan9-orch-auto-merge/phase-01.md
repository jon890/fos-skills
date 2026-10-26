# Phase 01. 자동 머지 판정 라이브러리와 설정 키

**Execution profile**: deep

## 목표

상주 루프의 자동 머지가 쓸 판정을 부수 효과 없는 함수 모듈 `orch/scripts/lib/auto-merge.ts` 하나에 두고, 설정 키를 `lib/config.ts` 에 더한다.
루프 연결(gh, git, 큐 띄우기)은 다음 phase 가 하므로 이 phase 는 입력을 받아 판정만 돌려주는 함수를 만든다.

**범위 외**: `orch-loop.ts` 수정, 상태 파일, 이벤트 쓰기(phase 02). 스킬 문서(phase 03). 번호 예약 명령(다음 plan).

## 컨텍스트

- 설정 읽기는 `orch/scripts/lib/config.ts` 의 `loadConfig`, `section`, `ConfigError` 다. 절 목록은 `SECTIONS`, 절마다 아는 키 목록(`QUEUE_KEYS`, `PIPELINE_KEYS`, `HEAVY_KEYS`)을 둔다.
- `QUEUE_KEYS` 는 `orch/tests/lib-config.spec.ts` 의 두 테스트가 지킨다. 하나는 `orch/references/overlay.md` 「마무리 설정 파일」 표의 `queue` 행 키와 같은 집합인지,
  다른 하나는 `orch/scripts/lib/queue-options.ts` 의 `QUEUE_VALUES`, `QUEUE_FLAGS`, `QUEUE_REPEATED`, `QUEUE_GROUPS` 키를 합친 것과 같은 집합인지 본다.
  `merge-with-finish.ts` 의 `queueDefaults` 는 `section(config, 'queue', QUEUE_KEYS)` 로 읽고 그 네 표에 든 키만 옵션으로 바꾼다. 다른 키는 무시한다.
- Python 정규식 글자는 `orch/scripts/lib/py.ts` 의 `pyRegExp(source)` 로 JS RegExp 로 바꾼다. 다른 설정 정규식(`finish.task_pattern`, `queue.shared_paths`)과 같다.
- 지시서의 `브랜치:` 줄 형식은 `orch/scripts/lib/spec.ts` 의 `BRANCH_LINE` 이다. `머지 보류:` 줄도 같은 꼴(앞의 `-`/`*` 목록 표시, `**` 굵게)을 받는다.
- 보드 항목 형식은 `work-board/README.md` 「저장 형식」 이다. `next` 와 `details` 는 `{text, done}` 목록이고 옛 문자열도 섞일 수 있다. 문자열 줄은 끝나지 않은 줄로 본다.
  타입은 `orch/scripts/lib/board.ts` 의 `BoardItem`, `BoardDetail`, `detailText` 를 쓴다.

**근거 문서**: `docs/adr/016-orch-auto-merge.md`, `docs/data-schema.md` 의 「config.json 에 더하는 절」(`queue.auto_merge`, `queue.auto_review`, `migrations.*` 행), `docs/flow.md` 의 「상주 루프의 자동 머지」.

## 의도 메모

- 마이그레이션 버전은 Flyway 파일 이름 `V<버전>__<설명>` 에서 읽는다. 버전은 `.` 과 `_` 로 나눈 숫자 목록이다. `R__` 반복 마이그레이션과 `U` 되돌리기는 세지 않는다.
- 판정 함수는 gh 와 git 을 부르지 않는다. 입력은 경로 목록, 리뷰 목록, 보드 항목처럼 이미 읽은 값이다. 테스트가 가짜 프로세스 없이 경계 값을 볼 수 있게 하려는 것이다.
- 큐 순서는 준비를 처음 본 시각 순이고, 같은 모듈 마이그레이션 PR 이 차지한 자리만 버전 순으로 바꾼다. 모듈을 공유하는 PR 은 하나의 묶음(`--chain`)이다. 머지 큐는 PR 하나가 묶음 하나에만 들게 하므로, 모듈 둘에 걸친 PR 이 있으면 두 묶음을 합친다.

## 작업 항목

### 1. `orch/scripts/lib/config.ts` 의 키와 절

- `Section` 과 `SECTIONS` 에 `'migrations'` 를 더한다.
- `export const QUEUE_LOOP_KEYS: readonly string[] = ['auto_merge', 'auto_review']` 를 두고 `QUEUE_KEYS` 끝에 펼쳐 넣는다. 주석: 상주 루프만 읽는 키라 merge-with-finish 의 옵션 표에 없다.
- `export const MIGRATIONS_KEYS: readonly string[] = ['dirs', 'before', 'blocked_after_sec']` 를 둔다.
- 머리 주석의 절 목록 문장에 `migrations` 절과 `MIGRATIONS_KEYS` 를 더한다.

### 2. `orch/scripts/lib/auto-merge.ts` (신규)

머리 주석에 사용처(orch-loop.ts 의 「자동 머지」)와 아래 판정을 적는다. 내보내는 것:

```ts
export type ReviewRule = { pass: RegExp; block: RegExp }
export type AutoMergeConfig = {
  enabled: boolean                       // queue.auto_merge. 없으면 false. boolean 이 아니면 ConfigError
  review: ReviewRule | null              // queue.auto_review. 없으면 null. {pass, block} 둘 다 비지 않은 문자열이 아니거나 모르는 키가 있으면 ConfigError
  dirs: Record<string, string>           // migrations.dirs. 없으면 {}. 값이 비지 않은 문자열이 아니면 ConfigError. 끝의 / 는 뗀다
  before: Record<string, string> | null  // migrations.before. 없으면 null. 값이 비지 않은 문자열이 아니면 ConfigError
  blockedAfterSec: number                // migrations.blocked_after_sec. 기본 3600. 양수가 아니면 ConfigError
}
export function autoMergeConfig(config: Config): AutoMergeConfig
```
`section(config, 'queue', QUEUE_KEYS)` 와 `section(config, 'migrations', MIGRATIONS_KEYS)` 로 읽는다.
`auto_review` 의 정규식은 `pyRegExp` 로 바꾼다. `pyRegExp` 와 `new RegExp` 가 던지는 일반 Error 는 `설정 파일의 queue.auto_review.<키> 를 정규식으로 읽지 못했다: <이유>` ConfigError 로 바꾼다. 그래야 명령이 잡지 않은 예외 대신 종료 코드 2 로 끝난다.

```ts
export const HOLD_LINE: RegExp         // /^\s*(?:[-*]\s+)?(?:\*\*)?머지 보류(?:\*\*)?:(?:\*\*)?\s*(.*)$/
export function specHold(text: string): string | null       // 지시서 본문에서 첫 「머지 보류:」 줄의 이유(빈 이유면 '이유 없음'). 없으면 null. 줄 나누기는 lib/spec.ts 의 LINE_BREAK
export function boardHold(item: BoardItem): string | null    // next 와 details 가운데 done 이 true 가 아닌 줄의 text 가 /^\s*(?:\d+[.)]?\s+)?머지 보류/ 로 시작하면 그 text. 없으면 null
                                                             // next 나 details 가 목록이 아니라 문자열 하나(옛 형식)면 줄바꿈으로 나눈 줄마다 끝나지 않은 줄로 본다
```

```ts
export type ReviewNote = { body: string; at: string }          // 리뷰의 submittedAt, 댓글의 createdAt (ISO 8601)
export function reviewVerdict(notes: ReviewNote[], rule: ReviewRule): 'pass' | 'block' | 'none'
```
`at` 이 늦은 것부터 보고 pass 나 block 에 맞는 첫 본문으로 정한다. 둘 다 맞으면 block. 하나도 없으면 none.

```ts
export type Migration = { module: string; version: number[]; label: string; path: string }   // label 은 파일 이름의 `V12` 나 `V1_2` 부분
export function migrationOf(path: string, dirs: Record<string, string>): Migration | null     // path 가 dirs[모듈] + '/' 아래이고 파일 이름이 /^V(\d+(?:[._]\d+)*)__/ 면 그 마이그레이션
export function compareVersion(a: number[], b: number[]): number                            // 자리마다 숫자 비교, 짧은 쪽 뒤는 0. 음수, 0, 양수
export function maxByModule(paths: string[], dirs: Record<string, string>): Map<string, Migration>  // base 의 파일 목록에서 모듈마다 가장 높은 버전
```

```ts
export type OpenMigrations = { pr: number; migrations: Migration[] }
export type MigrationJudgement = {
  clashes: { module: string; label: string; reason: string }[]   // label 은 이 PR 의 것. reason: `base 최고 <base 의 label> 이하` 또는 `#<다른 PR> 과 같은 번호`
  lower: { pr: number; module: string; label: string; mine: string }[]  // 같은 모듈에 base 최고보다 크고 이 PR 보다 낮은 번호를 더한 다른 열린 PR
}
export function judgeMigrations(pr: number, mine: Migration[], baseMax: Map<string, Migration>, others: OpenMigrations[]): MigrationJudgement
```
`others` 에서 `pr` 과 같은 번호는 뺀다. 같은 PR 이 같은 모듈을 여러 번 더하면 각각 본다.

```ts
export function beforeCommand(modules: string[], before: Record<string, string> | null):
  { ok: true; command: string | null } | { ok: false; module: string }
```
`before` 가 null 이거나 `modules` 가 비면 `{ok: true, command: null}`. 모듈마다 `before[모듈]`, 없으면 `before['*']` 의 `{module}` 을 모듈 이름으로 바꾼 것. 둘 다 없으면 `{ok: false, module}`. 여럿은 정렬한 모듈 순서로 ` && ` 로 잇는다.

```ts
export type QueueItem = { pr: number; readyAt: string; migrations: Migration[] }
export function queueOrder(items: QueueItem[]): { order: number[]; chains: number[][] }
```
`readyAt` 오름차순(같으면 PR 번호). 모듈마다 그 모듈 마이그레이션을 가진 PR 이 앉은 자리를 그 모듈의 가장 낮은 버전 순으로 다시 채운다(모듈 이름 순으로 차례로).
모듈을 함께 가진 PR 들을 이어 묶음으로 만들고, 둘 이상인 묶음만 `order` 순서로 `chains` 에 담는다.
모듈 둘 이상에 걸친 PR 때문에 뒤 모듈의 재배치가 앞 모듈의 버전 순서를 깨면, 모든 모듈의 버전이 오름차순인 가장 긴 앞부분만 `order` 에 남긴다. 나머지는 다음 틱에 다시 본다. 번호 순서를 어기고 거는 것보다 늦게 거는 쪽이 되돌리기 쉽다.

```ts
export function sweepArgs(configured: unknown, run: string): string[] | null
```
`queue.sweep_args` 가 문자열 목록이면 그 목록에서 `--run` 다음 값을 `run` 으로 바꾼(없으면 끝에 `--run`, `run` 을 더한) 목록, 목록이 아니면 null.
merge-with-finish 는 명령줄에 `--sweep-arg` 가 있으면 설정 목록을 쓰지 않고, 설정의 `--run` 과 `--run` 옵션이 다르면 사용법 오류이기 때문이다.

### 3. `orch/tests/lib-auto-merge.spec.ts` (신규)

`node:test` 와 `node:assert/strict`. 가짜 프로세스 없이 함수만 부른다. 아래를 각각 단언한다.

- `autoMergeConfig`: 빈 설정이면 `{enabled: false, review: null, dirs: {}, before: null, blockedAfterSec: 3600}`. `queue.auto_merge: "yes"`, `queue.auto_review: {"pass": "ok"}`, `migrations.blocked_after_sec: 0`, `migrations.dirs: {"api": ""}` 는 각각 ConfigError.
- `specHold`: `- **머지 보류:** #12 real 배포 뒤` 에서 `#12 real 배포 뒤`. `머지 보류` 가 줄 가운데 있는 문장은 null.
- `boardHold`: `details: [{"text": "머지 보류: 배포 뒤", "done": false}]` 는 그 text, 같은 줄이 `done: true` 면 null, 옛 문자열 `next: "1. 구현\n2. 머지 보류 까지 대기"` 는 `2. 머지 보류 까지 대기`.
- `reviewVerdict`: 늦은 본문이 block 이면 block, 늦은 본문이 아무 데도 안 맞고 이른 본문이 pass 면 pass, 빈 목록은 none, 한 본문이 둘 다 맞으면 block.
- `migrationOf`: `db/api/V12__add.sql` 과 dirs `{"api": "db/api/"}` 는 `{module: 'api', version: [12], label: 'V12'}`. `db/api/R__view.sql`, `db/web/V1__x.sql`(dirs 밖)은 null.
- `compareVersion`: `[1,2]` 와 `[1,10]` 은 음수, `[2]` 와 `[2,0]` 은 0.
- `judgeMigrations`: base 최고 V12 에서 이 PR 의 V11 은 clash `{module: 'api', label: 'V11', reason: 'base 최고 V12 이하'}`, 다른 PR #31 의 V13 과 이 PR 의 V13 은 clash `#31 과 같은 번호`, 다른 PR #32 의 V13 과 이 PR 의 V14 는 lower 에 #32.
- `beforeCommand`: `{"*": "backup {module}"}` 와 `['web', 'api']` 는 `backup api && backup web`. `{"api": "b"}` 와 `['web']` 는 `{ok: false, module: 'web'}`. before null 은 command null.
- `queueOrder`: 준비 순 #3(V14 api), #5(마이그레이션 없음), #4(V13 api) 는 order `[4, 5, 3]`, chains `[[4, 3]]`. #1(api V5, web V2), #2(api V6), #3(web V1) 이 이 순서로 준비되면 api 순서는 #1, #2 이고 web 순서는 #3, #1 이라 한 순서로 둘 다 지킬 수 없다. 결과 order 는 둘 다 지키는 가장 긴 앞부분이고 chains 는 남은 PR 의 묶음 하나다(값은 구현이 정한 재배치 순서로 단언한다). 모듈이 겹치지 않는 PR 은 묶음에 들지 않는다.
- `sweepArgs`: `['--run', 'old', '--kill-holders']` 와 `run_x` 는 `['--run', 'run_x', '--kill-holders']`, `['--kill-holders']` 는 `['--kill-holders', '--run', 'run_x']`, undefined 는 null.

### 4. `orch/tests/lib-config.spec.ts` 의 기대값

- `SECTIONS` 상수에 `'migrations'` 를 더한다.
- 「merge-with-finish 가 머지 큐 옵션으로 바꾸는 표들의 키를 합치면 QUEUE_KEYS 와 같은 집합」 테스트는 `QUEUE_KEYS` 에서 `QUEUE_LOOP_KEYS` 를 뺀 집합과 비교하게 바꾸고 제목도 그렇게 고친다.
- overlay 표와 대조하는 테스트는 그대로 둔다. 표에 `auto_merge`, `auto_review` 행을 더하는 일은 아래 5 가 한다.

### 5. `orch/references/overlay.md` 「마무리 설정 파일」 표

`queue` 행 하나를 더한다: `` | `queue` | `auto_merge`, `auto_review` | 상주 루프의 자동 머지. 키 뜻은 저장소 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다 | ``.
같은 표에 `` | `migrations` | `dirs`, `before`, `blocked_after_sec` | 모듈별 마이그레이션 폴더와 자동 머지의 머지 전 명령, 막힘 알림 시간 | `` 행도 더한다.
표 바로 위의 「스크립트마다 자기 절만 읽는다」 문단에 `migrations` 절은 상주 루프가 읽는다고 더하고, 「상주 루프(`orch-loop.ts`)는 … `queue` 절의 `required`, `skipped_is_missing` …」 문장의 queue 키에 `auto_merge`, `auto_review` 를 더한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-auto-merge.spec.ts orch/tests/lib-config.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

기대값: 둘 다 종료 코드 0. 첫 줄의 출력에 `lib-auto-merge` 의 테스트가 모두 통과로 나온다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/auto-merge.ts` | 신규 |
| `orch/scripts/lib/config.ts` | 수정 |
| `orch/tests/lib-auto-merge.spec.ts` | 신규 |
| `orch/tests/lib-config.spec.ts` | 수정 |
| `orch/references/overlay.md` | 수정 |
