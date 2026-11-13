# Phase 01. 경로 편집과 설정 파일 쓰기

**Execution profile**: standard

## 목표

경로 편집과 설정 파일 쓰기로 승인한 설정 명령을 완성한다.

**범위 외**: 루프와 기존 명령의 설정 읽기 동작 변경, 자동 루프 재시작.

## 컨텍스트

**요구사항**: REQ5, REQ8, REQ9

**근거 문서**: `docs/features/orch-config-cli/spec.md`, `docs/features/orch-config-cli/design.md`

기존 키 검사와 짝 규칙은 `core/config-schema.ts` 의 KEYS/PAIRS/problems/knownPath 를 쓴다. `lib/paths.ts` 는 주 checkout 과 ORCH_DIR, 옛 설정 위치 차단을 소유한다. 잠금은 `extensions/work-board/bin/file-lock.ts` 의 withFileLock 이다. lib/loop.ts 의 loopStatus 는 프로세스 조회를 하므로 재시작 키를 바꿀 때만 부른다.

## 의도 메모

- 기본값을 모으거나 읽는 명령의 검사를 바꾸지 않는다. 이 PR 은 PR1 의 deferred 전체를 인수한다.

## 작업 항목

### 1. 코드와 문서를 변경한다

`core/config-edit.ts` 에 경로 풀이, getAt, setAt, unsetAt 과 바꾼 경로·키·절의 새 문제 선택을 둔다. 빈 이름, 목록 항목, 겹치는 경로는 거절한다. 프로토타입의 속성은 읽거나 바꾸지 않고 이름이 자유로운 객체의 __proto__ 도 자기 속성으로 다룬다. 빈 객체를 위로 지우고, 부모가 객체가 아니면 편집을 거절한다.

`lib/config.ts` 의 readConfigFile 을 재사용하고 updateConfig(repo, change, opts) 를 더한다. withFileLock 안에서 다시 읽어 change 에 넘기고 반환 값이 undefined 면 쓰지 않는다. ensure 는 실제 쓰기 때 부르고 config.json.<pid>.tmp 에 쓴 뒤 rename 한다. 값 검사와 zod import 는 lib 에 넣지 않는다. 잠금 옵션은 테스트에서만 기다림을 줄이는 데 쓴다.

순수 테스트로 경로·빈 객체 정리·같은 문구의 잘못된 값·짝 규칙·오타와 기존 문제를 확인한다. lib 테스트로 파일 없음·깨진 JSON·no-op·잠금 실패·원자적 저장을 확인한다.

### 2. `skills/orch/tests/core-config-edit.spec.ts` 와 `skills/orch/tests/lib-config.spec.ts` 로 정상과 실패를 확인한다

위 작업에 적은 사례를 테스트에 넣고 아래 명령으로 실행한다.

## 검증

```bash
node --test skills/orch/tests/core-config-edit.spec.ts skills/orch/tests/lib-config.spec.ts
```

종료 코드 0 이고 테스트의 파일 값과 출력 단언이 통과한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/config-edit.ts` | 신규 |
| `skills/orch/scripts/lib/config.ts` | 수정 |
| `skills/orch/tests/core-config-edit.spec.ts` | 신규 |
| `skills/orch/tests/lib-config.spec.ts` | 수정 |
