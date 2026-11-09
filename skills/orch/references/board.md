# 진행 보드

work-board 형식의 `board.json` 으로 worker 와 PR 현황을 보여 주는 환경에서만 쓴다. 보드가 없으면 이 절차를 건너뛴다.
보드 파일은 work-board 소유다. 기본 위치는 [`extensions/work-board/README.md`](../../../extensions/work-board/README.md) 가 정하고, 다른 곳이면 `.orch/config.json` 의 `finish.board` 로 준다.

**하위 줄은 사용자 마일스톤 단계만 둔다.** 지시서 「할 일」 의 구현 세부는 보드에 올리지 않는다. 구현 세부는 머지와 배포로 끝낼 수 없어 진행률이 멈춘다.
단계 줄은 `1. PR`, `2. 머지` 처럼 번호로 시작하고, 저장할 때는 줄마다 `{"text": "1. PR", "done": false}` 객체를 쓴다.
`남은 일:` 줄과 `중간 과정:` 줄은 예외로, 번호 없이 스크립트가 쓰고 바꾼다(아래 「갱신 담당」).
진행률은 단계 줄에서 센다. `--progress 끝낸단계수/전체단계수` 는 단계로 나타낼 수 없을 때만 쓴다.
PR 상태, CI, 커밋, worker 화면 같은 상태 줄은 쓰지 않는다. 단계와 섞이면 보드를 읽기 어렵다.

**worker 는 보드를 고치지 않는다.** `board.ts step`, `mark`, `set` 은 스크립트와 코디네이터만 쓴다. worker 가 단계를 체크하면 PR 전인데 100% 로 보인다.

## 마일스톤 단계

단계 정의는 한 줄이 단계 하나다. 줄 앞 꼬리표가 그 단계를 끝낼 사건이고, 꼬리표가 없는 줄은 코디네이터가 끝내는 수동 단계다.

| 꼬리표 | 끝내는 때 | 끝내는 명령 |
| --- | --- | --- |
| `[pr]` | 항목의 PR 이 열렸다 | `board-sync.ts` |
| `[merge]` | PR 이 머지됐다 | `board-sync.ts`, `finish-pr.ts` |
| `[deploy]` | `finish.deploy_workflow` 가 머지 커밋을 성공으로 배포했다 | `board-sync.ts`, `finish-pr.ts` |
| `[release]` | 저장소가 정한 릴리스에 그 PR 이 들었다 | `board-release.ts` |

사건 하나는 그 사건과 앞 사건의 단계를 함께 끝낸다. 업무의 중간 PR 은 `[deploy]` 까지만 끝내고, 마지막 PR 만 `[release]` 와 done 으로 간다.

단계는 아래 순서로 처음 있는 것을 쓴다. 띄울 때 항목을 새로 만들거나 done 항목을 다시 열 때만 정하고, 이미 있는 항목의 단계는 바꾸지 않는다.

1. 지시서의 `## 보드 단계` 절. 번호 줄만 읽는다
2. `.orch/config.json` 의 `board.steps`
3. 기본값 `[pr] PR`, `[merge] 머지`

배포와 릴리스 단계는 그 흐름을 가진 저장소가 `board.steps` 로 둔다. 배포 워크플로가 있어도 코어가 배포 단계를 만들지 않는다.

```json
{
  "board": {
    "steps": ["[pr] PR", "[merge] 머지", "[deploy] 검증 환경 배포", "[release] 운영 반영"],
    "done_after": "release"
  }
}
```

```markdown
## 보드 단계

1. [pr] 설정 PR
2. 사용자 확인
3. [merge] 머지
```

항목은 사건과 단계 번호의 짝을 `stages` 필드(`pr=1,merge=2`)에 둔다. 사건 꼬리표도 `stages` 도 없는 옛 항목의 규칙은 `board-sync.ts` 머리 주석이 소유한다.

**done 으로 바꾸는 때는 `board.done_after` 가 정한다.** 값은 `merge`, `deploy`, `release` 이고 기본은 `merge` 다.
마지막 PR 이 그 사건 단계에 닿으면 그 번호까지의 남은 단계를 끝내고 done 으로 바꾼다. 항목에 그 사건 단계가 없으면 항목에 있는 가장 늦은 사건 단계에서 바꾼다.
그 뒤 번호에 끝나지 않은 수동 단계(꼬리표 없는 줄, 다음 PR 같은 것)가 남았으면 done 으로 바꾸지 않고 사건 단계만 끝낸다. 그 뒤에 남아도 되는 것은 나중 사건이 끝낼 사건 단계뿐이다.

**`board-release.ts` 를 언제 부를지는 저장소가 정한다.** 릴리스 PR 을 머지한 뒤 오버레이의 절차나 `after-deploy` 같은 이벤트 핸들러에서 부른다.
`--release <PR>` 은 그 PR 의 머지 커밋이 품은 PR 을 `pr` 필드에 둔 항목을, `--pr <N>` 은 그 번호가 `pr` 이나 `merged-pr` 필드에 든 항목을 끝낸다. `--dry-run` 은 보드를 고치지 않는다.

```bash
orch board release --release "$RELEASE_PR"
```

**PR 머지 반영과 목표 진행률은 `board-sync.ts` 에 맡긴다.** 판정은 스크립트 머리 주석이 소유한다.
결정과 다음 할 일처럼 사람만 아는 단계는 코디네이터가 직접 쓴다. 부르는 시점은 [`waiting.md`](waiting.md) 의 「깨어날 때마다 정리와 보드 동기화」 가 정한다.

## 직접 작성한 사건 단계

코디네이터가 직접 항목이나 goal 을 쓸 때는 자동으로 끝낼 단계의 줄 끝에 `(#665 merge)` 처럼 PR 번호와 사건을 붙인다.
`pr`, `merge`, `deploy`, `release` 를 쓰며, `3. develop 머지 (#665 merge)`, `4. dev 배포 (#665 deploy)`, `5. real 반영 (#665 release)` 처럼 적는다.
꼬리표가 있는 항목은 진행률을 세는 쪽의 사건 단계만 끝낸다. 꼬리표 없는 줄과 항목 상태는 코디네이터가 관리한다.
`stages` 와 함께 있어도 줄 끝 꼬리표를 우선한다. `finish-pr.ts` 도 꼬리표 항목은 일괄 완료하지 않고 `board-sync.ts` 에 맡긴다. 창에서는 꼬리표를 숨기지만 원본과 `board.ts steps` 출력에는 남는다.

## 갱신 담당

| 시점 | 담당 | 갱신하는 것 |
| --- | --- | --- |
| worker 를 띄운 뒤 | `launch-worker.ts` | 지시서의 보드 항목 id 로 항목을 찾거나 만들어 doing 으로 두고 위 「마일스톤 단계」 로 `stages` 필드를 둔다. 항목 찾기 순서, 제목 정하기, 같은 업무의 다음 PR 을 이어 쓰는 규칙, `중간 과정: PR #N` 줄, done 항목 다시 열기는 `launch-worker.ts` 와 `scripts/lib/board.ts` 의 `registerBoard`·`specTitle` 주석이 소유한다. 항목이 이미 있으면 제목과 단계는 사용자가 정한 마일스톤이라 그대로 둔다. 업무 연결 줄의 꼴은 `board.task_line` 이 정한다 |
| 준비됨 `worker_done` | `wait-important.ts` | 그 PR 의 브랜치로 `pr` 필드가 빈 항목을 찾아 `pr` 필드를 채운다 |
| 틱마다 | `orch-loop.ts` → `board-sync.ts` | 항목의 `pr` 필드를 연결하고, 마일스톤 항목의 PR 이 열려 있으면 `[pr]` 단계를 끝내고, 없어진 워크트리 이름을 비우고, 결정 항목이 바뀌면 REMINDER 를 한 번 기록한다. 판정은 `board-sync.ts` 머리 주석이 소유한다 |
| PR 머지 뒤 | `board-sync.ts` | 그 PR 의 마무리(`finish-pr.ts`)가 돌고 있으면 그 항목은 마무리에 맡긴다. 아니면 마지막 PR 인지 판정한다([`cleanup.md`](cleanup.md) 의 「마지막 PR 판정」). gh 조회 실패로 판정하지 못하면 다음 틱에 다시 판정한다. 마일스톤 항목은 `[merge]` 단계까지(배포가 이미 성공했으면 `[deploy]` 까지) 끝내고, 마지막 PR 이 done 지점에 닿았고 그 뒤에 끝나지 않은 수동 단계가 없으면 done 으로 바꾼다. 중간 PR 은 `pr` 필드를 비워 `merged-pr` 에 쌓고 `남은 일:` 줄을 둔다. 그 밖에 판정하지 못하면 마지막 PR 로 본다. 옛 항목의 규칙은 `board-sync.ts` 머리 주석이 소유한다 |
| 배포 성공 뒤 | `board-sync.ts`, `finish-pr.ts` | 마일스톤 항목의 `[deploy]` 단계를 끝내고, 마지막 PR 이 done 지점에 닿았으면 done 으로 바꾼다. `finish-pr.ts` 는 마지막 PR 인지 판정하지 못하면 중간 PR 로 본다. `merged-pr` 의 PR 은 다시 판정하지 않는다 |
| 릴리스 뒤 | `board-release.ts` | 저장소가 부른다. 릴리스에 든 PR 의 항목에서 `[release]` 단계까지 끝내고, done 지점에 닿았으면 done 으로 바꾼다 |
| 사건 꼬리표 확인 | `board-sync.ts`, `board-release.ts` | done 을 제외한 goal 과 수동 항목도 줄 끝의 `(#PR번호 사건)` 을 읽어 그 줄만 끝낸다. 다른 줄과 항목 상태는 그대로 둔다 |
| 결정·수동 단계 변경 | 코디네이터 | decide·wait 상태와 꼬리표 없는 수동 단계의 완료를 `board.ts set/step/mark` 로 반영한다. 자동 반영이 빠졌을 때만 사건 단계를 직접 고친다 |

자동 연결의 근거와 `pr`·`merged-pr` 필드의 값 읽기는 `board-sync.ts` 와 `board.ts` 머리 주석이 소유한다. 수동 갱신은 자동 반영이 누락됐을 때만 쓴다.

**DECISION-PENDING 을 받으면 코디네이터는 배경, 선택지, 권장안을 정리해 사용자에게 묻는다.** 이미 물어 답을 기다리는 결정은 다시 묻지 않는다.
알림 기억과 기본 핸들러, 사용자 질문 절차는 [`waiting.md`](waiting.md) 와 [`replying.md`](replying.md) 가 소유한다.

## 목표 진행 표시줄

하루 목표처럼 여러 단계를 묶은 목표 항목은 `goal-progress.ts` 로 진행 표시줄을 다시 계산한다.
`$GOAL_ID` 는 목표 항목 id 다. 무엇을 단계로 세는지는 스크립트 머리 주석이 소유한다.

```bash
orch board goal "$GOAL_ID"
```

기본 출력은 `GOAL <목표> <완료/전체>` 한 줄이다. `orch board sync`, `orch board release` 는 바꾼 항목마다 `BOARD <id> …` 와 끝 줄 `BOARD-SYNC <수>`, `BOARD-RELEASE <수>` 다. 설명 줄과 세부 줄은 `--full` 이다.

**mod 가 단계로 세면 이 스크립트는 걷어 낸다.** work-board mod 가 진행률을 단계 줄에서 직접 세는 기능을 갖게 되면 `goal-progress.ts` 와 `board-sync.ts` 의 `--goal` 을 지운다.
보드 파일과 도구 위치, 추적 항목 목록(`--items-file`) 같은 하위 호환 옵션은 스크립트 머리 주석이 소유한다.
