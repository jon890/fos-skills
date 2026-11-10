# Phase 01. `board.ts` 의 쓰기를 파일 잠금 안에서 한다

**Execution profile**: deep

## 목표

`board.ts` 의 쓰는 동작이 보드를 읽기 전에 잠금을 잡고 쓴 뒤에 놓는다. 루프의 동기화, 띄우기, 마무리, 코디네이터가 같은 보드를 함께 고쳐도 늦게 쓴 쪽이 앞 변경을 지우지 않게 하려는 것이다.

**범위 외**: 새 옵션과 새 동작(phase 02, 03). orch 스크립트(`skills/orch/**`)는 이 계획 전체에서 고치지 않는다. 낡은 목록 거절(`--if-rev`)은 phase 02 다.

## 컨텍스트

**요구사항**: REQ11(잠금), REQ13

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md` 의 「잠금 (PR1)」, `docs/adr/029-board-write-lock.md`

- 지금 `extensions/work-board/bin/board.ts` 의 `main` 은 인자 검사 뒤 `existsSync(path) ? JSON.parse(readFileSync(path))` 로 읽고, `apply(a, board)` 로 고치고, `writeFileSync(tmp)` 뒤 `renameSync(tmp, path)` 로 쓴다. 잠금이 없다.
- `apply` 는 읽기만 한 동작(`list`, `steps`)에 `false` 를 돌려주고 `main` 이 쓰지 않고 0 으로 끝낸다. 거절은 `Refused` 예외이고 `main` 이 stderr 에 이유를 쓰고 1 을 돌려준다.
- `main` 은 동기 함수다. 비동기로 바꾸지 않는다. 기다림은 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` 로 한다(설계 「설계 단계 실측」).
- 스펙 REQ13 은 「`board.ts` 의 기존 테스트가 고치지 않고 통과한다」 를 요구한다. 그래서 `extensions/work-board/tests/board.spec.ts` 는 이 계획 전체에서 고치지 않고 새 테스트는 새 파일에 쓴다.
- 종료 코드 계약: 0 반영, 1 거절(stderr 에 이유), 2 사용법 오류. 잠금을 못 잡은 것은 1 이다.

## 의도 메모

- 프로세스가 살아 있는지로 낡은 잠금을 가리지 않는다. 잠금 파일의 나이(마지막 수정 시각)만 본다(스펙 DECISION16).
- 낡은 잠금을 지우고 다시 만들지 않는다. 둘이 함께 지우면 둘 다 새로 만들어 함께 쥔다. 자기 표지를 쓴 임시 파일을 잠금 파일 이름으로 바꿔 덮고, 잠깐 뒤 다시 읽어 자기 표지일 때만 잡은 것으로 본다.
- 읽는 동작은 잠그지 않는다. 쓰기가 이름 바꾸기로 끝나 읽는 쪽은 늘 온전한 파일을 본다.
- 잠금 코드는 보드 형식을 모르는 모듈로 뗀다. 뒤에 orch 의 다른 상태 파일이 같은 함수를 쓴다.

## 작업 항목

### 1. `extensions/work-board/bin/file-lock.ts` 를 새로 만든다

node 내장 모듈만 import 한다. stdout, stderr 에 쓰지 않는다.

파일 맨 위 설명에 잠금 규약을 적는다: 잠금 파일의 자리와 표지, 잡는 순서, 낡은 잠금을 넘겨받는 조건과 순서, 놓는 조건, 기본값(5초, 30초), 프로세스가 살아 있는지는 보지 않는다는 것. `docs/adr/029-board-write-lock.md` 가 이 설명을 지금 규칙의 원본으로 가리킨다. 이유는 그 ADR 을 가리키고 다시 적지 않는다.

```ts
export class LockTimeout extends Error {}
export type LockOptions = { waitMs?: number; staleMs?: number; pollMs?: number; settleMs?: number }
export type Lock = { file: string; held(): boolean }
export function withFileLock<T>(target: string, work: (lock: Lock) => T, opts?: LockOptions): T
```

- 기본값: `waitMs` 5000, `staleMs` 30000, `pollMs` 50, `settleMs` 50.
- 잠금 파일은 `` `${target}.lock` `` 이다. 폴더는 부르는 쪽이 먼저 만든다. 그래도 `openSync` 가 `ENOENT` 면(다른 프로세스가 빈 폴더를 막 지웠다) `mkdirSync(dirname(lock), { recursive: true })` 로 다시 만들고 쉬지 않고 1 로 돌아간다.
- 표지는 `` `${process.pid} ${randomBytes(8).toString('hex')}` `` 다.
- 잡기 순서. 시작 시각에서 `waitMs` 가 지날 때까지 되풀이한다. `waitMs` 가 0 이어도 적어도 한 번은 1 과 2 를 해 본다(기다리는 한도는 3 에서 쉬기 전에 본다).
  1. `openSync(lock, 'wx')` 로 만들고 표지를 쓴 뒤 닫는다. 성공하면 잡은 것이다.
  2. `EEXIST` 면 잠금 파일의 내용과 `statSync(lock).mtimeMs` 를 읽는다. 지금보다 `staleMs` 넘게 오래됐으면 넘겨받기를 한다: `` `${lock}.${process.pid}.tmp` `` 에 자기 표지를 쓰고, 잠금 파일을 한 번 더 읽어 내용과 `mtimeMs` 가 방금 낡았다고 본 값 그대로일 때만 `renameSync` 로 잠금 파일을 덮는다(그 사이 다른 프로세스가 새로 잡았으면 덮지 않고 임시 파일을 지운 뒤 3 으로 간다). 덮은 뒤 `settleMs` 를 쉬고 잠금 파일을 다시 읽어 자기 표지면 잡은 것이다. 아니면 3 으로 간다.
  3. `waitMs` 가 지났으면 4 로 간다. 아니면 `pollMs` 를 쉬고 1 로 돌아간다. `stat` 이나 읽기가 `ENOENT` 로 실패하면(그 사이 잠금이 풀렸다) 쉬지 않고 1 로 돌아간다.
  4. `waitMs` 가 지나면 `LockTimeout` 을 던진다. 메시지에 잠금 파일 경로를 넣는다. `work` 는 부르지 않는다.
- `held()` 는 잠금 파일을 읽어 자기 표지와 같으면 `true` 다. 읽지 못하면 `false` 다.
- `work` 가 값을 돌려주든 던지든 `finally` 에서 `held()` 가 참일 때만 잠금 파일을 지운다.

### 2. `extensions/work-board/bin/board.ts` 의 `main` 이 쓰는 동작을 잠금 안에서 한다

- `list` 와 `steps` 는 지금 순서 그대로 잠금 없이 돈다.
- 그 밖의 동작(`set`, `detail-edit`, `detail-add`, `step`, `mark`, `del`)은 `--progress`, `--stages` 검사 뒤에 아래 순서로 돈다.
  1. `const dir = dirname(path)`. `const made = mkdirSync(dir, { recursive: true })` 를 부른다. 폴더가 이미 있으면 `undefined`, 새로 만들었으면 만든 폴더 가운데 가장 위의 경로를 돌려준다. 이 값을 기억한다.
  2. `withFileLock(path, (lock) => { … })` 안에서 지금의 읽기(`existsSync(path) ? JSON.parse(…) : { items: [] }`), `normalizeItem`, `before` 기록, `apply`, 시각 남기기, `.bak` 복사를 하고 3 의 함수로 쓴다.
  3. 쓰기는 내보내는 함수 하나로 뗀다. 테스트가 가짜 잠금으로 부를 수 있게 하려는 것이다.

     ```ts
     // 임시 파일에 쓰고 보드 파일 이름으로 바꾼다. 잠금을 잃었으면 쓰지 않고 false 다
     export function saveBoard(path: string, board: unknown, lock: { held(): boolean }): boolean
     ```

     임시 파일은 `` `${path}.${process.pid}.tmp` `` 다(지금의 `` `${path}.tmp` `` 는 두 프로세스가 같은 이름을 써 서로의 임시 파일을 지울 수 있다). `JSON.stringify(board, null, 1)` 을 쓴 뒤 `renameSync` 바로 앞에서 `lock.held()` 를 본다. 거짓이면 임시 파일을 지우고 `false` 를 돌려준다. `main` 은 `false` 면 stderr 에 `` `보드 잠금을 다른 프로세스가 넘겨받아 쓰지 않았다: ${lock.file}` `` 을 쓰고 1 을 돌려준다.
  4. `LockTimeout` 을 잡아 stderr 에 `` `보드 잠금을 ${초}초 안에 잡지 못했다: ${path}.lock` `` 을 쓰고 1 을 돌려준다. 초는 실제 기다린 한도다(기본 5).
  5. 보드를 쓰지 않고 끝났고(거절, 잠금 실패) 1 의 `made` 가 있으면 `dir` 에서 `made` 까지 위로 올라가며 폴더마다 `rmdirSync` 를 `try` 로 감싸 부른다. 빈 폴더만 지워지고, 지우지 못한 폴더에서 멈춘다. 거절한 호출이 지금처럼 아무 폴더도 남기지 않게 하려는 것이다.
- 기다리는 한도는 환경 변수 `BOARD_LOCK_WAIT_MS` 가 0 이상의 정수면 그 값이고 아니면 `withFileLock` 의 기본값이다. 테스트가 5초를 기다리지 않게 하려는 값이다.
- `apply` 안의 `Refused` 처리와 종료 코드는 그대로다. 잠금은 거절로 끝나도 놓인다(`withFileLock` 의 `finally`).
- 파일 맨 위 설명에 아래를 더한다(`HELP` 에는 한 줄로 줄여 더한다).
  - 쓰는 동작은 보드 파일 옆 `<보드 파일>.lock` 을 읽기부터 쓰기까지 잡는다. 5초 안에 못 잡으면 1 이고, 30초 넘은 잠금 파일은 죽은 프로세스의 것으로 보고 넘겨받는다. `list`, `steps` 는 잠그지 않는다.
  - `BOARD_LOCK_WAIT_MS` 는 테스트용이다.

### 3. `extensions/work-board/tests/board-run.ts` 를 새로 만든다(테스트 도우미)

`board.spec.ts` 의 `board()`, `write()`, `items()`, `item()` 과 같은 일을 하는 함수를 내보낸다. 뒤 phase 의 새 테스트 파일이 함께 쓴다.

```ts
export const BOARD: string                       // ../bin/board.ts 의 절대경로
export type Result = { code: number | null; stdout: string; stderr: string }
export function tempBoard(): { dir: string; file: string; cleanup(): void }   // mkdtemp 로 만든 폴더와 그 안의 board.json 경로
export function run(file: string, args: string[], env?: Record<string, string>): Result   // spawnSync 로 board.ts <args> --file <file>
export function runAsync(file: string, args: string[], env?: Record<string, string>): Promise<Result>   // spawn 으로 같은 호출
export function write(file: string, ...items: Record<string, unknown>[]): void   // {"items": [...]} 를 쓴다
export function item(file: string, id: string): Record<string, unknown>
```

### 4. `extensions/work-board/tests/file-lock.spec.ts` 를 새로 만든다

`withFileLock` 을 import 해 임시 폴더에서 본다. 시간은 옵션으로 줄인다(`waitMs: 200`, `pollMs: 10`, `settleMs: 10`).

- 정상: `work` 가 도는 동안 잠금 파일이 있고 `lock.held()` 가 참이다. 끝나면 잠금 파일이 없고 `work` 의 반환값을 돌려준다.
- 기다림 실패: 테스트가 미리 만든 새 잠금 파일(다른 표지)이 있으면 `LockTimeout` 을 던지고 `work` 를 부르지 않는다. 미리 만든 잠금 파일은 그대로 남는다.
- 낡은 잠금: 미리 만든 잠금 파일의 시각을 `utimesSync` 로 40초 전으로 옮기면(`staleMs` 기본값) `work` 가 돌고 끝난 뒤 잠금 파일이 없다.
- 낡지 않은 잠금은 넘겨받지 않는다: 시각을 10초 전으로 옮긴 잠금 파일은 `LockTimeout` 이고 그 파일의 내용이 그대로다.
- 예외: `work` 가 던지면 같은 예외가 나오고 잠금 파일이 없다.
- 넘겨받힘: `work` 안에서 잠금 파일을 다른 글로 덮어쓰면 `lock.held()` 가 거짓이고, 끝난 뒤 그 잠금 파일이 남아 있다(남의 잠금을 지우지 않는다).

### 5. `extensions/work-board/tests/board-lock.spec.ts` 를 새로 만든다

`board-run.ts` 로 `board.ts` 를 실행한다.

- 읽기가 잠금 안에 있다: 항목 없는 보드에 다른 표지의 새 잠금 파일을 미리 둔다. `BOARD_LOCK_WAIT_MS=3000` 으로 `set b wait` 를 `runAsync` 로 띄운다. 1초 뒤 테스트가 보드 파일에 항목 `a` 를 직접 쓰고 잠금 파일을 지운다. 기대: 종료 코드 0 이고 보드에 `a` 와 `b` 가 모두 있다. 읽기를 잠금 밖에 둔 구현은 `a` 를 잃어 이 사례에서 늘 실패한다.
- 잠금을 잃으면 쓰지 않는다: `saveBoard` 를 import 해 `{ held: () => false }` 로 부르면 `false` 를 돌려주고, 보드 파일의 바이트가 그대로이고, 그 폴더에 `.tmp` 로 끝나는 파일이 남지 않는다. `{ held: () => true }` 로 부르면 `true` 이고 보드 파일이 `JSON.stringify(값, null, 1)` 과 같다.
- 함께 쓰기: 빈 보드에서 `runAsync` 12개가 서로 다른 id 로 `set <id> wait` 를 함께 부른다. 모두 종료 코드 0 이고 보드에 12개 항목이 모두 있다. 끝난 뒤 `<보드 파일>.lock` 이 없다.
- 기다림 실패: 새 잠금 파일을 미리 두고 `BOARD_LOCK_WAIT_MS=200` 으로 `set a wait` 를 부르면 종료 코드 1 이고 stderr 에 「잠금」 과 잠금 파일 경로가 있다. 보드 파일의 바이트가 부르기 전과 같다.
- 낡은 잠금: 잠금 파일의 시각을 40초 전으로 옮긴 뒤 `set a wait` 가 종료 코드 0 이고 항목이 생기고 잠금 파일이 없다.
- 읽기는 잠그지 않는다: 새 잠금 파일이 있어도 `list` 와 `steps <id>` 가 종료 코드 0 이다.
- 거절 뒤 정리: 항목이 있는 보드에 `step a 9` 를 부르면 종료 코드 1 이고 잠금 파일이 없다. 없는 폴더의 보드(`<임시>/none/board.json`)에 `step a 1` 을 부르면 종료 코드 1 이고 `<임시>/none` 폴더가 없다. 두 단계가 없는 보드(`<임시>/x/y/board.json`)도 같은 호출 뒤 `<임시>/x` 가 없다.
- 기다리는 한도 0: 잠금 파일이 없을 때 `BOARD_LOCK_WAIT_MS=0` 으로 `set a wait` 를 부르면 종료 코드 0 이다(한 번은 잡아 본다).

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/file-lock.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/board.spec.ts
git diff --exit-code origin/main -- extensions/work-board/tests/board.spec.ts
node scripts/run-tests.ts --tsc-only
```

- 첫 줄은 새 테스트와 기존 `board.ts` 테스트가 모두 통과해야 한다.
- 둘째 줄은 출력 없이 종료 코드 0 이어야 한다(기존 테스트 파일을 고치지 않았다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/file-lock.ts` | 신규 |
| `extensions/work-board/bin/board.ts` | 수정 (쓰는 동작을 잠금 안에서, `saveBoard`, 파일 맨 위 설명과 HELP) |
| `extensions/work-board/tests/board-run.ts` | 신규 |
| `extensions/work-board/tests/file-lock.spec.ts` | 신규 |
| `extensions/work-board/tests/board-lock.spec.ts` | 신규 |
