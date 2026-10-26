# Phase 02. 상주 루프의 자동 머지 단계

**Execution profile**: deep

## 목표

`orch/scripts/orch-loop.ts` 의 틱에 「자동 머지」 단계를 더한다. `queue.auto_merge` 가 true 일 때만 돌며, 대상 PR 을 골라 마이그레이션을 검사하고 순서를 정해 `merge-with-finish.ts` 를 분리 실행한다.
이미 건 큐의 끝을 보고 알리고, 기록은 `state/auto-merge.json` 에 둔다.

**범위 외**: 판정 함수(phase 01 의 `lib/auto-merge.ts` 를 쓴다). 스킬 문서(phase 03). 번호 예약 명령(다음 plan).

## 컨텍스트

- 틱의 순서와 오류 억제는 `orch/scripts/orch-loop.ts` 머리 주석의 「틱」, 「오류 줄 억제」 다. 공유 일의 오류 출처는 `SHARED_SOURCES` 이고 `report(source, reason, opts)` 로 쓴다.
- 이번 틱의 내 열린 PR 은 `openPrs` 의 `OwnPr`(number, branch, head, draft, base, url, host, slug) 이고, CI 판정은 `watchCi` 가 돌려준 `ci` 맵(`{head, state}`)이다.
- 이번 틱이 맡는 Run 과 지시서 폴더는 `tickRuns(ctx)` 의 `TickRun`(run, specsDir) 이다. 상대 경로 지시서 폴더는 저장소 기준이다(`lib/last-pr.ts` 의 `rulesFrom` 과 같다).
- 지시서 읽기: `lib/last-pr.ts` 의 `specFiles(dir)`, `lib/spec.ts` 의 `branchesOf(text)`. 보드: `lib/paths.ts` 의 `boardPath(repo)`, `lib/board.ts` 의 `findBoardItems(file, pr, branch, null)` 와 `readBoard(file)`.
- 미해결 스레드: 머지 큐의 기본 `--threads-cmd` 와 같은 명령을 쓴다. `merge_queue.ts` 의 `review_threads.py` 경로 찾기(`${HERE}/../../review-fix/scripts/review_threads.py`)와 같은 자리다.
- 알림: `lib/loop.ts` 의 `appendEvent(repo, kind, pr, text, run)`. gh 호출: `lib/gh.ts` 의 `ghJson`. 명령 실행: `lib/proc.ts` 의 `run`, `runAsync`, `scriptCommand`.
- 분리 실행 예: `merge-with-finish.ts` 의 `launch`(spawn detached, stdio 를 파일 서술자로, unref).
- 테스트 짜임 예: `orch/tests/orch-loop-ci.spec.ts`(가짜 gh 는 `tests/fixtures/fake-bin.ts`, 가짜 orca, `--foreground --once` 를 여러 번).

**근거 문서**: `docs/adr/016-orch-auto-merge.md`, `docs/flow.md` 의 「상주 루프의 자동 머지」, `docs/data-schema.md` 의 `state/auto-merge.json` 행과 `state/loop-events/<Run>.jsonl` 행.

## 의도 메모

- 큐는 저장소에 하나만 둔다. 루프가 건 큐가 살아 있거나 `merge_queue` 가 든 프로세스가 하나라도 있으면 그 틱에는 걸지 않는다. 두 큐가 같은 base 를 움직이면 서로의 최신화 판정이 무효가 된다.
- 같은 (PR, HEAD) 는 한 번만 건다. 큐가 멈춘 PR 을 틱마다 다시 걸면 같은 이유로 계속 멈춘다.
- 업무의 마지막 PR 표시(`!`, `~`)는 붙이지 않는다. 마무리가 ADR-014 대로 판정한다.
- 큐를 건 뒤의 판정(필수 체크, 스레드, mergeable)은 머지 큐가 다시 한다. 루프의 판정은 멈출 큐를 걸지 않으려는 앞 단계다.

## 작업 항목

### 1. `orch/scripts/orch-loop.ts` 머리 주석

- 첫 줄의 틱이 하는 일 목록에 자동 머지를 더한다.
- 「틱」 의 단계 목록에서 8 을 「자동 머지. 아래 「자동 머지」」 로 두고 충돌 처리를 9 로 민다. 7 의 문장 「충돌 처리 … 마지막에 둔다」 는 9 로 옮긴다.
- 새 절 「자동 머지」 를 「충돌 처리」 앞에 둔다. 아래 2~6 의 동작, 알림 kind 와 text, 상태 파일, 환경 변수를 적는다.
- 「오류 줄 억제」 의 공유 출처 목록과 `SHARED_SOURCES` 에 `auto-merge` 를 더한다.
- 「설정」 에 `queue.auto_merge`, `queue.auto_review`, `migrations.*` 를 더한다(읽기는 `lib/auto-merge.ts` 의 `autoMergeConfig`).
- 「환경 변수」 에 `MERGE_WITH_FINISH`(기본 이 폴더의 merge-with-finish.ts), `THREADS_CMD`(미해결 스레드 수를 내는 bash 명령. 환경 변수 OWNER, REPO, PR, GH_HOST 를 받는다. 기본은 review_threads.py), `PS`(프로세스 목록 명령. 기본 `ps`)를 더한다.

### 2. 설정과 단계 자리

- `Context` 에 `autoMerge: AutoMergeConfig` 를 더하고 `context()` 에서 `autoMergeConfig(config)` 로 채운다. ConfigError 는 지금처럼 종료 코드 2 다.
- `tick()` 의 7(tick 이벤트) 뒤, 충돌 처리 앞에 `if (prs.ok && ctx.autoMerge.enabled)` 로 `autoMerge(ctx, prs.mine, ci ?? {}, runs)` 를 부르고 결과의 오류 이유를 `report('auto-merge', reason)` 로 쓴다. 예외도 같은 출처로 쓴다. `auto_merge` 가 false 거나 열린 PR 을 읽지 못한 틱은 `report('auto-merge', null)` 도 부르지 않고 이전 값을 둔다.

### 3. 상태 파일 `state/auto-merge.json`

`docs/data-schema.md` 의 행대로 `ready`, `tried`, `clashes`, `blocked`, `queue` 를 읽고 쓴다. 파일이 없거나 깨졌으면 빈 기록이다. 쓰기는 옆 파일에 쓰고 rename 한다.
`lib/loop.ts` 의 `replace` 와 같은 네 줄이다(파일이 없으면 `makeParent`, `<file>.<pid>.tmp` 에 쓰기, `renameSync`). 그 함수는 내보내지 않는다.
단계 시작에 이번 틱의 내 열린 PR 번호에 없는 PR 의 `ready`, `blocked` 항목과 `tried`, `clashes` 의 `<PR>@…` 키를 지운다.
큐 로그는 `state/auto-merge/<YYYYMMDDTHHMMSSZ>.log` 에 둔다. queue 폴더(`pathOf('queue', repo)`)에 두면 틱 4단계의 cleanup-sweep 이 끝난 `*.log` 를 휴지통으로 옮겨(`lib/queue-logs.ts`) 끝을 읽기 전에 사라진다.
단계 시작에 이 폴더에서 마지막으로 바뀐 지 7일이 넘은 `.log` 를 지운다. `queue` 기록이 가리키는 로그는 지우지 않는다.
한 단계의 오류 이유가 여럿이면 `; ` 로 잇는다(`handleConflicts` 와 같다).

### 4. 앞선 큐와 도는 큐

1. `PS` 로 `-Ao pid=,command=` 를 읽는다. ps 가 0 이 아니면 오류 이유 `프로세스 목록을 읽지 못했다` 로 단계를 끝낸다.
2. `queue` 기록이 있으면 그 pid 가 ps 출력에 있고 그 명령줄에 `merge-with-finish.` 가 들었는지 본다. 없으면 끝난 큐다. pid 를 다른 프로세스가 다시 받았을 수 있어 `alive` 만으로 보지 않는다.
   끝났으면 로그에서 `QUEUE-DONE`, `QUEUE-HELD` 로 시작하는 마지막 줄, 없으면 `STOP ` 으로 시작하는 마지막 줄, 그것도 없으면 `끝 줄 없음` 을 끝 줄로 정한다. 머지 큐는 끝 줄 뒤에 after-queue 와 정리 출력을 같은 로그에 이어 쓰므로 마지막 줄이 끝 줄이 아니다.
   `AUTO-MERGE-END`(pr null, text `<끝 줄> log=<로그 경로>`, 로그를 읽지 못하면 끝 줄 자리에 `로그 없음`)를 기록의 run 으로 쓰고 기록을 비운다. 아직 돌면 이 틱에는 걸지 않는다.
3. 명령줄에 `merge_queue.`, `merge-queue.sh`, `merge-with-finish.` 가운데 하나가 든 줄이 있으면 걸지 않는다. 머신 전체를 보므로 다른 저장소의 큐나 테스트 실행도 막는다. 거는 쪽으로는 틀리지 않으므로 그대로 둔다.

### 5. 대상과 판정

1. 맡은 Run 가운데 Run id 와 지시서 폴더가 둘 다 있는 칸마다 지시서 폴더의 `specFiles` 와 `branchesOf` 로 브랜치에서 `{run, hold}` 로 가는 맵을 만든다(앞 Run 이 먼저). hold 는 `specHold(text)`.
   Run id 가 없는 칸(등록도 `--run` 도 `finish.run` 도 없는 루프)은 보지 않는다. 큐의 `--run` 과 알림의 Run 을 정할 수 없기 때문이다.
   보드 파일(`boardPath(repo)`)이 있으면 `readBoard` 로 한 번 읽는다. 읽지 못하면 오류 이유 `보드를 읽지 못했다: <이유>` 를 남기고 이 틱에는 걸지 않는다. 보류 표시를 놓친 채 걸지 않으려는 것이다.
2. 내 열린 PR 가운데 브랜치가 맵에 있는 것만 본다. 아래를 차례로 보고, 처음 걸린 이유로 `AUTO-MERGE-WAIT #<PR> <이유>` 를 로그에만 쓰고 넘어간다.
   draft(`draft`), CI(`ci[번호]` 가 없거나 head 가 다르거나 passed 가 아님 → `CI <상태>`), 이미 건 HEAD(`tried` 에 `<PR>@<head>`), 지시서 보류(`지시서 보류: <이유>`), 보드 보류(`boardHold` → `보드 보류: <text>`), 미해결 스레드(`THREADS_CMD` 결과가 0 이 아님 → `미해결 스레드 <n>`. 명령 실패는 오류 이유), 리뷰(`ctx.autoMerge.review` 가 있을 때 `gh pr view <PR> --json reviews,comments,files` 의 `reviews[].body/submittedAt` 와 `comments[].body/createdAt` 로 `reviewVerdict`. block 이면 `리뷰 보류`, none 이면 `리뷰 대기`).
   `files` 는 리뷰 판정을 하지 않아도 마이그레이션이 있으면 같은 호출로 읽는다. gh 조회가 실패하면 오류 이유로 남기고 그 PR 은 넘어간다.
   보드 보류는 1 에서 읽은 항목으로 본다. 그 PR 의 항목은 `findBoardItems(file, 번호, 브랜치, null)` 의 ids 다.
   마무리(`finish-<PR>.pid`)가 살아 있는지는 보지 않는다. 마무리는 머지를 180분까지 기다려, 큐가 그 PR 을 보류한 뒤에도 살아 있다. 그 조건을 두면 worker 가 고쳐 push 해도 몇 시간 다시 걸리지 않는다.
   merge-with-finish 는 이미 도는 마무리를 그대로 쓰므로 다시 걸어도 마무리가 겹치지 않고, 도는 큐는 4 의 ps 검사가 막는다.
3. 통과한 PR 은 `ready[번호]` 를 `{head, at}` 로 둔다. 같은 head 면 `at` 을 그대로 둔다.

### 6. 마이그레이션, 순서, 띄우기

1. `ctx.autoMerge.dirs` 가 비지 않았고 준비된 PR 가운데 `changeType` 이 `ADDED`, `RENAMED`, `COPIED` 이거나 없는(옛 gh 출력) 파일에 `migrationOf` 가 있는 PR 이 있으면 아래를 한 번씩 한다.
   PR 의 base 마다 한 번 `git fetch --quiet origin <base>` 뒤 모듈 폴더마다 `git ls-tree -r --name-only origin/<base> -- <폴더>` 로 `maxByModule`. `gh pr list --state open --limit 200 --json number,baseRefName,files` 로 같은 base 의 다른 열린 PR 의 마이그레이션.
   실패하면 오류 이유로 남기고 마이그레이션이 있는 PR 은 이 틱에 걸지 않는다.
2. `judgeMigrations` 의 clashes 가 있으면 걸지 않는다. 이유를 `<모듈> <label>: <이유>` 로 만들어 `; ` 로 잇고, `clashes[<PR>@<head>]` 와 다를 때만 `MIGRATION-CLASH`(pr 그 번호, text 그 이유)를 그 PR 의 Run 으로 쓴다.
3. lower 가운데 그 PR 번호가 걸 후보에 없는 것이 있으면 걸지 않고 기다린다. 걸 후보는 처음에 clash 가 없는 준비된 PR 이고, 4 와 5 가 PR 을 뺀 뒤 다시 본다(아래 5). `blocked[번호]` 를 `{head, since, fired}` 로 둔다(head 가 같으면 since 를 둔다).
   기다린 시간이 `blockedAfterSec` 를 넘고 fired 가 아니면 `MIGRATION-BLOCKED`(pr 기다리는 PR, text `<모듈> <label> 이 #<막는 PR> <막는 label> 을 <분>분 기다린다. #<막는 PR> 의 번호를 뒤로 미는 재예약을 검토한다`)를 쓰고 fired 를 true 로 둔다. 막힘이 풀린 PR 은 항목을 지운다.
4. 남은 PR 마다 `beforeCommand(그 PR 의 마이그레이션 모듈, ctx.autoMerge.before)`. ok 가 false 면 걸지 않고 오류 이유 `#<PR> 의 모듈 <모듈> 에 migrations.before 규칙이 없다`.
5. `queueOrder` 로 순서와 묶음을 정한다. 첫 PR 의 Run 을 큐의 Run 으로 하고 그 Run 의 PR 만 남긴다.
   그 뒤 3 의 lower 판정을 남은 집합으로 다시 한다. 빠진 PR 이 lower 인 PR 도 빼고, 집합이 더 바뀌지 않을 때까지 3 에서 5 를 되풀이한다.
   예: Z(Run A, 마이그레이션 없음), Y(Run B, api V3), X(Run A, api V4) 가 모두 준비되면 순서는 [Z, Y, X] 이고 Run A 만 남는다. X 는 Y 가 빠져 lower 가 되므로 빼고 Z 만 건다. 되풀이로 빠진 PR 은 `blocked` 에 두지 않는다. 다음 틱에 다시 본다.
   묶음도 남은 PR 로 줄이고 둘 미만이면 뺀다.
6. 인자: `--repo <repo> --run <Run> --continue-on-hold`, 묶음마다 `--chain a,b`, `sweepArgs(config 의 queue.sweep_args, Run)` 이 null 이 아니면 항목마다 `--sweep-arg <값>`, PR 마다 `<번호>` 나 `<번호>:<명령>`.
   띄우기 직전에 4.1 의 ps 를 한 번 더 읽고 4.3 에 걸리면 띄우지 않는다. 판정하는 사이 코디네이터가 큐를 걸었을 수 있다.
   `MERGE_WITH_FINISH`(기본 `join(HERE, 'merge-with-finish.ts')`)를 `scriptCommand` 로, 작업 디렉터리 repo, stdin 무시, stdout 과 stderr 는 3 의 로그 파일로, detached 와 unref 로 띄운다. 띄우지 못하면 오류 이유.
7. 띄웠으면 `queue` 기록을 `{pid, log, run, prs, at}`, `tried[<PR>@<head>]` 를 지금 시각으로 두고 `AUTO-MERGE`(pr null, text `#<a> #<b> run=<Run> log=<로그 경로>`)를 그 Run 으로 쓰고 같은 줄을 로그에도 쓴다.

### 7. `orch/tests/orch-loop-auto-merge.spec.ts` (신규)

`orch-loop-ci.spec.ts` 의 짜임을 따른다. 가짜 gh(`tests/fixtures/fake-bin.ts`)가 `pr list`(내 PR, 롤업 통과, 작성자), 규칙 조회, `api user`, `pr view --json reviews,comments,files`, `pr list --json number,baseRefName,files` 에 답한다.
가짜 `MERGE_WITH_FINISH` 는 파일 이름을 `fake-merge-with-finish.ts` 로 둔다(4.2 가 명령줄의 `merge-with-finish.` 로 도는 큐를 알아보게). 먼저 받은 인자와 자기 pid 를 파일에 적고, 환경 변수 `FAKE_QUEUE_HOLD_MS`(기본 0)만큼 기다린 다음 `QUEUE-DONE` 을 낸 뒤 정리 출력 흉내로 두 줄(`정리: …`)을 더 내고 0 으로 끝난다. `THREADS_CMD` 는 파일의 숫자를 낸다.
`PS` 는 테스트가 정한 줄에 더해 실제 `ps -axo pid=,command=` 에서 가짜 큐의 pid 줄만 골라 낸다(그래야 4.2 가 도는 큐를 알아본다). 테스트가 정한 줄의 기본은 빈 목록이다.
저장소는 임시 git 저장소와 bare origin 이고, `.orch/config.json` 에 `queue.auto_merge: true`, `finish.run`(예 `run_t`), `finish.specs_dir` 를 두고 지시서 `spec-a.md` 에 `브랜치:` 줄을 둔다. 루프는 `--run` 없이 띄워 `finish.run` 을 쓴다. 각 테스트는 `--foreground --once` 를 돌리고 가짜 큐의 인자와 `state/loop-events/<Run>.jsonl` 을 단언한다.

- 대상 고르기: 지시서에 든 브랜치의 통과한 PR 은 `--run <Run> --continue-on-hold <번호>` 로 걸리고 `AUTO-MERGE` 가 쓰인다. 지시서에 없는 브랜치의 PR, draft, CI pending, 스레드 1 인 PR 은 인자에 없다. `auto_merge` 가 false 면 가짜 큐가 불리지 않는다.
- 리뷰: `auto_review` 를 두고 마지막 리뷰 본문이 block 이면 걸리지 않고, pass 면 걸린다.
- 보류 표시: 지시서의 `- 머지 보류: 배포 뒤` 줄, 보드 항목(pr 칸에 그 번호)의 끝나지 않은 `머지 보류` 줄은 각각 걸리지 않는다.
- 다시 걸지 않음: 첫 틱 뒤 가짜 큐의 인자 파일이 생기고 적힌 pid 가 끝날 때까지 기다린 다음 같은 HEAD 로 두 번째 틱을 돌린다. 가짜 큐가 한 번만 불렸고, `AUTO-MERGE-END` 의 text 가 `QUEUE-DONE log=` 로 시작한다(정리 줄이 뒤에 있어도). HEAD 를 바꾼 세 번째 틱에는 다시 걸린다.
- 큐가 도는 동안: `FAKE_QUEUE_HOLD_MS` 를 길게(예 5000) 두고 첫 틱 바로 뒤 HEAD 를 바꿔 두 번째 틱을 돌리면 `AUTO-MERGE-END` 가 없고 가짜 큐가 한 번만 불렸다. 테스트 끝에 가짜 큐 pid 를 끝낸다. `PS` 가 `node merge_queue.ts 9` 줄을 내면 걸지 않는다.
- 마이그레이션 겹침: base 에 `db/api/V2__a.sql` 이 있고 PR 이 `db/api/V1__b.sql` 을 더하면 걸리지 않고 `MIGRATION-CLASH` text 가 `api V1: base 최고 V2 이하` 다. 다른 열린 PR 이 같은 `V3` 를 더해도 `#<그 PR> 과 같은 번호` 로 알린다. 같은 틱을 다시 돌려도 같은 알림은 한 번이다.
- 순서: 준비된 PR 둘이 `db/api/V4__x.sql`(먼저 준비), `db/api/V3__y.sql` 을 더하면 인자 순서가 V3 의 PR, V4 의 PR 이고 `--chain <V3 PR>,<V4 PR>` 이 있다. `migrations.before` 가 `{"*": "backup {module}"}` 이면 PR 인자가 `<번호>:backup api` 다.
- 여러 Run: 등록된 Run 둘(`state/loop-runs/` 에 등록 파일. 앞 Run 은 `finish.run` 과 같은 id 에 `registered_at` 을 `2026-01-01T00:00:00Z`, 뒤 Run 은 다른 id 에 `2026-01-02T00:00:00Z`. 루프가 시작할 때 `finish.run` 을 다시 등록해도 이미 있어 차례가 바뀌지 않는다)의 지시서 폴더에 각각 브랜치를 두고, 앞 Run 의 마이그레이션 없는 PR, 뒤 Run 의 V3 PR, 앞 Run 의 V4 PR 이 모두 준비되면 큐 인자에 마이그레이션 없는 PR 만 있다.
- 보드 깨짐: 보드 파일이 JSON 이 아니면 걸지 않고 `WATCH-ERROR` 의 text 가 `auto-merge: 보드를 읽지 못했다` 로 시작한다.
- 막힘: 다른 열린 PR(CI pending)이 V3 를, 준비된 PR 이 V4 를 더하면 걸리지 않는다. `blocked_after_sec` 를 1 로 두고 2초 뒤 다시 돌리면 `MIGRATION-BLOCKED` 가 한 번 쓰인다.
- 설정 오류: `queue.auto_merge: "yes"` 면 `--foreground --once` 가 종료 코드 2 다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-auto-merge.spec.ts orch/tests/lib-auto-merge.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

기대값: 둘 다 종료 코드 0. 기존 `orch-loop*.spec.ts` 가 깨지지 않는다(`auto_merge` 가 없으면 단계가 돌지 않는다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/tests/orch-loop-auto-merge.spec.ts` | 신규 |
