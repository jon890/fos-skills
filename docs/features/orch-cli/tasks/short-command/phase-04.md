# Phase 04. 새 꼴 `NEXT_WAIT`, 훅의 새 꼴 인식, 핸들러의 `ORCH_BIN`

**Execution profile**: deep

## 목표

`wait-important` 가 내는 `NEXT_WAIT` 를 `orch wait --ack <id> …` 꼴로 줄이고, 실행기와 진입점이 낀 프로세스 사슬에서도 고아 대기를 찾게 하고, 훅이 새 꼴(`orch wait`, `orch worker send`, `orch spec line`)을 알아보며, 이벤트 핸들러가 `ORCH_BIN` 으로 새 꼴을 부를 수 있게 한다.

**범위 외**: 대기의 짧은 출력과 원문 저장(PR2). 대기의 판정 규칙.

## 컨텍스트

**요구사항**: REQ4(`NEXT_WAIT` 부분)

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ4, DECISION19. `docs/features/orch-cli/design.md` 의 「NEXT_WAIT (PR1)」, 「프로세스 사슬」, 「핸들러 환경」, 결정 DECISION11·DECISION13·DECISION15, 「검증 전략」 의 훅과 고아 대기 항목.

- 지금 `skills/orch/scripts/wait-important.ts` 의 `nextWait()`(212줄 근처)는 `'<진입점>' wait-important --run … --types … --timeout-ms … --lost-interval-sec … --completion-contract … --lost-state …` 처럼 모든 값을 적는다. `ORCH_BIN` 상수(193줄)는 `../bin/orch.ts` 다. 상태 파일 기본값은 954줄의 `join(pathOf('state', cwd), 'wait-important-lost.json')` 이고 `cwd` 는 시작 폴더의 주 checkout 이다.
- phase 02 의 `skills/orch/scripts/lib/bundle.ts` 가 `orchContext()` 로 진입점이 채운 인자와 출처(예: `{ run: 'run-current' }`)를 돌려준다.
- 고아 대기 판정 `stalePids()`(`wait-important.ts` 680줄 근처)는 부모가 init 인 셸에서 셸(`SHELLS`)과 대기 행만 따라 내려간다. 새 꼴 사슬 `셸 → node bin/orch → node skills/orch/bin/orch.ts → node wait-important.ts` 에서 가운데 두 node 는 셸도 대기도 아니라 사슬이 끊긴다.
- 훅: `skills/orch/hooks/block-background-wait.ts` 의 `CHECK_WAIT` 정규식(18줄)이 `wait-important` 낱말을 본다. `block-worker-terminal-send.ts` 의 `SEND_TO_WORKER` 안내(87줄)와 거부 문구가 `$SKILL_DIR/scripts/send-to-worker.ts`, `nudge-worker`, `adopt-sessions` 를 안내한다. `require-spec-line.ts` 의 거부 문구(32줄)가 `spec-line.ts` 직접 경로를 안내한다.
- 핸들러 환경: `skills/orch/scripts/lib/events.ts` 의 `handlerEnv()`(225줄)가 `ORCH_SCRIPTS` 를 넣는다. 다른 저장소 핸들러가 쓰는 공개 계약이라 유지한다(`skills/orch/references/hooks.md`).

## 의도 메모

- `--run` 은 출처로만 정한다. `orchContext().run === 'run-current'` 일 때만 빼고, 명시했거나 설정에서 온 Run 은 값이 같아도 적는다(설계 「NEXT_WAIT」).
- `--loop-repo` 는 늘 절대경로로 적는다. 다시 걸 때의 작업 폴더가 지워진 워크트리일 수 있다(스펙 DECISION19).
- `--lost-state` 의 기본값은 바꾸지 않는다(설계 DECISION13). 기본값을 쓴 대기에서 시작 폴더의 주 checkout 이 첫 `--loop-repo` 의 주 checkout 과 같으면 `NEXT_WAIT` 에서 빼고, 다르거나 `--loop-repo` 가 없거나 명시했으면 절대경로로 적는다. 스펙 REQ4 의 기대값 `orch wait --ack <id> --loop-repo <저장소>` 가 이 규칙의 흔한 경우다.
- 앞 낱말은 `skills/orch/scripts/lib/commands.ts` 에 새로 둘 `orchWord(): string` 이다. PATH 의 `orch` 가 표지 주석 `fos-skills orch launcher` 가 있는 실행기면 `orch`, 아니면 진입점 절대경로를 셸 따옴표로 감싼 것이다. phase 05 의 안내 줄도 이것을 쓴다.

## 작업 항목

### 1. `skills/orch/scripts/wait-important.ts`

- `nextWait()` 를 `<앞> wait --ack <id> [기본값과 다른 인자] [--lost-state <절대경로>] --loop-repo <절대경로>...` 로 바꾼다. 기본값은 이 파일의 parseArgs `default` 값과 같은 원본을 쓴다(상수로 빼서 두 곳이 같은 값을 읽게 한다).
- `ack` 가 없으면 `--ack` 를 빼고, `--ignore-lost`, `--kill-stale`, `--stop-reports` 는 지금처럼 줄 때만 적는다.
- 머리 주석의 `NEXT_WAIT` 설명을 새 꼴로 고친다.
- `stalePids()` 가 명령줄의 첫 스크립트 인자가 `/bin/orch` 나 `/bin/orch.ts` 로 끝나는 node 행을 셸처럼 통과 노드로 본다. 대기 행을 세는 `waiterProcesses()` 와 `lib/waiters.ts` 는 바꾸지 않는다.

### 2. 훅

- `block-background-wait.ts`: `CHECK_WAIT` 가 `orch wait`(동작 없음 또는 `--` 로 시작하는 인자)와 진입점 절대경로 꼴 `orch.ts wait` 도 잡게 한다. `orch wait triage`, `orch wait ack-lost`, `orch wait user-active`, `orch wait questions` 는 대기가 아니므로 잡지 않는다. 판정은 phase 01 의 명령 표에서 `wait` 묶음의 동작 이름을 읽어 정한다(훅은 이미 `../scripts/lib` 를 import 한다). 거부 문구를 새 꼴로 고친다.
- `block-worker-terminal-send.ts`: 안내 문구를 `orch worker send --dispatch <id> --body …`, `orch worker nudge`, `orch worker adopt` 로 바꾼다.
- `require-spec-line.ts`: 안내를 `orch worker launch` 와 `--spec "$(orch spec line "$SPEC" --require-permission)"` 으로 바꾼다. `$` 가 든 값을 통과시키는 지금 규칙은 그대로다.

### 3. `skills/orch/scripts/lib/commands.ts` 의 `orchWord()`

PATH 를 훑어 첫 `orch` 파일의 앞 몇 줄에 표지가 있는지 본다. 결과는 프로세스 안에서 한 번만 계산한다.

### 4. `skills/orch/scripts/lib/events.ts`

`handlerEnv()` 에 `ORCH_BIN`(진입점 `skills/orch/bin/orch.ts` 절대경로)을 더한다. 머리 주석의 환경 변수 목록(56줄 근처)에 적는다. `skills/orch/references/hooks.md` 의 예시는 phase 06 이 고친다.

### 5. 테스트

- `skills/orch/tests/wait-important.spec.ts`: `NEXT_WAIT` 기대값(234줄 근처)을 새 꼴로 바꾼다. 모든 사례는 PATH 를 테스트가 정한 값으로 고정한다. 사례: 기본값만 쓰고 시작 폴더와 같은 저장소의 루프 저장소 하나일 때 `… wait --ack d1 --loop-repo <절대경로>`. 루프 저장소가 다른 저장소이거나, `--loop-repo` 가 없거나, `--lost-state` 를 명시하면 `--lost-state <절대경로>` 가 있다. 기본과 다른 `--types` 는 적는다. `ORCH_CONTEXT=run=run-current` 이면 `--run` 이 없고, `--run` 을 명시하면 있다. 표지 있는 가짜 `orch` 를 PATH 앞에 두면 앞 낱말이 `orch` 이고, 없으면 진입점 절대경로다. 상태 파일 기본값은 지금과 같다. 가짜 ps(`PS`)로 `1 → zsh → node …/bin/orch wait → node …/bin/orch.ts wait → node …/wait-important.ts --run R` 사슬을 보이면 `--kill-stale` 이 그 대기를 고아로 끝낸다(기존 고아 대기 테스트의 가짜 ps 를 넓힌다).
- `skills/orch/tests/block-background-wait.spec.ts`: `orch wait --ack x &`, `'<진입점>' wait &` 는 거부, `orch wait triage f &` 와 `orch wait ack-lost d &` 는 통과.
- `skills/orch/tests/coordinator-hooks.spec.ts`: 두 훅의 거부 문구에 새 꼴이 있다. 지금 거부 문구를 단언하는 사례(`git grep -n "send-to-worker\|spec-line" skills/orch/tests/coordinator-hooks.spec.ts`)의 기대값을 고친다.
- `skills/orch/tests/lib-events.spec.ts`: 핸들러 환경에 `ORCH_BIN` 이 있고 그 파일이 있다.
- `skills/orch/tests/lib-commands.spec.ts`: `orchWord()` 가 표지 있는 `orch` 가 PATH 에 있으면 `orch`, 표지 없는 `orch` 나 없음이면 진입점 경로다.

## 검증

```bash
node --test skills/orch/tests/lib-commands.spec.ts skills/orch/tests/wait-important.spec.ts skills/orch/tests/block-background-wait.spec.ts skills/orch/tests/coordinator-hooks.spec.ts skills/orch/tests/lib-events.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/wait-important.ts` | 수정 |
| `skills/orch/hooks/block-background-wait.ts` | 수정 |
| `skills/orch/hooks/block-worker-terminal-send.ts` | 수정 |
| `skills/orch/hooks/require-spec-line.ts` | 수정 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/scripts/lib/events.ts` | 수정 |
| `skills/orch/tests/wait-important.spec.ts` | 수정 |
| `skills/orch/tests/block-background-wait.spec.ts` | 수정 |
| `skills/orch/tests/coordinator-hooks.spec.ts` | 수정 |
| `skills/orch/tests/lib-events.spec.ts` | 수정 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
