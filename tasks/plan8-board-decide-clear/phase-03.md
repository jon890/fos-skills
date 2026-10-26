# Phase 03. 중간 과정은 보드 항목을 만들지 않고 충돌 지시서는 PR 마다 하나다

**Execution profile**: deep

## 목표

충돌 해결, CI 고침, 리뷰 반영 worker 를 띄워도 보드에 새 항목이 생기지 않고, 루프의 충돌 지시서는 PR 마다 하나이며 머지 뒤 마무리가 지운다.

**범위 외**: work-board 의 줄과 질문(phase 01, 02).

## 컨텍스트

- `orch/scripts/lib/board.ts` 의 `registerBoard(repo, spec, worktree, name, branch)` 를 `launch-worker.ts` 가 띄운 뒤 부른다. 지시서의 `보드 항목 id:` 가 없으면 같은 워크트리나 브랜치의 끝나지 않은 항목을 이어 쓰고, 없으면 새 항목을 만든다.
- 같은 파일의 `findBoardItems(file, pr, branch, worktree)` 가 PR 번호, 브랜치, 워크트리로 항목을 찾는다. `detailArgs`, `detailText` 가 하위 줄을 다룬다.
- `orch/scripts/lib/conflicts.ts` 의 `resolveConflict` 가 끝난 dispatch 에 `spec-conflict-<PR>-<base SHA 앞 8자리>.md` 를 `followUp` 으로 쓰고 `send-to-worker --spec` 으로 이어 쓴다. 알림 기록 키는 `<PR>@<base SHA>` 다.
- `orch/scripts/finish-pr.ts` 는 머지 뒤 마지막 PR 이면 `deleteBranchSpecs` 로 `브랜치:` 줄이 그 브랜치인 지시서를 지운다. 지우기는 `lib/spec.ts` 의 `deleteSpecs` 와 `liveSpecPaths` 다.
- 지시서 폴더는 `lib/paths.ts` 의 `pathOf('specs', repo)` 다.

**근거 문서**: `docs/adr/015-board-decide-clear.md`, `docs/data-schema.md` 의 「orch 루트에 더하는 파일」

## 의도 메모

- 중간 과정은 지시서 제목이나 파일 이름으로 판정하지 않는다. `중간 과정:` 줄 하나로 명시한다.
- 알림 기록 키는 바꾸지 않는다. base 가 움직이면 다시 알리고 같은 파일을 덮어쓴다.

## 작업 항목

### 1. `orch/scripts/lib/board.ts`

- `INTERIM = '중간 과정: '` 을 export 한다. 지시서 줄 `^\s*(?:[-*]\s*)?중간 과정\s*:\s*(.+)$` 을 읽는 `interimOf(text)` 를 export 한다. 값에서 첫 `#?\d+` 를 PR 번호로 꺼낸다(없으면 null).
- `registerBoard` 는 그 줄이 있으면 `findBoardItems(file, pr ?? '', branch, basename(worktree))` 로 항목을 찾는다. PR 번호가 없으면 끝나지 않은 항목 가운데 branch 나 worktree 가 같은 것을 찾는다.
  찾은 항목이 하나면 그 항목의 details 에서 `중간 과정: ` 으로 시작하는 줄을 빼고 `중간 과정: <지시서 첫 # 제목>` 한 줄을 끝에 둔다(`board.ts set <id> --detail ...`). status, 제목, 단계, pr 은 바꾸지 않는다.
  없거나 둘 이상이면 아무것도 쓰지 않고 `Error` 를 던져 `launch-worker` 가 `보드를 갱신하지 못했다` 로 알리게 한다.
- `중간 과정:` 줄이 없고 이어 쓸 항목(지시서의 `보드 항목 id:` 나 같은 워크트리, 브랜치로 찾은 항목)이 done 이면 다시 연다.
  status 를 doing 으로 바꾸고, 기존 하위 줄은 모두 완료로 두고 `남은 일:` 줄은 뺀다. 지시서 「할 일」 의 번호 줄(없으면 구현·리뷰 반영·머지)을 기존 단계 번호의 최댓값 다음 번호부터 고쳐 이어 붙인다.
  `pr` 칸의 PR 은 `merged-pr` 로 옮기고 `pr` 칸을 비운다. 남기면 `board-sync.ts` 가 다음 틱에 그 머지 PR 로 항목을 다시 done 으로 바꾼다(코디네이터 실측 2026-10-26).
  같은 워크트리나 브랜치로 찾을 때 done 항목은 지금처럼 고르지 않는다. 다시 열기는 `보드 항목 id:` 로 정한 항목에만 한다.

### 2. `orch/scripts/lib/conflicts.ts`

- `conflictSpecPath(repo, pr)` 를 export 한다. `<지시서 폴더>/spec-conflict-<PR>.md` 다. `resolveConflict` 가 이 경로를 쓴다.
- `followUp` 이 `브랜치:` 줄 다음에 `중간 과정: PR #<PR>` 줄을 쓴다.
- `conflictSpecFiles(repo, pr)` 를 export 한다. 지시서 폴더에서 `spec-conflict-<PR>.md` 와 옛 `spec-conflict-<PR>-<8자리 16진수>.md` 경로를 낸다. 폴더가 없으면 빈 목록이다.
- 머리 주석에 지시서 이름 규칙을 적는다. `orch/scripts/notify-conflicts.ts` 머리 주석의 지시서 이름도 고친다.

### 3. `orch/scripts/finish-pr.ts`

- 마지막 PR 판정 뒤, 마지막과 중간 모두 `conflictSpecFiles(repo, pr)` 를 `deleteSpecs` 로 지운다. root 는 지시서 폴더 실경로의 부모, live 는 `liveSpecPaths(args.run)` 이다. `--specs-dir` 와 상관없다.
- 머리 주석의 단계 5 에 적는다.

### 4. 문서

- `orch/references/board.md` 의 「갱신 담당」 표 첫 줄에 `중간 과정:` 줄의 처리를 적는다.
- `orch/references/spec-writing.md` 에 CI 고침, 리뷰 반영, 충돌 해결처럼 기존 PR 을 마무리하는 지시서는 `중간 과정: PR #N` 줄을 넣는다고 적는다.
- `orch/CHANGELOG.md` 에 `4.4.0` 을 더하고 `orch/SKILL.md` 의 `metadata.version` 을 `4.4.0` 으로 올린다.

### 5. 테스트

- `orch/tests/lib-board.spec.ts`: `interimOf` 가 줄과 PR 번호를 읽는다.
- `orch/tests/launch-worker.spec.ts`: `보드 항목 id:` 가 가리키는 done 항목에 띄우면 doing 이 되고 옛 단계는 완료, 새 단계는 이어진 번호로 붙고, pr 칸이 비고 merged-pr 에 옛 PR 이 든다.
- `orch/tests/launch-worker.spec.ts`: `중간 과정: PR #7` 지시서로 띄우면 pr 이 7 인 기존 항목에 줄 하나만 생기고 항목 수, 제목, status 가 그대로다. 두 번 띄워도 줄은 하나다. 찾지 못하면 항목을 만들지 않는다.
- `orch/tests/notify-conflicts.spec.ts`, `orch/tests/orch-loop-conflict.spec.ts`: 지시서 이름이 `spec-conflict-7.md` 이고 `중간 과정: PR #7` 줄이 있다. base 가 움직여도 파일은 하나다.
- `orch/tests/finish-pr.spec.ts`: 중간 PR 판정에서도 `spec-conflict-<PR>.md` 와 옛 이름 파일이 지워지고 다른 PR 의 충돌 지시서는 남는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-board.spec.ts orch/tests/launch-worker.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/orch-loop-conflict.spec.ts orch/tests/finish-pr.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
```

기대값: 모두 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/board.ts` | 수정 |
| `orch/scripts/lib/conflicts.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/references/board.md` | 수정 |
| `orch/references/spec-writing.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/tests/lib-board.spec.ts` | 수정 |
| `orch/tests/launch-worker.spec.ts` | 수정 |
| `orch/tests/notify-conflicts.spec.ts` | 수정 |
| `orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `orch/tests/finish-pr.spec.ts` | 수정 |
