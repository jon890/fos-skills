# Phase 04. 명령 안내와 설정 타입 문서 맞추기

**Execution profile**: standard

## 목표

명령 안내와 설정 타입 문서 맞추기로 승인한 설정 명령을 완성한다.

**범위 외**: 루프와 기존 명령의 설정 읽기 동작 변경, 자동 루프 재시작.

## 컨텍스트

**요구사항**: REQ6, REQ12, REQ13

**근거 문서**: `docs/features/orch-config-cli/spec.md`, `docs/features/orch-config-cli/design.md`

기존 키 검사와 짝 규칙은 `core/config-schema.ts` 의 KEYS/PAIRS/problems/knownPath 를 쓴다. `lib/paths.ts` 는 주 checkout 과 ORCH_DIR, 옛 설정 위치 차단을 소유한다. 잠금은 `extensions/work-board/bin/file-lock.ts` 의 withFileLock 이다. lib/loop.ts 의 loopStatus 는 프로세스 조회를 하므로 재시작 키를 바꿀 때만 부른다.

## 의도 메모

- 기본값을 모으거나 읽는 명령의 검사를 바꾸지 않는다. 이 PR 은 PR1 의 deferred 전체를 인수한다.

## 작업 항목

### 1. 코드와 문서를 변경한다

overlay.md 에 설정 바꾸기와 show/get/set/unset, 배치 변경, --json, 재시작 안내를 둔다. replying/heavy-checks/board/hooks/cleanup/spec-writing 의 직접 편집 안내를 명령으로 바꾼다. 타입 표는 KEYS 와 설계의 키별 검사 기준에 맞춰 빠진 finish/cleanup 키와 타이머·짝 조건까지 보완한다. data-schema 에 config.json.lock 을 기록한다.

spec-common 틀에 no-config-edit 표지를 더해 worker 는 `orch config set` 과 `orch config unset` 을 호출하지 않는다고 적는다. SKILL 은 설정 명령의 소유 문서로 연결한다. README 기여 절에 npm ci --ignore-scripts 를 넣고 설치 테스트 머리 설명의 네트워크 사용을 바로잡는다. orch-lib-layers/design 의 core 의존에 config-schema.ts 의 zod 예외를 반영한다. 변경 조각을 더한다.

config-docs 테스트는 안내의 명령, no-config-edit 표지, 키 집합과 타입 문서의 누락을 확인한다. 기존 lib-config/spec-lint 문서 검사를 함께 돈다. PR1 계획은 다른 계획의 일괄 삭제를 금한 수명 규칙에 따라 남기고 deferred 를 이 PR 이 인수했다는 근거를 PR 에 보존한다.

### 2. `skills/orch/tests/config-docs.spec.ts` 로 정상과 실패를 확인한다

위 작업에 적은 사례를 테스트에 넣고 아래 명령으로 실행한다.

## 검증

```bash
node --test skills/orch/tests/config-docs.spec.ts skills/orch/tests/lib-config.spec.ts skills/orch/tests/spec-lint.spec.ts
```

종료 코드 0 이고 테스트의 파일 값과 출력 단언이 통과한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/references/overlay.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
| `skills/orch/references/heavy-checks.md` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/references/hooks.md` | 수정 |
| `skills/orch/references/cleanup.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/templates/spec-common.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/features/orch-lib-layers/design.md` | 수정 |
| `README.md` | 수정 |
| `scripts/test-plugin-install.ts` | 수정 |
| `skills/orch/tests/config-docs.spec.ts` | 신규 |
| `skills/orch/changes/config-command.minor.md` | 신규 |
