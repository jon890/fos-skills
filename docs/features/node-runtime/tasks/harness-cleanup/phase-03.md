# Phase 03. 부르는 곳과 저장소 정책, 이력을 맞춘다

**Execution profile**: standard

## 목표

harness-cleanup 문서의 호출을 새 이름으로 바꾸고, `runtime-policy.json` 에서 `harness-cleanup` 줄을 지우며 `migrated_docs` 를 넓히고, 스킬을 major 로 올린다.

**범위 외**: 저장소 밖 개인 문서의 호출(머지 뒤 후속), 팀 저장소 반영(내보내지 않는 스킬).

## 컨텍스트

**요구사항**: REQ4, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(DECISION4). 이 스크립트를 부르는 다른 스킬은 없다. `skills/mac-cleanup/references/targets.md` 와 `docs/code-architecture.md` 가 옛 이름을 말만 한다.
- CI 의 `zsh` 설치(`ci.yml` 의 `jq zsh`)는 `run_doc_snippets` 테스트가 계속 쓰므로 그대로 둔다. `design.md` 의 영역 8 메모와 CI 절을 이 결정으로 고친다.
- 호환성이 깨져(명령 이름) major 로 올린다. `metadata.version` 과 CHANGELOG 를 PR 이 직접 올린다(ADR-023). 이 영역의 계획서는 구현을 마치면 같은 PR 에서 지운다.

## 작업 항목

### 1. 문서 호출
`SKILL.md`, `README.md`, `references/*.md` 의 `python3 ... .py` 를 `node ... .ts` 로 바꾸고 「`python3` 가 필요하다」 문장을 맞춘다.

### 2. 저장소 정책
`runtime-policy.json`, `docs/code-architecture.md`, `docs/features/node-runtime/design.md`, `skills/mac-cleanup/references/targets.md`.

### 3. 버전과 변경 이력
`skills/harness-cleanup/SKILL.md` 의 `metadata.version`, `skills/harness-cleanup/CHANGELOG.md`.

## 검증

```bash
node scripts/runtime-policy.ts --pending
node scripts/run-tests.ts
git grep -n 'python3 ' -- skills/harness-cleanup
```

앞 둘은 종료 코드 0 이고 pending 에 `harness-cleanup` 이 없다. `git grep` 은 일치가 없어 종료 코드 1 이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/harness-cleanup/SKILL.md` | 수정 |
| `skills/harness-cleanup/README.md` | 수정 |
| `skills/harness-cleanup/CHANGELOG.md` | 수정 |
| `skills/harness-cleanup/references/run-doc-snippets.md` | 수정 |
| `skills/harness-cleanup/references/usage-audit.md` | 수정 |
| `skills/harness-cleanup/references/script-audit.md` | 수정 |
| `skills/harness-cleanup/references/judgment.md` | 수정 |
| `skills/mac-cleanup/references/targets.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
