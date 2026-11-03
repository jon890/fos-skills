# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 6.1.0 (2026-11-03)

- 자동 머지의 리뷰 판정을 저장소마다 `queue.auto_review.require` 의 조건 조합으로 고른다. 조건은 `verdict-on-head`, `verdict-seen`, `last-verdict-pass`, `rereview-after-block` 이다
- `require` 를 적지 않은 저장소는 지금 HEAD 의 판정만 세는 이전 동작(`verdict-on-head`)과 같다. 미해결 스레드 0 은 조합과 상관없이 늘 본다
- 모르는 조건 이름이 있으면 상주 루프는 멈추지 않고 PR 만 걸지 않으며, `orch-doctor` 가 `INVALID-CONFIG` 로 알린다
- 큐를 걸 때 PR 마다 통과 근거(조건, 판정, 커밋이나 댓글, 시각)를 `AUTO-MERGE-BASIS` 줄로 루프 로그에 남긴다
- `AUTO-MERGE-NO-REVIEW` 는 HEAD 범위가 아닌 조건이 막았으면 `HEAD <SHA> 의 PR 에 … (<조건>)` 꼴로 알린다

## 6.0.0 (2026-11-02)

- 호환성: 새로 띄우는 지시서는 `## 할 일` 아래 첫 줄이 `루프를 쓴다(스펙: <경로>)`, `루프를 쓴다(스펙: 새로 쓴다)`, `루프 없이: <이유>` 가운데 하나여야 한다. 아니면 `launch-worker` 가 5 로 멈춘다
- `루프를 쓴다(스펙: <경로>)` 는 그 스펙에 `확인: YYYY-MM-DD` 줄이 있어야 통과한다. 상대경로 스펙은 worker 가 시작할 곳(새 워크트리면 `origin/<base>`)에서 읽으므로 커밋하지 않은 스펙은 절대경로로 적는다
- `리뷰 PR:`, `중간 과정:` 줄이 있는 지시서와 이미 떠 있는 worker 의 지시서는 보지 않는다
- `루프 없이` 로 띄우면 사용자에게 보내는 띄우기 보고에 이유를 한 줄로 적는다

## 5.x

- `orch/scripts` 의 옛 `.py` 진입점과 옛 설정 칸, 옵션을 지웠다. 명령은 `bin/orch.ts <이름>` 으로 부르고 옛 설정은 `migrate-orch-dir --hooks` 로 바꾼다
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

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾸며 worker 가 작업 중이어도 적용한다. 옛 폴더 옮기기는 다른 저장소의 지시서에 막히지 않는다
- 저장소마다 상주 루프 `orch-loop.ts` 가 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 `wait-important --loop-repo` 를 깨운다
- worker 가 PR 이 머지될 때까지 맡고, 완료 검증은 `준비됨` 을 받은 때 한다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다
- `cleanup-sweep --remote-branches` 가 머지된 원격 브랜치를 지우고, 머지 큐가 머지한 브랜치를 base 로 둔 내 PR 의 base 를 옮긴다
- worker 를 띄우면 보드 항목을 만들고 루프가 PR 연결과 머지를 반영한다. 결정 필요 항목은 `DECISION-PENDING` notifier가 깨운다
- `heavy` 절로 무거운 검사를 분류하고, 시간 제한과 유예를 `ORCH_*` 환경 변수로 바꿀 수 있다
- node 24 이상이 필요하다. 그보다 낮으면 스킬을 열 때 `NODE-TOO-OLD` 로 멈춘다(ADR-011)

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
