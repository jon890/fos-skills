# Phase 01. 스킬 이름을 machine-cleanup 으로 바꾼다

**Execution profile**: standard

## 목표

`skills/mac-cleanup/` 을 `skills/machine-cleanup/` 으로 옮기고, 옛 이름을 가리키던 매니페스트, README, 기여 문서, 설정, orch 의 주석·문서·테스트, 옛 기능 문서의 링크를 새 이름으로 바꾼다. 맥 조사·정리 스크립트와 references 의 내용은 바꾸지 않는다.

**범위 외**: 개인 오버레이 자리 고르기와 머신 고르기(phase 02), 홈서버 조사·정리(PR2).

## 컨텍스트

**요구사항**: REQ1, REQ4

**근거 문서**: `docs/features/machine-cleanup/spec.md` REQ1·REQ4·DECISION4, `docs/features/machine-cleanup/design.md` 「요구사항 연결」, 「실패와 일관성」

- 옛 이름을 쓰는 곳은 `git grep -n mac-cleanup -- ':!skills/mac-cleanup'` 로 찾는다. 스펙 「목표」 의 목록과 `scripts/runtime-policy.json`, `.codex-plugin/plugin.json` 이 있다.
- `.claude-plugin/CHANGELOG.md` 는 workflow 만 쓰는 이력이라 고치지 않는다. `skills/orch/CHANGELOG.md` 의 옛 항목도 이력이라 그대로 둔다.
- 옛 기능 문서(`docs/features/mac-cleanup-container-runtime/`, `docs/features/node-runtime/`)의 「배경」 서술은 그 시점의 사실이라 이름을 남긴다. 파일 경로(`skills/mac-cleanup/...`)는 새 경로로 바꾼다.
- 바꾸기 전 조사 출력은 `$TMPDIR/mc-baseline/` 에 이미 남겼다(조사 스크립트 여섯 개, survey_git 은 `--no-fetch --no-check-prs`).

## 작업 항목

1. `git mv skills/mac-cleanup skills/machine-cleanup`.
2. `SKILL.md` frontmatter `name` 과 제목을 `machine-cleanup` 으로 바꾸고, 설명에 「맥 정리」, 「홈서버 정리」 를 남긴다. 테스트 helper 머리 주석의 스킬 이름을 바꾼다.
3. major 올리기: `node scripts/bump-skill-major.ts machine-cleanup --note "..."` 로 3.0.0 과 CHANGELOG 를 고친다. CHANGELOG 제목을 `# CHANGELOG: machine-cleanup` 으로 바꾸고, 항목에 옛 이름 `mac-cleanup` 과 옛 오버레이 자리를 적는다.
4. 매니페스트 두 개, 루트 README 표, `docs/contributing.md`, `tsconfig.json`, `scripts/runtime-policy.json`, `skills/orch/references/cleanup.md`, `skills/orch/scripts/lib/docker.ts`, `skills/orch/scripts/lib/claude-profile.ts`, `skills/orch/tests/link-claude-profile.spec.ts`(사례 이름과 새 오버레이 파일 이름), `docs/features/orch-cli/spec.md`, 옛 기능 문서의 경로를 바꾼다.
5. orch 는 동작이 바뀌지 않으므로 변경 이력 조각을 더하지 않는다(주석과 문서만).

## 의도 메모

- 별칭 스킬은 만들지 않는다(DECISION4). 옛 이름으로 부르지 못한다는 것은 CHANGELOG 의 `호환성:` 항목이 알린다.
- 링크로 설치한 사람은 `~/.claude/skills/mac-cleanup` 링크가 깨진다. CHANGELOG 항목에 함께 적는다.
