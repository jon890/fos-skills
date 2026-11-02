# Phase 03. SKILL.md 와 플러그인 등록

**Execution profile**: standard

## 목표

report 스킬의 실행 절차(`SKILL.md`), 사용자 안내(`README.md`), 이력(`CHANGELOG.md`)을 쓰고 두 플러그인 매니페스트와 저장소 README 에 등록한다(R1, R3, R5, R6, R7, R8).

**범위 외**: 검사 스크립트(phase 01), 틀과 구성 문서(phase 02). 팀 저장소 내보내기(`scripts/export-to-team.sh` 의 `SHARED_SKILLS`)는 이번에 하지 않는다.

## 컨텍스트

- 스펙: `docs/features/report/spec.md` 전체. 특히 R1 과 R8 은 description 에 들어갈 문장을 정한다.
- 문서 구조는 `~/.claude/references/skill-structure.md` 를 따른다: 목표 한 문장 → 워크플로우 개요 표(단계, 이름, 통과 조건, reference) → 단계별 절.
- 선례: `presentation/SKILL.md` 의 번들 상대경로 안내, `presentation/README.md` 의 README 절 구성.
- README 절과 CHANGELOG 형식은 저장소 `README.md` 의 「스킬 README」 와 「버전과 변경 이력」 이 정하고 `scripts/check-skill-docs.py` 가 검사한다.
- 스킬을 더할 때 `.claude-plugin/plugin.json` 과 `.codex-plugin/plugin.json` 의 `skills` 배열, 저장소 README 의 스킬 목록 표를 함께 고친다. 빠지면 `scripts/tests/test_plugin_manifest.py` 가 실패한다.
- 플러그인 `version` 은 main 머지 때 workflow 가 올린다. 사람이 올리지 않는다.

**근거 문서**: `docs/features/report/spec.md` 의 「요구사항과 인수 조건」 전체와 「설계」

## 의도 메모

- 파일 자리 계산은 짧은 셸 블록으로 둔다. git 저장소면 `<루트>/.omc/previews/`, 아니면 세션 임시 폴더(`$SCRATCHPAD`, 없으면 `$TMPDIR`)다(R3, D5).
- 검사 실패 시 두 번까지 고쳐 다시 검사하고, 그래도 실패면 띄우지 않고 알린다(R7, D12).
- korean-check 는 `check-report.py --text` 로 뽑은 글을 임시 `.md` 로 저장해 `check.sh` 에 넘긴다(R6).
- 응답에는 경로, 고른 구성 한 줄, 검사 결과를 적는다(R3, R5).

## 작업 항목

### 1. `report/SKILL.md`

- frontmatter: `name: report`, `metadata.version: "1.0.0"`, description 에 `/report`, 「HTML 로 시각화해서 설명」, 「보고서로 만들어」, 「한눈에 보이게 정리」 와 R8 의 나누는 문장(「청중 앞에서 넘기며 말하는 발표는 `presentation`, 외부에 게시할 글은 `content-preview`, 혼자 읽는 설명과 보고서는 `report`」), 웹 조사를 하지 않는다는 문장.
- 본문: 목표, 원칙(넘겨받은 내용만 쓴다), 개요 표 5단계(재료 모으기, 구성 고르기, 틀에 채우기, 검사, 띄우기), 단계별 절. 3단계는 `assets/template.html` 을 복사해 채우고 `references/layouts.md` 를 읽는다. 4단계는 `scripts/check-report.py` 와 korean-check. 5단계는 `open` 과 응답 형식.
- 본문에도 R8 문장을 둔다.

### 2. `report/README.md`

첫 문단, `## 이럴 때 쓴다`, `## 사용 예시`, `## 받는 것`, `## 함께 쓰는 스킬`.

### 3. `report/CHANGELOG.md`

`# CHANGELOG: report` 머리와 `## 1.0.0 (2026-11-03)` 절. 항목은 새 스킬을 쓰는 사람이 알 것만.

### 4. 매니페스트와 저장소 README

- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` 의 `skills` 에 `./report` 를 알파벳 순 자리에 더한다.
- `README.md` 의 스킬 목록 표에 `report` 줄을 `presentation` 아래에 더한다.

## 검증

```bash
python3 -m unittest discover -s scripts/tests
python3 -m unittest discover -s report/tests
python3 scripts/check-skill-docs.py
python3 korean-check/scripts/korean-style-check.py report/SKILL.md report/README.md report/CHANGELOG.md README.md
```

기대값: 모두 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `report/SKILL.md` | 신규 |
| `report/README.md` | 신규 |
| `report/CHANGELOG.md` | 신규 |
| `.claude-plugin/plugin.json` | 수정 |
| `.codex-plugin/plugin.json` | 수정 |
| `README.md` | 수정 |
