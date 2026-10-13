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
- `scripts/remove-worktree.sh`: 쓰는 프로세스, 미커밋 변경, 원격에 없는 커밋이 있으면 지우지 않는다
- `scripts/worker-ask.sh`: worker 가 코디네이터에게 묻는다. 끝난 Dispatch 에서는 Run 메일함으로 대신 보내고, 시간 제한과 대신 보내기를 종료 코드로 가른다
- `scripts/cleanup-sweep.py`: 머지된 worktree, 로컬과 원격 브랜치, 그 터미널과 Dispatch, 지시서를 정리한다. 기본은 dry-run 이다
- `scripts/board-sync.py`: PR 이 머지된 보드 항목을 done 으로 바꾸고 남은 단계에 ✓ 를 붙인 뒤 목표 진행률을 다시 센다. 상태 줄은 쓰지 않는다
- `scripts/goal-progress.py`: 보드 목표 항목의 진행 표시줄을 추적 항목 상태로 다시 계산한다
- `tests/`: 스크립트 테스트. gh, git, sleep 은 가짜를 PATH 앞에 두고 돈다

```bash
python3 -m unittest discover -s orch/tests
```

`merge-queue.sh` 는 미해결 스레드 수를 형제 스킬 `review-fix` 의 `review_threads.py` 로 센다.
명령 문법과 lifecycle 은 Orca 의 `orchestration` 스킬이 맡는다.
