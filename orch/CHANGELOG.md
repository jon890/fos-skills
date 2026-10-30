# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 5.4.0 (2026-10-30)

- 호환성: 기존 사용자 결정 `REMINDER`는 `DECISION-PENDING`으로 바뀐다. 저장소의 `worker-question` 핸들러로 결정 재알림을 받았다면 `decision-pending` 핸들러로 옮긴다
- `send-to-worker` 가 최신 미답변 질문에 먼저 답한다. 별도 지시는 `--no-reply` 로 보내고 재전송 질문은 뒤 질문에 답하면 보드와 감시에서 함께 해결된다
- `wait-important` 가 다음 대기 명령을 안내한다. 코디네이터는 메시지를 처리한 직후 다시 대기한다
- 상주 루프가 새 사용자 결정과 보드의 남은 결정 줄을 찾으면 `decision-pending` 기본 핸들러로 현재 코디네이터에게 묻기를 요청한다. 같은 결정은 반복해서 깨우지 않는다
- `migrations.watch` 로 감시 전용 폴더를 더한다. 예약 파일은 계속 `migrations.dirs` 의 폴더에 만든다

## 5.3.0 (2026-10-30)

- 체크 스냅샷은 PR HEAD 별로 공유한다. 진행 중이면 짧게, 완료됐으면 길게 캐시하고 멈춤·머지 직전에 다시 읽는다
- HEAD, 충돌, 리뷰, ready 판정 조회는 공유 캐시를 건너뛴다
- 같은 HEAD 와 워크플로에 더 늦게 시작한 실행이 있으면 옛 취소 실행을 실패로 세지 않는다. 체크 조회 중 HEAD 가 바뀌면 머지를 멈춘다

## 5.2.0 (2026-10-30)

- 호환성: 5.0.0의 major 정리에 이어 옛 설정 칸과 옵션을 지운다. `migrate-orch-dir --hooks`로 변환한다
- 호환성: `queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd` 설정을 지웠다
- 호환성: `--before`, `--verify-merged`, `--after-merged`, `--complete-cmd` 옵션을 지웠다
- `before-merge` 입력에 `has_pr_command`를 더했다. 변환한 기본 명령은 PR별 명령이나 빈 `PR:`이 있으면 건너뛴다

## 5.1.0 (2026-10-30)

- `adopt-sessions` 로 살아 있는 dispatch 에서 떨어진 터미널과 지시서·PR·화면 상태를 찾고, `--apply` 로 선택한 에이전트를 새 Run 에 이어 붙인다. 기본 실행은 조회만 한다
- 끊긴 worker 알림에서 이어받기 명령을 안내한다. 압축이나 계정 전환 뒤에도 이전 세션을 찾는다
- 입력 hook 이 끝난 dispatch 의 남은 터미널도 찾아 바로 차단하고 이어받기를 안내한다. 조회 시간이 초과되면 조회 횟수와 마지막 명령을 함께 알린다
- 설치 기록과 다른 캐시 번들의 스크립트를 직접 부르면 현재 진입점 경로를 경고한다

## 5.0.0 (2026-10-30)

- 호환성: `orch/scripts` 의 `orch-doctor.py`, `ts_shim.py` 외의 옛 `.py` 진입점과 `merge-queue.sh` 를 지웠다. 명령은 `"$SKILL_DIR/bin/orch.ts" <이름>` 이나 같은 이름의 `.ts` 로 부른다
- 호환성: 옛 `.py` 이름으로 부르던 저장소 스크립트와 기억한 명령은 `bin/orch.ts <이름>` 으로 바꾼다
- `orch-doctor.py` 는 공식 점검 진입점으로 남는다. `ts_shim.py` 가 Node 24 미만이면 `NODE-TOO-OLD` 로 멈춘다
- 옛 구조 안내가 옮기는 명령을 `node --disable-warning=ExperimentalWarning <경로>/migrate-orch-dir.ts` 로 알린다

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
