# Phase 06. 창이 제목 앞에 업무 칩을 그린다

**Execution profile**: standard

## 목표

work-board 창이 모든 항목 줄의 제목 앞에 `[<도구 이름> <번호>]` 칩을 그린다. 주소가 있으면 링크, 번호만 있으면 흐린 글자, 주소만 있으면 `[<도구 이름>]` 링크다. 제목 안의 `#342` 는 더는 링크가 아니다.

**범위 외**: 보드 칸과 자동 채우기(phase 02~05).

## 컨텍스트

**요구사항**: REQ2, REQ8(창 문서 몫)

**근거 문서**: `docs/features/board-task-link/spec.md` REQ2·DECISION1·DECISION2·DECISION14·DECISION15·DECISION22·DECISION23, `docs/features/board-task-link/design.md` 「창」, 설계 DECISION4·DECISION8

- `extensions/work-board/hooks/register.js`: `taskTag(url)`(49행), `splitTaskNumber(title)`(68행), 렌더 안의 `tagged`·`prLink`·`titleChildren`(1735-1750행 근처), 머리 줄 `headChildren`(1810행 근처), 항목 `itemView`. 결정 줄도 `decideRows.map((item) => itemView(item, SECTIONS[1]))` 로 같은 `itemView` 를 쓴다.
- 창은 TypeScript 와 `node:fs` 를 import 하지 못해 `extensions/work-board/bin/*.ts` 를 `run($, ['node', '--disable-warning=ExperimentalWarning', <경로>, ...])` 로 부르고 출력만 읽는다. 저장소가 바뀔 때 한 번 받는 꼴은 `loadApprovals` 의 `approvals.ts where`(1515행 근처)다. 저장소는 `boardRoot($)` 다.
- `bin/merge-queue.ts` 와 `bin/worker-marks.ts` 가 orch 의 `skills/orch/scripts/lib/*.ts` 를 import 하는 꼴을 따른다.
- 창 테스트는 `extensions/work-board/tests/pane.test.ts`(`claude plugin test .` 가 돈다)다. 180-202행과 600-615행 근처의 두 사례가 지금의 제목 안 링크(`[두레이 #342]`)와 「Button 안 표시+제목 앞부분」 을 본다. `start($, on, processResult, board)` 의 `processResult` 가 bin 호출의 결과를 정한다.
- 도구 이름은 phase 01 의 `taskAdapter(repo)`(`skills/orch/scripts/lib/task-adapters.ts`)가 정한다.

## 의도 메모

- 창은 설정 파일 위치를 계산하지 않는다(설계 DECISION4). 이름을 못 받으면 지금 규칙(호스트로 「두레이」, 「업무」)으로 그린다.
- 표시를 버튼 밖으로 꺼내고 버튼에는 제목만 둔다. 칩이 없는 항목도 같다(설계 DECISION8). 제목을 누르는 동작은 그대로다.

## 작업 항목

### 1. `extensions/work-board/bin/task-tool.ts`(신규)

`task-tool.ts --repo <폴더>` 는 `taskAdapter(repo)` 로 읽고 stdout 에 `{"name": <이름 또는 null>, "error": null}` 한 줄을 낸다. `ConfigError` 면 `{"name": null, "error": "<이유>"}` 이고 종료 코드는 둘 다 0 이다. `--repo` 가 없으면 사용법 오류(2)다. 파일 맨 위 설명에 부르는 곳(창)과 출력 꼴을 적는다.

### 2. `extensions/work-board/hooks/register.js`

- `splitTaskNumber` 를 지운다.
- `taskChip(item, tool)` 를 내보낸다. `ref = typeof item['task-ref'] === 'string' && item['task-ref'] ? item['task-ref'] : ''`, `url = typeof item.task === 'string' && /^https?:\/\//.test(item.task) ? item.task : ''`. 둘 다 없으면 `null`. 이름은 `tool && tool.name || (url ? taskTag(url) : '업무')`. `{ tag: 이름, label: ref, href: url }` 를 돌려준다.
- 모듈 상태 `taskTool = { root: '', name: null }` 를 두고, 보드 저장소가 바뀌거나 `/board` 를 열 때 `bin/task-tool.ts --repo <root>` 를 한 번 부른다. 실패하거나 JSON 이 아니면 `name` 은 `null` 이다.
- 렌더: `titleChildren` 을 지우고 `chipOf(item)` 가 `taskChip(item, taskTool)` 로 `tagged('task', tag, href, label)` 를 만든다. `tagged` 는 주소가 없으면 지금처럼 링크 없는 글자를 그리는데, 칩일 때는 `dimColor: true` 로 흐리게 그린다. 완료 줄의 칩은 취소선 없이 흐리게 그리고 링크와 색은 그대로 둔다.
- `headChildren`: 표시 `Text`, 칩(있으면), 제목 순서다. 완료·누를 수 없는 항목은 제목 `Text`, 진행 중·대기 항목은 제목만 담은 `Button`(`key: 'check-' + item.id`, `onPress` 는 그대로)이다. 머리 줄 `Box` 의 `columnGap` 은 1 로 둔다. 제목 글은 바꾸지 않고 `item.title || item.id` 그대로다.
- 렌더 위 주석(「Button 의 자식은 문자열과 Text 만 받으므로 …」)과 파일 맨 위 설명의 링크 문단을 새 꼴로 고친다.

### 3. `extensions/work-board/tests/pane.test.ts`

- 180-202행 근처 사례: 항목 `t` 에 `task-ref: 'P/342'` 를 더하고 칩 `[두레이 P/342]` 링크가 `task` 주소로 열리는지, 제목 `#342 감지상황 잇기` 의 `#342` 가 링크가 아닌지 본다. `#343 주소 없는 업무` 항목은 칩이 없다.
- 600-615행 근처 사례를 「칩은 버튼 밖, 표시와 제목 사이에 있고 버튼에는 제목만 있다」 로 바꾼다. 머리 줄 자식이 표시 `Text`, `Link`, `Button`(글 `배포 #342 정리`) 순서다.
- 528-530행(`expect(textOf(head)).toBe('▶ 단계 항목')`)과 563-564행(`'◇ 기획 답을 기다리는 항목'`)은 `Button check-<id>` 의 글을 표시와 함께 단언한다. 표시가 버튼 밖으로 나오므로 버튼 글은 제목만(`단계 항목`, `기획 답을 기다리는 항목`)이고, 표시는 머리 줄의 첫 `Text` 로 따로 단언한다. 같은 꼴로 `check-` 버튼 글을 단언하는 다른 사례가 있으면 함께 고친다(`git grep -n "check-" extensions/work-board/tests/`).
- 더할 사례: 번호만 있는 항목은 흐린 `Text` 칩(`dimColor`), 주소만 있는 항목은 `[두레이]` 링크, 둘 다 없으면 칩 없음. `processResult` 가 `task-tool.ts` 에 `{"name":"Jira","error":null}` 를 주면 `[Jira PROJ-1]` 이다. 결정 항목(`status: 'decide'`) 줄과 완료 항목 줄에도 칩이 있다. 진행 중 항목의 제목 버튼을 누르면 지금처럼 상태 확인 요청문이 채워진다.

### 4. `extensions/work-board/tests/task-tool.spec.ts`(신규)

임시 저장소의 `.orch/config.json` 세 경우(없음 → `name: null`, `dooray` → `두레이`, 모르는 어댑터 → `name: null` 과 `error`)와 `--repo` 없음(종료 코드 2)을 본다.

### 5. 문서와 조각

- `extensions/work-board/references/behavior.md` 59행의 링크 문단을 고친다. 업무 칩은 제목 앞, 표시 다음에 있고 글은 `[<도구 이름> <번호>]`(번호가 없으면 `[<도구 이름>]`), 주소가 있으면 링크, 없으면 흐린 글자다. 도구 이름은 orch 설정 `board.task` 의 어댑터가 정하고 없으면 주소의 호스트(두레이 주소면 「두레이」, 그 밖은 「업무」), 주소도 없으면 「업무」 다. 제목 안의 `#342` 는 링크로 그리지 않는다. 칸은 `orch board set <id> --task <주소> --task-ref <번호>` 로 넣는다.
- `extensions/work-board/changes/board-task-link.minor.md` 에 「창이 제목 앞에 업무 칩을 그린다. 제목 안 업무 번호 링크는 칩으로 대신한다」 줄을 더한다.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/task-tool.spec.ts extensions/work-board/tests/prompts.spec.ts
node scripts/run-tests.ts --tsc-only
claude plugin test .
```

기대값: 모두 통과. `claude plugin test .` 가 `pane.test.ts` 를 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/bin/task-tool.ts` | 신규 |
| `extensions/work-board/hooks/register.js` | 수정 (taskChip, 머리 줄) |
| `extensions/work-board/tests/pane.test.ts` | 수정 |
| `extensions/work-board/tests/task-tool.spec.ts` | 신규 |
| `extensions/work-board/references/behavior.md` | 수정 (링크 문단) |
| `extensions/work-board/changes/board-task-link.minor.md` | 수정 |
