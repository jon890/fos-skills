# Phase 03. 설정 키 검사표

**Execution profile**: standard

## 목표

`skills/orch/scripts/core/config-schema.ts` 에 아는 설정 키마다 값 검사를 두고, 파일 전체의 문제를 모으는 `problems`, 경로를 판정하는 `knownPath`, 루프 재시작 키 `RESTART_KEYS` 를 만든다.

**범위 외**: 읽는 곳과의 대조 테스트(phase 04), doctor 연결(phase 05), `orch config` 명령(다음 PR).

## 컨텍스트

**요구사항**: REQ6

**근거 문서**: `docs/features/orch-config-cli/design.md` 「검사표」, 「키별 검사 기준」, 「짝 규칙」, 「설계 단계 실측」, `docs/features/orch-config-cli/spec.md` REQ6, 「요구사항과 인수 조건」 머리의 「아는 이름」 정의

- zod 4.6.7 은 phase 01 이 루트 `package.json` 에 들였다. `import * as z from 'zod'` 로 쓴다.
- 키별 기준의 원본은 설계의 「키별 검사 기준」 표다. 그 표의 행마다 스키마나 기존 core 판정 하나를 둔다. 표에 없는 꼴을 만들어 내지 않는다.
- 기존 core 판정: `autoMergeConfig`(`core/auto-merge.ts` 137행), `boardSettingsFromConfig`(`core/milestones.ts` 94행), `autoAdvanceOf`(`core/auto-advance.ts` 82행), `refreshSettings`·`joined`(`core/refresh.ts` 21, 14행), `pyRegExp`(`core/regexp.ts`), `groupMap`(`core/overlap.ts` 39행), phase 02 가 옮긴 `contractSettings`, `dockerRules`, `adrDirs`, `compileHeavy`, `stallTicks`. 모르는 리뷰 조건 이름은 `autoMergeConfig(...).review.unknown` 과 `unknownConditionsText`(`core/auto-merge.ts`)로 얻는다.
- 키 목록: `core/config.ts` 의 `HOOKS_KEYS`, `QUEUE_KEYS`, `PIPELINE_KEYS`, `HEAVY_KEYS`, `MIGRATIONS_KEYS`, `ADR_KEYS`, `CONTRACTS_KEYS`, `BOARD_KEYS`, `REVIEW_KEYS`, `ROUTING_KEYS`, `INBOX_KEYS`, `CLEANUP_KEYS`, `DOCKER_KEYS`, `HOOK_EVENT_NAMES`, `SECTIONS`, `REMOVED_CONFIG_KEYS` 와 `core/finish-options.ts` 의 `FINISH_KEYS`.
- `queue.auto_review` 의 아래 이름은 `pass`, `block`, `require`, `feature_head` 다(`core/auto-merge.ts` 71행의 `REVIEW_CONFIG_KEYS`. 지금 내보내지 않으므로 `export` 를 붙인다).

## 의도 메모

- zod 는 객체 안의 키 하나가 틀리면 그 객체에 단 `superRefine` 을 건너뛴다. 그래서 절 전체를 zod 객체로 검사하지 않고 키마다 따로, 짝 규칙도 따로 돈다.
- 기존 core 판정은 그 키 하나만 담아 부른다. config 를 받는 함수(`autoMergeConfig`, `boardSettingsFromConfig`, `autoAdvanceOf`, `contractSettings`, `dockerRules`, `adrDirs`)는 `{ [절]: { [키]: 값 } }`, 절 몸통을 받는 `compileHeavy` 는 `{ [키]: 값 }`, 값을 받는 `stallTicks` 는 값 그대로다. 판정이 절의 모르는 키를 먼저 막거나 첫 오류만 던져도 다른 키에 가리지 않는다. `contractSettings` 는 두 키가 함께 있어야 판정하므로 키별 검사는 짝 키에 통과하는 값을 채워 부르고, 짝은 짝 규칙이 본다. `refresh_worker_paths` 는 `refreshSettings` 가 `refresh_slots` 0 이면 보지 않으므로 따로 zod 스키마(`joined` 꼴과 `pyRegExp`)를 둔다.
- 거절 이유는 파싱마다 `{ error: z.locales.ko().localeError }` 꼴로 한국어 로케일을 넘긴다. 전역 `z.config` 는 부르지 않는다. 정확한 옵션 이름은 zod 4.6.7 의 `.d.ts` 에서 확인한다.
- 이 모듈은 파일을 읽지 않는다. core 경계(`node:path`, `node:crypto` 와 core 상대 모듈)에 `zod` 하나를 더한다.

## 작업 항목

### 1. `skills/orch/scripts/core/config-schema.ts`

내보내는 것:

- `type Problem = { path: string; reason: string; kind: 'structure' | 'unknown' | 'removed' | 'value' | 'pair' }`. 이유 문구 가운데 세 가지는 이렇게 정한다. 모르는 절·키·이름은 경로가 그 이름이고 이유는 `모르는 키다`(절이면 `모르는 절이다. <아는 절 목록> 중 하나다`). 옛 칸은 이유가 `orch 5.2.0 에서 지운 설정이다. orch doctor migrate-hooks --apply 로 핸들러에 옮긴다`. 모르는 리뷰 조건은 경로가 `queue.auto_review.require` 이고 이유가 `모르는 조건이 있다: <이름>. 쓸 수 있는 조건: <목록>` 이다(`core/auto-merge.ts` 의 `unknownConditionsText` 에서 경로 앞부분을 뗀 문구).
- `KEYS`: 절에서 키에서 검사로. 검사는 `{ kind: 'zod', schema }` 나 `{ kind: 'core', check: (value) => Problem[], names?: readonly string[] | 'free' }` 다. core 판정은 키 하나만 담은 설정으로 부르고 `ConfigError` 의 메시지를 그 키 경로의 `value` 문제 하나로 돌려준다. `queue.auto_review` 의 check 는 여기에 더해 `autoMergeConfig(...).review.unknown` 이 비지 않으면 경로 `queue.auto_review.require`, `kind: 'value'` 문제를 하나 더 돌려준다.
- `PAIRS`: 절에서 `{ keys: readonly string[]; check(body: Record<string, unknown>): string | null }` 목록으로. 설계 「짝 규칙」 표의 일곱 줄이다. 문제의 경로는 `<절>.<keys[0]>` 이다.
- `problems(raw: unknown): Problem[]`: 차례는 최상위 객체 여부(경로 `config.json`), 절 이름(경로 `<절>`), 절이 객체인지, 옛 설정 칸(`REMOVED_CONFIG_KEYS`, 이유에 `orch doctor migrate-hooks --apply` 를 담는다), 절의 모르는 키, 키별 검사(zod 문제의 `path` 를 키 경로 뒤에 `.` 으로 잇는다. `unrecognized_keys` 문제는 키마다 한 문제로 나눈다), 짝 규칙(규칙의 키 하나라도 자기 검사에서 틀렸으면 건너뛴다)이다. 모든 키와 규칙은 서로 독립으로 돈다.
- `knownPath(names: readonly string[]): 'known' | 'unknown' | 'removed'`: `KEYS` 를 따라 내려간다. zod `strictObject` 는 `shape` 의 키, `record` 는 어떤 이름이든 안다. core 판정은 `names` 로 안다(`'free'` 는 어떤 이름이든). 그 밖의 스키마 아래 이름은 모른다. `REMOVED_CONFIG_KEYS` 의 경로와 그 아래는 `removed` 다.
- `RESTART_KEYS: readonly string[]` = `['pipeline.tick_sec', 'finish.run', 'finish.specs_dir']`.
- `TIMER_MAX_SEC = 2147483`.

### 2. `skills/orch/tests/core-boundary.spec.ts`

허용 import 에 `zod` 를 더한다. 지금 조건(`name !== 'node:path' && name !== 'node:crypto'`)에 `name !== 'zod'` 를 더하는 꼴이다. `config-schema.ts` 밖의 core 파일이 `zod` 를 import 하면 실패하게 파일 이름도 함께 본다.

### 3. `scripts/runtime-policy.json` 의 `bare_imports` 와 문서

- `{ "path": "skills/orch/scripts/core/config-schema.ts", "name": "zod" }` 를 더한다.
- `docs/code-architecture.md` 「orch 코어와 핸들러」 의 「core 는 core 안의 상대 모듈과 허용한 내장 모듈만 가져온다」 를 「core 는 core 안의 상대 모듈, 허용한 내장 모듈과 `config-schema.ts` 의 `zod` 만 가져온다」 로 고친다.

### 4. `skills/orch/tests/core-config-schema.spec.ts`(신규)

- 키 목록 대조: 절마다 `KEYS` 의 키 집합이 지금 키 목록(위 컨텍스트의 목록, `finish` 는 `FINISH_KEYS`)과 같다. `SECTIONS` 의 모든 절이 `KEYS` 에 있다.
- 표본: 키마다 `{ good: [...], bad: [...] }` 표본을 이 테스트 파일 안의 표 하나로 두고, 표에 없는 키가 있으면 실패한다. good 은 `problems({ [절]: { [키]: 값 } })` 에 그 키 경로나 그 아래의 `value`·`unknown` 문제가 없다는 뜻이다(짝 규칙 문제는 짝 키가 없어 생길 수 있으므로 여기서 보지 않는다). bad 는 그 키 경로나 그 아래의 `value` 문제가 하나 이상이다. 설계 「키별 검사 기준」 의 경계 값을 표본에 넣는다(예: `tick_sec` 2147483 good, 2147484 bad. `worker_done_timeout` 0 good, `merge_timeout` 0 bad. `finish.run` null good. `finish.specs_dir` null bad. `queue.required` `"A,,B"` good. `inbox.enabled` `"false"` bad).
- 짝 규칙: 일곱 규칙마다 위반 하나와 통과 하나. 같은 절에 오타 키(`poll_min_secs`)나 다른 키의 틀린 값이 있어도 짝 규칙 문제가 나온다.
- 구조: 최상위 배열, 모르는 절 `queu`, 객체가 아닌 절, 옛 칸 `queue.before` 가 각각 문제 하나다.
- `knownPath`: `queue.auto_review.pass` known, `queue.auto_review.prass` unknown, `hooks.timeouts.after-queue` known, `hooks.timeouts.foo` unknown, `migrations.dirs.anything` known, `queue.before` removed, `queu.x` unknown.
- 이유 문구가 한국어다(zod 기본 영어 문구 `Invalid input` 이 들어가지 않는다).

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-config-schema.spec.ts skills/orch/tests/core-boundary.spec.ts scripts/tests/runtime-policy.spec.ts
node scripts/runtime-policy.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 테스트 통과, `runtime-policy.ts` 종료 코드 0, tsc 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/config-schema.ts` | 신규 |
| `skills/orch/scripts/core/auto-merge.ts` | 수정 (`REVIEW_CONFIG_KEYS` 내보내기) |
| `skills/orch/tests/core-boundary.spec.ts` | 수정 (`zod` 허용) |
| `scripts/runtime-policy.json` | 수정 (`bare_imports` 에 `zod`) |
| `docs/code-architecture.md` | 수정 (core 의 허용 의존) |
| `skills/orch/tests/core-config-schema.spec.ts` | 신규 |
