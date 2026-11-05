# Phase 02. 가짜 실행 파일과 가짜 run(), orch fixtures 이전

**Execution profile**: standard

## 목표

`modules/testkit` 에 하드 링크로 재사용하는 가짜 실행 파일(`fake-bin.ts`)과 가짜 `run()`(`fake-run.ts`)을 두고, orch fixtures 의 `fake-bin.ts` 와 `cleanup-sweep.ts` 의 가짜·저장소 준비를 그 위로 옮긴다.

**범위 외**: `merge-queue-fakes.ts` 의 `writeNodeBin` 과 테스트 파일마다 직접 쓰는 가짜(orch-cli PR3 뒤 파일 묶음 PR), 함수 주입 전환(같은 뒤 PR), 측정 명령(phase 03).

## 컨텍스트

- 지금 `skills/orch/tests/fixtures/fake-bin.ts` 의 `fakeBin(dir, name, rules, { recordEnv })` 는 테스트마다 규칙·기록 파일의 절대 경로를 본문에 박은 node 스크립트를 새로 쓴다. 그래서 내용이 늘 달라 macOS 의 첫 실행 검사(220~690ms, inode 단위)를 매번 낸다(스펙 「이 머신의 프로세스 기동 비용」). 이 함수를 쓰는 테스트는 20개 파일이고, 가짜 경로나 규칙 파일에 직접 쓰는 테스트는 없다(2026-11-05 검토 확인).
- 규칙과 기록 파일의 이름은 지금도 `<dir>/<name>.rules.json`, `<dir>/<name>.calls.jsonl` 이다. 새 본문은 같은 이름을 자기 경로(`process.argv[1]`)에서 만든다. 하드 링크로 띄운 스크립트의 `process.argv[1]` 은 링크 경로다(2026-11-05 실험. 심볼릭 링크는 다르다).
- `skills/orch/tests/fixtures/cleanup-sweep.ts` 는 이미 가짜를 파일마다 한 번 쓰고(`before`), 템플릿 저장소를 복사한다(`makeRepo`). 이 phase 는 같은 일을 testkit 함수로 바꾼다. 가짜 본문은 `FAKE_STATE`, `FAKE_LOG` 환경 변수로 상태를 받아 본문에 테스트별 경로가 없다.
- shebang 은 `#!${process.execPath}` 로 쓴다. `merge-queue-fakes.ts` 의 `writeNodeBin` 주석대로 PATH 의 node 가 버전 관리 도구의 shim 이면 호출마다 느려진다.
- 지금 `fake-bin.ts` 가 import 될 때 `process.env.ORCH_GH_CACHE = '0'` 을 거는 것은 orch 에만 맞는 동작이라 orch fixtures 에 남긴다.

**요구사항**: REQ1, REQ2, REQ5, REQ6

**근거 문서**: `docs/features/test-speed/spec.md`(DECISION6, DECISION8, DECISION17), `docs/features/test-speed/design.md` 「가짜 실행 파일」, 「testkit 의 모듈」

## 의도 메모

- 원본 보관소는 프로세스마다 하나이고 `process.on('exit')` 에서 지운다. 테스트 파일 사이에서 다시 쓰지 않는다(스펙 DECISION17). 동시에 도는 테스트 파일이 같은 원본을 고치는 경쟁을 피한다.
- 링크한 경로에 다시 `fakeBin` 하면 링크를 지우고 다시 건다. 원본에 쓰면 모든 링크가 함께 바뀌므로 원본에는 처음 한 번만 쓴다.
- 하드 링크가 실패하면(`EXDEV` 등) 복사로 물러선다. 그때는 첫 실행 검사를 내지만 동작은 같다.

## 작업 항목

### 1. `modules/testkit/fake-bin.ts`

- `export type FakeRule = { args?: string[]; stdout?: string; stderr?: string; code?: number }`, `FakeCall = { argv: string[]; env: Record<string, string | null>; cwd: string }`, `FakeBin = { path: string; calls(): FakeCall[]; setRules(rules: FakeRule[]): void }`. 지금 orch fixture 의 꼴과 같다.
- `linkBin(dir: string, name: string, body: string): string`: 본문 앞에 `#!${process.execPath}\n` 을 붙인 내용의 sha256 으로 보관소의 원본 이름을 정해 처음 한 번만 쓰고 `chmod 0o755` 한다. `dir/name` 이 있으면 지우고 `linkSync(원본, dir/name)`. 실패하면 `copyFileSync` 와 `chmod`.
- `fakeBin(dir, name, rules, opts: { recordEnv?: string[] } = {})`: `<dir>/<name>.rules.json` 에 `{ rules, recordEnv }` 를 쓰고 공용 규칙 본문을 `linkBin` 한다. 공용 본문은 `process.argv[1]` 에서 두 파일 이름을 만들고, 기록에 `{ argv: process.argv.slice(2), env, cwd }` 를 덧붙이고, `args` 가 모두 argv 에 든 첫 규칙의 stdout, stderr, 종료 코드를 낸다. 맞는 규칙이 없으면 아무것도 내지 않고 0 이다. 출력은 `fs.writeSync` 로 쓴다(파이프가 비동기인 macOS 에서 끝나기 전에 다 나가게 한다. `merge-queue-fakes.ts` 머리 주석).
- `setRules` 는 `recordEnv` 를 유지한 채 규칙만 바꾼다. `calls` 는 지금과 같다.
- 맞춤 규칙의 원본 함수 `matchRule(rules: FakeRule[], args: string[]): FakeRule | undefined` 를 내보낸다. 공용 본문은 같은 규칙을 JS 문자열로 갖는다.

### 2. `modules/testkit/fake-run.ts`

- `fakeRun(rulesByCommand: Record<string, FakeRule[]>)` 가 `{ run, calls, setRules }` 를 돌려준다.
- `run(argv: string[], opts?: unknown)`: `basename(argv[0])` 의 규칙 묶음에서 `matchRule(rules, argv.slice(1))` 의 결과를 `{ code: rule.code ?? 0, stdout: rule.stdout ?? '', stderr: rule.stderr ?? '', timedOut: false }` 로 돌려준다. 묶음이 없거나 맞는 규칙이 없으면 code 0 과 빈 출력이다.
- `calls()` 는 `{ argv, opts }` 배열, `setRules(command, rules)` 는 그 명령의 묶음을 바꾼다. `skills/orch/scripts/lib/proc.ts` 를 import 하지 않는다.

### 3. orch fixtures 이전

- `skills/orch/tests/fixtures/fake-bin.ts`: 머리 주석을 줄이고 `process.env.ORCH_GH_CACHE = '0'` 을 건 뒤 `export { fakeBin, type FakeRule, type FakeCall, type FakeBin } from '../../../../modules/testkit/fake-bin.ts'` 만 둔다.
- `skills/orch/tests/fixtures/cleanup-sweep.ts`: `before` 의 `writeFileSync`·`chmodSync` 두 곳을 `linkBin(fx.bin, name, ...)` 으로 바꾼다. 본문의 shebang 줄(`FAKE_HEAD` 첫 줄 `#!/usr/bin/env node`, docker 가짜의 `#!/usr/bin/env node\n`)은 `linkBin` 이 붙이므로 뺀다. `makeRepo` 는 testkit 의 `copyRepo(join(fx.tmp, name))` 로 바꾸되 돌려주는 값(작업 폴더 경로)과 origin 이름(`<name>-origin.git`)은 그대로 둔다.
- 두 fixtures 를 쓰는 테스트 파일은 고치지 않는다(REQ2, REQ5).

### 4. 이 phase 를 검증하는 `modules/testkit/tests/fake-bin.spec.ts`, `fake-run.spec.ts`, `fake-rules.spec.ts`

- fake-bin: 두 임시 폴더에 같은 이름의 `fakeBin` 을 만들면 `statSync(path).ino` 가 같다(REQ6). 규칙과 기록은 폴더마다 따로다(한쪽 `setRules` 가 다른 쪽 출력을 바꾸지 않는다). `recordEnv` 로 고른 변수가 기록된다. 같은 경로에 다시 만들면 새 규칙으로 답한다.
- fake-run: 명령별 묶음 선택, 맞는 규칙이 없을 때 code 0, `calls` 기록.
- fake-rules: 사례 표(명령, 규칙 목록, 인자, 기대 stdout·stderr·code) 하나를 가짜 실행 파일(`runCommand([bin, ...인자])`)과 `fakeRun({ [명령]: 규칙 }).run([명령, ...인자])` 에 같이 돌려 결과가 같다. 규칙 없음, 첫 규칙 우선, `args` 없는 규칙, 일부만 맞는 규칙을 넣는다.

## 검증

```bash
node --test modules/testkit/tests/fake-bin.spec.ts modules/testkit/tests/fake-run.spec.ts modules/testkit/tests/fake-rules.spec.ts
node scripts/run-node-tests.ts $(grep -l "fixtures/fake-bin\|fixtures/cleanup-sweep" skills/orch/tests/*.spec.ts)
git diff --stat origin/main -- skills/orch/tests/*.spec.ts
```

마지막 줄은 비어 있어야 한다(fixtures 를 쓰는 테스트 파일을 고치지 않았다). 두 번째 줄이 600초를 넘기면 `--background` 로 띄우고 출력된 `--wait` 명령을 끝 줄이 나올 때까지 다시 부른다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `modules/testkit/fake-bin.ts` | 신규 |
| `modules/testkit/fake-run.ts` | 신규 |
| `modules/testkit/tests/fake-bin.spec.ts` | 신규 |
| `modules/testkit/tests/fake-run.spec.ts` | 신규 |
| `modules/testkit/tests/fake-rules.spec.ts` | 신규 |
| `skills/orch/tests/fixtures/fake-bin.ts` | 수정 |
| `skills/orch/tests/fixtures/cleanup-sweep.ts` | 수정 |
