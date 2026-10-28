# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

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
