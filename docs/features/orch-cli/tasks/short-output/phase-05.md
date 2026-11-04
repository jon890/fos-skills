# Phase 05. board, spec, doctor 묶음의 짧은 출력과 `orch status`

**Execution profile**: standard

## 목표

`orch board …`, `orch spec lint`, `orch doctor`, `orch doctor migrate(-hooks)` 의 짧은 출력이 판정 줄만 내고, 사람용 요약 `orch status` 가 루프·worker·보드를 한 번의 호출로 판정 줄로 낸다.

**범위 외**: 문서(phase 06), 폴더 이동(PR3).

## 컨텍스트

**요구사항**: REQ4, REQ10

**근거 문서**: `docs/features/orch-cli/spec.md` 의 REQ10, DECISION12, DECISION22. `docs/features/orch-cli/design.md` 의 「짧은 출력 (PR2)」 표의 `board …`, `spec lint`, `doctor`, `doctor migrate`, `status` 행, 「`orch status` (PR2)」.

- `board-sync.ts`, `board-release.ts`, `goal-progress.ts`, `migrate-orch-dir.ts` 는 `out(line)` 이다. `spec-lint.ts` 는 `errors`, `warnings` 줄을 `process.stdout.write` 로 낸다(695줄 근처). `orch-doctor.ts` 는 모든 줄을 모아 한 번에 낸다(791줄 근처).
- `stalled-workers.ts` 의 `workerLine`, `stageLine` 과 Run 고르기(`runsOf`)를 `orch status` 가 같이 쓴다. 진입 스크립트를 import 하면 그 `main` 이 돌므로 두 줄 함수를 `lib/movement.ts` 로 옮긴다.
- `lib/loop.ts` 의 `loopStatus(repo, now)`, `registeredRuns(repo)`, `lib/movement.ts` 의 `collectWorkers`, `collectStages`, `movementSettings`, `readRecords`, `lib/board.ts` 의 `readBoard`, `lib/paths.ts` 의 `boardPath`, `pathOf`, `lib/workers.ts` 의 `workerRows`.
- 명령 표(`lib/commands.ts`)에 `status` 행이 없다. `orch status` 는 묶음 하나, 동작 없음이다.

## 작업 항목

### 1. `skills/orch/scripts/board-sync.ts`, `board-release.ts`, `goal-progress.ts`

- `board-sync.ts`: `out` 이 `emit(line, RULES)`. 규칙: 항목 줄(389줄 근처, 첫 줄 `<id>[ -> done]` 과 들여 쓴 board 명령)은 `BOARD <id> <done 이면 done, 아니면 명령 수 cmds>` 한 줄, 끝 요약 `board-sync: <바뀐 목록|바뀐 항목 없음>` → `BOARD-SYNC <바뀐 수>`, 그 밖의 `board-sync: …` 설명은 버린다. 항목 줄은 `out` 을 부르기 전에 짧은 줄을 만들 수 있게 `emit` 대신 분기한다.
- `board-release.ts`: 같은 꼴(`BOARD <id> …`, `BOARD-RELEASE <바뀐 수>`). dry-run 의 `<id> (PR #N)` 와 명령 줄도 `BOARD <id> <명령 수> dry-run` 한 줄.
- `goal-progress.ts`: `^(\S+) 단계 줄이 없어` → `GOAL-SKIP $1`, `<목표> <값>` 줄은 짧은 출력이면 `GOAL <목표> <값>`, 세부 줄(들여쓰기)은 버린다.

### 2. `skills/orch/scripts/spec-lint.ts`

짧은 출력이면 `errors` 의 줄 앞에 `SPEC-ERROR `, `warnings` 의 줄 앞에 `SPEC-WARN ` 을 붙인다. stderr 의 요약은 그대로다.

### 3. `skills/orch/scripts/orch-doctor.ts`

모은 줄을 `emit(lines.join('\n'), [], { fix: true })` 로 낸다. 판정 줄과 들여 쓴 고칠 줄이 남고 `  안내:` 줄이 빠진다.

### 4. `skills/orch/scripts/migrate-orch-dir.ts`

`out` 이 `emit(line, RULES)`. 규칙: `^옮김 (\S+) -> (\S+)` → `MOVED $1 $2`, `^옮길 것 (\S+) -> (\S+)` → `WOULD-MOVE $1 $2`, `^겹침 (\S+) -> (\S+)` → `CONFLICT $1 $2`, `^(옛 경로를 바꿈|바꿀 옛 경로) (\S+) (\d+)곳` → `REWRITE`/`WOULD-REWRITE $2 $3`, `^(빈 폴더를 지움|지울 빈 폴더) (\S+)` → `REMOVED`/`WOULD-REMOVE $2`, `^남김 (\S+) \(보드` → `KEPT $1 board`, `^(핸들러를 만듦|만들 핸들러) (\S+)` → `HANDLER`/`WOULD-HANDLER $2`, `^(설정에서 지움|설정에서 지울 키) (\S+)` → `CONFIG-REMOVED`/`WOULD-CONFIG-REMOVE $2`, `^(옮길 것이 없다|옮길 칸이 없다)` → `NOTHING`, `^추적 파일 (.*?)  \(` → `TRACKED $1`. 그 밖(참조 표본 줄, 안내)은 버린다.

### 5. `orch status`

- `skills/orch/scripts/lib/movement.ts` 에 `workerLine(v)`, `stageLine(s)` 와 화면 기록 읽기 `screenMarks(repo)`(지금 `stalled-workers.ts` 의 지역 함수 `screens`, `<orch 루트>/state/movement.json` 의 `screens`)를 옮겨 export 하고 `stalled-workers.ts` 가 가져다 쓴다(출력 꼴은 그대로).
- `skills/orch/scripts/orch-status.ts` 신규. 이름은 묶음 이름 `status` 와 겹치지 않게 한다(`lib-commands.spec.ts` 의 「묶음 이름은 옛 스크립트 이름과 겹치지 않는다」). 머리 주석에 사용법(`orch-status.ts --repo DIR [--run ID]...`), 출력, 종료 코드를 적는다. `--repo` 없으면 사용법 오류(2). Run 은 `--run` 들, 없으면 `registeredRuns`, 없으면 설정의 `finish.run`, 그래도 없으면 빈 목록이다(그때는 Run 줄을 내지 않는다).
  - `loopStatus(repo, Date.now())` 가 살았으면 `LOOP-ALIVE <pid> runs=<등록된 Run 목록 또는 -> last_tick=<…>`, 아니면 `LOOP-DEAD <repo> <이유>`.
  - `collectWorkers({ runs, rowsOf: workerRows, settings: movementSettings(repo), now, screens: screenMarks(repo) })` 의 판정을 Run 마다 세어 `RUN <id> workers=<판정 수> stalled=<reason 있는 수>`. 읽지 못한 Run 은 `SKIP-WORKERS <Run> <이유>`.
  - `readBoard(boardPath(repo))` 의 status 가 `doing`, `decide` 인 수로 `BOARD doing=<n> decide=<n>`. 보드 파일이 없으면 `BOARD doing=0 decide=0`, 읽지 못하면 `SKIP-BOARD <이유>`.
  - 멈춘 worker 마다 `workerLine`(STALLED 만), `collectStages` 의 단계마다 `stageLine`.
  - 종료 코드 0, 조회 실패(SKIP-*)가 있으면 1, 사용법 오류 2. 아무것도 쓰지 않는다.
- `skills/orch/scripts/lib/commands.ts` 에 행 `{ group: 'status', verb: null, script: 'orch-status.ts', context: ['repo'], legacy: null, usage: 'orch status [--run <Run>]' }` 를 더한다(Run 은 문맥으로 채우지 않는다. 스펙 DECISION22).

### 6. 테스트

- `skills/orch/tests/board-sync.spec.ts`, `board-release.spec.ts`, `goal-progress.spec.ts`: 짧은 출력이 `BOARD …`, `BOARD-SYNC …`, `BOARD-RELEASE …`, `GOAL …` 이고 설명 줄이 없다.
- `skills/orch/tests/spec-lint.spec.ts`: 막을 발견이 있는 지시서의 짧은 출력이 `SPEC-ERROR …`.
- `skills/orch/tests/orch-doctor.spec.ts`: `LOOP-STALE` 처럼 `  안내:` 와 명령 줄이 따르는 판정이 짧은 출력에서 판정 줄과 명령 줄만이다.
- `skills/orch/tests/migrate-orch-dir.spec.ts`: dry-run 의 짧은 출력이 `WOULD-MOVE …` 이고 참조 표본 줄이 없다.
- `skills/orch/tests/orch-status.spec.ts` 신규: 임시 저장소에 루프 기록(`state/loop.json`, 살아 있는 pid 로 이 테스트 프로세스), 등록 Run 두 개(`state/loop-runs/`), 보드 파일(doing 둘, decide 하나), 가짜 orca(ORCA 환경 변수)의 worker-list 를 두고 `orch-status.ts --repo` 를 돌리면 `LOOP-ALIVE …`, Run 마다 `RUN <id> workers=… stalled=…`, `BOARD doing=2 decide=1`, 멈춘 worker 의 `STALLED` 줄이 나오고 종료 코드 0, 저장소 파일이 바뀌지 않는다. `--run` 을 주면 그 Run 줄만 나온다. 루프가 없으면 `LOOP-DEAD`.
- `skills/orch/tests/lib-commands.spec.ts`: `orch status` 가 `orch-status.ts` 로 풀리고 문맥 칸이 repo 뿐이다. 문맥 칸 검사(35-56줄 근처)는 스크립트의 `run` 옵션을 보고 문맥 칸에 run 이 없는 행을 실패로 보므로, 예외 표에 `orch status` 의 run(스펙 DECISION22)을 더한다. 명령 표의 `script` 가 모두 실제 파일이라는 기존 사례가 `orch-status.ts` 를 본다.
- `skills/orch/tests/stalled-workers.spec.ts`: 줄 함수를 옮긴 뒤에도 기존 사례가 통과한다.

## 검증

```bash
node --test skills/orch/tests/board-sync.spec.ts skills/orch/tests/board-release.spec.ts skills/orch/tests/goal-progress.spec.ts skills/orch/tests/spec-lint.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/migrate-orch-dir.spec.ts skills/orch/tests/orch-status.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/stalled-workers.spec.ts skills/orch/tests/lib-movement.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/board-sync.ts` | 수정 |
| `skills/orch/scripts/board-release.ts` | 수정 |
| `skills/orch/scripts/goal-progress.ts` | 수정 |
| `skills/orch/scripts/spec-lint.ts` | 수정 |
| `skills/orch/scripts/orch-doctor.ts` | 수정 |
| `skills/orch/scripts/migrate-orch-dir.ts` | 수정 |
| `skills/orch/scripts/lib/movement.ts` | 수정 |
| `skills/orch/scripts/stalled-workers.ts` | 수정 |
| `skills/orch/scripts/orch-status.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/tests/board-release.spec.ts` | 수정 |
| `skills/orch/tests/goal-progress.spec.ts` | 수정 |
| `skills/orch/tests/spec-lint.spec.ts` | 수정 |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 |
| `skills/orch/tests/migrate-orch-dir.spec.ts` | 수정 |
| `skills/orch/tests/orch-status.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
