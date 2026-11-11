## 공통 규칙 (모든 worker)

<!-- 저장소마다 한 번 복사해 {{...}} 를 채운다. 저장소에 해당하지 않는 줄은 지운다. -->
<!-- 개별 지시서에는 `허락:` 줄과 `worker 선택:` 줄, `## 할 일` 제목을 적는다. 이 파일이 아니라 지시서마다 둔다. 형식은 skills/orch/references/spec-writing.md 의 「넣을 것」 이다. 행의 후보 밖 모델을 고르면 선택 줄에 `후보 밖: <이유>` 를 덧붙인다. 이유가 비면 띄우지 않는다. -->
<!-- `## 할 일` 아래 첫 줄에 루프 선택을 적는다. 꼴이 틀리면 launch-worker 가 띄우지 않는다. 꼴과 예는 skills/orch/references/feature-loop.md 의 「루프를 쓸지 정한다」 가 소유한다. -->
<!-- `루프 없이` 로 띄우면 코디네이터는 사용자에게 보내는 띄우기 보고에 그 이유를 한 줄로 적는다. -->
<!-- `orch-rule:` 표지는 지우지 않는다. spec-lint 가 이 틀의 표지가 저장소 공통 지시서에 모두 있는지, 표지가 붙은 항목의 본문이 틀과 같은지 보고, 다르면 틀보다 낡았다고 경고한다. 틀을 고치면 `orch spec sync-common` 으로 diff 를 보고 `--apply` 로 반영한다. 일부러 바꾼 항목은 표지 이름 뒤에 `keep` 을 붙여 보존한다. -->
<!-- `migration` 표지 항목은 Flyway 마이그레이션이 없는 저장소면 지운다. spec-lint 는 orch 설정에 `migrations` 가 있는 저장소에서만 그 표지가 빠진 것을 알린다. -->

- 대상 저장소는 {{REPO}} 다. 지정된 워크트리에서만 작업한다. 워크트리는 지시서의 `브랜치:` 이름으로 `origin/{{BASE}}` 최신 위에 만들어져 있다.
- 브랜치 이름을 바꾸지 않는다. push 는 `git push -u origin HEAD` 로 한다.
- 먼저 {{READ_FIRST}} 를 읽는다.
- 커밋은 관심사별로 나눈다. 제목 형식은 {{COMMIT_FORMAT}} 이다. 코드를 고친 뒤 `{{FORMAT_CMD}}` 를 돌린다.
- 커밋 메시지 끝에는 세션이 받은 attribution 지침(`Co-Authored-By` 줄)을 그대로 붙인다. 모델 이름은 이 파일에 적지 않는다. 지침이 없으면 그 줄을 붙이지 않는다.
- 확정된 변경은 코드와 책임 문서에 함께 반영한다. 문서와 구현의 의미가 다르면 원인을 확인하고, 새 제품 결정만 spec 으로 돌려보낸다.
- 끝까지 진행하고 판단이 필요한 것만 ask 로 묻는다. 검증 명령(`{{VERIFY_CMD}}`)을 실제로 실행한다.
- CI 를 기다릴 때는 `gh pr checks --watch --interval 60` 이상을 쓴다. `gh run watch` 에도 `--interval 60` 이상을 준다.
- 파일 수정은 `sed -i` 대신 Edit 나 python 으로 한다.
- 의존성이 필요하면 워크트리 안에서 lockfile 로 설치한다. 원래 저장소의 의존성 폴더를 링크로 걸지 않는다.
- **PR 생성은 지시서의 `허락:` 줄이 허락한 경우에만 한다. 허락이 없으면 push 까지만 하고 status 로 알린다.** base 는 {{BASE}} 다. 다른 PR 브랜치를 base 로 두지 않는다. 제목과 본문은 {{PR_FORMAT}} 을 따른다. 지시서가 정한 PR 만 연다.
- {{DRAFT_PR_RULE}}
- 변경 파일에 자동 리뷰 workflow(예: `.github/workflows/claude-code-review.yml`)가 있으면 Ready 뒤 자동 리뷰를 기다리지 않고 코디네이터에게 독립 리뷰를 요청한다. 기본 브랜치와 workflow 가 달라 보안 검증으로 자동 리뷰가 건너뛰어질 수 있다. 코디네이터가 마련한 독립 리뷰 결과도 `review-fix` 로 반영한다. <!-- orch-rule: review-workflow -->
- PR 을 연 뒤 리뷰가 달리면 `review-fix` 스킬로 반영한다. 리뷰 회신과 resolve 는 허용한다. 반영하지 않을 지적이 있으면 회신 전에 ask 로 묻는다.
- 머지는 하지 않는다. 코디네이터가 한다(워크트리 권한 설정이 `gh pr merge` 를 막는다). **그러나 PR 이 머지될 때까지 이 worker 가 맡는다.** 준비됨을 보낸 뒤에도 CI 실패, 충돌, 기준 브랜치 변경, 리뷰를 코디네이터의 지시를 기다리지 않고 직접 처리한다.
- 하위 에이전트는 orca 명령을 쓰지 않는다. 스폰 프롬프트에 이 줄을 넣는다.
- 진행 보드(`board.json`)를 고치지 않는다. `board.ts step`, `mark`, `set` 을 부르지 않는다. 보드 단계는 스크립트가 PR, 머지, 배포로 끝내고 나머지는 코디네이터가 고친다. worker 가 단계를 체크하면 PR 전인데 끝난 것으로 보인다. <!-- orch-rule: no-board-edit -->
- 삭제처럼 되돌리기 어려운 쓰기는 하위 에이전트에 맡기지 않고 본체가 한다.
- `worker_done` 은 본체가 한 번만 보낸다. PR 을 여는 일은 그 PR 이 MERGED 가 된 것을 `gh pr view` 로 확인한 뒤 보낸다. PR 번호와 머지 커밋을 적는다. PR 이 없는 일(허락이 push 까지인 일)은 완료 기준을 채운 뒤 보낸다. 중간 진행(PR 생성, 준비됨)은 status 메시지로 보낸다.
- **status 는 PR 을 열었거나 고쳐 push 했을 때, 막혔을 때, 범위나 결정이 바뀌었을 때만 보낸다.** 검증 단계마다, 기다리는 중, 다시 돌리는 중 같은 진행 보고는 보내지 않는다. worker 가 여럿이면 코디네이터에게 알림이 쌓여 질문을 늦게 잡는다. 질문은 status 에 섞지 않고 ask 로 보낸다. 「PR 을 열었다」 와 「준비됨」 은 CI 를 기다린 뒤 한 번에 보낸다. <!-- orch-rule: status-only -->
- 머지를 기다린다는 알림은 따로 보내지 않는다. 「끝내기」 의 `준비됨` status 가 그 알림이다. escalation 은 코디네이터가 움직여야 이 worker 가 계속할 수 있을 때(권한 거부, 막힌 검증, 범위 밖 변경)만 쓴다. 머지 대기를 escalation 으로 보내면 막힌 worker 와 구분되지 않는다. <!-- orch-rule: status-not-escalation -->
- 권한 확인 창이나 거부로 막히면 우회하지 말고 ask 로 알린다. 터미널에만 적고 기다리지 않는다.
- 비밀값이 든 파일을 읽지 않고 비밀값을 출력하지 않는다. 공유 DB 에 마이그레이션을 적용하지 않는다.
- Flyway 마이그레이션 파일 이름은 직접 정하지 않는다. 만들기 전에 자기 워크트리에서 아래 블록으로 번호를 예약하고 `RESERVED` 줄의 경로로 만든다. 다른 워크트리의 파일과 번호가 겹치지 않게 하려는 것이다. `orch` 가 PATH 에 없으면 블록의 첫 줄이 아래 `worker-ask` 와 같이 설치본의 실행기를 푼다. <!-- orch-rule: migration -->

  ```bash
  MODULE=""
  NAME=""
  command -v orch >/dev/null || orch() { _o="$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")')" || return 3; node "$_o" "$@"; }
  orch queue reserve --repo "$(git rev-parse --show-toplevel)" --module "$MODULE" --name "$NAME"
  ```

  `MODULE` 은 orch 설정 `migrations.dirs` 의 모듈 이름이고 `NAME` 은 영문 설명이다. Java 마이그레이션은 `--kind java` 를 더하고 `NAME` 을 그 폴더의 기존 파일 이름 형식(snake_case 나 PascalCase)대로 준다. 줄 끝이 `renewed` 면 이미 만든 파일의 이름을 그 경로로 바꾼다. 기준 브랜치를 합친 뒤에는 같은 `MODULE` 과 `NAME` 으로 다시 부르고, `renewed` 면 파일 이름을 바꾼다. 합친 base 에 같은 번호가 들어왔으면 머지 단계의 번호 충돌에서야 드러나 검증을 한 바퀴 더 돌기 때문이다. `RESERVED` 줄이 없으면 파일을 만들지 않는다. 종료 코드 4(잠금)나 1(조회 실패)이면 한 번 다시 부르고, 그래도 아니면 그 줄을 붙여 ask 로 묻는다. 2 면 바로 ask 로 묻는다. out-of-order 를 켜지 않는다. 코디네이터가 이 PR 이 막는 쪽이라고 알리면 `--again` 을 더해 새 번호를 받고 파일 이름을 바꾼다.
- 번호 붙은 ADR 파일 이름은 직접 정하지 않는다. 만들기 전에 자기 워크트리에서 아래 블록으로 번호를 예약하고 `RESERVED` 줄의 경로로 만든다. 병렬 PR 이 같은 폴더에 같은 ADR 번호를 쓰지 않게 하려는 것이다. <!-- orch-rule: adr -->

  ```bash
  MODULE=""
  NAME=""
  command -v orch >/dev/null || orch() { _o="$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")')" || return 3; node "$_o" "$@"; }
  orch queue reserve --repo "$(git rev-parse --show-toplevel)" --kind adr --module "$MODULE" --name "$NAME"
  ```

  `MODULE` 은 orch 설정 `adr.dirs` 의 이름이고 `NAME` 은 영문 설명이다. 파일 이름의 설명 조각은 `NAME` 을 하이픈으로 이어 만든다. 줄 끝이 `renewed` 면 이미 만든 파일의 이름과 그 번호를 인용한 곳(INDEX, 본문 링크)을 그 경로로 바꾼다. `RESERVED` 줄이 없으면 파일을 만들지 않는다. 종료 코드 4(잠금)나 1(조회 실패)이면 한 번 다시 부르고, 그래도 아니면 그 줄을 붙여 ask 로 묻는다. 2 면 바로 ask 로 묻는다.
- {{REMOTE_ACCESS_RULE}}
- 다른 worker 가 동시에 다른 일을 한다. 지시서 범위 밖의 파일은 고치지 않는다.
- 프로세스는 자기가 띄운 PID 로만 끈다. `pkill`, `killall` 은 다른 worker 의 호스트까지 꺼 쓰지 않는다(워크트리 권한 설정이 막는다). 스폰 프롬프트에 이 줄을 넣는다.
- 브라우저는 `BROWSER_EGO_SPACE` 를 자기 워크트리 이름(`basename "$(git rev-parse --show-toplevel)"`)으로 주고 연다. 다른 worker 와 같은 공간을 쓰면 탭이 섞이고 공간 한도가 찬다. 끝나면 실패해도 같은 이름으로 `browser-driver reset` 을 불러 탭과 공간을 함께 닫는다. 사용자 탭이 남아 공간이 닫히지 않으면 reset 이 그 사실을 알린다. `BROWSER_EGO_SPACE` 없이 부른 reset 은 기본 공간을 비우므로 browser-driver 가 거절한다.

## 판단이 필요할 때

- **기술 판단은 묻지 않고 권장안으로 진행한다.** 파일 위치, 테스트 방식, 마이그레이션 방식, 리뷰 하위 등급 지적의 반영 여부와 이유, 지시서 범위 안의 리팩터링 방식이 여기 해당한다. 고른 안과 이유를 status 메시지 한 줄과 PR 본문 「결정」 절에 남긴다.
- **지시서와 스펙이 이미 정한 결정은 실행 전에 다시 확인하지 않고 진행한다.** 「이대로 진행할까요」, 「이 값이 맞나요」 처럼 답이 지시서에 있는 질문을 ask 로 보내지 않는다. 지시서와 실제 코드가 어긋나 정한 결정을 지킬 수 없을 때만 묻는다. 확인 질문 하나가 코디네이터와 사용자를 기다리게 해 worker 가 멈춘다. <!-- orch-rule: no-reconfirm -->
- **아래만 ask 로 묻는다.** 화면이나 외부 API 계약 변경, 기록된 팀 결정을 뒤집는 것, 외부에 보이는 글, 공유 서버나 DB 에 쓰기, 비용이 드는 작업, 지시서 범위를 넘는 변경, 데이터 삭제.
- **ask 는 설치된 스킬의 `worker-ask`(`orch worker ask`)로 보낸다.** `orch` 가 PATH 에 없으면(Codex worker, 실행기를 깔지 않은 셸) 블록의 첫 줄이 이 세션의 `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)에 설치된 `fos-skills@fos-skills` 의 실행기를 풀어 셸 함수로 둔다. 코디네이터와 worker 의 프로필이 다를 수 있고 번들은 갱신되므로 경로를 지시서에 박지 않는다. Bash 호출마다 셸이 새로 뜨니 같은 호출 안에서 푼다. <!-- orch-rule: worker-ask -->

  ```bash
  FROM=""
  QUESTION=""
  command -v orch >/dev/null || orch() { _o="$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")')" || return 3; node "$_o" "$@"; }
  orch worker ask --from "$FROM" --question "$QUESTION"
  ```

  위 블록은 `FROM` 과 `QUESTION` 을 채운 뒤 한 번에 붙여 넣는다. `FROM` 은 머리말의 `--from` 값이고 `QUESTION` 은 질문 문장이다. 값을 채우지 않고 돌리면 `worker-ask` 가 사용법 오류(종료 코드 2)로 끝난다. 명령은 전경으로 돌린다. 질문을 보내고 바로 끝난다. 0 이고 첫 줄이 `ASKED <질문 id>` 면 턴을 끝낸다. 답이 오면 Orca 가 깨우고, 깬 뒤 `orca orchestration check` 로 답을 읽는다. 0 이고 첫 줄이 `answer: ` 면 그 뒤가 답이다. 종료 코드 5 면 읽지 않은 코디네이터 메시지가 출력에 있으니 먼저 읽고, 그래도 물어야 하면 같은 명령을 다시 부른다(한 번 보여 준 메시지로는 다시 막지 않는다). 3 이고 `SENT-RUN <id>` 면 Run 메일함으로 대신 보낸 것이다. 같은 방식으로 턴을 끝내고 깬 뒤 `check` 로 읽는다.
- **사용자가 정할 결정은 아래 형식으로 쓰고 `--decision` 을 붙인다.** 보드의 결정 필요 항목이 첫 줄을 제목으로, `권장:` 줄을 그 아래에 보인다. 형식이 어긋나면 `worker-ask` 가 묻지 않고 종료 코드 2 로 끝난다. 결정 블록은 한 질문에 4개까지다. 넘으면 4개씩 나눠 질문마다 보내고, 긴 본문은 파일에 써 `--question-file <파일>` 로 보낸다. 기술 질문과 막힘 보고는 형식 없이 묻는다.

  ```text
  결정: 무엇을 정하는지 한 줄
  배경: 왜 지금 정해야 하는지
  선택지:
  - 선택지 이름: 고르면 생기는 결과
  - 선택지 이름: 고르면 생기는 결과
  권장: 선택지 이름. 이유
  ```

- 기준 브랜치와 충돌하면 코디네이터가 후속 지시서를 보낸다. 그 지시대로 이 worker 가 푼다.

## 끝내기

1. 검증 명령을 돌려 통과를 확인한다.
2. 원격 브랜치를 pull 한 뒤 `git push -u origin HEAD` 로 push 한다.
3. PR 본문을 파일로 쓴다. 파일 이름에 작업(워크트리) 이름을 넣어 `pr-body-<워크트리 이름>.md` 처럼 짓는다. `pr-body.md` 같은 고정 이름은 다른 PR 의 본문과 섞여 엉뚱한 본문이 올라간다. 허락 줄이 PR 을 허락했으면 그 파일로 PR 을 연다. 본문 파일은 PR 이 열릴 때까지 지우지 않는다.
4. **게시가 막히면 묻지 않는다.** `gh pr create` 나 리뷰 회신이 거부되거나, 지금 실행의 지시가 GitHub 게시를 막는다고 판단되면 push 까지 하고 본문 파일(회신이면 스레드 id 와 회신 파일) 경로를 status 로 보낸다. 코디네이터가 그 파일로 연다.
5. PR 이 열리면 status 로 `준비됨 #<PR 번호>, head <40자리 SHA>` 한 줄을 보낸다. **보내기 전에 `orch queue gate <PR 번호>` 이 `GATE-OK` 로 통과해야 한다.** `GATE-FAIL` 이면 이유 줄(미해결 리뷰 스레드, 기능 완료 근거 블록, 독립 리뷰 줄, CI, 충돌)을 모두 고쳐 push 하고 다시 돌린다. 리뷰 지적을 반영하기 전에는 보내지 않는다. 독립 리뷰 줄의 「대기」 하나만 남았고 그 리뷰를 코디네이터에게 요청했으면 그 이유 줄을 status 에 적고 보낼 수 있다. 설명을 붙이려면 그 줄 뒤에 줄을 바꿔 쓴다. 「게시가 막히면」에 따라 넘겼으면 본문 파일 경로를 보내고 PR 이 열리면 이 줄을 보낸다. <!-- orch-rule: ready-status -->
6. **머지될 때까지 맡는다.** CI 실패, 충돌, 기준 브랜치 변경, 리뷰를 직접 처리한다. 고쳐 push 하면 5 의 gate 를 다시 통과한 뒤 바뀐 head 로 「준비됨 status」를 다시 보낸다. 코디네이터가 머지한다.
7. PR 이 MERGED 인 것을 확인한다. `worker_done` 을 보내기 전에 지시서의 완료 기준을 다시 읽는다. 이 PR 밖의 PR 머지나 확인이 남았으면 보내지 않는다. 완료 기준에 머지 뒤에 할 일(dev 확인, 배포 뒤 검증)이 남았으면 그 일을 마친 뒤에, 없으면 바로 `worker_done` 을 보낸다. PR 번호와 머지 커밋, 아래 「스킬 개선 후보 보고」 와 「공부 후보 보고」 의 줄을 적는다. 머지 없이 닫혔으면 ask 로 알린다. <!-- orch-rule: done-after-merged -->
- 계획에서 PR 을 여럿으로 나눴으면 `worker_done` 본문에 남은 PR 목록을 PR 마다 한 줄(이름과 계획 경로)로 적는다. 보드에는 코디네이터가 단계로 올린다. <!-- orch-rule: remaining-prs -->
- PR 을 연 뒤나 고쳐 push 한 뒤에는 CI 결과를 그 턴 안에서 기다린다. `gh pr checks <PR 번호> --watch --interval 60` 을 전경으로 돌려 끝까지 기다리고, 도구 시간 제한에 걸리면 같은 명령을 다시 부른다. CI 가 끝나고 `orch queue gate <PR 번호>` 이 통과한 뒤 `준비됨` status 를 한 번 보내고 턴을 끝낸다. CI 를 기다리며 턴을 끝내거나 「CI 를 기다리는 중」 status 를 보내지 않는다. 이유: 턴을 끝내면 Orca 가 코디네이터를 깨운다. 실측(Run run_67445446b89f, haiku, 케이스당 1회, 표본이 적다): 아무것도 안 보내고 끝내면 escalation 1건, status 를 보낸 뒤 끝내면 status 1건과 escalation 1건, ask 뒤 끝내면 question 1건, worker_done 뒤 끝내면 worker_done 1건이다. 전경에서 오래 도는 명령 동안에는 깨우지 않는다. 그래서 진행 소식은 보내지 않고, 판단이 필요하면 status 대신 ask 로 묻고 턴을 끝낸다. <!-- orch-rule: wait-in-turn -->

## 설계와 구현을 맡길 때

<!-- 기능 개발이나 plan, implementation 를 맡길 때 남긴다. 기능 루프 규칙의 표지는 지우지 않는다. -->

- 새 기능은 `spec → technical-design → plan → implementation → verify → docs-consolidate 후보 추출` 순서로 진행한다. 스펙이나 계획이 있으면 필요한 단계부터 시작한다. 상세 인계는 orch 의 `references/feature-loop.md` 를 따른다. <!-- orch-rule: feature-loop -->
- spec 단계는 `spec` 스킬의 인터뷰 절차(`references/interview.md` 「직접 묻지 못할 때」)대로 결정 블록은 `worker-ask --decision` 으로, 스펙 확인 요청은 형식 없이 `worker-ask` 로 보낸다. 혼자 정하고 넘어가지 않는다. 코디네이터가 사용자의 확인을 돌려주기 전에는 plan 과 구현을 시작하지 않는다. <!-- orch-rule: spec-interview -->
- `implementation` 는 PR 을 열지 않는다. 실행 담당이 worker 인 PR 전 인수 검증(실행 담당이 코디네이터인 행은 코디네이터가 한다)과 문서 대조·후보 추출을 마친 뒤, PR 생성이 허락됐으면 worker 가 위 공통 규칙에 따라 PR 을 연다.

- `plan` 과 `implementation` 는 사용자와 대화하는 세션을 전제로 한다. worker 는 사용자에게 묻지 못하므로 아래로 바꿔 읽는다.
- 사용자에게 확인하라는 단계는 위 「판단이 필요할 때」 의 기준으로 정한다. 기술 판단은 권장안으로 진행하고, ask 대상만 `worker-ask` 로 묻는다. `AskUserQuestion` 은 쓰지 않는다.
- 설계와 근거 문서는 `{{DESIGN_DIR}}` 에 둔다.
- plan 하나는 PR 하나다. 큰 일은 plan 을 나눈다. 계획의 보존·삭제와 증거 인계는 `skills/plan/references/plan-lifecycle.md` 를 따른다.
- 세션 재시작, 계정 전환을 넘길 수 있는 일은 `plan` 으로 `tasks/` 를 만든다. 끊긴 뒤 다음 worker 가 계획과 phase 커밋으로 이어받는다.
- 지시서 「할 일」 첫 줄이 `루프를 쓴다(스펙: <경로>)` 면 그 스펙은 사용자가 확인한 것이다. technical-design 을 수행하거나 기존 설계의 유효성과 독립 검토를 확인한 뒤 plan 으로 간다. `루프를 쓴다(스펙: 새로 쓴다)` 면 spec 인터뷰부터 하고, 사용자가 확인하기 전에는 plan 과 구현을 하지 않는다.
- 지시서 「할 일」 첫 줄이 `루프 없이: <이유>` 면(제품·도메인 의미와 계약을 바꾸지 않는 버그 수정, 정리·삭제, 설정 값 조정 같은 작은 일) spec 과 plan 없이 바로 구현하고, PR 본문에 확인한 방법과 결과, 필요한 독립 검토를 적는다. 사용자 동작·권한·데이터 보존을 바꾸는 선택이 생기면 그 결정만 `--decision` 으로 묻는다.
- 기능 루프는 PR 하나라도 짧은 설계와 plan 을 남긴다. 인수 검증 계획은 phase 에 포함할 수 있다. PR 본문에는 orch 의 `templates/feature-evidence.md` 를 채운다. PR 자동 리뷰를 쓰면 독립 리뷰는 대기로 PR 을 열고, 실제 결과를 받은 뒤 통과 근거로 갱신한다. 머지 전 모든 사전 검증과 독립 리뷰를 마친다. 스펙만 담은 PR 에도 해당한다. 그 PR 의 블록 꼴은 같은 틀의 「스펙만 담은 PR」 이다. <!-- orch-rule: feature-evidence -->
- 구현만 맡겼으면 구현 결과와 검증 증거를 코디네이터에게 넘긴다. 뒤의 검증·후보 추출·PR 생성은 지시서가 정한 담당자가 이어 간다.
- critic, verify 검토자, docs-verifier 는 읽기 전용 하위 에이전트로 띄운다. 쓰기와 orca 명령은 금지한다. 이 줄이 머리말이 말하는 task 의 요청이다. <!-- orch-rule: review-subagents -->
- 하위 에이전트는 `name` 없이 띄운다. 이름을 주면 팀원으로 등록되고 tmux pane 이 없는 worker 터미널에서 실패한다.
- 저장소에 `.claude/plan-overlay.md` 나 `.claude/implementation-overlay.md`(옛 이름 `planning-overlay.md`, `build-with-teams-overlay.md`)가 있으면 경로는 그 파일을 따른다.
- 보고에서 phase 를 가리킬 때는 계획 이름을 붙인다(`plan12-login phase 3`). 계획이 둘 이상 돌면 phase 번호만으로는 어느 계획인지 알 수 없다.

## 스킬 개선 후보 보고

<!-- 이 절은 지우지 않는다. 빠지면 spec-lint 가 공통 경고를 낸다. 후보를 다시 보는 주기와 판정은 skills/orch/references/feedback-review.md 가 소유한다. -->

- 스킬과 이 지시서 체계를 쓰다가 아래를 만나면 그 자리에서 메모한다.
  - 지시대로 했는데 동작하지 않은 곳
  - 우회해야 했던 곳과 실제로 통한 방법
  - 스킬이 다루지 않아 물어야 했던 판단
  - 산문 대신 명령이나 스크립트로 바꿀 수 있는 곳
- 메모하기 전에 아래 세 가지를 모두 따져 하나라도 아니면 후보로 올리지 않는다.
  - 유의미한가: 고치면 다음 작업의 시간이나 실패가 실제로 줄어드는가. 한 번 겪고 끝날 일, 취향 차이는 올리지 않는다.
  - 단순 함정이 아닌가: 오타, 일시적인 네트워크나 권한 문제, 이 작업에만 있는 사정처럼 스킬을 고쳐도 재발을 못 막는 것은 올리지 않는다.
  - 구조로 막을 수 있는가: 스크립트, 검사기, 명령 한 줄, 문서 구조 변경처럼 다시 일어나지 않게 만드는 방법이 있어야 한다. 「주의한다」 같은 문장 추가로만 막을 수 있으면 올리지 않는다.
- 후보는 파일을 직접 쓰지 않고 `orch feedback add` 로 적는다. 필수 칸이 빠지면 명령이 저장하지 않는다. <!-- orch-rule: feedback-add -->
  `SLUG` 는 영문 소문자·숫자·하이픈으로 짓고, `TITLE` 은 무엇이 안 됐는지 쉬운 말로 쓴다. 나머지는 옵션 이름에 맞는 설명과 근거를 채운다.

  ```bash
  SLUG=""
  TITLE=""
  SKILL=""
  FILE=""
  SITUATION=""
  PROBLEM=""
  WANT=""
  EVIDENCE=""
  SIGNIFICANCE=""
  NONTRIVIAL=""
  STRUCTURAL=""
  command -v orch >/dev/null || orch() { _o="$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")')" || return 3; node "$_o" "$@"; }
  orch feedback add --slug "$SLUG" --title "$TITLE" --skill "$SKILL" --file "$FILE" --situation "$SITUATION" --problem "$PROBLEM" --want "$WANT" --evidence "$EVIDENCE" --significance "$SIGNIFICANCE" --nontrivial "$NONTRIVIAL" --structural "$STRUCTURAL"
  ```

  PATH 에 `orch` 가 없으면 위 함수가 설치 기록에서 실행기를 찾는다. 워크트리에서 불러도 주 checkout 의 orch 루트 아래 `feedback/` 에 후보 하나당 파일 하나를 만든다. 칸과 순서는 `references/feedback-review.md` 의 「후보 파일」 이 소유한다.
- `worker_done` 본문 끝에 「스킬 개선 후보 N건: <이름 목록>」 를 적는다. 없으면 「스킬 개선 후보 없음」. <!-- orch-rule: skill-feedback -->
- 스킬 파일은 직접 고치지 않는다. 코디네이터가 사용자와 정한 뒤 고친다.

## 공부 후보 보고

<!-- 이 절은 지우지 않는다. 빠지면 spec-lint 가 공통 경고를 낸다. 기준과 글로 잇는 법은 skills/orch/references/study-candidates.md 가 소유한다. -->

- 작업 중 판단을 바꾼 일반 기술 개념이 있으면 공부 후보로 적는다. 엔지니어링으로 공부할 가치가 있는 것만 적고, 아무 주제나 올리지 않는다.
- 아래 넷을 모두 채울 때만 적는다. 작업 하나에 0건이 기본이다.
  - 저장소 밖에서도 통하는 일반 기술 개념이다.
  - 이번 판단에서 선택지 사이의 트레이드오프가 선택을 정했다. 단순 사실 조회, 도구 사용법, 오타나 설정 실수, 내부 절차는 아니다.
  - 공식 문서나 널리 알려진 글로 더 공부할 거리가 있다.
  - 한두 문장 정의로 설명이 끝나지 않는다.
- 회사 이름, 서비스 이름, 내부 식별자는 적지 않는다. 적는 자리에서 일반 개념과 질문으로 바꾼다.
- `MEMO` 에는 네 기준을 어떻게 채웠는지 한 줄로 적는다. 같은 후보가 이미 있어 종료 코드 1 로 끝나면 새로 적지 않는다.

  ```bash
  SLUG=""
  TOPIC=""
  QUESTION=""
  ORIGIN=""
  REF=""
  MEMO=""
  command -v orch >/dev/null || orch() { _o="$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")')" || return 3; node "$_o" "$@"; }
  orch study add --slug "$SLUG" --topic "$TOPIC" --question "$QUESTION" --origin "$ORIGIN" --ref "$REF" --memo "$MEMO"
  ```

  워크트리에서 불러도 후보는 주 checkout 의 orch 루트에 쌓인다. slug 는 영문 소문자, 숫자, 하이픈으로 짓는다.
- `worker_done` 본문 끝에 「공부 후보 N건: <slug 목록>」 을 적는다. 없으면 「공부 후보 없음」. 0건도 정상이다. <!-- orch-rule: study-candidates -->
