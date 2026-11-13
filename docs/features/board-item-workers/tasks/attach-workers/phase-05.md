# Phase 05. 멈춘 단계 알림과 문서, 지시서 틀

**Execution profile**: standard

## 목표

작업 중 worker 줄(역할 무관)이 살아 있으면 멈춘 단계 알림을 내지 않는다. worker 줄 목록, 자동 붙이기, `보드 항목: 새로`, `worker 역할: 검증` 을 문서와 지시서 틀에 적는다.

**범위 외**: 창의 「worker 없음」 감추기와 worker 줄 그리기(PR2 계획 `multi-pr-window`), 동시 PR 단계 문서(PR2).

## 컨텍스트

**요구사항**: REQ7(멈춤 알림 몫), REQ8(PR1 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ7·REQ8·DECISION6·DECISION9·DECISION15·DECISION23, `docs/features/board-item-workers/design.md` 「worker 줄」·「대표 칸을 읽는 곳」, `docs/adr/033-board-item-worker-rows.md`

- `skills/orch/scripts/core/movement.ts` 의 `stalledStages`(120-147행). 대표 칸의 worker 가 살아 있으면 141행 `liveWorkerOn({ worktree, branch }, live, branches)` 로 건너뛴다. 자동 진행 줄은 139-140행의 `itemBusy` 로 본다. 입력 `items` 는 `board.json` 의 항목 그대로라 `workers` 필드가 들어 있다.
- phase 04 의 `skills/orch/scripts/core/board-workers.ts` 의 `boardWorkerRows`.
- 문서 자리: `docs/data-schema.md`(저장 모델. 「orch 루트에 더하는 파일」 절 앞에 새 절을 둔다), `skills/orch/references/board.md`(「상태와 단계 고치기」 절 뒤에 새 절), `skills/orch/references/spec-writing.md`(124-136행 「리뷰 worker 지시서」 절과 `보드 항목 id:` 를 설명한 줄), `skills/orch/templates/spec-review.md`(머리 주석과 `리뷰 PR:` 줄 근처).
- 변경 이력 조각 규칙은 `README.md` 「버전과 변경 이력」 이다.

## 의도 메모

- 자동 진행의 바쁨 판정(`itemBusy`)은 바꾸지 않는다. 리뷰·검증 줄은 대표가 되지 않아 자동 진행을 붙잡지 않는다(스펙 DECISION15).
- 문서에는 PR1 이 실제로 하는 동작만 적는다. 창의 worker 줄 그리기와 동시 PR 단계는 PR2 가 적는다.

## 작업 항목

### 1. `skills/orch/scripts/core/movement.ts`

- `stalledStages` 의 항목 고리에서 단계를 정한 뒤, 자동 진행 줄 판정과 대표 칸 판정 앞에 `boardWorkerRows(item).some((row) => row.status === 'working' && liveWorkerOn({ worktree: row.worktree, branch: row.branch }, live, branches))` 가 참이면 건너뛴다.
- 파일 맨 위 설명(`lib/movement.ts` 23행의 「멈춘 단계」 설명)에 「역할과 상관없이 작업 중 worker 줄이 살아 있으면 알리지 않는다」 를 더한다.

### 2. `skills/orch/tests/lib-movement.spec.ts`

- 대표 칸의 워크트리가 사라졌고 `review` 줄(`working`, 살아 있는 워크트리)만 있는 doing 항목은 멈춘 단계로 나오지 않는다. 첫 미완료 단계가 `[auto]` 이고 자동 진행이 켜진 항목(`options.autoAdvance`, 띄운 기록 있음)도 같다. 같은 줄이 `done` 이면 지금처럼 나온다. 줄 없는 옛 항목은 지금 결과 그대로다.

### 3. 문서

- `docs/data-schema.md`: 새 절 `## 보드 항목의 worker 줄`. 칸 표(`role`, `dispatch`, `worktree`, `branch`, `pr`, `status`, `at`, `endedAt`. `stages` 는 PR2 가 더한다), 열쇠(`worktree`·`branch`), 대표 칸 규칙(가장 최근의 작업 중 구현·후속 줄, 없으면 그대로, 리뷰·검증은 대표가 되지 않음), 쓰는 곳(`board.ts worker-add`·`worker-end`, 띄우기, 보드 맞추기의 `--worker-ends`), 옛 항목(필드 없음)은 대표 칸으로 읽는다. 근거는 ADR-033 링크.
- `skills/orch/references/board.md`: 새 절 `## 한 항목의 worker 들`. 띄울 때 리뷰·검증은 리뷰 PR 의 항목(done 포함)에, 후속은 같은 업무 번호·브랜치의 열린 항목에 줄로 붙고 `BOARD-ATTACH <항목> <역할>` 이 나온다. 리뷰·검증 줄은 상태·단계·대표 칸을 바꾸지 않고 항목 닫기와 자동 진행을 붙잡지 않는다. 줄은 worker_done, 끝난 dispatch, 사라진 워크트리로 끝난다. 따로 만들려면 지시서에 `보드 항목: 새로` 를 쓴다. 지금 창은 대표 worker 하나만 항목 아래 보이고 붙은 리뷰·검증 worker 는 「안 붙은 worker」 칸에 보인다는 것도 적는다(PR2 가 고친다).
- `skills/orch/references/spec-writing.md`: 머리 줄 설명에 `보드 항목: 새로`(자동 붙이기를 끈다, `보드 항목 id:` 와 함께 쓰면 spec-lint 오류)와 `worker 역할: 검증`(인수 검증 worker, 틀 `templates/spec-verify.md`)을 더한다. 「리뷰 worker 지시서」 절에 「`리뷰 PR: #N` 이 있으면 PR N 의 항목에 리뷰 줄로 붙는다. `보드 항목 id:` 를 적지 않아도 된다」 를 더한다.
- `skills/orch/templates/spec-review.md`: 머리 주석에 「`리뷰 PR:` 줄로 대상 PR 의 보드 항목에 리뷰 worker 로 붙는다. `보드 항목 id:` 는 적지 않는다」 를 더한다.
- `skills/orch/templates/spec-verify.md`(신규): 인수 검증 worker 지시서 틀. 머리에 공통 지시서 줄, `worker 역할: 검증`, `리뷰 PR: #{{N}}`(PR 을 연 뒤 검증할 때), `보드 항목 id: {{항목}}`(PR 을 열기 전에 검증할 때. 두 줄 가운데 하나를 남긴다는 주석), `브랜치: verify/{{이름}}`(검증 전용 브랜치. 구현 브랜치는 `make-worktree` 가 거부하고, 구현 워크트리에 띄우면 구현 줄을 덮는다는 주석), `허락:`, `worker 선택:`(행 `review`)을 둔다. 할 일은 verify 스킬로 스펙·설계·계획의 인수 검증 계획을 실행하고 코드를 고치지 않는 것이다. worker_done 첫 줄은 `완료:` 또는 `미완료:` 로 시작한다(`skills/orch/references/spec-writing.md` 의 완료 줄 규칙).
- `skills/orch/SKILL.md` 의 리뷰 worker 행(68행) 아래에 인수 검증 worker 행을 더해 `templates/spec-verify.md` 를 가리킨다.

### 4. 변경 이력 조각

- `skills/orch/changes/board-item-workers.minor.md`(신규): `- ` 줄로 「띄울 때 리뷰·검증·후속 worker 를 기존 보드 항목에 worker 줄로 붙이고 BOARD-ATTACH 를 낸다」, 「지시서의 보드 항목: 새로, worker 역할: 검증 줄과 검증 지시서 틀을 더한다」, 「상주 루프가 끝난 worker 줄을 끝내고, 구현 줄이 있는 항목은 리뷰가 끝나도 닫지 않는다」.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-movement.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/config-docs.spec.ts scripts/tests/check-skill-docs.spec.ts
node scripts/run-tests.ts --tsc-only
node export-only-skills/korean-check/scripts/check.ts docs/data-schema.md skills/orch/references/board.md skills/orch/references/spec-writing.md skills/orch/templates/spec-review.md skills/orch/templates/spec-verify.md
```

기대값: 모두 통과. 마지막 명령은 「표기 검사 통과」 다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/core/movement.ts` | 수정 (작업 중 줄이 있으면 알리지 않음) |
| `skills/orch/scripts/lib/movement.ts` | 수정 (머리 주석) |
| `skills/orch/tests/lib-movement.spec.ts` | 수정 |
| `docs/data-schema.md` | 수정 (보드 항목의 worker 줄 절) |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/templates/spec-review.md` | 수정 |
| `skills/orch/templates/spec-verify.md` | 신규 |
| `skills/orch/SKILL.md` | 수정 (검증 worker 행) |
| `skills/orch/changes/board-item-workers.minor.md` | 신규 |
