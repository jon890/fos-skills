# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.2.0

worker 의 ask 가 도구 시간 제한에 걸리거나 끝난 Dispatch 에서 거절되던 문제를 스크립트로 막는다.

- `scripts/worker-ask.sh` 를 더했다. ask 를 부르고, 시간 제한이면 종료 코드 4 와 메시지 ID 를, ask 가 실패하면 `send --to run:<id> --type question` 으로 대신 보내고 종료 코드 3 을 낸다. Run 은 `--run` 이 없으면 `check --peek` 의 runId 로 찾는다
- 공통 지시서 틀에 worker 가 이 스크립트를 `run_in_background` 로 돌리고 완료 알림을 기다린다는 줄과 `{{ORCH_SCRIPTS}}`, `{{RUN_ID}}` 를 더했다
- 가짜 orca 로 성공, 시간 제한, 대신 보내기, zsh 에서 부르는 경우를 테스트했다

## 1.1.0

`merge-queue.sh` 가 체크가 시작되기 전에 머지하는 문제와 오래된 base 위에서 통과한 PR 이 머지되는 문제를 막는다.

- 필수 체크가 모두 나타나고 끝날 때까지 기다린다. 이름은 `--required a,b,c` 로 받고, 없으면 저장소 규칙의 `required_status_checks` 에서 읽는다. 규칙 조회가 실패하면 멈추고, 목록이 비어 있으면 경고하고 예전처럼 지금 있는 체크만 기다린다
- `--require-up-to-date` 선택 옵션을 더했다. PR 이 base 최신을 품지 않으면 `update-branch` 로 base 를 merge 하고 필수 체크를 다시 기다린 뒤 머지한다. 기본은 끔이고 저장소 오버레이가 켠다
- 정리와 머지 단계 reference 에 두 동작의 이유를 적었고, 오버레이 항목 표의 머지 조건에 두 값을 더했다
- 가짜 gh 로 두 동작의 테스트를 더했다

## 1.0.0

개인 지침에 있던 Orca orchestration 운영 절차를 스킬로 옮겼다.

- 7단계(에이전트 고르기, 지시서 쓰기, 띄우기, 기다리기, 답하고 지시 보내기, 완료 검증, 머지와 정리)를 개요 표와 단계별 reference 로 나눴다
- `merge-queue.sh` 를 더했다. 저장소 경로와 호스트, 스레드 조회 명령을 인자로 받고, PR 마다 머지 전 명령을 `PR:명령` 이나 `--before` 로 받는다. 체크 완료 대기, mergeable UNKNOWN 재시도, 미해결 스레드 확인을 하고, 체크를 보기 전에 고정한 HEAD 를 머지 직전의 PR HEAD, 원격 브랜치 HEAD 와 대조한다. release 브랜치와 다른 열린 PR 의 base 인 브랜치는 지우지 않는다
- `triage-messages.py` 를 더했다. `worker_done`, `escalation`, `question` 을 따로 모으고 heartbeat 는 개수만 낸다. `--live --since` 로 지난 시각부터 다시 본다
- `remove-worktree.sh` 를 옮겼다. 쓰는 프로세스, 미커밋 변경, 원격에 없는 커밋이 있으면 지우지 않는다
- `goal-progress.py` 를 더했다. 추적 항목 목록을 인자나 파일로 받아 보드 목표 항목의 진행 표시줄을 다시 계산한다
- `templates/spec-common.md` 에 저장소와 무관한 공통 지시서 틀을 두었다
- 저장소 오버레이 `<repo>/.claude/orch-overlay.md` 를 먼저 읽고, 적을 항목은 `references/overlay.md` 가 정한다
- 머지마다 정리, 충돌 파일을 한쪽으로 통째 고르지 않기, worker 의 확인 창을 대신 승인하지 않기, 막힌 PR 생성과 리뷰 회신을 코디네이터가 대신 하기를 해당 단계에 넣었다
