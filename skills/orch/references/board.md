# 진행 보드

work-board 형식의 `board.json` 으로 worker 와 PR 현황을 보여 주는 환경에서만 쓴다. 보드가 없으면 이 절차를 건너뛴다.
보드 파일은 work-board 소유다. 기본 위치는 [`extensions/work-board/README.md`](../../../extensions/work-board/README.md) 가 정하고, 다른 곳이면 코디네이터가 `orch config set finish.board .omc/board.json` 으로 보드 파일을 정한다. 경로는 저장소에 맞게 바꾼다.

orch 는 명령줄의 보드 파일, `finish.board`, 기본 위치 순서로 고른다. 설정의 상대경로는 주 checkout 기준이고, `finish.board` 가 빈 문자열이면 기본 위치를 쓴다. 설정이 깨졌거나 보드 값이 문자열이 아니면 한 줄 설명과 종료 코드 2 를 내고 기본 보드로 바꾸지 않는다. 루프에서는 `WATCH-ERROR` 로 알리고 뒤 단계와 다음 틱을 계속 실행한다.
기존 `orch board sync`, `release`, `goal` 의 `--board` 상대경로는 명령을 부른 폴더 기준이다. `goal` 은 설정이 없으면 현재 작업 트리의 기본 보드를 쓰고, 정리 명령은 `cleanup.board` 를 먼저 쓴다.
보기와 지우기는 `orch board list`, `orch board del` 을 쓴다. 보드 창과 `board.ts set`, `board.ts mark` 는 orch 설정을 읽지 않으므로 다른 위치를 쓰면 직접 명령에 `--file` 로 같은 파일을 준다.

동기화와 마무리는 읽은 단계 목록을 통째로 저장할 때 줄 지문을 함께 보낸다. 그 사이 글이나 완료 값이 바뀌었으면 덮어쓰지 않는다. 동기화는 그 항목을 다음 틱에 다시 읽고, 릴리스 반영은 다른 항목을 처리한 뒤 종료 코드 1 을 내므로 다시 실행한다. worker 등록과 마무리는 다시 읽어 한 번 재시도한다.
`BOARD <id> stale` 은 읽은 뒤 줄이 바뀌어 그 항목의 저장을 건너뛰었다는 뜻이다. `sync` 는 다음 틱을 기다리고, `release` 는 종료 코드 1 을 확인한 뒤 다시 부른다.

**하위 줄은 사용자 마일스톤 단계만 둔다.** 지시서 「할 일」 의 구현 세부는 보드에 올리지 않는다. 구현 세부는 머지와 배포로 끝낼 수 없어 진행률이 멈춘다.
단계 줄은 `1. PR`, `2. 머지` 처럼 번호로 시작하고, 저장할 때는 줄마다 `{"text": "1. PR", "done": false}` 객체를 쓴다.
`남은 일:` 줄과 `중간 과정:` 줄은 예외로, 번호 없이 스크립트가 쓰고 바꾼다(아래 「갱신 담당」).
진행률은 단계 줄에서 센다. `--progress 끝낸단계수/전체단계수` 는 단계로 나타낼 수 없을 때만 쓴다.
PR 상태, CI, 커밋, worker 화면 같은 상태 줄은 쓰지 않는다. 단계와 섞이면 보드를 읽기 어렵다.

**worker 는 보드를 고치지 않는다.** `orch board set`, `step`, `add-step`, `del` 과 `board.ts mark` 는 스크립트와 코디네이터만 쓴다. worker 가 단계를 체크하면 PR 전인데 100% 로 보인다.

## 승인 대기

승인 대기는 보드 파일에 쓰지 않는다. `orch board approval list` 등 승인 명령이 별도 승인 파일을 읽고 쓴다. 코디네이터는 같은 일에 같은 id 를 쓰며, 신호를 받은 뒤 실행하기 직전에 확인한다. 종류별 필수 값과 채팅 승인 처리는 [`replying.md` 「보드 승인」](replying.md#보드-승인)이 소유한다.

`$APPROVAL_ID` 는 같은 일을 가리키는 id, `$TITLE` 과 `$PREVIEW` 는 제목과 미리보기 경로, `$VERSION` 은 받은 신호의 버전이다.

```bash
orch board approval add "$APPROVAL_ID" --title "$TITLE" --kind post --preview "$PREVIEW"
orch board approval list
orch board approval check "$APPROVAL_ID" --version "$VERSION"
orch board approval cancel "$APPROVAL_ID" --reason chat
```

끝난 기록도 보려면 `list --full` 을 쓴다.

## 상태와 단계 고치기

**`board.json` 은 직접 고치지 않는다.** 상태와 단계는 아래 명령으로 고친다. 새 항목을 만들거나 제목·PR·담당 워크트리 같은 칸을 고칠 때는 `board.ts set`, 번호 없는 줄을 끝낼 때는 `board.ts mark`, 항목을 지울 때는 아래 `orch board del` 을 쓴다.

```text
orch board set <항목> <goal|decide|doing|wait|done>
orch board step <항목> <번호> done|undo
orch board step <항목> <번호> text "<번호를 포함한 줄 전체>" [--on "<PR> <사건>"]
orch board step <항목> <번호> auto|ask|plain
orch board step <항목> <번호> wait ["<조건>"]
orch board add-step <항목> "<글>" [--on "<PR> <사건>"]
orch board show <항목> [--json]
orch board get <항목> <칸> [--json]
orch board get <항목> step <번호> [--json]
orch board list [--status <상태>[,<상태>…]] [--json]
orch board del <항목> [--force]
orch board del --done
공통: [--board <파일>] [--repo <폴더>] [--full]
```

`--repo` 를 생략하면 워크트리에서도 주 checkout 의 보드를 쓴다. 직접 주면 `finish.board` 가 없을 때 그 작업 트리의 기본 보드를 쓴다. 새 명령의 `--board` 상대경로와 `finish.board` 는 주 checkout 기준이다. 기존 명령의 예외는 위 파일 안내를 따른다.

`get` 은 값만 한 줄로 내므로 `b=$(orch board get <항목> branch)` 로 담는다. 칸 이름은 `board.ts set` 의 칸 옵션과 같고 `status`, `step <번호>` 가 더 있다. 목록은 `orch board get --help` 에서 본다. `progress` 는 끝낸 단계/전체 단계이고 `step` 은 완료 표시 없이 줄 글을 낸다. 제목 칸이 없으면 id 를 쓴다. 값이 없으면 stdout 이 비고 종료 코드 4 다. `set -e` 셸에서는 `if b=$(orch board get <항목> branch); then …` 이나 `|| true` 로 받는다.

`list` 는 항목마다 `BOARD <항목> <상태> <끝낸>/<전체> <제목>` 을 내고, 없으면 `BOARD-NONE` 을 낸다. `--status` 에 쉼표로 상태를 여럿 줄 수 있고 모르는 상태는 종료 코드 1 이다. `--full` 은 모든 줄과 안 풀린 머지 기록도 낸다.

`del` 은 `done` 항목만 지우며 다른 상태는 `--force` 가 필요하다. `--done` 은 끝난 항목 전부를 지운다. 묻지 않고 지우므로 먼저 보려면 `orch board list --status done` 을 쓴다. 지운 항목마다 `BOARD-DEL <항목>` 을 내고 없으면 `BOARD-NONE` 이다. 지우기 전 파일은 `<보드 파일>.bak` 에 한 세대 남으며 다음 통째 저장이나 삭제가 덮는다. 진행 중 항목을 강제로 지우면 동기화가 같은 id 를 다시 만들 수 있다.

`get`, `list`, `show` 는 잠금을 잡지 않는다. `--json` 은 저장된 칸과 계산된 `progress`, `lines` 를 담은 항목 객체를 내며 `show` 는 `unmatched` 도 낸다. `get` 은 `{"id", "field", "value"}` 를 내고 빈 값은 `null` 이다. 거절하면 stdout 은 비고 이유는 stderr 에 나온다.

`set` 은 있는 항목의 상태만 고치며 `doing` 에는 진행률이 있어야 한다. `step` 은 보이는 줄 앞 번호로 고른다. 같은 번호가 둘이거나 없으면 거절한다. `text` 는 번호를 포함한 줄 전체를 받고 번호가 다르거나 사건 꼬리표를 지우면 거절한다. 완료 표시를 쓰지 않으면 끝냄 상태는 유지된다. `undo` 는 항목 상태를 바꾸지 않고, `decide` 의 마지막 줄을 끝내면 항목도 `done` 이 된다.

`auto`, `ask`, `wait`, `plain` 은 그 줄 번호 뒤의 자동 진행 표시(`[auto]`, `[ask]`, `[wait]`, `[wait: <조건>]`)만 바꾸고 `plain` 은 지운다. 나머지 글, 끝냄 상태, 줄 끝 사건 꼬리표는 그대로다. 조건은 `wait` 에만 줄 수 있고 `]` 와 줄바꿈은 안 된다. 줄 앞 `[merge]` 같은 사건 표시가 있는 줄과 `stages` 필드가 가리키는 번호의 줄은 사건이 끝내는 단계라 거절한다. 출력은 `BOARD-STEP <항목> <번호> <동작>` 한 줄이고 `wait` 의 조건 글은 넣지 않는다. `-` 로 시작하는 조건은 옵션으로 읽혀 사용법 오류가 난다.

`add-step` 은 단계를 세는 쪽(details, 없으면 next)에 더한다. 번호가 없으면 가장 큰 번호 다음을 붙이고, 직접 쓴 번호가 겹치거나 항목이 `done` 이면 거절한다. `progress` 값이 있으면 새 단계가 진행률에 안 보일 수 있어 stderr 로 알린다.
`-` 로 시작하는 글은 옵션으로 읽혀 사용법 오류가 난다. `orch board add-step <항목> "10. - 하위 항목"` 처럼 쓰려는 단계 번호를 앞에 붙인다.
명시한 진행률을 지워 단계 수로 세려면 칸 수정 도구인 `board.ts set` 에 `--progress auto` 를 준다. `orch board set` 은 상태와 업무 칸만 고치므로 이 옵션을 받지 않는다.

`--on "1455 merge"` 는 줄 끝에 `(#1455 merge)` 를 붙이고 기존 꼬리표는 바꾼다. 사건은 `pr`, `merge`, `deploy`, `release` 다. `stages` 가 있는 항목에 붙이면 기존 사건 단계의 자동 완료가 멈출 수 있어 경고한다. 자동 진행 표시만 바꿀 때는 줄 전체를 다시 쓰지 않고 위 `auto`, `ask`, `wait`, `plain` 동작을 쓴다.

성공 출력은 `BOARD-SET <항목> <상태>`, `BOARD-STEP <항목> <번호> <동작>`, `BOARD-STEP-ADD <항목> <번호>` 한 줄이다. 단계 변경으로 상태도 바뀌면 `status=<상태>` 가 붙는다. `show` 는 `BOARD <항목> <상태> <끝낸>/<전체>` 와 미완료 번호 단계만 낸다. 명시 진행률이 앞서고 진행률이 없으면 `진행률 없음` 이다. `--full` 은 완료 단계와 참고 줄도 내며 완료 줄 앞에 `✓` 를 붙인다. 거절은 stderr 와 종료 코드 1, 사용법 오류는 2, 성공은 0 이다.

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
결정과 다음 할 일처럼 사람만 아는 단계는 코디네이터가 직접 쓴다. 부르는 시점은 아래 「갱신 담당」 표의 「틱마다」 행에 있다.

## 직접 작성한 사건 단계

코디네이터가 직접 항목이나 goal 을 쓸 때는 자동으로 끝낼 단계의 줄 끝에 `(#665 merge)` 처럼 PR 번호와 사건을 붙인다.
`pr`, `merge`, `deploy`, `release` 를 쓰며, `3. develop 머지 (#665 merge)`, `4. dev 배포 (#665 deploy)`, `5. real 반영 (#665 release)` 처럼 적는다.
꼬리표가 있는 항목은 진행률을 세는 쪽의 사건 단계만 끝낸다. 꼬리표 없는 줄과 항목 상태는 코디네이터가 관리한다.
`stages` 와 함께 있어도 줄 끝 꼬리표를 우선한다. `finish-pr.ts` 도 꼬리표 항목은 일괄 완료하지 않고 `board-sync.ts` 에 맡긴다. 창에서는 꼬리표를 숨기지만 원본과 `board.ts steps` 출력에는 남는다.

## 자동 진행 표시

꼬리표 없는 수동 단계 줄의 번호 뒤 맨 앞에 다음 표시를 붙인다. 표시의 꼴은 `extensions/work-board/hooks/step-marks.js` 가 소유한다.

| 표시 | 뜻 |
| --- | --- |
| `[auto]` | 미리 허락된 일이므로 코디네이터가 근거를 확인하고 묻지 않고 띄운다 |
| `[ask]` | 사용자가 정한다 |
| `[wait]`, `[wait: <조건>]` | 조건을 기다린다 |

```text
2. [auto] PR4 회차 추이 API (계획: docs/features/x/tasks/pr4)
3. [ask] real 활성화
4. [wait: 2026-11-10 19:00] real 19:00 회차
5. [wait] 기획 답 (#665 merge)
```

표시는 코디네이터가 붙인다. worker 는 계획에서 나눈 남은 PR 목록을 `worker_done` 에 적어 넘기고 보드를 고치지 않는다. `[pr]`, `[merge]`, `[deploy]`, `[release]` 사건 단계와 `stages` 필드에 든 번호의 줄에는 붙이지 않는다. 붙여도 자동 진행 표시로 읽지 않는다.

`[auto]` 를 붙여도 되는 일은 확인받은 계획의 다음 PR, 스펙 확인 뒤 설계와 계획, 배포·회차 뒤 정리와 다시 재기, 리뷰 지적 반영과 머지다. real 에 닿는 일, 외부로 나가는 글, 범위가 바뀌는 일에는 붙이지 않는다. real 배포·데이터·운영 설정 변경, Dooray 댓글·업무·메신저·메일·사내 회신, 스펙·계획에 없는 새 일과 계획을 나누는 결정이 여기에 든다.

`[auto]` 줄에는 `(스펙: <경로>)`, `(계획: <경로>)`, `(앞 사건: #N merge)` 중 하나 이상의 근거를 적는다. 여러 근거는 모두 맞아야 한다. 절대경로는 그 자리, 상대경로는 저장소 기본 checkout 기준이다. 근거 괄호 안의 PR 번호는 그 줄을 끝내지 않는다. 줄 끝 사건 꼬리표 `(#N merge)` 는 그 사건에 그 줄을 끝내므로 앞 사건 근거 대신 쓰지 않는다.

줄 끝 꼬리표가 하나라도 있는 항목은 꼬리표 줄만 스크립트가 끝내고 항목 상태는 코디네이터가 바꾼다. 직접 쓴 항목에서는 PR 이 끝낼 줄마다 꼬리표를 붙인다. 마일스톤 항목(`stages` 필드가 있다)에는 꼬리표를 붙이지 않고, 표시 줄은 done 지점(`board.done_after`) 뒤 번호에 둔다. 앞 번호의 수동 줄은 마지막 PR 이 done 지점에 닿을 때 함께 끝난다. `--board-id` 로 항목을 정한 마무리는 남은 줄과 상관없이 항목을 닫는다.

`[Auto]`, `[maybe]` 처럼 꼴이 다른 표시는 표시 없는 줄로 읽는다. 옛 줄은 한꺼번에 고치지 않고 단계를 새로 쓰거나 고칠 때 표시를 붙인다. 루프는 doing·wait 항목의 첫 미완료 `[auto]`·`[ask]` 단계에 `STEP-READY` 를 바로 보낸다. worktree·branch 가 비어 있어도 본다. `[auto]` 는 worker 와 열린 PR 이 없음을 확인한 틱에만 알리고 `[ask]` 는 그 조건 없이 알린다. 같은 글은 루프를 다시 띄워도 다시 알리지 않으며 줄 끝 사건 꼬리표만 붙인 것은 글 변경으로 보지 않는다.

`[wait]` 는 멈춤 알림을 보내지 않는다. `[wait: YYYY-MM-DD HH:MM]` 은 머신 로컬 시각이 지나면 첫 미완료 여부와 관계없이 그 줄만 끝내고 항목 상태는 그대로 둔다. 잘못된 날짜와 글 조건은 사람이 끝낸다. 표시 없는 줄은 기존 멈춤 알림을 유지하고, 띄운 `[auto]` 의 worker·PR 이 모두 없어지면 30분(`pipeline.idle_min`) 뒤 한 번 알린다. 띄운 기록이 있으면 연결 필드가 비었거나 상태가 wait 여도 본다.

마지막 `WORKER-LIMITED` 시각은 머신 전체가 공유한다. 30분 안에는 `auto-check` 가 거절하고, 그 뒤에는 전에 알렸지만 띄우지 않은 `[auto]` 를 한 번 더 알린다. 30분이 지난 뒤 처음 알린 단계에는 재알림이 없다. `board.auto_advance: false` 면 `STEP-READY` 를 끄고 `[auto]`·`[ask]` 를 표시 없는 줄처럼 본다. `[wait]` 와 시각 wait 는 그대로다.

표시를 바꾸는 명령과 띄우는 절차는 [`replying.md` 「다음 단계 이어 가기」](replying.md#다음-단계-이어-가기)가 소유한다.

## 갱신 담당

| 시점 | 담당 | 갱신하는 것 |
| --- | --- | --- |
| worker 를 띄운 뒤 | `launch-worker.ts` | 지시서의 보드 항목 id 로 항목을 찾거나 만들어 doing 으로 두고 위 「마일스톤 단계」 로 `stages` 필드를 둔다. 항목 찾기 순서, 제목 정하기, 같은 업무의 다음 PR 을 이어 쓰는 규칙, `중간 과정: PR #N` 줄, done 항목 다시 열기는 `launch-worker.ts` 와 `scripts/lib/board.ts` 의 `registerBoard`·`specTitle` 주석이 소유한다. 항목이 이미 있으면 제목과 단계는 사용자가 정한 마일스톤이라 그대로 둔다. 업무 연결 줄의 꼴은 `board.task_line` 이 정한다. 번호는 `task-ref`, 같은 줄의 어댑터 호스트 주소는 `task` 에 빈 칸일 때만 넣는다. 새 제목에는 번호를 붙이지 않고 같은 업무는 번호 칸으로 먼저 찾는다 |
| 준비됨 `worker_done` | `orch-loop.ts` | 그 PR 의 브랜치로 `pr` 필드가 빈 항목을 찾아 `pr` 필드를 채우고 PR 제목의 번호(`finish.task_pattern`)를 빈 `task-ref` 에 넣는다 |
| 틱마다 | `orch-loop.ts` → `lib/task-links.ts` | 번호만 있는 열린 항목의 업무 주소를 어댑터로 만들어 채운다. 실패는 항목·번호마다 한 번 `TASK-LINK-FAIL` 로 남기고 30분마다 다시 해 본다 |
| 틱마다 | `orch-loop.ts` → `board-sync.ts` | 항목의 `pr` 필드를 연결할 때 PR 제목의 번호(`finish.task_pattern`)를 빈 `task-ref` 에 넣고, 마일스톤 항목의 PR 이 열려 있으면 `[pr]` 단계를 끝내고, 없어진 워크트리 이름을 비우고, 결정 항목이 바뀌면 REMINDER 를 한 번 기록한다. 판정은 `board-sync.ts` 머리 주석이 소유한다 |
| PR 머지 뒤 | `board-sync.ts` | 그 PR 의 마무리(`finish-pr.ts`)가 돌고 있으면 그 항목은 마무리에 맡긴다. 아니면 마지막 PR 인지 판정한다([`cleanup.md`](cleanup.md) 의 「마지막 PR 판정」). gh 조회 실패로 판정하지 못하면 다음 틱에 다시 판정한다. 마일스톤 항목은 `[merge]` 단계까지(배포가 이미 성공했으면 `[deploy]` 까지) 끝내고, 마지막 PR 이 done 지점에 닿았고 그 뒤에 끝나지 않은 수동 단계가 없으면 done 으로 바꾼다. 중간 PR 은 `pr` 필드를 비워 `merged-pr` 에 쌓고 `남은 일:` 줄을 둔다. 그 밖에 판정하지 못하면 마지막 PR 로 본다. 옛 항목의 규칙은 `board-sync.ts` 머리 주석이 소유한다 |
| 배포 성공 뒤 | `board-sync.ts`, `finish-pr.ts` | 마일스톤 항목의 `[deploy]` 단계를 끝내고, 마지막 PR 이 done 지점에 닿았으면 done 으로 바꾼다. `finish-pr.ts` 는 마지막 PR 인지 판정하지 못하면 중간 PR 로 본다. `merged-pr` 의 PR 은 다시 판정하지 않는다 |
| 릴리스 뒤 | `board-release.ts` | 저장소가 부른다. 릴리스에 든 PR 의 항목에서 `[release]` 단계까지 끝내고, done 지점에 닿았으면 done 으로 바꾼다 |
| 사건 꼬리표 확인 | `board-sync.ts`, `board-release.ts` | done 을 제외한 goal 과 수동 항목도 줄 끝의 `(#PR번호 사건)` 을 읽어 그 줄만 끝낸다. 다른 줄과 항목 상태는 그대로 둔다 |
| 결정·수동 단계 변경 | 코디네이터 | decide·wait 상태와 꼬리표 없는 수동 단계의 완료를 `orch board set`, `orch board step` 으로 반영한다. 번호 없는 결정 줄은 `board.ts mark` 로 끝낸다. 자동 반영이 빠졌을 때만 사건 단계를 직접 고친다 |

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

보드 파일과 도구 위치, 추적 항목 목록(`--items-file`) 같은 하위 호환 옵션은 스크립트 머리 주석이 소유한다.

## 못 맞춘 머지와 남은 수동 단계

옛 단계 항목은 마지막 PR 이어도 그 PR 번호(`#N`)가 적힌 줄만 끝낸다. 근거 괄호 `(앞 사건: #N merge)` 안의 번호는 세지 않는다. 남은 단계가 없으면 done, 있으면 doing 이고 PR 은 `merged-pr` 에 옮긴다. 중간 PR 은 남은 단계가 없어도 doing 이다. `PR!`(`--complete`)도 같은 규칙이며, `--board-id` 로 항목을 직접 정한 마무리만 done 을 강제한다. 마일스톤 항목의 기존 완료 규칙은 그대로다.

머지를 가리키는 줄이 하나도 없고 끝나지 않은 단계가 남으면 `BOARD-UNMATCHED <항목> PR #<번호>` 를 기록한다. 이미 끝난 줄도 참조로 세므로 마일스톤 항목의 둘째 PR 에는 잘못 알리지 않는다. `orch board show` 는 풀리지 않은 기록을 함께 보인다. 기록은 보드 형식을 바꾸지 않고 orch 루트의 `state/board-unmatched.json` 에 둔다.

사건 표시 없는 옛 단계 정의로 띄운 항목도 PR 번호가 없으면 같은 알림을 받는다. 반복해서 만드는 단계 정의에는 `[merge]` 를 붙이면 머지 사건과 연결된다. 현재 항목의 알림을 푸는 방법은 [기다리기의 알림 처리](waiting.md#못-맞춘-머지-알림)를 따른다.

### 업무 번호와 주소

`orch board set <항목> --task-ref <번호>` 와 `--task <주소>` 로 넣거나 고친다. 빈 값은 그 칸만 지운다. 번호만 넣으면 상주 루프가 주소를 만든다. `dooray` 어댑터는 `/` 없는 번호에 기본 프로젝트를 붙인다.


이미 PR 이 있는 항목은 자동으로 업무 번호를 채우지 않는다.
