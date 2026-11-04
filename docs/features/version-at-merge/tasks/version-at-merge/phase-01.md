# Phase 01. 조각 방식 버전 상향

**Execution profile**: standard

## 목표

PR 이 `<단위>/changes/<슬러그>.<등급>.md` 조각만 더하고, main push 때 workflow 가 조각으로 스킬 버전과 CHANGELOG 절을 올리게 한다.

**범위 외**: 조각 없는 스킬 변경을 막는 CI 검사, major 를 조각으로 받는 것, 플러그인 version 등급 규칙 변경.

## 컨텍스트

- 지금 `scripts/bump-plugin-version.py` 는 push 범위의 스킬 CHANGELOG diff 로 플러그인 등급을 정하고 `.github/workflows/plugin-version.yml` 이 부른다. `scripts/check-skill-docs.py` 는 CHANGELOG 형식과 SKILL.md 버전 일치를 검사한다. `scripts/skill_paths.py` 는 스킬 원본 위치를 가진다. 이 스크립트 모듈 모양을 따른다.
- `extensions/work-board` 는 SKILL.md 가 없고 CHANGELOG 만 있다.
- 이 PR 자체는 옛 방식으로 버전을 올린다. 새 workflow 는 머지 뒤 처음 돈다.

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ6, REQ7, REQ8

**근거 문서**: `docs/features/version-at-merge/spec.md`, `docs/features/version-at-merge/design.md`

## 의도 메모

- `## Unreleased` 절은 같은 위치에 더해 충돌한다(실측). 그래서 조각 파일이다.
- 조각 규칙은 `scripts/skill_changes.py` 한 곳에 둔다.

## 작업 항목

### 1. `scripts/skill_changes.py` 신규 (commit 1: feat(scripts): 스킬 변경 이력 조각 규칙과 적용 코드를 더한다)

`UNIT_ROOTS = ("skills", "export-only-skills", "extensions")`, `MAX_BULLETS=5`, `MAX_BULLET_CHARS=160`. 함수: `unit_dirs(root)`(CHANGELOG.md 가 있는 단위), `check_fragment(name, text)`(문제 문자열 목록), `fragments(root)`(단위별 정렬된 경로, git 순서), `next_version(version, level)`, `apply_fragments(root, day=None)` 는 `([(단위 이름, 새 버전)], [경고])` 를 돌려준다. 설계의 「인터페이스와 데이터」 를 그대로 따른다. 날짜 기본값은 `Asia/Seoul` 오늘이다.

### 2. `scripts/check-skill-docs.py` 갱신 (commit 2: feat(scripts): 변경 이력 조각의 형식을 CI 가 검사한다)

모든 단위의 `changes/` 를 `check_fragment` 로 검사해 `<경로>: <이유>` 줄을 낸다. 인자로 스킬 이름을 주면 그 스킬만 본다.

### 3. `scripts/tests/test_skill_changes.py` 신규, `scripts/tests/test_skill_docs.py` 추가 (테스트는 각 commit 에 나눠 담는다)

임시 git 저장소로 확인한다. REQ1 두 브랜치 병합 무충돌, patch·minor 올림, 조각 둘의 머지 순서 번호(merge 커밋과 squash 머지, 이름순과 반대인 경우, 스킬 폴더 이동 뒤 이름순 대체), 직접 올린 버전 위에 조각, 단위 둘, SKILL.md 없는 확장, 틀린 조각 건너뜀과 경고, 조각 없음, 두 번째 실행이 아무것도 안 바꿈, 날짜 인자. 검사기는 접미·비목록 줄·6개 항목·161자·`호환성:` 이 각각 파일과 이유로 걸리는지 본다.

### 4. `scripts/bump-plugin-version.py` 와 `.github/workflows/plugin-version.yml` (commit 3: feat(plugin): 머지 workflow 가 조각으로 스킬 버전을 올린다)

`run` 맨 앞에서 `apply_fragments` 를 부르고 등급을 `max(옛 신호, 조각이 있으면 minor)` 로, 요약 줄에 조각의 「단위 새버전」 을 더한다. 경고는 stderr. workflow 는 plugin.json 이 안 바뀌고 다른 파일만 바뀌면 커밋 제목을 `chore(skills): 스킬 버전을 올린다` 로 한다. `scripts/tests/test_bump_plugin_version.py` 에 조각만 있는 변경, 조각 둘(플러그인 한 번, 줄에 새 버전 모두와 PR 번호), 옛 `호환성:` 신호와 조각이 섞인 변경(major), 조각이 이미 처리된 push 범위(올리지 않음), plugin.json 을 직접 올린 범위(스킬만 올림), 틀린 조각 경고, 임시 저장소에서 CLI 를 머지 커밋으로 끝까지 도는 테스트를 더한다.

### 5. `scripts/export-to-team.sh` 와 테스트 (commit 4: fix(scripts): 팀 내보내기에서 변경 이력 조각을 뺀다)

`is_junk` 에 `rel.startswith("changes/")` 를 더하고 `scripts/tests/test_export_to_team.py` 에 조각이 어긋남으로 안 나오는 것을 확인하는 테스트를 더한다.

### 6. 문서 (commit 5: docs: 스킬 버전을 머지 때 정하는 규칙을 적는다)

README 「버전과 변경 이력」 과 스크립트 표, `docs/flow.md` 「갱신」, `docs/code-architecture.md` 모듈 표, `docs/adr/023-version-at-merge.md`(ADR 양식은 기존 ADR 을 따른다), `docs/adr/INDEX.md`, ADR-019 의 「적용 범위」 줄. 조각 이름과 형식, major 직접 올림, 옛 방식 공존, 한 PR 에서 직접 올림과 조각을 섞지 않는 규칙을 README 가 소유한다.

### 7. 스펙과 설계 문서 (commit 6: docs: 기능 스펙과 설계를 더한다)

`docs/features/version-at-merge/spec.md`, `design.md` 는 남기고 이 `tasks/version-at-merge/` 폴더는 verify 뒤 별도 커밋으로 제거한다. 이 PR 은 스킬 파일을 바꾸지 않아 스킬 버전과 CHANGELOG 를 올리지 않는다.

## 검증

```bash
python3 -m unittest discover -s scripts/tests
python3 scripts/check-skill-docs.py
python3 skills/plan/scripts/check_feature.py docs/features/version-at-merge/spec.md --design docs/features/version-at-merge/design.md
python3 export-only-skills/korean-check/scripts/korean-style-check.py docs/features/version-at-merge/spec.md docs/features/version-at-merge/design.md docs/adr/023-version-at-merge.md README.md
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/plugin-version.yml'))"
! grep -rn '바뀐 스킬 CHANGELOG 로 등급' README.md docs/flow.md docs/code-architecture.md
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 임시 git 저장소, 같은 스킬에 조각을 하나씩 더한 두 브랜치 | 두 브랜치를 차례로 병합 | 충돌 없이 병합, 조각 둘이 남음 | `test_skill_changes.py` | 없음 | PR 전 |
| REQ2 | 조각 1건과 SKILL.md, CHANGELOG | `apply_fragments` 실행 | 버전이 한 단계 오르고 CHANGELOG 맨 위에 절이 생기며 조각이 지워진다 | `test_skill_changes.py` | 없음 | PR 전 |
| REQ3 | 스킬 둘, 조각 셋 | 순서가 다른 커밋으로 더한 뒤 실행 | 조각마다 버전 하나, 같은 스킬은 머지 순서 | `test_skill_changes.py` | 없음 | PR 전 |
| REQ4 | 조각 없는 스킬과 옛 방식으로 올린 버전 | `bump-plugin-version.py` 의 `run` | 그 스킬 파일은 그대로, 플러그인 등급은 지금과 같다 | `test_bump_plugin_version.py` | 없음 | PR 전 |
| REQ5 | 조각만 바꾼 push 범위 | `run` 실행 | 플러그인 minor 이상, 플러그인 CHANGELOG 줄에 「단위 새버전」 | `test_bump_plugin_version.py` | 없음 | PR 전 |
| REQ6 | 틀린 조각 다섯 종류 | `check-skill-docs.py` 실행 | 파일과 이유가 나오고 종료 코드 1, 저장소 전체는 0 | `test_skill_docs.py`, 위 검증 명령 | 없음 | PR 전 |
| REQ7 | 임시 팀 저장소와 `changes/` 가 든 스킬 | 내보내기 점검 | `changes/` 가 어긋남에 안 나온다 | `test_export_to_team.py` | 없음 | PR 전 |
| REQ8 | 고친 문서 | 한국어 검사기, ADR 레이아웃 검사, 옛 문장 grep | 위반 0, 옛 문장 0건 | 위 검증 명령, `test_doc_script_refs.py` | 없음 | PR 전 |
| REQ2 | 이 PR 이 main 에 머지됨 | 머지 뒤 첫 workflow 실행과 이어지는 조각 PR 의 머지를 본다 | 첫 실행은 조각 없이 플러그인 patch 만 올리고 경고가 없다. 조각을 더한 다음 PR 이 머지되면 봇 커밋이 SKILL.md 버전과 CHANGELOG 절을 올리고 조각을 지운다 | GitHub Actions 의 `Plugin version` 실행 | 머지 | PR 뒤 |
| REQ3 | 이 PR 이 main 에 머지됨 | 머지 뒤 첫 workflow 실행과 이어지는 조각 PR 의 머지를 본다 | 첫 실행은 조각 없이 플러그인 patch 만 올리고 경고가 없다. 조각을 더한 다음 PR 이 머지되면 봇 커밋이 SKILL.md 버전과 CHANGELOG 절을 올리고 조각을 지운다 | GitHub Actions 의 `Plugin version` 실행 | 머지 | PR 뒤 |
| REQ5 | 이 PR 이 main 에 머지됨 | 머지 뒤 첫 workflow 실행과 이어지는 조각 PR 의 머지를 본다 | 첫 실행은 조각 없이 플러그인 patch 만 올리고 경고가 없다. 조각을 더한 다음 PR 이 머지되면 봇 커밋이 SKILL.md 버전과 CHANGELOG 절을 올리고 조각을 지운다 | GitHub Actions 의 `Plugin version` 실행 | 머지 | PR 뒤 |

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/skill_changes.py` | 신규 |
| `scripts/check-skill-docs.py` | 수정 |
| `scripts/bump-plugin-version.py` | 수정 |
| `scripts/export-to-team.sh` | 수정 |
| `.github/workflows/plugin-version.yml` | 수정 |
| `scripts/tests/test_skill_changes.py` | 신규 |
| `scripts/tests/test_skill_docs.py` | 수정 |
| `scripts/tests/test_bump_plugin_version.py` | 수정 |
| `scripts/tests/test_export_to_team.py` | 수정 |
| `README.md` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `docs/adr/019-plugin-version-auto-bump.md` | 수정 |
| `docs/adr/023-version-at-merge.md` | 신규 |
| `docs/adr/INDEX.md` | 수정 |
