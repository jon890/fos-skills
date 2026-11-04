# Phase 01. 명령 표와 진입점의 새 꼴·옛 꼴 해석, 번들 범위 규칙

**Execution profile**: deep

## 목표

`skills/orch/bin/orch.ts` 가 `orch <묶음> <동작> [인자]` 새 꼴과 옛 이름을 같은 명령 표로 풀어 같은 스크립트를 같은 인자로 부르고, user 범위 설치본이 있으면 다른 범위로 넘어가지 않게 한다.

**범위 외**: 문맥 기본값 채우기(phase 02), PATH 실행기 `bin/orch` 와 `install-cli`(phase 03), 짧은 출력(PR2), 폴더 이동(PR3).

## 컨텍스트

**요구사항**: REQ2, REQ5, REQ6

**근거 문서**: `docs/features/orch-cli/spec.md` 의 「명령 표」, REQ2·REQ5·REQ6, DECISION1·DECISION3·DECISION7. `docs/features/orch-cli/design.md` 의 「책임과 경계」(실행기와 진입점의 자식 실행, 번들 고르기의 원본, 진입점, 명령 표), 「명령 표 항목」, 「옛 꼴 안내와 `--help`, `--path`」, 「실패와 일관성」 의 번들 고르기와 신호 누수, 결정 DECISION14.

- 지금 진입점 `skills/orch/bin/orch.ts` 는 `NAME [인자]` 와 `--path [NAME]` 만 받는다. 번들은 `ORCH_SCRIPTS_DIR` → 설치 기록(user 먼저, 다른 범위가 뒤) → 진입점이 든 번들 순으로 고른다. 의존은 Node 내장 모듈뿐이다.
- `skills/orch/scripts/lib/bundle.ts` 의 `staleBundleWarning` 이 같은 고르기 규칙을 따로 가진다(user 먼저, 없으면 다른 범위). `canonical()` 은 실경로 비교다.
- 테스트 `skills/orch/tests/orch-entry.spec.ts` 는 임시 설정 폴더와 가짜 번들(`bundle()`, `install()`)로 진입점을 돌린다. 이 패턴을 넓힌다.
- 이 phase 동안 새 꼴과 옛 꼴은 지금 출력 그대로를 낸다(스펙 DECISION14).

## 의도 메모

- 명령 표를 진입점 파일에 두지 않고 `lib/commands.ts` 로 뺀다. doctor(문서 판정, phase 05)와 훅(대기 판정, phase 04)이 같은 표를 읽어야 해서다(설계 DECISION6). 진입점은 이 lib 를 import 하므로 「진입점 파일 하나만 복사해 써도 된다」 성질은 phase 03 의 실행기가 물려받는다.
- 진입점이 현재 번들이 아닌 번들에서 불렸으면 현재 번들의 진입점에 인자를 그대로 넘긴다(설계 DECISION7). 다시 넘기지 않도록 `ORCH_ENTRY_HOP` 을 센다.
- 옛 꼴은 지금처럼 `lib/args.ts` 의 접두 펼치기를 그대로 받는다. 새 꼴은 「명령 표」 의 마지막 칸에서 동작으로 바뀐 모드 플래그(`forbid`)를 사용법 오류(2)로 거부한다.

## 작업 항목

### 1. `skills/orch/scripts/lib/install-record.ts` 신규

- `canonical(path)`(지금 `lib/bundle.ts` 의 것을 옮긴다)와 `selectBundle(configDir: string, own: string): { bundle: string; reason: string } | { error: string }` 를 export 한다. 내장 모듈만 쓰고 import 할 때 부수 효과가 없다.
- 규칙은 설계 「실패와 일관성」 의 번들 고르기다. `ORCH_SCRIPTS_DIR` 은 부르는 쪽이 먼저 본다(이 함수는 설치 기록과 `own` 만 본다).
- 사례 표 `skills/orch/tests/fixtures/install-records.json` 을 만든다. 행마다 설치 기록, 있는 폴더, 기대 결과(고른 번들 또는 오류)다. 사례: user 하나, user 에 스크립트 없음 + project 있음(오류), user 가 3.x 배치(오류), user 없음 + project 둘(기록 순서), 기록 없음(own), 기록 깨짐(own). phase 03 의 실행기와 phase 06 의 틀 풀이가 같은 표를 쓴다.

### 2. `skills/orch/scripts/lib/commands.ts` 신규

- 설계 「명령 표 항목」 의 `Command` 타입(`required`, `runFrom`, `skip`, `legacy: { name, flags }`, `usage` 포함)과 스펙 「명령 표」 의 모든 행을 담은 `COMMANDS: Command[]` 를 export 한다. 이 phase 에서 `context`, `explicit`, `required`, `runFrom`, `skip` 필드는 설계의 「문맥 칸」 표대로 값을 채우되 읽는 코드는 phase 02 에서 쓴다.
- `script` 는 지금 경로(`wait-important.ts` 처럼 scripts 바로 아래)다. PR3 이 이 칸만 바꾼다.
- `orch doctor` 는 `orch-doctor.ts`, `orch paths` 는 `orch_paths.ts`, `orch doctor install-cli` 는 phase 03 이 만들 `install-cli.ts` 를 가리킨다. `orch status` 는 PR2 의 몫이라 이 PR 의 표에 넣지 않는다.
- export 할 함수:
  - `resolveNew(argv: string[]): { command: Command; args: string[] } | { error: string }` — 묶음과 동작을 찾고 `positional` 을 옵션으로 바꾸고 `prepend` 를 앞에 붙인다. 금지 검사는 위치 인자 변환과 `prepend` 보다 먼저, 사용자가 준 인자의 첫 `--` 앞에만 한다. `forbid` 에 든 플래그나 그 줄여 쓴 꼴(`--ack-l`, `--sta`)이면 error 다. 단 명령 표의 `allow` 에 적은 이름(그 스크립트의 옵션이면서 금지 플래그의 접두인 것)과 정확히 같은 낱말은 금지하지 않는다. `wait` 의 `allow` 는 `--ack` 다(`wait-important.ts` 911줄 근처의 옵션). 구현 때 금지 플래그마다 그 스크립트 parseArgs 옵션 가운데 접두가 겹치는 이름을 찾아 `allow` 에 넣고, 테스트가 그 대응을 확인한다. 두 낱말 동작(`queue reserve prune`)은 긴 동작부터 맞춘다.
  - `resolveLegacy(name: string, args: string[]): { command: Command; hint: string } | null` — 옛 이름(`wait-important`, `wait-important.ts`)과 `legacy.flags` 조합으로 새 꼴 안내 문자열(`orch loop start` 같은 것)을 만든다. 인자는 바꾸지 않는다.
  - `scriptPath(dir: string, name: string): string | null` — 옛 이름이나 스크립트 파일 이름으로 `script` 를 풀어 경로를 낸다. `--path` 가 쓴다.
  - `legacyNames(): string[]`, `newForms(): string[]` — doctor 와 테스트가 읽는다.
- 같은 옛 이름이 여러 동작에 쓰이면 행마다 `legacy.flags` 로 구분하고, 플래그 없는 행이 그 이름의 기본 동작이다. `orch-loop` 처럼 플래그 없이는 동작이 없는 이름은 플래그 없는 행을 두지 않는다(그때 옛 꼴은 안내 없이 지금처럼 스크립트를 부른다).

### 3. `skills/orch/bin/orch.ts` 고침

- 첫 인자가 명령 표의 묶음 이름이면 새 꼴, 아니면 지금처럼 옛 이름(`NAME`, `NAME.ts`), `--path [NAME]`, `--help` 로 푼다. 새 꼴 묶음 이름과 겹치는 옛 스크립트 이름이 없음을 테스트로 고정한다.
- 옛 꼴로 부르면 stderr 에 `orch: 새 꼴: orch …` 한 줄을 낸다(REQ5). `--path` 는 안내만 내고 지금처럼 경로를 낸다.
- 정적 import 는 내장 모듈만 둔다. `../scripts/lib/install-record.ts` 를 동적 `import()` 로 읽어 번들 고르기와 넘기기를 먼저 정하고, `lib/commands.ts` 는 그 뒤에 읽는다. 옛 번들 진입점이 넘길 때 그 번들의 `lib/bundle.ts` 가 STALE-BUNDLE 을 찍지 않게 하려는 것이다. `install-record.ts` 를 읽지 못하면(진입점 파일만 복사한 사본) 「진입점만 복사해 쓰지 않는다. 플러그인 루트의 실행기 `bin/orch` 를 복사한다」 를 내고 3 으로 끝난다. 파일 하나로 도는 성질은 phase 03 의 실행기가 물려받는다(설계 「진입점」).
- 번들 고르기: `ORCH_SCRIPTS_DIR` 이 있으면 그 폴더의 `../bin/orch.ts` 가 자기와 다를 때 그 진입점으로 넘기고, 같으면 그 폴더를 쓴다. 아니면 `selectBundle(configDir, 자기 번들)`. 오류면 이유와 그 번들의 진입점 경로를 내고 3 으로 끝난다(REQ6).
- 자기 번들이 고른 번들과 `canonical()` 로 다르고 `ORCH_ENTRY_HOP` 이 비었으면 고른 번들의 `skills/orch/bin/orch.ts` 를 `ORCH_ENTRY_HOP=1` 로 실행하고 종료 코드를 그대로 돌려준다. 고른 번들에 진입점이나 `skills/orch/scripts/lib/commands.ts` 가 없으면(이 기능 이전 번들) 넘기지 않고 이유와 플러그인 갱신 명령(`claude plugin update fos-skills@fos-skills`)을 내고 3 으로 끝난다.
- 스크립트 자식의 환경에서 `ORCH_ENTRY_HOP` 을 지운다. 자식 실행은 지금의 `forward`(신호 전달, 128+신호 번호)를 그대로 쓴다.
- `--path [이름]` 은 옛 꼴로 받고, 이름이 있으면 `scriptPath()` 로 푼다.
- `--help` 는 설계 「옛 꼴 안내와 `--help`, `--path`」 대로 낸다(스펙 DECISION10).
- 머리 주석의 사용법, 번들 고르기 차례, 종료 코드를 새 동작으로 고친다.

### 4. `skills/orch/scripts/lib/bundle.ts` 의 고르기 규칙 맞추기

`staleBundleWarning` 이 현재 설치본을 `selectBundle()` 로 정한다. `selectBundle` 이 오류면 경고하지 않는다(null). `plugins/cache` 밖은 판정하지 않는 지금 예외는 그대로다. `canonical` 은 `install-record.ts` 에서 import 한다.

### 5. 테스트

- `skills/orch/tests/lib-install-record.spec.ts` 신규: `fixtures/install-records.json` 의 행마다 `selectBundle` 의 답이 기대와 같다.
- `skills/orch/tests/lib-commands.spec.ts` 신규: 스펙 「명령 표」 의 행마다 새 꼴과 옛 꼴이 같은 `script` 와 같은 최종 인자로 풀리는지 표 기반으로 본다. `orch loop --start`, `orch worker nudge --state`, 줄여 쓴 `orch wait --ack-l d` 같은 금지 플래그는 error. `orch wait --ack d1`, `orch wait ack-lost d1`, `orch worker screen t1`, `orch worker check w --spec s`, `orch queue reserve prune` 은 통과한다. 묶음 이름과 옛 스크립트 이름이 겹치지 않는다. 명령 표의 `script` 가 모두 실제 파일이다(`install-cli.ts` 는 phase 03 에서 생기므로 이 phase 에서는 그 행만 예외로 두고 phase 03 이 예외를 지운다).
- `skills/orch/tests/orch-entry.spec.ts`: 가짜 번들 도우미 `bundle()`(25~33줄)에 이 체크아웃의 `skills/orch/bin/orch.ts` 와 `skills/orch/scripts/lib/` 사본을 넣어 넘기기 뒤에도 기존 사례(55~139줄)가 돌게 한다. 바꿀 기존 사례: user 범위 번들에 스크립트가 없으면 project 범위로 넘어가던 사례(86~95줄 근처)는 3 을 기대하도록 뒤집는다. 진입점 파일만 복사한 사본 사례(112~130줄, 243~251줄 근처)는 3 과 실행기 복사 안내를 기대하도록 바꾸고, 「사본이 설치 기록을 따라간다」 는 phase 03 의 `orch-launcher.spec.ts` 가 실행기로 맡는다. 진짜 진입점을 부르는 사례는 모두 `CLAUDE_CONFIG_DIR` 을 임시 폴더로 고정한다(이 머신의 설치 기록에는 이 기능 이전 번들이 user 범위로 있다). 새 꼴이 가짜 번들의 스크립트를 앞 인자와 함께 부른다. 옛 꼴은 stderr 에 새 꼴 안내가 있고 stdout 과 종료 코드가 같다. user 범위 번들에 스크립트가 없고 project 범위에는 있는 기록에서 3 과 이유가 나온다. 옛 번들 진입점 사본으로 불러도 현재 번들 진입점이 돌고 stderr 에 STALE-BUNDLE 이 없다(가짜 번들에 진입점과 lib 사본을 넣는다). `ORCH_SCRIPTS_DIR` 이 다른 체크아웃을 가리키면 그 체크아웃의 진입점이 돈다. 스크립트 자식의 환경에 `ORCH_ENTRY_HOP` 이 없다. 진입점이 받은 SIGTERM 을 자식에게 전하고 143 으로 끝난다. `--path wait-important` 가 그 파일 경로를 낸다. `orch loop --help` 가 동작 목록을 낸다.
- `skills/orch/tests/lib-bundle.spec.ts`: user 범위 항목이 있을 때 project 범위 항목과 같은 번들이어도 경고하는 사례. 18~34줄 근처의 3.x 배치(`orch/scripts`) user 번들 사례는 `selectBundle` 오류로 경고하지 않는 기대로 바꾸거나 4.x 배치로 고친다.

## 검증

```bash
node --test skills/orch/tests/lib-install-record.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/lib-bundle.spec.ts skills/orch/tests/legacy-entrypoints.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/install-record.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 신규 |
| `skills/orch/tests/fixtures/install-records.json` | 신규 |
| `skills/orch/tests/fixtures/install-records.ts` | 신규 |
| `skills/orch/tests/lib-install-record.spec.ts` | 신규 |
| `skills/orch/bin/orch.ts` | 수정 |
| `skills/orch/scripts/lib/bundle.ts` | 수정 |
| `skills/orch/tests/lib-commands.spec.ts` | 신규 |
| `skills/orch/tests/orch-entry.spec.ts` | 수정 |
| `skills/orch/tests/lib-bundle.spec.ts` | 수정 |
