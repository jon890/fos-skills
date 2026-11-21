# machine-cleanup 기술 설계

스펙: [spec.md](spec.md). 코드는 `skills/machine-cleanup/` 아래이고, 홈서버 고유 값은 fos-home-infra 저장소의 오버레이에 둔다.
PR 은 스펙 DECISION7 대로 셋이다. PR1 은 이름 바꾸기와 머신 고르기 구조, PR2 는 홈서버 조사·정리·메모리 진단, PR3 은 fos-home-infra 오버레이 추가와 `homeserver-cleanup` 삭제다.
스킬 하나 안의 변경이라 새 서비스나 ADR 은 없다.

## 요구사항 연결

| ID | PR | 해결 방법 |
| --- | --- | --- |
| REQ1 | PR1 | `git mv skills/mac-cleanup skills/machine-cleanup`. 두 매니페스트, 루트 README 표, `docs/contributing.md`, `tsconfig.json`, `scripts/runtime-policy.json`, orch 의 주석·문서·테스트 이름, `skills/browser/browser-driver/driver/pylike.ts` 의 주석, 옛 기능 문서의 파일 경로를 새 이름으로 바꾼다. 스킬 major 를 올리고 CHANGELOG 에 옛 이름을 적는다 |
| REQ2 | PR1 | 새 스크립트 `overlay_path.ts` 가 세 자리를 순서대로 보고 처음 있는 파일 경로를 낸다. SKILL.md 「개인 오버레이」 가 이 스크립트를 부르고, 테스트가 가짜 홈으로 순서를 확인한다 |
| REQ3 | PR1(고르기), PR2(홈서버 절차) | SKILL.md 에 단계 앞 절 「머신 고르기」 를 둔다. 홈서버 판정 낱말과 「둘 다」 를 절차로 적고, 둘이면 머신마다 1~5단계를 따로 돈다. PR1 은 홈서버를 고르면 조사하지 않고 「아직 지원하지 않음」 으로 막고 맥만 돈다 |
| REQ4 | PR1 | 스크립트와 references 는 경로만 옮기고 내용을 바꾸지 않는다. 기존 테스트를 새 경로에서 돌리고, 바꾸기 전후 이 맥의 조사 출력의 절과 수치 항목을 비교한다. PR2 가 맥 스크립트의 판정을 공용 모듈로 옮기면 그 PR 에서 같은 비교를 다시 한다 |
| REQ5 | PR2 | 홈서버 스크립트를 이 맥의 번들에서 ssh 로 보내 돌린다(「홈서버 실행 방식」). 조사는 읽기 전용이고 `git fetch --prune` 만 원격 ref 를 바꾼다. 운영 checkout 의 fetch 는 운영 작업 잠금 아래에서 하고, 잠금을 300초 안에 못 잡으면 그 저장소의 fetch 만 건너뛰고 「fetch 하지 못함」 을 표시한다 |
| REQ6 | PR2 | 등급 규칙은 `homeserver-cleanup` 의 `references/targets.md` 를 옮긴 `references/homeserver-targets.md` 가, 등급 매기기는 이 맥에서 도는 `hs_classify.ts` 가 맡는다. 자동 정리가 소유한 이미지·경로 표와 매일 정리 시각은 오버레이 값이다 |
| REQ7 | PR2 | 삭제 스크립트가 dry-run 을 기본으로 하고 `--apply` 에서만 지운다. 잠금은 `remote.ts` 가 스크립트 실행 전체를 `flock -w 300` 으로 감싸 잡고, 넘으면 스크립트를 돌리지 않고 실패로 끝난다. sudo 대상은 사용자 터미널용 명령 문자열만 낸다 |
| REQ8 | PR2 | `hs_survey.ts` 의 메모리 절이 `/proc/meminfo` 의 여유 메모리와 스왑 사용량, `docker stats --no-stream` 의 컨테이너별 사용량, `docker inspect` 의 한도, `/proc/*/status` 의 `VmSwap` 상위를 보인다. 조치 명령은 내지 않는다 |
| REQ9 | PR2 | 맥의 `survey_git.ts` 분류 함수를 orca 없이 부를 수 있는 공용 모듈로 빼서 홈서버 조사가 같은 판정을 쓴다. 저장소 목록과 「조사만」 표시는 오버레이가 준다. 워크트리 사용 확인은 「홈서버 워크트리 사용 확인」 을 따른다 |
| REQ10 | PR2 | Claude·Codex 기록은 맥의 `survey_sessions.ts` 판정을 공용 모듈로 빼서 홈서버 홈에 쓴다. Hermes 세션은 「Hermes 세션 판정」 으로 고른다 |
| REQ11 | PR2, PR3 | 개인 오버레이에 `fos-home-infra 오버레이: <로컬 경로>` 한 줄을 두고, 그 파일(`.claude/machine-cleanup-overlay.md`)이 홈서버 값을 갖는다. 이 맥의 `hs_overlay.ts` 가 읽고 검사한다. 스킬 테스트가 홈서버 고유 문자열이 스킬에 없는지 본다 |
| REQ12 | PR2 | 홈서버 단계 앞에서 `hs_overlay.ts` 와 접속 확인을 돌린다. 하나라도 실패하면 홈서버 삭제 단계로 가지 않고 보고에 원인과 고칠 곳을 적는다. 「둘 다」 면 맥 절차는 계속 돈다 |
| REQ13 | PR3 | fos-home-infra 에서 `.claude/skills/homeserver-cleanup/` 과 그 스크립트를 부르는 `tests/unit/homeserver-cleanup.test.py` 를 지우고, 그 이름을 가리키는 문서를 새 스킬과 오버레이로 바꾼다 |
| REQ14 | PR2, PR3 뒤 | 두 PR 이 머지된 뒤 실제 홈서버에 적용하고 보고한다. 코드 변경이 아니라 운영 확인이다 |

## 책임과 경계

Java 로 빗대면 SKILL.md 는 공통 템플릿 메서드(조사, 분류, 승인, 실행, 보고)이고, 머신마다 단계별 구현을 references 와 scripts 가 맡는다.

| 모듈 | 책임 | 소유하는 값 | 도는 곳 | PR |
| --- | --- | --- | --- | --- |
| `SKILL.md` | 머신 고르기, 오버레이 읽기, 다섯 단계의 공통 통과 조건, 「둘 다」 의 순서와 분리 | 머신 판정 낱말, 단계 표 | | PR1 |
| `scripts/overlay_path.ts` | 개인 오버레이 자리 고르기 | 새 자리와 옛 자리 두 곳, 읽는 순서 | 맥 | PR1 |
| 기존 맥 스크립트와 `references/{targets,runtimes,git-and-sessions}.md` | 맥 조사·정리 | 기존 출력 계약 | 맥 | PR1(경로만) |
| `references/homeserver.md` | 홈서버의 1~5단계 명령과 규칙 | 접속 확인, 실패 처리, 홈서버 보고 꼴 | | PR2 |
| `references/homeserver-targets.md` | 홈서버 등급 규칙(소유자에서 등급, 자동 정리가 놓친 것, 표에 없는 용도) | 규칙. 경로와 이미지 이름 같은 값은 갖지 않는다 | | PR2 |
| `scripts/hs_overlay.ts` | 개인 오버레이에서 fos-home-infra 오버레이를 찾아 읽고 값을 검사 | 오버레이 형식의 검사 | 맥 | PR2 |
| `scripts/remote.ts` | 홈서버로 스크립트를 보내 돌리고 결과를 돌려받기, 잠금 감싸기 | 전달 방식, 잠금 대기 300초 | 맥 | PR2 |
| `scripts/hs_*.ts`(조사, 삭제) | 홈서버에서 도는 조사와 삭제 | dry-run 기본, 지우기 직전 재확인 | 홈서버 | PR2 |
| `scripts/hs_classify.ts` | 조사 JSON 과 오버레이 값으로 등급과 원인 판정 | 등급 매기기 | 맥 | PR2 |
| fos-home-infra `.claude/machine-cleanup-overlay.md` | 홈서버 고유 값 | 아래 「fos-home-infra 오버레이」 | | PR3 |

의존 방향은 SKILL.md, references, scripts 순이다.
홈서버에서 도는 `hs_*.ts` 는 맥 전용 모듈(`container_runtimes.ts`, orca 를 부르는 코드)을 import 하지 않는다. PR2 가 공용으로 쓸 판정(브랜치 분류, 기록 경과일)을 `scripts/lib/` 로 옮길 때 맥 스크립트도 그 모듈을 쓰게 바꾸고, 맥 테스트 전체와 REQ4 의 조사 출력 비교를 다시 돈다.
**홈서버 쪽 코드는 `orca` 를 부르지 않는다.** 홈서버의 `orca` 는 화면 낭독기다. 공용 판정 함수는 orca 정보를 인자로 받고, 홈서버 쪽은 빈 값을 넘긴다. 테스트가 `hs_*.ts` 의 import 를 따라가 맥 전용 모듈과 `orca` 호출이 없는지 본다.

### 머신 고르기

SKILL.md 의 「머신 고르기」 절이 소유한다. 판정 순서는 이렇다.

1. 요청에 「둘 다」, 「맥과 홈서버」 처럼 두 머신을 함께 말하면 둘이다.
2. 요청에 홈서버를 말하거나 홈서버에만 있는 대상(백업, 복구본, journal, snap, apt, Hermes)을 말하면 홈서버다.
3. 그 밖은 이 맥이다.

둘이면 맥을 먼저 1~5단계까지 끝내고 홈서버를 돈다. 승인 질문과 전후 표는 머신 이름을 붙여 머신마다 따로 둔다.
PR1 에서는 홈서버를 고르면 조사하지 않고 「홈서버 정리는 아직 지원하지 않는다」 를 보고한다. 「둘 다」 면 맥만 돌고 보고에 같은 줄을 남긴다.
스킬 설명(description)의 홈서버 낱말은 PR2 에서 넣는다. PR1 에서 넣으면 아직 남아 있는 `homeserver-cleanup` 의 요청을 가져와 막게 된다.

### 홈서버 실행 방식 (DECISION20)

`homeserver-cleanup` 은 Python 한 파일을 `ssh homeserver python3 - < survey.py` 로 보냈다. 이 저장소의 스크립트는 Node 24 의 `.ts` 이고 서로 import 하므로 표준 입력 한 파일로는 보낼 수 없다.

`scripts/remote.ts` 가 아래를 한 ssh 호출로 한다.

1. 돌릴 스크립트에서 import 를 따라간 파일 전부와, 넘길 입력 파일(`--input`)을 tar 로 묶어 표준 입력으로 보낸다.
2. 홈서버에서 `mktemp -d` 폴더에 풀고 스크립트를 돌린다. `--lock` 을 주면 `flock -E 75 -w 300 <잠금> env FOS_INFRA_LOCK_HELD=1 node ...` 로 실행 전체를 감싼다. 끝나면 `trap` 으로 그 폴더를 지운다. 홈서버 스크립트는 종료 코드 75 를 쓰지 않는다.
3. 스크립트의 표준 출력과 종료 코드를 그대로 돌려준다. 조사 JSON 은 스크립트가 `--json` 으로 표준 출력에 내고 `remote.ts --json-out LOCAL` 이 이 맥의 파일로 받는다. 삭제할 때는 그 파일을 `--input` 으로 다시 보낸다.
4. ssh 자체가 실패하면(종료 코드 255) 접속 실패로, 잠금을 못 잡으면(flock 의 전용 종료 코드 75, 스크립트는 돌지 않음) 잠금 실패로 따로 알린다. 스크립트 자신의 실패(1 등)와 겹치지 않는다.

조사 중 운영 checkout 의 fetch 는 `remote.ts --lock` 을 쓰지 않는다. `hs_survey.ts` 가 그 저장소의 fetch 한 번만 `flock -E 75 -w 300 <잠금> git fetch --prune` 으로 감싸고, 75 면 그 저장소의 fetch 만 건너뛴다.

잠금을 스크립트 실행 전체에 거는 이유: 지우기 직전의 사용 확인(이미지를 쓰는 컨테이너, 워크트리 안의 프로세스)과 실제 삭제가 같은 잠금 안에서 일어나야 배포와 엇갈리지 않는다. Node 에는 flock API 가 없어 스크립트 안에서 잡기보다 바깥에서 감싼다.
고른 이유: 홈서버 checkout 을 갱신하지 않아도 이 맥의 번들로 돈다(REQ5). 홈서버에 파일을 남기지 않는다. npm 패키지를 쓰지 않는 스크립트만 보내므로 홈서버에서 `npm install` 이 필요 없다.
버린 대안: 스크립트를 한 파일로 묶는 번들러는 새 빌드 단계와 의존이 생긴다. 홈서버 checkout 에 스크립트를 두는 방식은 REQ5 를 어긴다.

### fos-home-infra 오버레이 (DECISION6, REQ11)

개인 오버레이(`~/.claude/overlays/machine-cleanup.md`)는 맥의 예외와 함께 아래 한 줄을 둔다.

```markdown
fos-home-infra 오버레이: ~/personal/fos-home-infra/.claude/machine-cleanup-overlay.md
```

그 파일은 사람이 읽는 설명과 함께 ```` ```json ```` 코드 블록 하나에 값을 둔다. `hs_overlay.ts` 가 블록을 읽어 키와 형식을 검사하고, 값을 `hs_*.ts` 의 인자나 입력 파일로 넘긴다. 스크립트 안에 홈서버 값을 기본값으로 두지 않는다.
키 이름과 형식은 PR2 가 `hs_overlay.ts` 의 머리 주석과 테스트로 정하고, PR3 이 그 형식으로 파일을 쓴다. 담을 값은 이렇다.

| 값 | 쓰는 곳 |
| --- | --- |
| 접속 이름(ssh 호스트) | `remote.ts` |
| 백업 루트와 보관 규칙 표의 위치(`docs/data-schema.md` 「백업」) | 백업 조사와 등급. 표는 홈서버 운영 checkout 의 사본을 `hs_survey.ts` 가 읽어 조사 JSON 에 넣는다. 지금 운영 중인 규칙이 기준이다 |
| 자동 정리가 소유한 이미지·경로 표, 매일 정리 시각 | 유지 등급, 원인 판정 |
| 설정이 가리키는 이미지를 찾는 자리(Compose `image`, Dockerfile `FROM`, settings `image` 를 읽을 파일 glob)와 내용 해시로 태그를 정하는 이미지(이름, 해시할 파일 목록, 해시 길이) | 「설정이 가리킴」 판정. 읽는 코드는 스킬이, 자리는 오버레이가 갖는다 |
| 운영 작업 잠금 경로, 운영 checkout 경로 | 잠금, 설정 판정, 저장소 조사 |
| 조사할 저장소 목록과 「조사만」 표시, 빌드 스크립트가 만드는 워크트리 경로 패턴 | 브랜치·워크트리 조사(`fos-agents` 는 조사만, 빌드 워크트리는 원인 수정 제안) |
| Hermes 컨테이너 이름, profile 데이터 자리, 세션 삭제 명령(argv 배열) | Hermes 세션 조사와 삭제 |
| assistant 연결 세션 조회 명령(argv 배열) | Hermes 세션 판정 |

명령 값은 셸 문자열이 아니라 argv 배열이다. 세션 id 같은 값은 배열 끝에 인자로 붙여 셸 해석을 거치지 않는다.
자격 증명은 오버레이에 두지 않는다. 조회 명령은 컨테이너 안에서 그 컨테이너의 환경 변수로 인증하는 꼴(`docker exec <컨테이너> ...`)로 적는다.
오버레이를 찾지 못하거나 검사를 통과하지 못하면 REQ12 대로 홈서버는 조사도 삭제도 하지 않는다.

### 홈서버 워크트리 사용 확인 (DECISION16)

`/proc/<pid>/cwd` 가 그 워크트리 아래인 프로세스가 있으면 쓰는 중이다.
확인 대상은 워크트리 소유자와 같은 uid 의 프로세스다. 일반 사용자는 다른 uid 의 cwd 를 읽지 못하고, 다른 사용자의 프로세스는 이 사용자 홈의 워크트리에서 작업하지 않는다.
같은 uid 인데 cwd 를 읽지 못한 프로세스가 있으면 「확인하지 못함」 으로 후보에서 뺀다. 삭제 스크립트는 지우기 직전 같은 잠금 안에서 다시 확인한다.

### 등급 매기기 (REQ6)

`hs_classify.ts` 가 이 맥에서 조사 JSON 과 오버레이 값을 받아 후보마다 소유자, 등급, 이유를 붙인다.
유지 등급인데 규칙보다 많이 남은 것은 항목 시각을 오버레이의 매일 정리 시각과 비교해 `정상(마지막 매일 정리 뒤에 생김)` 이나 `원인 확인 필요: <용도>` 로 표시한다. 원인 스크립트를 찾는 판단은 `homeserver-targets.md` 의 절차대로 에이전트가 한다.
보관 규칙 표에 없는 백업 용도는 「표에 올릴 용도」 로 따로 낸다. 에이전트는 이 결과로 승인 묶음을 만들고 유지 등급은 묶음에 넣지 않는다.

### Hermes 세션 판정 (REQ10)

assistant 는 대화마다 Hermes 세션 id 와 루트 세션 id 를 저장하고, 실행 기록에도 profile 과 세션 id 를 적는다(fos-assistant `Conversation.hermesSessionId`, `hermesRootSessionId`, `AgentExecution.hermesSessionId`). 대화를 지우면 이 세션들을 Hermes API 로 함께 지운다.

후보 판정은 이렇다.

1. Hermes profile 마다 SQLite `sessions` 테이블에서 id, 부모 세션 id, 마지막 활동 시각, 출처를 읽는다. 읽기 전용으로 연다.
2. 오버레이의 「assistant 연결 세션 조회 명령」 이 대화의 세션 id, 루트 id, 실행 기록의 (profile, 세션 id) 를 한 줄에 하나씩 낸다. 삭제 표시만 되고 아직 정리(purge)되지 않은 대화도 넣는다. 정리 작업이 그 세션을 지울 차례를 기다리는 중이다.
3. 부모·자식 관계로 이어진 세션 묶음(트리) 단위로 본다. 트리 안의 세션 하나라도 2의 목록에 있거나 30일 안에 활동했으면 트리 전체를 후보에서 뺀다. Hermes 가 부모를 지우면 자식도 함께 지울 수 있어서다.
4. 남은 트리의 루트만 「확인 필요」 후보로, 출처(assistant, Discord, cron 등)와 함께 보인다.

2의 조회가 실패하면 Hermes 후보를 하나도 내지 않는다. 연결을 확인하지 못한 세션을 지우면 assistant 화면의 대화가 깨진다.
삭제는 오버레이의 세션 삭제 명령으로 고른 루트 하나씩 한다. 지운 뒤 2의 목록에 있는 세션이 Hermes SQLite 에 모두 남아 있는지 확인해 보고에 적는다(REQ10 의 「assistant 의 기존 대화 목록이 그대로다」).

### PR2 사전 확인

PR2 의 첫 작업은 아래 읽기 전용 확인을 코디네이터에게 맡기는 것이다. worker 는 홈서버에 직접 ssh 하지 않는다.

- `node --version` 과 `node -e 'console.log(process.features.typescript)'`(형식 제거 지원)
- `flock` 위치, `ps` 와 `lsof` 의 Linux 출력 꼴(맥 판정 함수가 그대로 쓸 수 있는지)
- Hermes 컨테이너 안의 `sqlite3` 나 python 유무, profile `sessions` 폴더의 소유자와 권한, `sessions` 테이블 스키마(부모 id, 활동 시각, 출처 컬럼 이름), 세션 삭제 명령의 사용법
- assistant DB 조회를 컨테이너 환경 변수로 인증해 돌릴 수 있는지

PR2 의 실제 홈서버 조사는 PR3 전이라 오버레이가 저장소에 없다. 같은 형식의 임시 오버레이를 이 맥에 두고 `hs_overlay.ts --overlay` 로 넘겨 돌린다. PR3 은 그 내용을 fos-home-infra 에 커밋한다.

## 인터페이스와 데이터

PR1 이 더하는 것은 `overlay_path.ts` 하나다.

- 사용법: `node "$SKILL_DIR/scripts/overlay_path.ts"`. 인자는 없다. `HOME` 아래에서 찾는다.
- 찾는 순서: `~/.claude/overlays/machine-cleanup.md`, `~/.claude/overlays/mac-cleanup.md`, `~/.claude/mac-cleanup-overlay.md`.
- 출력: 처음 있는 파일의 절대경로 한 줄. 옛 자리면 표준 오류에 새 자리로 옮기라는 한 줄을 낸다.
- 종료 코드: 0 찾음, 1 없음(코어 기본값으로 진행), 2 사용법 오류.

기존 스크립트의 옵션, 출력, JSON 파일, 종료 코드는 바뀌지 않는다. 경로만 `skills/mac-cleanup/scripts/` 에서 `skills/machine-cleanup/scripts/` 로 간다.
PR2 의 `hs_*.ts` 와 `remote.ts`, `hs_overlay.ts` 의 출력 계약은 PR2 의 계획이 정한다. 위 「홈서버 실행 방식」 의 왕복(조사 JSON 을 이 맥 파일로 받고 삭제 때 다시 보냄)을 지킨다.

## 실패와 일관성

- 이름 바꾸기는 한 PR 안에서 매니페스트와 폴더를 함께 바꾼다. 둘이 어긋나면 `node scripts/run-tests.ts scripts/tests` 의 매니페스트 검사가 실패한다.
- 옛 명령 `/fos-skills:mac-cleanup` 은 남기지 않는다(스펙 DECISION4). CHANGELOG 의 `호환성:` 항목이 이를 알린다.
- 개인 오버레이 파일은 옮기지 않는다. 옛 자리를 계속 읽으므로 사용자가 옮기기 전에도 같게 돈다. 그래서 「옛 자리는 다음 major 에서 읽기를 끝낸다」 문장은 지운다(스펙 DECISION21).
- 홈서버 쪽(PR2): 접속, 오버레이, 조사 가운데 하나가 실패하면 홈서버 단계 전체를 건너뛴다. 삭제 실행이 잠금을 300초 안에 못 잡으면 아무것도 지우지 않고 실패로 보고한다. 조사 중 fetch 의 잠금 실패는 그 저장소의 fetch 만 건너뛴다(조사는 읽기라 낡은 ref 로 판정해도 지우는 쪽이 지우기 직전 다시 본다). 부분 실패는 명령마다 종료 코드로 보고한다.
- 배포 순서: PR1, PR2, PR3. PR3 이 `homeserver-cleanup` 을 지우기 전에 PR2 의 홈서버 지원이 main 에 있어야 홈서버 정리가 끊기지 않는다.

## 검증 전략

| 요구사항 | 확인하는 곳 |
| --- | --- |
| REQ1 | `node scripts/run-tests.ts scripts/tests`(매니페스트와 README 검사), `git grep mac-cleanup` 의 남은 줄이 변경 이력, 옛 기능 문서의 배경 서술, 이 기능의 문서(`docs/features/machine-cleanup/`), 옛 오버레이 경로뿐인지 |
| REQ2 | `overlay_path.ts` 명령 경계 테스트. 임시 홈에 세 자리를 조합해 두고 출력 경로와 종료 코드를 본다. SKILL.md 가 이 스크립트를 부르는지 문서 테스트로 본다 |
| REQ3 | SKILL.md 「머신 고르기」 절의 문서 테스트(판정 낱말, 「둘 다」 의 머신별 분리, PR1 의 홈서버 막기). 실제 「둘 다」 실행의 머신별 승인 질문은 REQ14 에서 본다 |
| REQ4 | 기존 테스트 전부를 새 경로에서, 이 맥에서 조사 스크립트 여섯 개를 바꾸기 전후로 돌려 절 제목과 수치 항목 이름이 같은지 비교. 삭제 명령은 돌리지 않는다 |
| REQ5~REQ10 | PR2. 가짜 `ssh`, `docker`, `flock`, `sqlite3` 와 임시 홈으로 명령 경계 테스트를 하고, `homeserver-cleanup.test.py` 의 판정 사례(이미지 이름 풀기, 설정 이미지, 백업 규칙)를 옮긴다. 실제 홈서버 조사는 코디네이터가 임시 오버레이로 돌린다 |
| REQ11 | PR2. 스킬 폴더(tests 제외)에 홈서버 고유 문자열(백업 루트 경로, 사용자 이름)이 없는지 테스트한다. 금지 문자열 목록은 스킬 폴더 밖 `scripts/tests/` 에 둔다 |
| REQ12 | PR2. 접속 실패(ssh 255), 조사 실패, 오버레이 없음, 잠금 실패를 흉내 낸 테스트 |
| REQ13 | PR3. fos-home-infra 에서 `git grep homeserver-cleanup` 과 그 저장소 테스트 |
| REQ14 | PR2, PR3 머지 뒤 실제 적용 보고 |

## 결정

되돌리기 쉬운 기술 판단은 권장안으로 정했다. 사용자 결정은 스펙의 결정 표가 원본이다.

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 머신 고르기 자리 | 단계 표 앞의 번호 없는 절. 맥 단계 번호는 그대로 둔다 | 작성자 | 오버레이 읽기와 같은 사전 절차다. 단계 번호를 다시 매기면 references 와 테스트가 가리키는 「N단계」 가 모두 바뀌어 REQ4 비교가 흐려진다 |
| DECISION2 | 개인 오버레이 고르기 | 문서 문장 대신 `overlay_path.ts` | 작성자 | 세 자리의 순서를 테스트로 확인할 수 있다(REQ2). 에이전트가 자리를 하나 빠뜨리는 일을 막는다 |
| DECISION3 | 홈서버 스크립트 전달 | import 를 따라간 파일과 입력 파일을 tar 로 보내 임시 폴더에서 실행하고 지운다. 결과는 표준 출력으로 돌려받는다 | 작성자 | import 가 있는 `.ts` 여러 파일을 홈서버 checkout 없이 돌린다. 홈서버에 남는 파일이 없다 |
| DECISION4 | 홈서버 고유 값 전달 | fos-home-infra 오버레이의 JSON 블록을 `hs_overlay.ts` 가 읽어 스크립트 인자로 넘긴다. 스크립트에 기본값을 두지 않는다 | 작성자 | REQ11 의 「스킬에 홈서버 값이 없다」 를 테스트로 지킬 수 있다 |
| DECISION5 | 잠금 범위 | `remote.ts` 가 삭제 스크립트 실행 전체를 `flock -E 75 -w 300` 으로 감싼다. 잠금 실패는 전용 종료 코드 75 로 스크립트 실패와 나눈다 | 작성자 | 지우기 직전 사용 확인과 삭제가 한 잠금 안에 있다. Node 에 flock API 가 없다. 일부를 지운 뒤 실패한 실행을 「잠금 실패, 지우지 않음」 으로 잘못 보고하지 않는다 |
| DECISION6 | 등급 매기는 주체 | 이 맥의 `hs_classify.ts` | 작성자 | REQ6 을 테스트로 확인할 수 있고, 맥의 2단계와 달리 홈서버 등급은 소유자 표로 기계적으로 정해진다 |
| DECISION7 | Hermes 연결 판정 | assistant 저장값과 세션 트리. 트리 안에 연결되거나 30일 안의 세션이 있으면 트리 전체를 뺀다 | 작성자 | assistant 가 대화를 지울 때 쓰는 목록과 같다. 부모를 지울 때 자식이 함께 지워지는 경우를 막는다. 조회가 실패하면 후보를 내지 않는다 |
| DECISION8 | 워크트리 사용 확인 범위 | 워크트리 소유자와 같은 uid 의 프로세스. 그 가운데 cwd 를 읽지 못한 것이 있으면 확인하지 못함 | 작성자 | 스펙 DECISION16. 다른 uid 까지 보면 읽지 못하는 프로세스가 늘 있어 하나도 지우지 못한다 |
| DECISION9 | 「둘 다」 순서 | 맥 먼저, 홈서버 다음 | 작성자 | 기본 머신을 먼저 끝내 홈서버 실패가 맥 정리를 막지 않는다(REQ12) |
| DECISION10 | 조사 중 fetch 잠금 실패 | 그 저장소의 fetch 만 건너뛰고 표시한다 | 작성자 | 조사는 읽기라 낡은 ref 로도 안전하다. 홈서버 조사 전체를 실패로 돌리면 배포 하나가 정리 전체를 막는다 |
