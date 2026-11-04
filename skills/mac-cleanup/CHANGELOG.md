# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.13.1 (2026-11-04)

- 문서 표현만 고쳤다. 동작은 바뀌지 않았다

## 1.13.0 (2026-11-04)

- `survey_sessions.py` 에 「워크트리가 사라진 대화 기록」 절을 더했다. 기록 안의 `cwd` 가 없는 Claude 기록 폴더를 3일, 7일, 14일, 30일 넘은 묶음으로 세고 `--json-out` 으로 후보를 쓴다
- 실측: `~/.claude/projects` 18.4GB 가운데 13.5GB 가 이 기록이었는데 30일 기준 대화 기록 절은 350.8MB 만 보였다
- `delete_sessions.py` 를 더했다. 기본은 dry-run 이고, 지우기 직전에 경로, `cwd`, 수정 시각을 다시 확인한다
- `survey_system.py` 의 도구 캐시 절이 `~/.bun/install/cache` 크기를 보인다. `bun pm cache rm` 은 프로젝트 밖에서 아무것도 지우지 않아 폴더를 지운다
- Gradle 절의 auto mode 실측 문장을 사실에 맞게 고쳤다. 막힌 것은 glob 반복문과 여러 도구 정리를 한 명령에 묶은 것이라 원인을 확인하지 않았다

## 1.12.0 (2026-11-04)

- `survey_system.py` 의 mise 절이 버전마다 한 줄로 크기를 보이고, 그 설치 경로를 명령줄에 가진 프로세스가 있으면 `실행중` 을 붙인다. `24.15` 같은 별칭 링크 경로로 도는 프로세스도 잡고, 실행중 버전은 남긴다
- `survey_gradle.sh` 의 삭제 후보 절이 지울 경로를 한 줄에 하나씩 크기와 함께 보이고, 끝에 그 경로를 이어 붙인 `rm -rf` 한 줄을 낸다. glob 반복문 대신 이 줄을 쓰면 auto mode 가 막지 않는다

## 1.11.1 (2026-10-28)

- 삭제 명령 예시를 `"${VAR:?}"` 형식으로 바꿨다. 변수가 비면 셸이 멈춰 넓은 경로를 지우지 않고, Claude Code 의 삭제 안전 검사에도 막히지 않는다

## 1.11.0 (2026-10-28)

- Colima 가 꺼져 있으면 Docker 조사를 건너뛰고 끝내지 않는다. VM 디스크 크기를 보이고 켜서 조사할지를 승인 묶음으로 묻는다
- Orca 터미널이 붙은 워크트리는 지우지 않고 `orch` 의 정리로 넘기라고 알린다. description 에 worker PR 머지 뒤 정리는 `orch` 가 맡는다고 적었다

## 1.10.1 (2026-10-25)

- README 를 스킬을 쓰는 사람 관점으로 다시 쓰고, 이 CHANGELOG 를 버전마다 핵심만 남기도록 줄였다. 동작은 바뀌지 않았다

## 1.10.0 (2026-10-25)

- 익명 Docker volume 을 `delete_volumes.py` 로 지운다. 기본은 dry-run 이고 `--apply` 일 때만 지우며, testcontainers 의 ryuk 가 떠 있으면 거부한다
- `docker_volumes.py` 가 volume 내용 종류(`postgres`, `mysql`, `other`)를 보이고, `--json-out` 으로 결과를 파일에 쓰고, `--peek all` 로 후보를 모두 연다
- `delete_branches.py` 가 이미 지워진 브랜치를 dry-run 에서 `삭제 예정` 으로 보이던 문제를 고쳤다

## 1.9.0 (2026-10-23)

- `survey_git.py` 가 `--fetch` 와 `--check-prs` 를 기본으로 켜고, `--json-out` 으로 화면과 같은 조사 결과를 파일에 쓴다
- `survey_system.py` 가 `survey_system.sh` 를 대신하고, updater 캐시, Codex 이전 버전, Cursor snapshots, mise 후보, 오래된 `~/.cache` 를 보인다
- `~/.claude/mac-cleanup-overlay.md` 에 이 머신에서 정리하지 않을 앱을 적으면 후보에 올리지 않는다
- 호환성: `--fetch`, `--check-prs` 는 받기만 하고 효과가 없다. 끄려면 `--no-fetch`, `--no-check-prs` 를 쓴다

## 1.8.0 (2026-10-21)

- `repo:tag` 로 조회되지 않는 이미지는 `docker_images.py` 가 `rmi=` 에 이미지 ID 를 낸다. `docker rmi` 가 `No such image` 로 실패하던 문제다

## 1.7.0 (2026-10-19)

- `colima_trim.py` 를 더했다. Colima VM 디스크를 trim 하고 호스트 확보량을 재며, 덜 비워졌으면 시간을 두고 다시 돈다

## 1.6.0 (2026-10-19)

- `docker_images.py` 가 줄마다 `docker rmi` 에 그대로 넘길 `rmi=` 값과 이미지 ID 를 낸다
- `check_pr_branches.py` 를 더했다. `PR 확인 필요` 브랜치마다 최근 PR 과 원격에 없는 커밋 수로 지워도 되는지 판정을 보인다
- `alpha`, `beta` 브랜치를 유지로 둔다

## 1.5.0 (2026-10-15)

- `docker_volumes.py` 를 더했다. 익명 volume 에 생성 시각과 크기를 붙이고, 하루 안에 생긴 것은 후보에서 뺀다
- `delete_branches.py` 를 더했다. 조사 JSON 으로 브랜치를 지우며, 기본은 dry-run 이고 `--apply` 일 때만 지운다

## 1.4.0 (2026-10-12)

- Colima 가 꺼져 Docker 조사만 실패하면 Docker 항목을 건너뛰고 1단계를 통과한다
- `branch -d` 의 `not fully merged` 거절에서 멈추지 않고 `git-and-sessions.md` 의 절차로 처리한다

## 1.3.0 (2026-10-12)

- `~/.npm/_npx` 를 확인 필요 후보로 더했다. `npm cache clean` 은 `_cacache` 만 비운다
- `docker volume prune` 을 쓰지 않고, 조사 때 열어 본 volume 만 지운다
- `not fully merged` 로 거절된 브랜치는 끝 커밋이 조사 때와 같고 기준 브랜치에 들어 있을 때만 `-D` 로 지운다
- Docker 이미지 확보량을 「최대」 로 보인다. 남는 이미지와 레이어를 공유하면 실제 확보량이 작다

## 1.2.0 (2026-10-10)

- `survey_git.py` 가 브랜치와 워크트리의 끝 커밋을 보인다. 지우기 직전에 조사 때와 같은지 대조하는 데 쓴다
- 기준 브랜치가 아니어도 `main`, `master`, `develop` 을 유지로 둔다
- `--check-prs` 에서 `gh` 가 실패한 항목을 표시하고, `--gh-timeout` 으로 시간 한도를 정한다

## 1.1.0 (2026-10-08)

- `survey_git.py --check-prs` 를 더했다. squash 머지된 브랜치를 머지된 PR 의 끝 커밋과 대조해 찾는다
- 저장소의 stash 수를 모든 워크트리에 세어 워크트리가 모두 유지로 분류되던 문제를 고쳤다
- 대화 기록, 프로젝트 산출물, 반복 helper 의 정리 명령을 더했다

## 1.0.0 (2026-10-08)

- 스킬을 처음 만들었다. 디스크, 메모리, 스왑, 세션, 브랜치, 워크트리, Gradle, Docker 이미지를 읽기 전용으로 조사한다
