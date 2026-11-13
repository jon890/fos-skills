# Phase 03. doctor 설정 쓰기를 잠금 안으로 이전

**Execution profile**: standard

## 목표

doctor 설정 쓰기를 잠금 안으로 이전로 승인한 설정 명령을 완성한다.

**범위 외**: 루프와 기존 명령의 설정 읽기 동작 변경, 자동 루프 재시작.

## 컨텍스트

**요구사항**: REQ9

**근거 문서**: `docs/features/orch-config-cli/spec.md`, `docs/features/orch-config-cli/design.md`

기존 키 검사와 짝 규칙은 `core/config-schema.ts` 의 KEYS/PAIRS/problems/knownPath 를 쓴다. `lib/paths.ts` 는 주 checkout 과 ORCH_DIR, 옛 설정 위치 차단을 소유한다. 잠금은 `extensions/work-board/bin/file-lock.ts` 의 withFileLock 이다. lib/loop.ts 의 loopStatus 는 프로세스 조회를 하므로 재시작 키를 바꿀 때만 부른다.

## 의도 메모

- 기본값을 모으거나 읽는 명령의 검사를 바꾸지 않는다. 이 PR 은 PR1 의 deferred 전체를 인수한다.

## 작업 항목

### 1. 코드와 문서를 변경한다

finish() 의 config.json 경로 문자열 치환과 cleanup 이전을 updateConfig 안에서 최신 객체에 적용한다. 다른 json/md 파일 치환은 유지한다. configChanges 는 파일 읽기와 순수 변경을 분리해 잠금 안 값을 받게 한다. migrateHooks 의 옮긴 키 삭제도 최신 객체에 적용하고 잠금 밖 config 를 덮어쓰지 않는다. 핸들러 생성과 기존 출력은 유지한다.

기존 migrate 테스트를 유지하고 잠금을 쥔 부모와 자식 migrate/set 을 동기화해 두 쓰기 경로가 최신 값을 보존하는지 확인한다. set 과 migrate-hooks 가 동시에 돌아도 새 키가 남고 옛 키만 사라져야 한다.

### 2. `skills/orch/tests/migrate-orch-dir.spec.ts` 로 정상과 실패를 확인한다

위 작업에 적은 사례를 테스트에 넣고 아래 명령으로 실행한다.

## 검증

```bash
node --test skills/orch/tests/migrate-orch-dir.spec.ts skills/orch/tests/orch-config.spec.ts
```

종료 코드 0 이고 테스트의 파일 값과 출력 단언이 통과한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/doctor/migrate-orch-dir.ts` | 수정 |
| `skills/orch/tests/migrate-orch-dir.spec.ts` | 수정 |
