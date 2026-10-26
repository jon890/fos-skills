# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 4.0.0 (2026-10-26)

- 상주 루프가 같은 저장소를 쓰는 여러 세션의 Run 을 함께 맡는다. `--start --run` 은 살아 있는 루프에 그 Run 을 더하고 `LOOP-JOINED` 와 0 이다
- `--stop --run` 은 그 Run 만 빼고 마지막 Run 이 빠지면 루프가 끝난다. `--run` 없는 `--stop` 은 Run 이 둘 이상이면 1 로 거부하고 `--all` 로 모두 멈춘다
- 질문 확인, 정리, `tick` 이 Run 마다 그 Run 범위로 돈다. 알림은 `state/loop-events/<Run>.jsonl` 로 나뉘고 대기는 자기 Run 의 알림에만 깨어난다
- 호환성: `tick` 핸들러가 틱마다 Run 수만큼 불린다. 저장소 공유 일은 입력의 `primary` 가 true 일 때만 한다. 옛 루프에는 Run 을 더하지 못하고 안내 줄을 낸다
- 호환성: `handoff-cleanup --run` 은 그 Run 의 지시서와 PR 본문만 옮기고 큐 로그, 폴더, csv 는 남긴다. `--run` 이 없으면 경고 한 줄을 낸다

## 3.x

- 명령이 TypeScript 로 돌고 단계마다 이벤트를 낸다. 저장소 고유 일은 `.orch/hooks/<이벤트>.ts` 가 맡고, 옛 `.py` 경로는 shim 으로 남는다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 옛 셸 명령 칸을 핸들러로 바꾼다. 옛 폴더 옮기기는 다른 저장소의 살아 있는 지시서에 막히지 않는다
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
