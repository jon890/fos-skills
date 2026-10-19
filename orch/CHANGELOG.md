# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.9.0

GitHub Enterprise 저장소에서 머지 큐가 멈추던 문제와, 끝난 worker 의 프로세스가 워크트리를 쥐어 정리가 매번 거부되던 문제를 스크립트로 막는다.

- `merge-queue.sh`: `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 기본 호스트로 가서, GHE 저장소에서 필수 체크 규칙 조회와 `--require-up-to-date` 의 base 비교가 실패했다. PR URL 의 호스트(`GH_HOST` 가 있으면 그 값)를 모든 `gh api` 에 `--hostname` 으로 넘기고, 스레드 조회 명령과 머지 전 명령에는 `GH_HOST` 로 넘긴다
- `cleanup-sweep.py --kill-holders`: PR 이 MERGED 이고, 그 경로의 worker 가 모두 succeeded 나 fenced 이고, Orca 터미널이 남지 않았을 때만 작업 디렉터리가 그 경로 아래인 프로세스를 TERM, HUP, KILL 순으로 끈다. 자기와 조상 프로세스는 뺀다. 열린 파일로만 쥔 프로세스는 다른 워크트리의 빌드도 맡을 수 있어 끄지 않는다
- 기본은 끔이다. 코디네이터 흐름 밖에서 돌릴 때 사용자 셸을 끄지 않게 하고, 대기와 정리 reference 의 코디네이터 명령에 옵션을 넣었다
- `remove-worktree.sh`: 거부 줄에 그 경로를 쓰는 pid 를 낸다
- 가짜 gh 로 GHE URL 과 `GH_HOST` 의 호스트 전달을, 가짜 kill 로 TERM 을 무시하는 셸, KILL 까지 가는 경우, 옵션 없음, worker 를 모름, 끝나지 않은 dispatch, 남은 터미널, dry-run 을 테스트했다

## 1.8.0

정리 스크립트가 예전에 머지된 PR 과 이름만 같은 새 브랜치의 워크트리를 「머지됨」 으로 지우던 문제와, 워크트리 브랜치 이름이 지시서와 어긋나던 문제를 구조로 막는다.

- `cleanup-sweep.py`: 어느 이름으로 찾았든 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 로 본다. base 위 커밋이 0 개면 PR HEAD 와 정확히 같을 때만 인정한다. 걸린 PR 만 있으면 「이름만 같은 PR」 로 남긴다
- `remove-worktree.sh --merged-head`: HEAD 가 그 커밋과 같거나 그 조상이 아니면 거부한다
- 새 `make-worktree.sh`: 지시서의 `` 브랜치: `<이름>` `` 줄을 읽어 `origin/<기준 브랜치>` 위에 그 이름으로 워크트리를 만들고, exclude 와 로컬 설정 복사를 같이 한다. 같은 이름의 로컬, 원격 브랜치나 경로가 있으면 거부한다. `--check` 는 push 한 브랜치가 지시서 값과 같은지 본다
- 띄우기 reference 를 `make-worktree.sh` 다음 `--worktree path:` 로 바꾸고, 완료 검증에 `--check` 를 더했다. 지시서 reference 에 `브랜치:` 줄 형식과 push 명령을 정했다
- 이름 변형으로 PR 을 찾는 코드는 Orca 이름으로 만든 옛 워크트리를 위해 남긴다. 모든 후보에 커밋 검사를 하므로 이름이 우연히 맞아도 지우지 않는다
- 「옛 머지 PR 과 같은 이름의 새 브랜치」 세 경우, 일반 merge PR, `remove-worktree.sh` 거부, `make-worktree.sh` 를 테스트했다

## 1.7.0

끝난 워크트리, 세션, 브랜치가 말하지 않아도 정리되게 `cleanup-sweep.py` 가 건너뛰던 경우를 처리한다. 운영에서 코디네이터가 매번 직접 지우던 다섯 경우다.

- PR 찾기: upstream 의 원격 브랜치 이름, `branch.<b>.merge`, 로컬 이름, 이름 변형(사용자 접두 제거, 첫 하이픈을 슬래시로) 순으로 `gh pr list --head` 를 부른다. 변형으로 찾은 PR 은 브랜치의 커밋이 모두 PR HEAD 의 조상일 때만 쓰고, fork 에서 온 PR 은 건너뛴다
- PR 조회 결과를 JSON 으로 읽는다. 빈 목록은 「PR 없음」, 파싱 실패나 모르는 state 는 「조회 실패」 이고 둘 다 머지로 읽지 않는다
- PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 를 받아 와 `--merged-head` 로 넘긴다. 머지 큐의 update-branch 로 PR HEAD 가 앞서 간 squash 머지도 지워진다
- 터미널을 닫고 기다린 뒤에도 남은 프로세스가 전부 자식 없는 로그인 셸이고 그 경로에 Orca 터미널이 있으면, PR 이 MERGED 일 때 그 터미널을 `orca terminal close` 로 닫고 다시 기다린다. 다른 프로세스가 남으면 건너뛴다
- `--repo` 를 여러 번 받는다. 저장소 하나를 읽지 못해도 나머지는 돌고 종료 코드만 2 다. `--base` 를 주지 않으면 저장소마다 `origin/HEAD` 를 읽는다
- 원격 브랜치는 PR 의 head 이름, upstream, 로컬 이름으로 찾아 지운다. 기준 브랜치, `release/*`, 다른 열린 PR 의 base 는 지우지 않고, 끝점이 머지된 PR HEAD 와 다르면 그 뒤에 커밋이 더해진 것이므로 남긴다
- 대기와 정리 reference 에 「사용자가 말하지 않아도 깨어날 때마다 자동으로 돈다」 와 여러 저장소 예시를 적었다
- 가짜 gh, orca, lsof, ps 로 다섯 경우와 「PR 조회가 비거나 깨지면 지우지 않는다」 를 테스트했다

## 1.6.0

지시서를 scratchpad 가 아니라 대상 저장소의 git 무시 폴더에 쓰게 한다. 코디네이터 세션이 다시 시작되면 scratchpad 가 정리돼 지시서가 사라지던 문제를 막는다.

- `spec-writing.md`: 기본 폴더 `<repo>/.omc/orch/specs/`, 파일 이름 `spec-<worktree 이름>.md`, 공통 지시서 `spec-common.md` 를 정했다. 오버레이가 다른 폴더를 정하면 그것을 따른다
- 쓰기 전에 `git check-ignore` 로 무시 여부를 보고, 무시되지 않으면 공유 `.gitignore` 가 아니라 `.git/info/exclude` 에 더한다

## 1.5.1

korean-check 새 금지어(`손으로`, `거르다`)에 걸린 문구를 고친다.

- 보드, 정리, 검증, 대기 reference 의 `손으로` 와 `거르다` 활용형을 권장 표현으로 바꿨다. 동작은 그대로다

## 1.5.0

보드 동기화가 단계가 남은 항목을 끝낸 것으로 바꾸던 문제와, 목표 진행률이 추적 id 목록에 매이던 문제를 고친다. 실제 보드에서 먼저 고쳐 실측한 규칙을 옮겼다.

- `board-sync.py`: PR 이 MERGED 여도 끝나지 않은 단계가 2개 이상이면 done 으로 바꾸지 않는다. 그 PR 번호가 적힌 단계에만 「✓ 」 를 붙이고 pr 칸을 비운다. 1개 이하일 때만 done 과 남은 단계 ✓ 다
- `goal-progress.py`: 추적 항목을 주지 않으면 목표 항목 자신의 단계 줄(숫자로 시작, 끝나면 「✓ 」)을 센다. 숫자로 시작하지 않는 줄은 세지 않는다. 추적 id 를 주는 기존 사용법은 그대로다
- `board-sync.py --goal` 은 `--goal-items` 없이도 쓴다
- 보드 reference 에 새 규칙과, mod 가 단계로 세면 `goal-progress.py` 를 걷어 낸다는 것을 적었다

## 1.4.0

필수가 아닌 체크가 코드와 무관한 이유로 실패했을 때 코디네이터가 직접 머지하던 일을 막는다. 2026-10-13 fos-accountbook PR #469 에서 `claude-review` 가 리뷰 계정의 주간 한도로 실패했고, 스크립트가 멈출지 미리 알 수 없었다.

- `merge-queue.sh` 에 `--allow-fail A,B` 를 더했다. 이름이 든 체크의 실패는 멈춤 조건에서 빼고 머지 전에 `경고: <PR> 실패를 허용한 체크 <이름>` 줄을 찍는다. 기본 동작(실패하면 멈춤)은 그대로다
- `--required` 나 저장소 규칙의 필수 체크에 든 이름은 허용하지 않는다. 옵션 값이 겹치면 종료 코드 2, 규칙에서 읽은 이름과 겹치면 `STOP` 이다. 따옴표와 역슬래시는 `--required` 처럼 막는다
- 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다
- 정리 reference 의 머지 절에 쓰는 때와, 실패를 허용하는 이유를 사용자에게 알린다는 규칙을 적었다

## 1.3.0

머지 뒤 정리와 보드 갱신을 손에서 스크립트로 옮긴다. 머지된 worktree 와 브랜치, worker 터미널과 지시서가 남고, 보드가 늦게 반영되던 문제다.

- `scripts/cleanup-sweep.py` 를 더했다. PR 이 MERGED 이거나 upstream 이 gone 이고 base 에 없는 커밋이 0 개인 브랜치의 worktree 를 정리한다. 커밋 안 된 변경, 원격에 없는 커밋, 살아 있는 worker, 경로를 잡은 프로세스가 있으면 이유를 내고 건너뛰며, 다음 실행에서 다시 판정한다. 기본은 dry-run 이다
- 살아 있는 worker 는 workerState 가 working 이나 ready 이거나, Dispatch 상태와 상관없이 터미널이 `orca terminal list` 에 살아 있는 worker 다. 터미널은 PR 이 MERGED 일 때만 닫고, 아니면 그 경로에 살아 있는 터미널이 있을 때 건너뛴다
- `remove-worktree.sh` 에 `--merged-head` 를 더했다. squash 머지된 커밋을 원격에 없는 커밋으로 세지 않는다
- `merge-queue.sh` 가 모든 PR 을 머지한 뒤 `cleanup-sweep.py --apply` 를 부른다. `--sweep-arg` 로 인자를 넘기고 `--no-sweep` 으로 끈다
- `scripts/board-sync.py` 를 더했다. PR 이 MERGED 인 항목을 done 으로 바꾸고 남은 단계에 「✓ 」 를 붙인 뒤 `goal-progress.py` 를 부른다. 상태 줄은 쓰지 않고, 예전 버전이 남긴 「자동: 」 줄은 지운다
- 보드 reference 에 하위 줄은 번호 붙은 단계만 두고 끝나면 「✓ 」, 진행은 `--progress 끝낸/전체` 로 적는 규칙을 적었다
- 기다리기 단계에 깨어날 때와 5분마다 두 스크립트를 돌린다고 적고, 오버레이 표에 지시서 폴더 칸을 더했다
- 가짜 gh, orca, lsof 와 실제 git 저장소로 각 판정 갈래를 테스트했다

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
