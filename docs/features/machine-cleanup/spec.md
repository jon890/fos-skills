# machine-cleanup: 맥 정리 스킬을 일반화해 홈서버 정리를 합친다

확인: 2026-11-21

## 목표

`mac-cleanup` 을 `machine-cleanup` 으로 바꿔, 한 스킬이 이 맥과 홈서버를 같은 절차(조사, 묶음별 승인, 승인한 것만 정리, 전후 보고)로 정리한다. 홈서버에서는 디스크와 메모리·스왑을 함께 보고, 맥에서 하던 머지된 브랜치, 끝난 워크트리, 에이전트 대화 기록 정리도 한다.

- 사용자 요청(2026-11-20): 「/fos-skills:mac-cleanup 스킬을 더 일반화해서. /homeserver-cleanup 을 통합시키고. 홈서버에도 적용해볼 수 있을까?」
- 지금 있는 것
  - `skills/mac-cleanup/`: macOS 의 디스크·메모리·스왑, 컨테이너 런타임, 오래된 에이전트 세션, 머지된 브랜치, 끝난 워크트리를 정리한다.
  - `fos-home-infra` 저장소의 `.claude/skills/homeserver-cleanup/`: 홈서버 디스크를 `ssh homeserver python3 - < survey.py` 로 조사하고, 소유자 표로 등급을 매겨 승인한 것만 지운다. 대상은 Docker 이미지, 백업 루트의 복구본, 휴지통, 도구 캐시, journal, snap, apt 다. 메모리·스왑은 대상이 아니다.
- 홈서버 상태(2026-11-20, 21 조사)
  - 디스크 915G 중 640G 여유, 메모리 27G 중 16G 여유, 스왑 4G 중 1.1G 사용, Node v24 설치. 같은 날 assistant-backend 메모리 한도를 768m 에서 1700m 로 올렸다(fos-home-infra PR 355).
  - `gh` 가 설치돼 로그인돼 있다. `orca` 명령은 Orca 앱이 아니라 화면 낭독기다.
  - Claude·Codex 대화 기록 폴더(`~/.claude/projects`, `~/.codex/sessions`)가 없다. 에이전트는 Hermes 이고, 세션은 컨테이너 `hermes` 안 SQLite(`/opt/data/sessions`, profile 별 `sessions/`, 합계 약 200K)에 있다. assistant 가 대화를 지우면 그 Hermes 세션도 지운다(fos-home-infra `docs/operations/hermes.md` 「대화 사본」 표).
  - git 저장소는 운영 checkout `/home/bifos/apps/fos-home-infra` 와 Hermes 가 읽는 `/home/bifos/fos-agents` 다. `fos-agents` 에는 빌드 스크립트가 만든 `/tmp/career-build-*` 워크트리 3개가 붙어 있다. fos-home-infra ADR-013 은 `fos-agents` 에서 브랜치를 옮기기만 해도 운영이 깨질 수 있다고 적는다.
- `mac-cleanup` 이름을 쓰는 곳: `.claude-plugin/plugin.json`, `README.md`, `docs/contributing.md`, `tsconfig.json`, `skills/orch/references/cleanup.md`, `skills/orch/scripts/lib/docker.ts`, `skills/orch/scripts/lib/claude-profile.ts`, 기능 문서(`docs/features/mac-cleanup-container-runtime/`, `docs/features/node-runtime/`, `docs/features/orch-cli/spec.md`), 개인 오버레이 `~/.claude/overlays/mac-cleanup.md`.

## 범위

- 대상 머신은 이 맥과 홈서버 둘로 고정한다. 머신을 등록하는 설정은 만들지 않는다.
- 홈서버에서 하는 일: homeserver-cleanup 의 디스크 대상 전부, 메모리·스왑 진단, 오버레이에 적힌 git 저장소의 머지된 브랜치와 끝난 워크트리, Claude·Codex 대화 기록과 Hermes 세션.
- 맥에서 하는 일은 지금과 같다. 맥 정리 중에 보이는 이 맥 밖의 docker 엔진은 지금처럼 크기만 보이고 지우지 않는다(`docs/features/mac-cleanup-container-runtime/spec.md` DECISION9).
- 범위 밖
  - 홈서버 컨테이너 재시작, 메모리 한도 변경. 제안으로만 보고한다.
  - 맥과 홈서버가 아닌 머신(회사 맥, 다른 리눅스 서버).
  - 맥 전용 대상(Xcode, mise, 컨테이너 런타임 VM 디스크 회수 등)을 홈서버로 넓히는 것.
  - 홈서버의 자동 정리(매일 정리, 보관 규칙, Hermes 요청 덤프 정리) 자체를 바꾸는 것. 놓친 것은 지금처럼 원인 수정만 제안한다.
  - `fos-agents` 의 브랜치와 워크트리를 지우는 것. 조사해 보고만 한다.
  - 옛 명령 `/fos-skills:mac-cleanup` 의 별칭.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 스킬을 `machine-cleanup` 이름으로 부른다. `mac-cleanup` 을 가리키던 매니페스트, README, orch 문서·주석, 기능 문서 링크가 새 이름을 가리킨다. 옛 명령은 남기지 않는다 | `/fos-skills:machine-cleanup` 으로 스킬이 뜨고, 매니페스트와 테스트가 새 경로를 쓴다. `git grep mac-cleanup` 에 남는 것은 변경 이력(CHANGELOG), 옛 기능 문서의 배경 서술, REQ2 의 옛 오버레이 경로뿐이다 |
| REQ2 | 개인 오버레이는 `~/.claude/overlays/machine-cleanup.md` 를 먼저 읽고, 없으면 옛 자리(`~/.claude/overlays/mac-cleanup.md`, `~/.claude/mac-cleanup-overlay.md`)를 읽는다 | 옛 자리에만 오버레이를 둔 가짜 홈에서 오버레이가 읽힌다는 것을 SKILL.md 절차와 테스트로 확인한다 |
| REQ3 | 정리할 머신을 요청으로 정한다. 홈서버를 말하거나 홈서버에만 있는 대상(백업, 복구본, journal, snap, apt, Hermes)을 말하면 홈서버, 「둘 다」 면 둘, 그 밖에는 이 맥이다. 둘 다면 머신마다 승인 묶음과 보고를 따로 둔다 | SKILL.md 가 이 경우들을 절차로 정한다. 「둘 다」 로 돌린 실행에서 승인 질문과 전후 표가 머신별로 나뉜다 |
| REQ4 | 이름을 바꾼 뒤에도 맥 정리의 조사, 분류, 승인, 실행, 보고가 지금과 같다 | 기존 mac-cleanup 테스트가 새 경로에서 모두 통과한다. 이 맥에서 조사 스크립트를 돌린 결과의 절과 수치 항목이 바꾸기 전과 같다 |
| REQ5 | 홈서버 조사는 정리 대상 파일, 이미지, 세션을 바꾸지 않는다. 바꾸는 것은 `git fetch --prune` 의 원격 ref 갱신뿐이고, 운영 checkout 의 fetch 는 운영 작업 잠금 아래에서 한다. 홈서버 checkout 을 갱신하지 않아도 이 맥에 설치된 스킬 번들의 스크립트로 돈다. 디스크 후보(이미지, 백업 복구본, 휴지통, 도구 캐시, journal, snap, apt), 메모리·스왑 진단, git 저장소의 브랜치와 워크트리, 대화 기록과 Hermes 세션을 절로 보인다 | 실제 홈서버에서 조사가 종료 코드 0 으로 끝나고 각 절이 나온다. Claude·Codex 기록이 없으면 「없음」 으로 나온다. 조사 전후로 홈서버의 파일 목록, 이미지 목록, Hermes 세션 목록이 같다 |
| REQ6 | 홈서버 등급은 지금 homeserver-cleanup 규칙을 따른다. 자동 정리가 소유한 것(유지 등급)은 지우지 않고, 규칙보다 많이 남았으면 원인을 판정해 원인 수정을 제안한다. 보관 규칙 표에 없는 백업 용도는 지울지와 함께 표에 올릴지 묻는다 | 유지 등급 표본과 규칙보다 많이 남은 표본을 둔 테스트(또는 조사 결과)에서 유지 항목이 승인 묶음에 오르지 않고 원인 판정 줄이 나온다. 표에 없는 용도는 「표에 올릴 용도」 로 보고에 남는다 |
| REQ7 | 홈서버 정리는 승인한 묶음만 한다. Docker 이미지, 백업 루트, 운영 checkout 의 브랜치·워크트리를 지울 때는 운영 작업 잠금을 잡는다. 잠금은 지금처럼 최대 300초 기다리고, 넘으면 지우지 않고 실패로 보고한다. 이미지는 지우기 직전에 컨테이너가 쓰는지 다시 보고, `docker image prune -a` 와 `docker system prune -a` 는 쓰지 않는다. sudo 가 필요한 명령은 스킬이 돌리지 않고 사용자에게 넘긴다 | 이미지·백업·브랜치·세션 삭제는 dry-run 으로 지울 목록을 먼저 보인다. 잠금을 다른 프로세스가 쥔 상태의 테스트에서 지우지 않고 실패로 끝난다. 쓰는 중인 이미지를 넘기면 남긴다. sudo 대상은 사용자 터미널용 명령으로만 나온다 |
| REQ8 | 홈서버 메모리·스왑은 진단만 하고 조치는 제안으로 남긴다. 여유 메모리, 스왑 사용량, 컨테이너별 메모리 사용량과 한도, 스왑을 많이 쓰는 프로세스를 보인다 | 조사 결과에 이 네 항목이 나온다. 보고의 메모리 절은 제안만 담고, 스킬이 컨테이너 재시작이나 한도 변경 명령을 돌리지 않는다 |
| REQ9 | 홈서버 git 저장소는 fos-home-infra 오버레이에 적힌 것만 조사한다. 머지된 브랜치(머지된 PR 조회 포함)와 끝난 워크트리를 맥과 같은 기준으로 고르고, 현재 받은 브랜치는 후보에 올리지 않는다. 워크트리가 쓰는 중인지는 그 워크트리 안에서 도는 프로세스로 확인하고, 있거나 확인하지 못하면 지우지 않는다. `fos-agents` 는 조사만 하고, 빌드 스크립트가 남긴 워크트리는 원인 수정 제안으로 보고한다 | 홈서버 조사에서 오버레이의 저장소마다 맥과 같은 판정이 나오고, 현재 브랜치는 후보에 없다. 워크트리 안에 프로세스를 띄운 테스트에서 그 워크트리가 후보에서 빠진다. `fos-agents` 항목은 승인 묶음에 오르지 않는다 |
| REQ10 | 홈서버의 Claude·Codex 대화 기록은 맥과 같은 세 기준(30일 지난 기록, 워크트리가 사라진 기록, 오래 떠 있는 에이전트 프로세스)으로 보인다. Hermes 세션은 30일 지난 것 가운데 assistant 대화에 연결되지 않은 것만 확인 필요 후보로 보이고, 고른 것만 Hermes 의 세션 삭제 명령으로 지운다 | Claude·Codex 기록이 없으면 「없음」 으로 끝난다. assistant 대화에 연결된 세션과 30일 안의 세션은 후보에 오르지 않는다. 지운 뒤 assistant 의 기존 대화 목록이 그대로다 |
| REQ11 | 홈서버에만 맞는 값(접속 이름, 백업 루트와 보관 규칙 표의 위치, 자동 정리가 소유한 이미지·경로 표, 운영 작업 잠금 경로, 운영 checkout 경로, 조사할 저장소 목록, Hermes 컨테이너 이름)은 fos-home-infra 저장소의 오버레이에 두고, 개인 오버레이가 그 저장소의 로컬 경로를 가리킨다. 스킬 본문에는 홈서버 고유 값을 적지 않는다 | fos-skills 의 스킬 문서와 스크립트에 `/opt/data/backup`, `bifos` 같은 홈서버 값이 없다. fos-home-infra 오버레이가 보관 규칙의 원본(`docs/data-schema.md` 「백업」 표)을 가리킨다 |
| REQ12 | 홈서버에 접속하지 못하거나, 홈서버 조사가 실패하거나, fos-home-infra 오버레이를 찾지 못하면 홈서버는 아무것도 지우지 않는다. 「둘 다」 면 맥은 끝까지 정리하고, 보고에 「홈서버 조사하지 못함」 과 원인, 고칠 곳을 적는다 | ssh 실패, 조사 실패, 오버레이 없음을 각각 흉내 낸 실행에서 홈서버 삭제 명령이 나가지 않고, 맥 보고와 함께 원인 줄이 나온다 |
| REQ13 | fos-home-infra 의 `homeserver-cleanup` 스킬을 지운다 | 그 저장소에 `.claude/skills/homeserver-cleanup/` 이 없고, 그 이름을 가리키는 문서가 새 스킬과 오버레이를 가리킨다 |
| REQ14 | 합친 스킬로 실제 홈서버를 조사하고, 사용자가 승인한 것만 정리해 전후 보고를 낸다 | 홈서버 적용 보고에 디스크 여유와 Docker 이미지 회수 가능량의 전후 표, 메모리 진단과 제안, 원인 수정 제안, 표에 올릴 백업 용도, 사용자가 직접 할 일이 있다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 홈서버에 적용하는 목적 | 디스크 정리 습관을 맥과 맞추고, 메모리·스왑 진단도 한다 | 사용자 2026-11-21 | 디스크는 여유가 많지만 같은 날 메모리 한도를 올렸고 스왑을 1.1G 쓴다 |
| DECISION2 | 대상 머신 | 이 맥과 홈서버 둘로 고정한다. 머신 등록 설정은 만들지 않는다 | 사용자 2026-11-21 | 다른 머신이 생길 예정이 없다 |
| DECISION3 | 홈서버로 넓힐 맥 전용 일 | 머지된 브랜치, 끝난 워크트리, 에이전트 대화 기록 | 사용자 2026-11-21 | 맥과 같은 습관으로 홈서버도 정리한다(DECISION1) |
| DECISION4 | 스킬 이름 | `machine-cleanup`. 「맥 정리」, 「홈서버 정리」 같은 말은 설명에 남긴다. 옛 명령은 남기지 않는다 | 사용자 2026-11-21 | 하는 일이 이름에 드러난다. `cleanup` 은 harness-cleanup, orch cleanup 과 헷갈린다. 이름을 바꾸면 옛 명령으로 부르지 못한다는 것을 알고 골랐다 |
| DECISION5 | homeserver-cleanup 처리 | 지운다. 홈서버 고유 값만 fos-home-infra 오버레이로 남긴다 | 사용자 2026-11-21 | 절차와 스크립트가 두 곳에서 따로 낡지 않는다 |
| DECISION6 | 홈서버 고유 규칙의 자리 | fos-home-infra 저장소의 오버레이. 개인 오버레이가 그 저장소의 로컬 경로를 가리킨다 | 사용자 2026-11-21 | 규칙의 원본(`docs/data-schema.md` 「백업」 표) 옆에서 함께 고치고 리뷰한다. 어느 저장소에서 스킬을 불러도 같게 돈다 |
| DECISION7 | PR 순서 | PR1(fos-skills): 이름 바꾸기와 머신 고르기 구조, 맥 동작은 그대로. PR2(fos-skills): 홈서버 조사·정리·메모리 진단. PR3(fos-home-infra): 오버레이 추가와 homeserver-cleanup 삭제. 그 뒤 홈서버 적용 | 사용자 2026-11-21 | PR 마다 리뷰가 작고, 맥 회귀를 PR1 에서 따로 확인한다 |
| DECISION8 | 홈서버 메모리·스왑 조치 | 진단과 제안만. 재시작과 한도 변경은 fos-home-infra 변경으로 한다 | 사용자 2026-11-21 | 컨테이너를 다시 띄우면 운영 서비스가 끊긴다 |
| DECISION9 | 홈서버 브랜치·워크트리 정리 기준 | 맥과 같은 기준. 현재 브랜치는 건드리지 않고, 운영 checkout 은 운영 작업 잠금을 잡고 지운다 | 사용자 2026-11-21 | 배포가 운영 checkout 을 쓰는 동안 지우지 않는다 |
| DECISION10 | 머신 고르기 | 홈서버를 말하면 홈서버, 「둘 다」 면 둘, 말이 없으면 이 맥 | 사용자 2026-11-21 | 지금 쓰는 방식(이 맥 정리)이 그대로 기본이다 |
| DECISION11 | 홈서버 Claude·Codex 기록 기준 | 맥과 같은 세 기준과 등급(확인 필요). 기록이 없으면 「없음」 | 사용자 2026-11-21 | 되돌릴 수 없는 기록이라 맥처럼 항목을 보이고 고른 것만 지운다 |
| DECISION12 | Hermes 세션 포함 | 넣는다 | 사용자 2026-11-21 | 홈서버에서 실제로 쌓이는 에이전트 기록은 Hermes 세션이다 |
| DECISION13 | Hermes 세션 후보 | 30일 지난 세션 가운데 assistant 대화에 연결되지 않은 것만. 확인 필요 등급으로 보이고 고른 것만 지운다 | 사용자 2026-11-21 | assistant 화면의 대화가 깨지지 않는다. 세션 전체가 약 200K 라 디스크 이득보다 정리가 목적이다 |
| DECISION14 | 홈서버 fetch 와 PR 조회 | 맥과 같이 한다. 운영 checkout 의 fetch 는 운영 작업 잠금 아래에서 한다 | 사용자 2026-11-21 | squash 로 머지된 브랜치도 후보가 된다. 홈서버 gh 가 로그인돼 있다 |
| DECISION15 | 홈서버 저장소 범위 | fos-home-infra 오버레이에 적힌 저장소만. `fos-agents` 는 조사만 하고, 빌드용 워크트리는 원인 수정을 제안한다 | 사용자 2026-11-21 | ADR-013: `fos-agents` 에서 브랜치를 옮기기만 해도 운영이 깨질 수 있다 |
| DECISION16 | 홈서버 워크트리 사용 확인 | Orca 대신 그 워크트리 안에서 도는 프로세스로 확인한다. 있거나 확인하지 못하면 지우지 않는다 | 사용자 2026-11-21 | 홈서버의 `orca` 는 화면 낭독기라 맥 규칙을 그대로 두면 하나도 지우지 못한다 |
| DECISION17 | 홈서버 전용 대상으로 머신 추론 | 백업, 복구본, journal, snap, apt, Hermes 를 말하면 홈서버로 본다 | 사용자 2026-11-21 | 지금 homeserver-cleanup 이 이 말들로 불린다. 이 대상은 맥에 없다 |
| DECISION18 | 홈서버 접속·조사 실패 | 홈서버는 지우지 않고, 「둘 다」 면 맥은 끝까지 정리한 뒤 원인과 고칠 곳을 보고한다. 오버레이가 없을 때도 같다 | 사용자 2026-11-21 | 한 머신의 접속 문제로 다른 머신의 정리를 버리지 않는다 |
| DECISION19 | 홈서버 등급과 삭제 규칙 | homeserver-cleanup 의 소유자 표, 표에 없는 백업 용도 처리, 운영 작업 잠금(최대 300초 대기), 지우기 직전 사용 확인, `prune -a` 금지, sudo 넘기기를 그대로 옮긴다 | 작성자 | fos-home-infra `.claude/skills/homeserver-cleanup/SKILL.md` 4단계와 `references/targets.md`. 배포가 만든 복구본을 지우는 사고를 막으려고 정한 규칙이다 |
| DECISION20 | 홈서버 스크립트 실행 방식 | 홈서버 checkout 을 갱신하지 않고 이 맥의 스킬 번들 스크립트를 ssh 로 돌린다 | 작성자 | 지금 homeserver-cleanup 이 같은 성질을 지킨다(`ssh homeserver python3 - < survey.py`). 홈서버에 Node v24 가 있다. 구체적인 전달 방식은 technical-design 이 정한다 |
| DECISION21 | 개인 오버레이 이름 | 새 이름을 먼저 읽고, 없으면 옛 자리를 읽는다. 옛 경로는 REQ1 의 남는 이름에 넣는다 | 작성자 | 지금 SKILL.md 가 옛 자리 `~/.claude/mac-cleanup-overlay.md` 를 같은 방식으로 읽는다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 스킬 하나의 절차와 스크립트, 오버레이 자리만 바뀐다. 홈서버 백업 보관 규칙의 원본(fos-home-infra `docs/data-schema.md`)과 Hermes 보존 규칙(`scripts/hermes/hermes-retention.sh`)은 그대로다.
