# Phase 04. 저장소의 링크 없는 ADR 식별자를 고친다

**Execution profile**: standard

## 목표

이 저장소 전체 검사가 0 이 되게 링크 없는 ADR 식별자와 남은 링크·앵커 위반을 고친다. 첫 사용처가 깨끗해야 phase 05 의 생성 모드 검사가 검사기를 검증한다(스펙 DECISION15).

**범위 외**: 색인 재생성과 새 ADR(phase 05), 검사기 코드(phase 01).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 위반 목록은 `node skills/plan/scripts/adr-docs.ts check --index ids` 가 낸다. 2026-11-05 의 grep 예측은 아래 「변경 파일」 표다. `docs/adr/INDEX.md` 는 phase 05 가 다시 만들어 여기서 고치지 않는다.
- 고치는 규칙:
  - 이 저장소 ADR 을 가리키면 후보 경로로 링크를 건다. 링크 글은 식별자 그대로다.
  - 다른 저장소의 ADR(예: `ai-analysis ADR-017`), 예시 값(`korean-examples.md` 의 `ADR-053`), 후보가 없는 식별자는 코드 스팬으로 감싼다.
  - CHANGELOG 의 이력 줄은 코드 스팬으로 감싼다. 이력 문장에 링크 유지 부담을 더하지 않는다.
- 계획서 폴더(`tasks/` 아래)는 검사기가 보지 않는다.

## Blocked 조건

- 검사기가 낸 위반이 오탐(렌더 규격상 문제없는 자리)이다 → 고치지 않고 `PHASE_BLOCKED: adr-docs 오탐 <파일:줄>` 을 내고 멈춘다. 검사기 수정은 phase 01 의 파일을 다시 여는 일이라 이 phase 범위 밖이다.

## 작업 항목

### 1. 위반 수정

검사기 출력의 줄마다 위 규칙으로 고친다. 표에 없는 파일이 나오면 같은 규칙으로 고치고 커밋 메시지에 적는다.

## 검증

```bash
node skills/plan/scripts/adr-docs.ts check --index ids
python3 -m unittest discover -s scripts/tests
```

첫 줄의 종료 코드가 0 이어야 한다. `docs/adr/INDEX.md` 의 위반만 남으면 phase 05 가 지운다. 그 경우 종료 코드 1 과 남은 줄이 그 파일뿐인지를 확인한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `docs/adr/003-export-only-skills.md` | 수정 |
| `docs/adr/019-plugin-version-auto-bump.md` | 수정 |
| `docs/adr/superseded/001-plugin-from-repo-root.md` | 수정 |
| `docs/features/board-plugin-version/spec.md` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
| `docs/features/node-runtime/spec.md` | 수정 |
| `docs/features/orch-cli/design.md` | 수정 |
| `docs/features/orch-cli/spec.md` | 수정 |
| `docs/features/test-speed/spec.md` | 수정 |
| `docs/features/version-at-merge/design.md` | 수정 |
| `docs/features/version-at-merge/spec.md` | 수정 |
| `export-only-skills/korean-check/references/korean-examples.md` | 수정 |
| `skills/orch/CHANGELOG.md` | 수정 |
| `skills/orch/references/hooks.md` | 수정 |
| `skills/orch/references/replying.md` | 수정 |
