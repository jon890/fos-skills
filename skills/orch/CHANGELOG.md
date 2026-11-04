# CHANGELOG: orch

## 7.12.0 (2026-11-05)

- 스크립트를 `orch <묶음> <동작>` 으로 불러요. 플러그인 루트 `bin/orch` 가 PATH 에 실리고, Codex 와 사람 셸은 `orch doctor install-cli` 로 `~/.local/bin/orch` 를 깔아요
- 새 꼴은 저장소, Run, 지시서 폴더, 대기의 루프 저장소를 주지 않으면 작업 폴더와 코디네이터 터미널에서 읽고 출처를 stderr 한 줄로 남겨요
- user 범위 설치본이 있으면 그것만 써요. 옛 꼴 `bin/orch.ts <스크립트 이름>` 도 같은 스크립트를 부르고 stderr 에 새 꼴을 안내해요
- `NEXT_WAIT` 가 `orch wait --ack <id> --loop-repo <저장소>` 꼴로 짧아져요. 핸들러 환경에 진입점 경로 `ORCH_BIN` 이 더해져요
- doctor 가 `CLI-MISSING`, `CLI-STALE`, `CLI-NOT-ON-PATH`, `WAIT-STALE`, `OLD-CALL`, `DIRECT-PATH` 를 알리고, 문서의 새 꼴을 명령 표로 확인해요

## 7.11.1 (2026-11-05)

- orch 명령이 한 번 실행되는 동안 주 checkout 과 .orch 무시 여부를 한 번만 확인해, 상주 루프의 틱과 정리가 빨라진다. 실행 중에 지운 무시 줄은 다음 명령이 다시 더한다

## 7.11.0 (2026-11-05)

- 머지 뒤 마무리가 기능 PR 도 배포 확인 전에 워크트리, 브랜치, 빈 터미널을 지워요. 후속 검증이 대기면 지시서, 업무 완료, 보드만 남겨요
- 배포 브랜치에 연달아 머지해 배포가 skipped 로만 끝나면 끝 커밋의 배포를 기다리고, 끝 커밋도 skipped 면 배포 실패로 끝내요. 근거는 `배포 판정:` 줄에 남아요
- `remove-worktree` 도 끝난 worker 의 워크트리를 쥔 자식 없는 Orca 기본 셸 터미널을 닫고 지워요. worker 기록이 없는 워크트리의 셸과 자식이 있는 셸은 남겨요
- `cleanup-sweep` 이 PR 상태를 묶음 조회로 읽고, 머지를 확인한 브랜치는 끝 커밋이 그대로인 동안 다시 묻지 않아요

## 7.10.2 (2026-11-04)

- 버전 이름 설치 캐시도 설치 기록의 커밋으로 최신 여부를 판정한다

## 7.10.1 (2026-11-04)

- 머지 큐의 겹침 판정이 이름 변경의 옛 경로도 읽는다

## 7.10.0 (2026-11-04)

- 호환성: 설치 경로가 skills/orch 로 바뀌어요. 직접 참조와 개인 링크는 새 경로로 바꾸고 플러그인을 갱신해요.

## 7.9.0 (2026-11-04)

- `pipeline.refresh_slots` 를 켜면 상주 루프가 뒤처진 PR 의 `update-branch` 를 머지 차례 전에 PR 마다 걸어 CI 를 함께 돌린다. 판정은 머지 큐와 같은 `queue` 키로 한다
- 머지 큐는 보류한 PR 만 빼고 다음 PR 로 가는 것이 기본이다(옛 동작은 `--stop-on-hold`). 뺀 이유는 `QUEUE-DROPPED` 로 남고 worker 가 고칠 보류는 그 worker 에게 간다
- 차례 PR 이 update-branch 뒤 CI 를 기다리는 동안 겹치지 않고 준비된 뒤 PR 을 먼저 머지한다. 큐가 자동 머지를 막는 틱에는 `AUTO-MERGE-HELD` 를 남긴다
- `queue.poll_min_sec`, `poll_max_sec`, `ci_expected_sec` 로 체크 확인 간격을 정한다. 체크가 이미 끝났으면 다시 보는 60초를 건너뛴다
- 기능 완료 근거의 검증 커밋 뒤에 base 를 합친 merge 커밋만 있으면 통과로 보고, 지금 HEAD 의 CI 통과로 갈음한다

## 7.8.1 (2026-11-04)

- 문서 표현만 고쳤다. 동작은 바뀌지 않았다

## 7.8.0 (2026-11-04)

- 기능 PR 의 현재 커밋·인수 검증·문서 대조·독립 리뷰 근거를 머지 전에 확인하고, 후속 검증 뒤 정리해요.

## 7.7.0 (2026-11-04)

- `reserve-migration` 에 `--kind adr` 를 더했다. orch 설정 `adr.dirs` 의 폴더마다 base, 열린 PR, 남은 예약을 넘는 ADR 번호를 예약하고 `<번호>-<설명>.md` 경로를 낸다
- ADR 예약은 `state/adr-reservations.json` 에 따로 두고 자동 머지는 읽지 않는다. `--prune` 은 마이그레이션과 ADR 예약을 함께 정리한다
- 공통 지시서 틀에 ADR 번호 예약 줄(`adr`)을 더했다. `spec-lint` 는 `adr.dirs` 가 있는 저장소에서만 그 표지를 요구한다

## 7.6.0 (2026-11-04)

- 사용자와 대화 중이면(마지막 입력 10분 안) 코디네이터는 깨어난 대기를 다시 걸지 않는다. `user-active` 가 판정하고, 상주 루프는 그동안 `NO-WAIT` 와 `decision-pending` 전달을 미룬다
- `decision-pending` 전달이 실패하면 10분부터 두 배씩 기다렸다 다시 낸다. 보드 decide 항목의 `참고:` 줄은 결정으로 세지 않는다
- `send-to-worker` 가 `dispatch_inactive`, `answer_conflict` 로 거절된 질문을 닫은 질문으로 적는다. `worker-ask` 는 `runtime_busy` 면 기다렸다 다시 묻고, 끝난 dispatch 의 오류일 때만 Run 메일함으로 보낸다
- doctor 의 `LOOP-STALE` 이 지금 세션 프로필의 user 범위 설치본과 비교한다. `ORCA-SHAPE` 로 Orca 출력 형식 변경을 알린다. worker 터미널 send hook 은 살아 있는 터미널 상태만 읽고 판정을 10분 기억한다
- `board-sync` 가 단계를 모두 끝냈고 열린 PR, 워크트리, 남은 일 줄이 없는 doing 항목을 done 으로 바꾼다

## 7.5.0 (2026-11-04)

- 공통 지시서 틀에 검토 하위 에이전트를 요청하는 줄(`review-subagents`)을 더했다. Codex worker 도 하위 에이전트로 검토자를 띄운다
- `spec-lint` 가 표지 붙은 항목의 본문을 틀과 비교해 다르면 `공통` 경고를 낸다. 보드 고치기 금지 줄에 `no-board-edit` 표지를 달았다
- 마이그레이션 번호 예약 문구를 틀로 옮겼다(`migration`). orch 설정에 `migrations` 가 있을 때만 요구하고, `reserve-migration` 은 `--base` 의 `origin/` 을 뗀다
- `spec-lint` 가 지시서의 임시 폴더 경로를 `임시` 경고로 알린다. 재개 절은 회신 내용을 본문에 옮겨 적는다
- `launch-worker --worktree` 가 커밋 안 된 변경이 있으면 거부한다. 이어받을 때는 `--dirty-ack <이유>` 를 준다

## 7.4.0 (2026-11-03)

- 공부 후보를 사용자 질문이나 결정에서 일반 기술 개념이 판단을 바꿨을 때 적는다. 뜻을 물은 경우도 포함한다
- 저장소 밖에서도 통하고, 트레이드오프가 선택을 정했고, 더 볼 자료가 있고, 한두 문장으로 끝나지 않는 개념만 적는다
- 공통 지시서 틀에 「공부 후보 보고」 절을 더했다. worker 도 같은 기준으로 적고 `worker_done` 에 「공부 후보 N건」 을 싣는다
- 하루 끝 고르기를 뺐다. 후보는 계속 쌓고, 사용자가 고른 후보를 오버레이의 글 쓰기 스킬로 잇는다

## 7.3.0 (2026-11-03)

- 검증 절차·기대값·결과를 보존하고 공통 문서 변경이 겹치는 작업을 조율해요.

## 7.2.0 (2026-11-03)

- `send-to-worker` 가 `stable_pane_required` 로 거부되면 status 로 바꾸기 전에 `--run`, `--from` 없는 reply 를 한 번 보낸다
- 멈춤 확인은 구조화 worker 의 화면을 읽지 않고 worker-show 의 단계와 마지막 오류로 판정한다
- 마일스톤 항목은 마지막 PR 을 판정하지 못했거나 done 지점 뒤에 끝나지 않은 수동 단계가 남으면 done 으로 바꾸지 않는다
- 리뷰 worker 의 `worker_done` 은 결과 status(`판정:`, `완료:`, `미완료:` 줄)를 완료 근거로 센다
- `cleanup-sweep` 이 끝난 리뷰의 변경 없는 detached 워크트리와 `review/pr-N` 을 지운다. 공통 지시서 틀의 기능 루프에 technical-design 을 넣었다

## 7.1.0 (2026-11-03)

- 자동 머지의 리뷰 판정을 저장소마다 `queue.auto_review.require` 의 조건 조합으로 고른다. 조건은 `verdict-on-head`, `verdict-seen`, `last-verdict-pass`, `rereview-after-block` 이다
- `require` 를 적지 않은 저장소는 지금 HEAD 의 판정만 세는 이전 동작(`verdict-on-head`)과 같다. 미해결 스레드 0 은 조합과 상관없이 늘 본다
- 모르는 조건 이름이 있으면 상주 루프는 멈추지 않고 PR 만 걸지 않으며, `orch-doctor` 가 `INVALID-CONFIG` 로 알린다
- 큐를 걸 때 PR 마다 통과 근거(조건, 판정, 커밋이나 댓글, 시각)를 `AUTO-MERGE-BASIS` 줄로 루프 로그에 남긴다
- `AUTO-MERGE-NO-REVIEW` 는 HEAD 범위가 아닌 조건이 막았으면 `HEAD <SHA> 의 PR 에 … (<조건>)` 꼴로 알린다

## 7.0.0 (2026-11-03)

- 기술 설계 단계를 연결하고 기능별 계획 전체 경로를 인계해요.

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
