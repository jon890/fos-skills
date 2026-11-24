## 공통 규칙 (모든 worker)

<!-- 저장소마다 한 번 복사해 {{...}} 를 채운다. references/ 와 templates/ 는 설치한 orch 스킬 기준이다. -->
<!-- 명령 인자와 오류 뒤 할 일은 각 명령의 --help 에서 확인한다. -->
<!-- 개별 지시서에는 `허락:` 줄과 `worker 선택:` 줄, `## 할 일` 제목을 적는다. 이 파일이 아니라 지시서마다 둔다. 형식은 skills/orch/references/spec-writing.md 의 「넣을 것」 이다. launch-worker 는 행별 에이전트·모델·effort 를 정확히 대조한다. 하나라도 다른 worker 를 고르면 선택 줄에 `후보 밖: <이유>` 를 덧붙인다. 이유가 비면 띄우지 않는다. -->
<!-- `## 할 일` 아래 첫 줄에 루프 선택을 적는다. 꼴이 틀리면 launch-worker 가 띄우지 않는다. 꼴과 예는 skills/orch/references/feature-loop.md 의 「루프를 쓸지 정한다」 가 소유한다. -->
<!-- `루프 없이` 로 띄우면 코디네이터는 사용자에게 보내는 띄우기 보고에 그 이유를 한 줄로 적는다. -->
<!-- `orch-rule:` 표지는 지우지 않는다. spec-lint 가 이 틀의 표지가 저장소 공통 지시서에 모두 있는지, 표지가 붙은 항목의 본문이 틀과 같은지 보고, 다르면 틀보다 낡았다고 경고한다. 틀을 고치면 `orch spec sync-common` 으로 diff 를 보고 `--apply` 로 반영한다. 일부러 바꾼 항목은 표지 이름 뒤에 `keep` 을 붙여 보존한다. -->
<!-- 번호 예약과 통합 테스트 표지의 적용 기준은 references/spec-writing.md 를 따른다. -->
- 대상 저장소는 {{REPO}} 다. 지정된 워크트리에서만 작업한다. 워크트리는 지시서의 `브랜치:` 이름으로 `origin/{{BASE}}` 최신 위에 만들어져 있다.
- 브랜치 이름을 바꾸지 않는다. push 는 `git push -u origin HEAD` 로 한다.
- 먼저 {{READ_FIRST}} 를 읽는다.
- 커밋은 관심사별로 나눈다. 제목 형식은 {{COMMIT_FORMAT}} 이다. 코드를 고친 뒤 `{{FORMAT_CMD}}` 를 돌린다.
- 커밋 메시지 끝에는 세션이 받은 attribution 지침(`Co-Authored-By` 줄)을 그대로 붙인다. 모델 이름은 이 파일에 적지 않는다. 지침이 없으면 그 줄을 붙이지 않는다.
- 확정된 변경은 코드와 책임 문서에 함께 반영한다. 문서와 구현의 의미가 다르면 원인을 확인하고, 새 제품 결정만 spec 으로 돌려보낸다.
- 끝까지 진행하고 판단이 필요한 것만 ask 로 묻는다. 검증 명령(`{{VERIFY_CMD}}`)을 실제로 실행한다.
- 파일 수정은 `sed -i` 대신 Edit 나 python 으로 한다.
- 의존성이 필요하면 워크트리 안에서 lockfile 로 설치한다. 원래 저장소의 의존성 폴더를 링크로 걸지 않는다.
- **PR 생성은 지시서의 `허락:` 줄이 허락한 경우에만 한다. 허락이 없으면 push 까지만 하고 status 로 알린다.** base 는 {{BASE}} 다. 다른 PR 브랜치를 base 로 두지 않는다. 제목과 본문은 {{PR_FORMAT}} 을 따른다. 지시서가 정한 PR 만 연다.
- 원격 명령은 `orch config get worker.readonly_tools` 에 나온 도구의 읽기 전용 호출만 직접 한다. 지시서의 `허락:` 줄에 있더라도 목록 밖 원격 명령, 원격 쓰기, auto mode 가 막을 수 있는 대량 삭제는 `orch worker ask` 로 맡긴다. <!-- orch-rule: coordinator-commands -->
- {{DRAFT_PR_RULE}}
- 믿는 봇을 설정한 저장소에서는 봇이 리뷰한다. 줄 댓글을 반영하고 push 한다. 리뷰 worker 를 부르지 않는다. <!-- orch-rule: trusted-review-bot -->
- 믿는 봇 설정 없이 자동 리뷰 workflow 를 바꾸면 Ready 뒤 코디네이터에게 독립 리뷰를 요청한다. 결과는 `review-fix` 로 반영한다. <!-- orch-rule: review-workflow -->
- PR 리뷰는 `review-fix` 로 반영한다. 반영 뒤 새 비차단 제안은 ask 없이 다음에 다룬다고 회신하고 resolve 하며, 차단 지적만 다시 반영한다. 첫 리뷰의 회신 기준은 `references/replying.md` 를 따른다. <!-- orch-rule: review-once -->
- 머지는 하지 않는다. 코디네이터가 한다(워크트리 권한 설정이 `gh pr merge` 를 막는다). **그러나 PR 이 머지될 때까지 이 worker 가 맡는다.** 준비됨을 보낸 뒤에도 CI 실패, 충돌, 리뷰를 코디네이터의 지시를 기다리지 않고 직접 처리한다.
- 하위 에이전트는 orca 명령을 쓰지 않는다. 스폰 프롬프트에 이 줄을 넣는다.
- 기준 브랜치는 충돌이 났거나 코디네이터나 머지 큐가 요청했을 때만 합친다. <!-- orch-rule: no-early-base-merge -->
- worker 는 진행 보드(`board.json`)를 수정하거나 `orch board step`, `mark`, `set` 을 부르지 않는다. <!-- orch-rule: no-board-edit -->
- 삭제처럼 되돌리기 어려운 쓰기는 하위 에이전트에 맡기지 않고 본체가 한다.
- `worker_done` 은 본체가 한 번만 보낸다. PR 을 여는 일은 그 PR 이 MERGED 가 된 것을 `gh pr view` 로 확인한 뒤 보낸다. PR 번호와 머지 커밋을 적는다. PR 이 없는 일(허락이 push 까지인 일)은 완료 기준을 채운 뒤 보낸다. 중간 진행(PR 생성, 준비됨)은 status 메시지로 보낸다.
- PR 생성·push, 막힘, 범위·결정 변경만 status 로 알린다. 판단이 필요한 질문은 `orch worker ask` 로 보낸다. <!-- orch-rule: status-only -->
- 코디네이터가 해결해야 진행할 수 있을 때만 escalation 을 보낸다. 머지 준비는 「준비됨」 status 로 알린다. <!-- orch-rule: status-not-escalation -->
- 권한 확인 창이나 거부로 막히면 우회하지 말고 ask 로 알린다. 터미널에만 적고 기다리지 않는다.
- worker 는 `orch config set` 과 `orch config unset` 을 부르지 않는다. 공유 설정 변경은 코디네이터에게 맡긴다. <!-- orch-rule: no-config-edit -->
- 비밀값이 든 파일을 읽지 않고 비밀값을 출력하지 않는다. 공유 DB 에 마이그레이션을 적용하지 않는다.
- **번호 예약.** 번호가 붙는 마이그레이션·ADR 은 지시서의 `orch-reserved` 경로를 쓰고, 없으면 `orch queue reserve --kind` 로 번호를 잡아 `RESERVED` 경로에 만든다. <!-- orch-rule: migration -->
- {{REMOTE_ACCESS_RULE}}
- 다른 worker 가 동시에 다른 일을 한다. 지시서 범위 밖의 파일은 고치지 않는다.
- 프로세스는 자기가 띄운 PID 로만 끈다. `pkill`, `killall` 은 다른 worker 의 호스트까지 꺼 쓰지 않는다(워크트리 권한 설정이 막는다). 스폰 프롬프트에 이 줄을 넣는다.
- 브라우저는 `BROWSER_EGO_SPACE` 를 자기 워크트리 이름(`basename "$(git rev-parse --show-toplevel)"`)으로 주고 연다. 다른 worker 와 같은 공간을 쓰면 탭이 섞이고 공간 한도가 찬다. 끝나면 실패해도 같은 이름으로 `browser-driver reset` 을 불러 탭과 공간을 함께 닫는다. 사용자 탭이 남아 공간이 닫히지 않으면 reset 이 그 사실을 알린다. `BROWSER_EGO_SPACE` 없이 부른 reset 은 기본 공간을 비우므로 browser-driver 가 거절한다.

## 판단이 필요할 때
- **기술 판단은 묻지 않고 권장안으로 진행한다.** 파일 위치, 테스트 방식, 마이그레이션 방식, 지시서 범위 안의 리팩터링 방식이 여기 해당한다. 고른 안과 이유를 status 메시지 한 줄과 PR 본문 「결정」 절에 남긴다.
- 지시서와 스펙이 이미 정한 결정은 바로 실행한다. 코드와 어긋나 지킬 수 없으면 `orch worker ask` 로 묻는다. <!-- orch-rule: no-reconfirm -->
- **아래만 ask 로 묻는다.** 화면이나 외부 API 계약 변경, 기록된 팀 결정을 뒤집는 것, 외부에 보이는 글, 공유 서버나 DB 에 쓰기, 비용이 드는 작업, 지시서 범위를 넘는 변경, 데이터 삭제.
- 코디네이터 판단이 필요하면 `orch worker ask` 로 묻고, 사용자가 정할 결정에는 `--decision` 을 붙인다. <!-- orch-rule: worker-ask -->
- 코디네이터에게 넘길 파일은 `orch paths root` 아래 `handoff/` 에 두고 절대경로를 전한다. 자리와 정리는 `references/replying.md` 를 따른다. <!-- orch-rule: handoff-path -->
- 기준 브랜치와 충돌하면 코디네이터가 후속 지시서를 보낸다. 그 지시대로 이 worker 가 푼다.
- 변경이 `orch config get queue.integration_tests` 의 규칙에 걸리면 해당 모듈의 테스트를 실행하고 현재 커밋의 결과를 PR 에 적는다. 형식은 `references/verification.md` 를 따른다. <!-- orch-rule: integration-evidence -->

## 끝내기
1. 검증 명령을 돌려 통과를 확인한다.
2. 원격 브랜치를 pull 한 뒤 `git push -u origin HEAD` 로 push 한다.
3. PR 본문을 파일로 쓴다. 파일 이름에 작업(워크트리) 이름을 넣어 `pr-body-<워크트리 이름>.md` 처럼 짓는다. `pr-body.md` 같은 고정 이름은 다른 PR 의 본문과 섞여 엉뚱한 본문이 올라간다. 허락 줄이 PR 을 허락했으면 그 파일로 PR 을 연다. 본문 파일은 PR 이 열릴 때까지 지우지 않는다. PR 을 못 열거나 열지 않으면 본문을 `handoff/pending/<워크트리 이름>/` 에 두고 그 절대경로를 보고한다. 코디네이터는 worker 의 세션 임시 폴더를 열 수 없다.
4. **게시가 막히면 묻지 않는다.** `gh pr create` 나 리뷰 회신이 거부되거나, 지금 실행의 지시가 GitHub 게시를 막는다고 판단되면 push 까지 하고 본문 파일(회신이면 스레드 id 와 회신 파일) 경로를 status 로 보낸다. 코디네이터가 그 파일로 연다.
5. 리뷰 지적 처리를 마치고 `orch queue gate` 가 `GATE-OK` 로 통과한 뒤 `준비됨 #<PR 번호>, head <40자리 SHA>` 를 status 로 보낸다. 보류나 실패는 `references/replying.md` 를 따른다. <!-- orch-rule: ready-status -->
6. **머지될 때까지 맡는다.** CI 실패, 충돌, 리뷰를 직접 처리한다. 기준 브랜치가 앞서 나간 것만으로는 합치지 않는다. 고쳐 push 하면 5 의 gate 를 다시 통과한 뒤 바뀐 head 로 「준비됨 status」를 다시 보낸다. 코디네이터가 머지한다.
7. `gh pr view` 로 MERGED 를 확인한 뒤 지시서의 완료 기준을 다시 읽는다. 다른 PR 머지와 머지 뒤 확인을 포함해 완료 기준을 모두 채운 뒤 PR 번호와 머지 커밋을 넣어 `worker_done` 을 보낸다. <!-- orch-rule: done-after-merged -->
- 계획을 나눈 뒤 다음 PR 이 남으면 `worker_done` 에 PR 별 이름과 계획 경로를 한 줄씩 적는다. <!-- orch-rule: remaining-prs -->
- PR 을 열거나 고쳐 push 한 턴에서 `orch queue gate --wait` 로 CI 를 기다리고, 통과 뒤 「준비됨」을 한 번 보낸다. <!-- orch-rule: wait-in-turn -->

## 설계와 구현을 맡길 때

<!-- 기능 개발이나 plan, implementation 를 맡길 때 남긴다. 기능 루프 규칙의 표지는 지우지 않는다. -->
- 새 기능은 `references/feature-loop.md` 의 순서대로 진행한다. 확인한 스펙이나 계획이 있으면 해당 단계부터 시작한다. <!-- orch-rule: feature-loop -->
- spec 인터뷰의 결정은 `orch worker ask --decision` 으로 묻고, 스펙은 일반 ask 로 확인받은 뒤 plan 과 구현을 시작한다. <!-- orch-rule: spec-interview -->
- `implementation` 는 PR 을 열지 않는다. 실행 담당이 worker 인 PR 전 인수 검증(실행 담당이 코디네이터인 행은 코디네이터가 한다)과 문서 대조·후보 추출을 마친 뒤, PR 생성이 허락됐으면 worker 가 위 공통 규칙에 따라 PR 을 연다.
- `plan` 과 `implementation` 는 사용자와 대화하는 세션을 전제로 한다. worker 는 사용자에게 묻지 못하므로 아래로 바꿔 읽는다.
- 사용자에게 확인하라는 단계는 위 「판단이 필요할 때」 의 기준으로 정한다. 기술 판단은 권장안으로 진행하고, ask 대상만 `worker-ask` 로 묻는다. `AskUserQuestion` 은 쓰지 않는다.
- 설계와 근거 문서는 `{{DESIGN_DIR}}` 에 둔다.
- plan 하나는 PR 하나다. 큰 일은 plan 을 나눈다. 계획의 보존·삭제와 증거 인계는 `skills/plan/references/plan-lifecycle.md` 를 따른다.
- 세션 재시작, 계정 전환을 넘길 수 있는 일은 `plan` 으로 `tasks/` 를 만든다. 끊긴 뒤 다음 worker 가 계획과 phase 커밋으로 이어받는다.
- 지시서 「할 일」 첫 줄이 `루프를 쓴다(스펙: <경로>)` 면 그 스펙은 사용자가 확인한 것이다. technical-design 을 수행하거나 기존 설계의 유효성과 독립 검토를 확인한 뒤 plan 으로 간다. `루프를 쓴다(스펙: 새로 쓴다)` 면 spec 인터뷰부터 하고, 사용자가 확인하기 전에는 plan 과 구현을 하지 않는다.
- 지시서 「할 일」 첫 줄이 `루프 없이: <이유>` 면(제품·도메인 의미와 계약을 바꾸지 않는 버그 수정, 정리·삭제, 설정 값 조정 같은 작은 일) spec 과 plan 없이 바로 구현하고, PR 본문에 확인한 방법과 결과, 필요한 독립 검토를 적는다. 사용자 동작·권한·데이터 보존을 바꾸는 선택이 생기면 그 결정만 `--decision` 으로 묻는다.
- 기능 루프를 쓰는 PR 은 `templates/feature-evidence.md` 를 채우고 머지 전 사전 검증과 독립 리뷰를 마친다. <!-- orch-rule: feature-evidence -->
- 구현만 맡겼으면 구현 결과와 검증 증거를 코디네이터에게 넘긴다. 뒤의 검증·후보 추출·PR 생성은 지시서가 정한 담당자가 이어 간다.
- critic·verify·docs 검토를 맡길 때는 읽기 전용 하위 에이전트를 쓰고, 쓰기와 orca 호출은 금지한다. <!-- orch-rule: review-subagents -->
- 검토 결과를 기다릴 때 Claude worker 는 하위 에이전트가 실행 중이면 턴을 끝낸다. Codex worker 는 결과를 받은 뒤 턴을 끝낸다. 자세한 절차는 `references/launch.md` 를 따른다. <!-- orch-rule: wait-subagent -->
- 하위 에이전트는 `name` 없이 띄운다. 이름을 주면 팀원으로 등록되고 tmux pane 이 없는 worker 터미널에서 실패한다.
- 저장소에 `.claude/plan-overlay.md` 나 `.claude/implementation-overlay.md`가 있으면 경로는 그 파일을 따른다.
- 보고에서 phase 를 가리킬 때는 계획 이름을 붙인다(`plan12-login phase 3`). 계획이 둘 이상 돌면 phase 번호만으로는 어느 계획인지 알 수 없다.

## 스킬 개선 후보 보고

<!-- 이 절은 지우지 않는다. 빠지면 spec-lint 가 공통 경고를 낸다. 후보를 다시 보는 주기와 판정은 skills/orch/references/feedback-review.md 가 소유한다. -->
- 다음 작업에도 도움이 될 스킬 개선 후보는 `orch feedback add` 로 기록한다. <!-- orch-rule: feedback-add -->
- `worker_done` 에 「스킬 개선 후보 N건: <이름 목록>」 또는 「스킬 개선 후보 없음」을 적는다. <!-- orch-rule: skill-feedback -->
- 스킬 파일은 직접 고치지 않는다. 코디네이터가 사용자와 정한 뒤 고친다.

## 공부 후보 보고

<!-- 이 절은 지우지 않는다. 빠지면 spec-lint 가 공통 경고를 낸다. 기준과 글로 잇는 법은 skills/orch/references/study-candidates.md 가 소유한다. -->
- 판단을 바꾼 일반 기술 개념은 `orch study add` 로 기록하고, `worker_done` 에 후보 수와 slug 또는 「공부 후보 없음」을 적는다. <!-- orch-rule: study-candidates -->
