# Phase 03. 대체된 ADR 둘을 superseded/ 로 옮긴다

**Execution profile**: standard

## 목표

이 저장소의 대체된 ADR 둘을 이 저장소 규칙대로 `docs/adr/superseded/` 로 옮겨, phase 05 의 색인 생성과 `ADR_PLACEMENT` 검사가 통과할 자리를 만든다.

**범위 외**: 링크 없는 식별자 수정(phase 04), 오버레이·새 ADR·색인(phase 05).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 설계 「fos-skills 첫 적용」 과 DECISION11. 규칙의 원본은 `skills/technical-design/references/adr-rules.md` 「대체와 이동」 이다. 파일 이름은 바꾸지 않는다.
- `docs/adr/001-plugin-from-repo-root.md`, `002-plugin-version-is-commit-sha.md` 의 status 가 `superseded` 다.
- 가리키는 곳(2026-11-05, CHANGELOG 제외): `docs/adr/005-plugin-hooks-under-skill.md:7`, `docs/adr/019-plugin-version-auto-bump.md:10`, `docs/adr/021-skill-directory-layout.md:4`, `docs/features/board-plugin-version/spec.md:49`, `docs/features/docs-check-ownership/design.md`(「fos-skills 첫 적용」 절), `docs/adr/INDEX.md`. 옮긴 두 파일 안의 상대 링크도 한 단계 깊어진다.
- `001-plugin-from-repo-root.md:4` 의 링크 글 `ADR-020` 이 `021-skill-directory-layout.md` 를 가리킨다. 두 파일을 읽어 실제로 대체한 ADR 에 링크 글과 대상을 맞춘다.

## 작업 항목

### 1. 이동과 링크 수정

`git mv` 로 옮기고, 아래 명령이 찾는 상대 링크를 모두 고친다. `docs/adr/INDEX.md` 는 지금 목록형을 유지한 채 경로만 고친다(phase 05 가 다시 만든다).

```bash
git grep -n "001-plugin-from-repo-root\|002-plugin-version-is-commit-sha" -- ':!*CHANGELOG.md'
```

## 검증

```bash
! node skills/plan/scripts/adr-docs.ts check --index ids --changed-since HEAD | grep -E "BROKEN_LINK|BROKEN_ANCHOR|ADR_PLACEMENT"
test -f docs/adr/superseded/001-plugin-from-repo-root.md && test -f docs/adr/superseded/002-plugin-version-is-commit-sha.md
```

첫 줄은 이 phase 가 바꾼 파일에 링크·앵커·위치 위반이 없으면 통과한다. 링크 없는 식별자(`ADR_UNLINKED`)는 phase 04 몫이라 여기서 보지 않는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `docs/adr/001-plugin-from-repo-root.md` | 삭제 |
| `docs/adr/002-plugin-version-is-commit-sha.md` | 삭제 |
| `docs/adr/superseded/001-plugin-from-repo-root.md` | 신규 |
| `docs/adr/superseded/002-plugin-version-is-commit-sha.md` | 신규 |
| `docs/adr/005-plugin-hooks-under-skill.md` | 수정 |
| `docs/adr/019-plugin-version-auto-bump.md` | 수정 |
| `docs/adr/021-skill-directory-layout.md` | 수정 |
| `docs/adr/INDEX.md` | 수정 |
| `docs/features/board-plugin-version/spec.md` | 수정 |
| `docs/features/docs-check-ownership/design.md` | 수정 |
