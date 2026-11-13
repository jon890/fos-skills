# Phase 02. 새 브랜치 후속 worker 가 PR·머지 두 단계를 더한다

**Execution profile**: standard

## 목표

후속 worker 가 앞 PR 이 열린 기존 항목에 새 브랜치로 붙으면 PR·머지 두 단계를 다음 번호로 더하고 그 번호를 후속 줄의 `stages` 로 적는다.

**범위 외**: 그 단계를 끝내는 보드 맞추기(phase 03). 다시 열기(done 항목을 id 로 정함, 또는 merged-pr 이 있고 단계를 모두 끝낸 doing)와, 앞 PR 이 아직 없거나 머지됐는데 단계가 남은 항목의 동작은 바꾸지 않는다(스펙 DECISION22 「앞 PR 이 아직 열려 있을 때만」).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ4·DECISION7·DECISION16·DECISION22·DECISION25, `docs/features/board-item-workers/design.md` 「역할 정하기」·「PR 여럿이 열린 항목」 의 단계 더하기와 결정 DECISION6

- 선행: PR1(`attach-workers`)과 이 계획 phase 01. `skills/orch/scripts/lib/board.ts` 의 `registerBoard` 구현·후속 갈래가 PR1 에서 역할과 `worker-add` 를 갖는다. 다시 열기 판정(`nextPr`, `explicit && item.status === 'done'`)과 마일스톤 정의(`milestones()`, `milestoneLines`)를 재사용한다.
- 단계 줄을 더하는 보드 명령은 `board.ts step-add <id> <글>`(번호가 없으면 가장 큰 번호 다음)이다. `set --detail` 로 전체를 다시 쓰지 않는다. 사용자가 고친 단계 글을 덮지 않기 위해서다.
- 마일스톤 정의는 `core/milestones.ts` 의 `MilestoneStep`(`kind`, `text`)이고 기본값은 `DEFAULT_STEPS`(`[pr] PR`, `[merge] 머지`)다.

## 의도 메모

- 「새 브랜치」 는 대표 `branch` 와 항목의 어느 구현·후속 줄의 `branch` 와도 다른 브랜치다. 대표 칸을 함께 보아야 줄 없는 옛 항목의 원격 이어받기가 단계를 더하지 않는다. 같은 브랜치의 재시도와 원격 이어받기는 단계를 더하지 않는다(스펙 DECISION18).
- `중간 과정:` 후속과 리뷰·검증은 단계를 더하지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/board.ts`

- 구현·후속 갈래에서 역할이 `follow` 이고 브랜치가 비지 않았고 새 브랜치이며 다시 열기 조건이 아니고, 항목 `pr` 필드에 `merged-pr` 에 없는 PR 이 있으면(앞 PR 이 열림. gh 를 부르지 않는다): 마일스톤 정의에서 `[pr]`·`[merge]` 줄의 글을 고르고(없으면 `DEFAULT_STEPS` 의 글), 지금 가장 큰 단계 번호 다음 두 번호로 `<번호>. <글> (<워크트리 이름>)` 두 줄을 `step-add` 로 더한다. 그 두 번호를 `pr=N,merge=N+1` 로 만들어 `worker-add ... --stages` 에 넘긴다.
- 순서: 단계 더하기 → `worker-add` → 지금의 `set`(PR1 에서 대표 칸을 뺀 것). `step-add` 가 하나라도 거절되면(done 항목 등) stderr 로 알리고 `worker-add` 는 `--stages` 없이 부른다. 줄은 남고 그 PR 은 항목 `stages` 묶음으로 읽힌다. 두 번째만 실패해 남은 한 단계는 수동 단계로 남는다.
- 머리 주석의 순서 설명에 이 갈래를 더한다.

### 2. `skills/orch/tests/board-attach.spec.ts`

- `stages: 'pr=1,merge=2'`, `pr: 7`(열림), impl 줄(`feat/a`)이 있는 항목에 업무 번호가 같은 후속 지시서(`feat/b`, 워크트리 `wb`)를 띄우면 단계가 넷이 되고 3·4 번 줄 글 끝에 `(wb)` 가 있으며, follow 줄의 `stages` 가 `pr=3,merge=4` 다.
- 같은 워크트리로 다시 띄우면 단계 수가 그대로다. 줄 없는 옛 항목에 대표 `branch` 와 같은 브랜치로 다시 띄워도 그대로다. 리뷰 지시서를 붙이면 단계 수가 그대로다. `pr` 필드가 빈 항목(앞 PR 없음)에 새 브랜치 후속을 띄우면 단계 수가 그대로이고 줄에 `stages` 가 없다.
- merged-pr 이 있고 단계를 모두 끝낸 doing 항목에 새 브랜치 후속을 띄우면 지금처럼 마일스톤 전체가 붙고 follow 줄에 `stages` 가 없다.
- 보드 단계 설정이 `["[pr] 리뷰 요청", "[merge] 반영", "[deploy] 배포"]` 인 저장소에서는 더한 두 줄의 글이 `리뷰 요청 (wb)`, `반영 (wb)` 이다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-attach.spec.ts skills/orch/tests/board-path-callers.spec.ts skills/orch/tests/lib-board.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/board.ts` | 수정 (후속 묶음 단계 더하기) |
| `skills/orch/tests/board-attach.spec.ts` | 수정 |
