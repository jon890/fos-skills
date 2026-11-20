# docs-audit 오버레이: fos-skills

docs-audit 가 이 저장소에서 읽는 값이다. 감사 절차는 docs-audit 의 `SKILL.md` 가, 문서마다 따를 원본은 [docs-refresh 의 `references/sources.md`](skills/docs-refresh/references/sources.md) 가 소유한다.
ADR 폴더와 색인 생성은 [`plan-overlay.md`](plan-overlay.md) 가 갖는다.

## 문서 경계

설명 문서를 감사할 때의 범위다. 사용자가 범위를 정하면 그쪽을 따른다.

- 루트 `README.md`
- `docs/flow.md`, `docs/code-architecture.md`, `docs/data-schema.md`
- `skills/*/README.md`
- `extensions/work-board/README.md`

스킬의 `SKILL.md` 와 `references/` 는 하네스 지침이라 `harness-cleanup` 이 맡는다. 이 범위에 넣지 않는다.
`docs/features/` 와 `docs/adr/` 는 기능 문서와 결정 기록이다. 설명 문서 감사에서는 링크 대상으로만 읽는다.

## 검증 명령

```bash
# cwd: 저장소 루트
node .claude/skills/docs-refresh/scripts/check-drift.ts
node scripts/run-tests.ts scripts/tests
```

`check-drift.ts` 는 어긋남이 있으면 종료 코드 1 이다. 고친 뒤에는 0 이어야 한다.
`scripts/tests` 는 스킬 README 형식과 매니페스트 일치를 본다.

## 코드 대조 grep

README 를 마지막으로 고친 뒤 CHANGELOG 에 새 절이 생긴 스킬을 고른다. 그 스킬 README 를 먼저 의미 검사한다.

```bash
# cwd: 저장소 루트
for d in skills/*/; do
  since="$(git log -1 --format=%H -- "${d}README.md")"
  [ -n "$since" ] && git diff --quiet "$since" HEAD -- "${d}CHANGELOG.md" || echo "${d}README.md"
done
```

문서가 적은 명령과 스크립트 이름이 실제로 있는지 본다.

```bash
# cwd: 저장소 루트
grep -rhoE 'node [a-zA-Z./_-]+\.ts' README.md docs/flow.md docs/code-architecture.md docs/data-schema.md | sort -u | awk '{print $2}' | while read -r f; do [ -e "$f" ] || echo "없음 $f"; done
```
