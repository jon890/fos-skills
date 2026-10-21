# orch

Orca orchestration 으로 worker 를 띄워 PR 머지까지 끝내고, 머지 뒤 워크트리와 브랜치, 대기 프로세스를 남기지 않는 코디네이터 절차다.

## 산출물

| 산출물 | 내용 |
| --- | --- |
| 지시서 | 저장소 공통 지시서 한 파일과 worker 마다 범위와 완료 기준을 적은 파일 |
| 머지된 PR | 체크, 미해결 스레드, 원격 HEAD 를 확인하고 머지 전 명령을 돌린 뒤 머지한 PR |
| 정리된 작업 공간 | 머지마다 dispatch, 워크트리, 로컬과 원격 브랜치, 그 작업만의 문서를 지운 상태 |
| 마무리된 업무 | 배포 성공을 확인한 뒤 업무를 완료 처리하고 보드를 done 으로 바꾼 상태 |

## 구성

- `SKILL.md`: 목표, 원칙, 7단계 개요 표
- `references/`: 단계마다 하나씩 규칙과 복구 절차. `overlay.md` 는 저장소 오버레이에 적을 항목, `board.md` 는 진행 보드 연동
- `templates/spec-common.md`: 저장소와 무관한 공통 지시서 틀
- `scripts/merge-queue.sh`: PR 을 순서대로 확인하고 머지한다. 머지 전 명령을 PR 마다 받는다. PR 이 고친 파일을 base 도 고쳤으면 멈추거나(`--stop-on-overlap`) base 와 합친 임시 사본에서 검사 명령을 돌린 뒤 머지한다(`--verify-merged`). 겹치지 않은 코드 PR 도 검사하게 하거나(`--verify-merged-when`) 문서 PR 은 검사 없이 머지하고(`--docs-glob`), 보류한 PR 을 건너뛰고 다음 PR 로 갈 수 있다(`--continue-on-hold`)
- `scripts/merge-with-finish.py`: 머지 큐를 걸면서 PR 마다 `finish-pr.py` 를 함께 건다. PR 번호 뒤 `!` 는 업무의 마지막 PR 이다. 같은 PR 의 마무리가 이미 돌면 다시 걸지 않는다. 명령줄에 없는 머지 큐 옵션은 `orch-finish.json` 의 `queue` 절에서 채운다. 머지 큐는 기본으로 이 스크립트로 건다
- `scripts/finish-pr.py`: 머지를 `gh` 로 확인한 뒤 그 브랜치의 worker 를 정리하고, 머지 커밋이 들어간 배포의 성공을 기다리고, 업무를 완료 처리하고, 보드를 done 으로 바꾼다. 끝에 `FINISH-DONE` 이나 `FINISH-FAIL` 을 낸다
- `scripts/handoff-cleanup.py`: 끝난 큐 로그, 끝난 지시서, 오래된 handoff 폴더와 미리보기, 지난 csv·tsv 를 휴지통 폴더로 옮긴다. 기본은 후보만 보이고 `--apply` 로 옮긴다
- `scripts/ci-ready.py`: draft PR 을 ready 로 바꿔 CI 를 시작한다. 이미 ready 인 PR 과 파일이 겹치거나 base 와 충돌하면 보류한다. 바뀐 파일은 REST 로 읽는다. draft 로 CI 를 미루는 저장소에서만 쓴다
- `scripts/wait-important.py`: worker_done, question, escalation, status 가 든 묶음이 올 때까지 기다린다. heartbeat 만 든 묶음은 ack 하고 계속 기다리고, 마지막 줄에 다음 `--ack` 로 넘길 delivery id 를 낸다. 다른 대기가 자리를 쥐고 있으면(`waiter_exists`) 되풀이하지 않고 남은 대기 프로세스를 보여 준다
- `scripts/nudge-worker.py`: 메시지를 보낸 뒤 worker 화면이 입력 대기면 「check 로 읽어라」 를 넣고 턴 시작을 확인한다. 보이지 않으면 `--retry-request` 로 한 번 더 확인한다
- `scripts/spec-line.py`: 지시서의 `허락:` 줄을 붙여 `worker-start --spec` 에 넘길 첫 지시 줄을 만든다
- `scripts/launch-worker.sh`: `spec-line.py` 로 첫 지시 줄을 만들고 새 워크트리는 `make-worktree.sh` 로 만든 뒤 띄운다. 기존 워크트리에 터미널이 남아 있으면 거부하고, 띄운 뒤 `worktree_creating` 에서 멈추면 abandon 하고 한 번 다시 띄운다
- `scripts/send-to-worker.py`: dispatch 가 살아 있으면 `reply`(이미 답한 question 은 건너뜀)와 `nudge-worker.py`, 끝났으면 남은 터미널에 후속 지시서로 띄우고, 끝났는데 아직 일하는 터미널에는 본문을 넣고, 터미널도 없으면 새로 띄우라고 알린다
- `scripts/notify-conflicts.py`: 머지 직후 열린 PR 가운데 base 와 충돌하는 것과 충돌 파일을 내고, (PR, base SHA) 마다 한 번만 그 worker 에게 base 를 합치라고 보낸다
- `scripts/triage-messages.py`: orca 메시지를 종류별로 모으고 heartbeat 는 개수만 낸다
- `scripts/make-worktree.sh`: 지시서의 `브랜치:` 이름으로 `origin/<기준 브랜치>` 위에 워크트리를 만들고 exclude 와 로컬 설정 복사, `worktree-deny.py` 의 deny 규칙 추가를 한다. `--check` 는 push 한 브랜치가 지시서 값과 같은지 본다
- `scripts/worktree-deny.py`: 워크트리의 `.claude/settings.local.json` 에 다른 worker 의 자원을 빼앗는 명령(pkill, killall, browser-driver reset)과 `gh pr merge` 의 deny 규칙을 더한다
- `scripts/remove-worktree.sh`: 쓰는 프로세스, 미커밋 변경, 원격에 없는 커밋이 있거나 HEAD 가 `--merged-head` 의 조상이 아니면 지우지 않는다. 쓰는 프로세스는 `--wait` 초 동안, OMC session-end hook 만 남았으면 그 hook 이 끝날 때까지 기다린다
- `scripts/spec-lint.py`: 띄우기 전에 지시서끼리 담당 경로 겹침, 코디네이터 소유와 소유 계약, 없는 함수, 금지 문구를 막고 없는 파일 경로는 경고한다. 저장소 값은 오버레이의 `## spec-lint` 절에서 읽는다. `--check-overlay` 는 오버레이와 `orch-finish.json` 이 가리키는 경로가 `origin/<base>` 에 있는지 본다
- `scripts/orch-doctor.py`: 스킬을 열 때 설치 캐시의 커밋이 원본 main 보다 낡았는지 보고 갱신 명령을 보여 주고, 문서가 부르는 `$SKILL_DIR/scripts/*` 가 모두 있는지 본다. 저장소 테스트 `scripts/tests/test_doc_script_refs.py` 가 스킬마다 이 검사를 부른다
- `scripts/worker-ask.sh`: worker 가 코디네이터에게 묻는다. 읽지 않은 코디네이터 메시지가 있으면 묻지 않고, 답은 첫 줄 `answer:` 로 낸다. 시간 제한 뒤에는 status 로 온 답을 찾고, 끝난 Dispatch 에서는 Run 메일함으로 대신 보낸다. JSON 해석은 `scripts/ask-json.py` 가 맡는다
- `scripts/cleanup-sweep.py`: 머지된 worktree, 로컬과 원격 브랜치, 그 터미널과 Dispatch, 지시서와 PR 본문 파일, 저장소 밖에 남은 detached 워크트리를 정리하고 기준 브랜치를 fast-forward 한다. 살아 있는 dispatch 의 지시서는 지우지 않는다. 깨어날 때마다 사용자가 말하지 않아도 돌고, `--repo` 를 여러 번 받는다. 기본은 dry-run 이다. `--kill-holders` 는 끝난 dispatch 의 워크트리를 쥔 프로세스를 끈다
- `scripts/live_specs.py`: 살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서 경로를 모은다. `cleanup-sweep.py` 와 `handoff-cleanup.py` 가 import 한다
- `scripts/board-sync.py`: PR 이 머지된 보드 항목을 done 으로 바꾸고 남은 단계에 ✓ 를 붙인 뒤 목표 진행률을 다시 센다. 상태 줄은 쓰지 않는다
- `scripts/goal-progress.py`: 보드 목표 항목의 진행 표시줄을 추적 항목 상태로 다시 계산한다
- `hooks/`: 플러그인이 싣는 PreToolUse 훅. 판정과 오탐 기준은 각 파일 머리 주석이 소유한다
  - `block-background-wait.py`: `check --wait` 와 `wait-important.py` 를 셸의 `&` 나 `nohup` 으로 띄우는 Bash 호출을 거부한다
  - `block-git-after-cd.py`: `cd X;` 나 줄바꿈 뒤의 git 쓰기(merge, commit, push, reset, rebase)를 거부하고 `&&` 나 `git -C` 를 요구한다
  - `block-worker-terminal-send.py`: worker 터미널에 직접 `orca terminal send` 하는 호출을 거부하고 `send-to-worker.py` 로 보내게 한다
  - `require-spec-line.py`: `worker-start --spec` 값이 `spec-line.py` 가 만드는 한 줄 꼴이 아니면 거부한다
- `scripts/mem-gate.sh`: macOS 의 free 메모리와 swap 이 기준 안에 들 때까지 기다린 뒤 명령을 실행한다. 무거운 검사 앞에 둔다
- `tests/`: 스크립트 테스트. gh, git, sleep 은 가짜를 PATH 앞에 두고 돈다

```bash
python3 scripts/run-orch-tests.py --report /tmp/orch-tests.json
```

파일마다 별도 프로세스를 띄워 최대 4개를 동시에 실행한다. `--jobs`로 동시 실행 수를 지정한다.
각 테스트의 상태와 로그, 저장소는 임시 디렉터리를 따로 쓴다.
정리, 머지 큐, 질문, 보드, CI ready, worker 깨우기 테스트는 가짜 실행 파일만 클래스마다 재사용한다.
실패한 파일의 출력과 파일별 시간, 느린 테스트 상위 10개를 보여 주고, 실패가 하나라도 있으면 종료 코드 1을 낸다.
`--report` 는 전체 측정값을 JSON으로 저장한다. 순차 실행과 비교하려면 `--jobs 1`을 붙인다.

`cleanup-sweep.py` 테스트는 `--wait 0.01 --poll-interval 0.01`로 대기를 줄인다.
운영 기본값은 대기 5초, 확인 간격 1초이며, 신호를 보낸 뒤에는 최소 한 간격을 기다린다.

`merge-queue.sh` 는 미해결 스레드 수를 형제 스킬 `review-fix` 의 `review_threads.py` 로 센다.
명령 문법과 lifecycle 은 Orca 의 `orchestration` 스킬이 맡는다.
