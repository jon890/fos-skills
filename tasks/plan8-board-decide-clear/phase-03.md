# Phase 03. 띄울 때 중간 과정은 기존 항목에 한 줄만 남기고, done 항목은 다시 연다

**Execution profile**: deep

## 목표

충돌 해결, CI 고침, 리뷰 반영 worker 를 띄워도 보드에 새 항목이 생기지 않는다. 이미 done 인 항목에 새 worker 를 붙이면 그 항목이 doing 으로 다시 열린다.

**범위 외**: work-board 의 줄과 질문(phase 01, 02), 충돌 지시서 이름과 지우기(phase 04).

## 컨텍스트

- `orch/scripts/lib/board.ts` 의 `registerBoard(repo, spec, worktree, name, branch)` 를 `orch/scripts/launch-worker.ts` 가 띄운 뒤 부른다. 실패는 `launch-worker` 가 `보드를 갱신하지 못했다` 로 알리고 띄우기는 성공으로 둔다.
  지시서의 `보드 항목 id:` 가 없으면 같은 워크트리나 브랜치의 끝나지 않은 항목을 이어 쓰고, 없으면 새 항목을 만든다. 이어 쓰는 항목이 단계를 가지면 `set <id> doing --worktree --branch` 만 한다.
- 같은 파일의 `prNumbers`, `detailArgs`, `detailText`, `NOTE`(`남은 일: `) 를 쓴다. 보드 명령은 `BOARD_BIN` 의 `set`, `steps` 다.
- `orch/scripts/board-sync.ts` 는 `pr` 필드가 빈 항목의 브랜치로 머지된 PR 을 찾고, 찾은 PR 이 `merged-pr` 의 첫 번호(`prNumber`, 쉼표 앞)와 같으면 다시 연결하지 않는다. `pr` 필드의 PR 이 MERGED 면 항목을 done 으로 바꿀 수 있다.
- 코디네이터 실측(2026-10-26): `보드 항목 id:` 로 done 항목에 새 worker 를 띄우면 worktree 와 title 만 바뀌고 done 으로 남아 창에서 사라졌다.

**근거 문서**: `docs/adr/015-board-decide-clear.md`

## 의도 메모

- 중간 과정은 지시서 제목이나 파일 이름으로 판정하지 않는다. `중간 과정:` 줄 하나로 명시한다.
- 중간 과정의 항목 찾기에 `findBoardItems` 를 쓰지 않는다. 그 함수는 `pr` 필드가 빈 항목만 브랜치로 찾는데, CI 고침 worker 의 항목은 대개 `pr` 필드가 차 있다.
- 다시 열 때 옛 PR 을 `merged-pr` 의 맨 앞에 둔다. `board-sync.ts` 가 첫 번호만 비교한다.

## 작업 항목

### 1. `orch/scripts/lib/board.ts` 의 중간 과정

- `INTERIM = '중간 과정: '` 을 export 한다.
- `interimOf(text): { pr: string | null } | null` 을 export 한다. 지시서 줄 `^\s*(?:[-*]\s*)?중간 과정\s*:\s*(.+)$` 이 없으면 null 이다. 값에서 `#(\d+)` 를 먼저 찾고, 없으면 첫 `\d+` 를 PR 번호로 쓴다. 숫자가 없으면 `pr: null` 이다.
- `registerBoard` 는 이 줄이 있으면 새 항목을 만들지 않는다. done 이 아닌 항목 가운데 `prNumbers(item.pr)` 에 그 PR 이 든 항목을 찾고, 없거나 PR 번호가 null 이면 done 이 아닌 항목 가운데 `branch` 가 같거나 `worktree` 가 `basename(worktree)` 인 항목을 찾는다(`pr` 필드는 보지 않는다).
  하나면 그 항목의 details 에서 `INTERIM` 으로 시작하는 줄을 빼고 `중간 과정: <지시서 첫 # 제목>` 한 줄을 끝에 둔 목록으로 `set <id> --worktree <basename> --branch <branch> ...detailArgs` 를 부른다. 다른 줄의 완료 값은 `detailArgs` 가 보존한다. status, 제목, pr 은 바꾸지 않는다.
  없거나 둘 이상이면 보드를 쓰지 않고 `Error('중간 과정 지시서의 보드 항목을 찾지 못해 만들지 않는다: ...')` 를 던진다.

### 2. `orch/scripts/lib/board.ts` 의 다시 열기

- 중간 과정이 아니고 `보드 항목 id:` 로 정한 항목이 있고 그 status 가 done 이면 다시 연다. 같은 워크트리나 브랜치로 찾을 때 done 항목은 지금처럼 고르지 않는다.
- 새 하위 줄: 기존 details 에서 `NOTE` 줄을 빼고 나머지는 모두 완료로 둔다. 지시서 「할 일」 의 번호 줄(없으면 `1. 구현`, `2. 리뷰 반영`, `3. 머지`)의 앞 번호를 기존 단계 번호의 최댓값 다음 번호부터 차례로 고쳐 끝에 붙인다. 기존 단계 번호는 `board.ts steps` 대신 details 줄의 앞 번호(`/^(\d+)[.)]?\s/`)에서 읽는다. 없으면 1 부터다.
- 명령: `set <id> doing --title <지시서 제목> --worktree <basename> --branch <branch> --pr '' --merged-pr <옛 pr 칸의 번호들, 이어서 기존 merged-pr 의 번호들(중복 제외)> ...detailArgs`. 옛 pr 칸이 비었으면 `--pr ''` 와 `--merged-pr` 를 주지 않는다.
- 머리 주석과 `registerBoard` 위 주석에 두 규칙을 적는다.

### 3. 문서

- `orch/references/board.md` 의 「갱신 담당」 표 첫 줄에 `중간 과정:` 줄의 처리와 done 항목 다시 열기를 적는다. 코디네이터 줄의 `board.ts set/step` 에 `mark` 를 더한다.
- `orch/references/spec-writing.md` 에 CI 고침, 리뷰 반영, 충돌 해결처럼 기존 PR 을 마무리하는 지시서는 `중간 과정: PR #N` 줄을 넣는다고 적는다.

### 4. 테스트

- `orch/tests/lib-board.spec.ts`: `interimOf` 가 `중간 과정: PR #7` 에서 7, `- 중간 과정: 2차 PR #7` 에서 7, `중간 과정: 리뷰 반영` 에서 null PR, 줄이 없으면 null 을 낸다.
- `orch/tests/launch-worker.spec.ts`:
  - `중간 과정: PR #7` 지시서로 띄우면 pr 이 7 인 기존 doing 항목에 `중간 과정: ...` 줄 하나만 생기고 항목 수, 제목, status, 기존 단계의 완료 값이 그대로다. 두 번 띄워도 그 줄은 하나다.
  - 맞는 항목이 없으면 보드에 항목이 생기지 않고 stderr 에 `보드를 갱신하지 못했다` 가 나온다.
  - `보드 항목 id: a` 가 가리키는 done 항목(pr 12, merged-pr 9, 단계 `1. 구현`, `2. 머지` 완료, `남은 일:` 줄)에 띄우면 doing 이 되고, 옛 두 단계는 완료, 지시서의 할 일 두 줄이 `3. …`, `4. …` 로 붙고, `남은 일:` 줄은 없고, pr 칸이 없고, merged-pr 이 `12, 9` 다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-board.spec.ts orch/tests/launch-worker.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

기대값: 모두 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/board.ts` | 수정 |
| `orch/references/board.md` | 수정 |
| `orch/references/spec-writing.md` | 수정 |
| `orch/tests/lib-board.spec.ts` | 수정 |
| `orch/tests/launch-worker.spec.ts` | 수정 |
