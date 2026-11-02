# Phase 02. worker 줄에 멈춤과 최근 오류 붙이기

**Execution profile**: standard

## 목표

항목의 worker 줄에 그 worker 가 멈췄으면 「멈춤 N분」(R4), 최근 에이전트 오류가 있고 그 뒤 움직이지 않았으면 「오류: <요약>」(R5)을 붙인다.
멈춤 판정은 orch 상주 루프와 같은 함수(`orch/scripts/lib/movement.ts` 의 `judgeWorker`)와 같은 입력(답을 기다리는 질문, 머지 대기, 화면 변화)으로 낸다.

**범위 외**: 「worker 없음 · N시간」(phase 03). orch 루프의 `WORKER-IDLE` 알림과 `stalled-workers.ts` 는 고치지 않는다. 상자의 질문 목록은 phase 01 의 것을 그대로 쓴다.

## 컨텍스트

- 스펙: `docs/features/board-decision-box/spec.md` 의 R4, R5 와 D2, D8, D11, D12, D14.
- mod(`work-board/hooks/register.js`)는 Claude Code 의 mod 실행 환경에서 돌아 `node:fs` 나 TypeScript 를 import 하지 못한다. 외부 일은 `$.process.run(argv, { timeoutMs })` 로 명령을 부른다. 같은 플러그인의 스크립트는 `$.plugin.root + '/inbox/scripts/inbox.ts'` 처럼 경로를 만들어 `node --disable-warning=ExperimentalWarning <스크립트>` 로 부른다(`loadInbox` 참고).
- 그래서 판정은 새 TypeScript 명령 `work-board/bin/worker-marks.ts` 가 orch 의 `lib/movement.ts` 를 import 해 내고, mod 는 그 JSON 출력만 읽는다. orch 의 `lib/paths.ts` 가 `work-board/bin/board.ts` 를 import 하므로, 새 명령은 `board.ts` 와 다른 파일이어야 import 고리가 생기지 않는다.
- orch 에서 재사용할 것(모두 export 돼 있다): `orch/scripts/lib/movement.ts` 의 `movementSettings(repo)`, `judgeWorker`, `openRows`, `worktreeOf`, `latestMtime`, `lastCommitMs`, `readRecords`, `DEFAULT_IDLE_MIN`. `orch/scripts/lib/config.ts` 의 `ConfigError`. `orch/scripts/lib/paths.ts` 의 `pathOf('state', repo)`. `orch/scripts/lib/workers.ts` 의 `workerRows(run)`.
- 루프의 기다리는 이유는 `orch/scripts/orch-loop.ts` 의 `watchMovement` 안 `waitingOf` 가 정한다. 질문을 읽지 못한 Run 이면 `'질문을 읽지 못했다'`, 그 dispatch 나 터미널이 보낸 미답변 질문이 있으면 `'질문의 답을 기다린다'`, 워크트리 브랜치의 열린 PR 이 CI 를 통과했으면 `'CI 를 통과해 머지를 기다린다'` 다. 루프의 미답변 질문은 `lib/questions.ts` 의 `snapshot` 이 낸다. question 과 escalation 을 모두 세되, 턴만 끝낸 멈춤 보고(`lib/stop-reports.ts` 의 `isQuietStop`, `stopReason` 이 `finished`)는 뺀다.
- 화면 변화는 루프가 `<orch 루트>/state/movement.json` 의 `screens` 에 남긴다. `stalled-workers.ts` 의 `screens(repo)` 처럼 `readRecords(JSON.parse(...)).screens` 로 읽고, 없거나 깨졌으면 빈 기록이다.
- `msg_chaterr_` 오류 알림의 실측 모양(2026-11-02): `subject` 「Agent hit an error: Claude hit its session limit.」, `payload` 는 JSON 문자열 `{"taskId","dispatchId","handle","failureKind":"usageLimitReached","error":"Claude hit its session limit.","detail":"You've hit your 5-hour limit · resets 8:50pm (Asia/Seoul)"}`, `body` 첫 줄은 「Worker <handle> hit an error while running task …」, 둘째 줄이 「Error: …」 다. 용량 부족은 `failureKind` 없이 `error` 가 「Selected model is at capacity. Please try a different model.」 이다.
- 계정 한도 문구는 `orch/scripts/lib/sessions.ts` 의 `LIMIT_LINE`(`/usage limit reached|you['’]ve hit your\b.*\blimit|out of credits/iu`)과 같은 뜻으로 본다. mod 는 그 파일을 import 하지 못하므로 같은 정규식을 옮기고 출처를 주석에 적는다.
- worker 줄은 두 곳에서 그린다. 항목 아래 줄(`itemView` 의 `'⚙ worker ' + workerLine(worker, live.prs)`)과 「항목에 안 붙은 worker」 상자의 줄(`'▶ ' + workerLine(worker, live.prs)`)이다. `live.workers` 의 원소는 `parseWorkers` 가 만든 `{ id(dispatchId), terminal, state, worktree }` 다.

**근거 문서**: `docs/data-schema.md` 의 `pipeline.idle_min`, `pipeline.idle_exited` 행과 `state/movement.json` 행, `orch/references/waiting.md` 의 움직임 확인 설명

## 의도 메모

- `stalled-workers.ts` 에 옵션을 더하는 안은 기각한다. 그 명령은 보드 단계까지 훑고 멈춤이 있으면 종료 코드 3 이라, 45초마다 부르는 mod 에는 비용과 종료 코드 해석이 맞지 않는다. 판정 함수만 같으면 루프와 같은 결과다(D11).
- 질문 조회를 새 명령에서 다시 하지 않는다. mod 가 이미 같은 Run 의 질문과 답을 읽었으므로, 답을 기다리는 worker 의 id 만 인자로 넘긴다. Orca 호출을 두 배로 늘리지 않는다.
- R5 의 「움직였다」 는 오류 시각 뒤에 워크트리 파일이나 커밋이 바뀐 것으로 본다. 화면 변화 시각은 쓰지 않는다. 오류 알림 자체가 화면을 바꾸고, 루프는 그 변화를 틱(기본 300초) 단위로 늦게 적어 오류 직후에 표시가 사라지기 때문이다.
- 판정 명령은 45초마다 worker 목록을 다시 읽고 워크트리마다 파일을 4000개까지 훑는다. 루프의 틱과 같은 비용이고 mod 의 읽기는 비동기라 창을 막지 않는다. 실패는 `next.errors.marks` 에만 남기고 화면에 줄로 보이지 않는다. 표시가 덧붙임이라 실패해도 상자와 worker 줄은 지금처럼 보이기 때문이다.
- 머지 대기는 루프와 달리 PR 작성자와 HEAD 일치를 보지 않는다. mod 의 PR 목록(`gh pr list`)에 작성자 필터와 CI 판정 커밋이 없고, worker 의 PR 은 코디네이터 계정이 연다.
- 판정을 읽지 못하면(명령 실패) 멈춤 표시는 붙이지 않고, 오류 표시는 움직임을 모르는 것으로 보고 붙인다. 모르는 것을 멈춤으로 알리지 않는 루프의 원칙과 같고, 오류는 실제로 온 알림이라 남긴다.

## 작업 항목

### 1. `work-board/bin/worker-marks.ts` 신규

머리 주석에 사용법, 출력, 종료 코드, 판정 출처(`orch/scripts/lib/movement.ts` 머리 주석)를 적는다. work-board 가 orch 를 import 하는 곳이 이 파일 하나라는 것과 이유(스펙 D11)를 적는다.

```text
worker-marks.ts --repo DIR [--run ID] [--asking ID]... [--merging ID]... [--questions-unknown]
  --repo               설정(pipeline.idle_min, pipeline.idle_exited)과 movement.json 을 읽을 저장소(주 checkout)
  --run                worker 목록을 읽을 Run. 없으면 workers 는 빈 목록이고 settings 만 낸다
  --asking             답을 기다리는 질문을 보낸 dispatch id 나 터미널 handle. 여러 번 준다
  --merging            CI 를 통과해 머지를 기다리는 dispatch id. 여러 번 준다
  --questions-unknown  질문을 읽지 못했다. 모든 worker 를 '질문을 읽지 못했다' 로 기다리는 것으로 본다
출력(stdout 한 줄 JSON): {"settings": {"idleMin": n, "exited": b}, "workers": [WorkerMark...], "error": null | "<worker 목록을 읽지 못한 이유>"}
  WorkerMark = {"dispatch", "terminal", "worktree", "reason": "idle"|"exited"|null, "idleMin": n|null, "movedAt": ms|null, "workedAt": ms|null, "waiting": string|null}
  workedAt 은 워크트리 파일의 마지막 수정 시각과 마지막 커밋 시각 중 늦은 것이다. 화면은 넣지 않는다
종료 코드: 0 냈다(worker 목록을 못 읽어도 error 에 이유를 두고 0), 2 사용법 오류나 설정 오류(stderr 에 이유)
```

- `export function markWorkers(input: { rows: Json[]; settings: MovementSettings; now: number; screens: Record<string, ScreenMark>; asking: ReadonlySet<string>; merging: ReadonlySet<string>; questionsUnknown: boolean }): WorkerMark[]` 를 둔다. `openRows(rows)` 의 행마다 `worktreeOf(row)` 경로가 있고 `existsSync` 로 있으면 `latestMtime`, `lastCommitMs` 를 읽고(없으면 둘 다 `null`. `collectWorkers` 와 같다), `judgeWorker({ run: '', row, now, settings, mtime, commit, screen: screens[dispatchId], waiting })` 를 부른다. `waiting` 은 `questionsUnknown` 이면 `'질문을 읽지 못했다'`, `asking` 에 `dispatchId` 나 `agentTerminalHandle` 이 있으면 `'질문의 답을 기다린다'`, `merging` 에 `dispatchId` 가 있으면 `'CI 를 통과해 머지를 기다린다'`, 아니면 `null` 이다(`orch-loop.ts` 의 `waitingOf` 와 같은 순서와 문구). 결과의 `run` 은 출력에서 뺀다.
- `main` 은 `parseArgs` 로 인자를 읽고(`allowPositionals: false`), `movementSettings(real(repo))` 가 `ConfigError` 를 던지면 종료 코드 2 다. `--run` 이 있으면 `workerRows(run)` 을 부르고, `ok: false` 면 `workers: []`, `error: <이유>` 로 낸다. 화면 기록은 `join(pathOf('state', repo), 'movement.json')` 을 읽어 `readRecords(...).screens` 로 얻고, 읽지 못하면 `{}` 다.
- 명령 실행은 `if (import.meta.main)` 안에만 둔다. 테스트가 import 할 때 돌지 않게 한다(`board.ts` 와 같은 방식).

### 2. `work-board/hooks/register.js` 의 판정 입력과 읽기

- `export function isQuietStop(m)` 를 더한다. `orch/scripts/lib/stop-reports.ts` 의 `stopReason` 과 같은 규칙이다. `type` 이 `escalation` 이고, payload(문자열이면 JSON 으로 읽는다)의 `stopReason` 이 있으면 그 값이, 없으면 제목 표(「Worker stopped without reporting」 → `finished`, 「Worker stopped on an error without reporting」 → `errored`, 「Worker is waiting on a prompt」 → `needs-input`, 「Worker exited without reporting」 → `exited`)의 값이 `finished` 면 참이다. 출처를 주석에 적는다.
- `queryQuestions` 반환값에 `asking`(문자열 배열)과 `failures`(오류 목록)를 더한다.
  - `asking`: `parseQuestions(JSON.stringify({ messages: [...candidates.filter((m) => !isQuietStop(m)), ...replies] }), runId, workerOf)` 의 미답변마다, 그 id 의 원본 메시지에서 `dispatchOf(m)`, `m.from_handle`, `workerOf(m)` 가운데 있는 값을 모은다(중복 없음). 루프의 `askers(snapshot().pending)` 와 같은 뜻이다.
  - `failures`: `alerts` 가운데 `autoAlertKind(m) === 'error'` 인 것을 worker(`workerOf(m) || dispatchOf(m) || m.from_handle`)마다 `created_at` 이 가장 늦은 하나로 묶어 `{ worker, at: <created_at 의 ms, 못 읽으면 0>, summary: errorSummary(m) }` 로 낸다. 같은 오류가 여러 번 와도 하나다(R5).
- `export function errorSummary(m)`: payload 의 `failureKind` 가 `usageLimitReached` 이거나 payload `error`·`detail` 이나 `body` 가 계정 한도 정규식에 맞으면 `'계정 한도'`, `/at capacity|overloaded/i` 에 맞으면 `'모델 용량 부족'`, 아니면 payload `error` 의 첫 줄, 없으면 `body` 에서 `Error:` 로 시작하는 줄의 뒤, 그것도 없으면 `body` 의 첫 줄이다. `questionText(text, 80)` 으로 줄인다.
- `export function ciPassed(pr)`: `pr.pass + pr.fail + pr.pending > 0`, `pr.fail === 0`, `pr.pending === 0` 이면 참이다. 루프의 `ciState`(`orch/scripts/lib/gh.ts`)가 선택 검사를 포함해 실패가 하나라도 있으면 `failed` 로 보는 것과 맞춘다.
- `export function mergingIds(workers, prs)`: `workers` 가운데 `prFor(w, prs)` 가 있고 `ciPassed` 인 worker 의 `id` 목록이다.
- `export function parseMarks(stdout)`: JSON 을 읽어 `settings` 가 객체이고 `settings.idleMin` 이 수이며 `workers` 가 배열일 때만 `{ settings, marks: <dispatch 에서 WorkerMark 로의 객체>, error }` 를 낸다. 아니면 `Error('판정 출력 형식이 달라요')` 를 던진다.
- `export function marksArgv(script, repo, runId, asking, merging, questionsUnknown)`: `['node', '--disable-warning=ExperimentalWarning', script, '--repo', repo, ...(runId ? ['--run', runId] : []), ...asking.flatMap((id) => ['--asking', id]), ...merging.flatMap((id) => ['--merging', id]), ...(questionsUnknown ? ['--questions-unknown'] : [])]` 를 낸다.
- `loadLive` 의 PR 읽기 뒤에 판정을 읽는다. 저장소 루트는 `await boardRoot($)` 이고 비었으면 건너뛴다. `merging` 은 `mergingIds(next.workers, next.prs)` 다. 명령은 `run($, marksArgv(...), MARKS_TIMEOUT_MS)` 로 부르고 `MARKS_TIMEOUT_MS` 는 30000 이다. 질문을 읽지 못했으면(`next.errors.questions`) `questionsUnknown` 이 참이다. `parseMarks` 결과의 `marks` 를 `next.marks`, `settings` 를 `next.movement` 에 둔다. 명령이 실패하거나 `parseMarks` 가 던지면 `next.errors.marks` 에 이유를 두고 `next.marks` 는 `null` 이다. `next.failures` 에는 `queryQuestions` 의 `failures` 를 둔다. `live` 초기값과 `next` 초기값에 `marks: null, movement: null, failures: []` 를 더한다.

### 3. 바뀌는 설명 고치기

- `work-board/bin/board.ts` 의 `pyJson`, `expand` 주석에 있는 「work-board 는 orch 를 import 하지 않아(의존은 orch 에서 work-board 쪽 하나다)」 를 「board.ts 는 orch 를 import 하지 않는다(orch 의 lib/paths.ts 가 board.ts 를 import 해 고리가 생긴다)」 로 고친다.
- `docs/data-schema.md` 의 `state/movement.json` 행의 「`stalled-workers` 는 `screens` 만 읽는다」 를 「`stalled-workers` 와 work-board 의 `bin/worker-marks.ts` 는 `screens` 만 읽는다」 로 고친다.
- `orch/scripts/lib/movement.ts` 머리 주석의 「사용처」 에 `work-board/bin/worker-marks.ts`(보드 worker 줄의 멈춤 표시)를 더한다. 주석만 바꾸므로 orch 버전은 올리지 않는다.

### 3-1. `work-board/hooks/register.js` 의 표시

- `export function spanText(minutes)`: 60분 미만은 「N분」, 24시간 미만은 「N시간」(내림), 그 밖은 「N일」(내림)이다.
- `export function workerNotes(worker, marks, failures)`: 글 목록을 낸다.
  - `marks?.[worker.id]` 의 `reason` 이 `'idle'` 이면 `'멈춤 ' + spanText(idleMin)`, `'exited'` 면 `'멈춤 · 터미널 종료'` 다(R4). `marks` 가 `null` 이면 멈춤 글이 없다.
  - `failures` 에서 `worker === worker.id` 인 것이 있고, 그 worker 의 mark 가 없거나 `workedAt` 이 `null` 이거나 `workedAt <= at` 이면 `'오류: ' + summary` 다(R5).
- `itemView` 의 worker 줄과 「항목에 안 붙은 worker」 상자의 줄에 `workerNotes(worker, live.marks, live.failures)` 의 글을 `Text({ color: 'red', children: ['  ' + note] })` 로 줄 끝에 이어 붙인다. 글이 없으면 지금과 같다.

### 4. 이 phase 를 검증하는 `work-board/tests/worker-marks.spec.ts` 신규(node test)

임시 폴더(`mkdtempSync`)를 워크트리로 쓰는 `markWorkers` 테스트다. 행은 `{ dispatchId: 'd1', dispatchStatus: 'dispatched', agentTerminalHandle: 't1', resource: { worktreeId: 'x::' + <임시 폴더> } }` 꼴이다. 파일 mtime 은 `utimesSync` 로 맞춘다. settings 는 `{ idleMin: 30, exited: true }` 다.

- 정상: 파일이 40분 전에 바뀌었고 기다리는 이유가 없으면 `reason: 'idle'`, `idleMin: 40` 이다. 5분 전이면 `reason: null` 이다.
- 기다림: 같은 40분 전 행이라도 `asking` 에 `d1` 이나 `t1` 이 있으면 `reason: null`, `waiting: '질문의 답을 기다린다'` 이고, `merging` 에 `d1` 이 있으면 `'CI 를 통과해 머지를 기다린다'`, `questionsUnknown` 이면 `'질문을 읽지 못했다'` 다.
- 화면: 파일은 40분 전이지만 `screens.d1.changedAt` 이 2분 전이면 `reason: null` 이고 `workedAt` 은 파일 시각이다.
- 종료: `projection.liveness.verdict: 'exited'` 면 `asking` 에 있어도 `reason: 'exited'` 다.
- 닫힌 dispatch(`dispatchStatus: 'failed'`)는 결과에 없다.
- 명령: `spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', <worker-marks.ts>, '--repo', <임시 저장소>], { env })` 가 종료 코드 0 과 `{"settings": {"idleMin": 30, "exited": true}, "workers": [], "error": null}` 를 낸다. `env` 는 `process.env` 를 복사해 `ORCH_DIR` 를 지운 것이다. 물려받은 `ORCH_DIR` 가 절대경로면 실제 설정 파일을 읽고 쓰기 때문이다. 임시 저장소는 `git init` 한 폴더다. `<임시 저장소>/.orch/config.json` 에 `{"pipeline": {"idle_min": -1}}` 를 쓰면 종료 코드 2 다.

### 5. 이 phase 를 검증하는 `work-board/tests/decision-box.spec.ts`

앞 phase 가 만든 파일에 테스트를 더한다.

- R4: `workerNotes({ id: 'd1' }, { d1: { reason: 'idle', idleMin: 45 } }, [])` 가 `['멈춤 45분']`, `{ d1: { reason: 'exited', idleMin: null } }` 가 `['멈춤 · 터미널 종료']`, `{ d1: { reason: null, waiting: '질문의 답을 기다린다' } }` 와 `null` 이 `[]` 다. `spanText(45)`, `spanText(130)`, `spanText(3000)` 은 「45분」, 「2시간」, 「2일」 이다.
- R5: 오류 시각 `at` 뒤에 `workedAt` 이 있으면 「오류: 」 글이 없고, 없거나 이르면 있다. mark 가 없어도 있다.
- R5 요약: `msg_chaterr_` 실측 꼴(`failureKind: 'usageLimitReached'`)은 「계정 한도」, 용량 부족은 「모델 용량 부족」, `error` 가 「boom\nmore」 이고 분류되지 않으면 「boom」 이다.
- R5 묶음과 R4 입력: `queryQuestions` 에 같은 worker 의 `msg_chaterr_` 두 건(시각이 다르다)과 `msg_stop_` 멈춤 보고(`stopReason: 'finished'`), 미답변 question 하나를 준다. `failures` 는 늦은 오류 하나이고, `asking` 에는 그 question 의 dispatch 가 있다. 미답변 question 을 빼고 `msg_stop_` 만 두면 `asking` 이 비고, `stopReason: 'errored'` 인 `msg_stop_` 이면 그 dispatch 가 `asking` 에 있다.
- `isQuietStop`: payload `stopReason: 'finished'` 와 payload 없이 제목 「Worker stopped without reporting」 은 참, `stopReason: 'errored'` 와 question 은 거짓이다.
- `ciPassed`: 통과 둘 → 참, 진행 하나 → 거짓, `claude-review` 만 실패 → 거짓(루프와 같다), 검사 없음 → 거짓이다.
- `mergingIds`: worktree `wt-a` 의 worker 와 브랜치 `wt-a` 의 통과 PR 이면 그 id, PR 이 실패나 진행이면 빈 목록, PR 이 없으면 빈 목록이다.
- `parseMarks`: 판정 명령 출력 꼴이면 dispatch 로 찾을 수 있는 객체를 내고, 기존 테스트의 가짜 출력 `{ result: { workers: [] } }` 와 깨진 JSON 은 던진다.
- `marksArgv('/p/worker-marks.ts', '/repo', 'r', ['d1'], ['d2'], true)` 의 인자 순서를 본다.

## 검증

```bash
node --test work-board/tests/worker-marks.spec.ts work-board/tests/decision-box.spec.ts
claude plugin test .
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts" "inbox/tests/*.spec.ts"
```

세 명령 모두 종료 코드 0 이다. `claude plugin test .` 는 기존 `pane.test.ts` 가 그대로 통과하는지 본다. 기존 pane 테스트의 가짜 명령 결과는 판정 명령에도 `{ result: { workers: [...] } }` 를 내므로, `settings` 객체가 없는 출력은 판정을 읽지 못한 것(`next.errors.marks`)으로 다뤄야 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/bin/worker-marks.ts` | 신규 |
| `work-board/hooks/register.js` | 수정 |
| `work-board/bin/board.ts` | 수정 |
| `docs/data-schema.md` | 수정 |
| `orch/scripts/lib/movement.ts` | 수정 |
| `work-board/tests/worker-marks.spec.ts` | 신규 |
| `work-board/tests/decision-box.spec.ts` | 수정 |
