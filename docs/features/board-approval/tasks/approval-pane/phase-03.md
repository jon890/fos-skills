# Phase 03. 보드 창의 승인 대기 상자, 버튼, 글칸

**Execution profile**: standard

## 목표

보드 창(`register.js`)이 승인 파일을 5초마다 읽어 「승인 대기」 상자와 상태 줄의 「승인 n」 을 그리고, 「승인」·「고쳐 달라」·「명령 채우기」 버튼과 글칸, real 두 번 누르기를 동작시킨다. 사용자가 채팅에 「진행해줘」 를 치지 않고 보드에서 답하게 하려는 것이다.

**범위 외**: 기록과 신호를 쓰는 코드(phase 01, 02). 창은 스크립트 `bin/approvals.ts` 를 부르기만 한다. 승인 파일을 직접 쓰지 않는다.

## 컨텍스트

**요구사항**: REQ2(예전 화면 버튼), REQ5, REQ6, REQ7, REQ8, REQ9

**근거 문서**: `docs/features/board-approval/spec.md`, `docs/features/board-approval/design.md` 「창이 부르는 스크립트」, 「버튼과 누른 사람 이벤트」, `extensions/work-board/references/behavior.md`

- 창 훅 모듈은 `extensions/work-board/hooks/register.js` 하나이고 TypeScript 와 `node:fs` 를 쓰지 못한다. 파일은 `$.fs.exists`, `$.fs.read` 로 읽고, 쓰는 일과 Orca 조회는 `$.process.run` 으로 스크립트를 불러 한다. 기존 `run($, argv, timeoutMs)` 가 종료 코드가 0 이 아니면 stderr 첫 줄을 오류로 던진다.
- 판정 규칙을 창에 두지 않는다. 지금 버전인지, 열려 있는지, worker 인지는 `press` 스크립트가 다시 확인한다. 창의 판정은 버튼을 그릴지 정하는 데만 쓴다.
- 순수 함수는 `export` 해서 `extensions/work-board/tests/*.spec.ts` 가 `register.js` 에서 직접 부른다(`version.spec.ts` 방식). 그리기는 `claude-code/testing` 의 `pane.test.ts` 방식으로 본다.
- 버튼 키는 `approval:<id>:<버전>:<approve|revise|fill>` 이다. 보드를 다시 읽어 버전이 바뀌면 키도 바뀐다.
- `ui.press` 이벤트에 `origin` 이 없을 수 있다(`behavior.md` 「네트워크 조회」). 훅과 `onPress` 가 받은 이벤트의 `origin?.kind` 를 읽고 없으면 `none` 을 `--origin` 으로 넘긴다. 이 값은 나중에 확인하려는 기록이고 버튼을 막는 조건으로 쓰지 않는다(설계 DECISION9).

## 의도 메모

- 승인 파일 경로는 orch 루트 규칙(`ORCH_DIR`, 저장소 밖 캐시 등)이 정하므로 창이 계산하지 않고 `bin/approvals.ts where` 로 한 번 받는다. `where` 를 못 불러도(옛 설치본 등) 상자와 「승인 n」 은 그리지 않고 오류로 보이지 않는다. 파일이 있는데 JSON 으로 읽지 못할 때만 상자 자리에 「승인 대기를 읽지 못했어요」 를 흐리게 보인다.
- 미리보기는 링크가 아니라 「미리보기 열기」 버튼과 흐린 경로로 보인다. 터미널 링크(OSC 8 `file://`)가 로컬 파일을 여는지는 터미널마다 다르고 이 PR 에서 모든 터미널을 재지 못한다. 버튼은 `sh -c 'open "$1" || xdg-open "$1"'` 로 연다. 설계의 「링크를 먼저 시도하고 안 되면 버튼」 을 「버튼」 으로 정한다(설계를 같은 커밋에서 고친다).
- 「한 번 worker 로 본 터미널은 그 세션 동안 worker 로 둔다」(설계). `self --live` 가 한 번 `true` 를 내면 이후 `false` 로 바뀌어도 버튼을 그리지 않는다.
- 버튼에 단축키를 붙이지 않는다. 숫자와 알파벳 단축키는 이미 알림과 확인 모드가 쓴다.

## 작업 항목

### 1. 순수 함수 (`register.js` 에 export)

- `parseApprovals(source)`: 승인 파일 글 → `{ open: Entry[] } | { error }`. `entries` 중 `state === 'open'` 만 `version` 오름차순으로 낸다. 빈 글은 `{ open: [] }`. 꼴이 틀리면 `{ error }`.
- `approvalWait(createdAt, now)` → `{ text: 'N분'|'N시간'|'N일', old: boolean }`(24시간 넘으면 `old`). 본문은 `bin/worker-marks.ts` 의 시간 꼴(60분부터 시간, 하루부터 일)과 같다.
- `approvalKey(entry, action)` → `approval:<id>:<버전>:<approve|revise|fill>`.
- `approvalControls(entry, self, selfTerminalMatches)` → `'press' | 'fill' | 'guide' | 'text'`: `command` 이고 `self.terminal` 이 `entry.terminal` 과 같으면 `fill`, `command` 인데 다르면 `text`(명령 글만). 그 밖의 종류는 `self` 를 아직 읽지 못했거나 `worker` 가 `true`·`null` 이면 `guide`(「코디네이터 창이나 다른 창에서 누르세요」), `worker === false` 면 `press`.
- `approvalArgv(pluginRoot, repo, entry, action, note, origin)` → `['node', '--disable-warning=ExperimentalWarning', <root>/extensions/work-board/bin/approvals.ts, 'press', id, String(버전), action, '--origin', origin, '--repo', repo, ...(note ? ['--note=' + note] : [])]`.
- `armedState(armed, key, now)` → `'idle' | 'armed'`: `armed.key === key` 이고 `now < armed.until` 일 때만 `armed`.
- `pressToast(reason)`: 이유가 「내용이 바뀌었어요」 면 「내용이 바뀌었어요. 새 미리보기를 확인하세요」, 그 밖에는 이유 그대로.
- `statusLine(items, state, inboxState, freshness, approvalCount)`: 다섯째 인자가 0 보다 크면 「승인 n」 을 알림 다음, 결정 필요 앞에 붙인다. 없으면 그대로(기존 호출과 호환).

### 2. 읽기와 상태 (`register.js`)

- 모듈 값: `approvals = { open: [], error: '', path: '' }`, `approvalSelf = { known: false, terminal: null, worker: null }`, `approvalOrigin = 'none'`, `armed = null`, `reviseKey = ''`, `reviseText = ''`, `pressing = new Set()`.
- `loadApprovals($)`: `path` 가 비어 있으면 `bin/approvals.ts where --repo <주 checkout>` 을 불러 채운다(실패하면 조용히 끝). 파일이 있으면 읽어 `parseApprovals`. 읽은 뒤 `refreshStatus($)`. `session.start`, `command.run`, 5초 주기(`FILE_MS`)에서 부른다.
- `loadApprovalSelf($, live)`: `bin/approvals.ts self`(live 면 `--live`)의 JSON 을 읽어 `approvalSelf` 를 채운다. 한 번 `worker: true` 였으면 `true` 를 유지한다. 실패하면 `worker: null`. 세션 시작에 전체로 한 번, 그 뒤 60초마다 `--live`. 시작을 막지 않는다(`void`).
- `refreshStatus` 가 `statusLine` 의 다섯째 인자로 열린 대기 수를 넘긴다.
- `recordInput` 과 별개로 `ui.press`, `ui.input` 훅이 `approvalOrigin = e.origin?.kind ?? 'none'` 을 남기고 기존 `recordInput` 을 부른다.

### 3. 그리기 (`ui.render` 의 Pane 훅)

- 「승인 대기  n」 상자(`box`, key `approvals`)를 결정 필요 상자 바로 위에 그린다. 열린 대기가 없고 `error` 도 없으면 상자를 그리지 않는다. `error` 가 있으면 상자 자리에 흐린 줄 「승인 대기를 읽지 못했어요: …」.
- 대기마다 한 Box(key `approval-<id>`): 제목(굵게)과 종류 글(`post` 글 등록, `spec` 스펙 확인, `step` 단계 진행 허락, `real` real 쓰기(빨강), `command` 직접 실행), 올린 시각 `HH:MM` 과 기다린 시간(24시간 넘으면 노랑), `then` 이 있으면 「승인하면: …」 흐리게, 미리보기가 있으면 「미리보기 열기」 버튼과 흐린 경로, 보드 항목이 있으면 `<항목> <단계>` 흐리게.
- `real`: 대상 환경, 바꿀 것, 되돌리는 법을 빨간 줄 셋으로 그린다.
- `approvalControls` 결과에 따라: `press` → 「승인」, 「고쳐 달라」 버튼 둘. `fill` → `! <명령>` 글과 「명령 채우기」 버튼 하나. `text` → 명령 글만(`! <명령>` 흐리게)과 「올린 코디네이터 창에서 눌러요」. `guide` → 흐린 줄 「코디네이터 창이나 다른 창에서 누르세요」.
- 「고쳐 달라」 를 누르면 `reviseKey` 를 그 대기의 키로 두고 그 자리에 `Input`(key `approval-note:<id>:<버전>`, label 「고칠 내용」, placeholder 「무엇을 고칠지 적으세요」, submitLabel 「보내기」, rows 3, autoFocus)을 그린다. 다시 그릴 때 그 키의 대기가 없어지면(버전이 바뀌거나 닫힘) 글칸을 닫는다.

### 4. 누르기

- 「승인」: `real` 이 아니면 바로 `pressApproval`. `real` 이면 첫 누름은 `armed = { key, until: now + 10000 }` 만 남기고 toast 「real 에 씁니다. 한 번 더 누르세요」, 대기 줄에 빨간 글 「real 에 씁니다. 10초 안에 한 번 더 누르세요」를 보인다. 기한 안에 같은 키를 다시 누르면 `pressApproval`. 지나면 처음 상태(`armedState`)다.
- 「고쳐 달라」 글칸의 `onSubmit(value)`: `value.trim()` 이 비면 아무것도 부르지 않고 글칸을 남긴다. 아니면 `pressApproval(entry, 'revise', value)`.
- 「명령 채우기」: `$.prompt.fill({ text: '! ' + command })` 와 toast. 기록도 신호도 쓰지 않는다. `fillPrompt` 를 재사용하지 않는다(그 toast 는 「요청문」 이다).
- `pressApproval($, entry, action, note)` 가 창에서 승인 기록을 쓰는 유일한 자리다. `pressing` 에 키가 있으면 무시한다. `run($, approvalArgv(...), PRESS_TIMEOUT_MS)` 를 부르고, 성공하면 그 대기를 `approvals.open` 에서 바로 빼고 toast(「승인했어요」, 「고쳐 달라를 보냈어요」)와 `loadApprovals`. 실패하면(`run` 이 던진 첫 줄) `pressToast` 로 toast 하고 상자는 그대로 둔다. 끝나면 `pressing`, `armed`, `reviseKey` 를 정리한다.
- 「미리보기 열기」: `$.process.run(['sh', '-c', 'open "$1" 2>/dev/null || xdg-open "$1"', 'sh', path])`. 실패하면 toast.

### 5. 테스트

- `extensions/work-board/tests/approvals-pane.spec.ts` 신규(순수 함수): `parseApprovals`(열린 것만, 정렬, 빈 글, 깨진 글), `approvalWait`(59분, 61분, 25시간 노랑, 2일), `approvalKey`, `approvalControls`(worker 아님 `press`, worker `guide`, 모름 `guide`, 올린 터미널의 command `fill`, 다른 터미널의 command `text`), `approvalArgv`(인자 순서, `--note=` 에 `-` 로 시작하는 글), `armedState`(10초 경계), `pressToast`, `statusLine` 의 「승인 n」(알림과 결정 필요 사이, 0 이면 없음, 다섯째 인자 없는 기존 호출 그대로).
- `extensions/work-board/tests/approvals-pane.test.ts` 신규(`claude-code/testing`): 파일이 가짜 `fs.read`/`fs.exists` 로 열린 대기 둘을 줄 때 → 상자 머리 「승인 대기  2」, 상태 줄 「승인 2」, 열린 대기가 없으면 둘 다 없음. `self` 가 worker 가 아니면 「승인」·「고쳐 달라」 버튼이 있고 worker 면 없고 안내 줄만 있다. 「승인」 을 누르면 가짜 `process.run` 이 `approvals.ts press <id> <버전> approve` 인자로 불리고(`--origin` 포함) 성공이면 상자에서 빠진다. 가짜 `process.run` 이 「내용이 바뀌었어요」 로 실패하면 toast 문구가 스펙 문구이고 상자가 그대로다. `real` 은 첫 누름에 `press` 가 불리지 않고 둘째 누름에 불린다. 고쳐 달라 글칸이 빈 글이면 `press` 가 불리지 않고 글을 적으면 `--note=<글>` 로 불린다. `command` 대기는 올린 터미널이면 `prompt.fill` 이 `! <명령>` 으로 불리고 `process.run` 은 `press` 를 부르지 않는다. 다른 터미널이면 버튼이 없다.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/approvals-pane.spec.ts extensions/work-board/tests/version.spec.ts extensions/work-board/tests/decision-box.spec.ts
claude plugin test .
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/hooks/register.js` | 수정 (승인 읽기, 상자, 버튼, 글칸, 상태 줄) |
| `extensions/work-board/tests/approvals-pane.spec.ts` | 신규 |
| `extensions/work-board/tests/approvals-pane.test.ts` | 신규 |
