# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 3.5.0 (2026-10-25)

- KILL 유예, 질문 조회 시간 제한, 루프 재확인 여유를 `ORCH_KILL_GRACE_SEC`, `ORCH_QUESTIONS_TIMEOUT_SEC`, `ORCH_LOOP_RECHECK_MARGIN_SEC` 로 바꿀 수 있다. 기본값은 그대로다
- 이벤트 핸들러의 잠금 대기는 시간 제한에 KILL 유예의 1.5배를 더한다. 기본은 전과 같은 15초다

## 3.4.1 (2026-10-25)

- README 를 스킬을 쓰는 사람 관점으로 다시 쓰고, 이 CHANGELOG 를 버전마다 핵심만 남기도록 줄였다. 동작은 바뀌지 않았다

## 3.4.0 (2026-10-25)

- 저장소마다 하나 도는 상주 루프 `orch-loop.ts` 를 더했다. 틱마다 질문 확인, 정리, 보드 동기화, 내 PR 의 CI 감시, 충돌 PR 알림을 하고 머지는 하지 않는다
- `wait-important --loop-repo` 가 루프의 알림(`LOOP-EVENT`, 종료 코드 7)과 루프의 죽음(`LOOP-DEAD`, 8)에도 깨어난다
- 루프가 `ci-passed`, `ci-failed`, `tick`, `pr-conflict` 이벤트를 낸다. `orch-doctor --run` 은 죽은 루프와 다시 띄울 명령을 알린다
- 기다리기 절차를 루프 기준으로 바꿨다. Monitor 로 띄우는 `watch-questions` 는 루프를 쓸 수 없을 때의 대안이다
- 호환성: 루프를 쓰는 저장소는 `watch-questions` 를 따로 띄우지 않는다. `watch-questions.ts` 는 `poll` 을 export 하지 않는다

## 3.3.0 (2026-10-25)

- 정리와 대기열 명령(`cleanup-sweep`, `remove-worktree`, `handoff-cleanup`, `heavy-slot` 등)과 보드 명령이 TypeScript 로 돈다. 옛 `.py` 는 shim 으로 남는다
- `cleanup-sweep` 이 `before-cleanup`, `after-cleanup` 이벤트를 내고, `--remote-branches` 로 머지된 원격 브랜치를 지운다
- `.orch/config.json` 의 `heavy` 절로 무거운 검사를 분류하고, `wait_idle` 로 대기열 밖의 무거운 프로세스가 끝나길 기다린다
- 호환성: `heavy-slot` 의 자동 분류를 지웠다. `heavy` 절이 없으면 모든 명령이 자리를 기다리고, perl 이 PATH 에 필요하다
- 호환성: `cleanup-sweep`, `handoff-cleanup` 의 출력 줄 일부가 바뀌었다. `scripts/run-orch-tests.py` 를 지우고 `node --test` 하나로 돌린다

## 3.2.0 (2026-10-24)

- worker 가 PR 이 머지될 때까지 맡는다. PR 이 열리면 `준비됨` 을 보내고 CI 실패, 충돌, 리뷰를 직접 처리한 뒤 MERGED 를 확인하고 `worker_done` 을 보낸다
- 지시서 하나는 PR 하나로 끝나는 크기로 쓴다. 더 큰 일은 나눠 앞 PR 이 머지된 뒤 다음 지시서를 쓴다
- 완료 검증은 `준비됨` 을 받은 때 한다. `worker_done` 을 기다리지 않고 diff 를 읽고 머지 큐에 넣는다

## 3.1.0 (2026-10-24)

- 머지 단계 명령(`ci-ready`, `notify-conflicts`, `merge_queue`, `merge-with-finish`, `finish-pr`)이 TypeScript 로 돌고 `before-merge`, `after-deploy` 같은 이벤트를 낸다
- 업무 완료는 `after-deploy` 핸들러가 한다. `migrate-orch-dir --hooks` 가 `config.json` 의 옛 셸 명령 칸을 같은 일을 하는 `hooks/<이벤트>.ts` 로 바꾼다
- 머지한 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 머지 큐가 그 PR 들의 base 를 옮긴 뒤 원격 브랜치를 지운다
- 호환성: `ci-ready` 는 로컬 merge-tree 로 충돌을 보고 남의 PR 은 보류한다. `notify-conflicts` 는 내 PR 만 보고, 이어 쓰지 못하면 `CONFLICT-ORPHAN` 을 낸다
- 호환성: 옛 설정 칸도 이벤트 실행기로 돌아 1800초 제한을 받는다. `after-merge` 나 `after-queue` 가 실패하면 머지 큐는 종료 코드 3 이다

## 3.0.0 (2026-10-24)

- hook 과 띄우기, 답하기, 기다리기 명령, `orch-doctor` 가 TypeScript 로 돈다. 옵션과 종료 코드는 그대로이고, 저장소의 `.orch/hooks/<이벤트>.ts` 를 부른다
- worker 터미널 직접 입력 금지 hook 이 모든 Run 의 worker 를 보고, 대상이 변수이거나 orca 조회가 실패하면 거부한다
- `orch-doctor` 가 이름이 틀린 핸들러를 `UNKNOWN-HOOK`, 지울 설정 칸을 `DEPRECATED-CONFIG` 로 알린다. 질문 감시의 조회 실패는 stdout 의 `WATCH-ERROR` 줄로 낸다
- 호환성: 옛 `.py` 경로는 `DEPRECATED` 줄을 내고 `.ts` 로 넘기며 다음 major 에서 지운다. node 22.18 이상이 없으면 종료 코드 127 로 끝난다
- 호환성: stdout 에 `WATCH-ERROR`, `HOOK-FAIL` 줄이 섞이고 ps 명령줄이 `node … <이름>.ts` 로 바뀐다. 가짜 orca 는 `ORCA` 환경 변수로 넣는다

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
