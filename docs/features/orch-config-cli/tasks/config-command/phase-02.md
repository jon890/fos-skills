# Phase 02. 설정 명령과 루프 재시작 안내

**Execution profile**: standard

## 목표

설정 명령과 루프 재시작 안내로 승인한 설정 명령을 완성한다.

**범위 외**: 루프와 기존 명령의 설정 읽기 동작 변경, 자동 루프 재시작.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ8, REQ10, REQ11

**근거 문서**: `docs/features/orch-config-cli/spec.md`, `docs/features/orch-config-cli/design.md`

기존 키 검사와 짝 규칙은 `core/config-schema.ts` 의 KEYS/PAIRS/problems/knownPath 를 쓴다. `lib/paths.ts` 는 주 checkout 과 ORCH_DIR, 옛 설정 위치 차단을 소유한다. 잠금은 `extensions/work-board/bin/file-lock.ts` 의 withFileLock 이다. lib/loop.ts 의 loopStatus 는 프로세스 조회를 하므로 재시작 키를 바꿀 때만 부른다.

## 의도 메모

- 기본값을 모으거나 읽는 명령의 검사를 바꾸지 않는다. 이 PR 은 PR1 의 deferred 전체를 인수한다.

## 작업 항목

### 1. 코드와 문서를 변경한다

`core/config-schema.ts` 의 knownPath 에서 목록 항목은 unknown 으로 거절하고, 이름을 정한 객체에서 프로토타입 속성을 읽지 않게 한다. 승인한 경로 문법을 지키는 수정이며 core-config-schema 테스트에 두 사례를 더한다.

명령 표에 config show/get/set/unset 을 prepend 와 repo 문맥으로 등록하고 positional 은 두지 않는다. orch-config.ts 가 --repo, set 전용 --json, -- 와 단일 - 값을 직접 푼다. 겹치는 경로와 잘못된 인자 수는 종료 코드 2 다. requireMigrated 를 네 동작 앞에서 부른다. 검사표는 동적 import 로만 읽고 실패하면 의존 설치 안내와 종료 코드 1 을 낸다.

show/get 은 readConfigFile 로 읽고 problems 를 경고로 낸다. show 는 절 목록을 확인하고 JSON 두 칸, get 은 파일에 있는 값만 한 줄로 낸다. set/unset 은 updateConfig 의 잠금 안에서 모든 경로를 함께 적용하고 검사한다. knownPath 의 removed 와 unset 범위의 옛 칸은 migrate-hooks 로 안내한다. 바꾼 최상위 키의 문제와 관련 짝 문제는 기존 문제여도 거절한다. 다른 문제는 옛 문제와 비교한다. 글자 대신 JSON 값이 검사를 통과할 때 --json 을 안내한다. 성공 줄의 이전 값은 잠금 안에서 읽은 값이고 기존 문제·새 파일·재시작 안내는 stderr 에 낸다.

RESTART_KEYS 의 실제 바뀐 값과 loopStatus 의 alive/recheck 로 재시작 안내를 고른다. tick_sec 과 finish 키의 조건부 안내를 구분한다. 다른 키와 no-op 은 알리지 않는다.

명령 테스트는 bin/orch.ts 경계와 임시 저장소를 사용한다. 인수 계획의 정상·실패·배치 변경·파일 바이트 보존·주 checkout/ORCH_DIR·옛 위치·깨진 파일·의존 누락·프로토타입·루프 alive/recheck/없음·동시 set 을 확인한다. 실제 사용자 설정은 건드리지 않는다.

### 2. `skills/orch/tests/orch-config.spec.ts` 로 정상과 실패를 확인한다

위 작업에 적은 사례를 테스트에 넣고 아래 명령으로 실행한다.

## 검증

```bash
node --test skills/orch/tests/orch-config.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/core-config-schema.spec.ts
```

종료 코드 0 이고 테스트의 파일 값과 출력 단언이 통과한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/config/orch-config.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/orch-config.spec.ts` | 신규 |
| `skills/orch/scripts/core/config-schema.ts` | 수정 |
| `skills/orch/tests/core-config-schema.spec.ts` | 수정 |
