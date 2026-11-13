# Phase 05. orch doctor 가 설정 문제를 모두 알린다

**Execution profile**: standard

## 목표

`orch doctor` 가 설정 파일의 깨진 JSON, 모르는 절과 이름, 틀린 값, 짝 규칙 위반, 옛 설정 칸을 모두 `INVALID-CONFIG <경로> <이유>` 로 알리고 종료 코드 1 로 끝나게 한다. 검사표를 불러오지 못하면 `CLI-DEPS-MISSING` 을 내고 설정 검사만 건너뛴다.

**범위 외**: `orch config` 명령, `updateConfig`(다음 PR).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/orch-config-cli/design.md` 「doctor 줄」, 「zod 와 의존 설치」 의 「불러오는 범위」, 「설치 실패」, `docs/features/orch-config-cli/spec.md` REQ7

- 지금 설정 검사는 `skills/orch/scripts/doctor/orch-doctor.ts` 411-437행 `checkRepo` 다. `loadConfig` 실패 가운데 옛 칸(`RemovedConfigError`)만 `INVALID-CONFIG` 로 내고 나머지는 stderr 로 흘린다. 이어서 모르는 리뷰 조건과 `inbox` 절의 모르는 키만 본다. `legacyInboxFilter`(440행~)는 그대로 둔다.
- `executeMain`(723행)은 async 다. `checkRepo` 는 757행에서 부른다.
- `lib/config.ts` 의 `loadConfig` 는 검사하며 읽어 던진다. doctor 는 검사 없이 읽는 함수가 필요하다.
- zod 는 `core/config-schema.ts` 만 import 하고, 그 모듈을 부르는 명령은 `doctor/orch-doctor.ts` 와 다음 PR 의 `config/orch-config.ts` 뿐이다(설계 DECISION15). `lib/config.ts` 는 검사표를 import 하지 않는다.
- 머리 주석 137행이 `INVALID-CONFIG <이유>` 를, 162-163행이 종료 코드를 설명한다. `skills/orch/references/hooks.md` 135-136행 줄 표와 `skills/orch/SKILL.md` 34행이 이 줄을 안내한다.

## 의도 메모

- 검사표는 동적 import(`await import('../core/config-schema.ts')`)로 `executeMain` 에서 한 번 불러 `checkRepo` 에 넘긴다. 실패하면 null 을 넘기고 `CLI-DEPS-MISSING <이유>` 한 줄을 낸다. 종료 코드에는 넣지 않는다. 의존 설치가 실패한 머신에서도 나머지 doctor 검사가 돌아야 한다.
- 옛 칸 줄은 지금 테스트(`skills/orch/tests/orch-doctor.spec.ts` 590행)가 `INVALID-CONFIG .*queue.before.* doctor migrate-hooks --repo ` 를 본다. 새 이유 문구에 `orch doctor migrate-hooks --repo <저장소> --apply` 를 담아 이 꼴을 지킨다.

## 작업 항목

### 1. `skills/orch/scripts/lib/config.ts` 의 `readConfigFile`

`readConfigFile(repo: string): { file: string; exists: boolean; value?: unknown; error?: string }`. 파일이 없으면 `exists: false`, JSON 이 깨졌으면 `error` 에 이유, 아니면 `value` 다. 검사하지 않는다. 머리 주석에 함수를 더한다.

### 2. `skills/orch/scripts/doctor/orch-doctor.ts`

- `executeMain` 에서 검사표를 동적으로 불러온다. 실패하면 `CLI-DEPS-MISSING <이유>` 를 줄에 더한다.
- `checkRepo(repo, schema)` 의 설정 검사를 바꾼다. `readConfigFile` 로 읽어 `error` 면 `INVALID-CONFIG config.json <이유>`, 아니면 `schema.problems(value)` 의 문제마다 `INVALID-CONFIG <경로> <이유>` 다. 옛 칸 문제의 이유는 `orch doctor migrate-hooks --repo <저장소> --apply` 를 담는다. 검사표가 null 이면 설정 검사를 건너뛴다.
- `legacyInboxFilter` 에 넘기던 `config` 는 `value` 가 객체일 때 그것, 아니면 빈 객체다.
- 머리 주석 46-51행 「저장소 판정」 의 설정 문단(옛 칸, 리뷰 조건, 「설정 파일이 깨졌으면 stderr 에 내고 건너뛴다」, 「깨진 JSON 경고는 종료 코드를 바꾸지 않는다」)을 새 동작으로 고친다. 설정 문제는 모두 `INVALID-CONFIG <경로> <이유>` 와 종료 코드 1 이고, 검사표를 불러오지 못하면 `CLI-DEPS-MISSING` 이다.
- `removed` 문제의 이유는 `orch doctor migrate-hooks --apply` 를 `orch doctor migrate-hooks --repo <저장소> --apply` 로 바꿔 낸다. 다른 종류는 이유를 그대로 낸다.
- 머리 주석의 출력 줄(137행 근처)에 `INVALID-CONFIG <경로> <이유>` 의 문제 종류와 `CLI-DEPS-MISSING <이유>` 를, 종료 코드 줄(162행)의 「있을 수 있는 줄」 에 `CLI-DEPS-MISSING` 을 더한다(`CLI-*` 에 이미 들면 그대로 둔다).

### 3. `skills/orch/tests/orch-doctor.spec.ts`

지금 테스트 가운데 셋은 새 꼴에 맞춰 기대를 바꾼다.

- 590행(옛 칸): 그대로 통과해야 한다. 이유에 `orch doctor migrate-hooks --repo <저장소> --apply` 가 들어간다.
- 598-603행(모르는 리뷰 조건): 기대를 `^INVALID-CONFIG queue\.auto_review\.require 모르는 조건이 있다: thread-resolved\. 쓸 수 있는 조건: verdict-on-head, ` 로 바꾼다.
- 606행(아는 조건만): 그대로다.
- 636-640행(inbox 모르는 키): 기대를 `^INVALID-CONFIG inbox\.doorey 모르는 키다` 로 바꾼다.
- 642-648행(깨진 JSON 이면 종료 코드 0): REQ7 에 맞춰 `INVALID-CONFIG config.json ` 줄과 종료 코드 1 로 바꾼다.

더할 테스트:

- 틀린 값(`pipeline.tick_sec: "60"`), 오타 키(`pipeline.tick_secs`), 모르는 절(`queu`), 깨진 JSON, 짝 규칙 위반(`contracts.merge_command` 만)을 하나씩 넣은 임시 저장소마다 그 경로의 `INVALID-CONFIG` 줄과 종료 코드 1.
- 문제가 없는 설정에는 `INVALID-CONFIG` 줄이 없다.
- 검사표를 불러오지 못할 때 `CLI-DEPS-MISSING` 이 나오고 다른 줄은 지금처럼 나온다. 테스트는 `orch-doctor.ts` 가 검사표를 불러오는 경로를 환경 변수(`ORCH_CONFIG_SCHEMA` 같은 테스트 전용 이름)로 바꿀 수 있게 하고 없는 파일을 준다. 이 환경 변수는 머리 주석에 테스트용이라고 적는다.

### 4. `skills/orch/tests/core-config-schema.spec.ts`

`core/config-schema.ts` 를 import 하는 파일이 `skills/orch/scripts/` 안에서 `doctor/orch-doctor.ts` 와 `config/orch-config.ts`(다음 PR) 뿐인지 보는 테스트를 더한다. 정적 import 와 동적 import 를 모두 센다.

### 5. 변경 이력 조각

`skills/orch/changes/orch-doctor-config-problems.minor.md` 를 만든다. 내용은 `- ` 줄로 「orch doctor 가 설정 파일의 깨진 JSON, 모르는 절과 키, 틀린 값, 짝 규칙 위반을 INVALID-CONFIG <경로> <이유> 와 종료 코드 1 로 알린다」 와 「설정 검사에 쓰는 의존(zod)을 불러오지 못하면 CLI-DEPS-MISSING 을 낸다」 다. 꼴은 `README.md` 「스킬 버전」 절의 조각 규칙을 따른다.

### 6. 안내 문서

- `skills/orch/references/hooks.md` 135-136행 줄 표: `INVALID-CONFIG <경로> <이유>` 꼴과 문제 종류(깨진 JSON, 모르는 절·키, 틀린 값, 짝 규칙, 옛 칸)를 적고, `CLI-DEPS-MISSING` 줄(플러그인을 다시 설치하거나 플러그인 폴더에서 `npm ci`)을 더한다.
- `skills/orch/SKILL.md` 34행의 `INVALID-CONFIG <이유>` 를 `INVALID-CONFIG <경로> <이유>` 로 고친다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/core-config-schema.spec.ts skills/orch/tests/lib-config.spec.ts skills/orch/tests/docs-contract.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/config.ts` | 수정 (`readConfigFile`) |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 (검사표 연결, `CLI-DEPS-MISSING`, 머리 주석) |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/lib-config.spec.ts` | 수정 (`readConfigFile`) |
| `skills/orch/tests/core-config-schema.spec.ts` | 수정 (import 범위) |
| `skills/orch/references/hooks.md` | 수정 (줄 표) |
| `skills/orch/SKILL.md` | 수정 (34행) |
| `skills/orch/changes/orch-doctor-config-problems.minor.md` | 신규 |
