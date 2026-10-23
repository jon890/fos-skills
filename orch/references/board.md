# 진행 보드

work-board 형식의 `board.json` 으로 worker 와 PR 현황을 보여 주는 환경에서만 쓴다. 보드가 없으면 이 절차를 건너뛴다.
보드 파일은 work-board 소유다. 기본 위치는 [`work-board/README.md`](../../work-board/README.md) 가 정하고, 다른 곳이면 `.orch/config.json` 의 `finish.board` 로 준다.

**하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다.** 형식은 `1. 구현`, `2. 리뷰 반영`, `3. 머지` 처럼 단계 1, 2, 3… 이고, 저장할 때는 줄마다 `{"text": "1. 구현", "done": false}` 객체를 쓴다. 끝낸 단계는 `board.py step` 으로 `done: true` 로 바꾼다.
진행률은 단계 줄에서 센다. `--progress 끝낸단계수/전체단계수` 는 단계로 나타낼 수 없을 때만 쓴다.
PR 상태, CI, 커밋, worker 화면 같은 상태 줄은 쓰지 않는다. 단계와 섞이면 보드를 읽기 어렵다.

**PR 머지 반영과 목표 진행률은 `board-sync.py` 에 맡긴다.** 판정은 스크립트 머리 주석이 소유한다. 머지 뒤 검증이나 후속 PR 이 남은 항목은 done 이 되지 않으므로, 머지 뒤 단계에 PR 번호를 적으면 그 PR 이 머지될 때 끝난 것으로 처리되므로 적지 않는다.
결정과 다음 할 일처럼 사람만 아는 단계는 코디네이터가 직접 쓴다. 부르는 시점은 [`waiting.md`](waiting.md) 의 「깨어날 때마다 정리와 보드 동기화」 가 정한다.

**상태가 바뀔 때마다 보드를 고친다.** 띄울 때 `doing`, 사용자 결정을 기다리면 `decide`, 앞 PR 을 기다리면 `wait`, 머지하면 `done` 이다.
보드를 고치는 명령은 `$SKILL_DIR/../work-board/bin/board.py` 이고, 사용법과 단계 줄 형식은 그 머리 주석과 [`work-board/README.md`](../../work-board/README.md) 가 소유한다.
`doing` 으로 둘 때는 단계 줄(`--next '1. 구현' --next '2. 머지'`)이나 `--progress N/M` 을 함께 준다. 없으면 board.py 가 거절한다.

**보드에 `decide` 항목이 생기거나 남아 있으면 사용자가 묻지 않아도 정리해 알린다.**
각 항목이 무엇을 정해야 하는지와 권장안을 적고, `AskUserQuestion` 으로 결정을 받는다.
보드를 갱신해 보고할 때마다 결정 대기 목록을 함께 알린다.

## 목표 진행 표시줄

하루 목표처럼 여러 단계를 묶은 목표 항목은 `goal-progress.py` 로 진행 표시줄을 다시 계산한다.
`$GOAL_ID` 는 목표 항목 id 다. 무엇을 단계로 세는지는 스크립트 머리 주석이 소유한다.

```bash
python3 "$SKILL_DIR/scripts/goal-progress.py" "$GOAL_ID"
```

**mod 가 단계로 세면 이 스크립트는 걷어 낸다.** work-board mod 가 진행률을 단계 줄에서 직접 세는 기능을 갖게 되면 `goal-progress.py` 와 `board-sync.py` 의 `--goal` 을 지운다.
보드 파일과 도구 위치, 추적 항목 목록(`--items-file`) 같은 하위 호환 옵션은 스크립트 머리 주석이 소유한다.
