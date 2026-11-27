# ADR-039: 보드 항목은 기능 하나의 진행이고, 단계 PR 머지는 다음 단계 줄을 만든다

- **status**: `accepted`
- **decision-type**: `domain-policy`
- **현재 규칙의 원본**: [기능 단위 보드 항목 스펙](../features/board-feature-items/spec.md), [설계](../features/board-feature-items/design.md), 구현 뒤 [board.md](../../skills/orch/references/board.md) 의 「기능 항목」 절
- **결정**: 기능 폴더(`docs/features/<기능>/`)가 있는 일은 보드 항목 하나가 그 기능의 spec 부터 docs-consolidate 까지 따라간다. 항목은 `feature` 칸에 기능 폴더를 둔다. 단계 PR 이 머지되면 done 대신 다음 단계 줄을 `[ask]` 로 더하고, 마지막 단계가 머지될 때만 done 이 된다. 기능이 아닌 일(버그 수정, 정리)은 [ADR-018](018-board-milestone-steps.md) 의 마일스톤 규칙 그대로다. 사용자 결정 2026-11-27.
- **맥락**: [ADR-018](018-board-milestone-steps.md) 의 done 지점은 PR 하나의 머지다. 기능 루프는 단계마다 PR 을 내서, 설계 PR 머지로 항목이 done 이 된 뒤 구현 PR 이 이어진 일이 세 건 있었다(요청 R39, 2026-11-27). 구현 worker 두 개는 보드 항목 없이 떴다.
- **대안 기각**: 구현이 끝날 때까지 `board.done_after` 를 늦추는 설정은 기능이 아닌 일까지 늦춘다. 기능 폴더의 산출물로 단계를 추측하면 구현 PR 이 여럿일 때 마지막을 알 수 없다. 다음 단계 worker 를 자동으로 띄우면 스펙 확인 같은 사람 단계를 건너뛴다.
- **결과**:
  - 얻는 것: 기능의 남은 단계가 보드에 남고, 코디네이터가 기억해 이어 붙이던 일을 `STEP-READY` 알림이 맡는다.
  - 감당할 것: 기능 단계 지시서는 머리에 `기능 단계:` 줄을 적어야 한다. 옛 항목은 옮기지 않아 두 규칙이 한동안 함께 있다.
- **확인 방법**: `board-sync.spec.ts` 의 「설계 PR 머지 → 항목 doing, 구현 단계 줄」 경우
