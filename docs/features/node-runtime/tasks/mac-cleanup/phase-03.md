# Phase 03. 부르는 곳과 저장소 정책, 이력을 맞춘다

**Execution profile**: standard

## 목표

mac-cleanup 문서의 호출을 새 이름으로 바꾸고, `runtime-policy.json` 에서 `mac-cleanup` 줄을 지우며 `migrated_docs` 를 넓히고, 스킬을 major 로 올린다.

**범위 외**: 저장소 밖 파일의 호출(머지 뒤 후속), 팀 저장소 반영(내보내지 않는 스킬).

## 컨텍스트

**요구사항**: REQ4, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(DECISION4). 이 스크립트를 부르는 다른 스킬은 없다. 오버레이 예시(`~/.claude/mac-cleanup-overlay.md`)는 앱 이름만 갖고 호출이 없다.
- `README.md` 의 「`python3` 가 필요하다」 를 Node 로 바꾼다.
- 호환성이 깨져(명령 이름) major 로 올린다. `metadata.version` 과 CHANGELOG 를 PR 이 직접 올린다(ADR-023). 이 영역의 계획서는 구현을 마치면 같은 PR 에서 지운다.
- 다른 저장소의 옛 호출은 스펙 표에 이 영역 행이 없다. 머지 전 같은 검색을 다시 돌려 확인한 결과는 index.json 의 `deferred` 에 있다.

## 작업 항목

### 1. 문서 호출
`SKILL.md`, `README.md`, `references/git-and-sessions.md`, `references/targets.md` 의 `python3 ... .py`, `bash ... .sh` 를 `node ... .ts` 로 바꾼다.

### 2. 저장소 정책
`runtime-policy.json`(pending 줄 삭제, `migrated_docs` 에 `skills/mac-cleanup/`), `docs/features/node-runtime/design.md` 영역 9 메모.

### 3. 버전과 변경 이력
`skills/mac-cleanup/SKILL.md` 의 `metadata.version`, `skills/mac-cleanup/CHANGELOG.md`.

## 검증

```bash
# cwd: 저장소 루트
node scripts/runtime-policy.ts --pending
node scripts/run-tests.ts
git grep -n 'python3 \|bash "\$SKILL_DIR' -- skills/mac-cleanup
```

앞 둘은 종료 코드 0 이고 pending 에 `mac-cleanup` 이 없다. `git grep` 은 일치가 없어 종료 코드 1 이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/mac-cleanup/SKILL.md` | 수정 |
| `skills/mac-cleanup/README.md` | 수정 |
| `skills/mac-cleanup/CHANGELOG.md` | 수정 |
| `skills/mac-cleanup/references/git-and-sessions.md` | 수정 |
| `skills/mac-cleanup/references/targets.md` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
