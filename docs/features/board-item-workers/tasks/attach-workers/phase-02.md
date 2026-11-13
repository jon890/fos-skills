# Phase 02. 지시서의 `보드 항목: 새로` 와 `worker 역할: 검증` 줄

**Execution profile**: standard

## 목표

지시서 머리의 두 줄을 읽는 함수를 두고, spec-lint 가 `보드 항목: 새로` 와 `보드 항목 id:` 를 함께 쓴 지시서를 막게 한다.

**범위 외**: 두 줄로 항목을 고르는 일(phase 03), 문서와 틀(phase 05).

## 컨텍스트

**요구사항**: REQ5, REQ8(spec-lint 머리 주석 몫)

**근거 문서**: `docs/features/board-item-workers/spec.md` REQ5·DECISION6·DECISION9, `docs/features/board-item-workers/design.md` 「역할 정하기」

- `skills/orch/scripts/lib/spec.ts`: `BOARD_ID`(133행)와 `boardIdOfLine`·`boardIdOf`(137-154행), 머리 절만 읽는 `interimOf`(170행)의 꼴(`text.split(/^##\s/m)[0]` 로 첫 `## ` 앞만 본다, 목록 기호 `- `·`* ` 를 받는다)을 따른다.
- `skills/orch/scripts/spec/spec-lint.ts`: 검사 이름별 머리 주석(76행 「보드」), 지시서마다 도는 고리(518-528행). 오류는 `errors.push(\`${spec.name}:<줄>: <검사>: <글>\`)` 꼴이고 종료 코드에 든다.
- 테스트: `skills/orch/tests/lib-spec.spec.ts`, `skills/orch/tests/spec-lint.spec.ts`.

## 의도 메모

- 두 줄은 머리 절(첫 `## ` 앞)에서만 읽는다. 본문의 예시 줄을 실행 의도로 읽지 않는다(`autoStepNumberOf` 와 같은 이유).
- 값이 다르면(`보드 항목: 새 항목`) 줄을 읽지 않는다. 낱말 하나로 정해 다시 띄워도 결과가 같다.

## 작업 항목

### 1. `skills/orch/scripts/lib/spec.ts`

- `boardNewOf(text: string): boolean`: 머리 절에 `^\s*(?:[-*]\s*)?보드 항목\s*:\s*새로\s*$` 줄이 있으면 참이다. `보드 항목 id:` 줄은 이 꼴에 맞지 않는다.
- `workerRoleOf(text: string): 'verify' | null`: 머리 절에 `^\s*(?:[-*]\s*)?worker 역할\s*:\s*검증\s*$` 줄이 있으면 `'verify'` 다. 다른 값은 `null` 이다.
- 두 함수 위에 한 줄 설명을 단다. 원본은 `skills/orch/references/spec-writing.md`(phase 05)다.

### 2. `skills/orch/scripts/spec/spec-lint.ts`

- 머리 주석 「보드」 항목에 「`보드 항목: 새로` 와 `보드 항목 id:` 가 함께 있다. 새로 만들지 그 항목에 붙일지가 갈려 오류다」 를 더한다.
- 지시서 고리에서 `boardNewOf(text)` 가 참이고 `boardIdOf(text)` 가 있으면 `errors.push(\`${spec.name}:<보드 항목 줄 번호>: 보드: \\\`보드 항목: 새로\\\` 와 \\\`보드 항목 id:\\\` 를 함께 쓰지 않는다. 하나만 남긴다\`)` 를 넣는다. 줄 번호는 `보드 항목: 새로` 줄이다.

### 3. 테스트

- `skills/orch/tests/lib-spec.spec.ts`: `boardNewOf` 가 `보드 항목: 새로`, `- 보드 항목: 새로` 를 참으로, `## 할 일` 아래의 같은 줄과 `보드 항목: 새 항목`, `보드 항목 id: x` 를 거짓으로 본다. `workerRoleOf` 가 `worker 역할: 검증` 을 `'verify'`, `worker 역할: 리뷰` 와 본문 줄을 `null` 로 본다.
- `skills/orch/tests/spec-lint.spec.ts`: 두 줄을 함께 쓴 지시서는 종료 코드 1 과 `보드:` 오류 줄, `보드 항목: 새로` 만 쓴 지시서는 이 오류가 없다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-spec.spec.ts skills/orch/tests/spec-lint.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/spec.ts` | 수정 (boardNewOf, workerRoleOf) |
| `skills/orch/scripts/spec/spec-lint.ts` | 수정 (함께 쓴 두 줄 오류) |
| `skills/orch/tests/lib-spec.spec.ts` | 수정 |
| `skills/orch/tests/spec-lint.spec.ts` | 수정 |
