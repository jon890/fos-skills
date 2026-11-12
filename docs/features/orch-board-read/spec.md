# orch: 보드 항목을 `orch board` 명령으로 읽고 지운다

확인: 2026-11-12

## 목표

코디네이터가 보드 항목의 값 하나(상태, 브랜치, PR, 워크트리, 진행률, N번 단계 글)를 `orch board get` 한 줄로 꺼내 셸 변수에 바로 담는다. 보드 전체 보기와 끝난 항목 지우기도 `orch board list`, `orch board del` 로 해서, 플러그인 경로의 `board.ts` 를 직접 부르지 않는다. 스크립트가 읽을 때는 `--json` 으로 같은 내용을 받는다.

- 배경(사용자 2026-11-12): 「보드 기능도 CLI 화… 특정 항목을 읽을 때 바로 값을 꺼내 줄 수 있도록」.
- 배경: 보드 명령 스펙([`orch-board-cli`](../orch-board-cli/spec.md))과 구현 PR(#433, #435, #437, #441, #452)은 고치기(`set`, `step`, `add-step`)와 `show` 까지 다뤘다. 코디네이터의 아침 정리는 아직 보드 전체 보기(`board.ts list`)와 done 항목 지우기(`board.ts del <id>`)를 플러그인 경로로 직접 부른다.

## 조사한 사실

| 대상 | 사실 | 근거 |
| --- | --- | --- |
| 지금 `orch board` | `set`, `step`, `add-step`, `show` 와 `approval`, `sync`, `release`, `auto-check`, `goal` 이 있다. 읽기·지우기 동작은 `show` 뿐이다 | `skills/orch/scripts/lib/commands.ts` 의 board 묶음 |
| `show` 의 출력 | 머리 `BOARD <항목> <상태> <끝낸>/<전체>`, 아직 안 풀린 `BOARD-UNMATCHED <항목> PR #<번호>` 줄, 미완료 단계를 낸다. 브랜치, PR, 워크트리 칸은 내지 않는다. `--json` 옵션은 받지 않아 사용법 오류(종료 코드 2)다 | `skills/orch/scripts/board/board-edit.ts` 의 `OPTIONS`, `main` |
| `board.ts view` | 읽기 전용 JSON 한 줄(`id`, `status`, `was`, `progress`, `rev`, `lines`)을 낸다. 칸 값(제목, 브랜치, PR, 워크트리, 업무 주소)은 넣지 않는다. `show` 가 이것을 부른다 | `extensions/work-board/bin/board.ts` 의 `itemView` |
| `board.ts list` | 항목마다 `<상태> <id> <제목>   <진행률 n/m (p%)>` 한 줄과 그 아래 모든 줄(mark 번호, ✓)을 낸다. 필터가 없고 JSON 이 없다 | `board.ts` 의 `apply` 의 `list` 분기 |
| `board.ts` 의 id 맞추기 | 명령줄 id 는 문자열이라 숫자 id(`1`) 항목은 찾지 못한다 | `board.ts` 머리 주석, `find` |
| `board.ts del` | 상태를 보지 않고 지운다. 없는 id 여도 거절하지 않고 종료 코드 0 이다. 지우기 전 사본(`.bak`)을 남기지 않는다(`.bak` 는 `set --detail`, `--next` 만 남긴다) | `board.ts` 의 `del` 분기, `main` 의 `copyFileSync` |
| 잠금 | 쓰기는 `<보드 파일>.lock` 을 읽기부터 저장까지 잡는다. `list`, `steps`, `view` 는 잠그지 않는다. 저장은 임시 파일에 쓴 뒤 이름을 바꾸므로 읽는 쪽이 반쯤 쓴 파일을 보지 않는다 | `board.ts` 머리 주석, `saveBoard` |
| 항목 칸 | `id`, `title`, `status`, `owner`, `pr`, `worktree`, `branch`, `merged-pr`, `task`, `progress`, `stages`, `details`, `next`, `stepAt`. `set` 옵션으로 고치는 칸(`FIELDS`)은 `title`, `owner`, `pr`, `worktree`, `branch`, `merged-pr`, `task`, `progress`, `stages` 이고 `status` 는 `set` 의 위치 인자다. `pr`, `merged-pr` 은 숫자 하나 또는 「492, 495」 꼴 문자열이다. 새 항목의 `title` 은 없으면 id 로 채운다 | `board.ts` 의 `FIELDS`, `prValue`, `apply` |
| 진행률 | `progress` 칸(N/M)이 있으면 그 값, 없으면 단계 줄을 센다. 둘 다 없으면 진행률이 없다 | `board.ts` 의 `progressOf` |
| 종료 코드 3 | `orch` 실행기가 설치본을 못 찾을 때 3 으로 끝난다. 공통 지시서의 셸 함수도 같은 때 3 을 돌려준다 | `bin/orch` 37, 94행, `skills/orch/templates/spec-common.md` 의 `worker-ask` 블록 |
| 짧은 출력과 `--json` | 진입점이 `--json` 이 있는 호출은 짧은 출력으로 줄이지 않고 그대로 낸다 | `skills/orch/scripts/lib/output.ts` 의 `short` |

## 범위

이번 범위:

- `orch board` 의 새 동작 셋: `get`, `list`, `del`
- `show`, `list`, `get` 의 `--json`
- 새 규칙(칸 값 꺼내기, 상태 필터, done 만 지우기, 없는 항목 거절)을 `board.ts` 에 더하고 `orch board` 는 얇게 감싸기

범위 밖:

- 칸 값을 고치는 `orch board` 동작(제목, PR, 브랜치 따위). 지금처럼 `board.ts set` 으로 고친다
- 여러 항목을 한 번에 지우는 꼴 가운데 `del --done` 밖의 것(상태별, 날짜별)
- 지운 항목을 되살리는 명령. 되살릴 때는 `.bak` 파일을 직접 연다
- 보드 창(work-board mod)의 표시 변경
- 아래 「스펙이 머지되면 바꿀 곳」 의 문서 고치기. 구현 PR 이 맡는다

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | `orch board get <항목> <칸>`, `orch board get <항목> step <번호>`, `orch board list`, `orch board del <항목>`, `orch board del --done` 을 부를 수 있다. 보드 파일 찾기와 `--repo`, `--board` 는 보드 명령 스펙의 REQ2 와 같다 | `orch board --help` 와 명령 표(`lib/commands.ts`)가 세 동작을 보인다. 워크트리 안에서 `--repo` 없이 불러도 주 checkout 의 보드를 읽고 지운다. `finish.board` 로 정한 보드가 있으면 그 파일을 쓴다 |
| REQ2 | `get` 이 받는 칸은 `status`, `title`, `owner`, `pr`, `merged-pr`, `branch`, `worktree`, `task`, `stages`, `progress` 와 `step <번호>` 다. 다른 칸 이름은 사용법 오류이고 stderr 에 받는 칸 목록이 나온다 | `get <항목> foo` 가 종료 코드 2 이고 stderr 에 칸 목록이 있다. `get <항목> branch` 가 브랜치 이름만 낸다 |
| REQ3 | `get` 은 값만 한 줄로 stdout 에 낸다. 앞뒤 머리나 칸 이름을 붙이지 않는다. `pr`, `merged-pr` 은 저장된 값 그대로(`555` 나 `492, 495`)다. `progress` 는 `<끝낸>/<전체>` 이고 `show` 와 같이 센다. `step <번호>` 는 그 단계 줄에 저장된 글 그대로다. 자동 진행 표시(`[ask]`), 줄 앞 사건 표시(`[merge]`), 줄 끝 꼬리표(`(#1455 merge)`)를 남기고 끝냄 표시(`✓`)는 붙이지 않는다. `title` 칸이 없는 옛 항목은 id 를 낸다. 단계 고르기는 보드 명령 스펙의 REQ3 과 같다(줄 앞 번호, 단계를 세는 쪽, 같은 번호 둘이면 거절) | `b=$(orch board get <항목> branch)` 뒤 `$b` 가 브랜치 이름과 바이트가 같다. `get <항목> progress` 가 `3/5` 다. `get <항목> step 2` 가 `2. [ask] 머지 (#70 merge)` 처럼 저장된 줄 글을 그대로 낸다 |
| REQ4 | 칸이 비었으면(칸이 없거나 빈 문자열, 진행률이 없음) stdout 에 아무것도 내지 않고 종료 코드 4 로 끝난다. 없는 항목과 없는 단계 번호는 거절이고 종료 코드 1 과 stderr 이유다(없는 단계는 있는 번호를 함께 알린다). 숫자 id 항목은 보드 명령 스펙 REQ8 처럼 「항목이 없다」 다 | 브랜치 칸이 없는 항목에 `get <항목> branch` 가 빈 stdout 과 종료 코드 4 다. 없는 id 는 종료 코드 1 과 「항목이 없다」 다. 단계가 1~3번인 항목에 `get <항목> step 9` 는 종료 코드 1 과 「있는 번호: 1 2 3」 이다 |
| REQ5 | `list` 는 항목마다 한 줄 `BOARD <항목> <상태> <끝낸>/<전체> <제목>` 을 보드 파일 순서로 낸다. 진행률이 없으면 그 자리에 `진행률 없음` 이다. `--status <상태>` 는 그 상태 항목만 낸다. 쉼표로 여럿(`--status doing,wait`)을 준다. 다섯 상태 밖의 값은 거절(종료 코드 1, 허용 값 안내)이다. 낼 항목이 없으면 `BOARD-NONE` 한 줄과 종료 코드 0 이다. `--full` 은 항목마다 그 아래 `show --full` 과 같은 줄(안 풀린 `BOARD-UNMATCHED` 줄 포함)을 잇는다. `--full` 이 없으면 `BOARD-UNMATCHED` 줄을 내지 않는다 | 항목 셋인 보드에서 `list` 가 세 줄을 낸다. `list --status done` 이 done 항목만 낸다. 빈 보드에서 `BOARD-NONE` 한 줄이다. `list --status foo` 는 종료 코드 1 이다 |
| REQ6 | `del <항목>` 은 `done` 항목만 지운다. 다른 상태면 거절(종료 코드 1)하고 stderr 에 지금 상태와 `--force` 안내를 낸다. `--force` 가 있으면 상태와 무관하게 지운다. 없는 항목은 거절이다. 성공은 `BOARD-DEL <항목>` 한 줄이다 | doing 항목에 `del <항목>` 이 종료 코드 1 이고 보드 바이트가 그대로다. 같은 항목에 `del <항목> --force` 가 지우고 `BOARD-DEL <항목>` 을 낸다. 없는 id 는 종료 코드 1 과 「항목이 없다」 다 |
| REQ7 | `del --done` 은 `done` 항목을 한 번에 모두 지우고 지운 항목마다 `BOARD-DEL <항목>` 한 줄을 낸다. 숫자 id 항목도 상태가 `done` 이면 지운다. 지울 항목이 없으면 `BOARD-NONE` 한 줄과 종료 코드 0 이고 보드 파일을 다시 저장하지 않는다(파일이 없으면 만들지 않는다). `--done` 과 항목 id, `--done` 과 `--force` 를 함께 주면 사용법 오류다 | done 둘, doing 하나인 보드에서 `del --done` 이 두 줄을 내고 doing 항목만 남는다. 다시 부르면 `BOARD-NONE` 이다 |
| REQ8 | 지우는 호출(`del <항목>`, `del --done`)은 저장 직전 파일을 `<보드 파일>.bak` 에 한 세대 남긴다. 지울 항목이 없거나 거절한 호출은 `.bak` 를 바꾸지 않는다 | `del --done` 뒤 `.bak` 의 내용이 지우기 전 보드와 같다. 거절된 `del` 뒤 `.bak` 가 그대로다 |
| REQ9 | `show --json`, `list --json`, `get --json` 은 JSON 을 낸다. 항목 객체는 저장된 칸(`id`, `title`, `status`, `owner`, `pr`, `merged-pr`, `branch`, `worktree`, `task`, `stages`, `stepAt` 가운데 있는 것)과 계산한 `progress`(`[끝낸, 전체]` 또는 `null`), 줄 목록 `lines`(`[{"number", "done", "text", "in"}]`, `board.ts view` 와 같은 꼴)를 갖는다. 저장된 `progress` 칸 값은 계산한 `progress` 로 대신한다. `show --json` 은 항목 객체 하나에 안 풀린 못 맞춘 머지 PR 번호 목록 `unmatched`(숫자 배열, 없으면 `[]`)를 더한다. `list --json` 은 항목 객체 배열(필터 반영, 없으면 `[]`, `unmatched` 없음)이다. `get --json` 은 `{"id", "field", "value"}` 이고 `step` 이면 `"field": "step"` 과 `"number"` 를 더한다. `value` 는 JSON 없는 `get` 이 내는 글과 같은 문자열이고 빈 칸은 `null` 이다. 종료 코드는 JSON 이 없을 때와 같다. 거절(종료 코드 1, 2)은 stdout 을 비우고 stderr 에만 이유를 쓴다 | `show <항목> --json | jq -r .branch` 가 브랜치를 낸다. `list --status done --json | jq length` 가 done 항목 수다. 빈 칸의 `get --json` 은 `value` 가 `null` 이고 종료 코드 4 다. `get <항목> progress --json` 의 `value` 가 `"3/5"` 다. 없는 항목의 `get --json` 은 stdout 이 비고 종료 코드 1 이다 |
| REQ10 | 읽기(`get`, `list`, `show`)는 보드 잠금을 잡지 않는다. 지우기(`del`)는 보드 명령 스펙 REQ11 의 잠금을 지키고, 상태 확인과 지우기를 같은 잠금 안에서 한다 | 다른 프로세스가 잠금을 잡고 있어도 `get` 이 기다리지 않고 값을 낸다. 다른 프로세스가 잠금을 잡은 동안 done 항목을 doing 으로 바꾸면, 기다리던 `del <항목>` 이 잠금을 얻은 뒤 새 상태를 읽어 종료 코드 1 로 거절하고 항목이 남는다 |
| REQ11 | 출력과 종료 코드는 보드 명령 스펙 REQ8 의 꼴을 따른다: 0 성공, 1 거절, 2 사용법 오류. 이 스펙이 더하는 것은 `get` 의 4(값 없음) 하나다. 종료 코드 3 은 `orch` 실행기가 쓰므로 쓰지 않는다 | 인자를 빠뜨린 호출은 종료 코드 2 와 사용법이다. 거절한 호출은 보드 바이트가 그대로다 |
| REQ12 | 새 규칙은 `board.ts` 한 곳에 둔다. `orch board` 는 보드 파일 찾기, 인자 풀이, 짧은 출력만 맡는다. `board.ts` 의 기존 호출(`list`, `del`, `view` 포함)은 인자, 출력, 종료 코드가 지금과 같다 | `board.ts` 의 기존 테스트가 고치지 않고 통과한다. `board.ts del <없는 id>` 는 지금처럼 종료 코드 0 이다. `board.ts list` 출력이 바뀌지 않는다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 범위 | `get`, `list`, `del`, `--json`(show·list·get) 넷 모두 | 사용자 2026-11-12 | 범위 인터뷰 답 |
| DECISION2 | `get` 의 출력 | 값만 한 줄. 셸에서 `b=$(orch board get x branch)` 로 바로 쓴다. 빈 칸은 종료 코드로 구분한다 | 사용자 2026-11-12 | 범위 인터뷰 답 |
| DECISION3 | `del` 의 대상 | `done` 항목만. 다른 상태는 `--force` 로 지운다. done 을 한 번에 비우는 `del --done` 을 둔다 | 사용자 2026-11-12 | 범위 인터뷰 답. 진행 중 항목을 id 오타로 지우지 않게 한다 |
| DECISION4 | technical-design 담당 | Fable 실험 5/5 로 맡긴다 | 사용자 2026-11-12 | 범위 인터뷰 답 |
| DECISION5 | `get` 이 꺼내는 칸 | `status`, `title`, `owner`, `pr`, `merged-pr`, `branch`, `worktree`, `task`, `stages`, `progress`, `step <번호>`. 이름은 저장된 칸 이름(`board.ts set` 옵션 이름)과 같다. `stepAt`, `details`, `next` 는 `--json` 으로만 본다 | 사용자 2026-11-12 | 저장된 칸 이름과 같아 따로 외울 것이 없다 |
| DECISION6 | 「값 없음」 과 「없는 항목」 의 종료 코드 | 값 없음 4, 없는 항목·없는 단계 1(거절), 모르는 칸 이름 2 | 사용자 2026-11-12 | 1·2 는 보드 명령 스펙 REQ8 의 뜻 그대로다. 3 은 `orch` 실행기가 설치본을 못 찾을 때 쓴다 |
| DECISION7 | `list` 의 꼴과 필터 | 한 줄 `BOARD <항목> <상태> <끝낸>/<전체> <제목>`(`show` 머리에 제목을 붙인 꼴), 단계 줄은 `--full` 에서만, `--status a,b` 필터, 빈 결과는 `BOARD-NONE` | 사용자 2026-11-12 | 짧은 출력이 orch 관례다(`docs/features/orch-cli/spec.md` DECISION5). 아침 정리는 상태와 진행률만 본다 |
| DECISION8 | `del --done` 이 지우기 전에 목록을 보이는지 | 묻지 않고 바로 지우고 지운 id 를 한 줄씩 낸다. 지우기 전 파일을 `.bak` 에 한 세대 남긴다 | 사용자 2026-11-12 | 확인 창은 코디네이터 셸에서 답할 수 없다. 먼저 보려면 `list --status done` 을 부른다 |
| DECISION9 | 읽기 잠금 | 읽기는 잠그지 않는다 | 작성자 | `board.ts` 의 `list`, `steps`, `view` 가 이미 잠그지 않고, 저장이 이름 바꾸기라 읽는 쪽이 반쯤 쓴 파일을 보지 않는다 |
| DECISION10 | `--json` 항목 객체의 꼴 | 저장된 칸 이름 그대로에 계산한 `progress` 와 `board.ts view` 꼴의 `lines` 를 더한다. `was`, `rev` 는 넣지 않는다 | 작성자 | 칸 이름이 `board.ts set` 과 같아 소비자가 따로 외울 것이 없다. `was` 는 고치기 결과에만 뜻이 있고 `rev` 는 고치기 쪽(`--if-rev`)이 쓴다 |
| DECISION12 | `get step` 이 내는 글 | 저장된 줄 글 그대로(자동 진행 표시와 사건 꼬리표 포함), 끝냄 표시만 뺀다 | 작성자 | `show` 가 같은 글을 낸다. 표시를 빼면 `step text` 로 다시 쓸 때 꼬리표가 사라져 보드 명령 스펙 REQ4 의 거절에 걸린다 |
| DECISION13 | `get --json` 의 `value` 타입 | JSON 없는 출력과 같은 문자열 또는 `null`. 타입 있는 값은 `show --json` 으로 본다 | 작성자 | 두 출력이 같은 값을 내야 소비자가 헷갈리지 않는다. `pr` 은 숫자와 문자열이 섞여 저장된다 |
| DECISION14 | 거절된 호출의 `--json` | stdout 은 비우고 stderr 에 이유, 종료 코드로 구분한다 | 작성자 | 보드 명령 스펙 REQ8 의 거절 꼴과 같다. 오류 JSON 을 내면 `jq` 소비자가 성공 객체로 잘못 읽을 수 있다 |
| DECISION15 | `list` 의 `BOARD-UNMATCHED` | 기본 출력에는 넣지 않고 `--full` 에만 넣는다. `show --json` 에는 `unmatched` 로 넣는다 | 작성자 | 기본 `list` 는 항목당 한 줄을 지킨다. 못 맞춘 머지는 루프가 따로 알린다 |
| DECISION16 | 옛 항목과 숫자 id | 제목 칸이 없으면 id 를 낸다. 숫자 id 는 `get`, `del <항목>` 에서 「항목이 없다」, `del --done` 은 상태만 보고 지운다 | 작성자 | `board.ts` 가 새 항목의 제목을 id 로 채운다. 숫자 id 거절은 보드 명령 스펙 REQ8 과 같다. `del --done` 은 id 를 명령줄로 받지 않아 맞추기 문제가 없다 |
| DECISION17 | 지울 것 없는 `del --done` | 보드 파일과 `.bak` 를 건드리지 않는다 | 작성자 | 아침 정리마다 부르는 명령이라 빈 호출이 `updatedAt` 을 바꾸면 보드 창이 바뀐 것처럼 보인다 |
| DECISION11 | `board.ts` 의 기존 `del`, `list` | 그대로 둔다. 없는 항목 거절, done 만 지우기, 상태 필터는 `board.ts` 의 새 옵션이나 새 동작으로 더한다. 이름은 technical-design 이 정한다 | 작성자 | 보드 명령 스펙 REQ13 과 DECISION5(얇은 감싸기). 루프와 창이 기존 호출을 부를 수 있다 |

## 스펙이 머지되면 바꿀 곳

구현 PR 이 고친다. 이 스펙 PR 에서는 고치지 않는다.

| 자리 | 지금 | 바꿀 내용 |
| --- | --- | --- |
| `skills/orch/references/board.md` 38행 | 「항목을 지울 때는 `board.ts del` 을 쓴다」 | `orch board del`(done 만, `--force`, `--done`)로 바꾸고, 「상태와 단계 고치기」 명령 목록에 `get`, `list`, `del` 과 `--json` 을 더한다 |
| `skills/orch/references/board.md` 8행 | `board.ts` 직접 호출은 orch 설정을 읽지 않으니 `--file` 을 주라는 안내 | 읽기·지우기는 `orch board` 가 맡으므로 직접 호출 안내를 칸 고치기(`board.ts set`)와 `mark` 로 좁힌다 |
| `extensions/work-board/README.md` 114~129행 | `BOARD_BIN` 으로 `board.ts list` 를 부르는 예시 | 보드 보기는 `orch board list` 로, `board.ts` 예시는 칸 고치기만 남긴다 |
| `skills/orch/scripts/lib/commands.ts` board 묶음 | `set`, `step`, `add-step`, `show` | `get`, `list`, `del` 줄을 더한다 |
| 코디네이터 아침 정리 | `board.ts list`, `board.ts del <id>` 직접 호출 | 저장소 문서(`skills/orch/`, `.orch/overlay.md`, `~/.claude/references/`)에서는 이 절차를 찾지 못했다. 코디네이터가 기억하는 습관이면 `orch board list`, `orch board del --done` 으로 바꾸라고 머지 알림에 적는다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 보드 형식은 `docs/data-schema.md` 와 `skills/orch/references/board.md` 가 정한 그대로 두고, 읽기와 지우기 입구만 더한다.
