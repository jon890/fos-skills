# Phase 03. 보드 맞추기와 마무리가 PR 마다 자기 묶음을 끝낸다

**Execution profile**: standard

## 목표

보드 맞추기와 완료 확인이 구현·후속 줄마다 PR 을 잇고, PR 필드의 PR 을 하나씩 보아 각 PR 의 열림·머지가 자기 묶음 단계만 끝내게 한다. 열린 PR 이 남은 동안은 마지막 PR 로 보지 않는다. 머지 마무리(`finish-pr`)와 릴리스 확인도 같은 규칙을 쓴다.

**범위 외**: 창(phase 04).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ4·DECISION16·DECISION22, `docs/features/board-item-workers/design.md` 「대표 칸을 읽는 곳」 의 PR 잇기 행과 「PR 여럿이 열린 항목」, 설계 결정 DECISION4

- 선행: PR1 과 이 계획 phase 01·02. phase 01 의 `prStages`, `eventKinds`, `mergedCommands` 의 `remaining`·`kinds`, `board.ts worker-set`.
- `skills/orch/scripts/board/board-sync.ts`: `prNumber`(146행, 첫 PR 하나만 읽는다), `prState`, 마일스톤 갈래(377-455행). PR 잇기는 `if (!item.pr && branch)` 로 대표 브랜치 하나만 본다(380행). 머지 반영은 `judge`, `mergedCommands`, `deployPending`, `deploymentFor` 를 쓴다. 반영한 명령은 `guardedCommands(…, linesRev(item))` 로 줄 지문 가드를 붙인다.
- `skills/orch/scripts/queue/finish-pr.ts`: 마일스톤 항목의 반영(619-630행 근처)이 `mergedCommands({ ...row, id: item }, steps, stagesOf(row) ?? stages, args.pr, …)` 를 부른다.
- 테스트의 가짜 gh 와 보드 꼴은 `skills/orch/tests/board-sync.spec.ts`, `skills/orch/tests/finish-pr.spec.ts` 의 기존 사례를 따른다.

## 의도 메모

- 한 틱에 항목마다 머지 하나만 반영한다(번호가 작은 것). 반영 명령이 그 틱의 줄 지문을 쓰므로 둘을 한 번에 쓰면 뒤 명령이 거절된다(설계 DECISION4).
- 줄이 없는 옛 항목과 PR 이 하나인 항목은 지금 결과와 같아야 한다.

## 작업 항목

### 1. PR 잇기(`board-sync.ts`, `lib/board.ts`)

- `board-sync.ts`, `workers` 줄이 있는 항목:
  - `stages` 가 있는 후속 줄마다 `pr` 이 비었으면 줄의 `branch` 로 지금과 같은 방식(열린 PR 목록, 없으면 그 브랜치의 가장 최근 머지 PR 가운데 `merged-pr` 에 없는 것)으로 PR 을 찾는다. 찾으면 `worker-set <id> --worktree <줄 워크트리> --pr N` 과, 항목 `pr` 필드에 N 을 더한 값의 `set <id> --pr "<목록>"` 을 낸다.
  - 항목 `stages` 묶음의 PR 은 지금 규칙(380-397행)으로 잇되, 조건을 「`pr` 필드가 비었을 때」 에서 「`pr` 필드에 묶음 없는 PR 이 없을 때」 로, 브랜치를 「`stages` 가 없는 가장 최근(`at`) 구현·후속 줄의 브랜치」 로 바꾼다. 그런 줄이 없으면 대표 브랜치다. 찾은 PR 은 `pr` 필드 목록에 더하고 그 줄에도 `worker-set` 으로 적는다.
  - 첫 연결이면 지금처럼 `--fill --task-ref` 도 붙인다.
- 줄이 없는 옛 항목은 지금 규칙 그대로다.
- `lib/board.ts` 의 `findBoardItems`: 브랜치·워크트리로 찾을 때 「`pr` 필드가 비고 대표 칸이 같은 항목」 에 더해, 「줄의 브랜치·워크트리가 같고 그 줄의 `pr` 이 비었으며 `merged-pr` 에 그 PR 이 없는 항목」 도 찾는다. `linkBoardPr` 는 줄로 찾은 항목이면 `worker-set` 과 `pr` 필드 목록 더하기를 쓴다. 이 둘을 부르는 `loop/completion-watch.ts`, `queue/finish-pr.ts`, `loop/steps/auto-merge.ts` 는 호출을 바꾸지 않는다.

### 2. 같은 파일의 마일스톤 갈래

- 항목 `pr` 필드의 PR 을 번호 순으로 모두 본다(`prNumbers`). 상태는 `stateFor` 로 캐시해 읽는다. 하나라도 읽지 못했으면 이 항목은 이번 틱에 고치지 않는다(`hold`).
- 열린 PR 마다 `prStages(item, n)` 의 `[pr]` 단계를 끝낸다(`advanceCommands(…, 'pr', { last: false, … })`).
- 머지된 PR 가운데 `merged-pr` 에 없는 가장 작은 번호 하나만 반영한다. `remaining` 은 같은 칸의 다른 PR 가운데 열려 있거나 머지됐지만 아직 반영하지 않은 것이다. 그래야 같은 틱에 둘이 머지돼도 번호가 작은 쪽이 마지막 PR 로 판정되지 않는다.
  - `remaining` 이 비지 않았으면 판정 함수를 부르지 않고 `last: false`, `reached: 'merge'`, `note: null` 로 `mergedCommands(item, steps, prStages(item, n), n, 'merge', { last: false, doneAfter, note: null, remaining, kinds: eventKinds(item) })` 를 부른다.
  - 비었으면 지금처럼 판정하고 배포를 본다. 묶음은 `prStages(item, n)`, `kinds` 는 `eventKinds(item)` 다.
- 이미 반영한 마지막 PR(`merged-pr` 에 있고 `pr` 필드에 남은 것)의 배포 대기도 `prStages` 로 본다.
- 기능 검증 대기(`featureCompletionProblem`)와 마무리 진행(`finish-<PR>.pid`) 판정은 반영할 PR 번호로 본다.
- 갱신 필요 알림(`staleSteps`, 211행)과 시각 대기 갈래(337행)가 `stagesOf` 로 사건 단계를 빼는 곳을 `eventNumbers(item)` 로 바꾼다.
- 머리 주석의 마일스톤 항목 설명에 「PR 필드에 PR 이 여럿이면 PR 마다 그 묶음(`core/milestones.ts` 의 「PR 묶음」)을 끝낸다. 한 틱에 머지 하나만 반영한다」 를 더한다.

### 3. `skills/orch/scripts/queue/finish-pr.ts`

- 마일스톤 반영에서 묶음을 `prStages(row, args.pr) ?? stages` 로 고른다. 항목 `pr` 필드에 이 PR 밖의 PR 이 있으면 그 상태를 읽어 닫히지 않은 것(열림, 머지됨, 읽지 못함)을 `remaining` 으로 넘기고, 비지 않았으면 마지막 PR 판정 대신 `last: false` 로 본다. 배포 성공은 `remaining` 이 빌 때만 본다.

### 4. `skills/orch/scripts/board/board-release.ts`

- `mergedCommands(item, steps, stages, pr, 'release', …)`(238행)에 `kinds: eventKinds(item)` 을 넘긴다. 묶음은 항목 `stages` 그대로다(릴리스 단계는 항목에 하나다). 그래서 done 지점 판정이 후속 묶음 단계를 수동 단계로 세지 않는다.

### 5. 테스트

- `skills/orch/tests/board-sync.spec.ts`:
  - 줄 둘(impl `feat/a`, follow `feat/b` 의 `stages: 'pr=3,merge=4'`)과 열린 PR 둘(가짜 gh)이 있는 항목은 한 틱 뒤 `pr` 필드가 두 번호이고 1·3 단계가 끝난다.
  - 뒤 PR 만 MERGED 면 3·4 만 끝나고 항목은 doing, `pr` 필드는 앞 PR 하나, `merged-pr` 에 뒤 PR 이 있다. 판정 함수(가짜 gh 의 `pr view --json title,headRefName`)를 부르지 않는다.
  - 그 뒤 앞 PR 이 MERGED 면 1·2 가 끝나고 done 이다(`done_after` 기본). `stages` 에 `deploy` 가 있고 배포 설정과 `board.done_after: deploy` 가 있으면 마지막 PR 의 배포 성공 전에는 done 이 아니다. `done_after` 기본값(merge)이면 마지막 PR 머지 때 done 이고 배포 단계는 남는다.
  - 두 PR 이 같은 틱에 MERGED 면 그 틱에는 번호가 작은 PR 만 반영된다.
  - 남은 PR 의 상태를 읽지 못하면 항목이 그대로다.
  - 줄 없는 옛 항목의 기존 사례가 그대로 통과한다.
  - 대표가 후속 줄(`stages` 있음)로 바뀐 항목에서 impl 줄의 브랜치에 PR 이 열리면 그 PR 이 `pr` 필드에 더해지고 impl 줄의 `pr` 이 채워진다.
  - 후속 묶음 단계에 머지된 PR 번호가 적혀 있어도 갱신 필요 알림이 나오지 않는다.
- `skills/orch/tests/finish-pr.spec.ts`: 다른 열린 PR 이 `pr` 필드에 있는 항목의 머지 마무리는 자기 묶음만 끝내고 done 으로 바꾸지 않는다. `pr` 필드가 아직 비었고 impl 줄의 브랜치가 머지 PR 의 브랜치인 항목을 찾는다.
- `skills/orch/tests/board-release.spec.ts`: 후속 묶음 단계가 모두 끝난 항목의 릴리스 반영이 done 으로 바꾼다.
- `skills/orch/tests/lib-board.spec.ts`: `findBoardItems` 가 줄의 브랜치로 항목을 찾는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/board-release.spec.ts skills/orch/tests/board-unmatched.spec.ts skills/orch/tests/lib-board.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/board/board-sync.ts` | 수정 (줄마다 PR 잇기, PR 마다 묶음 반영, 사건 단계 번호) |
| `skills/orch/scripts/queue/finish-pr.ts` | 수정 (prStages, 남은 열린 PR) |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/scripts/lib/board.ts` | 수정 (findBoardItems, linkBoardPr 의 줄 찾기) |
| `skills/orch/scripts/core/milestones.ts` | 수정 (`hasPrGroup`: 그 PR 이 후속 묶음을 갖는지) |
| `docs/features/board-item-workers/design.md` | 수정 (남은 PR 의 뜻) |
| `skills/orch/scripts/board/board-release.ts` | 수정 (eventKinds) |
| `skills/orch/tests/board-release.spec.ts` | 수정 |
| `skills/orch/tests/lib-board.spec.ts` | 수정 |
