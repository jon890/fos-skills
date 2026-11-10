# Phase 03. 단계 글 바꾸기(`step-edit`), 단계 더하기(`step-add`), 줄 끝 꼬리표(`--event`)

**Execution profile**: standard

## 목표

`board.ts` 가 단계 번호로 줄 글을 바꾸는 동작과 번호를 붙여 단계를 더하는 동작을 받고, 두 동작이 줄 끝 사건 꼬리표를 붙이거나 바꾼다. 코디네이터가 `mark` 번호를 세거나 줄 전체를 통째로 다시 쓰지 않고 단계를 고치게 하려는 것이다.

**범위 외**: orch 의 `orch board step … text`, `add-step`, `--on` 은 뒤 PR 이 이 동작을 부르게 만든다. 자동 진행 표시(`[auto]` 따위)를 바꾸는 동작은 만들지 않는다. `detail-edit`, `detail-add` 의 동작은 바꾸지 않는다.

## 컨텍스트

**요구사항**: REQ4, REQ5, REQ6, REQ13

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md` 의 「`board.ts` 에 더하는 것 (PR1)」

- `extensions/work-board/hooks/event-tags.js` 가 단계 줄 정규식 `STEP`(`/^\s*(?:(✓|\[[xX ]\]|▶|◇)\s*)?(\d+)[.)]?\s/`)과 줄 끝 꼬리표 정규식 `EVENT_TAG`(모듈 안, `(#665 merge)` 꼴), `parseEventTag(text)`, `hideEventTag(text)` 를 갖는다. 창(`hooks/register.js`)과 `board.ts` 가 함께 import 한다.
- 줄 앞 사건 꼬리표는 번호 바로 뒤의 `[pr]`, `[merge]`, `[deploy]`, `[release]` 다(`2. [merge] 머지`). 사람이 직접 쓴 줄에만 있다. orch 의 띄우기가 만드는 줄은 꼬리표 없이 `2. 머지` 로 쓰고 사건과 단계 번호의 짝을 항목의 `stages` 값(`pr=1,merge=2`)에 둔다(`skills/orch/scripts/core/milestones.ts` 의 `milestoneLines`). 지금 줄 글에서 줄 앞 꼬리표를 읽는 함수는 work-board 쪽에 없다.
- `board.ts` 의 `normalizeLine(글)` 은 앞 표시(`✓`, `[x]`, `[ ]`, `▶`, `◇`)를 떼고 `{text, done}` 을 돌려준다. `LEAD_MARK.test(글)` 로 앞 표시가 있었는지 안다. `detail-edit` 가 「앞 표시가 없으면 끝냄 값은 그대로」 를 이 방식으로 한다.
- phase 02 가 만든 것: `findStep(item, id, number)`(없는 번호와 같은 번호 둘을 거절), `itemView`, 결과 JSON 을 `renameSync` 뒤에 내는 길, `PROGRESS` 정규식(지금 있다).
- 위치 인자 개수는 `parse` 의 `limit` 이 정한다(`detail-edit` 만 4, 나머지 3). `Args` 의 `status` 가 둘째 위치 인자, `text` 가 셋째다.

## 의도 메모

- 새 동작은 늘 엄격하다. `--exact` 를 따로 받지 않는다.
- 꼬리표를 지우는 글은 거절한다. 꼬리표가 조용히 사라지면 그 줄이 사건으로 끝나지 않는다(스펙 DECISION13). 사건이나 PR 번호를 다른 값으로 바꾸는 것은 받는다. 잘못 붙인 번호를 고칠 수 있어야 한다.
- `step-edit` 는 항목 상태를 바꾸지 않는다. 앞 표시로 마지막 줄이 끝나도 `decide` 를 `done` 으로 바꾸지 않는다. 상태 전환은 `step` 과 `mark` 의 일이다.
- 옵션 이름은 `--event` 다. `--on` 은 `--o`(`--owner`)의 줄임 꼴을 모호하게 만든다.

## 작업 항목

### 1. `extensions/work-board/hooks/event-tags.js` 에 함수를 더한다

```js
export const EVENTS = ['pr', 'merge', 'deploy', 'release']
// 줄 앞 사건 꼬리표. `2. [merge] 머지` 면 'merge', 없거나 단계 줄이 아니면 null. 대소문자를 가리지 않고 소문자로 돌려준다
export function stageTag(text)
// 줄 끝 꼬리표를 붙인 글. 이미 `(#N 사건)` 이 있으면 떼고 붙인다. 글 끝의 공백은 지운다
export function withEventTag(text, pr, event)
```

- `stageTag` 는 `STEP` 이 맞은 자리 바로 뒤가 `[낱말]` 이고 그 낱말이 `EVENTS` 에 있을 때만 값을 돌려준다(`[auto]`, `[x]` 는 `null`).
- `withEventTag('3. 머지 (#1 pr)', '1455', 'merge')` 는 `'3. 머지 (#1455 merge)'` 다.
- 기존 내보내기(`STEP`, `parseEventTag`, `hideEventTag`)는 그대로 둔다.

### 2. `board.ts` 의 옵션과 동작 이름

- `COMMANDS` 와 `USAGE` 의 목록에 `step-edit`, `step-add` 를 `view` 앞에 더한다(목록의 앞부분 `set,detail-edit,detail-add,step,steps,mark,del,list` 는 그대로).
- `parse` 의 위치 인자 한도: `step-edit` 는 `detail-edit` 처럼 4 다.
- 옵션 `event`(string)를 더한다. `step-edit`, `step-add` 가 아닌 동작에 주면 사용법 오류(종료 코드 2)다. `--exact`, `--if-rev` 를 두 동작에 주는 것도 사용법 오류다.
- `--event` 값은 `/^\s*#?([1-9]\d*)\s+(pr|merge|deploy|release)\s*$/` 로 읽는다. PR 번호 `0` 과 `0` 으로 시작하는 번호는 맞지 않는다(`parseEventTag` 가 그 번호를 읽지 못한다). 맞지 않으면 `` Refused(`--event 는 "<PR 번호> <사건>" 이다. 사건은 pr, merge, deploy, release 다: ${값}`) `` 로 종료 코드 1 이다(스펙 REQ6 이 1 로 정했다). 보드를 읽은 뒤 `apply` 안에서 판정해도 되고 그 앞에서 해도 되지만 보드 파일은 바뀌지 않아야 한다.

### 3. `step-edit <id> <번호> <글> [--event "<PR> <사건>"]`

`apply` 에 분기를 더한다. 순서대로 본다.

1. 항목이 없으면 `Refused('항목이 없다: <id>')`.
2. 번호 자리가 숫자가 아니면 `Refused('step-edit 에는 단계 번호가 필요하다: board.ts step-edit <id> <번호> <글>')`. 글이 비었으면(공백뿐 포함) `Refused('step-edit 에는 새 글이 필요하다: …')`.
3. `findStep` 으로 줄을 찾는다(없는 번호, 같은 번호 둘은 그 함수가 거절한다).
4. `const fresh = normalizeLine(글)`. `STEP.exec(fresh.text)` 가 맞지 않거나 읽은 번호가 다르면 `` Refused(`새 글은 ${번호} 번으로 시작해야 한다: ${fresh.text}`) ``. `9.머지` 처럼 번호 뒤에 공백이 없는 글은 단계 줄이 아니라 여기서 거절된다.
5. `--event` 가 있으면 `fresh.text = withEventTag(fresh.text, pr, 사건)`.
6. 옛 줄의 `stageTag` 가 있는데 새 글의 `stageTag` 가 없으면 `` Refused(`${번호} 번 줄의 사건 꼬리표를 지우는 글이다. 꼬리표를 지우려면 detail-edit 를 쓴다`) ``. 옛 줄의 `parseEventTag` 가 있는데 새 글의 `parseEventTag` 가 없을 때도 같은 문구로 거절한다.
7. 끝냄 값은 `LEAD_MARK.test(글)` 이 참이면 `fresh.done`, 아니면 옛 줄의 값이다.
8. 그 자리의 줄을 `{text: fresh.text, done}` 으로 바꾸고 `item[source]` 에 넣는다. 항목 상태는 건드리지 않는다.
9. 결과 JSON(`itemView`)에 `number` 를 넣어 낸다.

### 4. `step-add <id> <글> [--event "<PR> <사건>"]`

글은 `detail-add` 처럼 둘째 위치 인자(`a.status`)다.

1. 항목이 없으면 `Refused('항목이 없다: <id>')`. 글이 비었으면 `Refused('step-add 에는 더할 글이 필요하다: board.ts step-add <id> <글>')`.
2. `item.status === 'done'` 이면 `` Refused(`done 항목에는 단계를 더하지 않는다: ${id}. 다시 열려면 먼저 set ${id} doing 을 부른다`) ``.
3. `const [source] = stepSource(item)`, `const key = source ?? 'details'`. 그쪽의 단계 번호들을 `parseStep` 으로 모은다.
4. `const fresh = normalizeLine(글)`(앞 표시는 뗀다). `STEP.exec(fresh.text)` 가 맞으면 그 번호를 쓰고, 이미 있는 번호면 `` Refused(`${번호} 번 단계가 이미 있다. 있는 번호: …`) ``. 맞지 않으면 번호는 가장 큰 번호에 1 을 더한 값(단계가 없으면 1)이고 글은 `` `${번호}. ${fresh.text}` `` 다.
5. `--event` 가 있으면 `withEventTag` 로 붙인다.
6. `item[key]` 의 끝에 `{text, done: false}` 를 더한다. `item[key]` 가 없으면 새 목록으로 만든다.
7. `PROGRESS.test(String(item.progress || ''))` 가 참이면 stderr 에 `` `${id} 의 progress 값이 단계 수보다 앞서 새 줄이 진행률에 안 보인다. 단계로 세려면 set ${id} --progress auto 를 부른다` `` 한 줄을 낸다. 종료 코드는 0 이다.
8. 결과 JSON 에 `number` 를 넣어 낸다.

### 5. `stages` 가 있는 항목에 줄 끝 꼬리표가 생길 때의 알림

`step-edit` 와 `step-add` 가 반영한 줄에 줄 끝 꼬리표가 있고(`parseEventTag` 가 읽는다. `--event` 로 붙였든 새 글에 직접 썼든 같다) 항목에 `stages` 값(비지 않은 문자열)이 있으면, 반영한 뒤 stderr 에 한 줄을 낸다. 종료 코드는 0 이다.

`` `${id} 는 stages 가 있는 항목이다. 줄 끝 꼬리표가 생기면 꼬리표 줄만 사건으로 끝나고 stages 의 단계는 저절로 끝나지 않는다` ``

줄 끝 꼬리표가 하나라도 있으면 orch 의 `board-sync` 와 마무리가 그 항목을 꼬리표 항목으로만 다루기 때문이다(`skills/orch/references/board.md` 「직접 작성한 사건 단계」).

### 6. 문서

- `board.ts` 파일 맨 위 설명과 `HELP` 의 「사용」 목록에 `step-edit`, `step-add`, `--event` 를 더한다. 거절하는 경우(번호가 다른 글, 꼬리표를 지우는 글, 이미 있는 번호, `done` 항목)를 한 줄씩 적는다.
- `extensions/work-board/references/behavior.md` 의 「단계 끝내기」 항목 아래에 항목을 더한다: 잠금(파일 위치, 5초와 30초, 읽기는 잠그지 않음, 갱신 전에 띄운 루프는 옛 `board.ts` 로 잠금 없이 쓰므로 doctor 의 `LOOP-STALE` 안내대로 다시 띄운다), 엄격 호출과 결과 JSON, `view`, `step-edit` 와 `step-add`, 낡은 목록 거절(`--if-rev` 와 `linesRev`). 결정의 이유는 적지 않고 `docs/adr/029-board-write-lock.md` 를 가리킨다.
- `extensions/work-board/changes/board-lock-step-edit.minor.md` 를 새로 만든다. `- ` 줄로 쓴다: 쓰는 동작이 파일 잠금을 지킨다(못 잡으면 종료 코드 1), `--exact` 와 결과 JSON, `view`, `step-edit` 와 `step-add` 와 `--event`, `set --if-rev`.

### 7. `extensions/work-board/tests/board-step-edit.spec.ts` 를 새로 만든다

`board-run.ts` 로 실행한다. 거절 사례마다 보드 파일의 바이트가 같은지 본다.

`step-edit`:

- 9번 줄이 있는 항목에 `step-edit a 9 '9. 머지 확인'` 은 그 줄의 글만 바꾸고 끝냄 값이 그대로다(끝난 줄과 끝나지 않은 줄 둘 다 본다). 다른 줄은 그대로다. JSON 의 `number` 가 9 다.
- `step-edit a 9 '10. 머지'` 와 `step-edit a 9 '9.머지'` 는 종료 코드 1 이다.
- `'✓ 9. 머지'` 는 그 줄을 끝낸 것으로 바꾼다. `decide` 항목의 마지막 줄을 이렇게 끝내도 상태는 `decide` 다.
- 줄 끝 꼬리표: `'9. 머지 (#1455 merge)'` 줄을 `'9. 머지 확인'` 으로 바꾸면 종료 코드 1 이다. `'9. 머지 확인 (#1456 merge)'` 로 바꾸면 종료 코드 0 이다. `'9. 머지 확인' --event '1456 deploy'` 도 종료 코드 0 이고 줄이 `9. 머지 확인 (#1456 deploy)` 다.
- 줄 앞 꼬리표: `'2. [merge] 머지'` 줄을 `'2. 머지'` 로 바꾸면 종료 코드 1, `'2. [merge] develop 머지'` 로 바꾸면 종료 코드 0 이다.
- 단계가 `next` 에만 있는 항목에서도 듣고 `next` 의 줄이 바뀐다.
- 없는 번호는 「있는 번호: …」 로, 같은 번호 줄이 둘이면 종료 코드 1 로 거절한다.

`step-add`:

- 단계가 1~9번인 항목에 `step-add a '리뷰 반영'` 은 `details` 끝에 `{text: '10. 리뷰 반영', done: false}` 를 더하고 JSON 의 `number` 가 10 이다.
- `step-add a '9. 중복'` 은 종료 코드 1 이다. `step-add a '12. 건너뛴 번호'` 는 종료 코드 0 이고 글이 그대로다.
- 단계가 `next` 에만 있으면 `next` 에 더한다. 단계가 어느 쪽에도 없으면 `details` 에 `1. …` 로 더한다(참고 줄만 있는 `details` 는 그 뒤에 붙는다).
- `done` 항목은 종료 코드 1 이다.
- `'✓ 정리'` 처럼 앞 표시를 줘도 끝나지 않은 줄이다.
- `--event '1455 merge'` 와 `--event '#1455 merge'` 는 둘 다 `N. 글 (#1455 merge)` 를 더한다. 그 줄을 `parseEventTag` 가 `{pr: '1455', event: 'merge'}` 로 읽는다. `--event '1455 build'`, `--event 'abc merge'`, `--event '1455'`, `--event '0 merge'` 는 종료 코드 1 이다.
- `stages` 가 `pr=1,merge=2` 이고 줄이 `1. PR`, `2. 머지`, `3. 확인` 인 항목에 `step-add a 글 --event '1455 merge'` 를 주면 종료 코드 0 이고 stderr 에 「stages」 가 든 한 줄이 나온다. 같은 항목에 `step-edit a 3 '3. 확인 (#1455 merge)'` 처럼 글에 직접 써도 나온다. 꼬리표 없는 글이나 `stages` 가 없는 항목은 그 줄이 없다.
- `progress` 값이 `2/5` 인 항목은 종료 코드 0 이고 stderr 에 「progress」 가 든 한 줄이 나온다. `progress` 가 없는 항목은 stderr 가 비어 있다.

공통:

- `set a wait --event '1 merge'` 와 `step-add a 글 --exact` 는 종료 코드 2 다.
- 저장 꼴: `step-add` 뒤 보드 파일의 글이 `JSON.stringify(JSON.parse(글), null, 1)` 과 같다(들여쓰기 한 칸, 끝 줄바꿈 없음).

### 8. `extensions/work-board/tests/event-tags.spec.ts` 에 사례를 더한다

- `stageTag`: `'2. [merge] 머지'` 는 `'merge'`, `'✓ 2. [Deploy] 배포'` 는 `'deploy'`, `'2. [auto] PR4'`, `'2. 머지'`, `'참고 [merge]'` 는 `null`.
- `withEventTag`: 꼬리표 없는 글에 붙이기, 있는 꼬리표 바꾸기, 붙인 글을 `parseEventTag` 가 읽고 `hideEventTag` 가 원래 글로 돌려주는지.

## 검증

```bash
node scripts/run-tests.ts extensions/work-board/tests/board-step-edit.spec.ts extensions/work-board/tests/event-tags.spec.ts extensions/work-board/tests/board-exact.spec.ts extensions/work-board/tests/board-lock.spec.ts extensions/work-board/tests/file-lock.spec.ts extensions/work-board/tests/board.spec.ts
git diff --exit-code origin/main -- extensions/work-board/tests/board.spec.ts
node scripts/run-tests.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/board-release.spec.ts skills/orch/tests/goal-progress.spec.ts skills/orch/tests/lib-board.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/launch-worker.spec.ts
node skills/orch/tests/fixtures/golden-run.ts
claude plugin test .
node scripts/run-tests.ts --tsc-only
node export-only-skills/korean-check/scripts/check.ts extensions/work-board/references/behavior.md extensions/work-board/changes/board-lock-step-edit.minor.md
```

- 셋째와 넷째 줄은 `board.ts` 를 부르는 orch 스크립트의 테스트와 고정 입력 기록이다. 이 계획은 orch 를 고치지 않으므로 고치지 않은 채 통과해야 한다. 실패하면 기존 호출의 호환이 깨진 것이다.
- `claude plugin test .` 는 창(`hooks/register.js`)이 `event-tags.js` 를 import 한 채 도는지 본다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `extensions/work-board/hooks/event-tags.js` | 수정 (`EVENTS`, `stageTag`, `withEventTag`) |
| `extensions/work-board/bin/board.ts` | 수정 (`step-edit`, `step-add`, `--event`, 설명과 HELP) |
| `extensions/work-board/tests/board-step-edit.spec.ts` | 신규 |
| `extensions/work-board/tests/event-tags.spec.ts` | 수정 (새 함수 사례) |
| `extensions/work-board/references/behavior.md` | 수정 (잠금과 새 동작) |
| `extensions/work-board/changes/board-lock-step-edit.minor.md` | 신규 |
