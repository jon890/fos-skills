# orch

Orca orchestration 으로 worker 를 띄워 PR 머지까지 끝내고, 머지 뒤 워크트리와 브랜치, 대기 프로세스를 남기지 않는 코디네이터 절차다.

## 산출물

| 산출물 | 내용 |
| --- | --- |
| 지시서 | 저장소 공통 지시서 한 파일과 worker 마다 범위와 완료 기준을 적은 파일 |
| 머지된 PR | 체크, 미해결 스레드, 원격 HEAD 를 확인하고 머지 전 명령을 돌린 뒤 머지한 PR |
| 정리된 작업 공간 | 머지마다 dispatch, 워크트리, 로컬과 원격 브랜치, 그 작업만의 문서를 지운 상태 |

## 구성

- `SKILL.md`: 목표, 원칙, 7단계 개요 표
- `references/`: 단계마다 하나씩 규칙과 복구 절차. `overlay.md` 는 저장소 오버레이에 적을 항목, `board.md` 는 진행 보드 연동
- `templates/spec-common.md`: 저장소와 무관한 공통 지시서 틀
- `scripts/merge-queue.sh`: PR 을 순서대로 확인하고 머지한다. 머지 전 명령을 PR 마다 받는다
- `scripts/triage-messages.py`: orca 메시지를 종류별로 모으고 heartbeat 는 개수만 낸다
- `scripts/make-worktree.sh`: 지시서의 `브랜치:` 이름으로 `origin/<기준 브랜치>` 위에 워크트리를 만들고 exclude 와 로컬 설정 복사, `worktree-deny.py` 의 deny 규칙 추가를 한다. `--check` 는 push 한 브랜치가 지시서 값과 같은지 본다
- `scripts/worktree-deny.py`: 워크트리의 `.claude/settings.local.json` 에 다른 worker 의 자원을 빼앗는 명령(pkill, killall, browser-driver reset)과 `gh pr merge` 의 deny 규칙을 더한다
- `scripts/remove-worktree.sh`: 쓰는 프로세스, 미커밋 변경, 원격에 없는 커밋이 있거나 HEAD 가 `--merged-head` 의 조상이 아니면 지우지 않는다. 쓰는 프로세스는 `--wait` 초 동안, OMC session-end hook 만 남았으면 그 hook 이 끝날 때까지 기다린다
- `scripts/spec-lint.py`: 띄우기 전에 지시서끼리 담당 경로 겹침, 코디네이터 소유와 소유 계약, 없는 함수, 금지 문구를 막고 없는 파일 경로는 경고한다. 저장소 값은 오버레이의 `## spec-lint` 절에서 읽는다
- `scripts/worker-ask.sh`: worker 가 코디네이터에게 묻는다. 읽지 않은 코디네이터 메시지가 있으면 묻지 않고, 답은 첫 줄 `answer:` 로 낸다. 시간 제한 뒤에는 status 로 온 답을 찾고, 끝난 Dispatch 에서는 Run 메일함으로 대신 보낸다. JSON 해석은 `scripts/ask-json.py` 가 맡는다
- `scripts/cleanup-sweep.py`: 머지된 worktree, 로컬과 원격 브랜치, 그 터미널과 Dispatch, 지시서를 정리한다. 깨어날 때마다 사용자가 말하지 않아도 돌고, `--repo` 를 여러 번 받는다. 기본은 dry-run 이다. `--kill-holders` 는 끝난 dispatch 의 워크트리를 쥔 프로세스를 끈다
- `scripts/board-sync.py`: PR 이 머지된 보드 항목을 done 으로 바꾸고 남은 단계에 ✓ 를 붙인 뒤 목표 진행률을 다시 센다. 상태 줄은 쓰지 않는다
- `scripts/goal-progress.py`: 보드 목표 항목의 진행 표시줄을 추적 항목 상태로 다시 계산한다
- `hooks/`: 플러그인이 싣는 PreToolUse 훅. `check --wait` 를 셸의 `&` 나 `nohup` 으로 띄우는 Bash 호출을 거부한다
- `tests/`: 스크립트 테스트. gh, git, sleep 은 가짜를 PATH 앞에 두고 돈다

```bash
python3 -m unittest discover -s orch/tests
```

`merge-queue.sh` 는 미해결 스레드 수를 형제 스킬 `review-fix` 의 `review_threads.py` 로 센다.
명령 문법과 lifecycle 은 Orca 의 `orchestration` 스킬이 맡는다.
