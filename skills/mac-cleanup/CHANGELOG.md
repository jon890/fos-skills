# CHANGELOG: mac-cleanup

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 2.1.1 (2026-11-12)

- 정리 후보 문서에서 표본 수치와 사고 기록을 지우고 도구 동작만 남겼다.
- 이미지 지우기와 브랜치 지우기의 세부 조건은 각 스크립트 설명을 가리키게 줄였다.

## 2.1.0 (2026-11-12)

- 컨테이너 런타임(Docker Desktop, Colima, OrbStack)을 감지해 런타임마다 켜짐 여부, context, VM 디스크 크기를 조사한다. 꺼진 런타임은 런타임마다 승인받아 켜고 조사한다
- 표에 없는 로컬 엔진은 「알 수 없는 런타임」 으로 조사와 정리만 하고, ssh·tcp 엔진은 크기만 보인다. `delete_volumes.ts` 와 이미지·빌드 캐시 삭제용 `docker_cleanup.ts` 는 맥 밖 엔진을 종료 코드 5 로 거부한다
- 이미지와 volume 조사·삭제가 `--context` 로 런타임을 나눈다. `runtime_reclaim.ts` 가 정리 뒤 VM 디스크를 런타임별로 회수한다(Colima 는 기존 fstrim 반복)
- 5단계 보고가 호스트 여유 전후(확보량), 런타임별 디스크 파일 전후(참고), 정리하지 않은 런타임을 따로 요구한다. 런타임별 값은 `references/runtimes.md` 가 소유한다
- `survey_system.ts` 의 Colima 전용 Docker 절을 `container_runtimes.ts` 로 옮겼다

## 2.0.0 (2026-11-08)

- 호환성: 스크립트 열하나(Python 열, 셸 하나)를 Node 24 의 `.ts` 로 바꿨다. `node "$SKILL_DIR/scripts/survey_system.ts"` 처럼 확장자만 바꿔 부른다. `survey_gradle.sh` 는 `survey_gradle.ts` 다
- 옵션, 출력, 쓰는 JSON 파일, 종료 코드는 그대로다. 조사 JSON 을 넘기는 `--json-out` 파일도 같은 바이트다
- `survey_gradle.ts` 는 버전 이름을 읽지 못한 `dists` 폴더를 삭제 후보에 올리지 않는다. 전에는 그런 폴더가 있으면 `~/.gradle/caches/` 와 `~/.gradle/daemon/` 전체를 지우는 `rm -rf` 줄을 냈다
- 옛 `python3 …/<이름>.py`, `bash …/survey_gradle.sh` 호출(허용 규칙 포함)은 새 이름으로 바꿔야 한다. Python 은 더 필요하지 않고 Node 24 이상이 필요하다

## 1.x

- 디스크, 메모리, 스왑, Docker, 도구 캐시, 대화 기록, 머지된 브랜치와 끝난 워크트리를 조사해 후보마다 크기와 등급을 붙이고, 사용자가 묶음별로 승인한 것만 정리한다
- 조사는 읽기 전용이고, 지우는 명령(`delete_branches`, `delete_sessions`, `delete_volumes`)은 기본이 dry-run 이며 지우기 직전에 tip, 경로, 수정 시각, dangling 여부를 다시 확인한다
- 익명 volume 은 내용을 열어 본 종류(`postgres`, `mysql`, `other`)로 나누고, Colima 에서 지운 뒤에는 `colima_trim` 으로 호스트 디스크를 되찾는다
- 설치 대기 업데이트가 든 updater 캐시, 실행 중인 mise 버전, 사용 중인 Codex 릴리스는 지우지 않고 유지로 보인다
- 워크트리가 사라진 Claude 대화 기록을 3일, 7일, 14일, 30일 묶음으로 세어 지우는 절차와 사용처가 없는 Gradle 버전을 한 줄 `rm -rf` 로 내는 절차를 더했다
