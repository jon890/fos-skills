# Phase 01. 상주 루프의 뼈대와 코디네이터를 깨우는 알림 경로를 만든다

**Execution profile**: deep

## 목표

`orch-loop.ts` 를 저장소마다 하나 도는 분리된 프로세스로 만든다. 틱마다 질문 확인, 정리(원격 브랜치 포함), 보드 동기화, `tick` 이벤트를 한다.
코디네이터를 깨워야 하는 일은 알림 파일에 적고 `wait-important` 가 그 파일로 깨어난다. 루프가 죽으면 `LOOP-DEAD` 로 깨어난다.
루프 상태 판정(`loop.json` 읽기, 생존 판정, 알림 파일과 커서)은 `lib/loop.ts` 한 벌이고, 질문 판정은 `lib/questions.ts` 한 벌이다.

**범위 외**: CI 감시와 worker 찾기의 lib 이전(phase 02). 충돌 PR 처리(phase 03). `orch/SKILL.md` 와 `orch/references/` 의 사용법(phase 04).
자동 진행(ready 슬롯, base 합치기, 순서 머지와 `--order`, 문서 PR 머지), 배포 묶기, `ci-missing` 은 이 plan 에서 하지 않는다(`index.json` 의 `deferred`).
목표 진행률(`board-sync --goal`)은 루프가 하지 않는다. 코디네이터의 수동 경로로 남기고 phase 04 가 `orch/references/waiting.md` 에 적는다.

## 컨텍스트

시작 조건: `orch/scripts/cleanup-sweep.ts` 가 `--remote-branches` 를 받는다(orch 3.3.0). 아니면 `PHASE_BLOCKED: orch 3.3.0 이 main 에 없다` 를 내고 멈춘다.

지금은 코디네이터가 Monitor 로 `watch-questions.ts` 를 띄우고, 깨어날 때마다와 5분마다 `cleanup-sweep.ts` 와 `board-sync.ts` 를 직접 부른다(`orch/references/waiting.md`). Monitor 는 시간이 지나면 끝나고, 하네스의 백그라운드 명령은 시간 한도(기본 30분, 최대 2시간)가 있어 그 사이에 질문이 쌓였다.

이 phase 가 쓰는 기존 코드:

| 쓰는 것 | 위치 |
| --- | --- |
| 질문 조회 | `lib/questions.ts` 의 `snapshot(run)`, `ageSeconds`. `orcaJson`(동기, 호출마다 30초 제한)으로 읽는다 |
| 재알림 판정과 알린 기록 | 지금은 `watch-questions.ts` 의 `poll(run, state, now, remindAfter, repo)` 와 `notify(notice, repo, run)`. 이 phase 가 `lib/questions.ts` 로 옮긴다 |
| `worker-question` 입력의 worker | `lib/completion.ts` 의 `context(message)` |
| 이벤트 실행 | `lib/events.ts` 의 `fire(event, input, ctx)`. 결과의 `result` 가 `fail` 이나 `timeout` 이면 `HOOK-FAIL` 줄을 이미 냈다 |
| 죽은 pid 의 잠금 회수 | `lib/events.ts` 의 `reclaim(lock, seen)`. 잠금 파일을 `wx` 로 만들고 pid 를 적는 방식은 같은 모듈의 핸들러 잠금과 같다 |
| pid 생존 | `lib/process.ts` 의 `alive(pid)`(EPERM 은 살아 있음) |
| 자식 실행 | `lib/proc.ts` 의 `runAsync`, `scriptCommand`(확장자로 인터프리터를 고른다), `stopChildren`, `signalCode` |
| 경로 | `lib/paths.ts` 의 `pathOf('state', repo)`, `makeParent(target, repo)`, `boardPath(repo)` |
| 설정 | `lib/config.ts` 의 `loadConfig`, `section`, `PIPELINE_KEYS`. `finish` 절의 아는 키는 지금 `finish-pr.ts` 의 `FINISH_KEYS`(`lib/finish-options.ts` 의 `FINISH_OPTIONS` 에서 `config`, `help` 를 빼고 하이픈을 밑줄로 바꾼 것)뿐이다 |
| 내 PR | `lib/gh.ts` 의 `ownAuthors(repo, host)`, `isOwnPr(pr, authors)`, `apiTarget(url)`, `ghJson` |

환경 변수: 정리 명령 경로는 기존 `CLEANUP_SWEEP`(`finish-pr.ts`, `merge_queue.ts` 와 같은 이름), 보드 동기화 명령 경로는 새 이름 `BOARD_SYNC` 다. `BOARD_BIN` 은 `board-sync.ts` 가 부르는 보드 편집 명령(`work-board/bin/board.ts`)의 경로라 쓰지 않는다. orca 와 gh 는 `ORCA`, `GH` 다.
`git grep -n "BOARD_SYNC\|ORCH_LOOP_ALIVE_SEC"` 는 지금 아무것도 찾지 않는다.

상태 파일(`state/loop.json`, `state/loop.lock`, `state/loop.log`, `state/loop-events.jsonl`, `state/loop-events.cursor`)의 형식은 `docs/data-schema.md` 의 「orch 루트에 더하는 파일」 이, `pipeline.tick_sec` 은 같은 문서의 「config.json 에 더하는 절」 이 소유한다. 이 phase 가 그 행을 아래 결정에 맞게 고친다.

`orch/tests/readme-script-list.spec.ts` 는 `orch/scripts/` 의 `.ts` 가 모두 `orch/README.md` 에 `` `scripts/<이름>.ts` `` 로 적혀 있어야 통과한다. 그래서 README 한 줄을 이 phase 에서 더한다.

**근거 문서**: `docs/flow.md` 의 「운영 공백을 막는 곳」 의 질문 감시 줄과 「갈래」 의 루프 두 줄, `docs/data-schema.md` 의 「orch 루트에 더하는 파일」, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 와 「사용자 결정 (2026-10-24)」 의 상주 루프 줄

## 의도 메모

- 사용자 결정(2026-10-25): plan7 은 늘 도는 상주 루프(질문 확인, 정리, 보드 동기화, CI 감시와 알림, 충돌 PR 처리)와 wait-important 연동까지만 하고 PR 하나로 끝낸다. 자동 진행과 배포 묶기, `ci-missing` 은 `index.json` 의 `deferred` 다. 그래서 이 plan 의 루프는 `pipeline.enabled` 를 읽지 않는다. 지금 하는 일은 모두 그 값과 무관하게 도는 일이다(사용자 결정 2026-10-24).
- 루프는 상태로만 판정한다. 루프가 없던 동안 생긴 일은 다음 틱이 다시 본다. 그래서 루프가 죽어도 잃는 것이 없고, 다시 띄우기만 하면 된다.
- 하네스는 백그라운드 명령의 stderr 를 알리지 않는다. 루프의 실패도 알림 파일의 `WATCH-ERROR` 나 `HOOK-FAIL` 로 간다. 같은 이유는 한 번만 쓴다(아래 「오류 줄 억제」). 틱마다 같은 실패로 코디네이터를 깨우지 않기 위해서다.
- 새 질문(`QUESTION`)은 알림 파일에 쓰지 않는다. 코디네이터의 `wait-important` 가 `question`, `escalation` 메시지로 이미 깨어난다. 메시지가 다시 오지 않는 재알림(`REMINDER`)만 알림 파일로 깨운다.
- 생존 판정은 틱 길이와 떼어 낸다(아래 「생존」). 틱 하나는 같은 스크립트를 `--tick` 자식 프로세스로 `runAsync` 로 띄워 돌리고, 부모 프로세스는 일정, 생존 타이머, `loop.json` 쓰기만 맡는다. lib 의 조회(`lib/questions.ts` 의 `snapshot`, `lib/gh.ts` 의 `ghJson`, `lib/conflicts.ts` 의 `findConflicts`)가 동기라 같은 프로세스에서 틱을 돌리면 그동안 타이머가 돌지 못하기 때문이다(team-lead 결정 2026-10-25). 정리 명령의 `--wait` 나 phase 03 의 `send-to-worker` 이어 쓰기(최대 65분)가 틱을 길게 만들어도 죽은 것으로 보지 않는다.
- `loop.json` 은 부모 프로세스만 쓴다(옆 파일에 쓴 뒤 rename). 틱 자식은 `loop.json` 을 읽기만 하고(이전 `errors` 를 보려고), 틱 결과(`last_tick` 에 쓸 시각, 바뀐 `errors`, `open_prs`)를 stdout 마지막 줄의 JSON 한 줄로 낸다. 부모가 그 값을 합쳐 쓴다. 자식의 나머지 출력은 부모가 `log()` 로 옮긴다. 자식이 JSON 줄 없이 끝나면 `errors.tick` 에 그 종료 코드를 이유로 둔다.
- 알림 파일(`loop-events.jsonl`)은 틱 자식만 append 한다. 틱은 한 번에 하나만 돌므로 `seq` 를 쓰는 쪽이 하나다. 읽는 쪽(`--status`, `wait-important`, `orch-doctor`)은 `lib/loop.ts` 로만 읽는다.

## 작업 항목

### 1. 질문 판정을 `lib/questions.ts` 로 옮긴다

`watch-questions.ts` 의 `poll`, `brief`, `Notice` 타입, `Seen` 타입과 `notify` 를 `lib/questions.ts` 로 옮기고 export 한다. 동작과 바이트 꼴(`pyJson`, 옆 파일에 쓰고 rename, 형식 오류 판정, 「옛 명령은 …」 이유 주석)은 그대로다.
`notify` 는 이름을 `notifyQuestion(notice, repo, run)` 으로 바꾼다. 이벤트 실행기의 오류를 잡아 stderr 에 한 줄 남기는 동작도 같다. stderr 접두는 부르는 명령 이름을 인자로 받는다(`watch-questions:`, `orch-loop:`).
`watch-questions.ts` 는 두 함수를 import 해 부른다. 옵션, 출력, 종료 코드, `WATCH-ERROR` 억제는 바꾸지 않는다. 머리 주석의 「테스트가 poll 을 import 한다」 를 지우고 `lib/questions.ts` 머리 주석에 사용처(watch-questions, orch-loop)와 `questions-seen.json` 의 형식을 옮긴다.
`orch/tests/questions.spec.ts` 는 `poll` 을 `../scripts/lib/questions.ts` 에서 import 한다.

### 2. `finish` 절의 아는 키를 `lib/finish-options.ts` 로 옮긴다

`finish-pr.ts` 의 `FINISH_KEYS` 계산을 `lib/finish-options.ts` 의 `export const FINISH_KEYS` 로 옮기고 `finish-pr.ts` 가 import 한다. 루프가 `finish.run`, `finish.specs_dir` 를 읽을 때 `section(config, 'finish', FINISH_KEYS)` 로 읽어, 다른 `finish` 키를 둔 저장소에서 사용법 오류로 멈추지 않게 한다.

### 3. `orch/scripts/lib/loop.ts`

루프 상태 판정 한 벌이다. `orch-loop.ts --status`, `wait-important.ts`, `orch-doctor.ts` 가 쓴다.

| 함수 | 하는 일 |
| --- | --- |
| `loopFile(repo)`, `eventsFile(repo)`, `cursorFile(repo)`, `lockFile(repo)` | `pathOf('state', repo)` 아래의 `loop.json`, `loop-events.jsonl`, `loop-events.cursor`, `loop.lock` |
| `readLoop(repo)` | `loop.json` 을 읽는다. 없거나 깨졌으면 null |
| `loopStatus(repo, now)` | `{ alive: true, state }` 또는 `{ alive: false, reason }`. 아래 「생존」 |
| `appendEvent(repo, kind, pr, text)` | 알림 한 줄을 더한다. 아래 「알림 파일과 커서」 |
| `readEvents(repo)` | 커서보다 큰 `seq` 의 줄과 빠진 구간(`gap`)을 낸다. 커서는 옮기지 않는다 |
| `writeCursor(repo, seq)` | 커서를 옆 파일에 쓰고 rename 한다 |

**생존**: `loop.json` 이 있고, `pid` 가 살아 있고(`alive`), `alive_at` 이 `now` 에서 `max(3 × tick_sec, 120)` 초 안이면 살아 있다. `tick_sec` 은 `loop.json` 에 루프가 적은 값이다. `last_tick` 은 상태 보고용이고 판정에 쓰지 않는다.
죽은 이유는 `없음`(파일이 없다), `pid <n> 종료`, `alive_at <시각> 이후 응답 없음` 가운데 하나다.

**알림 파일과 커서**: `loop-events.jsonl` 의 한 줄은 `{"seq": <정수>, "time": <ISO 8601 UTC>, "kind": ..., "pr": <번호 또는 null>, "text": ...}` 다. `seq` 는 1 부터 단조 증가한다. 커서 파일에는 마지막으로 읽은 `seq` 하나를 적는다.

- 쓰는 쪽은 루프 하나다. 루프는 시작할 때 알림 파일 마지막 줄의 `seq` 와 커서 값 가운데 큰 것 다음부터 센다. 파일을 잘라 낸 뒤 루프가 다시 떠도 `seq` 가 되돌아가 새 알림이 커서 뒤에 숨지 않게 하기 위해서다
- 더한 뒤 줄이 1000 줄을 넘으면 마지막 1000 줄만 옆 파일에 써서 rename 으로 바꾼다. 쓰는 쪽이 하나라 잠금이 필요 없고, 읽는 쪽은 rename 전이나 뒤의 온전한 파일 하나를 읽는다
- 읽는 쪽은 `seq` 가 커서보다 큰 줄만 낸다. 파일의 첫 `seq` 가 커서의 다음 값보다 크면 그 사이를 `gap` 으로 낸다. 읽지 않은 줄이 1000 줄을 넘어 잘린 경우다
- 커서가 없으면 0 이다

### 4. `orch/scripts/orch-loop.ts`

```
orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop | --status | --foreground) [--once]
```

| 옵션 | 동작 | 출력과 종료 코드 |
| --- | --- | --- |
| `--start` | 살아 있는 루프가 없으면 `child_process.spawn` 의 `detached: true`, `stdio: 'ignore'` 로 자기 자신을 `--foreground` 로 띄우고 `unref` 한다. 자식이 `loop.json` 에 자기 pid 를 쓸 때까지 10초까지 기다린다 | `LOOP-STARTED <pid> run=<Run id 또는 ->` 와 0. 10초 안에 쓰지 않으면 `LOOP-START-FAIL <이유>` 와 1 |
| `--start`, 살아 있는 루프가 있다 | 띄우지 않는다. 요청한 Run 이 기존 루프의 Run 과 같든 다르든 같다 | `LOOP-RUNNING <pid> run=<기존 Run id 또는 ->` 와 4. Run 이 다르면 코디네이터가 `--stop` 뒤 다시 `--start` 한다 |
| `--stop` | `loop.json` 의 pid 에 TERM 을 보내고 20초까지 끝나기를 기다린다 | `LOOP-STOPPED <pid>` 와 0, 루프가 없으면 `LOOP-NOT-RUNNING` 과 0, 20초 뒤에도 살아 있으면 `LOOP-STOP-TIMEOUT <pid>` 와 1 |
| `--status` | `loopStatus` | `LOOP-ALIVE <pid> run=<…> last_tick=<…> alive_at=<…>` 와 0, `LOOP-DEAD <repo> <이유>` 와 1 |
| `--foreground` | 지금 프로세스에서 틱을 돈다. `--start` 의 자식과 테스트가 쓴다 | 신호를 받으면 `stopChildren` 뒤 128 + 신호 번호 |
| `--once` | `--foreground` 와 함께 틱 한 번만 돌고 끝난다 | 0 |

사용법 오류와 설정 오류(`ConfigError`)는 2 다. `pipeline.tick_sec` 이 양수가 아니면 설정 오류다. 기본은 300 이다.

**한 저장소에 하나**: `--foreground` 는 시작할 때 `loop.lock` 을 `wx` 로 만들어 자기 pid 를 적고, 끝날 때 자기 pid 가 든 잠금만 지운다. 죽은 pid 의 잠금은 `reclaim` 으로 회수한다. 살아 있는 pid 가 쥐고 있으면 `LOOP-RUNNING` 과 4 다. `--start` 의 판정도 이 잠금과 `loopStatus` 로 한다.

**Run id**: `--run`, 없으면 `config.json` 의 `finish.run` 이다. 둘 다 없으면 질문 확인을 건너뛰고, 시작할 때 `경고: Run id 가 없어 질문 확인을 건너뛴다. --run 이나 finish.run 으로 준다` 한 줄을 로그에 낸다. `loop.json` 의 `run` 은 null 이다. 지시서 폴더는 `--specs-dir`, 없으면 `finish.specs_dir` 이고, 둘 다 없으면 정리에 `--specs-dir` 를 넘기지 않는다.

**로그**: 루프의 모든 줄은 `log()` 한 함수로 `loop.log` 에 붙이고 stdout 에도 쓴다. 붙이기 전에 1MB 를 넘으면 `loop.log.1` 로 돌린다. `--start` 의 자식은 `stdio: 'ignore'` 라 stdout 은 버려진다. 파일 서술자를 자식에 넘기지 않는 것은 돌린 뒤에도 자식이 `loop.log.1` 에 쓰게 되기 때문이다. 잡지 않은 예외와 거부된 promise 는 `log()` 로 스택을 남기고 1 로 끝난다.

**틱**: 하나가 끝나면 `tick_sec` 을 기다린 뒤 다음 틱을 돈다. 겹치지 않는다. 한 틱이 하는 일(순서대로, 하나가 실패해도 다음을 한다):

1. 질문 확인. Run id 가 있을 때만. `poll(run, questions-seen.json, now, 600, repo)` 를 부르고 알릴 줄마다 `log()` 로 `QUESTION` 이나 `REMINDER` 줄을 쓰고 `notifyQuestion` 을 부른다. `REMINDER` 는 `appendEvent(repo, 'REMINDER', null, <줄>)` 도 한다. 재알림 간격 600초는 `watch-questions.ts` 의 기본과 같다
2. 정리. `scriptCommand(CLEANUP_SWEEP 또는 <이 폴더>/cleanup-sweep.ts, ['--repo', repo, '--kill-holders', '--remote-branches', '--apply', ...(run ? ['--run', run] : []), ...(specsDir ? ['--specs-dir', specsDir] : [])])` 를 `runAsync` 로 부르고 출력을 `log()` 로 옮긴다
3. 보드 동기화. `boardPath(repo)` 파일이 없으면 건너뛴다. 있으면 `scriptCommand(BOARD_SYNC 또는 <이 폴더>/board-sync.ts, ['--repo', repo])` 를 `runAsync` 로 부른다
4. `tick` 이벤트. 입력은 `tick`(이 프로세스가 돈 틱 수, 1 부터)과 `open_prs`(내 열린 PR 번호 목록)다. 열린 PR 은 `gh pr list --state open --json number,author,url` 로 읽고 `ownAuthors`, `isOwnPr` 로 내 PR 만 남긴다. 읽지 못하거나 작성자를 정하지 못하면 `open_prs` 는 null 이다

각 틱 끝에 `loop.json` 의 `last_tick`, `ticks` 를 쓴다.

**생존 타이머**: 부모 프로세스가 틱 자식과 따로 `setInterval` 로 30초마다 `loop.json` 의 `alive_at` 을 쓴다. 시작할 때도 한 번 쓴다. 간격은 `ORCH_LOOP_ALIVE_SEC` 환경 변수(양수 초)로 바꾼다. 테스트가 줄여 쓰는 값이다.

**`loop.json`**: `pid`, `run`, `repo`, `tick_sec`, `started_at`, `alive_at`, `last_tick`, `ticks`, `errors` 다. 시각은 ISO 8601 UTC 다. phase 02 가 `ci` 를 더한다.

**오류 줄 억제**: `errors` 는 출처마다 마지막 오류 이유다. 출처는 `questions`(질문 조회), `cleanup`(정리 명령이 0 이 아닌 종료), `board`(보드 동기화가 0 이 아닌 종료), `prs`(열린 PR 조회), `hook`(tick 핸들러)이다.

- 출처의 이유가 이전과 다를 때만 알림 파일에 쓴다. `hook` 은 `HOOK-FAIL tick <종료 코드, timeout, lock>`, 나머지는 `WATCH-ERROR <출처>: <이유>` 다
- 그 출처가 한 번 성공하면 이유를 지운다. 다시 실패하면 다시 쓴다
- 알림 파일에 쓰는 `HOOK-FAIL` 은 `tick` 핸들러의 것만이다. `worker-question` 핸들러의 실패는 `loop.log` 의 `HOOK-FAIL` 줄로만 남는다
- `loop.log` 에는 실패할 때마다 쓴다

머리 주석은 사용법, 옵션, 위 판정, 환경 변수(`ORCA`, `GH`, `CLEANUP_SWEEP`, `BOARD_SYNC`, `ORCH_LOOP_ALIVE_SEC`), 종료 코드를 소유한다. 이벤트 입력은 `docs/data-schema.md` 「이벤트별 필드」 를 가리킨다.

### 5. `wait-important.ts` 가 알림 파일로 깨어난다

`--loop-repo DIR` 를 받는다(여러 번). 주지 않으면 지금 동작 그대로다. 주면 대기를 시작할 때와 `--lost-interval-sec` 간격의 확인마다 저장소 순서대로 아래를 본다. 간격이 0 이면 시작할 때만 본다. 끊긴 worker 확인(종료 코드 5)이 먼저다.

| 상황 | 출력과 종료 코드 |
| --- | --- |
| `readEvents` 가 줄을 냈다 | 줄마다 `LOOP-EVENT <kind> <pr 또는 -> <text>` 를 모두 내고, `gap` 이 있으면 그 앞에 `LOOP-EVENT GAP - seq <a>..<b> 를 잃었다` 를 낸다. 그다음 마지막 `seq` 로 커서를 쓰고, `check --wait` 그룹을 끝낸 뒤 `LAST_DELIVERY <id>` 와 종료 코드 7. 커서를 쓰지 못하면 `WATCH-ERROR` 줄을 더 내고 그래도 7 이다. 줄은 이미 냈으므로 다음 대기가 같은 줄을 다시 낼 수 있다 |
| `loopStatus` 가 죽었다 | `LOOP-DEAD <repo> <이유>`, `LAST_DELIVERY <id>` 와 종료 코드 8 |

한 번 깨어나면 끝난다. 알림 줄이 있으면 그 저장소의 죽음보다 먼저 낸다. 다음 대기가 죽음을 낸다.
머리 주석의 사용법, 옵션, 출력, 종료 코드 표에 위를 더한다.

### 6. `orch-doctor.ts` 의 `session-resume`

`--run` 을 주면 `loopStatus(<--repo 의 주 checkout>, now)` 로 `loop_alive` 를 채운다. 죽었으면 `LOOP-DEAD <repo> <이유>` 줄과 다음 줄에 다시 띄울 명령 `node --disable-warning=ExperimentalWarning "<스킬 디렉터리>/scripts/orch-loop.ts" --repo <repo> --run <run> --start` 를 낸다. 종료 코드는 바꾸지 않는다.
머리 주석의 「loop_alive 늘 false 다」 를 고친다.

### 7. 문서

- `orch/README.md`: 스크립트 목록에 `` `scripts/orch-loop.ts` `` 줄을 더한다. 저장소마다 하나 도는 상주 루프이고, 틱마다 질문 확인, 정리, 보드 동기화, `tick` 이벤트를 한다는 한 문장이다
- `docs/data-schema.md` 「orch 루트에 더하는 파일」: `state/loop.json` 행을 위 필드로, `state/loop-events.jsonl` 행을 위 형식(`seq`, `time`, `kind`, `pr`, `text`)과 자르기 규칙과 커서 규칙(마지막으로 읽은 `seq`)으로 고친다. `kind` 는 `REMINDER`, `WATCH-ERROR`, `HOOK-FAIL`, `CI-FAILED`, `CONFLICT-ORPHAN` 이고 `CI-MISSING` 은 `ci-missing` 을 낼 때 더한다고 적는다. `state/loop.lock` 행(한 저장소에 루프 하나, 끝나면 푼다, 죽은 pid 는 회수)을 더한다. `state/loop.log` 행은 그대로다
- `docs/data-schema.md` 「이벤트별 필드」 의 `tick` 행: `open_prs` 는 읽지 못하면 null 이라고 더한다
- `docs/flow.md` 「갈래」 의 「상주 루프가 죽었거나 틱이 멈췄다」 행: 판정을 위 「생존」(`alive_at` 이 `max(3 × tick_sec, 120)` 초보다 오래됐거나 pid 가 죽었다)으로 고친다. 「같은 저장소에 루프를 둘 띄운다」 행에 `state/loop.lock` 과 다른 Run 이면 `--stop` 뒤 다시 띄운다는 것을 더한다
- `docs/code-architecture.md` 「배치」: `orch/scripts/lib/loop.ts` 줄(루프 상태, 생존 판정, 알림 파일과 커서 한 벌. 사용처는 머리 주석이 소유한다)을 더하고, `lib/questions.ts` 줄을 「미답변 질문 조회, 재알림 판정과 알린 기록 한 벌」 로 고친다

### 8. 테스트

`orch/tests/lib-loop.spec.ts` 를 만든다. 임시 orch 루트(`ORCH_DIR`)에 `loop.json` 을 직접 쓴다.

| 사례 | 기대 |
| --- | --- |
| pid 가 `process.pid`, `alive_at` 이 10초 전, `last_tick` 이 65분 전, `tick_sec` 300 | 살아 있다. `send-to-worker` 가 이어 쓰기를 기다리는 긴 틱이다 |
| `alive_at` 이 `max(3 × tick_sec, 120)` 초보다 오래됐다(`tick_sec` 10 이면 121초 전) | 죽었다. 이유에 `alive_at` |
| 끝난 자식 프로세스의 pid | 죽었다 |
| `loop.json` 이 없다 | 죽었다. 이유 `없음` |
| `appendEvent` 세 번 뒤 커서 0 과 커서 3 에서 `readEvents` | 세 줄, 빈 목록 |
| 1005 줄을 더하고 커서가 1000 일 때 | 파일은 1000 줄이고 `readEvents` 는 `seq` 1001 부터 1005 까지 한 번씩 낸다. 커서를 1005 로 쓴 뒤 다시 읽으면 빈 목록이다(잘라 낸 뒤에도 잃거나 다시 받지 않는다) |
| 1005 줄을 더하고 커서가 2 일 때 | `gap` 이 3..5 다 |
| 알림 파일을 지우고 커서 7 에서 새로 쓰는 쪽이 `appendEvent` | 새 줄의 `seq` 가 8 이다 |

`orch/tests/orch-loop.spec.ts` 를 만든다. `--foreground --once` 로 돌린다. 가짜 orca 와 gh 는 `ORCA`, `GH`, 가짜 정리와 보드 동기화는 `CLEANUP_SWEEP`, `BOARD_SYNC` 로 준다. 가짜 명령은 받은 인자를 파일에 적는다. 핸들러가 받은 입력은 핸들러가 stdin 을 파일에 적게 해서 본다.

| 사례 | 기대 |
| --- | --- |
| `questions-seen.json` 에 700초 전에 알린 미답변 질문 | `loop-events.jsonl` 에 `REMINDER` 한 줄. `worker-question` 핸들러가 `reminder: true` 를 받는다 |
| 처음 보는 미답변 질문 | `loop.log` 에 `QUESTION` 줄. 알림 파일에는 쓰지 않는다 |
| orca 조회 실패 | `WATCH-ERROR questions: …` 한 줄. 정리와 보드 동기화는 그래도 불린다. 같은 실패로 한 번 더 `--once` 하면 알림 파일에 줄이 늘지 않는다. 한 번 성공한 뒤 다시 실패하면 한 줄 더 쓴다 |
| `hooks/tick.ts` 가 1 로 끝난다, 두 번 | `HOOK-FAIL tick 1` 한 줄 |
| `config.json` 에 `finish.run`, `finish.specs_dir` 와 다른 `finish` 키 | 정리 명령이 `--kill-holders --remote-branches --apply --run <run> --specs-dir <dir>` 와 함께 불린다. `loop.json` 에 `last_tick`, `alive_at` 이 쓰인다 |
| `--run` 도 `finish.run` 도 없다 | 경고 줄 하나, orca `check` 호출 없음, `loop.json` 의 `run` 은 null, 정리 명령에 `--run` 이 없다 |
| 보드 파일이 없다 | 보드 동기화 명령이 불리지 않는다 |
| `tick` 핸들러의 입력 | `tick` 이 1, `open_prs` 가 가짜 gh 의 내 PR 번호만이다. gh 가 실패하면 `open_prs` 는 null |
| 정리 가짜가 1.5초 자고 `ORCH_LOOP_ALIVE_SEC=0.2` | 정리가 도는 동안 `alive_at` 이 두 번 이상 바뀌고 `last_tick` 은 그대로다 |
| 틱 자식 안의 동기 조회가 막힌다(가짜 orca 가 2초 자고 `ORCH_LOOP_ALIVE_SEC=0.2`) | 그동안에도 부모가 `alive_at` 을 쓴다 |
| 틱 자식이 JSON 줄 없이 3 으로 끝난다 | `errors.tick` 이 그 종료 코드를 담고, 다음 틱은 그대로 돈다 |
| `--start`, `--status`, `--stop` 을 차례로 | `LOOP-STARTED <pid>`, `LOOP-ALIVE <pid>`, `LOOP-STOPPED <pid>`. 그 뒤 pid 가 죽어 있다. `tick_sec` 은 설정으로 크게 둔다 |
| 살아 있는 루프가 있는데 다른 `--run` 으로 `--start` | 종료 코드 4 와 `LOOP-RUNNING <pid> run=<기존 Run id>` |
| `pipeline.tick_sec` 이 0 | 종료 코드 2 |

`orch/tests/wait-important.spec.ts` 에 사례를 더한다. 가짜 orca 의 `check --wait` 는 끝나지 않게 둔다.

- 알림 파일에 커서 뒤 두 줄 → `LOOP-EVENT` 두 줄, 마지막 줄 `LAST_DELIVERY`, 종료 코드 7, 커서가 마지막 `seq` 다
- 다시 걸면 그 두 줄을 내지 않는다
- `alive_at` 이 오래된 `loop.json` → `LOOP-DEAD <repo>`, 종료 코드 8
- `--loop-repo` 가 없으면 알림 파일이 있어도 보지 않는다

`orch/tests/orch-doctor.spec.ts` 에 사례를 더한다: 죽은 pid 의 `loop.json` 이면 `LOOP-DEAD` 줄과 `orch-loop.ts … --start` 줄, `session-resume` 입력의 `loop_alive` 가 false. 살아 있는 `loop.json`(pid 는 `process.pid`, 새 `alive_at`)이면 true.
`orch/tests/questions.spec.ts` 의 기존 사례가 옮긴 `poll` 로 통과한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/lib-loop.spec.ts orch/tests/orch-loop.spec.ts orch/tests/wait-important.spec.ts orch/tests/orch-doctor.spec.ts orch/tests/questions.spec.ts orch/tests/finish-pr.spec.ts orch/tests/readme-script-list.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 korean-check/scripts/korean-style-check.py orch/README.md docs/data-schema.md docs/flow.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 신규 |
| `orch/scripts/lib/loop.ts` | 신규 |
| `orch/scripts/lib/questions.ts` | 수정 |
| `orch/scripts/watch-questions.ts` | 수정 |
| `orch/scripts/lib/finish-options.ts` | 수정 |
| `orch/scripts/finish-pr.ts` | 수정 |
| `orch/scripts/wait-important.ts` | 수정 |
| `orch/scripts/orch-doctor.ts` | 수정 |
| `orch/tests/lib-loop.spec.ts` | 신규 |
| `orch/tests/orch-loop.spec.ts` | 신규 |
| `orch/tests/questions.spec.ts` | 수정 |
| `orch/tests/wait-important.spec.ts` | 수정 |
| `orch/tests/orch-doctor.spec.ts` | 수정 |
| `orch/README.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
