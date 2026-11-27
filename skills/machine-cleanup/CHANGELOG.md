# CHANGELOG: machine-cleanup
버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 fos-skills 저장소 `docs/contributing.md` 의 "버전과 변경 이력" 을 따른다.

## 0.4.0 (2026-11-27)

- 외부 공개 전 버전 체계에 맞춰 번호를 0.x로 바꿨어요.

## 3.2.0 (2026-11-26)

- 홈서버의 「명시적 정리로 최신 N개」 백업을 `hs_delete.ts backup --keep N` 으로 지워 최신 N개를 남긴다. 지우기 직전에 보관 규칙 표를 다시 읽어 개수가 없거나 모자라면 폴더째 지우지 않는다
- 홈서버 조사가 홈 아래 큰 폴더와 실패한 작업이 남긴 사본(`.failed-*`, `*.bak`, `*-backup`)을 확인 필요로 보이고, 정리 전 수치에 상위 폴더 크기를 남긴다

## 3.1.0 (2026-11-21)

- 홈서버를 정리한다. 이 맥에서 ssh 로 스크립트를 보내 디스크 후보(Docker 이미지, 백업 복구본, 휴지통, 도구 캐시, journal, snap, apt), 메모리와 스왑, git 저장소, 대화 기록, Hermes 세션을 조사한다
- 홈서버 후보는 fos-home-infra 오버레이의 소유자 표로 등급을 매기고, 자동 정리가 놓친 것은 원인 수정을, 표에 없는 백업 용도는 표에 올릴지를 함께 묻는다
- 홈서버 삭제는 dry-run 을 먼저 보이고 항목마다 지우기 직전에 다시 확인한다. 이미지, 백업, 운영 checkout 은 운영 작업 잠금 아래에서 지우고 sudo 와 메모리 조치는 제안만 한다
- Hermes 세션은 30일 지났고 assistant 대화에 연결되지 않은 트리만 출처별로 물어 지운다. DB 공간 회수는 사용자 할 일로 보고한다. 맥의 머지된 브랜치(-d)는 끝 커밋이 조사 때와 같을 때만 지운다
- 오버레이가 없거나 접속, 조사가 실패하면 홈서버는 지우지 않고, 필수 조사가 실패한 범주는 실행 차단으로 멈춘다. 「둘 다」 면 이 맥은 끝까지 정리한다

## 3.0.0 (2026-11-21)

- 호환성: 스킬 이름을 `mac-cleanup` 에서 `machine-cleanup` 으로 바꿨다. `/fos-skills:machine-cleanup` 으로 부르고, 옛 명령 `/fos-skills:mac-cleanup` 은 남기지 않는다
- 호환성: 번들 경로가 `skills/machine-cleanup/` 으로 바뀌었다. 링크로 설치했으면 `~/.claude/skills/mac-cleanup` 링크를 새 경로로 다시 건다
- 개인 오버레이를 `~/.claude/overlays/machine-cleanup.md` 에서 먼저 읽고, 없으면 옛 자리 `overlays/mac-cleanup.md`, `mac-cleanup-overlay.md` 를 차례로 읽는다. 자리에 있는 것을 읽지 못하면 멈춘다
- 정리할 머신을 요청에서 고른다. 홈서버만 말하면 아직 지원하지 않는다고 알리고 끝낸다. 「둘 다」 면 홈서버는 같은 안내를 남기고 이 맥만 정리한다

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
