# Phase 03. 스킬 문서와 배선

**Execution profile**: fast

## 목표

`inbox` 스킬 문서(답변 절차, 설정)와 매니페스트·README·CHANGELOG·CI 를 맞춘다. 대화 요청으로 스킬이 뜨고 CI 가 inbox 테스트를 돈다.

**범위 외**: 코드 변경(phase 01, 02)

## 컨텍스트

스킬 구조는 `~/.claude/references/skill-structure.md`, README 「스킬을 더할 때」, 「버전과 변경 이력」 을 따른다.

**근거 문서**: `docs/features/work-inbox/spec.md` 의 「설계」 와 「요구사항과 인수 조건」

## 작업 항목

### 1. 구현

- `inbox/SKILL.md`(metadata.version "1.0.0"), `inbox/README.md`, `inbox/CHANGELOG.md`, `inbox/references/reply.md`(답변 절차: context, 초안, content-preview 가 있으면 그것으로 미리보기, 확인, `reply --yes`. 두레이 댓글 문체는 `dooray-task` 가 있으면 따른다), `inbox/references/config.md`(설정, 상태, 필터 파일 형식과 예시, Slack adapter 를 더할 때 바뀌는 곳). 스킬 구조는 `~/.claude/references/skill-structure.md` 를 따른다
- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` 의 skills 에 `./inbox`, 루트 README 스킬 표에 한 줄, `tsconfig.json` include 에 `inbox/scripts/**/*.ts`, CI(`.github/workflows/ci.yml`)와 README 의 node --test 줄에 `"inbox/tests/*.spec.ts"`
- `work-board/README.md` 에 알림 상자 줄, `work-board/CHANGELOG.md` 1.4.0, work-board 버전 표기가 있으면 함께
- 이 계획 디렉터리를 지운다

### 2. 이 phase 를 검증하는 `scripts/tests` 의 매니페스트 테스트

`.claude-plugin/plugin.json` 과 `.codex-plugin/plugin.json` 의 skills 배열에 `./inbox` 가 함께 있는지 기존 테스트가 본다. 스킬 README 와 CHANGELOG 형식은 `check-skill-docs.py` 가 본다.

## 검증

```bash
python3 -m unittest discover -s scripts/tests
python3 scripts/check-skill-docs.py
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts" "inbox/tests/*.spec.ts"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `inbox/SKILL.md` | 신규 |
| `inbox/README.md` | 신규 |
| `inbox/CHANGELOG.md` | 신규 |
| `inbox/references/reply.md` | 신규 |
| `inbox/references/config.md` | 신규 |
| `.claude-plugin/plugin.json` | 수정 |
| `.codex-plugin/plugin.json` | 수정 |
| `README.md` | 수정 |
| `.github/workflows/ci.yml` | 수정 |
| `work-board/README.md` | 수정 |
| `work-board/CHANGELOG.md` | 수정 |
