# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.10.0

실제 정리(2026-10-25)에서 막힌 두 곳을 고쳤다.

- 익명 volume 삭제에 스크립트가 없었다. 후보 101개를 코디네이터가 텍스트 출력에서 정규식으로 이름을 뽑아 파일에 쓰고 `while read` 로 지웠는데, 파일 끝에 줄바꿈이 없어 마지막 하나가 빠졌다(100개 삭제, 1개 남음). 종류별 집계(Postgres 77개, MySQL 2개, 그 밖 22개)도 직접 짰고, 그 밖 22개는 에이전트 홈과 SQLite 파일이라 테스트 DB 와 따로 물어야 했다
- `docker_volumes.py` 가 열어 본 volume 에 내용 종류(`postgres`, `mysql`, `other`)를 붙이고 종류별 합계를 낸다. `--json` 항목에 `kind` 를 더했다(열지 않으면 `null`). `--json-out FILE` 은 텍스트를 출력하면서 같은 결과를 파일에 쓴다. `--peek all` 은 후보를 모두 연다. 기존 필드와 정수 `--peek` 동작은 그대로다
- `delete_volumes.py` 를 더했다. `--json-out` 파일을 읽어 기본은 dry-run 으로 보이고 `--apply` 일 때만 이름마다 `docker volume rm` 을 부른다. 후보이고 열어 본 결과가 있으며 `--kind`(기본 `postgres`, `mysql`)에 드는 것만 지우고, 실행 직전 dangling 목록을 다시 읽는다. ryuk 가 떠 있으면 `--apply` 를 거부한다
- `delete_branches.py` 의 `merged` 경로가 이미 없는 브랜치를 dry-run 에서 `삭제 예정` 으로 보였다. 조사 뒤 다른 곳에서 지워진 브랜치가 `[삭제 예정] ... -d (거절되면 유지: 브랜치가 없다)` 로 보였다. `pr-merged` 경로처럼 dry-run 과 `--apply` 모두 `유지`, 「브랜치가 없다」 로 보인다
- `tests/test_delete_volumes.py` 를 새로 더하고 `test_docker_volumes.py`, `test_delete_branches.py` 에 종류 판정과 없는 브랜치 테스트를 더했다

## 1.9.0

실제 정리에서 막힌 네 곳을 고쳤다.

- `survey_git.py` 가 `--fetch` 와 `--check-prs` 를 기본으로 켠다. 사용자가 항상 둘 다 켜기를 골라 1단계의 질문을 없앴다. 끄는 옵션은 `--no-fetch`, `--no-check-prs` 이고, 기존 `--fetch`, `--check-prs` 는 오류 없이 받되 효과가 없다
- `survey_git.py --json-out FILE` 을 더했다. 텍스트를 출력하면서 같은 조사 결과를 JSON 으로 파일에 쓴다. 텍스트와 `--json` 을 따로 돌리면 fetch 와 `gh` 조회가 두 번 돌고, 실측에서 두 결과가 달라져 사용자에게 보인 목록과 실행 목록이 어긋났다. 기존 `--json` 동작은 그대로다. SKILL.md 와 `git-and-sessions.md` 의 명령이 이 한 번 실행을 쓴다
- `survey_system.sh` 를 `survey_system.py` 로 옮겼다. 기존 절과 출력 의미는 같다. 큰 디렉터리는 `du -xkd1` 한 번으로 읽어 셸 glob 실패로 디렉터리가 빠지는 문제가 없다
- `survey_system.py` 에 「업데이트 캐시」 절을 더했다. `*-updater`, `*.ShipIt` 마다 크기와 대기 표시(`pending`, `update.zip`, `update-info.json`)를 보인다. `targets.md` 는 대기 표시가 없을 때만 안전으로 둔다. 실측에서 `orca-updater` 에 설치 전 업데이트 268MB 가 있었다
- `survey_system.py` 에 Codex 이전 버전, Cursor snapshots, `mise prune --dry-run` 후보, 오래된 `~/.cache` 하위 절을 더했다. `targets.md` 「큰 영역 후보」 가 등급(확인 필요)과 지우는 조건을 정한다. `mise prune` 은 그대로 돌리지 않고 사용자가 고른 도구만 `mise uninstall` 로 지운다
- SKILL.md 에 「개인 오버레이」 절을 더했다. `~/.claude/mac-cleanup-overlay.md` 가 있으면 먼저 읽고 코어보다 우선하며, 오버레이가 뺀 항목은 2단계 분류와 3단계 승인 질문에 올리지 않는다. 없으면 코어 기본값이다
- `tests/test_parsers.py` 에 기본값 반전과 `--json-out` 테스트를, `tests/test_survey_system.py` 를 새로 더했다

## 1.8.0

`rmi=` 가 `repo:tag` 로 조회되지 않는 이미지를 이미지 ID 로 내도록 고쳤다.

- 이름이 `repo:tag@digest` 로 저장된 이미지는 `docker images` 가 태그를 보여 줘도 `docker rmi repo:tag` 가 `No such image` 로 실패했다. 실측 사례는 `ghcr.io/actions/actions-runner:2.338.0` 이다. `docker_images.py` 가 `docker image inspect <repo:tag>` 의 종료 코드로 조회 여부를 확인하고, 조회되지 않으면 `rmi=` 에 짧은 이미지 ID 를 낸다
- 시간 초과나 docker 실행 실패는 확인하지 못한 것이므로 기존처럼 `repo:tag` 를 낸다. 확인하지 못한 것을 ID 로 바꾸면 태그가 여럿인 이미지가 `-f` 없이 거절되기 때문이다
- `rmi_target` 에 `resolves` 인자를 더했다(기본값 `True`). 기존 호출과 기존 테스트의 결과는 그대로다
- `targets.md` 「Docker」 에 조회되지 않는 이미지의 처리와 실측 사례를 적었다
- `tests/test_parsers.py` 에 조회 실패 시 ID, 시간 초과 시 `repo:tag` 테스트를 더했다

## 1.7.0

Colima 의 `fstrim` 을 결과를 재고 재시도하는 스크립트로 옮겼다.

- `colima_trim.py` 를 더했다. `sync` 뒤에 `fstrim -v` 를 돌리고, 호스트 VM 디스크 파일의 점유 크기와 VM 안 사용량의 차이가 기준값(`--threshold-gib`, 기본 4)보다 크면 `--interval` 초(기본 60) 뒤 최대 `--max-attempts` 회(기본 4) 다시 돈다. 시도마다 trim 양과 세 수치를 내고 마지막에 전후 비교와 호스트 확보량을 낸다. 종료 코드는 0 완료, 1 Colima 정지나 측정 실패, 2 재시도 상한까지 차이가 남음이다. 실측에서 volume 을 지운 직후의 trim 이 8GiB 만 비우고 1분 뒤 43.8GiB 를 비웠기 때문이다
- 에이전트 도구의 명령 시간 한도(Bash 도구는 기본 120초)에 끊기지 않도록 `--max-seconds`(기본 100)를 두었다. 대기와 직전 시도 소요 시간을 더한 다음 시도가 이 안에 끝나지 않을 것 같으면 재시도하지 않고 남은 차이를 출력한 채 종료 코드 2 로 끝낸다
- `targets.md` 「Docker」 와 SKILL.md 4, 5단계가 이 스크립트를 가리킨다
- `tests/test_colima_trim.py` 를 더했다

## 1.6.0

실제 정리에서 막힌 세 곳을 고쳤다.

- `docker_images.py` 가 각 줄 끝에 `docker rmi` 에 그대로 넘길 `rmi=` 값과 짧은 이미지 ID `id=` 를 낸다. 이전에는 태그만 `<none>` 인 이미지가 `traefik:<none>` 으로 나와 `invalid reference format` 으로 실패했다. 태그가 있으면 `repo:tag`, 저장소나 태그가 `<none>` 이면 이미지 ID 다. 기존 컬럼의 순서와 의미는 그대로다
- `check_pr_branches.py` 를 더했다. `survey_git.py --json` 의 `PR 확인 필요(-D)` 브랜치마다 지금 tip 이 조사 때와 같은지, 최근 PR 목록, 원격에 없는 로컬 커밋 수와 판정 한 줄을 낸다. `pr_state` 가 `null` 이어도 돌고, `gh` 실패는 항목별로 표시한다. `--json` 이 있고 읽기 전용이다. `git-and-sessions.md` 의 수동 확인 명령을 이 스크립트를 쓰는 절차로 바꿨다
- `KEEP_BRANCHES` 에 `alpha`, `beta` 를 더했다. 배포용 장수 브랜치가 「PR 확인 필요」 후보로 올라오던 문제다
- `targets.md` 「Docker」 가 이미지를 `rmi=` 값으로 지우게 하고, SKILL.md 4단계에 새 스크립트를 반영했다
- `tests/` 에 `rmi_target`, `check_pr_branches.py`, `alpha` 와 `beta` 유지 분류의 테스트를 더했다

## 1.5.0

즉석 셸 루프와 Python 으로 하던 두 단계를 스크립트로 옮겨, 기준(하루 이내 volume 제외, tip 대조)을 빠뜨리지 않게 했다.

- `docker_volumes.py` 를 더했다. dangling 인 64자리 hex 익명 volume 에 생성 시각과 크기를 붙이고, 기준 시간(기본 24시간) 안에 생긴 것은 "최근" 으로 따로 보여 후보 합계에서 뺀다. ryuk 가 떠 있으면 경고하고, `--peek N` 이 이미 있는 이미지로 volume 을 읽기 전용으로 붙여 최상위 항목을 보인다. `--json` 이 있다. 읽기 전용이다
- `delete_branches.py` 를 더했다. `survey_git.py --json` 결과를 읽어 `-d`, 거절 뒤 tip 과 `--is-ancestor` 확인을 거친 `-D`, 실행 직전 tip 이 같을 때만 쓰는 PR 머지됨 `-D` 를 수행한다. 기본은 dry-run 이고 `--apply` 가 있어야 지운다. 브랜치마다 결과를 내고 실패가 있으면 종료 코드 1 이다. 원격 브랜치는 지우지 않는다
- `targets.md` 「Docker」 와 `git-and-sessions.md` 「브랜치」 가 새 스크립트를 쓰게 고쳤다. 스크립트가 소유하게 된 명령 나열은 걷어내고 판단 기준만 남겼다
- SKILL.md 1단계 조사 목록과 4단계에 새 스크립트를 반영했다
- `tests/` 에 두 스크립트의 테스트를 더했다. volume 쪽은 순수 함수로, 브랜치 쪽은 `tempfile` 임시 저장소로 확인한다

## 1.4.0

지시끼리 어긋난 곳을 맞추고, reference 와 스크립트가 이미 소유한 문장을 걷어낸다.

- 1단계 통과 조건이 Colima 가 꺼져 `docker_images.py` 만 1 로 끝나는 경우를 허용한다
- 4단계의 「실패하면 멈춘다」 에서 `branch -d` 의 `not fully merged` 거절을 뺐다. 그 처리는 `git-and-sessions.md` 가 정한다
- 3단계 승인 질문에서 하네스 도구 이름을 지우고 「구조화 질문 도구가 있으면」 으로 바꿨다
- 4단계 reference 에 `targets.md` 를 더했다
- `git-and-sessions.md`, `targets.md`, 스크립트 docstring 과 겹치던 `SKILL.md` 문장(JSON 파싱 함정, 워크트리 삭제 뒤 재조사, 현재 세션 제외, sudo 확인, gh 확인 실패 처리)을 지웠다
- 행동을 바꾸지 않는 실측 수치와 문장(옵션 재실행 24개, npx 44개 중 25개, 부팅 직후 종료 코드, 눈으로 해시 대조)을 지웠다
- 브랜치 제외 이름 목록을 `survey_git.py` 의 `KEEP_BRANCHES` 를 가리키는 문장으로 바꿨다
- `targets.md` 에서 `docker_images.py` 내부의 태그 비교 설명을 지웠다

## 1.3.0

`targets.md` 가 `npm cache clean --force` 는 `_cacache` 만 비운다고 적고, `~/.npm/_npx` 를 "확인 필요" 후보로 더했다. 이전에는 `~/.npm` 이 전부 `_npx` 여도 명령이 종료 코드 0 에 확보량 0 으로 끝났다. `survey_system.sh` 가 `~/.npm/_npx` 크기를 따로 한 줄 보인다.
`git-and-sessions.md` 가 `git branch -d` 의 `not fully merged` 거절을 다룬다. 조사 JSON 의 `tip` 과 `git rev-parse` 가 같고 `merge-base --is-ancestor "$BR" "$BASE"` 가 0 일 때만 `-D` 로 지우고, 하나라도 다르면 유지한다.
`targets.md` 가 Docker 이미지 확보량을 "최대" 로 적고 약속하지 않게 했다. 남는 이미지와 레이어를 공유하면 실제 확보량이 미사용 합계보다 훨씬 작다.
`targets.md` 가 `docker volume prune` 을 금지하고, 조사 때 열어 본 volume 만 `docker volume rm` 으로 지우게 했다. 실행 직전에 testcontainers 의 ryuk 가 떠 있는지 본다.
SKILL.md 가 `--fetch` 와 `--check-prs` 를 1단계에서 묻게 하고 통과 조건에 넣었다. 이전에는 승인 뒤 옵션을 바꿔 다시 조사해 후보가 새로 나왔다.

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
