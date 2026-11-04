# 스킬 버전과 변경 이력을 머지 때 정한다: 기술 설계

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | PR 은 `<단위>/changes/<슬러그>.<등급>.md` 새 파일만 더한다. 파일 이름이 PR 마다 달라 git 이 충돌 없이 합친다 |
| REQ2 | 새 `scripts/skill_changes.py` 의 `apply_fragments` 가 조각마다 버전을 계산해 CHANGELOG 와 SKILL.md 를 고치고 조각을 지운다. `plugin-version.yml` 이 부르는 `bump-plugin-version.py` 가 이것을 먼저 호출한다 |
| REQ3 | `apply_fragments` 는 단위(스킬, 내보내기 전용 스킬, 확장)마다 조각을 모아 정렬한 뒤 하나씩 적용한다. 단위끼리는 독립이다 |
| REQ4 | 조각이 없는 단위는 건드리지 않는다. 조각이 있는 단위는 파일의 지금 버전 위에 올린다. 플러그인 등급의 옛 신호(범위 diff 의 `호환성:` 줄, 새 버전 절)는 그대로 읽는다 |
| REQ5 | `bump-plugin-version.py` 의 `run` 이 조각 적용 결과를 받아 등급을 minor 이상으로 하고 요약 줄에 새 버전을 적는다 |
| REQ6 | 조각 검사 함수 `check_fragment` 를 `skill_changes.py` 에 두고 `check-skill-docs.py` 가 불러 PR 의 CI(`scripts/tests`)가 저장소 전체를 검사한다 |
| REQ7 | `export-to-team.sh` 의 `is_junk` 가 `changes/` 아래를 제외한다 |
| REQ8 | README, flow.md, code-architecture.md, 새 ADR-023, ADR-019 의 적용 범위 줄을 고친다 |

## 책임과 경계

- `scripts/skill_changes.py`(새)가 조각의 규칙을 소유한다: 단위 탐색, 이름과 내용 검사, 순서, 적용. `skill_paths.py` 와 같은 모양의 순수 함수 모듈이다. `check-skill-docs.py` 와 `bump-plugin-version.py` 가 같은 규칙을 쓰게 한 곳에 둔다.
- 단위는 `skills/<이름>`, `export-only-skills/<이름>`, `extensions/<이름>` 가운데 `CHANGELOG.md` 가 있는 폴더다. 확장(work-board)은 `SKILL.md` 가 없다.
- 지금 버전의 원본은 CHANGELOG 첫 버전 절이다. `check-skill-docs.py` 가 SKILL.md 의 `metadata.version` 과 같음을 이미 강제한다. `SKILL.md` 가 있으면 그 version 줄도 함께 바꾼다.
- `check-skill-docs.py` 의 `main` 은 SKILL.md 가 있는 스킬을 도는 기존 검사 뒤에 `check_changes(root)` 를 따로 불러 모든 단위(SKILL.md 가 없는 work-board 포함)의 조각을 본다. 스킬 이름을 인자로 주면 그 단위의 조각만 본다.
- `bump-plugin-version.py` 는 플러그인 version 과 `.claude-plugin/CHANGELOG.md` 를 계속 소유한다. 조각 적용은 호출만 한다.
- workflow 는 호출 한 줄과 커밋 메시지만 가진다. 규칙은 스크립트에 둔다.

## 인터페이스와 데이터

조각 파일: `^[a-z0-9][a-z0-9-]*\.(patch|minor)\.md$`. 내용은 `- ` 줄 1~5개이고 줄마다 160자 이하이며 `호환성:` 으로 시작하지 않는다. 끝의 빈 줄은 허용한다.

`apply_fragments(root, day) -> (적용한 [(단위, 새 버전)], 경고 [문자열])`:

1. 조각 파일을 단위별로 모은다. 검사에 실패한 조각은 경고만 내고 건너뛴다.
2. 순서는 `git log --reverse --first-parent -m --diff-filter=A --name-only --format=` 가 낸 경로의 마지막 등장 순서다(같은 슬러그를 지웠다 다시 쓰면 다시 더한 자리). 목록에 없으면 파일 이름순이다. 머지 커밋은 첫째 부모 기준 diff 라 PR 이 더한 파일이 머지 순서로 나온다.
3. 조각마다 지금 버전에 등급을 적용한다(patch → Z+1, minor → Y+1 이고 Z 는 0). CHANGELOG 의 첫 `## ` 줄 앞에 `## X.Y.Z (day)`, 빈 줄, 조각 항목, 빈 줄을 넣는다. 파일 끝 빈 줄은 한 줄로 맞춘다. SKILL.md 가 있으면 `metadata.version` 줄을 바꾼다. 조각을 `git rm` 없이 파일로 지우면 workflow 의 `git commit -am` 이 삭제를 담는다.
4. 날짜 `day` 는 호출자가 준다. 기본값은 `Asia/Seoul` 의 오늘이다(`zoneinfo`).

`bump-plugin-version.py` 의 `run`: 맨 앞에서 `apply_fragments` 를 부른다. 조각 파일 경로는 바뀐 파일 목록에서 뺀다(조각을 앞 실행이 이미 처리했다면 조각 추가만으로 다시 올리지 않는다). skip 판정은 이렇게 한다. 범위가 plugin.json version 을 이미 바꿨으면 플러그인은 올리지 않는다(사람이 정한 값이 우선이고 조각 적용은 이미 끝났다). 바뀐 파일이 두 버전 파일뿐이어도 이번에 적용한 조각이 있으면 플러그인을 올린다. 올릴 때 등급은 `max(옛 신호 등급, 조각이 있으면 minor)` 이고 요약은 `조각 항목 + 옛 신호 항목` 의 「단위 새버전」 목록과 PR 번호다. 경고는 stderr 로 낸다.

`export-to-team.sh`: `is_junk(rel)` 에 `rel.startswith("changes/")` 를 더한다. 두 방향(복사와 남은 파일 정리)이 같은 함수를 쓴다.

workflow: `Commit and push` 단계의 제목을 `git diff --quiet -- .claude-plugin/plugin.json` 으로 나눈다. plugin.json 이 바뀌었으면 지금 문구, 안 바뀌고 다른 파일만 바뀌었으면 `chore(skills): 스킬 버전을 올린다` 다.

## 실패와 일관성

- workflow 는 push 범위가 아니라 main 트리의 조각을 모두 처리한다. 같은 그룹의 대기 실행이 최신 하나만 남아도 다음 실행이 이어 올린다. 한 번 처리한 조각은 지워져 다시 올리지 않는다(멱등).
- 형식이 틀린 조각은 건너뛰고 경고한다. 나머지는 처리한다. 틀린 조각은 남아 다음 실행에도 경고한다.
- CHANGELOG 의 첫 버전 절을 읽을 수 없거나 `SKILL.md` 가 있는데 `metadata.version` 줄이 없는 단위는 조각을 지우지 않고 건너뛰며 경고한다. 두 파일이 어긋나는 것을 막는다.
- 옛 방식 PR 과의 공존: 옛 방식이 올린 버전 위에 조각이 올라간다. 한 PR 안에서 직접 올림과 조각을 섞지 않는 것은 README 규칙이다(검사하지 않는다).
- 이 PR 은 옛 방식으로 올린다. 새 workflow 는 머지 뒤 처음 돈다. 머지 직후 main 에 조각이 없어 첫 실행은 플러그인 patch 로 끝난다.
- 취소된 실행의 한계: 조각과 스킬 버전은 다음 실행이 복구하지만, 플러그인 CHANGELOG 줄의 PR 번호와 옛 방식 `호환성:` 신호는 push 범위만 보므로 취소된 실행 몫이 빠진다. 기존 한계이고 문서(ADR-023)에 적는다.
- 사람이 plugin.json 을 직접 올린 push 에 조각이 함께 있으면 조각은 처리하지만 플러그인 CHANGELOG 줄에는 그 스킬 버전이 적히지 않는다.
- 봇의 `git pull --rebase` 가 옛 방식 PR 과 CHANGELOG 에서 겹치면 3회 뒤 workflow 가 끝난다. 수동 복구다(ADR-023 에 적는다).
- 스킬 폴더를 옮기면 조각 추가가 이름 변경으로 잡혀 `--diff-filter=A` 에 나오지 않는다. 이때는 DECISION3 의 이름순 대체 순서를 받는다.
- 되돌리기: workflow 의 호출 줄을 되돌리면 조각이 쌓이기만 한다. 조각이 있어도 옛 방식 PR 은 그대로 머지된다.

## 검증 전략

- 순수 함수와 임시 git 저장소(`tempfile`)만 쓴다. 실제 브랜치와 원격은 건드리지 않는다.
- REQ1: 임시 저장소에서 두 브랜치가 같은 스킬에 조각을 하나씩 더하고 차례로 병합해 충돌이 없는지 본다.
- REQ2~REQ4: `apply_fragments` 를 patch, minor, 순서, 여러 단위, SKILL.md 없는 확장, 틀린 조각 건너뛰기, 조각 없음, 두 번 돌려도 같음으로 확인한다. 날짜는 인자로 고정한다.
- REQ5: `bump-plugin-version.py` 의 `run` 을 조각만 있는 변경과 옛 신호가 섞인 변경으로 확인한다.
- REQ6: `check-skill-docs.py` 가 접미·내용 위반을 파일과 이유로 내는지 확인하고, 저장소 전체 검사가 지금 0 으로 끝나는지 본다.
- REQ7: 임시 팀 저장소로 `export-to-team.sh` 를 돌려 `changes/` 가 어긋남에 안 나오는지 본다. 기존 테스트의 방식을 따른다.
- REQ8: 문서 검사기(`korean-style-check.py`, `test_doc_script_refs.py`)와 `check-skill-docs.py` 로 본다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 조각 규칙의 자리 | `scripts/skill_changes.py` 한 곳. 검사기와 bump 스크립트가 함께 쓴다 | 작성자 | 규칙이 둘로 갈라 낡지 않게 한다(`skill_paths.py` 와 같은 관례) |
| DECISION2 | 지금 버전의 원본 | CHANGELOG 첫 버전 절. SKILL.md 가 있으면 함께 바꾼다 | 작성자 | work-board 확장은 SKILL.md 가 없다. 두 값의 일치는 `check-skill-docs.py` 가 지킨다 |
| DECISION3 | 조각 순서 | 첫째 부모 기준 `git log` 에서 파일을 마지막으로 더한 순서, 없으면 이름순 | 작성자 | 머지 순서가 버전 순서가 되고 squash, merge, rebase 머지 모두 같다 |
| DECISION4 | ADR 번호 | 023 을 쓴다. 이 저장소는 orch 의 `adr.dirs` 를 설정하지 않아 번호를 예약하지 못한다 | 작성자 | 열린 PR 에 ADR 변경이 없음을 `gh pr list` 로 확인했다 |
