# 진행 보드

work-board 형식의 `board.json` 으로 worker 와 PR 현황을 보여 주는 환경에서만 쓴다. 보드가 없으면 이 절차를 건너뛴다.
보드 파일은 work-board 소유다. 기본 위치는 [`work-board/README.md`](../../work-board/README.md) 가 정하고, 다른 곳이면 `.orch/config.json` 의 `finish.board` 로 준다.

**하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다.** 형식은 `1. 구현`, `2. 리뷰 반영`, `3. 머지` 처럼 단계 1, 2, 3… 이고, 저장할 때는 줄마다 `{"text": "1. 구현", "done": false}` 객체를 쓴다. 끝낸 단계는 `board.ts step` 으로 `done: true` 로 바꾼다.
진행률은 단계 줄에서 센다. `--progress 끝낸단계수/전체단계수` 는 단계로 나타낼 수 없을 때만 쓴다.
PR 상태, CI, 커밋, worker 화면 같은 상태 줄은 쓰지 않는다. 단계와 섞이면 보드를 읽기 어렵다.

**PR 머지 반영과 목표 진행률은 `board-sync.ts` 에 맡긴다.** 판정은 스크립트 머리 주석이 소유한다. 머지 뒤 검증이나 후속 PR 이 남은 항목은 done 이 되지 않으므로, 머지 뒤 단계에 PR 번호를 적으면 그 PR 이 머지될 때 끝난 것으로 처리되므로 적지 않는다.
결정과 다음 할 일처럼 사람만 아는 단계는 코디네이터가 직접 쓴다. 부르는 시점은 [`waiting.md`](waiting.md) 의 「깨어날 때마다 정리와 보드 동기화」 가 정한다.

## 갱신 담당

| 시점 | 담당 | 갱신하는 것 |
| --- | --- | --- |
| worker 를 띄운 뒤 | `launch-worker.ts` | 지시서의 보드 항목 id(없으면 같은 워크트리나 브랜치의 끝나지 않은 항목, 그것도 없으면 `--name`, 기존 워크트리는 그 이름), 첫 제목, 「할 일」의 번호 줄로 doing 항목을 만든다. 같은 워크트리에 다시 띄운 worker(충돌 후속 지시서)는 새 항목을 만들지 않고 앞 항목을 이어 쓴다. 기존 단계는 보존하고 번호 줄이 없으면 구현·리뷰 반영·머지 단계를 둔다 |
| 준비됨 `worker_done` | `wait-important.ts` | 그 PR 의 브랜치로 `pr` 필드이 빈 항목을 찾아 `pr` 필드을 채운다 |
| 틱마다 | `orch-loop.ts` → `board-sync.ts` | done, goal 이 아닌 항목의 worktree 브랜치와 같은 열린 PR 을 연결한다. 없으면 머지 PR 을 조회한다. 결정 항목의 제목·줄이 바뀌면 REMINDER 를 한 번 기록한다 |
| PR 머지 뒤 | `board-sync.ts` | 업무의 마지막 PR 이면([`cleanup.md`](cleanup.md) 의 「마지막 PR 판정」) 남은 단계를 끝내고 done 으로 바꾼다. 중간 PR 이면 해당 PR 번호가 있는 단계만 끝내고 PR 칸을 비우고 `남은 일: PR #31, 지시서 spec-b.md` 한 줄을 하위 항목에 둔다. 판정하지 못하면 남은 단계가 하나 이하일 때 done, 둘 이상이면 해당 PR 번호의 단계만 끝내고 PR 칸을 비운다 |
| 배포 확인 뒤 | `finish-pr.ts` | 마지막 PR 이면 `pr` 필드이나 브랜치로 찾은 항목을 done 으로 바꾼다. 중간 PR 이면 브랜치로 찾은 항목의 `pr` 필드을 채운다 |
| 결정·후속 단계 변경 | 코디네이터 | decide·wait 상태와 사람만 아는 단계, 구현·검증 단계의 완료를 `board.ts set/step` 으로 반영한다 |

자동 연결은 항목의 worktree 와 git 워크트리 목록으로 브랜치를 찾는다. 띄울 때 저장한 `branch` 는 워크트리가 정리된 뒤에도 연결할 근거다.
후속 단계 때문에 비운 PR 은 `merged-pr` 에 기록해 다음 틱에 다시 연결하지 않는다.
`pr` 필드과 `merged-pr` 필드은 `#555` 와 `555` 를 같은 값으로 읽고, `board.ts` 가 PR 번호 하나를 숫자 555 로 저장한다. 창은 `#555` 로 그린다. 수동 갱신은 자동 반영이 누락됐을 때만 쓴다.

**REMINDER 가 정할 것이면 코디네이터는 배경, 선택지, 권장안을 정리해 보여 주고 `AskUserQuestion` 으로 묻는다.**
알림의 내용 해시는 `.orch/state/board-decisions.json` 에 기억한다. 항목이 사라지면 잊고, 다시 생기면 알린다.

## 목표 진행 표시줄

하루 목표처럼 여러 단계를 묶은 목표 항목은 `goal-progress.ts` 로 진행 표시줄을 다시 계산한다.
`$GOAL_ID` 는 목표 항목 id 다. 무엇을 단계로 세는지는 스크립트 머리 주석이 소유한다.

```bash
node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/goal-progress.ts" "$GOAL_ID"
```

**mod 가 단계로 세면 이 스크립트는 걷어 낸다.** work-board mod 가 진행률을 단계 줄에서 직접 세는 기능을 갖게 되면 `goal-progress.ts` 와 `board-sync.ts` 의 `--goal` 을 지운다.
보드 파일과 도구 위치, 추적 항목 목록(`--items-file`) 같은 하위 호환 옵션은 스크립트 머리 주석이 소유한다.
