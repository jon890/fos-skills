# Phase 05. 창과 동시 PR 단계의 문서

**Execution profile**: standard

## 목표

창의 worker 줄 그리기와 동시에 열린 PR 의 단계 규칙을 참조 문서와 데이터 스키마에 적는다. PR1 이 「지금 창은 대표 worker 하나만 보인다」 로 적은 줄을 고친다.

**범위 외**: 코드 변경. 앞 phase 들이 끝냈다.

## 컨텍스트

**요구사항**: REQ8(PR2 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ4·REQ6·REQ8, `docs/features/board-item-workers/design.md` 「PR 여럿이 열린 항목」·「창」, `docs/adr/033-board-item-worker-rows.md`

- `extensions/work-board/references/behavior.md`: 항목 칸 목록(59행)과 워커 설명(61행). PR1 뒤에도 「항목의 worktree 와 같은 이름의 워커 상태를 붙인다」 로 적혀 있다.
- `skills/orch/references/board.md`: PR1 이 만든 「한 항목의 worker 들」 절과 「마일스톤 단계」 절(80행 근처).
- `docs/data-schema.md`: PR1 이 만든 「보드 항목의 worker 줄」 절. `stages` 필드가 빠져 있다.
- 변경 이력 조각 규칙은 `README.md` 「버전과 변경 이력」 이다.

## 의도 메모

- 규칙의 원본은 코드 머리 주석(`core/milestones.ts` 의 「PR 묶음」, `register.js` 의 그리기 주석)이다. 참조 문서는 사람이 읽을 요약과 그 원본 링크만 둔다.

## 작업 항목

### 1. 문서

- `extensions/work-board/references/behavior.md`: 항목 칸 목록에 worker 줄 목록(`workers`)을 더하고, 워커 설명을 「항목 아래에 작업 중 worker 를 역할·워크트리·PR·CI·상태로 한 줄씩, 끝난 worker 는 「✓ 끝난 worker N」, 끊긴 worker 는 빨간 줄로 그린다. 펼친 보기(d)는 모두 그린다. done 항목은 작업 중 줄만 그린다. 작업 중 줄이 있으면 「worker 없음」 을 그리지 않는다. 줄이 없는 옛 항목은 worktree 칸의 worker 하나를 붙인다」 로 바꾼다.
- `skills/orch/references/board.md`: 「한 항목의 worker 들」 절의 창 설명을 위와 맞춘다. 「마일스톤 단계」 절에 「앞 PR 이 열린 항목에 새 브랜치 후속 worker 를 붙이면 PR·머지 두 단계(`(<워크트리>)` 가 붙은 글)가 더해지고, 각 PR 의 머지가 자기 단계만 끝낸다. 열린 PR 이 남은 동안은 마지막 PR 이 아니고, 배포 단계는 마지막으로 머지된 PR 의 배포로 끝난다」 를 더한다.
- `docs/data-schema.md`: 「보드 항목의 worker 줄」 절의 칸 표에 `stages`(`pr=N,merge=M`, 앞 PR 이 열린 채 새 브랜치로 붙은 후속 줄만)를 더한다.

### 2. 변경 이력 조각

- `extensions/work-board/changes/board-item-worker-rows.minor.md`(신규): 「창이 보드 항목 아래에 작업 중·끝남·끊김 worker 줄을 그린다」, 「worker-add --stages, worker-set 을 더한다」.
- `skills/orch/changes/board-item-multi-pr.minor.md`(신규): 「앞 PR 이 열린 항목에 새 브랜치 후속 worker 가 PR·머지 두 단계를 더하고, 각 PR 의 머지가 자기 단계만 끝낸다」.

## 검증

```bash
node scripts/run-tests.ts scripts/tests/check-skill-docs.spec.ts
node export-only-skills/korean-check/scripts/check.ts extensions/work-board/references/behavior.md skills/orch/references/board.md docs/data-schema.md
```

기대값: 테스트 통과, 표기 검사 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/references/behavior.md` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `extensions/work-board/changes/board-item-worker-rows.minor.md` | 신규 |
| `skills/orch/changes/board-item-multi-pr.minor.md` | 신규 |
