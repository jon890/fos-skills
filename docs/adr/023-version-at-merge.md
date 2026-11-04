# ADR-023: 스킬 버전과 CHANGELOG 절은 PR 이 아니라 머지 때 정한다

- **status**: `accepted`
- **결정**: PR 은 스킬의 `metadata.version` 과 CHANGELOG 를 건드리지 않고 `<단위>/changes/<슬러그>.<등급>.md` 조각 파일만 더한다. 단위는 `skills/<이름>`, `export-only-skills/<이름>`, `extensions/<이름>` 이고 등급은 파일 이름 접미 `.patch.md`, `.minor.md` 둘뿐이다. 내용은 CHANGELOG 항목(`- ` 줄) 1~5개다.
  main push 마다 `plugin-version.yml` 이 부르는 `scripts/bump-plugin-version.py` 가 먼저 main 트리의 조각을 모두 처리한다. 조각마다 버전 하나를 머지 순서(`git log --first-parent` 에서 처음 나온 순서)로 올려 CHANGELOG 맨 위에 `## X.Y.Z (한국 시간 실행일)` 절을 만들고 `SKILL.md` 가 있으면 `metadata.version` 도 바꾸며 조각 파일을 지운다. 조각이 있으면 플러그인 등급은 minor 이상이다.
  major(`호환성:` 항목)는 조각으로 받지 않는다. PR 이 버전과 CHANGELOG 를 직접 올린다. 옛 방식 PR 도 그대로 머지되고, 조각이 없는 스킬은 workflow 가 건드리지 않는다.
  [ADR-019](019-plugin-version-auto-bump.md) 의 플러그인 version 규칙(등급, 형식, 봇 커밋)은 유지하고 그 입력에 조각을 더한다. 사용자 결정 2026-11-04.
- **맥락**: 같은 스킬을 고치는 PR 이 여럿이면 먼저 머지된 PR 뒤의 PR 이 버전 줄과 CHANGELOG 절에서 충돌했다. orch `7.6.0` 절에서 두 PR 이 충돌해 7.7.0 으로 다시 올리고 CI 를 다시 기다렸고, 다른 PR 도 `work-board/CHANGELOG.md` 에서 CONFLICTING 이 났다.
  CHANGELOG 맨 위에 `## Unreleased` 절을 두는 안은 같은 위치에 더하는 것이라 충돌을 없애지 못한다. 임시 git 저장소에서 두 PR 이 각각 `## Unreleased` 와 항목을 더하고 차례로 병합하니 CONFLICT 가 났다(2026-11-04 실측).
- **대안 기각**:
  - `## Unreleased` 절: 위 실측대로 충돌한다.
  - 지금처럼 PR 이 직접 올림: 충돌이 그대로다.
  - 조각이 없는 스킬 변경을 CI 가 막는다: 충돌이 없어져 가능해졌지만 오타 고침까지 조각을 강제하게 된다. 빠뜨림이 실제로 생기면 다음에 검토한다.
  - 조각을 스킬마다 한 절로 합친다: 절당 항목 5개 상한(`check-skill-docs.py`)을 넘기거나 항목을 깎아야 한다. PR 하나가 버전 하나인 지금 이력도 달라진다.
  - major 도 조각으로 받는다: 이전 major 의 절들을 `N.x` 한 절로 접는 글을 사람이 써야 해서 자동으로 만들 수 없다.
- **결과**:
  - 얻는 것: 같은 스킬을 고치는 PR 끼리 버전 줄과 CHANGELOG 로 충돌하지 않는다. 조각 파일 이름이 PR 마다 달라 git 이 그대로 합친다.
  - 얻는 것: 실행이 빠져도 복구된다. workflow 는 push 범위가 아니라 main 트리의 조각을 모두 처리한다. GitHub 은 같은 그룹의 대기 실행을 최신 하나만 남기므로 앞 머지의 실행이 취소돼도 다음 실행이 이어서 올린다.
  - 감당할 것: PR 브랜치의 `SKILL.md` 버전이 main 보다 낡아 보이고, 새 버전 번호는 머지 뒤 봇 커밋에서야 정해진다.
  - 감당할 것: 취소된 실행의 PR 번호와 옛 방식 `호환성:` 신호는 플러그인 CHANGELOG 줄에서 빠진다. 스킬 버전과 조각은 복구된다.
  - 감당할 것: 틀린 조각은 건너뛰고 경고만 내므로 main 에 남는다. PR 의 `check-skill-docs.py` 가 먼저 막지만 관리자 머지로 들어오면 다음 실행마다 경고한다.
  - 감당할 것: 봇의 push 가 옛 방식 PR 과 CHANGELOG 에서 겹치면 `git pull --rebase` 가 실패해 3회 뒤 workflow 가 끝난다. 수동으로 복구한다.
  - 감당할 것: 스킬 폴더를 옮기면 조각 추가가 이름 변경으로 잡혀 머지 순서를 모르고 이름순으로 처리한다.
  - 팀 저장소 내보내기는 `changes/` 를 제외한다. 사본은 main 에서 조각이 지워진 뒤의 버전을 받는다.
- **적용 범위**: 조각 이름과 형식, 직접 올림과 섞지 않는 규칙은 저장소 README 「버전과 변경 이력」 이 소유한다. 조각의 검사와 적용은 `scripts/skill_changes.py` 가 소유한다. 설계는 `docs/features/version-at-merge/` 에 있다.
