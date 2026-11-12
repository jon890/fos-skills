# Phase 02. 설정 값 판정을 core 로 옮긴다

**Execution profile**: standard

## 목표

검사표(phase 03)가 부를 순수 판정과 키 목록을 `skills/orch/scripts/core/` 로 옮긴다. 지금 호출자의 동작은 바꾸지 않는다.

**범위 외**: 검사표 작성(phase 03), 판정 내용의 변경.

## 컨텍스트

**요구사항**: REQ6

**근거 문서**: `docs/features/orch-config-cli/design.md` 「책임과 경계」, `docs/adr/028-orch-core-layer.md`

- core 는 core 안의 상대 모듈과 `node:path`, `node:crypto` 만 import 하고 `process`, `Date.now()`, `require`, 동적 import 를 쓰지 않는다. 검사는 `skills/orch/tests/core-boundary.spec.ts` 다.
- 옮긴 함수는 원래 자리에서 재수출해 지금 호출자를 고치지 않는다. `lib/config.ts` 가 `core/config.ts` 를 재수출하는 꼴(`skills/orch/scripts/lib/config.ts` 58-59행)을 따른다.
- `ConfigError` 는 `core/config.ts` 에 있다. `section` 도 같은 파일이다.

## 의도 메모

- `compileHeavy` 는 틀린 정규식을 `heavy-slot.ts` 의 지역 클래스 `Usage` 로 던지고, `heavy-slot.ts` 495, 509행이 `Usage` 와 `ConfigError` 를 가려 잡는다. core 로 옮길 때 두 번째 인자로 정규식 오류를 만드는 함수를 받아(`badRegex: (message: string) => Error`, 기본은 `ConfigError`) `heavy-slot.ts` 는 지금처럼 `Usage` 를 넘긴다.
- 이벤트 이름과 cleanup 키는 몸체(`EVENTS` 의 핸들러 사양, `handoff-cleanup.ts` 의 `OPTIONS`)가 명령 쪽에 붙어 있어 목록만 core 에 둔다. 두 벌이 어긋나지 않게 아래 작업 6, 7 의 검사를 둔다.
- `loop/steps/shared.ts` 의 `StallState` 는 core 가 import 할 수 없어 core 에 `'error' | 'idle'` 키 타입을 따로 둔다.

## 작업 항목

### 1. `contractSettings` → `skills/orch/scripts/core/contracts.ts`

`lib/contract-merge.ts` 49-61행의 `contractSettings` 와 `ContractSettings` 타입을 옮긴다. 의존은 `core/config.ts`(`section`, `CONTRACTS_KEYS`, `ConfigError`), `core/regexp.ts`(`pyRegExp`), `core/refresh.ts`(`joined`)다. `lib/contract-merge.ts` 는 재수출한다.

### 2. `dockerRules` → `skills/orch/scripts/core/docker.ts`

`lib/docker.ts` 84-112행의 `dockerRules` 와 그것이 쓰는 지역 함수(`compile`, `unknownKeys`), 상수(`DOCKER_KEYS`, `CONTAINER_RULE_KEYS`, `IMAGE_RULE_KEYS`, `DEFAULT_KEEP`), 타입(`DockerRules`, `ContainerRule`, `ImageRule`)을 옮긴다. `lib/docker.ts` 는 재수출하고 프로세스·docker 호출 코드는 그대로 둔다. `DOCKER_KEYS` 는 `core/config.ts` 의 다른 키 목록과 같은 자리에도 재수출한다.

### 3. `adrDirs` → `skills/orch/scripts/core/reservations.ts`

`lib/reservations.ts` 189-201행의 `adrDirs` 를 새 파일로 옮기고 `lib/reservations.ts` 는 재수출한다.

### 4. `compileHeavy` → `skills/orch/scripts/core/heavy.ts`

`slot/heavy-slot.ts` 101-119행의 `compileHeavy` 와 `Heavy` 타입을 옮긴다. 시그니처는 `compileHeavy(body: Record<string, unknown>, badRegex?: (message: string) => Error): Heavy` 다. `heavy-slot.ts` 는 `(message) => new Usage(message)` 를 넘긴다(`Usage` 는 `heavy-slot.ts` 89행의 `class Usage extends Error {}` 다).

### 5. `stallTicks` → `skills/orch/scripts/core/loop.ts`

`loop/steps/context.ts` 34행의 `DEFAULT_STALL_TICKS` 와 69-83행의 `stallTicks` 를 `core/loop.ts` 에 내보내기로 옮긴다. 키 타입은 `export type StallTickState = 'error' | 'idle'` 다. `context.ts` 는 core 의 것을 import 한다.

### 6. 이벤트 이름 목록

`core/config.ts` 에 `HOOK_EVENT_NAMES: readonly string[]` 을 둔다. 값은 `lib/events.ts` 152행 `EVENTS` 의 키와 같은 순서다. `skills/orch/tests/lib-events.spec.ts` 에 `Object.keys(EVENTS)` 와 `HOOK_EVENT_NAMES` 가 같다는 테스트를 더한다.

### 7. cleanup 키 목록

`core/config.ts` 에 `CLEANUP_KEYS: readonly string[]` 을 둔다. 값은 지금 `cleanup/handoff-cleanup.ts` 108-111행이 `OPTIONS` 에서 만드는 목록과 같다. `handoff-cleanup.ts` 는 지역 계산을 남기고, 시작할 때 그 결과가 core 의 목록과 다르면 `Error('CLEANUP_KEYS 가 OPTIONS 와 다르다')` 를 던진다. 설정 읽기에는 core 의 목록을 쓴다. 이 파일은 import 하면 바로 실행되므로(`import.meta.main` 가드가 없다) 테스트는 지금의 `skills/orch/tests/handoff-cleanup.spec.ts` 가 명령을 돌리는 것으로 대신한다.

### 8. 테스트

지금 테스트를 고치지 않고 통과시키는 것이 동작 보존의 증거다. 아래를 더한다.

- `skills/orch/tests/core-config-moved.spec.ts`(신규): 옮긴 다섯 함수를 core 경로로 불러 대표 입력 하나씩 확인한다(정상 하나, `ConfigError` 하나). `compileHeavy` 는 `badRegex` 를 넘기면 그 오류를 던지는지 본다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/core-config-moved.spec.ts skills/orch/tests/core-boundary.spec.ts skills/orch/tests/contract-merge.spec.ts skills/orch/tests/lib-docker.spec.ts skills/orch/tests/cleanup-sweep-docker.spec.ts skills/orch/tests/lib-reservations.spec.ts skills/orch/tests/reserve-migration.spec.ts skills/orch/tests/heavy-slot.spec.ts skills/orch/tests/orch-loop-stall.spec.ts skills/orch/tests/lib-events.spec.ts skills/orch/tests/handoff-cleanup.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과. 지금 테스트 파일은 `lib-events.spec.ts` 말고 고치지 않는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/contracts.ts` | 신규 |
| `skills/orch/scripts/core/docker.ts` | 신규 |
| `skills/orch/scripts/core/reservations.ts` | 신규 |
| `skills/orch/scripts/core/heavy.ts` | 신규 |
| `skills/orch/scripts/core/loop.ts` | 수정 (`stallTicks`, `DEFAULT_STALL_TICKS`) |
| `skills/orch/scripts/core/config.ts` | 수정 (`HOOK_EVENT_NAMES`, `CLEANUP_KEYS`, `DOCKER_KEYS` 재수출) |
| `skills/orch/scripts/lib/contract-merge.ts` | 수정 (재수출) |
| `skills/orch/scripts/lib/docker.ts` | 수정 (재수출) |
| `skills/orch/scripts/lib/reservations.ts` | 수정 (재수출) |
| `skills/orch/scripts/slot/heavy-slot.ts` | 수정 (core 의 `compileHeavy` 사용) |
| `skills/orch/scripts/loop/steps/context.ts` | 수정 (core 의 `stallTicks` 사용) |
| `skills/orch/scripts/cleanup/handoff-cleanup.ts` | 수정 (core 의 `CLEANUP_KEYS` 와 대조) |
| `skills/orch/tests/lib-events.spec.ts` | 수정 |
| `skills/orch/tests/core-config-moved.spec.ts` | 신규 |
