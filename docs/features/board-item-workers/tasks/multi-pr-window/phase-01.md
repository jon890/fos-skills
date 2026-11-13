# Phase 01. PR 마다의 단계 묶음을 다루는 순수 함수와 보드 명령

**Execution profile**: standard

## 목표

후속 worker 줄이 자기 PR·머지 단계 번호(`stages`)를 갖게 하고, PR 하나의 단계 묶음을 고르는 `prStages` 와 여러 묶음을 아는 done 판정을 순수 함수로 둔다.

**범위 외**: 띄울 때 단계를 더하는 일(phase 02), 보드 맞추기와 마무리의 호출(phase 03), 창(phase 04).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ4·DECISION7·DECISION16·DECISION22, `docs/features/board-item-workers/design.md` 「보드 명령」·「PR 여럿이 열린 항목」, `docs/adr/033-board-item-worker-rows.md`, `docs/adr/018-board-milestone-steps.md`

- 선행: PR1(`attach-workers`)이 main 에 있다. `extensions/work-board/bin/board.ts` 의 `worker-add`·`worker-end` 와 `skills/orch/scripts/core/board-workers.ts` 의 `boardWorkerRows` 를 쓴다. 이 계획의 행 번호는 PR1 전 코드 기준이라 구현 전에 함수 이름으로 다시 찾는다.
- `skills/orch/scripts/core/milestones.ts`: `stagesOf`, `doneStep`, `advanceCommands`(168행 근처), `mergedList`, `mergedCommands`(199행 근처). `advanceCommands` 는 마지막 PR 이 done 지점에 닿으면 그 번호까지의 남은 단계를 모두 끝내고, 사건 번호 집합(`events`)에 든 단계만 done 뒤에 남겨도 된다. `mergedCommands` 는 중간 PR 에 `['set', id, '--pr', '', '--merged-pr', …]` 를 낸다.
- `skills/orch/scripts/core/auto-advance.ts` 의 `eventDone`(14-22행). PR 이 하나인 항목(`prs.size === 1`)에서만 `stages` 번호로 merge 밖 사건을 본다.
- 테스트: `skills/orch/tests/lib-milestones.spec.ts`, `skills/orch/tests/core-auto-advance.spec.ts`, `extensions/work-board/tests/board-workers.spec.ts`(PR1 이 만든 파일).

## 의도 메모

- 배포·릴리스 단계는 항목에 하나씩이다. 후속 묶음은 PR·머지 두 단계만 갖는다(스펙 REQ4).
- 묶음 없는 항목(줄이 없거나 줄에 `stages` 가 없음)은 지금 결과와 같아야 한다. 기존 테스트가 그대로 통과하는 것이 회귀 확인이다.

## 작업 항목

### 1. `extensions/work-board/bin/board.ts`

- `worker-add` 에 `--stages S` 를 받는다. 값은 `pr=N,merge=M` 꼴(`STAGES` 정규식 가운데 pr·merge 만)이고 아니면 사용법 오류(종료 코드 2)다. 지금 `set --stages` 는 `main` 에서 검사해 종료 코드 1 을 내므로(777-781행 근처), `worker-add` 의 값은 `parse` 에서 따로 검사한다. 줄의 `stages` 에 저장한다. 같은 열쇠의 줄을 바꿀 때 `--stages` 를 주지 않으면 그대로 둔다.
- 새 명령 `worker-set <id> --worktree W [--pr N]`: 그 워크트리 줄의 `pr` 만 바꾼다. `status` 는 바꾸지 않는다. 맞는 줄이 없으면 쓰지 않고 종료 코드 0. 머리 주석과 `HELP` 에 적는다.
- 사건 단계 번호(`stageNumbers`, 463행 근처)에 줄 `stages` 의 번호도 합친다. 그래서 `step-mark` 가 후속 묶음 단계를 거절하고, 그 글이 바뀌면 경고한다. bin 은 orch 를 import 하지 않으므로 같은 규칙을 이 파일 안에 둔다.
- `extensions/work-board/tests/board-workers.spec.ts` 에 `--stages` 저장, 틀린 값(종료 코드 2), `worker-set` 이 끝난 줄의 `status` 를 바꾸지 않는 사례, 후속 묶음 단계의 `step-mark` 거절을 더한다.

### 2. `skills/orch/scripts/core/milestones.ts`

- `prStages(item, pr: string): Stages | null`: `boardWorkerRows(item)` 가운데 `prNumbers(row.pr).has(pr)` 이고 `stages` 가 있는 줄이 있으면 그 줄의 `pr`·`merge` 에 `stagesOf(item)` 의 `deploy`·`release` 를 더한 값, 없으면 `stagesOf(item)` 이다.
- `eventKinds(item): Map<number, StageKind>`: 항목 `stages` 와 모든 줄 `stages` 의 번호 → 사건 종류. `eventNumbers(item): Set<number>` 는 그 키다.
- `advanceCommands` 에 선택 인자 `kinds?: Map<number, StageKind>` 를 더한다. 주면 done 으로 닫을 때 끝내는 단계를 「끝나지 않은 수동 단계 가운데 done 지점 번호 이하」 와 「`kinds` 의 사건 단계 가운데 종류가 done 지점 종류 이하」 로 정하고, done 을 막는 「남은 단계」 는 `kinds` 에 없는 수동 단계만 센다. 주지 않으면 지금 동작 그대로다.
- `mergedCommands` 의 `opts` 에 `remaining?: string[]`(이 PR 뒤에도 `pr` 필드에 남을 열린 PR)을 더한다. 중간 PR 이면 `--pr` 값을 `remaining.join(', ')`(없으면 `''`)으로 쓴다. `kinds` 를 `advanceCommands` 에 넘긴다.
- 머리 주석에 「PR 묶음」 단락을 더한다. 설계 「PR 여럿이 열린 항목」 의 규칙(묶음 고르기, 남은 열린 PR 이 있으면 마지막이 아님, 배포는 마지막으로 머지된 PR 의 배포, done 지점의 종류 비교)을 적는다.

### 3. 사건 단계를 알아보는 orch 자리

- `skills/orch/scripts/lib/auto-advance.ts` 의 `firstPendingStep`(38행 근처)이 `stagesOf` 로 사건 단계를 알아보는 곳을 `eventNumbers(item)` 로 바꾼다. 후속 묶음 단계가 자동 진행 표시의 대상이 되지 않는다.

### 4. `skills/orch/scripts/core/auto-advance.ts`

- `BoardView` 에 `groups: Array<{ pr: string; stages: Stages }>`(선택)를 더한다. `eventDone` 은 그 PR 의 묶음이 있으면 묶음 번호의 단계가 끝났는지 보고, 없으면 지금 규칙이다. `BoardView` 를 만드는 곳(`skills/orch/scripts/lib/auto-advance.ts`)이 `prStages` 로 채운다.

### 5. 테스트

- `skills/orch/tests/lib-milestones.spec.ts`: 항목 `stages` 가 `pr=1,merge=2,deploy=3` 이고 후속 줄(`pr: 9`, `stages: 'pr=4,merge=5'`)이 있을 때 `prStages(item, '9')` 가 `{pr:4, merge:5, deploy:3}` 이고, 다른 PR 은 항목 `stages` 다. 줄이 없는 항목은 `stagesOf` 와 같다.
- 같은 항목에서 PR 9 가 마지막(`last: true`, `doneAfter: 'merge'`, `kinds` 줌)이고 1·2 가 끝났을 때 `advanceCommands` 는 4·5 를 끝내고 3(deploy)을 남기며 done 이다. 수동 단계 6 이 남았으면 done 이 아니다. `kinds` 없이 부르면 지금 결과와 같다.
- `mergedCommands` 에 `remaining: ['7']` 을 주면 중간 PR 명령의 `--pr` 이 `7` 이다.
- `skills/orch/tests/core-auto-advance.spec.ts`: 두 PR 이 있는 항목에서 `eventDone(items, '9', 'merge')` 와 `'pr'` 이 묶음 번호로 판정된다.
- `skills/orch/tests/board-auto-check.spec.ts`: 첫 미완료 단계가 후속 묶음의 `[pr]` 단계인 항목은 자동 진행 대상이 아니다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-milestones.spec.ts skills/orch/tests/core-auto-advance.spec.ts skills/orch/tests/board-auto-check.spec.ts extensions/work-board/tests/board-workers.spec.ts skills/orch/tests/core-boundary.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/board.ts` | 수정 (worker-add --stages, worker-set, stageNumbers 의 줄 묶음) |
| `extensions/work-board/tests/board-workers.spec.ts` | 수정 |
| `skills/orch/scripts/core/milestones.ts` | 수정 (prStages, eventKinds, eventNumbers, kinds·remaining 인자) |
| `skills/orch/scripts/core/auto-advance.ts` | 수정 (eventDone 의 묶음) |
| `skills/orch/scripts/lib/auto-advance.ts` | 수정 (BoardView 의 groups, firstPendingStep 의 사건 단계) |
| `skills/orch/tests/board-auto-check.spec.ts` | 수정 |
| `skills/orch/tests/lib-milestones.spec.ts` | 수정 |
| `skills/orch/tests/core-auto-advance.spec.ts` | 수정 |
