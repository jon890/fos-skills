# Phase 04. 띄우기 전 확인 명령 `orch board auto-check`

**Execution profile**: standard

## 목표

코디네이터가 `[auto]` 단계를 띄우기 직전에 부르는 명령을 만든다. 보드와 근거 파일, worker 목록, 열린 PR, 띄운 기록을 읽어 한 줄로 답한다. 글 규칙만으로는 바쁠 때 확인을 건너뛰므로 명령이 확인한다.

**범위 외**: 띄운 기록을 쓰는 일(phase 05. 이 phase 는 기록 파일의 읽기와 덧붙이기 함수만 만든다). 사용 한도 확인(다음 PR). 보드를 고치는 일(이 명령은 읽기만 한다).

## 컨텍스트

- 판정은 phase 03 의 `skills/orch/scripts/core/auto-advance.ts`(`eventDone`, `itemBusy`, `judgeAdvance`, `ADVANCE_REASONS`, `autoAdvanceOf`), 근거 읽기는 phase 02 의 `core/evidence.ts`(`parseEvidence`), 표시 읽기는 phase 01 의 `extensions/work-board/hooks/step-marks.js`(`parseStepMark`)가 한다.
- 단계 목록은 보드 도구의 `board.ts steps <항목> --file <보드>` 로 읽는다. 진행률을 세는 쪽(details, 없으면 next)의 번호 줄을 `[{"number", "done", "text"}]` 로 낸다. `text` 는 앞 완료 표시를 뗀 줄 글이다. orch 에서는 `skills/orch/scripts/lib/board.ts` 의 `boardSteps(bin, id, file)` 가 부르고, 읽지 못하면 `null` 이다. 보드 도구 경로는 같은 파일의 `BOARD_BIN`(환경 변수 `BOARD_BIN` 이 앞선다)이다. 단계 고르는 규칙을 orch 에 다시 쓰지 않는다.
- 줄 끝 사건 꼬리표는 `extensions/work-board/hooks/event-tags.js` 의 `parseEventTag(text)` 로 읽고 `hideEventTag(text)` 로 뗀다. `lib/board.ts` 가 이미 그 파일을 가져온다.
- 보드 파일은 `boardPath(repo, explicit?)` 로 찾고 `lib/board.ts` 의 `readBoard(file)` 로 읽는다. `boardPath` 는 지금 `skills/orch/scripts/lib/paths.ts` 에 있고, 보드 명령 구현이 `lib/board-file.ts` 로 옮긴다.
- `stages` 필드는 `skills/orch/scripts/lib/milestones.ts` 의 `stagesOf(item)`, PR 번호 필드는 `lib/board.ts` 의 `prNumbers(field)`(Set 을 돌려준다)로 읽는다. 설정은 `skills/orch/scripts/lib/config.ts` 의 `loadConfig(repo)` 로 읽어 `autoAdvanceOf` 에 넘긴다.
- worker 목록은 `skills/orch/scripts/lib/workers.ts` 의 `workerRows(run)`(`{ ok, rows }` 나 `{ ok: false, error }`)와 `worktreePaths(repo)`(`{브랜치: 워크트리 경로}`)로 읽는다. 열린 dispatch 행과 그 워크트리 경로는 `skills/orch/scripts/lib/movement.ts` 가 내보내는 `openRows(rows)`, `worktreeOf(row)` 다. 그 저장소 루프에 등록된 Run 은 `skills/orch/scripts/lib/loop.ts` 의 `registeredRuns(repo)`(항목의 `run` 이 Run id)다.
- 열린 PR 은 `skills/orch/scripts/lib/gh.ts` 의 `ghJson(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefName'], { cwd: repo })` 로 읽는다(`board-sync.ts` 가 같은 조회를 쓴다).
- 스펙 확인 줄 판정은 지금 `skills/orch/scripts/spec/spec-lint.ts` 안의 `confirmProblem`(와 `CONFIRMED`, `validDate`)이다. 제목과 첫 `## ` 절 사이의 `확인: YYYY-MM-DD` 줄을 보고, 코드 블록 안은 `skills/orch/scripts/lib/common-rules.ts` 의 `outsideFences` 로 뺀다. 줄은 `spec-lint.ts` 의 지역 함수 `splitLines`(`LINE_BREAK` 로 나누고 끝의 빈 줄을 뺀다)로 나눈다. `LINE_BREAK` 의 원본은 `skills/orch/scripts/core/text.ts` 다.
- 저장소 기본 checkout 은 `skills/orch/scripts/lib/git.ts` 의 `mainCheckout(repo)`, orch 상태 폴더는 `lib/paths.ts` 의 `pathOf('state', repo)`(읽기)와 `ensure('state', repo)`(쓰기 전 만들기)다.
- 명령 표는 `skills/orch/scripts/lib/commands.ts` 의 `ROWS` 다. `context` 에 `'repo'`, `'run'` 을 적으면 진입점이 `--repo`, `--run` 을 문맥에서 채운다. 짧은 출력 규칙은 `skills/orch/scripts/lib/output.ts` 머리 주석이 소유한다. `emit` 은 대문자 낱말로 시작하는 판정 줄만 짧은 출력에 내고, 나머지 줄은 `--full` 이거나 스크립트를 경로로 직접 부를 때만 낸다.
- 가짜 `orca` 로 명령을 돌리는 테스트 방식은 `skills/orch/tests/stalled-workers.spec.ts` 에 있다. 환경 변수 `ORCA` 에 임시 실행 파일을 주고 `orca.json` 의 `workers_by_run` 으로 답한다. `gh` 는 환경 변수 `GH` 로 바꾼다.

**선행 조건**: 보드 명령 구현 PR(`docs/features/orch-board-cli/spec.md`)이 먼저 머지된다. 그 PR 이 `boardPath` 의 자리, `lib/board.ts`, `lib/commands.ts` 의 board 묶음을 고친다. 이 phase 를 시작할 때 세 곳의 지금 모습을 다시 읽고 `boardPath` 는 옮긴 자리에서 가져온다(설계 「보드 명령 설계와 맞출 것」 5, 7, 8번).

**요구사항**: REQ3, REQ9, REQ10, REQ11

**근거 문서**: `docs/features/board-auto-advance/spec.md`, `docs/features/board-auto-advance/design.md` 「`orch board auto-check <항목>`」, 「단계 글을 비교할 때」, 「띄운 기록 `state/step-launches.jsonl`」

## 의도 메모

- 이 명령은 통과해도 아무것도 기록하지 않는다. 통과할 때 「띄웠다」 로 기록하면 확인만 두 번 불러도 거절된다. 기록은 실제로 띄울 때 남긴다(phase 05).
- 상대경로 근거는 부른 폴더가 아니라 저장소 기본 checkout 기준이다(스펙 REQ3). 연결된 워크트리에서 불러도 같다.
- 확인하지 못한 것을 「없다」 로 보지 않는다. Run 을 모르거나 worker 목록, 열린 PR 을 못 읽으면 거절한다.
- 스펙 확인 줄 판정을 `lib/spec.ts` 에 두지 않는다. 그 파일은 지시서를 읽는 모듈이고, 기능 스펙의 확인 줄은 다른 문서의 규칙이다.
- 띄운 기록은 덧붙이기만 하는 파일이라 잠금을 쓰지 않는다. 한 줄이 짧아 겹쳐 써도 섞이지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/spec-confirm.ts` 신규, `skills/orch/scripts/spec/spec-lint.ts` 수정

`spec-lint.ts` 의 `CONFIRMED`, `validDate`, `confirmProblem` 을 새 파일로 옮기고 `confirmProblem(text: string): string | null` 을 내보낸다. 동작과 돌려주는 글은 그대로다. 줄 나누기 함수 `splitLines` 도 새 파일로 옮겨 내보내고, `spec-lint.ts` 는 `confirmProblem` 과 `splitLines` 를 새 파일에서 가져와 쓴다. `splitLines` 가 쓰는 `LINE_BREAK` 는 옮기지 않는다. 원본이 `skills/orch/scripts/core/text.ts` 에 있으니(`spec-lint.ts` 는 `lib/spec.ts` 의 재수출로 가져온다) 새 파일도 거기서 가져온다. `validDate` 를 `spec-lint.ts` 의 다른 곳이 쓰면 그것도 내보낸다.

### 2. `skills/orch/scripts/lib/step-launches.ts` 신규

파일은 `<orch 상태 폴더>/step-launches.jsonl` 이고 한 줄이 `{"at": <ISO 8601 UTC>, "item": <항목 id>, "number": <단계 번호>, "step": <꼬리표를 뗀 단계 글>, "dispatch": <dispatch id>}` 다.

```ts
// 같은 항목, 같은 단계 글로 띄운 기록이 있는가. 파일이 없으면 false. 깨진 줄은 건너뛴다
export function stepLaunched(repo: string, item: string, step: string): boolean
// 한 줄을 덧붙인다. 폴더가 없으면 만든다
export function appendStepLaunch(repo: string, row: { item: string; number: number; step: string; dispatch: string }): void
```

파일이 줄바꿈 없이 끝나 있으면 앞에 줄바꿈을 넣는다(`skills/orch/scripts/lib/launch-history.ts` 의 `recordHistory` 와 같은 방식).

### 3. `skills/orch/scripts/lib/auto-advance.ts` 신규

```ts
export type PendingStep = { number: number; mark: 'auto' | 'ask' | 'wait' | null; condition: string | null; text: string; key: string; body: string }

// 끝나지 않은 첫 단계. 단계가 없거나 모두 끝났으면 null. 단계 목록을 읽지 못하면 Error 다
export function firstPendingStep(file: string, item: Record<string, unknown>): PendingStep | null
// 항목 하나를 확인한다
export function checkAdvance(repo: string, id: string, opts?: { board?: string; run?: string }): { verdict: AdvanceVerdict; step: PendingStep | null; checks: Array<{ text: string; problem: string | null }> }
```

`firstPendingStep`:

- `boardSteps(<보드 도구>, <항목 id>, file)` 의 목록에서 `done` 이 아닌 첫 줄이다. `null` 이 오면 `Error('단계 목록을 읽지 못했다: <id>')` 를 던진다.
- `text` 는 그 줄의 글, `key` 는 `hideEventTag(text)`(띄운 기록과 비교하는 글), `mark`·`condition`·`body` 는 `parseStepMark(text)` 의 값이다.
- 그 줄의 번호가 `stagesOf(item)` 의 값 가운데 있으면 `mark` 와 `condition` 을 `null` 로 둔다. 사건 단계에는 표시를 읽지 않는다.

`checkAdvance` 의 순서:

1. `autoAdvanceOf(loadConfig(repo))` 를 읽는다. `ConfigError` 는 그대로 던진다.
2. 보드 파일(`boardPath(repo, opts?.board)`)이 없으면 항목이 없는 것으로 본다. 있으면 `readBoard` 로 읽는다. JSON 이 깨져 읽지 못하면 `Error('보드를 읽지 못했다: <파일>: <이유>')` 를 던진다.
3. 항목을 id 로 찾고(`row.id === id`) `firstPendingStep` 을 구한다.
4. 여기까지 `judgeAdvance` 의 앞 네 조건(꺼짐, 항목 없음, 상태, `[auto]` 아님)에 걸리면 아래 5, 6, 7번을 건너뛰고 8번으로 간다. Orca 와 gh 를 쓸데없이 부르지 않는다.
5. 진행 중인지 본다.
   - Run 목록은 `registeredRuns(repo)` 의 Run 과 `opts?.run` 을 합친 것이다(중복 없이). 하나도 없으면 `busy` 는 `null` 이다.
   - Run 마다 `workerRows(run)` 을 읽는다. 하나라도 `ok` 가 아니면 `busy` 는 `null` 이다. 읽었으면 `openRows(rows)` 의 `worktreeOf(row)` 가운데 `null` 이 아닌 것이 `live` 다.
   - `branches` 는 `worktreePaths(repo)` 다.
   - 열린 PR 을 위 `ghJson` 조회로 읽는다. 실패하면 `busy` 는 `null` 이다. `{ number: String(number), branch: headRefName }` 으로 바꾼다.
   - `itemBusy({ worktree, branch, pr: [...prNumbers(item.pr)] }, live, branches, openPrs)` 가 `busy` 다. `worktree` 와 `branch` 는 항목의 그 필드를 앞뒤 공백을 떼어 읽고 비었으면 `null` 이다.
6. `stepLaunched(repo, id, step.key)` 를 읽는다.
7. 단계의 `body` 에서 `parseEvidence` 로 근거를 읽고 근거마다 확인한다. 문제 글은 `ADVANCE_REASONS` 의 값을 쓴다.
   - 스펙: 경로가 절대경로면 그대로(`~/` 는 홈 폴더), 아니면 `mainCheckout(repo)` 기준이다. 파일이 아니면 `noSpec`, `confirmProblem` 이 문제를 내면 `unconfirmed`.
   - 계획: 같은 경로 규칙이다. 파일도 폴더도 아니면 `noPlan`.
   - 앞 사건: 보드의 **모든 항목**을 `BoardView` 로 바꿔 `eventDone` 에 넘긴다. 거짓이면 `eventPending`. 항목마다 `pr`, `mergedPr`, `stages` 는 늘 채운다. `merged-pr` 필드만 있는 직접 쓴 항목도 머지 근거가 되기 때문이다. `steps` 는 그 항목의 `boardSteps` 목록이고 `tag` 는 `parseEventTag(text)` 다. 줄 글에 `(#` 가 없고 `stages` 필드도 없는 항목은 단계 목록이 판정에 쓰이지 않으므로 보드 도구를 부르지 않고 `steps` 를 빈 목록으로 둔다. 단계 목록을 읽지 못한 항목도 `steps` 만 빈 목록으로 두고 넘긴다. 항목을 통째로 빼지 않는다.
8. `judgeAdvance` 를 부른다.

### 4. `skills/orch/scripts/board/auto-check.ts` 신규, `skills/orch/scripts/lib/commands.ts` 수정

```text
사용법: auto-check.ts <항목 id> [--repo DIR] [--run ID] [--board FILE]
```

- 머리 주석에 사용법, 확인 순서, 출력, 종료 코드를 적는다(`skills/orch/scripts/board/goal-progress.ts` 머리 주석의 꼴).
- 통과: stdout 첫 줄 `AUTO-OK <항목> <번호> <근거 글>`, 종료 코드 0.
- 거절: stdout 첫 줄 `AUTO-REJECT <항목> <번호 또는 -> <이유>`, 종료 코드 1.
- 항목 id 가 없거나 둘 이상이면 stderr 에 사용법, 종료 코드 2. `ConfigError` 는 stderr 에 그 글, 종료 코드 2.
- 보드나 단계 목록을 읽지 못한 `Error` 는 stderr 에 `auto-check: <글>`, 종료 코드 1 이고 stdout 은 비운다. 판정 줄을 내지 않는다.
- 판정 줄은 `emit` 으로 낸다. 그 뒤에 `emit` 으로 단계 글 한 줄(`단계: <글>`)과 근거마다 한 줄(`근거: <text> 통과` 또는 `근거: <text> <문제>`)을 낸다. 통과면 `안내: 지시서에 「보드 항목 id: <항목>」 줄을 적고 띄운다` 한 줄을 더 낸다. 이 줄들은 짧은 출력(진입점 `orch board auto-check`)에서 버려지고 `--full` 이나 경로로 직접 부를 때만 보인다.
- 저장소 폴더(`repo`)는 `--repo` 가 있으면 그 폴더, 없으면 `mainCheckout(현재 폴더)` 다. 워크트리 안에서 `--repo` 없이 불러도 주 checkout 의 보드를 본다. 보드는 `boardPath(repo, --board)` 로 찾고, 상대경로 근거와 orch 상태 폴더는 늘 `mainCheckout(repo)` 기준이다.
- `commands.ts` 의 board 묶음에 행을 더한다: `{ group: 'board', verb: 'auto-check', script: 'board/auto-check.ts', context: ['repo', 'run'], usage: 'orch board auto-check <항목>' }`. 옛 이름(`legacy`)은 두지 않는다.

### 5. 이 phase 를 검증하는 테스트

`skills/orch/tests/board-auto-check.spec.ts` 신규. 임시 폴더를 git 저장소로 만들고(`git init`), `.omc/board.json` 과 근거 파일을 쓰고, 가짜 `orca`(Run `R` 의 worker 목록)와 가짜 `gh`(열린 PR 목록)를 둔 뒤 스크립트를 `--run R` 로 `spawnSync` 한다. 스크립트를 경로로 직접 부르면 설명 줄도 함께 나오므로 **stdout 의 첫 줄**을 단언한다.

- 통과: `2. [auto] PR4 (계획: docs/plan)` 이 첫 미완료이고 `docs/plan` 폴더가 있으며 worker 와 열린 PR 이 없으면 첫 줄이 `AUTO-OK a 2 계획: docs/plan` 이고 0.
- 스펙 근거: 확인 줄이 있는 스펙은 통과, 확인 줄이 없는 스펙은 `AUTO-REJECT a 2 스펙에 확인 줄이 없다` 와 1, 없는 파일은 `스펙 파일이 없다`.
- 절대경로 근거: 저장소 밖 임시 폴더의 계획을 절대경로로 적으면 통과한다.
- 기본 checkout 기준: 저장소에 커밋을 하나 만들고 `git worktree add` 로 연결 워크트리를 만든다. 계획 폴더는 주 checkout 에만 두고(커밋하지 않는다) 보드도 주 checkout 에 둔다. 워크트리를 `cwd` 로 불러도 통과한다. 주 checkout 의 계획 폴더를 지우면 `계획 파일이 없다` 다.
- 앞 사건: 같은 보드의 다른 항목에 끝난 `3. 머지 (#665 merge)` 줄이 있으면 `(앞 사건: #665 merge)` 가 통과하고, 그 줄이 끝나지 않았으면 `앞 사건이 끝나지 않았다`.
- 앞 사건, `merged-pr` 만 있는 항목: 다른 항목이 `{ merged-pr: 665, details: [{ text: '1. PR #665 구현', done: true }] }` 뿐이고(줄 끝 꼬리표도 `stages` 필드도 없다) 확인할 항목의 첫 미완료 단계가 `2. [auto] 후속 작업 (앞 사건: #665 merge)` 면 통과한다. 그 항목의 `merged-pr` 을 지우면 `앞 사건이 끝나지 않았다` 다.
- 근거 없음: `2. [auto] PR4` 는 `근거가 없다`.
- 진행 중: 가짜 `orca` 가 그 항목 worktree 의 열린 dispatch 를 답하면 `worker 나 열린 PR 이 있다`. 가짜 `gh` 가 항목의 `branch` 와 같은 head 의 열린 PR 을 답해도 같다. 띄운 기록이 함께 있어도 이 이유가 먼저 나온다.
- 확인 못 함: `--run` 을 주지 않고 등록된 Run 도 없으면 `worker 나 PR 을 확인하지 못했다`. 가짜 `orca` 가 실패로 답해도, 가짜 `gh` 가 0 이 아닌 코드로 끝나도 같다.
- 이미 띄움: `appendStepLaunch` 로 같은 항목과 단계 글을 남긴 뒤에는 `이미 한 번 띄웠다`. 그 줄 끝에 `(#700 merge)` 꼬리표를 붙여도 같은 단계로 보아 거절한다. 본문이 다르면 통과한다.
- 표시: 첫 미완료가 `[ask]`, `[wait]`, 표시 없음이면 `첫 미완료 단계가 [auto] 가 아니다`. `stages` 가 `merge=2` 인 항목의 `2. [auto] 머지` 도 같다. 앞 단계가 끝나지 않았으면 뒤의 `[auto]` 를 보지 않는다. 이 사례들에서 가짜 `orca` 가 불리지 않는다(부른 인자를 파일에 남겨 확인한다).
- next 에만 단계가 있는 항목의 `[auto]` 를 읽는다.
- 상태와 항목: `done` 항목은 `상태가 doing 이나 wait 가 아니다`, 없는 id 는 `AUTO-REJECT x - 항목이 없다`, 보드 파일이 없어도 `항목이 없다` 다.
- 깨진 보드: `board.json` 이 JSON 이 아니면 종료 코드 1 이고 stdout 이 비며 stderr 에 `보드를 읽지 못했다` 가 있다.
- 설정: `.orch/config.json` 의 `board.auto_advance` 가 `false` 면 `자동 진행이 꺼져 있다`, 문자열이면 종료 코드 2.
- 읽기만 한다: 통과 사례의 호출 앞뒤로 보드 파일의 바이트가 같고 `step-launches.jsonl` 이 생기지 않는다.
- 인자 없이 부르면 종료 코드 2.

`skills/orch/tests/lib-step-launches.spec.ts` 신규: 파일이 없을 때 `false`, 덧붙인 뒤 `true`, 깨진 줄이 섞여도 읽는다, 끝 줄바꿈이 없는 파일에 덧붙여도 줄이 나뉜다.

`skills/orch/tests/lib-commands.spec.ts` 수정: `resolveNew(['board', 'auto-check', 'a'])` 가 `board/auto-check.ts` 로 풀린다.

`skills/orch/tests/spec-lint.spec.ts` 는 고치지 않고 통과해야 한다(확인 줄 판정을 옮겼을 뿐이다).

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-auto-check.spec.ts skills/orch/tests/lib-step-launches.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/script-folders.spec.ts skills/orch/tests/orch-entry.spec.ts skills/orch/tests/lib-bundle.spec.ts
node scripts/run-tests.ts --tsc-only
```

두 명령 모두 종료 코드 0 이어야 한다. `lib-bundle.spec.ts` 는 새 진입 스크립트가 짧은 출력 신호 모듈에 닿는지 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/spec-confirm.ts` | 신규 |
| `skills/orch/scripts/spec/spec-lint.ts` | 수정 (확인 줄 판정과 줄 나누기를 새 파일에서 가져온다) |
| `skills/orch/scripts/lib/step-launches.ts` | 신규 |
| `skills/orch/scripts/lib/auto-advance.ts` | 신규 |
| `skills/orch/scripts/board/auto-check.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 (board 묶음에 `auto-check` 행) |
| `skills/orch/tests/board-auto-check.spec.ts` | 신규 |
| `skills/orch/tests/lib-step-launches.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 (새 행 사례) |
