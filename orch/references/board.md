# 진행 보드

work-board 형식의 `board.json` 으로 worker 와 PR 현황을 보여 주는 환경에서만 쓴다. 보드가 없으면 이 절차를 건너뛴다.
보드 파일은 기본으로 git 루트의 `.omc/board.json` 이고, 위치는 오버레이가 바꿀 수 있다.

**상태가 바뀔 때마다 보드를 고친다.** 띄울 때 `doing`, 사용자 결정을 기다리면 `decide`, 앞 PR 을 기다리면 `wait`, 머지하면 `done` 이다.
보드를 고치는 명령은 보드 도구가 소유한다. 항목의 하위 줄(`--detail`)에서 끝난 일은 앞에 「✓ 」 를 붙인다.

## 목표 진행 표시줄

하루 목표처럼 여러 항목을 묶은 목표 항목은 `goal-progress.py` 로 진행 표시줄을 다시 계산한다.
추적 항목 중 `done` 인 수를 세어 목표 항목에 `끝낸수/전체수` 로 넣는다.
`$GOAL_ID` 는 목표 항목 id, `$ITEMS_FILE` 은 추적 항목 id 를 한 줄에 하나씩 적은 파일이다.

```bash
python3 "$SKILL_DIR/scripts/goal-progress.py" "$GOAL_ID" --items-file "$ITEMS_FILE" --details
```

머지한 항목을 보드에서 지우면 그 항목은 끝나지 않은 것으로 셈해진다. 지우지 말고 `done` 으로 두거나 추적 목록에서도 뺀다.
보드 파일과 도구 위치, 그 밖의 옵션은 스크립트 머리 주석이 소유한다.
