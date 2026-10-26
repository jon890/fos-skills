# Phase 02. 자동 머지가 예약을 낮은 번호로 본다

**Execution profile**: deep

## 목표

상주 루프의 자동 머지가 PR 이 아직 없는 다른 브랜치의 마이그레이션 예약을 더 낮은 번호(기다릴 대상)와 같은 번호(겹침)로 판정하게 한다. 막힘 알림에 막는 쪽이 할 재예약 명령을 붙인다.

**범위 외**: 예약 명령과 파일(phase 01). 스킬 문서(phase 03).

## 컨텍스트

- 판정은 `orch/scripts/lib/auto-merge.ts` 의 `judgeMigrations(pr, mine, baseMax, others)` 와 타입 `MigrationJudgement`(`clashes`, `lower`) 다. `lower` 항목은 `{pr, module, label, mine}` 이다.
- 루프 쪽은 `orch/scripts/orch-loop.ts` 의 자동 머지 단계다. `migrationContext(ctx, bases)` 가 base 최고(`baseMax`)와 다른 열린 PR 의 마이그레이션(`others`)을 읽고, 「4. 마이그레이션 겹침」 블록이 `judgeMigrations` 를 부른다.
  막힘 판정은 `waitsFor(c, set)` 가 `lower` 가운데 걸 후보 집합에 없는 PR 을 고르고, `MIGRATION-BLOCKED` 의 text 는 `<모듈> <mine> 이 #<pr> <label> 을 <분>분 기다린다. #<pr> 의 번호를 뒤로 미는 재예약을 검토한다` 다.
- 예약은 phase 01 의 `lib/reservations.ts` 의 `readReservations(repo)`(잠금 없이 읽는다. 쓰는 쪽이 rename 한다)와 타입 `Reservation`(`module`, `version`, `label`, `branch`, `name`, `path`) 이다.
- `orch-loop.ts` 의 `addedMigrations` 는 phase 01 의 `lib/reservations.ts` 의 `addedPaths` 와 같은 규칙이다. 이 phase 에서 `addedPaths` 를 부르도록 바꿔 규칙을 한 벌로 둔다.

**근거 문서**: `docs/adr/017-orch-migration-reserve.md`, `docs/flow.md` 의 「상주 루프의 자동 머지」 표(「PR 이 아직 없는 다른 브랜치가 더 낮은 번호를 예약했다」 행).

## 의도 메모

- 예약은 PR 번호가 없다. `lower` 와 `clashes` 의 항목이 PR 대신 브랜치를 가리킬 수 있어야 한다. 기다릴 대상이 예약이면 걸 후보 집합에 들 일이 없으므로 늘 기다린다.
- 대상 PR 자기 브랜치의 예약은 빼고, 다른 브랜치라도 그 브랜치의 열린 PR 이 같은 (모듈, 번호)를 이미 더했으면 빼고 본다. 같은 번호를 두 번 세지 않으려는 것이다.
- 예약 파일을 읽지 못하면 마이그레이션 목록을 읽지 못한 것과 같게 다룬다(마이그레이션이 든 PR 은 그 틱에 걸지 않고 오류 이유를 남긴다).
- 형식이 틀린 예약이 하나라도 있으면(`skipped > 0`) 같게 다룬다. 이유 끝에 `reserve-migration.ts --prune 으로 뺀다` 를 붙인다.
- 열린 PR 조회가 200 줄 이상이면 목록이 잘렸을 수 있어 같게 다룬다.

## 작업 항목

### 1. `orch/scripts/lib/auto-merge.ts`

- `export type ReservedMigrations = { branch: string; migrations: Migration[] }` 를 더한다.
- `judgeMigrations` 에 다섯째 인자 `reserved: ReservedMigrations[] = []` 를 더한다. 기본값이 있어 기존 호출은 그대로다.
  - 이 PR 의 마이그레이션과 같은 (모듈, 번호)인 예약은 clash `<branch> 의 예약과 같은 번호` 다(base 최고 이하 clash 가 먼저인 규칙은 그대로).
  - 같은 모듈에 base 최고보다 크고 이 PR 보다 낮은 예약은 `lower` 에 `{pr: null, branch, module, label, mine}` 로 넣는다.
- `lower` 항목 타입을 `{ pr: number | null; branch: string | null; module: string; label: string; mine: string }` 로 바꾼다. 열린 PR 항목은 `branch: null` 이다.
- 머리 주석의 판정 설명을 고친다.

- 예약을 거르는 판정은 `export function reservedFor(branch, reserved, openByBranch): ReservedMigrations[]` 로 둔다. 자기 브랜치의 예약과, 예약한 브랜치의 열린 PR 이 같은 (모듈, 번호)를 더한 예약을 뺀다.

### 2. `orch/scripts/orch-loop.ts`

- `addedMigrations` 가 `lib/reservations.ts` 의 `addedPaths` 로 파일을 고르게 바꾼다.
- `migrationContext` 가 `readReservations(ctx.repo)` 도 읽어 base 마다 돌려준다. 실패하면 `ok: false` 와 이유 `마이그레이션 예약을 읽지 못했다: <이유>`.
  예약을 base 에 묶을 수 없으므로 모든 base 에 같은 예약을 쓴다.
- `migrationContext` 의 `gh pr list` 필드를 `number,headRefName,baseRefName,files`(이 순서) 로 바꾸고, 모든 base 의 열린 PR 에서 `headRefName` → (모듈, 번호) 집합 지도 `openByBranch` 를 만들어 함께 돌려준다. 예약은 모든 base 에 쓰므로 이 지도도 base 를 가리지 않는다.
- 「4. 마이그레이션 겹침」 블록에서 PR 마다 `reserved` 를 만든다. 그 PR 의 브랜치(`c.pr.branch`) 것을 빼고, `openByBranch.get(예약의 branch)` 에 같은 (모듈, 번호)가 있는 예약도 뺀다. 예약한 브랜치가 PR 을 열면 그 PR 의 파일로 이미 세기 때문이다.
- `waitsFor` 는 `pr` 이 null 인 항목을 늘 기다릴 대상으로 본다.
- `MIGRATION-BLOCKED` 의 text 를 바꾼다. 막는 쪽이 PR 이면 `#<pr> <label>`, 예약이면 `<branch> 의 예약 <label>` 로 쓰고, 끝을 `막는 쪽 worker 가 reserve-migration.ts --again 으로 번호를 다시 받는다. 막는 브랜치를 버렸으면 지운 뒤 reserve-migration.ts --prune` 으로 바꾼다. `AUTO-MERGE-WAIT` 로그 줄도 같은 이름 규칙을 쓴다.
- 머리 주석 「자동 머지」 에 예약을 읽는 것과 새 text 를 적는다.

### 3. 테스트

- `orch/tests/lib-auto-merge.spec.ts` 의 `judgeMigrations`: base 최고 V2, 다른 브랜치 예약 V3, 이 PR V4 면 `lower` 에 `{pr: null, branch: 'feat/x', label: 'V3'}`. 예약 V4 와 이 PR V4 면 clash `feat/x 의 예약과 같은 번호`. 기존 단언에 `branch: null` 을 더한다.
- `orch/tests/orch-loop-auto-merge.spec.ts` 의 `github()` 도우미가 쓰는 pr list 규칙의 args 를 `['pr', 'list', 'number,headRefName,baseRefName,files']` 로 바꾸고, 기존 테스트의 열린 PR 행에 `headRefName` 을 넣는다. 가짜 gh(`tests/fixtures/fake-bin.ts`)는 argv 원소가 정확히 같은지 보므로 바꾸지 않으면 기존 마이그레이션 테스트가 깨진다.
- 중복 제외: 예약 파일에 feat-1 의 api V3 을 두고, PR #1(headRefName feat-1)이 V3, PR #2 가 V4 를 더하고 둘 다 준비되면 `--chain 1,2` 로 둘 다 걸린다. 이 제외가 빠지면 예약이 늘 기다릴 대상이 되어 #2 가 영영 막힌다.
- `orch/tests/orch-loop-auto-merge.spec.ts`: 예약 파일(`.orch/state/migration-reservations.json`)에 다른 브랜치의 api V3 을 두고 준비된 PR 이 api V4 를 더하면 걸리지 않는다. `blocked_after_sec` 1 로 두고 2초 뒤 다시 돌리면 `MIGRATION-BLOCKED` text 가 `api V4 이 feat/x 의 예약 V3 을` 로 시작하고 `--again` 을 담는다.
  같은 PR 의 브랜치가 예약한 V4 는 막지 않는다(자기 예약). 예약 파일이 JSON 이 아니면 `WATCH-ERROR` 의 text 가 `auto-merge: 마이그레이션 예약을 읽지 못했다` 를 담는다.
  기존 MIGRATION-BLOCKED text 단언을 새 형식으로 고친다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-auto-merge.spec.ts orch/tests/orch-loop-auto-merge.spec.ts orch/tests/lib-reservations.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

기대값: 둘 다 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/auto-merge.ts` | 수정 |
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/tests/lib-auto-merge.spec.ts` | 수정 |
| `orch/tests/orch-loop-auto-merge.spec.ts` | 수정 |
