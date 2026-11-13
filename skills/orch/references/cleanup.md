# 7. 머지와 정리

**worker 가 일하는 중인지, 끝났는지, 사용자가 넘겨받았는지는 `scripts/lib/worker-state.ts` 한 곳이 정한다.** `cleanup-sweep.ts`, `orch-doctor.ts`, `lib/lost-workers.ts` 가 같은 판정을 쓰고, 입력과 판정 순서는 그 파일 머리 주석이 소유한다. 끝난 dispatch 위에 PR 이 MERGED 이거나, PR 이 없고 base 보다 앞선 커밋이 0 개면 치워도 된다. `user_takeover` 표시라도 화면이 에이전트 작업 중이면 일하는 중으로 본다.

`cleanup-sweep.ts` 와 `remove-worktree.ts` 는 삭제 전에 그 경로와 하위 경로의 터미널 소유 상태를 확인한다. 소유 상태를 읽는 범위와 방법, 끝난 dispatch 터미널의 `남김` 사유는 `scripts/lib/ownership.ts` 머리 주석이 소유한다. 터미널 목록이나 소유 상태를 읽지 못하면 빈 셸도 닫지 않고 남긴다.

`user_takeover` 는 사용자가 의도해 넘겨받은 터미널과, worker 의 claude 가 끝난 뒤 그 셸에 입력이 들어가 자동으로 기록된 터미널을 구분하지 못한다. 사용자 터미널을 잘못 닫는 것이 남기는 것보다 나쁘므로 기본은 남긴다.

## worker 터미널을 닫는 기본 경로

**worker 터미널을 닫는 기본 경로는 `orca orchestration worker-release --dispatch <id>` 다.** 이 문서가 소유하고, 다른 문서는 가리키기만 한다.
`worker-release` 는 끝난 worker 의 터미널 하나만 닫고 출력 보관본을 남긴다. 결과가 `retained` 이면 먼저 `worker-show --full` 의 `retainedReason` 으로 이유를 구분한다.
사용자가 Keep open(`worker-keep-open`, `--keep-open`)으로 남겼거나 사용자가 넘겨받은 터미널은 닫지 않는다. 직접 닫는 것은 신원 미확인(`identity_unproven`)처럼 Orca 가 소유를 증명하지 못했고, 사용자 보존이 아님이 확인된 터미널뿐이다.
그때만 아래 세 조건을 모두 확인한 뒤 `orca terminal close --terminal <handle>` 로 닫는다.

- 띄움 기록: 이 세션의 `launch-worker` 가 띄운 dispatch 이고 `worker-show` 의 `agentTerminalHandle` 이 그 터미널이다.
- 화면: `orca terminal read` 로 읽어 에이전트가 일하는 중이 아니고 사용자가 쓰는 흔적이 없다.
- 프로세스: 그 터미널에서 도는 프로세스가 worker 의 claude·codex 가 아니고 빈 셸이다.

Orca 의 판정을 그대로 믿지 않는다. Orca 가 새 세션에서 띄운 worker 를 `user_takeover` 로 적기도 한다(`scripts/cleanup/steps/worktrees.ts` 파일 맨 위 설명).
worker_done 을 받은 뒤 Orca 가 약 2분 뒤 자동으로 release 한다(`worker-show` 의 `autoReleaseAt`). 바로 정리할 때만 `worker-release` 를 부른다.
PR 이 머지될 때까지 같은 worker 가 이어 받아야 하면 자동 release 를 막는다. 띄울 때 `worker-start --keep-open` 을 주거나 이미 뜬 worker 에 `worker-keep-open --dispatch <id>` 를 부른다. 머지 뒤 `worker-release` 가 그 보존을 풀고 닫는다. 새 워크트리(`new-child`, `new-top-level`)에 띄운 worker 는 처음부터 열려 있다.

## 코디네이터가 띄운 터미널 정리

**`launch-worker.ts` 로 띄운 worker 의 끝난 터미널은 옵션 없이 알아본다.** 기록이 없는 터미널(사람이 연 것)은 그대로 남긴다. 조건은 `scripts/cleanup/steps/worktrees.ts` 파일 맨 위 설명의 「코디네이터가 띄운 터미널」 과 「PR 없이 끝난 워크트리」 가 소유한다.

**코디네이터가 그 워크트리가 자기 worker 것이고 사용자가 쓰지 않는다는 것을 알면 `orch cleanup sweep --run "$RUN_ID" --close-own-taken-over` 로 닫는다.**
옵션은 `--run` 과 함께 줄 때만 동작하고, 소유 확인에서 빼는 조건은 `scripts/cleanup/steps/worktrees.ts` 파일 맨 위 설명의 「넘겨받은 터미널」 이 소유한다.
`finish-pr.ts` 와 `merge-with-finish.ts` 는 스스로 이 옵션을 더하지 않는다. `queue.sweep_args` 에 두면 머지 큐의 정리에 넘어가고, Run 이 없으면 옵션을 빼고 경고한다.

## 머지

머지는 worker 에게 맡기지 않는다.
사용자가 머지까지 맡겼으면 코디네이터가 6단계 검증 뒤 머지한다. 맡기지 않았으면 6단계 검증 뒤 사용자에게 확인받고 머지한다.

**PR 머지는 `merge-with-finish.ts` 로 건다. 사용자가 말하지 않아도 마무리까지 함께 건다.**
이 스크립트가 PR 마다 `finish-pr.ts`(아래 「머지 뒤 마무리」)를 백그라운드로 걸고, 같은 인자로 `merge_queue.ts` 를 돌린다.
머지 큐만 걸면 worker 정리, 배포 확인, 업무 완료, 보드 갱신이 코디네이터의 기억에 달려 빠진다.
마무리가 필요 없는 저장소만 `orch queue run` 을 직접 걸거나 `orch queue merge --no-finish` 를 쓴다.

머지 큐는 오래 걸리므로 Bash 도구의 `run_in_background` 로 건다. 셸의 `&` 나 `nohup` 은 쓰지 않는다.
`merge_queue.ts` 의 옵션과 종료 코드는 그 스크립트 머리 주석이, 래퍼 옵션은 `merge-with-finish.ts` 머리 주석이 소유한다.
PR 번호는 머지할 순서대로 인자 하나씩 준다. `migrations` 설정이 있으면 같은 모듈의 낮은 번호부터 다시 정렬한다. 공백으로 이은 변수 하나로 넘기면 zsh 가 쪼개지 않아 사용법 오류로 끝난다.
`queue.auto_merge` 를 켠 저장소에서는 상주 루프가 머지할 수 있는 PR 을 스스로 건다(조건은 `loop/steps/auto-merge.ts` 머리 주석의 「자동 머지」).
코디네이터가 걸 일은 루프가 걸지 않은 PR(지시서 밖, 큐가 멈춘 같은 HEAD, 보류를 푼 PR)뿐이다.
**코디네이터가 따로 건 큐가 도는 동안에는 루프가 자동 머지를 걸지 않는다.** 머지 큐는 저장소에 하나만 돈다. 두 큐가 같은 base 를 함께 움직이면 서로의 최신화 판정이 무효가 되기 때문이다.
직접 건 큐도 주 checkout 의 `state/merge-queue.lock` 을 공유한다. 같은 저장소의 다른 큐가 실행 중이면 새 큐는 `QUEUE-BUSY` 이유와 종료 코드 2 로 거절한다. 거절되면 래퍼가 이번 호출에서 새로 띄운 마무리만 끝내고, 이미 돌던 마무리는 남긴다. `ps` 조회 실패는 `QUEUE-CHECK-FAILED` 로 구분하고 시작하지 않는다. 기존 큐가 끝난 뒤 다시 건다. 정상 종료와 종료 신호를 받으면 잠금을 풀고, PID 와 시작 시각·명령줄을 함께 대조해 죽은 프로세스나 다른 프로세스가 재사용한 PID 의 잠금은 다음 실행이 회수한다.
그래서 루프가 준비된 PR 을 볼 때 먼저 건다. 직접 걸기 전에 `state/loop.log` 의 `AUTO-MERGE` 줄로 루프가 이미 건 PR 인지 보고, 걸었으면 그 큐가 끝나기를 기다린다.
루프가 큐 때문에 자동 머지를 미룬 틱에는 `AUTO-MERGE-HELD pid <pid> #<차례 PR> <단계> <분>분 남은 #a #b` 한 줄이 같은 로그에 남는다. 어느 큐가 무엇을 기다리는지 이 줄로 본다.
루프에 걸지 말아야 할 PR 은 지시서에 `- 머지 보류: <이유>` 줄을 두거나 보드 항목에 끝나지 않은 `머지 보류: <이유>` 줄을 둔다. 풀 때 그 줄을 지우거나 끝낸다.

**업무의 마지막 PR 인지는 마무리(`finish-pr.ts`)가 배포를 확인한 뒤 스스로 판정한다. 코디네이터가 PR 마다 `!` 를 정하지 않아도 된다.**
판정 규칙은 아래 「마지막 PR 판정」 이 소유한다. 판정을 덮어야 할 때만 표시를 붙인다.

| 표시 | 뜻 | 쓰는 때 |
| --- | --- | --- |
| 없음 | 마무리가 판정한다 | 늘 |
| `PR!` | 판정 없이 마지막 PR 이다(`orch queue finish --complete`) | 판정 규칙이 모르는 남은 일이 없다고 코디네이터가 안다. 업무 번호 설정이 없는 저장소에서 업무를 끝낼 때 |
| `PR~` | 판정 없이 중간 PR 이다(`orch queue finish --intermediate`) | 열린 PR 도 지시서도 없지만 뒤 작업이 남았다(사용자 확인 대기 같은 것) |

`!` 와 `~` 는 함께 쓸 수 없다. before-merge 입력의 `last_of_task` 는 `!` 일 때만 true 다. 판정은 머지와 배포 뒤에야 하기 때문이다.

#### 마지막 PR 판정

`!` 와 `~` 가 없으면 PR 제목에서 업무 번호를 뽑았고, 같은 업무의 다른 열린 PR 도 같은 업무를 가리키는 다른 지시서도 없을 때 마지막 PR 이다. 조건과 판정 줄은 `scripts/lib/last-pr.ts` 머리 주석이 소유한다.
판정하지 못하면(번호 없음, `spec_task_pattern` 없음, gh 조회 실패) 중간 PR 로 본다. 업무를 일찍 완료하는 것이 늦게 완료하는 것보다 되돌리기 어렵다.
보드 동기화(`board-sync.ts`)도 머지를 본 틱에 같은 판정을 쓴다. 그 PR 의 마무리가 돌고 있으면 보드 동기화는 그 항목을 마무리에 맡긴다([`board.md`](board.md)).

```json
{
  "finish": {
    "task_pattern": "^\\[(PROJ-[0-9]+)\\]",
    "spec_task_pattern": "^브랜치: `feature/(PROJ-[0-9]+)-",
    "specs_dir": ".orch/specs"
  }
}
```

Run 은 머지 뒤 정리가 다른 Run 의 worker 터미널을 닫지 않도록 한정한다. 새 꼴은 코디네이터 터미널의 Run 을 문맥에서 채운다. 다른 Run 의 PR 이면 `--run <Run>` 을 준다. Run 을 끝내 읽지 못하면 정리 단계가 Run 으로 한정되지 않는다는 경고가 난다.

```bash
orch queue merge 101 102 103!
```

출력 줄(`FINISH-STARTED`, `MERGED`, `STOP`, `CONFLICT`, 끝 줄 `QUEUE-DONE`/`QUEUE-HELD`)은 `merge_queue.ts` 와 `merge-with-finish.ts` 머리 주석이 소유한다. 진행 줄은 `--full` 이다.

저장소마다 다른 값(배포 워크플로, 업무 번호 정규식, 업무 완료 명령, 보드 파일)은 코디네이터가 `orch config set` 으로 `finish` 절에 둔다. 예를 들어 `orch config set finish.deploy_workflow deploy.yml finish.deploy_branch main` 으로 배포 설정을 함께 바꾼다. 항목은 [`overlay.md`](overlay.md) 가 소유한다.
**머지 큐에 매번 붙이는 옵션(필수 체크, 합친 사본 검사, 문서 glob, 머지 방식, 최신화 규칙, 정리 인자)은 같은 파일의 `queue` 절에 둔다.** `merge-with-finish.ts` 가 명령줄에 없는 옵션을 그 절에서 채운다. 오버레이에서 옵션을 옮겨 적다 하나씩 빠뜨리는 일을 막는다.

**머지 큐가 끝나면 `notify-conflicts.ts` 로 열린 PR 가운데 base 와 충돌하는 것을 찾는다.** 앞 PR 의 머지로 생긴 충돌은 그 PR 의 worker 가 모른 채 끝나, 머지 큐에 넣은 뒤에야 `STOP` 으로 드러난다.
출력 줄과 알림 중복 방지는 스크립트 머리 주석이 소유한다.

```bash
orch queue conflicts --base "$BASE"
```

`STOP` 줄이 나오면 그 PR 에서 멈춘 것이다. 이유를 읽고 고친 뒤 남은 PR 만 다시 준다. 이미 MERGED 인 PR 은 건너뛴다.

**base 와 충돌하는 PR 은 큐를 멈추지 않는다.** update-branch 가 충돌로 실패하거나 mergeable 이 `CONFLICTING` 이면 `CONFLICT <PR> <이유>` 를 찍고 그 PR 만 빼고 뒤 PR 을 이어 머지한다.
해당 Run 에 `QUEUE-CONFLICT` 메시지가 가고, 그 PR 의 worker 에게 base 를 합치라고 보내는 일은 루프의 충돌 처리와 `notify-conflicts.ts` 가 한다.
끝 줄 앞에 `QUEUE-CONFLICT <번호...>` 가 오고, 끝 줄은 `QUEUE-HELD` 이며 종료 코드는 1 이다. worker 가 충돌을 푼 뒤 그 PR 만 다시 건다.

**앞 PR 이 먼저 들어가야 하는 PR 들은 `--chain 101,102` 로 묶는다.** 묶음 안 앞 PR 이 머지되지 않고 빠지면 뒤 PR 은 `SKIP <PR> 묶음의 앞 PR <번호> 가 머지되지 않았다` 로 머지하지 않는다. 묶음 밖의 PR 은 이어 머지한다.
`migrations.dirs` 또는 `migrations.watch` 에 해당하는 파일을 더한 PR 은 번호 순서로 자동 정렬하고 묶는다. 순서가 바뀌면 `QUEUE-ORDER <번호...>: <이유>` 한 줄을 낸다. 수동 `--chain` 과 자동 묶음을 함께 지키며, 서로 모순되면 머지 전에 종료 코드 2 로 거절한다. 마이그레이션 설정이 없으면 입력 순서와 수동 묶음을 그대로 쓴다.
준비 상태 검사와 머지 직전에 `origin/<base>` 를 새로 받아 최고 번호를 다시 본다. 그보다 크지 않은 번호는 보류하고, `orch queue reserve ... --again` 으로 새 번호를 받으라는 안내를 worker 에게 보낸다. 파일 이름까지 새 번호로 바꾸려면 `--again --rename` 을 준다.

```bash
orch queue merge --chain 101,102 101 102 103
```
**보류한 PR 은 큐를 멈추지 않는다(기본).** 체크 실패, 근거 블록 불일치처럼 조건에 못 미친 PR 은 `STOP` 줄을 찍고 그 PR 만 빼고 다음 PR 로 간다. 끝 줄이 `QUEUE-DONE` 대신 `QUEUE-HELD <번호...>` 이고 종료 코드는 1 이다.
뒤 PR 이 앞 PR 에 기대면 `--chain` 으로 묶는다. 첫 보류에서 멈추려면 `--stop-on-hold` 를 준다.
뺀 PR 과 이유는 차례 기록(`state/queue-turn/<pid>.json`)의 `held` 에 남고, 상주 루프가 `state/loop.log` 에 `QUEUE-DROPPED #<PR> pid <pid>: <이유>` 한 줄로 옮긴다.
worker 가 고쳐야 하는 보류(근거 블록 불일치, 미해결 리뷰 스레드, 합친 사본 검사 실패)는 큐가 그 PR 의 살아 있는 worker 에게 이유를 보낸다. Run 은 정리 인자의 `--run` 이다. 체크 실패와 충돌은 루프의 CI 감시와 충돌 처리가 보내므로 큐는 보내지 않는다.

**차례 PR 이 base 를 합친 뒤 CI 를 기다려야 하면, 그동안 겹치지 않고 준비된 뒤 PR 을 먼저 머지한다.** `--require-up-to-date` 와 `--up-to-date-when overlap` 일 때만 한다.
먼저 머지하는 PR 은 묶음(`--chain`)에 들지 않았고, 필수 체크가 이미 모두 통과했고, 최신화가 필요 없고, 차례 PR 과 단위가 겹치지 않는 PR 이다. 겹치는 PR 을 먼저 머지하면 차례 PR 이 다시 뒤처져 방금 돌린 CI 가 쓸모없어진다.
`<PR> 앞지르지 않는다: <이유>` 와 `<PR> 차례 PR <번호> 보다 먼저 머지했다` 줄로 무엇을 먼저 머지했는지 보인다. 판정은 `merge_queue.ts` 머리 주석의 「앞지르기」 가 소유한다.

PR 마다 하는 확인(HEAD 고정, 필수 체크가 모두 나타난 뒤 대기, 충돌과 미해결 스레드, 머지 결과 확인)의 순서와 종료 코드는 `merge_queue.ts` 머리 주석이 소유한다.

### draft 로 CI 를 미루는 저장소

**오버레이가 「draft PR 은 CI 를 돌리지 않는다」 고 정한 저장소에서만 쓴다.** 그 저장소의 worker 는 PR 을 draft 로 연다.
코디네이터가 6단계 검증을 마친 PR 을 `ci-ready.ts` 로 ready 로 바꿔 CI 를 시작한다. 그다음 머지 큐에 넣는다.
겹친 PR 둘을 함께 ready 로 바꾸면 앞 PR 이 머지된 뒤 뒤 PR 의 CI 를 다시 돌려야 하므로, 스크립트가 겹치거나 충돌하는 PR 을 보류한다.
판정과 종료 코드는 스크립트 머리 주석이 소유한다.

```bash
orch queue ready 101 102
```

### 머지 전 조건만 미리 보기

`orch queue gate <PR>` 은 머지 큐가 머지 전에 보는 조건(체크, 미해결 리뷰 스레드, 충돌, 설정한 리뷰 판정, 기능 완료 근거 블록과 독립 리뷰 줄)을 머지 없이 돌린다.
통과하면 `GATE-OK <PR>`, 걸리면 `GATE-FAIL <PR>` 과 걸린 이유를 한 줄씩 낸다(종료 코드 0, 1). 판정은 머지 큐와 같은 함수가 하므로 큐가 멈출 이유를 큐에 걸기 전에 안다.
리뷰 판정은 `block` 을 받은 PR 을 기본으로 막는다. 저장소가 `queue.auto_review.fixed_after_block` 을 `true` 로 두면 `block` 이 가리키는 커밋 뒤에 반영 커밋이 있고(기준 브랜치를 합친 merge 만 있으면 반영이 아니다) 미해결 스레드가 0 일 때 재리뷰 없이 통과한다. 그때 `GATE-OK <PR>` 다음 줄에 `REVIEW-FIXED <리뷰 id> <block 커밋 8자리>..<HEAD 8자리>` 를 낸다. 자동 리뷰가 PR 을 열 때만 돌고 재리뷰를 금지하는 저장소를 위한 설정이다. 조건의 정확한 뜻은 `scripts/core/auto-merge.ts` 머리 주석의 「judgeReview」 가 소유한다.
worker 는 「준비됨」 을 보내기 전에 이 명령을 통과해야 한다(공통 지시서). 옵션과 출력은 `scripts/queue/gate.ts` 머리 주석이 소유한다.

`HELD <PR> <이유>` 줄(`--full` 은 `보류`)의 PR 은 겹친 PR 이 머지된 뒤 다시 돌린다. ready 로 바꾼 PR 은 `READY <PR>` 이다. base 와 충돌하는 PR 은 그 worker 에게 base 를 합치게 한다.

### 쉼표가 든 체크 이름

`--required` 는 값을 쉼표로 나눈다. `Lint, Test & Build` 처럼 쉼표가 든 이름은 `--required-check "Lint, Test & Build"` 로 준다(여러 번 줄 수 있고 `--allow-fail-check` 도 같다).
이름이 틀려 필수 체크가 나타나지 않으면 `--missing-timeout`(기본 5분) 뒤에 나타나지 않은 이름과 PR 에 붙은 체크 이름을 찍고 멈춘다.

### 실패를 허용하는 체크

**`--allow-fail A,B` 는 필수가 아닌 체크가 코드와 무관한 이유로 실패했고, 그 대신 할 검증을 끝냈을 때만 쓴다.**
사용량 한도나 외부 장애로 리뷰 봇이 실패한 경우가 예다. 그 체크가 하던 일을 독립 리뷰 같은 다른 방법으로 끝낸 뒤에 쓴다.
기본은 실패한 체크가 하나라도 있으면 멈추는 것이다. 모르는 실패를 조용히 넘기지 않으려고 이름을 하나씩 적어 준 체크만 넘긴다.
**실패를 허용하려면 그 이유를 사용자에게 먼저 알린다.** 어떤 체크가 왜 실패했고, 대신 어떤 검증을 끝냈는지 적는다.
필수 체크는 허용할 수 없고, 목록에 없는 체크가 실패하면 멈춘다. 판정은 스크립트 머리 주석이 소유한다.

```bash
orch queue merge --required test,browser --allow-fail claude-review 101
```

### base 최신 여부

**`--require-up-to-date` 는 기본이 꺼져 있다. 저장소 오버레이가 켜라고 정한 저장소에서만 쓴다.**
켜면 머지 직전에 PR 이 base 최신을 품는지 보고, 품지 않으면 `update-branch` 로 base 를 merge 한 뒤 필수 체크를 다시 기다리고 머지한다.
체크는 PR HEAD 기준으로 돌아 base 가 움직였는지 모른다. 오래된 base 위에서 각각 통과한 PR 둘이 머지돼 base 빌드가 깨질 수 있고, 이 옵션이 그 틈을 닫는다.

- 충돌이 나면 `update-branch` 가 실패하고 그 PR 을 큐에서 뺀다(위 `CONFLICT`). 충돌을 푸는 일은 그 PR 의 worker 가 한다
- 머지 큐에서 앞선 PR 이 머지되면 뒤 PR 은 base 가 달라진 것이므로 이 옵션이 뒤 PR 마다 다시 base 를 merge 한다. 시간이 더 걸리는 대신 base 가 깨지지 않는다

```bash
orch queue merge --require-up-to-date --required backend,frontend 101 102
```

### 머지 차례 전에 미리 최신화하기

**`pipeline.refresh_slots` 를 켠 저장소에서는 상주 루프가 뒤처진 PR 의 `update-branch` 를 머지 차례 전에 PR 마다 따로 건다.** 머지 큐는 지금처럼 하나씩 머지한다.
`--require-up-to-date` 만으로는 뒤 PR 이 차례마다 base 를 합치고 CI 를 기다려 CI 한 번씩 줄을 선다. 루프가 미리 합치면 CI 들이 함께 돌고, 차례가 온 PR 이 이미 최신이고 통과했으면 머지 큐가 기다리지 않고 머지한다.

- 판정은 머지 큐와 같은 `queue` 키로 한다. 최신이거나 겹치지 않아 머지 큐가 바로 머지할 PR 은 건드리지 않는다
- 충돌한 PR 은 지금처럼 충돌 처리가 그 worker 에게 보낸다. 충돌 파일이 모두 `contracts.paths` 에 맞으면 먼저 orch 가 합쳐 push 한다(`overlay.md` 「계약 머리 자동 합치기」). `pipeline.refresh_worker_paths` 에 맞는 파일을 양쪽이 바꾼 PR 은 `update-branch` 대신 그 worker 에게 base 를 합쳐 검증하고 한 번 push 하라고 보낸다
- 도는 머지 큐의 차례 PR 은 건드리지 않는다. 큐 밖에서 HEAD 가 바뀌면 그 PR 이 `STOP` 으로 멈춘다. 큐에서 아직 머지되지 않은 앞 PR 과 겹치는 PR 은 그 머지 뒤로 미룬다. 곧 다시 뒤처져 방금 돌린 CI 가 쓸모없어지기 때문이다
- 같은 (PR, base SHA) 에는 한 번만 건다. CI 가 passed 가 아닌 PR 은 걸지 않는다

루프 로그(`state/loop.log`)의 `REFRESH`, `REFRESH-WAIT`, `REFRESH-WORKER`, `REFRESH-ORPHAN` 줄이 무엇을 걸었고 왜 미뤘는지 보인다. Run 메시지는 보내지 않는다.
자리 수와 runner 의 관계, 설정 예시는 [`overlay.md`](overlay.md) 의 「뒤처진 PR 미리 최신화」 가, 판정 순서는 `loop/steps/refresh.ts` 머리 주석의 「최신화」 가 소유한다.

### 체크 확인 간격

머지 큐는 진행 중인 체크를 60초에서 시작해 두 배씩 늘린 간격(최대 300초)으로 다시 본다. 간격은 `queue.poll_min_sec`, `queue.poll_max_sec`, `queue.ci_expected_sec` 로 바꾼다. 키 뜻은 [`overlay.md`](overlay.md) 의 queue 행이 소유한다.
간격을 줄이면 PR 하나를 기다리는 동안 gh 호출이 는다. 호출 예산은 [`gh-call-budget.md`](gh-call-budget.md) 를 본다.

### 겹치지 않는 PR 은 최신화하지 않기

**`--up-to-date-when overlap` 은 `--require-up-to-date` 가 base 를 합치는 때를 줄인다. 기본은 `always`(뒤처졌으면 늘 합친다)이고, 바꾸지 않으면 동작이 달라지지 않는다.**
`--require-up-to-date` 만 쓰면 앞 PR 이 머지될 때마다 뒤 PR 이 base 를 합치고 필수 CI 를 다시 기다려, PR 하나에 CI 한 번 분량이 더 든다.
`overlap` 은 PR 이 바꾼 단위와 PR 이 갈라진 뒤 base 에 들어온 변경의 단위가 겹치지 않으면 최신화 없이 머지하고, 겹치면 지금처럼 합치고 CI 를 다시 기다린다.

단위, 공용 경로, 문서 파일, 판정 시점, 다시 판정하는 조건과 횟수 한도는 `merge_queue.ts` 와 `overlap_units.ts` 머리 주석이 소유한다.
PR 차례마다 `<PR> 판정: 바로 머지` 나 `<PR> 판정: 갱신 필요(이유)` 한 줄이 찍힌다. 판정하지 못하면 안전한 쪽인 갱신 필요로 다룬다.
`--require-up-to-date` 가 있어야 한다.

#### 언제 overlap 을 쓰는가

**공용 경로가 잘 정의된 모노레포에서만 쓴다.** 아래 조건을 모두 확인할 수 있어야 한다.

- 다른 모듈의 코드에 컴파일 의존이 있는 모듈 쌍은 `--unit-group a,b` 로 묶었다. 한 단위가 두 묶음에 들 수 없으므로 의존이 사슬(`web` → `bff` → `billing`)이면 사슬 전체를 한 묶음으로 쓴다. 묶음 설정이 틀리면 큐를 시작할 때 종료 코드 2 로 멈춘다
- 모든 모듈에 영향을 주는 경로를 `--shared-paths` 로 빠짐없이 적었다. 공용 모듈, 루트 빌드 파일과 버전 카탈로그(`settings.gradle`, `gradle/`, `buildSrc/`), 계약, CI 설정, 공용 테스트 설정, 저장소 전체에서 번호가 하나로 이어지는 마이그레이션이 후보다
- 머지 뒤 검사가 따로 있다(아래 「머지 뒤 안전망」)

**이 규칙이 놓치는 경우.** 단위가 겹치지 않으면 합친 상태를 아무도 검사하지 않는다.

| 놓치는 경우 | 대응 |
| --- | --- |
| 계약 없이 런타임에 호출하는 모듈 쌍(화면 모듈과 그 BFF) | `--unit-group` 으로 묶는다 |
| 공개 API 를 바꾸고 호출처를 같이 고친 base 변경과, 옛 시그니처를 새로 호출하는 PR | 폴더가 달라 못 잡는다. 모듈 의존을 `--unit-group` 으로 묶거나 `verify_merged_when: code` 를 함께 쓴다 |
| 같은 이름 공간을 쓰는 자원(마이그레이션 버전 번호, 빈 이름, 라우트, 번역 키) | 경로를 `--shared-paths` 에 넣거나 `verify_merged_when: code` 를 함께 쓴다 |
| `--shared-paths` 에서 빠진 루트 파일 | 접두 밖 파일은 파일 경로 자체가 단위라 같은 파일을 고칠 때만 겹친다. 루트에서 모듈이 함께 쓰는 파일을 모두 적는다 |
| 너무 넓은 `--docs-glob`(`*.md` 가 문서 빌드나 doctest 가 읽는 파일일 때) | 문서 glob 은 코드가 읽지 않는 경로로 좁힌다 |
| 판정한 base 를 마지막으로 확인한 때와 머지 API 를 부르는 때 사이의 짧은 틈 | 막을 수 없다. `--match-head-commit` 은 PR HEAD 만 지키고 base 는 지키지 않는다. 이 틈에 들어온 변경은 머지 뒤 안전망으로 잡는다 |
| `hooks/verify-merged.ts`가 합친 사본을 검사하는 사이 base 가 움직였다 | 놓치지 않고 `STOP <PR> 검사하는 동안 base(<브랜치>) 가 움직였다. 다시 돌린다` 로 멈춘다. 같은 인자로 다시 걸면 새 base 로 검사한다 |

**머지 뒤 안전망.** `overlap` 으로 합친 상태가 깨져도 PR 쪽 CI 는 알 수 없다. 이미 있는 확인은 `finish-pr.ts` 의 배포 워크플로 성공 대기(`--deploy-workflow`)뿐이다. 머지 커밋의 배포 실행이 실패하면 `FINISH-FAIL` 로 알린다. 배포 워크플로가 없는 저장소에는 머지 뒤 base CI 를 보는 단계가 없다.
깨진 조합을 막으려면 `verify_merged_when: code` 를 `overlap` 과 함께 둬 합친 사본에서 컴파일과 영향받는 모듈의 테스트를 돌린다. 이 경우 CI 재대기는 줄지만 로컬 검사 시간은 든다.
깨진 base 가 나오면 그 PR 을 되돌리는 PR 로 복구한다.

옵션을 매번 적지 않도록 `queue` 절에 둔다. 코디네이터는 `merge-with-finish.ts` 만 부르면 된다.

```json
{
  "queue": {
    "required": ["backend", "frontend"],
    "require_up_to_date": true,
    "up_to_date_when": "overlap",
    "shared_paths": ["^modules/common/", "^(settings|build)\\.gradle(\\.kts)?$", "^(gradle|buildSrc)/", "^\\.github/"],
    "unit_groups": [["web", "bff"]],
    "docs_glob": ["docs/*", "*.md"],
    "sweep_args": ["--specs-dir", ".orch/specs"]
  }
}
```

`sweep_args` 에 `--run` 을 고정하지 않는다. Run 은 명령줄의 `--run` 으로 준다. 둘이 다르면 `merge-with-finish.ts` 가 멈춘다.

그러면 호출은 다음 한 줄이다. 마무리가 보드 파일에서 그 PR 의 항목을 찾아, 마지막 PR 이면 done 으로 바꾼다.
항목은 `pr` 필드에 그 PR 이 든 것을 먼저 찾고, 없으면 `pr` 필드가 빈 끝나지 않은 항목을 PR 브랜치나 워크트리 이름으로 찾는다. 중간 PR 이면 그 PR 의 단계를 끝내고 `남은 일:` 줄을 두고 PR 을 `merged-pr` 에 쌓는다.
마일스톤 항목(`stages` 필드가 있다)은 `[merge]` 단계까지, 배포가 성공했으면 `[deploy]` 단계까지 끝내고, done 지점(`board.done_after`)에 닿고 그 뒤에 끝나지 않은 수동 단계가 없을 때만 done 으로 바꾼다. 마지막 PR 인지 판정하지 못하면 중간 PR 로 본다([`board.md`](board.md) 의 「마일스톤 단계」).
같은 PR 의 항목이 둘 이상이면 건너뛴다. `--board-item PR=ID` 로 준 항목은 판정과 상관없이 done 으로 바꾼다. 규칙은 `finish-pr.ts` 머리 주석의 「보드 항목」 이 소유한다.

```bash
orch queue merge 492 '495:./bin/backup-db.sh orders "before-pr-$PR"'
```

### 같은 파일을 고친 PR

**PR 이 갈라진 뒤 base 에서도 바뀐 파일을 그 PR 이 고쳤으면, 체크가 통과해도 합친 상태는 아무도 검사하지 않았다.**
체크는 PR HEAD 기준으로 돈다. 앞 PR 을 머지한 뒤 같은 파일을 고친 뒤 PR 을 그대로 머지하면 base 에서 처음 깨진다.
`--require-up-to-date` 는 base 를 PR 에 merge 하고 CI 를 다시 돌려 이 틈을 닫지만 PR 마다 CI 를 한 번 더 기다린다.
겹친 PR 만 로컬에서 다시 검사하려면 아래 둘 중 하나를 쓴다.

| 옵션 | 겹치면 | 쓰는 때 |
| --- | --- | --- |
| `--stop-on-overlap` | `STOP <PR> 겹침: <파일>` 로 멈춘다 | 합친 상태를 코디네이터가 따로 확인한다 |
| `hooks/verify-merged.ts` | `origin/<base>` 에 PR HEAD 를 merge 한 임시 사본에서 핸들러가 0으로 끝나면 머지한다 | 오버레이가 핸들러의 검사 명령을 정해 둔다 |

**파일이 겹치지 않아도 합치면 깨질 수 있다.** 두 PR 이 각자 상한 안이어도 합치면 같은 상한을 넘을 수 있다.
그런 저장소는 오버레이가 `--verify-merged-when code` 를 정한다. 문서만 바꾼 PR 까지 검사하려면 `always` 다. 기본 `overlap` 은 겹칠 때만 검사한다.
`--docs-glob` 을 주면 문서 PR 은 `overlap` 과 `code` 에서 합친 사본 검사를 생략한다. `--stop-on-overlap` 만 쓰면 문서 PR 도 겹침에서 멈춘다.

문서 PR 도 최신 base 와 합친 CI 를 확인해야 하면 **`--update-docs-on-overlap` 을 더한다.** 조건은 스크립트 머리 주석이 소유한다.
기본은 꺼져 있다. 문서 겹침에서 큐가 멈추는 저장소의 오버레이에서 켠다.

합친 사본 검사가 실패하면 그 PR 을 만든 worker 가 이어 받아 기준 브랜치를 merge 하고 고친다([`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」). rebase 와 force push 는 쓰지 않는다.

핸들러 입력과 환경 변수, 사본을 두는 폴더(`--copy-dir`)는 `merge_queue.ts` 머리 주석이 소유한다.
검증 명령은 실행할 테스트 파일이 실제로 있는지 확인해야 한다.
사본 생성과 머지까지 하는 저장소 스크립트가 이미 있으면 그 전체를 넘기지 않는다. 검증 부분만 넘기며 사본 생성, 충돌 검사, HEAD 대조와 머지는 큐가 한다.
저장소 hook 이 `worktrees/` 밖의 워크트리를 막으면 오버레이가 허용된 폴더를 정한다.
`$COPY_DIR` 은 오버레이의 값이고, 검증 명령은 `hooks/verify-merged.ts` 에 둔다.

```bash
orch queue merge --copy-dir "$COPY_DIR" 101 102
```

### draft 때 건너뛴 필수 체크

draft 에서 CI 를 건너뛰게 둔 저장소는 같은 HEAD 에 결론이 `SKIPPED` 인 실행이 남는다. GitHub 는 `SKIPPED` 를 통과로 본다.
ready 로 바꾼 직후 새 실행이 붙기 전에 머지 큐가 그 체크를 보면 CI 없이 머지한다.
그런 저장소는 오버레이가 `--skipped-is-missing` 을 정한다. 조건은 스크립트 머리 주석이 소유한다.

### 머지 뒤 명령

머지한 뒤 한 번 돌릴 명령은 `hooks/after-queue.ts` 에 둔다. 머지 뒤 배포를 Actions 가 아니라 로컬 스크립트로 하는 저장소가 예다.
문서 PR 만 머지했을 때 배포를 건너뛰려면 핸들러가 `code_prs` 입력을 본다. 입력과 실패 처리는 `merge_queue.ts` 머리 주석이 소유한다.

```bash
orch queue merge --docs-glob 'docs/*,*.md' 101 102
```

저장소의 검증과 배포 명령은 그 저장소의 오버레이가 소유한다.

### 머지 전 명령

PR 마다 머지 직전에 돌릴 명령은 `PR번호:명령` 으로 준다. 모든 PR 에 같은 명령은 `hooks/before-merge.ts` 에 둔다.
환경 변수와 종료 코드는 `merge_queue.ts` 머리 주석이 소유한다.

DB 마이그레이션이 든 PR 을 머지하기 전에 개발 DB 를 백업하는 것이 대표적인 예다.
백업 스크립트는 저장소마다 서버와 DB 가 달라 이 스킬에 두지 않는다. 저장소의 오버레이가 경로와 인자를 정한다.

```bash
orch queue merge 101 '102:./bin/backup-db.sh orders "before-pr-$PR"' 103
```

백업 스크립트를 저장소에 둘 때 지킬 것이다.

- 덤프가 끝났는지 종료 코드와 파일 크기로 판정하고, 실패하면 0 이 아닌 코드로 끝낸다. 머지 큐가 그 코드로 멈춘다
- 보관 개수를 정하고 오래된 덤프를 지운다. 개발 단계에서는 DB 마다 최근 몇 개만 남겨도 된다
- 비밀번호는 서버 쪽 환경 변수로 읽는다. 명령줄과 출력에 남기지 않는다

### 머지 뒤 마무리

**`finish-pr.ts` 는 PR 이 MERGED 인 것을 `gh` 로 직접 확인한 뒤에 정리한다.** 순서(머지 확인, worker 에게 머지 알림, worker 정리, 배포 확인, 마지막 PR 판정, 업무 완료, 보드 done), 옵션, 배포 판정은 스크립트 머리 주석이 소유한다. 업무 시스템이 없는 저장소는 `--complete` 만 주면 되고, `PR!` 도 같은 뜻이다.
머지된 줄 모르고 기다리는 worker 가 정리를 막으므로 스크립트가 먼저 알린다. 코디네이터가 「MERGED 됐다」 를 따로 보내지 않는다. 출력에 `notify: worker 남음` 이 있으면 그 worker 의 화면을 보고 이어 가게 한다.

출력은 `<로그 폴더>/finish-<PR>.out` 에 쌓이고 마지막 줄이 `FINISH-DONE` 이나 `FINISH-FAIL` 이다. 깨어날 때마다 그 줄을 본다.
이 로그는 `orch queue merge` 가 신호 없이 띄워 지금 출력 그대로다. `FINISH-FAIL` 의 이유는 그 앞의 진행 줄에 있다. `orch queue finish <PR>` 로 직접 부르면 기본 출력이 `LAST-PR <마지막|중간>` 과 이유를 붙인 `FINISH-FAIL <이유>` 다.
`FINISH-FAIL` 이면 출력의 이유를 읽고 사용자에게 알린다. 배포 실패나 업무 번호 없음처럼 사람이 정해야 하는 것은 스크립트가 다시 시도하지 않는다.
머지 큐가 `STOP` 으로 멈춘 뒤 남은 PR 만 다시 걸어도 같은 PR 의 마무리는 겹쳐 돌지 않는다.

## 정리

**정리는 `cleanup-sweep.ts` 가 한다.** `merge_queue.ts` 가 모든 PR 을 머지한 뒤 `--apply` 로 부르고, 상주 루프(`orch-loop.ts`)가 틱마다 `--remote-branches` 와 함께 부른다.
**사용자가 정리하라고 말하지 않아도 상주 루프가 돈다.** 끝난 워크트리, 터미널과 Dispatch, 로컬 브랜치를 사용자 지시를 기다리며 남겨 두지 않는다.
로컬 브랜치가 없는 원격 브랜치는 `--remote-branches` 로 지운다. 직접 머지한 PR 과 다른 PR 에 합쳐 닫힌 PR 의 원격 브랜치가 여기 든다.
머지 큐 로그 폴더(`.orch/queue`)의 끝난 마무리 로그와 큐 로그도 휴지통(`--trash`)으로 옮긴다. 돌고 있는 것, 모르는 파일, 1시간이 안 된 실패 로그와, 끝 표시 없이 pid 만 죽은 마무리 로그는 남긴다(1시간이 지나면 옮긴다). 조건은 `lib/queue-logs.ts` 머리 주석이 소유한다.
작업이 띄운 Docker 컨테이너와 쌓은 이미지도 반납한다. 무엇을 지우고 남기는지는 아래 「Docker 자원 반납」 이 소유한다.
상세 규칙은 `scripts/cleanup/steps/` 의 해당 단계 파일 맨 위 설명을 따른다.

**코디네이터가 worker 에게 맡긴 작업은 그 PR 이 머지되면 그 자리에서 정리한다.** 작업을 맡긴 저장소가 코디네이터의 저장소가 아니어도 같다.
대상은 worker 터미널, 워크트리, 로컬 브랜치다(원격 브랜치는 위 조건을 따른다). 지시한 쪽이 정리하지 않으면 아무도 정리하지 않는다.
절차는 아래 「다른 저장소에 맡긴 PR 을 직접 머지했을 때」 가 소유한다.
**다른 세션이 띄운 작업은 건드리지 않는다.** 그 세션이나 사용자가 하던 작업이 끊긴다.
조건과 실행 순서는 `scripts/cleanup/steps/`의 해당 단계 설명을 따른다. 지시서 폴더 같은 정리 인자는 설정 `queue.sweep_args` 에 두는 것이 기본이다. Run 은 `--run` 으로 준 값이 자동으로 정리에 넘어간다.

```bash
orch queue merge --sweep-arg --kill-holders 101 102
```

**`--sweep-arg` 를 명령줄에 하나라도 주면 설정의 `queue.sweep_args` 를 통째로 쓰지 않는다.** `--specs-dir` 처럼 설정에 둔 인자도 `--sweep-arg --specs-dir --sweep-arg "$SPECS_DIR"` 로 다시 준다.

**`scripts/cleanup/steps/`의 설명이 다루는 경우는 코디네이터가 직접 지우지 않는다.** squash 머지, 로컬과 PR 의 브랜치 이름 차이, 빈 셸 터미널, 살아 있는 dispatch 의 지시서 보호, 남은 프로세스가 대표적이다.
저장소가 여럿이면 `--repo` 를 저장소마다 준다.

스크립트가 건너뛴 항목은 기본 출력의 `KEPT <대상> <이유>` 줄(`--full` 과 루프 로그는 `건너뜀` 줄)로 읽는다. 지운 것은 `REMOVED`, 실패는 `FAILED` 이고 끝 줄이 `SWEEP <지운 수> <남긴 수>` 다.

**머지나 완료를 확인하면 사용자 지시를 기다리지 않고 worker 의 워크트리, 브랜치, 터미널을 정리한다.**
같은 워크트리에서 후속 작업을 하는 worker 가 있으면 그 worker 가 끝날 때까지 남긴다.

**worker 터미널은 `worker_done` 뒤에도 PR 이 머지되거나 닫힐 때까지 남긴다.** 충돌과 리뷰 반영을 그 PR 을 만든 worker 가 이어 받기 때문이다([`replying.md`](replying.md) 의 「충돌과 리뷰 반영은 만든 worker 가 이어 받는다」).
머지 뒤에는 그 터미널을 바로 정리한다. `cleanup-sweep.ts` 가 PR 이 MERGED 일 때 닫는다.
머지 없이 닫힌 PR 의 터미널도 `--run` 을 주면 `cleanup-sweep.ts` 가 닫는다. 대상은 내 PR 의 끝난 dispatch 터미널이다.
다른 사람의 PR 이거나 `--run` 이 없으면 코디네이터가 이 세션이 띄운 worker 의 터미널만 `worker-release` 로 닫는다(기본 경로는 위 문단이 소유한다).

스크립트가 하지 않아 직접 하는 일은 그 작업만의 문서 정리다. 진행 보드 항목은 마무리(`finish-pr`)와 `board-sync` 가 done 으로 바꾸므로 직접 바꾸지 않는다([`board.md`](board.md)).

- 그 작업만의 문서(지시서 사본, 설계 메모, PR 본문, 리뷰 회신 사본)를 정리한다.
   `.orch/` 에 둔 지시서, 조사 보고, 큐 로그, 임시 계획도 작업이 끝나면 휴지통 폴더로 옮긴다(`orch cleanup handoff`, 아래 「handoff 산출물 정리」).
   공통 지시서, 결정 기록, 인수인계 문서, 진행 중 작업의 문서는 남긴다.
   사용자 미리보기 폴더는 content-preview 의 것이라 사용자가 정리하라고 말하거나 설정의 `cleanup.previews` 로 맡겼을 때만 정리한다

**다음 PR 은 새 worker 로 띄운다.** 계획이 PR 여럿이면 앞 PR 이 MERGED 인 것을 확인한 뒤 코디네이터가 뒤 PR 의 지시서를 쓴다. 지시서는 PR1 한 개만 맡기는 규칙([`spec-writing.md`](spec-writing.md))으로 쓰고, 앞 PR 의 결과가 뒤 PR 의 전제가 되면 그 내용을 지시서에 적는다.
worktree 는 재사용하지 않고 새로 만든다. 앞 PR 의 워크트리와 로컬 브랜치는 위 정리가 지우고, `launch-worker --repo --name` 이 원격을 갱신한 뒤 `origin/<기준 브랜치>`(앞 PR 이 머지된 최신) 위에 새 브랜치로 워크트리를 만든다. 앞 worker 의 터미널은 이미 닫혔으므로 이어 쓰지 않는다. 브랜치 이름은 앞 PR 과 다르게 한다.
앞 PR 이 머지되지 않고 닫혔으면 뒤 지시서를 쓰지 않고 사용자에게 알린다. 충돌과 리뷰 반영은 PR 을 만든 worker 가 이어 받으므로 이 규칙의 대상이 아니다.

**머지 직전과 지우기 직전에 `gh pr view --json state` 를 본다.** 머지는 `OPEN` 일 때만 하고, 브랜치와 워크트리는 `MERGED` 일 때만 지운다.
다른 세션이나 사용자가 같은 PR 을 먼저 머지하기도 한다.

```bash
gh pr view "$PR" --json state --jq .state
```

**`gh pr merge` 로 바로 머지하면 마무리가 빠진다.** 루프의 정리가 워크트리는 치우지만 배포 확인, 업무 완료, 보드 done 은 하지 않는다.
그 PR 에 마무리가 돈 표시가 없으면 정리가 `FINISH-MISSING` 을 내고 루프가 코디네이터를 깨운다. 알림의 `finish-pr` 명령으로 마무리를 돌린다.

### 다른 저장소에 맡긴 PR 을 직접 머지했을 때

`orch queue merge` 의 마무리는 머지 큐를 건 저장소만 정리한다. 다른 저장소에 맡긴 PR 을 코디네이터가 `gh pr merge` 로 머지했으면 바로 이어서 정리한다.
값을 채운다: `$OTHER_REPO` 는 그 저장소의 주 checkout, `$RUN_ID` 는 worker 를 띄운 Run, `$PR` 은 PR 번호, `$WORKER_TERM` 은 그 worker 의 터미널 handle(`worker-show`), `$WORKTREE` 는 그 워크트리 경로다.
먼저 `orch cleanup sweep` 으로 정리한다. worker 를 띄운 Run 이 지금 코디네이터 터미널의 Run 과 다를 수 있어 `--run` 은 명시한다. 터미널 소유 확인, 끝난 dispatch 반납, 워크트리와 로컬, 원격 브랜치 삭제를 한 번에 한다.

```bash
orch cleanup sweep --repo "$OTHER_REPO" --run "$RUN_ID" --kill-holders --apply
```

스크립트가 건너뛴 것만 아래 묶음으로 직접 지운다. 묶음은 PR 이 `MERGED` 일 때만 돈다.
돌리기 전에 그 터미널이 이 세션이 띄운 worker 의 것인지 `worker-list` 의 `ownershipState` 로 본다. `owned` 가 아니면 `worker-release` 줄을 빼고 돌린다. `$DISPATCH_ID` 는 그 worker 의 dispatch 다.

```bash
if [ "$(cd "$OTHER_REPO" && gh pr view "$PR" --json state --jq .state)" = MERGED ]; then
  BRANCH=$(git -C "$WORKTREE" branch --show-current)
  PR_HEAD=$(cd "$OTHER_REPO" && gh pr view "$PR" --json headRefOid --jq .headRefOid)
  orca orchestration worker-release --dispatch "$DISPATCH_ID"
  orch cleanup worktree "$WORKTREE" --delete-branch --merged-head "$PR_HEAD" --wait 30
  if git -C "$OTHER_REPO" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null; then
    git -C "$OTHER_REPO" push origin --delete "$BRANCH"
  fi
fi
```

### 워크트리 지우기

**작업이 끝난 워크트리는 `remove-worktree.ts` 로만 지운다.** `git worktree remove` 를 바로 쓰지 않는다.
거부하는 경우와 전제는 스크립트 머리 주석이 소유한다. squash 머지로 거부되면 `--merged-head` 를 주고(아래), PR 이 `MERGED` 인 것을 확인했으면 사용자에게 묻지 않고 지운다.
**워크트리를 쥔 것이 자식 없는 Orca 기본 셸(「Terminal 1」 같은 에이전트 없는 로그인 셸)뿐이면 스스로 그 터미널을 닫고 지운다.** 끝난 worker 의 워크트리에서만 닫고, 에이전트 터미널, 살아 있는 dispatch 의 터미널, 자식이 있는 셸, worker 기록이 없는 워크트리의 셸(사람이 연 셸일 수 있다)은 남긴다. 커밋 안 된 변경처럼 어차피 거부할 워크트리면 셸을 닫기 전에 거부한다. 판정은 `scripts/lib/idle-shells.ts` 한 곳이 소유하고 `cleanup-sweep.ts` 도 같은 판정을 쓴다.
거부되면 먼저 그 worker 터미널을 닫고 `--wait 30` 을 붙여 다시 돌린다.
거부 줄의 pid 가 끝난 dispatch 의 것이면 `orch cleanup sweep --kill-holders` 로 끈다. 위 판정이 「끝남」 인 워크트리(PR MERGED, PR 없이 끝남)의 남은 프로세스만 끈다. lsof 로 직접 찾아 끄지 않는다.

```bash
orch cleanup worktree "$WORKTREE" --delete-branch
```

squash 머지된 PR 이면 `--merged-head "$PR_HEAD"` 를 더한다. `cleanup-sweep.ts` 는 이 값을 스스로 넘긴다.
리뷰 worker 의 워크트리처럼 PR head 에 detached 로 놓인 워크트리도 같은 명령으로 지운다. `--delete-branch` 는 PR 이 닫히고 그 리뷰가 끝났을 때 그 워크트리를 만든 `review/pr-<N>` 브랜치를 함께 지운다.

- Orca 가 만든 워크트리를 `orca worktree rm` 으로 지울 때는 뒤에 `git -C "$REPO" worktree prune` 을 돌린다.
  디렉터리만 지우고 git 의 워크트리 기록이 남아, 그대로면 브랜치 삭제가 `used by worktree` 로 거절된다
- **`orca worktree rm` 이 `ok` 를 돌려줘도 디렉터리는 뒤이어 지워진다.** 응답 직후의 `git worktree list` 에는 아직 남아 있다.
  이때 `git worktree remove` 를 덧붙이면 `is not a working tree` 로 실패한다. 손대지 말고 `ls -d "$WORKTREE"` 로 디렉터리가 사라졌는지 확인한 뒤 `prune` 한다
- `orca worktree rm` 은 그 워크트리의 로컬 브랜치까지 지우므로, 이어서 `git branch -d` 가 `not found` 로 끝나면 이미 지워진 것이다

지우기 전에 미커밋 변경과 stash 를 확인한다. `.omc/` 처럼 추적되지 않는 디렉터리만 남은 것은 지워도 된다.

### Docker 자원 반납

**작업이 띄운 컨테이너와 쌓은 이미지도 정리가 반납한다.** 검사 스크립트의 trap 은 셸이 신호로 죽으면 돌지 않아, 끊긴 worker 의 컨테이너가 남는다.
**귀속을 확인한 것만 지운다.** 같은 PC 에 다른 프로젝트의 Testcontainers, compose 컨테이너와 볼륨이 함께 있다.
판정과 출력 줄은 `scripts/lib/docker.ts` 머리 주석이 소유한다.

| 언제 | 지우는 것 | 근거 |
| --- | --- | --- |
| `remove-worktree.ts` 가 워크트리를 지운 직후 | `com.docker.compose.project.working_dir` 가 그 워크트리이거나 그 아래인 컨테이너 | compose 가 붙인 표식 |
| 같은 때 | 위 컨테이너의 compose 프로젝트 네트워크. 그 프로젝트의 컨테이너가 모두 그 워크트리 것일 때만 | 같은 프로젝트 이름을 다른 체크아웃이 쓰면 남긴다 |
| `cleanup-sweep.ts` 의 저장소마다(상주 루프의 틱마다) | `config.json` 의 `docker.containers` 규칙에 맞는 컨테이너 가운데, 이름의 PID 가 없는 것. 이름에 PID 가 없는 규칙은 멈춘 것만 | 저장소가 선언한 표식과 이름 |
| 같은 때 | `docker.images` 규칙에 맞는 이미지 태그 가운데 저장소 이름마다 최근 `keep` 개와 컨테이너가 쓰는 것을 뺀 나머지 | 저장소가 선언한 이미지 이름 |

컨테이너는 `docker rm -f -v` 로 지운다. 익명 볼륨만 함께 지워지고 이름 있는 볼륨은 남는다.
지운 것과 남긴 것(규칙에 맞았지만 PID 가 살아 있다, 최근 `keep` 개 안이다 같은 까닭)을 한 줄씩 낸다. `cleanup-sweep.ts` 는 `--apply` 가 없으면 지울 것만 낸다.
Docker 가 없거나 데몬이 꺼져 있으면 `Docker 정리 건너뜀: <이유>`(기본 출력은 `KEPT docker <이유>`) 한 줄만 내고 나머지 정리는 그대로 한다.

**아래는 orch 가 지우지 않는다.** 귀속을 알 수 없거나 운영 데이터일 수 있다.

- 이름 있는 볼륨. compose 가 만든 데이터 볼륨도 여기 든다
- build cache, `docker system prune`, 귀속 없는 dangling 이미지와 볼륨. `mac-cleanup` 스킬이 맡는다
- 규칙에 맞지 않는 컨테이너와 이미지. 줄도 내지 않는다

규칙 칸의 형식은 [`overlay.md`](overlay.md) 의 「마무리 설정 파일」 표가 소유한다.
검사 스크립트가 컨테이너를 띄우는 저장소는 표식과 `<이름>-<PID>` 이름을 함께 붙이고 그 둘을 규칙으로 선언한다.
이름에 PID 를 넣어야 띄운 셸이 살아 있는 동안의 컨테이너를 지우지 않는다.

```json
{
  "docker": {
    "containers": [{ "label": "fos-assistant.temp", "name": "mysql-migration-check-(?<pid>\\d+)" }],
    "images": [{ "repository": "fos-synthetic-(loopback|chrome)-test", "keep": 1 }]
  }
}
```

### 남기는 것

- PR 이 열려 있는 워크트리. 리뷰 반영에 필요하고, 머지된 뒤에 지운다
- `release/*` 브랜치. 머지 여부와 무관하게 릴리스 이력이다

### handoff 산출물 정리

끝난 작업의 큐 로그, 지시서, 오래된 handoff 폴더와 미리보기, 지난 csv·tsv 는 `handoff-cleanup.ts` 가 휴지통 폴더로 옮긴다. 지우지 않으므로 되살릴 수 있다.
**사용자에게 묻지 않고 `--apply` 로 옮긴다.** 휴지통 폴더라 되살릴 수 있다. 판정 조건과 옵션은 스크립트 머리 주석이 소유한다.
**코디네이터와 핸들러는 `--run` 을 준다.** 그 Run 의 Task 가 쓴 지시서와 PR 본문만 옮겨 다른 세션의 산출물을 건드리지 않는다.
`tick` 이나 `after-cleanup` 핸들러에서 부르면 입력의 `run` 을 넘긴다. 큐 로그, 폴더, csv 는 Run 에 묶을 수 없어 `--run` 없이 사용자가 직접 돌릴 때만 옮긴다.

```bash
orch cleanup handoff --apply
```

기능 PR 의 완료 근거는 [기능 루프](feature-loop.md#pr-과-완료-근거)를 따른다. finish-pr 은 기능 PR 도 배포 확인 전에 워크트리·브랜치·빈 터미널을 지운다. 근거 누락이나 대기면 지시서, 업무 완료, 보드를 남기고 FINISH-FAIL 로 끝난다. 후속 검증을 갱신한 뒤 같은 명령으로 재개한다.
