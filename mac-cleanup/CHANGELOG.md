# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.1.0

`survey_git.py` 가 stash 를 워크트리 브랜치 기준으로 센다. 이전에는 저장소 전체 stash 수를 모든 워크트리에 넣어, stash 가 하나라도 있는 저장소의 워크트리가 모두 "유지" 로 분류됐다.
`survey_git.py --check-prs` 를 더했다. squash 머지처럼 `--is-ancestor` 로 보이지 않는 머지를 `gh pr list` 로 확인해 "PR 머지됨(-D)" 와 "제거 후보(PR 머지됨)" 로 분류한다.
`--check-prs` 는 브랜치 이름만이 아니라 머지된 PR 의 `headRefOid` 와 로컬 브랜치 끝 커밋을 대조한다. 같은 이름을 다시 써서 PR 이후 커밋을 쌓은 브랜치는 "PR 머지됨" 이 아니라 "PR 확인 필요" 로 남고, 실행 직전 끝 커밋이 조사 때와 같은지 다시 보게 했다.
`git-and-sessions.md` 의 `gh` 명령이 저장소 위치를 받고, 워크트리를 지운 뒤 브랜치 후보를 다시 조사하라는 안내를 더했다.
`targets.md` 에 대화 기록, 프로젝트 산출물, 반복 helper 의 정리 명령을 더했다.

## 1.0.0

스킬을 처음 만들었다.
조사 스크립트 다섯 개(`survey_system.sh`, `survey_sessions.py`, `survey_git.py`, `survey_gradle.sh`, `docker_images.py`)는 모두 읽기 전용이다.
정리 후보의 등급과 명령은 `references/targets.md`, 세션과 브랜치와 워크트리 정리 절차는 `references/git-and-sessions.md` 가 소유한다.
