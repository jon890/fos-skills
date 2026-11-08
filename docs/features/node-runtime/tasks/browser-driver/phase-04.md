# Phase 04. 문서 호출과 저장소 정책, 이력을 맞춘다

**Execution profile**: standard

## 목표

문서의 호출과 설치 안내를 새 이름으로 바꾸고, `runtime-policy.json` 에 옛 이름 진입을 `legacy` 로 적고 `pending` 의 영역 줄을 지우며, `browser` 스킬을 major 로 올린다.

**범위 외**: 저장소 밖 파일의 호출(머지 뒤 후속), 팀 저장소 반영.

## 컨텍스트

**요구사항**: REQ4, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 호출 꼴은 `node "$SKILL_DIR/browser-driver/browser_driver.ts"` 가 아니라 실행 파일 경로 하나다. 드라이버는 사용자가 `~/.claude/scripts/browser-driver` 링크로 PATH 처럼 부르는 명령이라 문서의 `B=…` 꼴은 그대로 둔다. 링크 대상과 찾기 후보만 `.ts` 로 바꾼다(DECISION21).
- `python3` 를 말하는 문장(`README.md` 의 「구성」, content-preview README)을 Node 로 바꾼다.
- 호환성이 깨져(링크 대상 이름) major 로 올린다. `metadata.version` 과 CHANGELOG 를 PR 이 직접 올린다(ADR-023). 이 영역의 계획서는 구현을 마치면 같은 PR 에서 지운다.

## 작업 항목

### 1. 문서
`skills/browser/SKILL.md`, `skills/browser/browser-driver/README.md`, `README.md`, `docs/code-architecture.md`, content-preview·presentation 의 README 와 변경 조각.

### 2. 저장소 정책
`runtime-policy.json`(`pending` 줄 삭제, `legacy` 에 옛 이름 진입), `docs/features/node-runtime/design.md` 영역 10 메모.

### 3. 버전과 변경 이력
`skills/browser/SKILL.md` 의 `metadata.version`, `skills/browser/CHANGELOG.md`.

## 검증

```bash
node scripts/runtime-policy.ts --pending
node scripts/run-tests.ts
git grep -n 'tools/browser-driver'
```

앞 둘은 종료 코드 0 이고 pending 에 `browser-driver` 가 없다. `git grep` 에는 옛 이름 진입과 팀 사본을 말하는 줄만 남는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/browser/SKILL.md` | 수정 |
| `skills/browser/CHANGELOG.md` | 수정 |
| `skills/browser/browser-driver/README.md` | 수정 |
| `README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
