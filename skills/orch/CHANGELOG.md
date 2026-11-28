# CHANGELOG: orch

## 0.17.0 (2026-11-28)

- 모델 실측 비용이 빠지지 않는다. 가격표에 6.2 계열을 더하고, 옛 세대는 같은 계열 단가로, `opus` 같은 계열 이름은 정식 id 로 합쳐 계산한다.
- 계열 이름으로 띄운 Claude worker 도 실제 모델 id 를 기록한다. 띄울 때 지시서의 할 일 수와 가리키는 파일 수도 남긴다.
- 새 설정 `routing.review_sources` 로 첫 리뷰 출처를 여럿 받고 Codex 봇의 P0~P3 배지를 센다. PR 의 바뀐 줄, 파일, 모듈 수와 크기 구간도 남긴다.
- 되돌려 이어 맡은 dispatch 가 연 PR 은 첫 dispatch 의 모델로 센다. `orch routing report --compare` 는 크기 구간별로 모델을 나란히 보인다.
- 호환성: `orch routing report --json` 의 `first_review_p1_mean`, `first_review_p2_mean` 을 없앴다. 출처별 값은 `first_review.<출처>.means` 에서 읽는다.

## 0.16.4 (2026-11-28)

- 리뷰와 보안 리뷰 worker 의 Sonnet 5.5 를 `medium` 대신 `high` 로 띄운다. 리뷰를 맡는 sol 은 `medium` 그대로다.
- 모델 표의 「두 모델과 effort」 칸에 적힌 effort 를 행의 effort 보다 먼저 쓴다. 같은 등급을 쓰는 행끼리 한 모델의 effort 만 다르게 둘 수 있다.

## 0.16.3 (2026-11-27)

- PR 을 열기 전에 보고 없이 턴을 끝낸 worker 도 `orch worker continue --dispatch <id>` 로 이어 가게 한다. 지금까지는 열린 PR 이 없으면 `CONTINUE-SKIP` 으로 끝나 다시 움직일 명령이 없었다.
- 살아 있는 dispatch 라도 Orca 가 턴이 끝났다고 보면(작업 중도 백그라운드 대기도 아니다) 「남은 할 일을 이 턴에서 이어 한다」 를 본문으로 보낸다. 작업 중인 worker, 머지된 PR, 리뷰 worker 는 지금처럼 건너뛴다.
- 같은 브랜치와 단계마다 2번까지만 보내고, 출력 끝에 `tries=<n>/<상한>` 을 붙인다.

## 0.16.2 (2026-11-27)

- 정기 정리가 Orca 가 이미 잊은 dispatch 의 띄우기 기록과 브랜치 칸이 없는 옛 기록도 워크트리가 없고 `cleanup.state_days` 가 지났으면 휴지통으로 옮긴다. 전에는 이 둘이 한 달 넘게 남았다.
- `overlay.md` 「작업 산출물의 자리와 지우는 때」 표에 `queue/` 와 `state/` 줄을 더하고, 정리하지 않는 실측 기록과 GitHub 응답 캐시의 이유를 `cleanup.md` 에 적는다.

## 0.16.1 (2026-11-27)

- `launch-worker --lint-ack` 이 `보드` 발견(붙일 보드 항목을 찾지 못함 같은 것)을 넘기지 않는다. 넘기면 워크트리 이름으로 따로 항목이 생겼다.
- 붙일 항목을 찾지 못하면 지시서 머리에 `보드 항목 id: <id>`, `보드 항목: 새로`, `보드 항목 없음: <이유>` 가운데 하나를 적어야 띄운다.
- `spec-lint` 가 붙일 보드 항목을 찾지 못하면 제목이나 브랜치가 비슷한 열린 항목을 최대 세 개(id 와 제목) 함께 보여 준다.

## 0.16.0 (2026-11-27)

- 머지 큐가 체크가 하나도 없는 PR 을 5분 기다리지 않고 관문과 같은 `PR 에 CI 체크가 하나도 없다` 로 바로 멈추고 `queue.allow_no_checks` 를 켜라고 알린다.
- 머지 큐와 관문 `--wait` 가 체크를 기다리는 동안 1분마다 `CHECK-WAIT` 줄로 몇 분째 무엇을 기다리는지 낸다. 짧은 출력에도 남는다.
- 관문 `--wait` 가 믿는 봇의 리뷰가 끝나기를 `--review-timeout`(기본 20분)까지 기다린다.
- 한도 안에 봇 리뷰가 끝나지 않으면 관문이 실패와 다른 `GATE-PENDING` 과 종료 코드 3 을 낸다.

## 0.15.1 (2026-11-27)

- Run 없는 세션에서 `orch request send` 가 「`--run` 이 필요하다」 로 끝나면, Run 을 만들고 루프에 묶는 명령을 저장소 값으로 채워 함께 알린다.
- 루프에 등록된 Run 이 있으면 그 Run 으로 다시 부르는 명령을 먼저 보여 준다.
- `orch loop start` 가 Run 없이 `run=-` 로 뜨면 `LOOP-NO-RUN` 줄로 경고하고 같은 다음 명령을 낸다.

## 0.15.0 (2026-11-27)

- 보드 기본 단계를 「PR 머지」 한 줄로 바꾼다. PR 이 이어지면 줄에 PR 번호를 적고 머지 때 끝낸다. 이미 PR, 머지 두 줄로 만든 항목은 그대로 처리한다.
- PR 없는 지시서는 기본 단계 대신 「할 일」 의 번호 줄을 단계로 쓰고, 지금 담당 worker 의 `worker_done` 에 적은 `steps=2,3`(할 일 번호)이나 번호 없는 보고로 상주 루프가 그 단계를 끝낸다.
- `orch worker launch` 가 이미 있는 보드 항목의 제목을 지시서 제목으로 덮지 않는다.
- 마무리가 PR 제목에서 업무 번호를 찾지 못하면 브랜치 이름과 보드 항목의 업무 번호에서 찾는다. 찾은 번호를 `after-deploy` 입력의 `task_number` 로 넘긴다.
- `orch board set` 이 `--title` 을 받아 없는 항목을 만들고, 없는 항목에 `add-step` 하면 만드는 명령을 알린다.

## 0.14.1 (2026-11-27)

- `orch worker send` 가 모든 worker 에게 보내는 답과 후속 지시 끝에 할 일, 완료 조건, 대기 표시 줄을 붙인다.
- Codex 에만 붙이던 한 줄로는 확인 답만 하고 턴을 끝내는 일이 줄지 않았다.

## 0.14.0 (2026-11-27)

- 보드 항목 id 가 없는 지시서는 띄울 때 브랜치, 업무, 기능 폴더로 기존 항목을 찾아 붙이고, 못 찾으면 띄우기 전에 막는다. 항목 없이 띄울 일은 `보드 항목 없음: <이유>` 를 적는다.

## 0.13.0 (2026-11-27)

- `orch request send` 가 보드 항목 제목에 요청 제목만 적고, 보낸 저장소와 받는 저장소는 따로 칸에 남겨요. 보드 창이 그 칸으로 「[보낸 저장소 요청] 제목 · 요청 46」 을 그려요.
- 요청 알림 제목을 「새 요청 · ai-analysis 가 보냄 · 「보드 단계 정리」 (요청 46)」 꼴로 바꿨어요. 받음, 보류, 거절, 완료, 실패, 답 없음 알림도 같은 꼴이에요.
- 요청 번호 인자는 `46` 과 `R46` 을 모두 받아요. 요청 메시지의 답 명령은 `orch request accept 46` 처럼 숫자로 적어요.

## 0.12.0 (2026-11-27)

- 기능 단계의 PR 이 머지되면 보드에 다음 차례를 적고, 마지막 단계까지 같은 항목에서 진행한다.

## 0.11.0 (2026-11-27)

- 보드 대기 줄 `[wait: 사건 <이름>]` 을 상주 루프가 느린 틱마다 `board.wait_events` 의 확인 명령으로 확인한다. 0 이면 그 줄을 끝내고 `WAIT-EVENT` 를 보낸다.
- 사건 확인 명령이 1 이면 그대로 두고, 명령 없음·실패·시간 초과·출력 초과는 `WAIT-EVENT-ERROR` 로 한 번만 알린다.
- 사건 확인 명령은 새 프로세스 그룹으로 돌고, 시간 상한을 넘기면 TERM 을 무시한 하위 프로세스까지 끝낸 뒤 돌아온다.

## 0.10.2 (2026-11-27)

- 스킬 개선 후보의 세 기준을 찾는 곳을 공통 지시서 틀에서 `orch feedback add --help` 로 고친다.

## 0.10.1 (2026-11-27)

- 살아 있는 작업 세션이 쓰는 워크트리는 정리 대상에서 뺀다. 세션 상태를 조회하지 못한 경우에도 워크트리를 남기고 이유를 출력한다.
- PR을 열지 않는 지시서로 보드 항목을 만들면 완료 보고를 기다리는 단계 하나를 만들고, 담당 작업의 보고를 받으면 끝낸다.

## 0.10.0 (2026-11-27)

- `orch board set <항목> --priority 1`로 우선순위를 정하고 `--priority none`으로 지워요. `show`와 `list`에서 우선순위를 확인할 수 있어요.

## 0.9.0 (2026-11-27)

- 외부 공개 전 버전 체계에 맞춰 번호를 0.x로 바꿨어요.

## 8.4.0 (2026-11-26)

- 대화 문맥을 압축한 뒤 코디네이터에게 진행 중인 보드 항목, 답을 기다리는 기술 질문, 열린 승인을 다시 보여 준다.

## 8.3.0 (2026-11-26)

- 리뷰 설정(`queue.auto_review` 의 `trusted_bots`, `review_checks`)이 없으면 상주 루프가 기능 PR 인지와 관계없이 어떤 PR 도 자동 머지에 걸지 않아요. 이 조건을 스레드 조회와 PR 조회 앞에서 봐서 헛된 gh 조회가 없어요.
- 믿는 리뷰 봇의 마지막 리뷰에 P1·P2 지적이 없으면 그 뒤 커밋에도 그 리뷰를 인정해요. P3~P5 만 반영한 push 는 재리뷰를 기다리지 않고, 루프도 다시 요청하지 않아요.
- 판단 중에 PR HEAD 가 바뀌면 어느 값에서 걸렸든 `검사 중 HEAD 가 바뀌었다` 하나로 알리고, 체크를 읽다 본 HEAD 변경도 머지 큐가 새 HEAD 로 다시 판정해요.
- 루프의 PR 조회와 미해결 스레드 조회가 gh 캐시를 쓰지 않고, 읽은 HEAD 가 틱의 HEAD 와 다르면 기다려요. 머지 직전 체크 재확인도 같은 판단(`checkReadiness`)으로 캐시 없이 한 번 읽어요.

## 8.2.0 (2026-11-26)

- 보드 기본 위치를 `.orch/board.json`으로 바꾸고, `orch doctor migrate`에서 보드 파일과 공유 저장소의 `finish.board`를 함께 옮길 수 있게 했어요.

## 8.1.0 (2026-11-26)

- 지금 HEAD의 CI 체크가 없으면 관문과 머지 큐가 첫 체크를 기다린다. CI가 없는 저장소는 플러그인을 갱신한 뒤 `queue.allow_no_checks`를 켜면 된다.

## 8.0.2 (2026-11-26)

- 사람이 머지하기로 한 PR 은 열려 있는 상태에서 worker 가 완료를 보내도 DONE-SUSPECT 알림을 보내지 않는다.

## 8.0.1 (2026-11-26)

- `orch worker launch` 가 Orca 에 등록되지 않은 저장소면 워크트리를 만들기 전에 `orca repo add` 를 안내하고 멈춘다. 워크트리만 남는 일이 없어진다.
- 정리가 `orch worker resume` 으로 이어 간 끝난 worker 의 터미널을 띄우기 기록으로 확인해 닫는다. 「터미널 소유 상태 조회 실패」 로 워크트리가 남던 일이 없어진다.

## 8.0.0 (2026-11-26)

- 호환성: `orch queue ready`, `--skipped-is-missing`, `before-ready`, `pr-ready` 를 없앴어요. PR 은 처음부터 ready 상태로 열어요. <!-- orch-compat -->
- 호환성: 옛 draft CI 설정 키와 핸들러, 오버레이 문구는 `orch doctor` 의 `DRAFT-CI-RETIRED` 에서 위치를 확인해요.

## 7.x

- Orca 메시지로 질문과 작업 완료를 받고, 상주 루프가 CI 와 충돌을 감시해요.
- 머지 관문과 큐, 루프 자동 머지가 공통 조건 표로 PR 을 확인해요.
- 머지 전에는 HEAD, 통합 테스트 기록, 리뷰 체크와 믿는 봇의 영수증을 확인해요.
- 코디네이터는 공통 지시서와 보드에서 작업 범위, 승인, 재리뷰, 배포 뒤 확인을 관리해요.

## 6.x

- 기능 루프의 사용자 확인과 worker 지시서 진입 검사를 제공해요.

## 5.x

- `skills/orch/scripts` 의 옛 `.py` 진입점과 옛 설정 칸, 옵션을 지웠다. 명령은 `bin/orch.ts <이름>` 으로 부르고 옛 설정은 `migrate-orch-dir --hooks` 로 바꾼다
- 상주 루프가 멈춘 worker(`WORKER-IDLE`, `STAGE-STALLED`, 사용 한도), 마무리 없는 머지, 대기 없음, 오래 쥔 무거운 검사 자리, 새 사용자 결정을 알린다
- 기능 루프(spec, planning, build-with-teams, verify, docs-consolidate)와 루프를 쓸지 정하는 기준, worker 의 spec 인터뷰 중계를 더했다
- 지시서 하나의 완료 기준은 PR 하나의 MERGED 다. `spec-lint` 가 완료, 보드, 공통 지시서 표지 경고를 내고 무관한 활성 지시서끼리의 겹침은 경고만 한다
- `리뷰 PR: #N` 지시서는 `launch-worker` 가 PR head 에 리뷰 워크트리를 둔다. 정리가 리뷰 흔적, 후속 지시서, compose 컨테이너, 선언한 Docker 자원을 지운다
- `worker-ask`, `wait-important`, `send-to-worker` 가 답과 완료 근거를 더 넓게 찾고, `adopt-sessions` 가 떨어진 worker 를 붙이며, 끝난 worker 의 막힘은 `worker-release` 로 닫는다
- 공부 후보를 `study/<slug>.md` 파일로 모아 `study-candidates` 로 다루고, `orch-doctor` 가 `STUDY-OPEN`, `FEEDBACK-OPEN` 을 낸다
- gh 체크를 HEAD 별로 캐시하고 모든 `orca orchestration` 조회에 `--full` 을 붙인다. Codex worker 의 SSH 인증과 `reserve-migration --kind java` 를 더했다

## 4.x

- 상주 루프가 여러 세션의 Run 을 함께 맡고, 자동 머지(`queue.auto_merge`)와 마이그레이션 번호 검사, 예약(`reserve-migration.ts`)을 한다
- 보드 항목의 단계는 마일스톤 단계다. `[pr]`, `[merge]`, `[deploy]`, `[release]` 와 줄 끝 사건 꼬리표를 사건에 맞춰 끝낸다
- `launch-worker` 가 띄우기 전에 `spec-lint`, `worker 선택:` 줄 대조, codex 모델 검사, Claude 프로필 판정을 한다. 프로필은 `link-claude-profile.ts` 로 맞춘다
- worker 상태 판정을 `lib/worker-state.ts` 한 곳이 정하고 `cleanup-sweep`, `orch-doctor`, `wait-important` 가 함께 쓴다
- 진입점 `bin/orch.ts <이름>` 이 설치 기록의 현재 번들에서 스크립트를 찾아 실행한다. 문서의 명령 예시가 이 꼴이다
- 읽기 전용 gh 조회가 프로세스 사이에서 캐시를 공유하고 `gh-usage.ts` 가 호출 수를 낸다
- `finish-pr` 이 업무의 마지막 PR 인지 스스로 판정하고, 머지 큐가 충돌한 PR 을 빼고 뒤 PR 을 잇는다
- 지시서 하나는 PR 하나다. 에이전트 고르기에 제공자 절과 라우팅표, 사용 한도 대응표를 두었다

## 3.x

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.skills/orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾸며 worker 가 작업 중이어도 적용한다. 옛 폴더 옮기기는 다른 저장소의 지시서에 막히지 않는다
- 저장소마다 상주 루프 `orch-loop.ts` 가 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 `wait-important --loop-repo` 를 깨운다
- worker 가 PR 이 머지될 때까지 맡고, 완료 검증은 `준비됨` 을 받은 때 한다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다
- `cleanup-sweep --remote-branches` 가 머지된 원격 브랜치를 지우고, 머지 큐가 머지한 브랜치를 base 로 둔 내 PR 의 base 를 옮긴다
- worker 를 띄우면 보드 항목을 만들고 루프가 PR 연결과 머지를 반영한다. 결정 필요 항목은 `DECISION-PENDING` notifier가 깨운다
- `heavy` 절로 무거운 검사를 분류하고, 시간 제한과 유예를 `ORCH_*` 환경 변수로 바꿀 수 있다
- node 24 이상이 필요하다. 그보다 낮으면 스킬을 열 때 `NODE-TOO-OLD` 로 멈춘다(`ADR-011`)

## 2.x

- orch 파일을 `.omc/` 와 `.claude/` 에서 주 checkout 의 `.orch/` 로 옮겼다(`overlay.md`, `config.json`, `specs/`). 옛 위치는 `migrate-orch-dir` 로 옮긴다
- `heavy-slot.py` 가 같은 PC 에서 여러 worker 가 돌리는 무거운 검사를 대기열과 자리 수로 제한한다
- `merge-with-finish --run` 으로 머지 뒤 정리를 그 Run 의 worker 로 한정한다. 다른 코디네이터의 터미널을 닫던 문제를 고쳤다
- `launch-worker`, `make-worktree` 의 `--resume-remote` 로 원격 PR 브랜치를 새 워크트리에서 이어 받는다
- `cleanup-sweep.py --close-own-taken-over` 로 끝난 worker 가 남긴 사용자 보유 셸을 닫는다
- `watch-questions` 가 미답변 질문을 Monitor 로 알리고 10분마다 다시 알린다
- 모든 지시서에 `허락:` 줄이 필수다. `worker-ask --decision` 이 사용자 결정 질문의 형식(`결정:`, 선택지, `권장:`)을 검사한다
- 코디네이터 터미널에서 돌린 정리가 모든 워크트리를 터미널 소유 상태 조회 실패로 건너뛰던 문제를 고쳤다

## 1.x

- 7단계 절차(에이전트 고르기부터 머지와 정리까지)와 단계별 reference, 공통 지시서 틀, 저장소 오버레이를 두었다
- 머지 큐가 필수 체크, 미해결 스레드, HEAD 를 확인해 차례로 머지하고 base 최신화, 합친 사본 검사, `--up-to-date-when overlap` 을 받는다
- `merge-with-finish` 와 `finish-pr` 가 머지 뒤 worker 정리, 배포 성공 대기, 업무 완료, 보드 done 을 함께 건다
- `cleanup-sweep.py` 가 깨어날 때마다 머지된 워크트리, 브랜치, 터미널, 지시서를 지우고 `board-sync.py` 가 보드를 맞춘다
- `launch-worker` 가 지시서의 브랜치와 `허락:` 줄대로 띄우고, `send-to-worker` 가 답을 보내고 입력 대기인 worker 를 깨운다
- `wait-important` 가 heartbeat 를 넘기고 중요한 메시지나 끊긴 worker 에서만 깨어난다. `notify-conflicts` 가 충돌한 PR 의 worker 에게 알린다
- 띄우기 전 `spec-lint`, 스킬을 열 때 `orch-doctor` 가 돌고, worker 워크트리에 `gh pr merge` 와 `pkill` 을 막는 권한 규칙이 들어간다
- PreToolUse hook 이 백그라운드 대기, `cd` 뒤 git 쓰기, worker 터미널 직접 입력, 형식이 다른 `--spec` 을 거부한다
