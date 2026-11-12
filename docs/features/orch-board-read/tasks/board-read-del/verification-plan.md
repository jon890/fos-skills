# 보드 읽기와 지우기 명령 인수 검증 계획

스펙: `docs/features/orch-board-read/spec.md`. 설계: `docs/features/orch-board-read/design.md`.

verify 가 구현 커밋에서 실제 명령을 불러 스펙의 인수 조건을 확인한다. phase 의 테스트는 개발 검증이고, 이 계획은 진입점부터 셸까지 이어지는 동작을 본다.

## 준비

저장소 루트에서 한 번 실행한다. 임시 저장소 `$T` 와 그 워크트리 `$T/wt` 를 만들고, 이 체크아웃의 스크립트로 `orch` 를 부르게 한다. 저장소의 `.omc/board.json` 은 건드리지 않는다.
`ORCH_DIR` 은 지운다. 이 변수가 있으면 못 맞춘 머지 기록이 임시 저장소가 아니라 그 폴더에 쓰인다.
명령은 셸 함수로 둔다. zsh 는 따옴표 없는 변수를 낱말로 나누지 않아 `ORCH="node …"; $ORCH board …` 꼴이 「명령을 찾을 수 없다」 로 끝난다.

```bash
R="$PWD"
export ORCH_SCRIPTS_DIR="$R/skills/orch/scripts"
unset ORCH_DIR
orch_() { node "$R/bin/orch" "$@"; }
board_ts() { node --disable-warning=ExperimentalWarning "$R/extensions/work-board/bin/board.ts" "$@"; }
BASE="$(git merge-base origin/main HEAD)"
T=$(mktemp -d)
git -C "$T" init -q -b main
git -C "$T" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git -C "$T" worktree add -q -b feat/x "$T/wt"
mkdir -p "$T/.omc"
node -e '
const items = [
  { id: "a", status: "doing", title: "주문 API", branch: "feat/a", pr: 555, details: [{ text: "1. 구현", done: true }, { text: "2. [ask] 머지 (#70 merge)", done: false }, { text: "3. 배포 확인", done: false }] },
  { id: "b", status: "done", title: "끝난 일" },
  { id: "c", status: "done" },
  { id: "d", status: "wait", title: "기다리는 일" },
  { id: 7, status: "done", title: "숫자 id" },
]
require("fs").writeFileSync(process.argv[1], JSON.stringify({ items }, null, 1))
' "$T/.omc/board.json"
cp "$T/.omc/board.json" "$T/board.orig.json"
```

- 「보드 되돌리기」 는 `cp "$T/board.orig.json" "$T/.omc/board.json"; rm -f "$T/.omc/board.json.bak"` 이다.
- 명령은 `(cd "$T" && orch_ board list)` 처럼 임시 저장소 안에서 부른다. 워크트리 사례만 `cd "$T/wt"` 다. 아래 표의 `orch_ board` 호출은 모두 이렇게 감싼 것이다.
- 「기록 두기」 는 항목 `a` 에 PR 99 의 못 맞춘 머지 기록을 두는 아래 명령이다. `BOARD-UNMATCHED a PR #99` 한 줄을 낸다. 「기록 지우기」 는 `rm -rf "$T/.orch"` 다.

  ```bash
  node --disable-warning=ExperimentalWarning --input-type=module -e '
  const { recordUnmatched } = await import(process.argv[1] + "/skills/orch/scripts/lib/board-unmatched.ts")
  console.log(recordUnmatched(process.argv[2], { id: "a" }, [{ number: 3, done: false, text: "3. 배포 확인" }], "99"))' "$R" "$T"
  ```

- `jq` 가 없으면 `node -e` 로 같은 값을 읽는다.
- 끝나면 `git -C "$T" worktree remove --force "$T/wt"; rm -rf "$T"` 로 치운다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 위 준비 | `orch_ board --help` 를 본다. `cd "$T/wt"` 에서 `--repo` 없이 `orch_ board get a status` 와 `orch_ board list` 를 부른다 | 도움말에 `orch board get`, `orch board list`, `orch board del` 이 있다. 워크트리에서 부른 값이 `doing` 이고 `list` 가 주 checkout 보드의 항목을 낸다. `$T/wt/.omc` 가 생기지 않는다 | 로컬 임시 저장소, 이 체크아웃의 스크립트 | worker | 없음 | PR 전 |
| REQ1 | 보드 되돌리기 | `cd "$T/wt"` 에서 `--repo` 없이 `orch_ board del b` 를 부르고 `orch_ board list --status done` 을 본다 | `BOARD-DEL b` 가 나오고 주 checkout 의 보드에서 `b` 가 사라진다. `$T/wt/.omc` 가 생기지 않는다 | 같다 | worker | 없음 | PR 전 |
| REQ1 | `$T/.orch/config.json` 의 `finish.board` 를 `chosen.json` 으로 두고 `$T/chosen.json` 에 `a` 의 상태가 `wait` 인 보드를 둔다 | `orch_ board get a status` 를 부른 뒤 설정 파일과 `chosen.json` 을 지운다 | `wait` 가 나온다(기본 보드의 `doing` 이 아니다) | 같다 | worker | 없음 | PR 전 |
| REQ2 | 보드 되돌리기 | `orch_ board get a foo; echo $?` 와 `orch_ board get a branch` | 앞의 것은 종료 코드 2 이고 stderr 에 `branch`, `merged-pr`, `step` 이 든 칸 목록이 있다. 뒤의 것은 `feat/a` 한 줄이다 | 같다 | worker | 없음 | PR 전 |
| REQ3 | 보드 되돌리기 | `b=$(cd "$T" && orch_ board get a branch); [ "$b" = "feat/a" ]; echo $?` 를 부른다. 이어 `get a progress`, `get a step 2`, `get a pr`, `get c title` 을 부른다 | 비교가 0 이다. 차례로 `1/3`, `2. [ask] 머지 (#70 merge)`, `555`, `c` 가 앞뒤에 다른 글 없이 나온다 | 같다 | worker | 없음 | PR 전 |
| REQ4 | 보드 되돌리기 | `out=$(cd "$T" && orch_ board get b branch); echo "[$out] $?"` 를 부른다. 이어 `get nope status`, `get a step 9`, `get 7 status`, `get d progress` 의 stdout 과 종료 코드를 본다 | `[] 4` 다. `nope` 와 `7` 은 종료 코드 1 과 `항목이 없다`, `step 9` 는 종료 코드 1 과 `있는 번호: 1 2 3`, `d progress` 는 빈 stdout 과 4 다 | 같다 | worker | 없음 | PR 전 |
| REQ5 | 보드 되돌리기 | `orch_ board list`, `list --status done`, `list --status doing,wait`, `list --status goal`, `list --status foo; echo $?` 를 부른다 | 다섯 줄이 파일 순서로 나오고 첫 줄이 `BOARD a doing 1/3 주문 API`, `c` 줄이 `BOARD c done 진행률 없음 c` 다. `done` 은 세 줄(`b`, `c`, `7`), `doing,wait` 는 두 줄, `goal` 은 `BOARD-NONE` 과 종료 코드 0, `foo` 는 종료 코드 1 과 허용 값 안내다 | 같다 | worker | 없음 | PR 전 |
| REQ5 | 보드 되돌리기, 기록 두기 | `orch_ board list --full` 과 `orch_ board list` 를 부른 뒤 기록 지우기 | `--full` 은 `a` 머리 줄 바로 아래에 `BOARD-UNMATCHED a PR #99`, 이어 `✓ 1. 구현` 과 남은 두 단계가 나온다. `--full` 이 없으면 `BOARD-UNMATCHED` 줄이 없고 항목마다 한 줄이다 | 같다 | worker | 없음 | PR 전 |
| REQ6 | 보드 되돌리기 | `orch_ board del a; echo $?` 뒤 `cmp "$T/.omc/board.json" "$T/board.orig.json"` 을 본다. 이어 `del nope; echo $?`, `del b`, `del a --force` 를 부른다 | 첫 호출은 종료 코드 1 이고 stderr 에 `지금 doing` 과 `--force` 가 있고 보드가 그대로다. `nope` 는 종료 코드 1 과 `항목이 없다` 다. `del b`(`done` 항목)는 `BOARD-DEL b` 를 낸다. `--force` 는 `BOARD-DEL a` 를 내고 `a` 가 사라진다 | 같다 | worker | 없음 | PR 전 |
| REQ6 | 보드 되돌리기 | 빈 변수로 `id=""; orch_ board del "$id"; echo $?` 를 부르고 `cmp "$T/.omc/board.json" "$T/board.orig.json"` 을 본다 | 종료 코드 1 이고 stdout 이 비고 보드가 그대로다. `done` 항목이 지워지지 않는다 | 같다 | worker | 없음 | PR 전 |
| REQ7 | 보드 되돌리기 | `orch_ board del --done` 을 부르고 `cp "$T/.omc/board.json" "$T/after.json"; sleep 1` 뒤 한 번 더 부른다. `cmp "$T/.omc/board.json" "$T/after.json"` 을 본다. 이어 `del --done b; echo $?`, `del --done --force; echo $?` 를 부른다 | 첫 호출은 `BOARD-DEL b`, `BOARD-DEL c`, `BOARD-DEL 7` 세 줄이고 `a`, `d` 만 남는다. 둘째 호출은 `BOARD-NONE` 과 종료 코드 0 이고 보드 바이트가 그대로다(다시 저장했다면 `updatedAt` 의 초가 달라진다). 뒤의 둘은 종료 코드 2 다 | 같다 | worker | 없음 | PR 전 |
| REQ7 | 보드 파일이 없는 새 임시 저장소 | 그 안에서 `orch_ board del --done` 을 부른다 | `BOARD-NONE` 과 종료 코드 0 이고 `.omc` 폴더가 생기지 않는다 | 같다 | worker | 없음 | PR 전 |
| REQ8 | 보드 되돌리기 | `orch_ board del a`(거절) 뒤 `.bak` 가 없는지 본다. `del b` 뒤 `cmp "$T/.omc/board.json.bak" "$T/board.orig.json"` 을 본다. `cp "$T/.omc/board.json" "$T/before2.json"` 뒤 `del --done` 을 부르고 `.bak` 를 `before2.json` 과 비교한다. 이어 `del a`(거절)를 부르고 `.bak` 를 다시 `before2.json` 과 비교한다 | 거절 뒤에는 `.bak` 가 없다. `del b` 뒤의 `.bak` 가 지우기 전 보드와 같다. `del --done` 뒤의 `.bak` 가 그 호출 직전 보드와 같다. 뒤의 거절이 `.bak` 를 바꾸지 않는다 | 같다 | worker | 없음 | PR 전 |
| REQ9 | 보드 되돌리기 | `show a --json`, `list --status done --json`, `get b branch --json`, `get a progress --json`, `get nope status --json` 을 부르고 `jq` 로 읽는다 | 각각 `.branch` 가 `feat/a`, `.pr` 이 숫자 `555`, `.progress` 가 `[1,3]`, `.unmatched` 가 `[]`, `.lines` 의 길이가 3 이다. 배열 길이가 3 이고 원소에 `unmatched` 키가 없다. `.value` 가 `null` 이고 종료 코드 4 다. `.value` 가 `"1/3"` 이다. 마지막은 stdout 이 비고 종료 코드 1 이다 | 같다 | worker | 없음 | PR 전 |
| REQ9 | 보드 되돌리기, 기록 두기 | `orch_ board show a --json` 을 `jq .unmatched` 로 읽은 뒤 기록 지우기 | `[99]` 다(숫자 배열) | 같다 | worker | 없음 | PR 전 |
| REQ10 | 보드 되돌리기 | `echo other > "$T/.omc/board.json.lock"` 을 두고 `orch_ board get a branch` 와 `list` 가 걸리는 시간을 본 뒤 잠금 파일을 지운다 | 둘 다 5초를 기다리지 않고 바로 값을 낸다 | 같다 | worker | 없음 | PR 전 |
| REQ10 | 보드 되돌리기 | 잠금 파일을 다시 두고 `(cd "$T" && orch_ board del b; echo "code=$?") &` 로 띄운다. 1초 뒤 보드 파일에서 `b` 의 상태를 `doing` 으로 바꿔 쓰고(`node -e` 로 파일을 다시 쓴다. 임시 보드라 직접 쓴다) 잠금 파일을 지운 뒤 `wait` 한다 | `code=1` 이고 stderr 에 `지금 doing` 이 있고 `b` 가 보드에 남는다. `extensions/work-board/tests/board-del.spec.ts` 의 잠금 사례도 같은 것을 본다 | 같다 | worker | 없음 | PR 전 |
| REQ11 | 보드 되돌리기 | `orch_ board get a; echo $?`, `orch_ board del; echo $?`, `orch_ board list extra; echo $?` 를 부른다. 이어 `orch_ board get b branch; echo $?` 를 부른다 | 앞의 셋은 종료 코드 2 와 `orch board` 사용법이다. 마지막은 PATH 의 실행기와 같은 `bin/orch` 를 지나서도 4 다(3 이 아니다) | 같다 | worker | 없음 | PR 전 |
| REQ12 | 구현 커밋 | `git diff --stat "$BASE" -- extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/board-step-mark.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/board-run.ts` 가 비었는지 보고 `node scripts/run-tests.ts 'extensions/work-board/tests/board*.spec.ts'` 를 돌린다 | 이 브랜치가 main 에서 갈라진 뒤로 기존 `board.ts` 테스트 파일과 도우미가 바뀌지 않았고 모두 통과한다 | 이 체크아웃 | worker | 없음 | PR 전 |
| REQ12 | 보드 되돌리기 | `board_ts del nope --file "$T/.omc/board.json"; echo $?` 를 부른다. 이어 `board_ts list --file "$T/.omc/board.json"` 의 앞 두 줄을 본다 | `del` 은 종료 코드 0 이고 아무것도 내지 않으며 `.bak` 를 만들지 않는다. `list` 의 첫 줄이 `doing`, `a`, `주문 API`, `1/3 (33%)` 순서이고 둘째 줄이 `    1 ✓ 1. 구현` 이다(지금 출력 꼴 그대로다. 정확한 칸 맞춤은 기존 `board.spec.ts` 의 `list` 사례가 고정한다) | 같다 | worker | 없음 | PR 전 |
