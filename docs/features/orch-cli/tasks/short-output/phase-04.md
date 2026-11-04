# Phase 04. queue 와 cleanup 묶음의 짧은 출력

**Execution profile**: standard

## 목표

`orch queue …` 과 `orch cleanup …` 의 짧은 출력이 설계 「짧은 출력 (PR2)」 표의 판정 줄만 내고, 실패 이유를 판정 줄에 남기게 한다.

**범위 외**: 상주 루프가 읽는 머지 큐 로그(경로 호출이라 지금 출력 그대로), board·spec·doctor·status(phase 05), 문서(phase 06).

## 컨텍스트

**요구사항**: REQ4

**근거 문서**: `docs/features/orch-cli/spec.md` 의 「출력」, REQ4, DECISION16. `docs/features/orch-cli/design.md` 의 「짧은 출력 (PR2)」 표의 `queue …`, `cleanup …` 행, 결정 DECISION19, DECISION21.

- `merge_queue.ts` 의 `log(message)` 는 `out(`${now()} ${message}`)` 다. PR 결과는 `log(`${n} MERGED`)`, `log(`${n} 이미 MERGED`)` 이고, `STOP`, `CONFLICT`, `SKIP`, `QUEUE-*`, `HOOK-FAIL`, `AFTER-MERGED-FAILED` 는 `out` 이다. `sweep()` 이 `cleanup-sweep.ts` 를 `runInherit` 로 부른다.
- `merge-with-finish.ts` 는 `runInherit` 로 `merge_queue.ts` 를 부르고(410줄 근처), 마무리(`finish-pr.ts`)는 로그 파일로 띄운다. 상주 루프(`orch-loop.ts`)는 `merge-with-finish.ts` 를 경로로 불러 로그 끝 줄(`QUEUE-DONE`, `QUEUE-HELD`, `STOP`)을 읽는다. 경로 호출이라 신호가 없어 그대로다.
- `finish-pr.ts` 의 `fail(reason?)` 은 이유를 `log` 하고 `FINISH-FAIL` 을 낸다. 마지막 PR 판정은 `log(`마지막 PR 판정: <마지막|중간>(…)`)`.
- `notify-conflicts.ts` 는 `out` 을 `lib/conflicts.ts` 의 `resolveConflict` 에 넘긴다. 그 함수의 줄은 `CONFLICT-ORPHAN …`, `  <dispatch> 에 알릴 것: …`, `  <dispatch> 에 이어 쓸 것: …`, `  <dispatch> 에 보내지 못했다(…)`, `  <dispatch> 에 알렸다…` 다.
- `cleanup-sweep.ts` 의 `log` 는 `main` 의 지역 함수(1913줄 근처)이고 `sweepRepo` 와 그 아래 함수가 받아 쓴다. `lib/spec.ts` 의 `deleteSpecs` 는 `log` 를 받아 `<지시서|PR 본문> 남긴다 …`, `… 지울 것 …`, `… 삭제 …`, `… 휴지통으로 옮길 것 …`, `… 옮김 … -> …` 를 낸다.
- `remove-worktree.ts`, `handoff-cleanup.ts` 는 `out` 이다.

## 작업 항목

### 1. `skills/orch/scripts/merge_queue.ts`

- `out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^\d\d:\d\d (\d+) (?:이미 )?MERGED$` → `MERGED $1`, `^경고: (.*)` → `WARN $1`, 그 밖의 시각 붙은 줄(`^\d\d:\d\d `)은 버린다.
- 머지 실패(1014-1024줄 근처)의 이유는 `gh pr merge` 의 마지막 줄(`if (last) out(last)`)뿐이다. 짧은 출력이면 그 줄을 따로 내지 않고 뒤의 `STOP <n> 머지 실패` 를 `STOP <n> 머지 실패: <그 줄>` 로 낸다(설계 DECISION21).
- `sweep()` 의 `runInherit` 에 `env: shortEnv()` 를 준다.

### 2. `skills/orch/scripts/merge-with-finish.ts`

- `out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^마무리 시작: PR (\d+) \(.*\) -> (.*)` → `FINISH-STARTED $1 $2`, `^마무리는 이미 돌고 있다: PR (\d+) \((.*)\)` → `FINISH-RUNNING $1 $2`.
- `merge_queue` 를 부르는 `runInherit`(410줄 근처)에 `env: shortEnv()` 를 준다.

### 3. `skills/orch/scripts/finish-pr.ts`

- `out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^\d\d:\d\d 마지막 PR 판정: (마지막|중간)` → `LAST-PR $1`, 그 밖의 시각 붙은 줄은 버린다.
- `fail(reason)` 은 짧은 출력이면 `FINISH-FAIL <이유>` 다. 이유는 인자, 없으면 마지막으로 `log` 한 줄(시각 뺀 것)이다. `log` 가 마지막 줄을 기억한다.

### 4. `skills/orch/scripts/ci-ready.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^(\d+) 보류: (.*)` → `HELD $1 $2`, `^(\d+) 이미 ready$` → `READY $1 already`, `^(\d+) ready 로 바꿀 것$` → `WOULD-READY $1`, `^(\d+) ready 로 바꿈` → `READY $1`.

### 5. `skills/orch/scripts/notify-conflicts.ts` 와 `skills/orch/scripts/lib/conflicts.ts`

- `notify-conflicts.ts`: 짧은 출력이면 PR 마다 `#<PR> CONFLICTING …` 줄을 내지 않고 결과가 정해진 뒤 `CONFLICT <PR> <브랜치> <결과>` 한 줄을 낸다. 워크트리나 dispatch 가 없는 PR(orphan)은 `resolveConflict` 가 내는 `CONFLICT-ORPHAN <PR> <이유>` 한 줄만 내고 `CONFLICT` 줄을 내지 않는다. 결과는 이미 알렸으면 `already`, worker 목록을 읽지 못했으면 `workers-unread`, 그 밖은 `resolveConflict` 에 넘긴 `out` 이 받은 들여 쓴 줄로 정한다(`알릴 것` → `would-notify`, `이어 쓸 것` → `would-relaunch`, `보내지 못했다` → `send-failed`, `알렸다` → `notified`). `CONFLICT-ORPHAN` 줄은 그대로 낸다. `충돌한 열린 PR 이 없다(base <b> <sha>)` → `NO-CONFLICT <b> <sha>`.
- `lib/conflicts.ts` 는 바꾸지 않는다(상주 루프가 같은 함수를 쓴다). 결과 판정은 `notify-conflicts.ts` 가 넘긴 `out` 감싸개에서 한다.

### 6. `skills/orch/scripts/overlap_units.ts`

짧은 출력이면 `바로 머지` → `MERGE-NOW`, `갱신 필요(<이유>)` → `UPDATE-NEEDED <이유>`. `lib/overlap.ts` 의 `verdictText` 는 바꾸지 않는다(`merge_queue` 가 쓴다).

### 7. `skills/orch/scripts/cleanup-sweep.ts`

- 짧은 출력이면 `main` 의 `log` 가 줄을 `sweepRule(line)` 로 바꿔 내고 셈을 더한다. 끝에 `SWEEP <지운 수> <남긴 수>`(dry-run 은 `SWEEP-DRY <지울 수> <남길 수>`)를 낸다.
- `sweepRule` 규칙(앞의 들여쓰기는 무시한다. 차례대로 처음 맞는 것을 쓴다):
  - 실패(맨 앞): `(.*) 실패 ([^\s:]+)(?:: (.*))?` → `FAILED $2 $3`(이유가 없으면 `FAILED $2`). 지움 규칙보다 먼저 봐야 `원격 브랜치 삭제 실패 X: e` 가 `REMOVED` 로 읽히지 않는다.
  - 지움: `터미널 닫음 (\S+)`, `닫음 (\S+)`, `빈 셸을 닫았다: (\S+)` → `REMOVED terminal:$1`. `dispatch release (\S+)` → `REMOVED dispatch:$1`. `리뷰 워크트리 삭제 (\S+)`, `detached 워크트리 삭제 (\S+)` → `REMOVED $1`. `브랜치 삭제 (\S+)`, `원격 브랜치 삭제 (\S+)`, `리뷰 브랜치 삭제 (\S+)` → `REMOVED branch:$1`. `기준 브랜치 fast-forward (\S+)` → `REMOVED ff:$1`. `(지시서|PR 본문) (삭제|옮김) (\S+)` → `REMOVED $3`(`lib/spec.ts` 의 `KIND[kind].subject` 가 `지시서`, `PR 본문` 이다). `removed (\S+)`(remove-worktree 출력) → `REMOVED $1`. `deleted branch (\S+)` → `REMOVED branch:$1`.
  - 지울 것(dry-run): `… 지울 것 (\S+)`, `닫을 것:? (\S+)`, `… 을 닫을 것 (\S+)`, `release 할 것 (\S+)`, `fast-forward 할 것 (\S+)`, `휴지통으로 옮길 것 (\S+)` → `WOULD-REMOVE <대상>`(대상 앞에 위와 같은 종류 접두).
  - 남김: `건너뜀 (?:리뷰 워크트리|브랜치) (\S+)(?: \(#\d+\))?: (.*)`, `원격 브랜치 남김 (\S+): (.*)`, `리뷰 (?:흔적|브랜치) 남김 (\S+): (.*)`, `(지시서를|PR 본문을) 남긴다 (\S+): (.*)`(`lib/spec.ts` 333, 361줄 근처의 `KIND[kind].object`), `지시서 남김: (.*)`(1458줄 근처) → `KEPT specs $1`, `브랜치 남김 (\S+): (.*)` → `KEPT <대상> <이유>`. `건너뜀: (.*)\. 다음 실행에서` → 바로 앞 `정리 <경로>` 의 경로로 `KEPT <경로> $1`. `남김: (.*) \((\S+)\)`(remove-worktree) → `KEPT $2 $1`. `원격 브랜치 정리 건너뜀: (.*)` → `KEPT remote $1`. `기준 브랜치를 맞추지 않는다: (.*)` → `KEPT ff $1`.
  - 그대로: `FINISH-MISSING …` 과 판정 줄.
  - 나머지(머리 줄 `cleanup-sweep …`, `정리 <경로> (…)` 는 경로만 기억, 진행 줄)는 버린다.
- `정리 <경로>` 뒤 `removed`/`남김`/`건너뜀` 이 오지 않은 워크트리는 셈하지 않는다.

### 7-1. `skills/orch/scripts/lib/docker.ts`

Docker 정리 줄(`Docker <네트워크|컨테이너|이미지> 남김|삭제|지울 것 …`, `Docker 정리 건너뜀: …`)을 판정 줄로 바꾸는 `dockerShortLine(line)` 을 export 한다. `cleanup-sweep` 과 `remove-worktree` 가 같이 쓴다. 남김 줄의 이유에 든 「삭제 실패」 는 남김(`KEPT docker:<이름>`)으로 본다.

### 8. `skills/orch/scripts/remove-worktree.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^removed (\S+)` → `REMOVED $1`, `^deleted branch (\S+)` → `REMOVED branch:$1`, `^(?:브랜치 )?남김:? (.*) \((\S+)\)$` → `KEPT $2 $1`, `^브랜치 남김 (\S+): (.*)` → `KEPT branch:$1 $2`, `^없음: (\S+)` → `ABSENT $1`, `^git worktree 가 아니다: (\S+)` → `NOT-WORKTREE $1`, `^거부: (.*)` → `REFUSED $1`, `^유휴 셸 터미널 닫음 (\S+)` → `CLOSED $1`, `^유휴 셸 터미널 닫기 실패 (\S+)` → `FAILED terminal:$1`, `^Docker 정리 건너뜀: (.*)` → `KEPT docker $1`. 여러 줄 거부(`closed.refused`, `refused`)는 첫 줄을 `REFUSED` 로.

### 9. `skills/orch/scripts/handoff-cleanup.ts`

`out` 이 `emit(line, RULES)` 를 부른다. 규칙: `^후보 (.*)` → `WOULD-TRASH $1`, `^옮김 (.*)` → `TRASHED $1`, `^휴지통 폴더: (.*)` → `TRASH-DIR $1`, 지시서 줄은 위 7 의 지시서 규칙과 같다(규칙표를 `lib/output.ts` 에 두지 않고 `cleanup-sweep.ts` 에서 export 하지 않는다. 같은 정규식을 이 파일에 둔다. 두 곳뿐이다).

### 10. 테스트

- `skills/orch/tests/merge-queue.spec.ts`: 가짜 gh 로 PR 하나를 머지한 큐를 `ORCH_OUTPUT=short` 로 돌리면 `MERGED <PR>` 와 `QUEUE-DONE` 이고 시각 붙은 줄이 없다. 신호가 없으면 지금처럼 `HH:MM <PR> MERGED`.
- `skills/orch/tests/merge-with-finish.spec.ts`: 짧은 출력이 `FINISH-STARTED <PR> <로그>` 다. 가짜 머지 큐(`MERGE_QUEUE`)가 받은 `ORCH_OUTPUT` 을 찍게 해 짧은 출력이면 `short`, 아니면 빈 값인지 본다. 마무리 로그(`finish-<PR>.out`)를 쓰는 자식에는 신호가 없다.
- `skills/orch/tests/merge-queue.spec.ts`(정리 신호): 가짜 정리(`CLEANUP_SWEEP`)가 받은 `ORCH_OUTPUT` 을 찍게 해 짧은 출력의 큐에서만 `short` 다.
- `skills/orch/tests/finish-pr.spec.ts`: 머지 없이 닫힌 PR 이 짧은 출력에서 `FINISH-FAIL PR <N> 가 머지 없이 닫혔다` 다. 끝까지 간 사례가 `LAST-PR …` 와 `FINISH-DONE`.
- `skills/orch/tests/ci-ready.spec.ts`: `HELD`, `READY … already`, `WOULD-READY`.
- `skills/orch/tests/notify-conflicts.spec.ts`: 충돌 PR 이 `CONFLICT <PR> <브랜치> <결과>`, 없으면 `NO-CONFLICT`.
- `skills/orch/tests/overlap-units.spec.ts`: `MERGE-NOW`, `UPDATE-NEEDED`.
- `skills/orch/tests/cleanup-sweep-merge.spec.ts`: 머지된 워크트리를 지운 짧은 출력이 `REMOVED <경로>`, `REMOVED branch:<브랜치>` 와 끝 줄 `SWEEP <n> <m>` 이다. dry-run 은 `WOULD-REMOVE` 와 `SWEEP-DRY`. `sweepRule` 을 export 해 `원격 브랜치 삭제 실패 b: e` 가 `FAILED b e`, `지시서를 남긴다 s.md: 살아 있다` 가 `KEPT s.md 살아 있다` 인지 직접 본다.
- `skills/orch/tests/remove-worktree.spec.ts`: `REMOVED`, `ABSENT`.
- `skills/orch/tests/handoff-cleanup.spec.ts`: `WOULD-TRASH`, `TRASHED`.

## 검증

```bash
node --test skills/orch/tests/merge-queue.spec.ts skills/orch/tests/merge-with-finish.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/ci-ready.spec.ts skills/orch/tests/notify-conflicts.spec.ts skills/orch/tests/overlap-units.spec.ts skills/orch/tests/cleanup-sweep-merge.spec.ts skills/orch/tests/remove-worktree.spec.ts skills/orch/tests/handoff-cleanup.spec.ts skills/orch/tests/orch-loop-auto-merge.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/merge_queue.ts` | 수정 |
| `skills/orch/scripts/merge-with-finish.ts` | 수정 |
| `skills/orch/scripts/finish-pr.ts` | 수정 |
| `skills/orch/scripts/ci-ready.ts` | 수정 |
| `skills/orch/scripts/notify-conflicts.ts` | 수정 |
| `skills/orch/scripts/overlap_units.ts` | 수정 |
| `skills/orch/scripts/cleanup-sweep.ts` | 수정 |
| `skills/orch/scripts/remove-worktree.ts` | 수정 |
| `skills/orch/scripts/handoff-cleanup.ts` | 수정 |
| `skills/orch/scripts/lib/docker.ts` | 수정 |
| `skills/orch/tests/merge-queue.spec.ts` | 수정 |
| `skills/orch/tests/merge-with-finish.spec.ts` | 수정 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/ci-ready.spec.ts` | 수정 |
| `skills/orch/tests/notify-conflicts.spec.ts` | 수정 |
| `skills/orch/tests/overlap-units.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-merge.spec.ts` | 수정 |
| `skills/orch/tests/remove-worktree.spec.ts` | 수정 |
| `skills/orch/tests/handoff-cleanup.spec.ts` | 수정 |
