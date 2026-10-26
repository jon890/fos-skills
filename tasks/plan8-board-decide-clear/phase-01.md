# Phase 01. 결정 줄을 끝내고 남은 줄만 센다

**Execution profile**: standard

## 목표

`board.ts` 에 줄 하나를 끝내는 `mark` 를 더하고, decide 항목의 줄이 모두 끝나면 done 으로 바꾼다. `list` 와 `steps` 가 번호 없는 줄과 완료 여부를 보인다.

**범위 외**: 창의 결정 필요 수와 worker 질문의 회신 판정(phase 02), orch 의 중간 과정(phase 03).

## 컨텍스트

- 보드 명령은 `work-board/bin/board.ts` 의 `apply` 가 명령마다 갈라 처리한다. 줄은 `{text, done}` 객체이고 `normalizeLines` 가 옛 문자열을 바꾼다.
- `step` 은 번호로 시작하는 단계 줄만 끝낸다(`stepSource`, `parseStep`). 모음 항목의 결정 줄은 번호가 없어 `step` 으로 끝낼 수 없다.
- `steps` 의 stdout JSON 은 `orch/scripts/board-sync.ts` 와 `orch/scripts/lib/board.ts` 의 `registerBoard` 가 읽는다. 형식을 바꾸지 않는다.

**근거 문서**: `docs/adr/015-board-decide-clear.md`, `docs/flow.md` 의 「운영 공백을 막는 곳」

## 의도 메모

- `step` 이 번호 없는 줄을 끝내게 하지 않는다. 단계 번호와 줄 번호가 섞인다.
- `steps` JSON 에 번호 없는 줄을 넣지 않는다. 참고 줄만 있는 항목을 단계가 있는 항목으로 읽는다. 대신 stderr 에 낸다.

## 작업 항목

### 1. `work-board/bin/board.ts`

- `COMMANDS` 에 `mark` 를 더한다. `board.ts mark <id> <n> [--undo]`. n 은 details 다음 next 순서로 1부터 센 줄 번호이고 번호 없는 줄도 센다. 그 줄의 `done` 만 바꾼다. 줄이 없으면 `Refused`.
- `mark` 와 `step` 뒤에 항목이 `decide` 이고 details 와 next 의 줄이 하나 이상이며 모두 `done` 이면 `status` 를 `done` 으로 바꾼다. `--undo` 로 되돌려도 status 는 바꾸지 않는다.
- `list` 는 항목 줄 아래에 details 와 next 의 모든 줄을 `    <n> ✓ <text>`(끝냄) 또는 `    <n>   <text>`(안 끝냄) 로 낸다. n 은 `mark` 의 번호와 같다.
- `steps` 는 stdout JSON 을 그대로 두고, 진행률을 세는 단계 줄이 아닌 줄이 있으면 stderr 에 `단계 밖의 줄(mark 번호):` 머리와 `list` 와 같은 꼴의 줄을 낸다.
- 머리 주석과 `HELP` 의 사용법에 `mark` 를 적는다.

### 2. `work-board/board-decide/SKILL.md`

- 5단계를 바꾼다. 답한 보드 줄은 `board.ts mark <id> <n>` 으로 끝내고 줄 번호는 `board.ts list` 로 본다. 줄이 모두 끝난 decide 항목은 저절로 done 이 된다.
  worker 질문은 코디네이터 터미널에서 `orca orchestration reply --id <질문 id> --body ...` 로 답한다.
- `metadata.version` 을 `1.1.0` 으로 올린다.

### 3. `work-board/README.md`

- 「결정 필요」, 「단계 끝내기」 줄에 `mark`, 남은 줄 세기, `list` 와 `steps` 의 줄 표시를 적는다.

### 4. 테스트

- 기존 `work-board/tests/board.spec.ts` 의 `list` 테스트(항목 줄이 `lines[1]`, `lines[2]` 라고 가정)와 사용법 테스트(`사용법: board.ts {set,step,steps,del,list}` 로 시작)의 기대값을 새 출력과 `USAGE` 에 맞춘다.
- `work-board/tests/skills.spec.ts` 가 `board-decide/SKILL.md` 의 문구를 검사한다. 5단계를 고친 뒤 그 기대 문구가 남는지 확인하고, 바꾼 문구면 테스트 기대값도 고친다.
- `work-board/tests/board.spec.ts`: `mark` 가 번호 없는 줄을 끝내고 `--undo` 로 되돌린다. decide 항목의 마지막 줄을 끝내면 status 가 done 이다. 없는 줄 번호는 종료 코드 1. `list` 가 줄과 완료 표시를 낸다. `steps` 는 stdout JSON 이 그대로이고 stderr 에 단계 밖의 줄을 낸다.

## 검증

```bash
node --test --test-concurrency=4 "work-board/tests/*.spec.ts"
```

기대값: 종료 코드 0.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `work-board/bin/board.ts` | 수정 |
| `work-board/board-decide/SKILL.md` | 수정 |
| `work-board/README.md` | 수정 |
| `work-board/tests/board.spec.ts` | 수정 |
| `work-board/tests/skills.spec.ts` | 수정 |
