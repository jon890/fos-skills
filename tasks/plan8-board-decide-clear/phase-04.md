# Phase 04. 충돌 지시서는 PR 마다 하나이고 마무리가 지운다

**Execution profile**: deep

## 목표

상주 루프와 `notify-conflicts` 가 쓰는 충돌 후속 지시서가 PR 마다 한 파일이고 `중간 과정:` 줄을 담는다. 머지 뒤 마무리가 그 파일을 지운다.

**범위 외**: 띄울 때의 보드 처리(phase 03).

## 컨텍스트

- `orch/scripts/lib/conflicts.ts` 의 `resolveConflict` 가 끝난 dispatch 에 `join(pathOf('specs', repo), \`spec-conflict-${number}-${baseSha.slice(0, 8)}.md\`)` 를 `followUp` 으로 쓰고 `send-to-worker --spec` 으로 이어 쓴다. 이 경로가 `launch-worker` 를 거쳐 `registerBoard` 에 닿는다.
- 알림 기록 키는 `notifiedKey(pr, baseSha)` 의 `<PR>@<base SHA>` 다. 바꾸지 않는다. base 가 움직이면 다시 알리고 같은 파일을 덮어쓴다.
- `orch/scripts/finish-pr.ts` 는 머지 뒤 마지막 PR 이면 `deleteBranchSpecs` 로 `브랜치:` 줄이 그 브랜치인 지시서를 지운다. 목록이 비면 `liveSpecPaths` 를 부르지 않고 돌아간다. 지우기는 `orch/scripts/lib/spec.ts` 의 `deleteSpecs` 와 `liveSpecPaths` 다.
- `orch/tests/finish-pr.spec.ts` 의 중간 PR 테스트는 orca 호출이 없음을 확인한다.
- phase 03 이 `orch/scripts/lib/board.ts` 에 `INTERIM`(`중간 과정: `) 을 export 한다.

**근거 문서**: `docs/adr/015-board-decide-clear.md`, `docs/data-schema.md` 의 「orch 루트에 더하는 파일」

## 의도 메모

- 지시서를 base SHA 마다 남기지 않는다. 앞 지시서는 다음 base 에서 쓸모가 없다.
- 지울 충돌 지시서가 없으면 `liveSpecPaths` 를 부르지 않는다. 부르면 orca 를 읽어 느리고 기존 테스트가 깨진다.

## 작업 항목

### 1. `orch/scripts/lib/conflicts.ts`

- `conflictSpecPath(repo, pr)` 를 export 한다. `join(pathOf('specs', repo), \`spec-conflict-${pr}.md\`)` 다. `resolveConflict` 가 이 경로를 쓴다.
- `followUp` 이 `브랜치:` 줄 다음 줄에 `${INTERIM}PR #<PR>` 을 쓴다(`INTERIM` 은 `./board.ts` 에서 import).
- `conflictSpecFiles(repo, pr): string[]` 를 export 한다. 지시서 폴더의 파일 가운데 이름이 `spec-conflict-<PR>.md` 이거나 `/^spec-conflict-<PR>-[0-9a-f]{8}\.md$/` 인 것의 경로다. 폴더가 없으면 빈 목록이다. `spec-conflict-71.md` 는 PR 7 에 들지 않는다.
- 머리 주석에 지시서 이름 규칙을 적는다. `orch/scripts/notify-conflicts.ts` 머리 주석의 지시서 이름(`spec-conflict-<PR>-<base SHA 앞 8자리>.md`)도 `spec-conflict-<PR>.md` 로 고친다.

### 2. `orch/scripts/finish-pr.ts`

- 마지막 PR 판정 로그 뒤, 마지막과 중간 모두 `conflictSpecFiles(repo, pr)` 를 지운다. 목록이 비면 돌아간다. 아니면 `deleteSpecs({ root: dirname(realPath(pathOf('specs', repo))), specs, prBodies: [], live: liveSpecPaths(args.run), mode: 'delete', apply: true, log })` 다. `--specs-dir` 와 상관없다.
- 머리 주석의 단계 5 에 적는다.

### 3. 버전과 변경 이력

- `orch/CHANGELOG.md` 에 `## 4.4.0 (2026-10-27)` 을 더한다. 중간 과정 지시서, done 항목 다시 열기, 충돌 지시서 한 파일과 지우기, `board.ts mark` 와 창의 결정 필요 세기를 사용자 관점으로 적는다.
- `orch/SKILL.md` 의 `metadata.version` 을 `4.4.0` 으로 올린다.

### 4. 테스트

- `orch/tests/notify-conflicts.spec.ts`, `orch/tests/orch-loop-conflict.spec.ts`: 끝난 dispatch 의 지시서 이름이 `spec-conflict-7.md` 이고 `중간 과정: PR #7` 줄이 있다. 기존의 `spec-conflict-7-<sha>.md` 기대값을 고친다. `notify-conflicts.spec.ts` 에서 base 가 움직인 뒤 다시 돌려도 `spec-conflict-` 파일은 하나다.
- `orch/tests/finish-pr.spec.ts`: 중간 PR 판정에서 `spec-conflict-<PR>.md` 와 `spec-conflict-<PR>-0123abcd.md` 가 지워지고 `spec-conflict-<PR>1.md`(다른 PR) 는 남는다. 충돌 지시서가 없는 기존 중간 PR 테스트는 그대로 통과한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/notify-conflicts.spec.ts orch/tests/orch-loop-conflict.spec.ts orch/tests/finish-pr.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
```

기대값: 모두 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/conflicts.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/SKILL.md` | 수정 |
| `orch/tests/notify-conflicts.spec.ts` | 수정 |
| `orch/tests/orch-loop-conflict.spec.ts` | 수정 |
| `orch/tests/finish-pr.spec.ts` | 수정 |
