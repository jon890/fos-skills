# Phase 05. 색인 생성을 켜고 새 ADR 과 두 표 색인을 만든다

**Execution profile**: standard

## 목표

이 저장소 plan 오버레이에서 색인 생성을 켜고, 이 기능의 결정을 ADR 로 남긴 뒤 `docs/adr/INDEX.md` 를 `write-index` 로 두 표로 다시 만든다.

**범위 외**: ai-analysis 이전(다음 PR).

## 컨텍스트

**요구사항**: REQ7

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 설계 「fos-skills 첫 적용」, DECISION12. `.claude/plan-overlay.md` 는 아직 없다(`.claude/` 에는 `settings.local.json` 만 있다).
- 오버레이 꼴은 `skills/plan/references/monorepo.md` 「오버레이가 지정하는 경로 값」 의 예시 표다. 값은 「ADR 색인 생성」 하나다. 「ADR 폴더」 와 「ADR 대체 배치」 는 기본값이다.
- 새 ADR 번호는 착수 때 정한다. `git ls-files docs/adr` 의 가장 큰 번호와 열린 PR(`gh pr list --state open --json headRefName,files`)의 새 ADR 을 보고 다음 번호를 고른다. node-runtime 저장소 기반 PR 도 ADR 을 더한다.
- ADR 내용: `decision-type: engineering-process`. 결정은 「문서 링크·ADR 검사는 plan 번들 검사기 하나가 소유하고 작성 단계(spec, technical-design, review-fix, docs-audit)에서 돈다. CI 사본을 두지 않는다」. 기각한 대안은 CI 사본, CI 가 공개 저장소에서 받기, 저장소 스크립트 유지(스펙 DECISION5)와 스킬마다 검사기(스펙 DECISION1)다. 현재 규칙의 원본은 네 스킬 SKILL.md 의 검사 단계와 `adr-docs.ts` 머리 주석이다. 양식은 `skills/technical-design/templates/adr.md`, 남길 조건은 `adr-rules.md` 다.
- README 나 `docs/code-architecture.md` 가 ADR 색인 형식(목록형)을 설명하면 함께 고친다.

## 작업 항목

### 1. `.claude/plan-overlay.md` 신규

### 2. 새 ADR

### 3. 색인 재생성

`node skills/plan/scripts/adr-docs.ts write-index` 로 `docs/adr/INDEX.md` 를 다시 만든다.

## 검증

```bash
node skills/plan/scripts/adr-docs.ts write-index
node skills/plan/scripts/adr-docs.ts check --index generated
node skills/plan/scripts/adr-docs.ts write-index && git diff --quiet -- docs/adr/INDEX.md
python3 -m unittest discover -s scripts/tests
python3 export-only-skills/korean-check/scripts/korean-style-check.py docs/adr/INDEX.md
for f in docs/adr/0*.md; do git diff --cached --quiet -- "$f" || python3 export-only-skills/korean-check/scripts/korean-style-check.py "$f" || exit 1; done
```

둘째 줄은 종료 코드 0 이다. 셋째 줄은 커밋 전이면 `git add` 뒤에 돌려 두 번째 `write-index` 가 색인을 바꾸지 않는지 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `.claude/plan-overlay.md` | 신규 |
| `docs/adr/0NN-docs-checks-at-authoring-time.md` | 신규 |
| `docs/adr/INDEX.md` | 수정 |
