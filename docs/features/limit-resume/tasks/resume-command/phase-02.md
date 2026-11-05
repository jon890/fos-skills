# Phase 02. `orch worker resume` 명령

**Execution profile**: deep

## 목표

코디네이터가 멈춘 dispatch 하나를 명령 하나로 resume 해 같은 Task 에 다시 잇게 한다. 살아 있는 worker 의 abandon 과 터미널 닫기, 잠금, 실행기와의 순서를 다루므로 실패 사례를 모두 테스트로 묶는다.

**범위 외**: 세션 찾기와 실행기(phase-01), `adopt-sessions`·상주 루프의 안내 줄(phase-03), 참조 문서(phase-04).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4

**근거 문서**: `docs/features/limit-resume/spec.md`, `docs/features/limit-resume/design.md`(「명령」, 「요청 폴더」, 「대상 판정」, 「호출과 상태」 1~8, 「실패와 일관성」, 결정 표)

- 경로: phase-01 컨텍스트의 「스크립트 폴더」 표를 따른다. `resume-worker.ts` 는 `resume-exec.ts` 와 같은 폴더에 둔다.
- 재사용할 것(실제 정의):
  - `skills/orch/scripts/lib/orca.ts` 의 `orca`, `orcaJson`. 실행 파일은 `ORCA` 환경 변수라 테스트가 가짜로 바꾼다.
  - `skills/orch/scripts/lib/sessions.ts` 의 `terminalRows`, `limitedScreen`, `isStructured`.
  - `skills/orch/scripts/lib/screen.ts` 의 `screenLines`, `screenTail`, `classify`(`ScreenState` 는 `working`, `error`, `interrupted`, `idle`, `draft`, `permission`, `unknown`).
  - `skills/orch/scripts/lib/workers.ts` 의 `LIVE_DISPATCH`, `worktreePaths`.
  - `skills/orch/scripts/lib/launched.ts` 의 `readLaunch`, `recordLaunch`. dispatch id 검사 규칙도 이 파일의 `fileOf` 와 같게 한다.
  - `skills/orch/scripts/lib/paths.ts` 의 `ensure('state', repo)`, `skills/orch/scripts/lib/py.ts` 의 `shQuote`, `skills/orch/scripts/lib/output.ts` 의 `emit`.
- `worker-start --terminal` 은 `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다(`orca orchestration worker-start --help`).
- 가짜 orca: `skills/orch/tests/fixtures/fake-bin.ts` 의 `fakeBin` 은 정해 둔 응답만 돌려주고 파일을 쓰거나 상태에 따라 응답을 바꾸지 못한다. 이 phase 의 테스트는 `skills/orch/tests/fixtures/merge-queue-fakes.ts` 의 가짜 gh 처럼 `FAKE_STATE`(JSON 상태 파일)와 `FAKE_LOG`(호출 기록)를 쓰는 상태 있는 가짜 orca 를 테스트 파일 안에 만든다.

## 의도 메모

- `link` 실패 뒤에는 같은 명령을 안내하지 않는다. 남은 터미널에 이미 resume 한 에이전트가 붙어 있어 같은 명령이 두 번째 프로세스를 띄운다. 잠금 판정이 그 경우를 거부한다.
- 6단계에서 `idle` 만 받지 않는다. resume 한 화면은 앞 대화의 한도 오류 줄이 다시 그려져 `error` 로 보일 수 있다.
- Run 은 문맥이 아니라 옛 dispatch 의 `runId` 다(설계 DECISION9).

## Blocked 조건

- phase-01 의 `lib/resume.ts`, `resume-exec.ts` 가 없다 → `PHASE_BLOCKED: phase-01 미완료`

## 작업 항목

### 1. `skills/orch/scripts/resume-worker.ts`(신규)

머리 주석에 사용법, 출력 줄, 단계별 종료 코드와 `NEXT`(설계 「명령」 의 두 표)를 적는다. 사용법 `resume-worker.ts --dispatch ID [--run ID] [--repo DIR] [--timeout-ms N]`, 기본 시한 100000.

- 사용법 검사: `--dispatch` 가 없거나 `^[\w.-]+$` 가 아니거나 `.` 으로 시작하면 종료 코드 2.
- 잠금: `<ensure('state', repo)>/resume/<dispatch>/lock` 을 `openSync(…, 'wx')` 로 만든다. 이미 있으면 그 `pid` 가 살아 있는지(`process.kill(pid, 0)`)와 `terminal` 이 `terminalRows()` 에 열려 있는지 본다. 하나라도 참이면 `RESUME-FAIL target 앞 실행이 진행 중이거나 결과 터미널 <handle> 이 열려 있다` 와 `NEXT` 로 그 터미널 확인을 내고 3. 둘 다 거짓이면 폴더를 지우고 다시 잡는다.
- 대상 판정: `worker-show --dispatch <id> --full --json` 의 `dispatch.runId` 를 Run 으로 쓴다. `--run` 이 있고 다르면 `RESUME-FAIL target`. `task-list --run <Run> --json`, `dispatch-show --task <Task>`(마지막 dispatch), `terminalRows()` 로 설계 「대상 판정」 표대로 `limited`, `restart`, `settled`, 거부를 정한다. 구조화 worker(`isStructured`)와 `claude`, `codex` 밖의 에이전트는 거부한다. 조회 실패와 `terminalRows()` 의 예외는 `RESUME-FAIL target <이유>` 와 종료 코드 1.
- `limited` 의 Claude 면 옛 터미널의 `processId`(`orca terminal show --terminal <handle> --json` 의 `terminal.processId`) 자손 가운데 명령 줄이 `claude` 로 시작하는 프로세스의 `--plugin-dir` 값을 `ps -A -o pid=,ppid=,command=` 로 읽어(`ps` 는 절대경로가 아니라 PATH 에서 찾는다. 테스트가 PATH 앞에 가짜 `ps` 를 둔다) `request.json` 의 `pluginDir` 로 넘긴다. 못 읽으면 null.
- 차례 1~8(설계 「호출과 상태」). 새 터미널 명령은 `<process.execPath> <resume-exec.ts> <요청 폴더> && . <요청 폴더>/launch.sh` 이고 세 경로 모두 `shQuote` 로 감싼다. `resume-exec.ts` 경로는 `join(dirname(import.meta.filename), 'resume-exec.ts')`. 새 handle 을 받으면 `lock` 에 적는다.
- 6단계 준비 판정: `terminalRows()` 의 그 handle 의 `agentIdentity` 가 요청 에이전트와 같고, `terminal read --screen --limit 40` 의 `classify(screenTail(screenLines(…), 20))` 가 `idle`, `error`, `interrupted` 중 하나.
- 7단계 Task 상태가 `failed`·`blocked` 면 `--retry-of <옛 dispatch>` 를 더한다. receipt 의 `ok !== true` 도 실패다.
- 8단계 `recordLaunch(repo, { dispatch: 새, task, terminal: 새, worktree, branch, run, spec })`. `branch` 는 `worktreePaths(repo)` 에서 워크트리 실경로로 찾는다. `spec` 은 `readLaunch(repo, 옛 dispatch)?.spec ?? null` 이고 null 이면 `RESUME-WARN spec 기록 없음`.
- 실패마다 설계의 표대로 새 터미널을 닫거나 남기고 `RESUME-FAIL`, `NEXT`, 종료 코드를 낸다. 성공하면 요청 폴더를 지운다.

### 2. `skills/orch/scripts/lib/commands.ts` 의 명령 표

`worker adopt` 행 옆에 `{ group: 'worker', verb: 'resume', script: 'resume-worker.ts', context: ['repo'], usage: 'orch worker resume --dispatch <id>' }` 를 더한다. 옛 이름(`legacy`)은 두지 않는다. `skills/orch/tests/lib-commands.spec.ts` 의 `omitted` 객체에 `worker resume` 의 `--run` 을 「옛 dispatch 의 runId 를 쓴다. 문맥의 지금 Run 으로 채우면 다른 Run 의 worker 를 잘못 잇는다」 이유와 함께 더한다.

### 3. `skills/orch/tests/resume-worker.spec.ts`(신규)

상태 있는 가짜 orca 를 둔다. `FAKE_STATE` 에 dispatch, Task, 터미널 목록, 화면 상태를 두고, 호출마다 `FAKE_LOG` 에 인자와 그때 요청 폴더에 `go` 가 있었는지를 한 줄로 적는다. `terminal create` 는 받은 `--command` 에서 요청 폴더를 읽어 사례가 정한 `found.json` 을 쓰고 새 터미널을 상태에 더한다. `go` 가 생긴 뒤의 `terminal list` 는 새 터미널의 `agentIdentity` 를 사례가 정한 값으로 낸다. 임시 저장소와 워크트리 준비는 `skills/orch/tests/adopt-sessions.spec.ts` 를 따른다.

- `limited`(Claude): 호출 순서가 `terminal create` → `worker-abandon` → `terminal close`(옛) → `worker-start --task … --terminal <새>` 이고, `worker-abandon` 과 옛 `terminal close` 기록의 `go` 는 거짓, `worker-start` 기록의 `go` 는 참이다. 출력에 `RESUME-TARGET … kind=limited`, `RESUME-SCREEN`, `RESUME-SESSION <세션> home=… terminal=<새>`, `RESUMED` 가 있고 종료 코드 0. `launched-workers/<새 dispatch>.json` 에 `branch`, `spec` 이 있다. `request.json` 의 `pluginDir` 이 옛 프로세스 실행 줄의 값이다(가짜 `ps` 는 `PATH` 앞의 가짜 실행 파일로 둔다).
- `limited`(Codex): 같은 흐름이고 `request.json` 의 `agent` 가 `codex`, `pluginDir` 이 null 이다.
- `restart`: `worker-abandon`, `terminal close` 를 부르지 않는다. 옛 터미널이 열려 있으면 `RESUME-FAIL target` 이고 `terminal create` 가 없다.
- `settled`: abandoned dispatch 를 받는다.
- 정상 작업 중인 살아 있는 dispatch(화면 `working`, 한도 줄 없음): `RESUME-FAIL target`, 종료 코드 3, `terminal create` 와 `worker-abandon` 이 없다.
- 구조화 worker, 에이전트 `cursor`, 같은 Task 의 더 새 dispatch, `--run` 이 `runId` 와 다름: 각각 `RESUME-FAIL target`.
- 잘못된 `--dispatch`(`../x`): 종료 코드 2, 폴더를 만들지 않는다.
- `find` 실패: `found.json` 이 `ok: false` 면 새 터미널을 닫고 옛 dispatch 를 건드리지 않으며 종료 코드 3.
- `cleanup` 실패: `worker-abandon` 이 실패하면 새 터미널을 닫고 `go` 를 쓰지 않으며 종료 코드 3.
- `start-agent` 실패: 화면이 계속 `working` 이면(짧은 `--timeout-ms`) 새 터미널을 닫고 종료 코드 3, 출력에 화면 끝 줄이 있다. 화면이 `error` 면 통과한다.
- `link` 실패: `worker-start` 가 실패하면 새 터미널을 닫지 않고 `NEXT orca orchestration worker-start --task … --terminal <새> …` 와 종료 코드 1. 이어서 같은 명령을 부르면 잠금 판정으로 `RESUME-FAIL target`.
- Task 가 `failed` 면 `worker-start` 에 `--retry-of <옛>` 이 붙고, `ready` 면 붙지 않는다.

## 검증

```bash
node scripts/run-node-tests.ts skills/orch/tests/resume-worker.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/lib-resume.spec.ts skills/orch/tests/resume-exec.spec.ts skills/orch/tests/lib-bundle.spec.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/resume-worker.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/resume-worker.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
