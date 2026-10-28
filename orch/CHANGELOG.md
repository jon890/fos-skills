# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 4.13.0 (2026-10-28)

- 사용 한도에 걸렸을 때 더 비싼 모델로 올리지 않는다는 전역 지침을 에이전트 고르기에서 가리킨다
- 원칙에 「auto mode 분류기가 머지나 배포를 막으면 우회 스크립트를 새로 쓰지 않고, 돌릴 명령을 보여 주고 사용자가 직접 실행하게 한다」 를 더했다

## 4.12.0 (2026-10-28)

- `send-to-worker` 가 `--from run:<run>` 이 `consumer_fenced` 로 거부되면 `--from` 없이 한 번 다시 보내고 `retry:` 줄을 낸다
- 질문 감시가 질문의 스레드에 worker 쪽으로 간 답을 보낸 쪽과 상관없이 답으로 센다. 답은 질문을 보낸 쪽과 그 질문의 `dispatch:<id>` inbox 에서 찾는다. 코디네이터 터미널에서 보낸 답이 다시 REMINDER 로 뜨지 않는다
- 공통 지시서 틀이 plan 하나를 PR 하나로 둔다. 큰 일은 plan 을 나누고 계획서는 그 plan 을 구현한 PR 에서 지운다. 기술 판단 목록에서 PR 분할을 뺐다
- 지시서 작성 규칙이 지시서 하나를 PR 하나로 쓰게 한다. 설계 문서만 담은 PR 을 따로 열지 않는다

## 4.11.0 (2026-10-28)

- `launch-worker` 가 새 보드 항목의 제목을 `# ` 제목 줄, `보드 항목 id` 의 기존 항목 제목, 업무 연결 줄의 제목, `## 목표` 첫 문장, id 순으로 고른다. 업무 번호가 있으면 제목 앞에 붙인다
- 같은 업무 번호가 제목에 든 끝나지 않은 항목이 있으면 다른 워크트리에서 띄워도 그 항목을 이어 쓴다. 워크트리만 바꾸고 단계는 그대로 둔다
- 업무 연결 줄의 꼴은 `config.json` 의 `board.task_line` 정규식으로 바꾼다. 기본 꼴은 `두레이 업무: <프로젝트>/<번호> 「제목」` 이다
- `spec-lint` 가 제목 줄도 `보드 항목 id:` 도 없는 지시서에 `제목` 경고를 낸다. 지시서 첫 줄은 `# <업무 목적 한 문장>` 이다

## 4.10.0 (2026-10-27)

- `orch-loop` 이 끝난 dispatch 의 질문을 재알림하지 않는다. 그 dispatch 의 준비 상태가 가리키는 PR 이 모두 머지되거나 닫혔을 때다
- 처음 판정한 틱에 `REMINDER-SKIP <id>: <근거>` 를 로그에 한 번 쓰고, `state/questions-closed.json` 에 남겨 다시 조회하지 않는다
- `launch-worker` 가 dispatch 기록(`state/launched-workers/<dispatch>.json`)에 Task 와 지시서 절대경로를 더한다. `send-to-worker` 의 이어 쓰기도 `launch-worker` 를 거쳐 같이 남는다
- `cleanup-sweep --specs-dir` 가 워크트리를 지우면 그 워크트리의 기록에 든 지시서를 이름과 상관없이 `--trash` 로 옮기고 기록을 지운다. 살아 있는 dispatch 가 가리키는 지시서는 남긴다
- 공통 지시서 틀의 tasks 규칙을 바꿨다. PR 이 여럿이거나 재시작을 넘길 수 있는 일은 `tasks/` 를 만들고, PR 하나로 끝나는 일은 `build-with-teams` 의 리뷰부터 도는 경로를 쓴다

## 4.9.0 (2026-10-27)

- `launch-worker` 가 worker-start 실패를 `worker-start 오류: <code>: <message>` 한 줄로 알린다. 다시 띄우기 실패도 이유를 붙인다
- 설정이 보드(`finish.board`, `cleanup.board`, `board` 절)를 가리키는데 보드 파일이 없으면 `launch-worker` 가 항목을 만들지 못했다고 알린다
- 호환성: 옛 경로 `work-board/bin/board.py` 를 지웠다. `board.ts` 를 부른다

## 4.8.0 (2026-10-27)

- 호환성: `launch-worker` 가 만드는 보드 항목의 단계는 지시서 「할 일」 이 아니라 마일스톤 단계다. 지시서의 `## 보드 단계` 절, `board.steps`, 기본값(PR, 머지) 순으로 정한다
- 꼬리표 `[pr]`, `[merge]`, `[deploy]` 단계는 `board-sync`, `finish-pr` 가 PR 열림, 머지, 배포 성공에 맞춰 끝낸다. done 으로 바꾸는 사건은 `board.done_after`(기본 `merge`)다
- `board-release.ts` 를 더했다. 릴리스 PR(`--release`)이나 PR 번호(`--pr`)로 항목의 `[release]` 단계를 끝낸다. 부르는 때는 저장소가 정한다
- `board-sync` 가 정리된 워크트리의 `worktree` 필드를 비우고 중간 PR 을 `merged-pr` 에 쌓는다. 공통 지시서 틀에 worker 는 보드를 고치지 않는다는 줄을 더했다

## 4.7.1 (2026-10-27)

- 끝난 dispatch 의 question 과 escalation 에도 `send-to-worker` 가 답을 단다. `--reply-to` 를 주거나, 없으면 미답변 메시지 중 마지막에 답하고, 깨우지 않으며 `--spec` 이 없으면 0 으로 끝난다
- 답을 `--from run:<run>` 으로 달아 `orch-doctor` 의 `UNANSWERED` 와 루프의 `REMINDER` 가 남지 않는다

## 4.7.0 (2026-10-27)

- 머지 큐에 `--required-check NAME` 과 `--allow-fail-check NAME` 을 더했다. 쉼표가 든 체크 이름을 나누지 않고 받는다
- 저장소 규칙과 `queue.required` 목록에서 읽은 이름에 쉼표가 있어도 나뉘지 않는다
- 진행 중인 체크 없이 필수 체크가 `--missing-timeout`(기본 5분) 동안 나타나지 않으면 먼저 멈추고 실제 체크 이름을 찍는다
- 호환성: `queue.required` 목록은 이름마다 `--required-check` 로 머지 큐에 넘어간다

## 4.6.0 (2026-10-27)

- `reserve-migration.ts` 를 더했다. 마이그레이션 번호를 잠금을 걸고 예약하며, 같은 인자는 같은 예약을 돌려준다. `--again` 으로 새 번호를 받고, 머지되거나 사라진 브랜치의 예약을 정리한다
- 자동 머지가 PR 없는 예약을 낮은 번호로 보고, `MIGRATION-BLOCKED` 알림에 재예약 방법을 안내한다
- 지시서 문구 예시에 마이그레이션 예약 규칙을 더했다

## 4.5.0 (2026-10-27)

- 자동 머지(`queue.auto_merge`)를 더했다. 상주 루프가 지시서에 든 내 열린 PR 가운데 draft 가 아니고, CI 가 통과했고, 미해결 스레드가 없고, 리뷰 판정(`queue.auto_review`)이 통과인 것을 머지 큐에 건다
- 지시서의 `- 머지 보류: <이유>` 줄과 보드 항목의 끝나지 않은 `머지 보류: <이유>` 줄이 그 PR 을 루프가 거는 대상에서 뺀다
- 마이그레이션 검사(`migrations` 절)를 더했다. 번호가 base 이하거나 다른 PR 과 같으면 `MIGRATION-CLASH`, 낮은 번호의 PR 이 오래 막혀 있으면 `MIGRATION-BLOCKED` 를 낸다
- 루프 알림 `AUTO-MERGE`(큐를 걸었다)와 `AUTO-MERGE-END`(건 큐가 끝났다)를 더했다

## 4.4.0 (2026-10-27)

- 지시서에 `중간 과정: PR #N` 줄이 있으면 `launch-worker` 가 보드에 새 항목을 만들지 않고 그 PR 의 기존 항목에 한 줄만 남긴다. 충돌 해결, CI 고침, 리뷰 반영 지시서에 쓴다
- 호환성: 이미 있는 보드 항목에 worker 를 다시 띄우면 제목과 단계를 바꾸지 않고 워크트리와 브랜치만 바꾼다. 그 항목이 done 이면 doing 으로 다시 열고 새 단계를 다음 번호부터 잇는다
- 충돌 후속 지시서는 PR 마다 `spec-conflict-<PR>.md` 하나이고 base 가 움직이면 덮어쓴다. `finish-pr` 가 머지 뒤 중간 PR 이어도 그 지시서를 지운다
- 답한 결정 줄은 `board.ts mark` 로 끝내고, 줄이 모두 끝난 decide 항목은 done 이 된다. `list` 가 번호 없는 줄도 보이고 `steps` 는 그 줄을 stderr 에 낸다
- 창의 결정 필요는 남은 결정 줄과 답하지 않은 worker 질문만 센다. 코디네이터 터미널에서 보낸 회신도 답으로 보고, 같은 worker 가 다시 보낸 질문은 하나로 센다

## 4.3.0 (2026-10-26)

- 표시가 없는 PR 은 `finish-pr` 가 배포 뒤 업무의 마지막 PR 인지 스스로 판정한다. 근거는 `마지막 PR 판정:` 한 줄로 남는다. `PR!` 는 강제로 마지막, 새 `PR~` 는 강제로 중간이다
- 판정에 `finish.spec_task_pattern` 을 더했고 `finish.task_pattern` 은 지우지 않는다. 판정하지 못하면 중간 PR 이다
- 머지 큐가 base 와 충돌한 PR 을 `CONFLICT` 로 빼고 뒤 PR 을 이어 머지하며 루프 알림 `QUEUE-CONFLICT` 를 쓴다. `--chain A,B` 로 묶은 PR 은 앞 PR 이 빠지면 `SKIP` 한다
- 보드 항목을 `pr` 필드가 비어도 브랜치나 워크트리로 찾는다. 다시 띄운 worker 는 같은 워크트리의 항목을 이어 쓰고, `pr` 필드는 `#` 없이 숫자로 저장한다
- 호환성: `PR!` 가 없던 PR 도 판정이 마지막이면 업무를 완료하고 보드를 done 으로 바꾼다. 뒤 작업이 남았는데 PR 도 지시서도 없으면 `PR~` 를 붙인다

## 4.2.0 (2026-10-26)

- `launch-worker.ts` 가 띄운 worker 의 dispatch, 터미널, 워크트리를 기록한다. 기록이 없는 터미널은 예전처럼 사용자 보유로 남는다
- `cleanup-sweep.ts` 는 기록에 있고 dispatch 가 끝난 `user_owned` 터미널을 닫고 PR 상태로 정리를 판단한다
- PR 없는 워크트리는 dispatch 가 끝나고 앞선 커밋과 변경이 없으면 치운다. 원격 브랜치도 앞선 커밋이 없을 때만 지운다
- 머지 큐 로그 폴더의 끝난 로그를 휴지통(`--trash`)으로 옮긴다. `FINISH-FAIL` 과 `STOP` 로그는 1시간 남기고 모르는 파일은 건드리지 않는다

## 4.1.1 (2026-10-26)

- PR 본문 파일 위치를 worker 세션 임시 폴더로 바꾼다. 지시서 작성과 오버레이 안내가 저장소의 `.orch/` 대신 임시 폴더에 쓰고 경로를 status 나 `worker_done` 에 적게 한다
- `cleanup-sweep` 이 지시서 폴더의 `pr-<이름>.md` 를 지우는 동작은 그대로다. 옛 위치의 파일을 정리하는 용도로 문서와 주석에 밝힌다

## 4.1.0 (2026-10-26)

- `nudge-worker --state` 가 모델 오류로 멈춘 화면을 `error` 로, 사람이 Esc 로 끊은 Codex 화면을 `interrupted` 로 낸다. `--msg-id` 와 `--text` 는 두 화면에도 입력한다
- 상주 루프가 등록된 Run 의 worker 화면에서 같은 멈춤이 `pipeline.stall_ticks`(기본 `error` 2틱) 이어지면 `worker-stalled` 를 낸다. 핸들러가 없거나 0 이 아니면(10 은 넘김) 그 Run 에 `WORKER-STALLED` 가 온다
- 핸들러 환경에 `ORCH_SCRIPTS` 를 넘기고, 핸들러가 부른 `nudge-worker` 와 `send-to-worker` 가 가드에 막히지 않고 입력한다
- 고친 문제: `--run` 없이 띄운 루프의 알림을 대기가 읽지 않았다. 주 Run 이 바뀌면 진행 중인 실패가 새 주 Run 에 오지 않았다
- 고친 문제: `--stop --run` 이 다 읽은 알림 파일과 커서를 남겼다. 막 뜨는 루프에 합류한 Run 의 등록이 지워질 수 있었다

## 4.0.0 (2026-10-26)

- 상주 루프가 같은 저장소를 쓰는 여러 세션의 Run 을 함께 맡는다. `--start --run` 은 살아 있는 루프에 그 Run 을 더하고 `LOOP-JOINED` 와 0 이다
- `--stop --run` 은 그 Run 만 빼고 마지막 Run 이 빠지면 루프가 끝난다. `--run` 없는 `--stop` 은 등록된 Run 이 있으면 1 로 거부한다. 동시에 `--start` 해 진 쪽은 먼저 뜬 루프에 합류한다
- 질문 확인, 정리, `tick` 이 Run 마다 그 Run 범위로 돈다. 알림은 `state/loop-events/<Run>.jsonl` 로 나뉘고 대기는 자기 Run 의 알림에만 깨어난다. 옛 알림 파일은 옛 루프가 자기 Run 이거나 Run 없는 루프일 때만 읽는다
- 호환성: `tick` 핸들러가 틱마다 Run 수만큼 불린다. 저장소 공유 일은 입력의 `primary` 가 true 일 때만 한다. 옛 루프에는 Run 을 더하지 못하고 안내 줄을 낸다
- 호환성: `handoff-cleanup --run` 은 그 Run 의 지시서와 PR 본문만 옮기고 큐 로그, 폴더, csv 는 남긴다. `--run` 이 없으면 경고 한 줄을 낸다

## 3.x

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾸며 worker 가 작업 중이어도 적용한다. 옛 폴더 옮기기는 다른 저장소의 지시서에 막히지 않는다
- 저장소마다 상주 루프 `orch-loop.ts` 가 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 `wait-important --loop-repo` 를 깨운다
- worker 가 PR 이 머지될 때까지 맡고, 완료 검증은 `준비됨` 을 받은 때 한다. 지시서 하나는 PR 하나로 끝나는 크기로 쓴다
- `cleanup-sweep --remote-branches` 가 머지된 원격 브랜치를 지우고, 머지 큐가 머지한 브랜치를 base 로 둔 내 PR 의 base 를 옮긴다
- worker 를 띄우면 보드 항목을 만들고 루프가 PR 연결과 머지를 반영한다. 결정 필요 항목이 바뀌면 REMINDER 로 깨운다
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
