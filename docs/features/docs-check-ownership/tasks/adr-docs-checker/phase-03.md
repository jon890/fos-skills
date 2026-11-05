# Phase 03. fos-skills 자기 저장소에 먼저 적용한다

**Execution profile**: standard

## 목표

이 저장소가 검사기의 첫 사용처가 된다. 색인 생성을 켜고 저장소 전체 위반을 0 으로 만든 뒤 두 표 색인을 만들고, 이 결정을 ADR 로 남긴다.

**범위 외**: ai-analysis 이전(다음 PR).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 설계 「fos-skills 첫 적용」 절과 DECISION11, DECISION12 가 할 일을 정한다.
- `.claude/plan-overlay.md` 는 아직 없다. `.claude/` 에는 `settings.local.json` 만 있다.
- `docs/adr/001-plugin-from-repo-root.md`, `002-plugin-version-is-commit-sha.md` 의 status 가 `superseded` 인데 `docs/adr` 바로 아래에 있다. 가리키는 곳은 `git grep -n "001-plugin-from-repo-root\|002-plugin-version-is-commit-sha"` 로 찾는다(CHANGELOG 를 빼고 7곳, 2026-11-05).
- 설계 독립 검토가 계획서 밖 링크 없는 `ADR-NNN` 을 30곳 넘게 찾았다. 정확한 목록은 검사기가 낸다.
- `001-plugin-from-repo-root.md:4` 는 링크 글 `ADR-020` 이 `021-skill-directory-layout.md` 를 가리킨다. 실제 대체한 ADR 을 확인해 링크 글을 맞춘다.
- 새 ADR 은 `docs/adr/025-<슬러그>.md`, `decision-type: engineering-process`. 양식은 `skills/technical-design/templates/adr.md`, 남길 조건은 `adr-rules.md` 다. 결정은 「문서 링크·ADR 검사는 plan 번들 검사기 하나가 소유하고 작성 단계(spec, technical-design, review-fix, docs-audit)에서 돈다. CI 사본을 두지 않는다」, 기각한 대안은 CI 사본, CI 가 공개 저장소에서 받기, 저장소 스크립트 유지(스펙 DECISION5)다. 현재 규칙의 원본은 네 스킬 SKILL.md 의 검사 단계와 `adr-docs.ts` 머리 주석이다.

## 작업 항목

### 1. `.claude/plan-overlay.md` 신규

`skills/plan/references/monorepo.md` 의 오버레이 꼴로 「ADR 색인 생성」 값 하나를 적는다.

### 2. 대체된 ADR 이동 (커밋 하나)

`git mv` 로 두 파일을 `docs/adr/superseded/` 로 옮기고, 옮긴 파일 안과 가리키는 문서의 상대 링크를 고친다.

### 3. 저장소 위반 수정 (커밋 하나)

`node skills/plan/scripts/adr-docs.ts check --index ids` 가 낸 위반을 고친다. 링크 없는 식별자는 후보 경로로 링크를 건다. 계획서 폴더는 검사기가 보지 않는다.
검사기 오탐이면 고치지 않고 phase 01 의 테스트에 사례를 더해 검사기를 고친다.

### 4. 새 ADR 과 색인 (커밋 하나)

`docs/adr/025-*.md` 를 쓰고 `write-index` 로 `docs/adr/INDEX.md` 를 두 표로 다시 만든다. README 나 `docs/code-architecture.md` 가 색인 형식을 설명하면 함께 고친다.

## 검증

```bash
node skills/plan/scripts/adr-docs.ts write-index
node skills/plan/scripts/adr-docs.ts check --index generated
git diff --stat HEAD~1 -- docs/adr/INDEX.md
python3 -m unittest discover -s scripts/tests
python3 export-only-skills/korean-check/scripts/korean-style-check.py docs/adr/INDEX.md
```

둘째 줄은 종료 코드 0 이어야 한다. `write-index` 를 한 번 더 돌려도 `git status --short docs/adr/INDEX.md` 가 비어야 한다.

## 변경 파일

링크 없는 식별자와 옮긴 ADR 을 가리키던 문서도 고친다. 목록은 검사기 출력이 정한다.

| 파일 | 변경 |
|---|---|
| `.claude/plan-overlay.md` | 신규 |
| `docs/adr/001-plugin-from-repo-root.md` | 삭제 |
| `docs/adr/002-plugin-version-is-commit-sha.md` | 삭제 |
| `docs/adr/superseded/001-plugin-from-repo-root.md` | 신규 |
| `docs/adr/superseded/002-plugin-version-is-commit-sha.md` | 신규 |
| `docs/adr/025-docs-checks-at-authoring-time.md` | 신규 |
| `docs/adr/INDEX.md` | 수정 |

