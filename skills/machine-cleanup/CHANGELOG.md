# CHANGELOG: machine-cleanup
버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 fos-skills 저장소 `docs/contributing.md` 의 "버전과 변경 이력" 을 따른다.

## 3.0.0 (2026-11-21)

- 호환성: 스킬 이름을 `mac-cleanup` 에서 `machine-cleanup` 으로 바꿨다. `/fos-skills:machine-cleanup` 으로 부르고, 옛 명령 `/fos-skills:mac-cleanup` 은 남기지 않는다
- 호환성: 번들 경로가 `skills/machine-cleanup/` 으로 바뀌었다. 링크로 설치했으면 `~/.claude/skills/mac-cleanup` 링크를 새 경로로 다시 건다
- 개인 오버레이를 `~/.claude/overlays/machine-cleanup.md` 에서 먼저 읽고, 없으면 옛 자리 `overlays/mac-cleanup.md`, `mac-cleanup-overlay.md` 를 차례로 읽는다
- 정리할 머신을 요청에서 고른다. 홈서버나 「둘 다」 를 말하면 홈서버는 아직 지원하지 않는다고 알리고 이 맥만 정리한다

## 2.x

- 컨테이너 런타임(Docker Desktop, Colima, OrbStack)을 감지해 런타임마다 조사하고, 꺼진 런타임은 승인받아 켠다
- 표에 없는 로컬 엔진은 조사와 정리만 하고, ssh·tcp 엔진은 크기만 보이며 삭제 스크립트가 종료 코드 5 로 거부한다
- 이미지와 volume 조사·삭제가 `--context` 로 런타임을 나누고, `runtime_reclaim.ts` 가 정리 뒤 VM 디스크를 회수한다
- 이미지 조사 결과를 파일로 남기고 `docker_cleanup.ts rmi --images-json` 이 그 목록을 지운다
- `builder-prune` 의 시간 제한을 1800초로 늘렸다
- 개인 오버레이를 `~/.claude/overlays/mac-cleanup.md` 에서 읽고, 없으면 옛 자리 `~/.claude/mac-cleanup-overlay.md` 를 읽는다
- 호환성: 스크립트를 Node 24 의 `.ts` 로 바꿨다. 옵션, 출력, JSON 파일, 종료 코드는 그대로다

## 1.x

- 디스크, 메모리, 스왑, Docker, 도구 캐시, 대화 기록, 머지된 브랜치와 끝난 워크트리를 조사해 후보마다 크기와 등급을 붙이고, 사용자가 묶음별로 승인한 것만 정리한다
- 조사는 읽기 전용이고, 지우는 명령(`delete_branches`, `delete_sessions`, `delete_volumes`)은 기본이 dry-run 이며 지우기 직전에 tip, 경로, 수정 시각, dangling 여부를 다시 확인한다
- 익명 volume 은 내용을 열어 본 종류(`postgres`, `mysql`, `other`)로 나누고, Colima 에서 지운 뒤에는 `colima_trim` 으로 호스트 디스크를 되찾는다
- 설치 대기 업데이트가 든 updater 캐시, 실행 중인 mise 버전, 사용 중인 Codex 릴리스는 지우지 않고 유지로 보인다
- 워크트리가 사라진 Claude 대화 기록을 3일, 7일, 14일, 30일 묶음으로 세어 지우는 절차와 사용처가 없는 Gradle 버전을 한 줄 `rm -rf` 로 내는 절차를 더했다
