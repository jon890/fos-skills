# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.2.0

`survey_git.py` 가 브랜치와 워크트리의 끝 커밋을 JSON 의 `tip`(전체 해시)과 텍스트의 `끝=`(짧은 해시)로 출력한다. 이전에는 `-D` 직전에 대조할 조사 때 값이 출력에 없어 `gh` 를 다시 불러야 했다.
`classify_branch` 가 기준 브랜치가 아니어도 `main`, `master`, `develop` 을 "유지" 로 둔다. 기준이 `develop` 인 저장소에서 로컬 `main`, `master` 가 "삭제 후보(-d)" 로 나오던 문제다.
`--check-prs` 에서 `gh` 가 실패하면 `pr_state` 를 `"error"` 로 표시하고, 합계에 `gh 확인 실패 N개` 를 센다. 분류 결과는 바뀌지 않고, 실패한 항목은 "유지" 여도 출력에 남는다. `--gh-timeout` 으로 시간 초과를 정하고 기본은 20초다.
SKILL.md 와 `git-and-sessions.md` 가 실행 목록을 `--json` 으로 만들고, `-D` 직전 대조를 JSON 의 `tip` 과 `git rev-parse` 로 하라고 안내한다.
부팅 직후 Colima 가 올라오기 전이면 `docker_images.py` 가 종료 코드 1 로 끝나므로, 건너뛰기 전에 `colima status` 를 보라는 안내를 더했다.

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
