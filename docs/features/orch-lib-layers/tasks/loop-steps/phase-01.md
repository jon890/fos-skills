# Phase 01. Run 이 둘인 틱의 순서를 옮기기 전 코드로 기록한다

**Execution profile**: standard

## 목표

코드를 옮기기 전에, Run 이 둘 등록된 틱이 내는 로그 줄의 순서, 결과 줄 `errors` 의 키 순서, 바깥 명령을 부르는 순서를 지금 코드로 기록한다. phase 02 가 틱 본문을 단계 함수로 나눈 뒤에도 이 순서가 같은지 보려는 것이다.

**범위 외**: `skills/orch/scripts/` 의 코드, `skills/orch/tests/golden` 의 기록.

## 컨텍스트

**요구사항**: REQ13

**근거 문서**: `docs/features/orch-lib-layers/spec.md` 의 REQ13, `docs/features/orch-lib-layers/design.md` 의 「동작 같음 확인」

- 고정 입력 기록의 루프 사례는 모두 `--run r` 하나다(`skills/orch/tests/fixtures/golden-run.ts` 의 `cases`). 기존 루프 테스트는 Run 이 여럿일 때 알림을 정렬해서 비교하거나 `errors` 를 키로 꺼내 본다. Run 이 둘일 때의 순서는 아무 테스트도 보지 않는다.
- 틱 본문은 Run 마다 번갈아 도는 곳이 여럿이다. 질문 확인, 결정 알림, 정리, tick 이벤트, 미답변 질문 확인이 Run 마다 돌고, 마지막에는 Run 마다 DIGEST, 완료 보고, 끊긴 worker 확인이 차례로 돈다. 단계 함수로 나누다 이 순서가 바뀌면 지금 테스트로는 알 수 없다.
- 실행기 `golden-run.ts` 는 입력(`input.json`)을 임시 폴더에 펼치고 가짜 실행 파일(`modules/testkit/fake-bin.ts`)과 고정 시계(`fixtures/fixed-clock.ts`)로 스크립트를 돌린 뒤 stdout, stderr, 종료 코드, `.orch` 아래 상태 파일을 `result.json` 과 비교한다. 가짜 실행 파일은 받은 인자를 `<bin>/<명령>.calls.jsonl` 에 호출 순서대로 적는다.
- Run 등록은 `repo/.orch/state/loop-runs/<Run>.json` 이고 `lib/loop.ts` 의 `registeredRuns` 가 `registered_at` 순으로 읽는다. 앞이 주 Run 이다.

## 의도 메모

- 기록은 `tests/golden` 밖(`skills/orch/tests/loop-order/`)에 둔다. `tests/golden` 에 사례를 더하면 이 PR 의 `git diff --exit-code origin/main HEAD -- skills/orch/tests/golden` 이 깨진다.
- 실행기는 새로 쓰지 않고 `golden-run.ts` 의 `runGolden` 에 기록 묶음(폴더, 사례, 호출을 적을 명령)을 받는 인자를 더한다. 기본값은 지금의 `tests/golden` 과 `cases` 라 기존 기록의 꼴과 비교는 바뀌지 않는다.
- 이 커밋은 옮기기 전 코드에서 통과해야 한다. 기록을 옮긴 뒤의 코드로 만들면 아무것도 증명하지 못한다.

## 작업 항목

### 1. `skills/orch/tests/fixtures/golden-run.ts` 에 기록 묶음 인자

`Input` 타입을 내보내고, `runGolden(record, selected, set)` 의 셋째 인자로 `{ dir: string; cases: () => Record<string, Input>; calls?: string[] }` 를 받는다. 기본값은 `{ dir: golden, cases }` 다. `calls` 를 주면 그 명령들의 `<bin>/<명령>.calls.jsonl` 에서 argv 목록을 읽어 결과에 `calls` 로 담는다(임시 경로는 다른 값과 같이 `<TMP>` 로 바꾼다). `calls` 를 주지 않으면 결과에 그 값이 없다. 기존 `skills/orch/tests/golden.spec.ts` 는 인자 없이 부르므로 고치지 않는다.

### 2. `skills/orch/tests/fixtures/loop-order-run.ts` 와 기록

Run `r1`(주 Run), `r2` 가 등록된 틱 사례 둘을 둔다. 스크립트는 `loop/orch-loop.ts`, 인자는 `--repo <TMP>/repo --run r1 --tick --tick-number 1` 이다.

- `two-runs-offline`: orca 와 gh 가 모두 종료 코드 1 로 실패한다. 모든 단계가 Run 마다 오류 이유를 적는다.
- `two-runs-busy`: `r1` 에는 worker 와 600초 넘은 미답변 질문이 있고 `r2` 에는 다른 worker 만 있다. 내 열린 PR 하나가 CI 실패이면서 base 와 충돌한다. Run 마다 응답이 달라 번갈아 도는 순서가 결과에 드러난다.

`runLoopOrder(record)` 가 `runGolden(record, undefined, { dir: <tests>/loop-order, cases, calls: ['orca', 'gh'] })` 를 부른다. `node skills/orch/tests/fixtures/loop-order-run.ts --record` 로 `skills/orch/tests/loop-order/<사례>/input.json` 과 `result.json` 을 만든다. 기록은 이 phase 의 코드(옮기기 전)로 만든다.

### 3. 이 phase 를 검증하는 `skills/orch/tests/loop-order.spec.ts`

`runLoopOrder()` 를 불러 두 사례의 stdout(로그 줄과 결과 줄. 문자열로 비교하므로 `errors` 의 키 순서까지 본다), stderr, 종료 코드, 상태 파일, orca·gh 호출 순서가 기록과 같은지 본다. 정상 사례는 `two-runs-busy`, 실패가 이어지는 사례는 `two-runs-offline` 이다.
순서를 일부러 바꾸면 실패하는지 한 번 확인한다: `orch-loop.ts` 의 마지막 Run 반복에서 `flushDigest` 줄을 완료 보고 뒤로 옮긴 임시 수정으로 테스트가 실패하는 것을 보고 되돌린다. 커밋에는 넣지 않는다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/loop-order.spec.ts skills/orch/tests/golden.spec.ts
node skills/orch/tests/fixtures/golden-run.ts
node scripts/run-tests.ts --tsc-only
git status --short skills/orch/tests/golden skills/orch/scripts
```

앞의 셋은 종료 코드 0, 마지막 줄은 출력이 비어야 한다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/tests/fixtures/golden-run.ts` | 수정 (기록 묶음 인자) |
| `skills/orch/tests/fixtures/loop-order-run.ts` | 신규 |
| `skills/orch/tests/loop-order.spec.ts` | 신규 |
| `skills/orch/tests/loop-order/two-runs-offline/input.json` | 신규 |
| `skills/orch/tests/loop-order/two-runs-offline/result.json` | 신규 |
| `skills/orch/tests/loop-order/two-runs-busy/input.json` | 신규 |
| `skills/orch/tests/loop-order/two-runs-busy/result.json` | 신규 |
