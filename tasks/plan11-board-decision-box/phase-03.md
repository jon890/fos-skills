# Phase 03. worker 없이 남은 단계에 경과 시간 붙이기와 문서 갱신

**Execution profile**: deep

## 목표

`board.ts` 가 항목의 단계를 바꿀 때 그 항목에 시각(`stepAt`)을 남기고, 창은 doing 항목의 「⚙ worker 없음」 줄에 그 시각부터의 경과 시간을 붙인다(R6).
이번 PR 의 동작 변경을 `work-board/README.md` 와 `work-board/CHANGELOG.md` 에 반영한다.

**범위 외**: orch 루프의 `STAGE-STALLED` 알림과 `movement.json` 의 `stages` 기록. 그 판정은 고치지 않는다.

## 컨텍스트

- 스펙: `docs/features/board-decision-box/spec.md` 의 R6 과 D9, D13.
- `work-board/bin/board.ts` 의 `main` 은 파일을 읽고 `normalizeItem` 으로 줄을 객체로 바꾼 뒤 `apply(a, board)` 를 부른다. `apply` 가 `true` 면 `board.updatedAt = localIso(new Date())` 를 적고 옆 파일에 쓴 뒤 rename 한다. 쓰기 명령은 `set`, `step`, `mark`, `del` 이다.
- 창의 「⚙ worker 없음 (<worktree>)」 줄은 `work-board/hooks/register.js` 의 `itemView` 가 그린다. 완료가 아니고 `item.worktree` 가 있는데 `workerFor(item, live.workers)` 가 없을 때다. 줄의 상태는 `stepRows(item)` 의 `state`(`done`, `now`, `todo`, `note`)와 `step`(단계 줄인지)이 정한다.
- 기준 분은 phase 02 의 판정 명령 출력 `settings.idleMin` 을 `live.movement` 로 받는다. 명령을 읽지 못했으면 orch 기본값과 같은 30분을 쓴다. 0 이면 orch 설정의 뜻대로 보지 않는다.
- 창의 지금 시각은 `register.js` 의 전역 `now`(`loadFile` 이 `$.clock.now()` 로 채운다)다.
- `spanText(minutes)` 는 phase 02 가 `register.js` 에 만든 경과 시간 글(「N분」, 「N시간」, 「N일」)이다.
- 기존 board 테스트는 `work-board/tests/board.spec.ts` 가 임시 파일로 `board.ts` 를 실행해 확인한다. orch 의 테스트(`orch/tests/launch-worker.spec.ts` 등)는 `board.ts` 가 쓴 보드의 `details` 나 id 목록만 비교하므로 새 칸에 영향을 받지 않는다. 이 phase 의 검증 명령이 그것을 함께 돈다.

**근거 문서**: `docs/features/board-decision-box/spec.md` 의 R6, `work-board/README.md` 의 「저장 형식」 절과 「결정 필요」, 「워커」 항목

## 의도 메모

- 시각은 「단계 상태가 바뀐 때」 만 바꾼다. 같은 줄을 다시 쓰거나 제목만 바꾸는 `set` 은 시각을 바꾸지 않는다. 항목의 status 와 details, next 의 줄(글과 done)을 비교한다. 옛 문자열 줄을 객체로 바꾸는 정규화는 비교 전에 하므로 변화로 세지 않는다.
- 시각이 없는 기존 항목은 표시하지 않는다(스펙 R6). 이전 시각을 추정해 채우지 않는다.
- 저장 형식에 칸이 하나 늘 뿐 기존 칸의 뜻은 그대로다. 옛 파일은 그대로 읽힌다.

## 작업 항목

### 1. `work-board/bin/board.ts` 의 `stepAt`

- `function stepKey(item: Item): string` 를 둔다. `JSON.stringify([item.status ?? null, item.details ?? null, item.next ?? null])` 다. `normalizeItem` 뒤에 부르므로 줄은 `{text, done}` 객체다.
- `main` 에서 `normalizeItem` 뒤, `apply` 앞에 `const before = new Map(board.items.map((item) => [item, stepKey(item)]))` 를 둔다.
- `apply` 가 `true` 를 낸 뒤 `const stamp = localIso(new Date())` 로 `updatedAt` 과 같은 값을 만들고, `board.items` 가운데 `before` 에 없거나(새 항목) `stepKey` 가 달라진 항목의 `stepAt` 을 `stamp` 로 둔다.
- 머리 주석과 `HELP` 에 「항목의 status, details, next 가 바뀐 쓰기는 그 항목의 stepAt 에 그 시각을 남긴다. 창이 worker 없이 남은 단계의 경과 시간을 이 값으로 잰다」 를 더한다.

### 2. `work-board/hooks/register.js` 의 경과 시간 표시

- `export function idleStepMinutes(item, rows, at, idleMin)`: 아래를 모두 만족하면 `Math.floor((at - Date.parse(item.stepAt)) / 60000)` 을, 아니면 `null` 을 낸다.
  - `item.status === 'doing'`
  - `rows.some((row) => row.step && row.state !== 'done')`(끝나지 않은 단계가 있다)
  - `Date.parse(item.stepAt)` 가 유한한 수다
  - `idleMin > 0` 이고 `at - stepAt >= idleMin * 60000`
- `export function workerNoneText(item, rows, at, idleMin)` 는 `'⚙ worker 없음' + (minutes === null ? '' : ' · ' + spanText(minutes)) + ' (' + item.worktree + ')'` 를 낸다. `minutes` 는 `idleStepMinutes(item, rows, at, idleMin)` 이다. `itemView` 의 worker 없음 줄은 `workerNoneText(item, rows, now, live.movement ? live.movement.idleMin : 30)` 으로 그린다. 경과 시간이 붙으면 줄 색은 지금의 흐림 대신 노란색(`color: 'yellow'`)이다.
- 파일 머리 주석의 형식 설명의 항목 필드 목록에 `stepAt?` 를 더한다.

### 3. `work-board/README.md` 와 `work-board/CHANGELOG.md`

- README 의 「결정 필요」 항목에 「Orca 자동 알림(id 접두 `msg_stop_`, `msg_chaterr_`)은 상자에도 수에도 넣지 않는다. 같은 제목이라도 worker 가 보낸 메시지는 넣는다」 와 「worker 가 직접 올린 막힘은 답장이나 그 worker 의 해제·중지로 사라지고, worker 가 다시 움직여도 남는다」 를 더한다.
- README 의 「워커」 항목 뒤에 「worker 줄 표시」 항목을 더한다. 「멈춤 N분」(판정은 `bin/worker-marks.ts` 가 orch `lib/movement.ts` 로 낸다. 답을 기다리는 질문, CI 를 통과한 PR, 화면 변화를 루프와 같게 넘긴다. 기준은 orch 설정 `pipeline.idle_min`, `pipeline.idle_exited`), 「멈춤 · 터미널 종료」, 「오류: <요약>」(최근 `msg_chaterr_` 하나. 계정 한도, 모델 용량 부족 같은 분류어, 분류하지 못하면 오류 첫 줄. 그 뒤 워크트리 파일이나 커밋이 바뀌었거나 worker 가 해제·중지되면 사라진다), 「⚙ worker 없음 · N시간」(doing 항목의 끝나지 않은 단계가 `stepAt` 부터 idle_min 넘게 worker 없이 남았다. 시각이 없는 옛 항목은 다음 단계 갱신부터 보인다)을 적는다.
- README 의 「정할 것 묻기」 항목에 요청문이 막힘과 자동 알림을 다루는 방법(직접 올린 막힘은 먼저 처리하고 정할 것만 묻는다, 자동 알림은 처리 결과만 알린다, 끝난 worker 는 답장 대신 해제한다)을 담는다는 것을 더한다.
- README 의 「저장 형식」 절에 `stepAt`(그 항목의 status, details, next 를 마지막으로 바꾼 시각. `board.ts` 가 쓴다) 설명을 더한다.
- CHANGELOG 맨 위에 `## 1.10.0 (2026-11-02)` 절을 더한다. 항목: 결정 필요 상자에서 Orca 자동 알림을 뺀다, worker 줄에 멈춤과 최근 오류를 붙인다, worker 없이 남은 단계에 경과 시간을 붙인다(`board.ts` 가 `stepAt` 을 쓴다), 정할 것 묻기 요청문이 막힘과 자동 알림을 다룬다.

### 4. 이 phase 를 검증하는 `work-board/tests/board.spec.ts`

`describe('stepAt')` 를 더한다.

- `set n doing --next '1. a'` 로 새 항목을 만들면 `stepAt` 이 있고 `updatedAt` 과 같다.
- 기존 항목에 `stepAt: '2000-01-01T00:00:00+09:00'` 을 두고 `step n 1` 을 하면 값이 바뀐다. `mark` 도 같다.
- 같은 항목에 `set n --title 새 제목` 만 하면 `stepAt` 이 그대로다. 같은 `--next` 를 다시 줘도 그대로다.
- 옛 문자열 `next`(「1. a」) 항목에 제목만 바꾸는 `set` 을 하면 `stepAt` 이 생기지 않는다.

### 5. 이 phase 를 검증하는 `work-board/tests/decision-box.spec.ts`

- decision-box: `idleStepMinutes` 가 doing 항목, 끝나지 않은 단계, 40분 전 `stepAt`, idleMin 30 에서 40 을 낸다. wait·decide 항목, 단계가 모두 끝난 항목, `stepAt` 이 없는 항목, 20분 전, idleMin 0 은 `null` 이다.
- `workerNoneText(item, rows, at, idleMin)`(작업 항목 2 의 줄 글을 내는 함수로 빼 둔다)가 3시간 전 `stepAt` 에서 「⚙ worker 없음 · 3시간 (wt-a)」, `stepAt` 이 없으면 「⚙ worker 없음 (wt-a)」 를 낸다.

## 검증

```bash
node --test work-board/tests/board.spec.ts work-board/tests/decision-box.spec.ts
claude plugin test .
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts" "inbox/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
python3 korean-check/scripts/korean-style-check.py work-board/README.md work-board/CHANGELOG.md
```

모든 명령이 종료 코드 0 이다. `scripts/tests` 가 CHANGELOG 형식을 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/bin/board.ts` | 수정 |
| `work-board/hooks/register.js` | 수정 |
| `work-board/README.md` | 수정 |
| `work-board/CHANGELOG.md` | 수정 |
| `work-board/tests/board.spec.ts` | 수정 |
| `work-board/tests/decision-box.spec.ts` | 수정 |
