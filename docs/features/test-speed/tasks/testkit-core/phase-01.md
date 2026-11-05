# Phase 01. testkit 의 임시 폴더, git, 명령 도우미

**Execution profile**: standard

## 목표

`modules/testkit` 에 `temp.ts`, `git.ts`, `command.ts` 와 그 테스트를 두고, 새 node 테스트가 CI 와 로컬 실행기에서 돌게 한다.

**범위 외**: 가짜 실행 파일과 가짜 `run()`(phase 02), 측정 명령과 내보내기 경계 검사(phase 03), 새 실행기(계획 test-runner).

## 컨텍스트

- 테스트 파일 114개 가운데 83개가 임시 폴더를, 43개가 `git init` 을, 28개가 자기 `git()` 도우미를 따로 둔다(스펙 「테스트 도우미의 중복」). 이 phase 는 도우미만 만들고 기존 테스트를 옮기지 않는다.
- 따를 기존 패턴: `skills/orch/tests/fixtures/cleanup-sweep.ts` 의 `sh`, `git`(종료 코드가 0 이 아니면 실패, stdout trim), `makeRepo`(템플릿 한 벌을 만들어 `cpSync` 로 복사하고 `remote set-url`), `beforeEach` 의 git 격리 환경 변수(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, 작성자·커미터 이름과 메일).
- testkit 은 Node 내장 모듈만 import 하고 저장소의 다른 폴더를 import 하지 않는다(설계 「책임과 경계」). 타입 제거가 지우는 문법만 쓴다(`docs/code-architecture.md` 「실행 규칙」).

**요구사항**: REQ5

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md` 「testkit 의 모듈」

## 의도 메모

- `node:test` 의 `after` 를 `beforeEach`, `before` 안에서 부르면 그 훅이 끝나자마자 돈다. 테스트 본문보다 먼저다(2026-11-05 실험). 그래서 `tempDir` 은 모듈 수준 목록에 모으고, 모듈을 처음 평가할 때 루트 `after` 하나와 `process.on('exit')` 를 건다. `t` 를 받으면 `t.after` 를 쓴다.
- `node:test` 를 import 하는 testkit 파일은 `temp.ts` 하나로 둔다. 일반 스크립트가 그 파일을 import 하면 stdout 끝에 node:test 요약이 붙는다.
- `runCommand` 는 자식 환경에서 `NODE_TEST_CONTEXT` 를 지운다. 테스트 안에서 띄운 `node --test` 가 그 값을 물려받으면 reporter 출력이 사라진다.

## 작업 항목

### 1. `modules/testkit/temp.ts`

- `export function tempDir(prefix = 'testkit-', t?: { after(fn: () => void): void }): string`. `realpathSync(mkdtempSync(join(tmpdir(), prefix)))` 를 돌려준다.
- `t` 가 없으면 모듈 수준 배열에 넣는다. 모듈 최상위에서 `after(cleanupAll)` 과 `process.on('exit', cleanupAll)` 을 한 번 건다. `cleanupAll` 은 두 번 불려도 안전하다.
- `TESTKIT_KEEP=1` 이면 지우지 않고 `testkit: 남긴 폴더 <경로>` 를 stderr 에 한 줄씩 낸다.

### 2. `modules/testkit/git.ts`

- `gitEnv(base: NodeJS.ProcessEnv = process.env, opts: { ceiling?: string } = {})`: 사본에 `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` 를 넣는다. `ceiling` 을 주면 `GIT_CEILING_DIRECTORIES` 를 건다.
- `git(cwd: string, args: string[], env = gitEnv()): string`: `spawnSync('git', args, { cwd, env, encoding: 'utf8' })`. 0 이 아니면 명령과 stderr 를 담은 `Error` 를 throw 하고, 아니면 stdout 을 trim 해 돌려준다.
- `templateRepo(): { origin: string; dir: string }`: 프로세스마다 처음 한 번 `tempDir`(프로세스 단위 목록) 아래에 `git init -q --bare -b main` 한 origin 과, clone 해 빈 커밋 `init` 을 push 한 작업 폴더를 만든다. 다음 호출은 같은 값을 돌려준다.
- `copyRepo(dest: string, template = templateRepo()): { origin: string; dir: string }`: `dest-origin.git` 과 `dest` 로 `cpSync(..., { recursive: true })` 하고 `git remote set-url origin <새 origin>` 을 한다.

### 3. `modules/testkit/command.ts`

- 결과 꼴 `CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }`.
- `runCommand(argv: string[], opts: { cwd?; env?; input?; timeoutMs? } = {})`: `spawnSync(argv[0], argv.slice(1), ...)`. env 는 받은 값(없으면 `process.env`)의 사본에서 `NODE_TEST_CONTEXT` 를 지운다. 시간 초과는 `spawnSync` 의 `timeout` 과 `error.code === 'ETIMEDOUT'` 로 `timedOut: true` 다.
- `runCommandAsync(argv, opts)`: 같은 꼴을 Promise 로 돌려준다. `spawn` 과 타이머를 쓰고 시간이 지나면 SIGKILL 한다.
- `nodeScript(script: string, args: string[] = []): string[]` 는 `[process.execPath, script, ...args]` 다.

### 4. 이 phase 를 검증하는 `modules/testkit/tests/temp.spec.ts`, `git.spec.ts`, `command.spec.ts`

- temp: `beforeEach` 에서 만든 폴더가 테스트 본문에서 있다. 자식 프로세스로 작은 테스트 파일을 `node --test` 로 돌려, 그 파일이 만든 폴더(경로를 stdout 에 냄)가 파일이 끝난 뒤 없다. 같은 자식을 `TESTKIT_KEEP=1` 로 돌리면 폴더가 남고 stderr 에 경로가 있다(검사 뒤 지운다). `t` 를 준 폴더는 그 테스트의 `after` 뒤 없다.
- git: `gitEnv` 아래 `git config user.name` 이 testkit 값이다. `copyRepo` 두 번이 서로 다른 origin 을 가리키고, 사본에서 커밋해 `push` 하면 그 사본의 origin 에만 들어간다. 실패한 명령(`git rev-parse --verify nope`)은 throw 하고 메시지에 stderr 가 있다.
- command: 종료 코드 3, 신호로 끝남(`process.kill(process.pid, 'SIGTERM')`), stdin 을 그대로 돌려줌, 시간 초과(`timeoutMs: 200` 으로 오래 자는 자식)에서 `timedOut: true`. 부모에 `NODE_TEST_CONTEXT` 가 있어도 자식 `node -e` 가 그 값을 보지 못한다.

### 5. 새 테스트가 돌게 하는 설정

- `.github/workflows/ci.yml` 의 「Run orch, work-board and inbox node tests」 줄과 `scripts/run-node-tests.ts` 의 `DEFAULT_PATTERNS` 에 `"modules/testkit/tests/*.spec.ts"` 와 `"scripts/tests/*.spec.ts"` 를 더한다. 두 곳의 목록은 같아야 한다. `scripts/tests/*.spec.ts` 는 phase 03 의 검사가 쓴다.
- `tsconfig.json` 의 `include` 에 `"modules/**/*.ts"` 를 더한다.
- 계획 test-runner 가 먼저 머지되면 `scripts/run-node-tests.ts` 는 지워졌고 CI 는 `node scripts/run-tests.ts` 하나다. 그때는 rebase 하며 이 항목의 CI·`DEFAULT_PATTERNS` 수정을 버린다. 새 실행기가 `tests/` 아래 `*.spec.ts` 를 찾으므로 두 패턴이 저절로 든다. `tsconfig.json` 수정은 남긴다.

### 6. `docs/code-architecture.md`

- 「범위」 표의 「플러그인과 함께 복사되지만 스킬이 아니다」 칸에 `modules/` 를 더한다.
- 「디렉터리 배치」 표에 `| \`modules/\` | 여러 영역의 테스트와 코드가 함께 쓰는 공용 모듈. 스킬이 아니다. 팀 저장소로 내보내지 않는다 |` 행을 더하고, 표 아래 배치 결정 문장 뒤에 「`modules/` 는 test-speed 스펙(`docs/features/test-speed/spec.md`) DECISION7 이 정했다」 를 링크로 적는다.

## 검증

```bash
node --test modules/testkit/tests/temp.spec.ts modules/testkit/tests/git.spec.ts modules/testkit/tests/command.spec.ts
python3 -m unittest discover -s scripts/tests
git grep -n "modules/testkit/tests" -- .github/workflows/ci.yml scripts/run-node-tests.ts
```

`tsc` 는 CI 와 같은 명령으로 돌린다(임시 폴더 설치).

```bash
npm install --no-save --no-audit --no-fund --prefix "$TMPDIR/tsc" typescript@5.9.3 @types/node@24 && "$TMPDIR/tsc/node_modules/.bin/tsc" -p tsconfig.json --typeRoots "$TMPDIR/tsc/node_modules/@types"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `modules/testkit/temp.ts` | 신규 |
| `modules/testkit/git.ts` | 신규 |
| `modules/testkit/command.ts` | 신규 |
| `modules/testkit/tests/temp.spec.ts` | 신규 |
| `modules/testkit/tests/git.spec.ts` | 신규 |
| `modules/testkit/tests/command.spec.ts` | 신규 |
| `.github/workflows/ci.yml` | 수정 |
| `scripts/run-node-tests.ts` | 수정 |
| `tsconfig.json` | 수정 |
| `docs/code-architecture.md` | 수정 |
