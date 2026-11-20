# orch 메인 코디네이터 기술 설계

스펙: [spec.md](spec.md). 스펙 「PR 순서」 의 PR1(메인 판별·넘겨받기·요청)과 PR2(쓰기 제한·우회·doctor 알림)를 다룬다.
PR2(메인이 아닌 세션의 쓰기 명령 거절과 우회 옵션)는 아래 「쓰기 명령 제한」 이 소유한다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | `lib/main-coordinator.ts` 의 `findMain` 이 루프 등록(`state/loop-runs/`), `run-list` 의 `coordinator_handle`, `terminal list` 의 `agentIdentity` 로 메인을 정한다. `orch status` 가 `MAIN` 줄을 낸다. `orch loop start` 는 등록되지 않은 Run 이 메인이 있는 루프에 들어오려 하면 `MAIN-EXISTS` 와 요청 명령을 내고 6 으로 끝난다 |
| REQ2 | 메인이 없으면 `loop start` 가 넘겨받기를 한다. 도는 루프를 멈추고 옛 등록을 지운 뒤 자기 Run 으로 루프를 띄우고, 옛 Run 의 이 저장소 worker 를 새 Run 으로 옮긴다. 옮기지 못한 worker 와 열린 요청을 줄로 낸다. 작업 중이라 남은 worker 는 메인의 `loop start --take-over` 가 다시 옮긴다 |
| REQ3 | `--take-over` 는 `--confirmed "<사용자 답>"` 이 있어야 진행한다. 없으면 `TAKEOVER-CONFIRM` 과 6 이다. 진행하면 REQ2 와 같은 넘겨받기를 하고 앞 메인 Run 에 `MAIN-TAKEN` 을 보낸다 |
| REQ4 | 새 명령 `orch request send --to <저장소>` 가 받는 저장소의 메인을 찾고, 그 저장소의 요청 번호(`R<n>`)를 잡아 기록을 쓴 뒤 메인 Run 에 Orca 메시지를 보낸다. 메인이 없으면 보내지 않고 `REQUEST-NO-MAIN` 과 직접 띄우는 명령을 낸다 |
| REQ5 | 보낼 때 받는 저장소 보드에 `req-<n>` 항목을, 다른 저장소면 보낸 저장소 보드에 `req-<받는 저장소 이름>-<n>` 항목을 만든다. 같은 저장소면 받는 쪽 항목 하나다 |
| REQ6 | `orch request accept|hold|reject <번호>` 가 기록과 양쪽 보드 항목을 바꾸고 답을 보낸다. `hold`, `reject` 는 `--reason` 이 없으면 사용법 오류다 |
| REQ7 | `finish-pr` 이 `FINISH-DONE` 직전에, 찾은 보드 항목이 요청 항목(`req-<n>`)이고 마지막 PR 이며 이번 마무리가 그 항목을 done 으로 닫았으면 그 요청을 완료로 보낸다. 같은 요청의 다른 PR 이나 끝나지 않은 단계가 남으면 `REQUEST-OPEN` 줄만 낸다. 보내지 못하면 기록에 `pending_done` 을 남기고 루프가 다음 틱에 다시 보낸다. 그 밖은 `orch request done|fail <번호>` 로 직접 보낸다(`fail` 은 `--reason` 필수) |
| REQ8 | 답의 대상은 보낸 Run 의 코디네이터 터미널에 에이전트가 있으면 그 Run, 없으면 보낸 저장소의 지금 메인, 그것도 없으면 보낸 Run 이다. 요청 기록이 받는 저장소에 있으므로 메인이 바뀌어도 지금 메인이 `orch request list` 와 넘겨받기 출력으로 이어 맡는다 |
| REQ9 | 새 루프 단계 `steps/requests.ts` 가 틱마다 받은 지 `pipeline.request_ack_sec`(기본 1800초)가 지난 `sent` 요청을 찾아 REQ8 의 대상에 `REQUEST-NO-ACK` 를 한 번 보낸다 |
| REQ10 | 코드 변경 없음. 요청으로 띄운 worker 는 받은 메인의 Run 에 묶이므로 질문도 받은 메인에게 간다. `references/requests.md` 에 적는다 |
| REQ11 | 아래 「쓰기 명령 제한」 |
| REQ12 | 아래 「쓰기 명령 제한」 |
| REQ13 | PR1 은 살아 있는 등록 Run 을 지우지 않는다(이미 등록된 Run 은 지금처럼 `LOOP-RUNNING`). 메인은 등록 순서로 첫 살아 있는 Run 이라 「가장 먼저 등록한 Run」 과 같다. doctor 는 `lib/main-guard.ts` 의 기록 조회로 남은 소유를 알린다 |

## 책임과 경계

| 모듈 | 소유 | 새로 만드는가 |
| --- | --- | --- |
| `scripts/core/main-coordinator.ts` | 메인 판정(`judgeMain`), 답 대상 판정(`replyTarget`), 요청 상태 전이(`nextRequestState`). 값만 받아 결과를 낸다 | 새로 |
| `scripts/lib/main-coordinator.ts` | Orca 조회(`run-list` 전체 페이지, `terminal list`)와 `findMain`, `runAlive` | 새로 |
| `scripts/lib/requests.ts` | 요청 기록 읽기와 쓰기, 번호 잡기(파일 잠금), 보드 항목 쓰기, 답 보내기 | 새로 |
| `scripts/request/orch-request.ts` | `orch request …` 명령 | 새로 |
| `scripts/loop/takeover.ts` | worker 옮기기, 옮길 Run 목록(`state/takeover.json`), 넘겨받은 뒤의 출력과 알림 | 새로 |
| `scripts/loop/lifecycle.ts` | `start` 앞에 넘겨받기 잠금, 메인 판정, 넘겨받기 차례(루프 멈춤, 등록 지우기, 띄우기)를 넣는다. 나머지는 그대로 | 고침 |
| `scripts/loop/steps/requests.ts` | 답 없음 알림과 자동 완료 다시 보내기. 틱의 마지막(13번) 단계이고 저장소마다 틱에 한 번 돈다 | 새로 |
| `scripts/queue/finish-pr.ts` | 마무리 끝의 자동 완료 한 곳 | 고침 |
| `scripts/status/orch-status.ts` | `MAIN`, `REQUESTS` 줄 | 고침 |
| `scripts/lib/run-notice.ts` | `notifyRun` 에 payload 의 `source` 를 바꾸는 옵션 | 고침 |

의존 방향은 기존 층([ADR-028](../../adr/028-orch-core-layer.md))을 따른다. `core` 는 `lib` 를 부르지 않고, 명령과 루프 단계가 `lib` 를 부른다.
요청 기록은 받는 저장소가 소유한다. 보낸 쪽은 기록을 갖지 않고 보드 항목만 갖는다. 받는 쪽 명령이 보낸 저장소의 보드 파일(`boardPath(from.repo)`)을 직접 고친다. 두 저장소가 같은 머신에 있어 경로로 닿는다.

## 인터페이스와 데이터

### 메인 판정

`judgeMain(entries, coordinators, terminals)`:

- `entries` 는 `registeredRuns(repo)` 결과(등록 이른 순)다.
- 각 Run 의 터미널은 `run-list` 의 `coordinator_handle` 과 등록 파일의 `coordinator_terminal` 이다(REQ1 의 「같은 Run 에 묶인 다른 터미널」).
- 그 터미널 가운데 `terminal list` 에 있고 `agentIdentity` 가 있으며 `connected` 가 false 가 아닌 것이 하나라도 있으면 살아 있는 Run 이다(DECISION19).
- 결과는 `{ kind: 'main', run, terminal }`(첫 살아 있는 Run), `{ kind: 'none', stale: [Run…] }` 가운데 하나다. 조회가 실패하면 `findMain` 이 `{ kind: 'unknown', error }` 를 낸다.

등록이 하나도 없으면 Orca 를 조회하지 않고 `none` 이다.

### `orch loop start` 의 차례

1. 지금처럼 명의 확인(`callerFenced`)을 한다.
2. 등록이 하나도 없으면 지금 흐름(띄우기, 합류)이다. 넘겨받을 것도 맞설 메인도 없다.
3. 등록이 있으면 넘겨받기 잠금(`state/takeover.lock`, 60초 대기)을 쥐고 그 안에서 `findMain` 을 부른다. 잠금을 얻지 못하면 `TAKEOVER-BUSY` 와 1 이다.
   기다린 쪽은 먼저 넘겨받은 Run 을 메인으로 보고 `MAIN-EXISTS` 로 끝난다. 두 세션이 함께 worker 를 옮기지 않는다.
   - `unknown` 이면 `MAIN-UNKNOWN <이유>` 와 1 이다. 메인을 모른 채 루프를 빼앗지 않는다.
   - `none` 이면 이 Run 밖의 등록을 지우고 넘겨받는다. 다른 등록이 없어도 도는 루프가 다른 Run 의 명의(`loop.json` 의 `bound_run`)로 묶였으면 넘겨받아 다시 띄운다.
   - `main` 이고 이 Run 이면, 도는 루프가 다른 Run 의 명의로 묶였을 때만 넘겨받아 다시 띄운다(배포 전부터 등록된 앞 Run 이 죽은 경우). `--take-over` 를 줬으면 먼저 남은 worker 를 다시 옮긴다. 그 밖은 지금 흐름이다.
   - `main` 이고 다른 Run 인데 이 Run 이 이미 등록돼 있으면 지금 흐름이다(DECISION24).
   - `main` 이고 다른 Run 이면 `--take-over` 가 없을 때 `MAIN-EXISTS <Run> terminal=<handle>` 과 안내(요청 명령, 넘겨받기 옵션)를 내고 6 이다.
     `--take-over` 만 있으면 `TAKEOVER-CONFIRM <Run> terminal=<handle>` 과 6 이다. `--confirmed "<사용자 답>"` 이 함께 있을 때만 넘겨받는다. 이때 지우는 등록은 앞 메인과 살아 있지 않은 Run 이다.
4. 넘겨받기(`lifecycle.ts` 의 `takeOver`, 세부는 `loop/takeover.ts`):
   1. 도는 루프 프로세스를 멈춘다(기존 `stopProcess`). 멈추지 못하면 등록을 건드리지 않고 `TAKEOVER-FAIL stop` 이다. 옛 루프는 앞 메인의 명의로 묶여 있어 그대로 두면 `LOOP-START-FENCED` 가 난다.
   2. 지울 등록을 지우고 `state/takeover.json` 의 옮길 Run 목록에 더한다.
   3. 지금 흐름으로 새 루프를 띄운다. 실패하면 `TAKEOVER-FAIL start` 다. 이 Run 은 이미 등록됐으므로 같은 명령을 다시 부르면 메인으로 이어 간다.
   4. 새 `loop.json` 의 `bound_run` 이 이 Run(또는 묶이지 않음)일 때만 worker 를 옮긴다(아래 「worker 옮기기」). 아니면 `TAKEOVER-RACE <bound_run>` 이다.
   5. `MAIN-TAKEN <새 Run> from=<지운 Run 목록>` 을 내고, 명시적 넘겨받기면 앞 메인 Run 에 `MAIN-TAKEN` 알림을 보낸다. 본문에 사용자 답을 담는다.
   6. 끝나지 않은 요청마다 `REQUEST-OPEN <번호> <상태> <제목>` 을 낸다.

[ADR-032](../../adr/032-loop-bundle-handover.md) 의 넘겨받기(옛 루프가 새 루프를 자식으로 띄우고 잠금을 넘긴다)는 쓰지 않는다. 새 루프는 넘겨받는 터미널의 명의로 떠야 해서, 옛 루프가 띄우면 다시 옛 명의가 된다.
명시적 넘겨받기에서 앞 메인이 돌리던 머지 큐와 마무리 프로세스는 그대로 끝까지 돈다. 루프를 멈춰도 그 프로세스는 루프의 자식이 아니다.

새 종료 코드 6 은 「메인이 있어 등록하지 않았다」 다. 5(명의)와 4(이미 돈다)와 나눈다.

### worker 옮기기

앞 Run 마다 `worker-list --run` 을 읽어, 살아 있는 dispatch 가운데 워크트리가 이 저장소의 git 워크트리(주 checkout 은 뺀다)인 것만 옮긴다.
다른 저장소의 worker 는 옮기지 않고 `WORKER-OTHER-REPO <터미널> <dispatch> <워크트리>` 로 보이기만 한다. 그 저장소에서 남은 worker 를 알리는 일은 PR2 의 doctor 가 맡는다. 스펙 REQ2 의 「옛 메인의 worker」 를 저장소 기준으로 읽은 것이다(DECISION20 「요청과 worker 를 저장소 기준으로 둔다」).
옮기기 전에 모두 확인하고, 하나라도 맞지 않으면 그 worker 는 옮기지 않는다.

| 확인 | 맞지 않으면 |
| --- | --- |
| 터미널이 열려 있고 에이전트가 있다 | `WORKER-NOT-MOVED <터미널> <dispatch> 터미널 없음` |
| 화면이 idle, error, interrupted 다(lib/screen 의 classify) | `… 작업 중`. 작업 중인 dispatch 를 끊으면 그 턴의 보고가 사라진다 |
| 띄우기 기록(`state/launched-workers/<dispatch>.json`)의 지시서가 있다 | `… 지시서 모름` |
| `worker-start` 가 `--terminal` 을 받는다 | `… CLI 가 이어 붙이기를 모른다` |

확인을 마치면 `worker-abandon --dispatch <앞 dispatch>` 뒤 `worker-start --terminal <터미널> --worktree path:<워크트리> --run <새 Run> --spec "지시서 <이어받기 파일> 를 …"` 를 부른다.
이어받기 파일은 `lib/sessions.ts` 의 `handover` 를 쓴다. 새 dispatch 는 앞 기록을 복사해 `recordLaunch` 로 남기고 앞 기록은 지운다.
보드의 worker 줄은 `board.ts worker-add <항목> <역할> --dispatch <새 dispatch>` 로 다시 잇는다. 앞 dispatch 는 abandoned 라, 줄을 그대로 두면 끊긴 worker 로 보인다.
`worker-start` 가 실패하면 다시 시도하지 않고 `WORKER-MOVE-FAIL <터미널> <이어받기 파일>` 을 낸다. 그 터미널은 dispatch 가 없어 `orch worker adopt` 로 잇는다. 성공하면 `WORKER-MOVED <터미널> <앞 dispatch> <새 dispatch>` 다.
옮기지 못한 worker(`WORKER-NOT-MOVED`, `WORKER-LIST-FAIL`)가 남은 앞 Run 은 `state/takeover.json` 에 남는다. 작업 중이던 worker 가 쉬면 메인이 `orch loop start --take-over` 로 같은 확인을 거쳐 다시 옮긴다. `orch worker adopt` 는 살아 있는 dispatch 의 터미널을 받지 않으므로 이 길을 쓴다.

### 요청 기록

위치는 받는 저장소의 `<orch 루트>/state/requests/` 다.

| 파일 | 내용 |
| --- | --- |
| `seq.json` | `{"next": <다음 번호>}`. `seq.json.lock` 파일 잠금 안에서 읽고 올린다(work-board 의 `withFileLock`) |
| `R<n>.json` | 요청 하나. 아래 칸. 바꾸는 쪽은 모두 `R<n>.json.lock` 파일 잠금 안에서 다시 읽고 쓴다. 자동 완료와 메인의 실패 답이 겹쳐도 하나만 받는다 |

`R<n>.json` 칸의 원본은 [`docs/data-schema.md`](../../data-schema.md) 의 「orch 루트에 더하는 파일」 이다.
쓰기는 옆 파일에 쓰고 rename 한다(기존 `lib/loop.ts` 의 `replace` 와 같은 방식).

상태 전이(`nextRequestState`):

| 지금 | 받는 동작 |
| --- | --- |
| `sent` | accept, hold, reject, done, fail |
| `held` | accept, hold, reject, done, fail |
| `accepted` | hold, done, fail |
| `rejected`, `done`, `failed` | 없음. `REQUEST-CLOSED <번호> <상태>` 와 3 |

지금 상태가 받지 않는 동작(받은 뒤의 거절)은 `REQUEST-REFUSED <번호> <상태> <동작>` 과 3 이다.

### 보드 항목

`board.ts set` 을 부른다. 보드 파일이 없으면 건너뛰고 `BOARD-SKIP <저장소>` 를 낸다.

| 쪽 | id | 상태 | 제목 |
| --- | --- | --- | --- |
| 받는 저장소 | `req-<n>` | 처음 `wait`, 끝 상태면 `done` | `요청 R<n>: <제목>`(다른 저장소면 뒤에 `(<보낸 저장소 이름>)`) |
| 보낸 저장소(다른 저장소일 때만) | `req-<받는 저장소 이름>-<n>` | 같은 규칙 | `<받는 저장소 이름> 요청 R<n> 기다림: <제목>` |

새 항목은 마일스톤 단계(`lib/milestones.ts`, 기본 PR·머지)와 `stages` 를 갖고 만든다. 받은 메인이 그 요청으로 worker 를 띄울 때 지시서에 `보드 항목 id: req-<n>` 을 두면 `lib/board.ts` 의 기존 항목 분기가 worker 줄을 붙이고 doing 으로 바꾼다. 그 뒤 `finish-pr` 은 보통의 마일스톤 항목처럼 머지와 배포를 반영하고, 마지막 PR 이면 자동 완료를 보낸다.
답마다 이력 한 줄을 `detail-add` 로 더한다. `set --detail` 은 하위 줄 전체를 바꿔 단계를 지우므로 쓰지 않는다. 끝 상태면 done 으로 바꾸되, worker 가 붙은 받는 쪽 항목은 상태를 마무리에 맡긴다.
받는 저장소 이름(폴더 이름)이 같은 두 저장소에서 보낸 쪽 항목 id 가 겹칠 수 있다. 번호가 저장소마다 따로라 실제로 겹치려면 이름과 번호가 함께 같아야 한다.

### 메시지

모든 요청 메시지는 `orca orchestration send --to run:<Run> --type status` 다(DECISION17). payload 는 `{source: "orch-request", kind, request, repo}` 이고 kind 는 아래다.

| kind | 받는 쪽 | 보내는 곳 |
| --- | --- | --- |
| `REQUEST` | 받는 저장소 메인 | `request send` |
| `REQUEST-ACCEPTED`, `REQUEST-HELD`, `REQUEST-REJECTED`, `REQUEST-DONE`, `REQUEST-FAILED` | REQ8 의 대상 | `request` 의 답 명령, `finish-pr` |
| `REQUEST-NO-ACK` | REQ8 의 대상 | `steps/requests.ts` |
| `MAIN-TAKEN` | 앞 메인 Run | 명시적 넘겨받기 |

보내기는 `lib/run-notice.ts` 의 `notifyRun` 을 쓴다. 답은 보내기가 성공한 뒤에 기록에 남긴다. 실패하면 기록과 보드를 바꾸지 않고 1 로 끝나 같은 명령을 다시 부를 수 있다.

### 명령 표

`lib/commands.ts` 에 `request` 묶음을 더한다. 옛 이름은 없다(`legacy: null`).

| 꼴 | 문맥 |
| --- | --- |
| `orch request send --to <저장소> --title <제목> (--body <글> \| --body-file <파일>)` | repo, run(필수, run-current) |
| `orch request accept <번호>` | repo, run |
| `orch request hold <번호> --reason <이유>` | repo, run |
| `orch request reject <번호> --reason <이유>` | repo, run |
| `orch request done <번호> [--reason <이유>]` | repo, run |
| `orch request fail <번호> --reason <이유>` | repo, run |
| `orch request list [--open]` | repo |

`orch loop start` 는 `--take-over`, `--confirmed` 를 받는다.

### 설정

`pipeline.request_ack_sec` 를 더한다. 양수, 타이머 상한 이하, 기본 1800 이다. 틱마다 다시 읽는다.

## 실패와 일관성

- 번호 잡기는 파일 잠금 안에서만 한다. 두 세션이 동시에 보내도 번호가 겹치지 않는다.
- 요청 기록은 받는 저장소 하나에만 있어 두 기록이 어긋날 일이 없다. 보낸 쪽 보드는 받는 쪽 명령이 고치는 사본이다. 보드 쓰기가 실패해도 기록과 메시지는 남기고 `BOARD-FAIL` 을 낸다.
- 보내기와 기록 순서: 메시지가 성공한 뒤 기록을 쓴다. 보낸 뒤 기록이 실패하면 같은 답이 두 번 갈 수 있다. 답을 잃는 쪽보다 낫다.
- `request send` 는 번호를 잡은 뒤 `R<n>.json.lock` 안에서 기록을 `sent` 로 쓰고, 메시지를 보내고, 첫 보드 항목을 만든다. 메인이 곧바로 답해도 답 명령이 같은 잠금을 기다리므로 첫 보드 쓰기가 답을 덮지 않는다. 보내기가 실패하면 기록을 지워 번호만 비게 둔다(번호는 다시 쓰지 않는다).
- 답 없음 알림은 `ack_notice_at` 을 보내기가 성공한 뒤에 잠금 안에서 다시 읽어 쓴다. 실패하면 다음 틱이 다시 한다.
- 받는 저장소의 루프가 죽어 있으면(메인이 끝났고 아직 아무도 넘겨받지 않았다) 답 없음 알림도 나가지 않는다. 다음 세션이 넘겨받으면 루프가 다시 잰다.
- 자동 완료를 보내지 못하면 기록에 `pending_done` 을 남기고, 마무리는 그대로 `FINISH-DONE` 이다. 보드는 이미 바뀌어 같은 마무리를 다시 돌려도 보내지 않기 때문이다. 루프의 같은 단계가 다음 틱에 다시 보낸다.
- 넘겨받기는 넘겨받기 잠금 안에서 루프를 멈춘 뒤 띄운다. 등록이 없는 저장소의 `loop start` 는 이 잠금을 쓰지 않으므로, 그 사이 띄워진 루프가 있으면 새 `loop.json` 의 `bound_run` 이 달라 `TAKEOVER-RACE` 로 worker 를 옮기지 않는다.
- 메인 판정이 Orca 조회 실패로 `unknown` 이면 넘겨받지 않는다. 살아 있는 메인의 루프를 잘못 멈추는 쪽이 더 나쁘다.
- worker 옮기기는 모두 확인한 뒤에만 abandon 한다. `worker-start` 가 실패하면 그 worker 는 dispatch 가 없는 터미널로 남으므로 이어받기 파일 경로를 출력해 `orch worker adopt` 로 잇게 한다.
- `orch status` 의 `MAIN-UNKNOWN` 은 종료 코드를 바꾸지 않는다. 기존 계약(worker 목록과 보드를 읽지 못할 때만 1)을 지킨다. `request send` 는 `MAIN-UNKNOWN` 이면 보내지 않고 1 이다.
- 호환: 이미 등록된 Run 이 여럿인 루프는 그대로 돈다. 새 등록만 막는다(DECISION24). 옛 orch 로 띄운 루프(`runs` 없음)는 넘겨받기에서도 `stopProcess` 로 멈출 수 있다.

## 쓰기 명령 제한

쓰기 명령은 `findMain` 을 그대로 써서 「명령을 부른 Run 이 대상 저장소의 메인인가」 를 묻는 판정 하나(`callerIsMain(repo)`)를 더하고, `worker launch`, `send-to-worker`, `queue merge`, 정리, 보드 쓰기 명령 앞에서 부른다.
우회 옵션(`--not-main "<이유>"`)은 `state/launched-workers/not-main/<id>.json` 에 대상 저장소·부른 Run·메인 Run·명령·이유·시각을 기록한다(스펙 DECISION27). 가짜 dispatch 는 만들지 않는다. worker 를 띄우면 기존 dispatch 기록에도 `not_main` 칸으로 이유를 남긴다. 메인에게 가는 알림은 이 PR 의 `notifyRun` 을 쓴다.
`request` 명령의 답 명령(accept 등)도 같은 검사를 거친다.
막기는 명령 진입점에서 한다. 보드 쓰기 lib 층에 넣으면 `request send` 가 보낸 저장소 보드에 쓰는 일과 받는 쪽 답이 보낸 저장소 보드에 쓰는 일이 막힌다.
doctor 의 「다른 Run 이 띄운 남은 worker」, 「메인이 아닌 등록된 Run」 알림(REQ13)도 PR2 다. 넘겨받기에서 옮기지 못하고 끝난 Run 에 남은 worker 의 워크트리와 지시서도 그 알림이 다룬다. 새 메인의 Run 별 정리는 그 Run 이 띄운 것만 치운다.


`lib/main-guard.ts` 가 실제 `run-current` 로 호출자를 확인한다. 명령별 옵션을 파싱한 뒤 쓰기 전에 검사하므로 새 CLI·옛 이름·직접 스크립트 호출에 같은 규칙이 적용된다. dispatch 는 실제 `worker-show` 의 worktree, 보드는 명시·설정 파일의 실제 저장소를 확인한다. 단 `--repo` 의 루프 한 틱이 부른 `board sync` 는 `--repo` 기준으로 확인한다. 보드를 나눠 쓰는 저장소의 루프가 자기 PR 을 그 보드에 반영해야 하기 때문이다. 이때 루프는 자기 저장소가 띄운 worker 의 항목만 고친다. 항목의 PR 번호를 자기 저장소 기준으로 조회하므로 남의 항목은 보드 저장소의 루프에 맡긴다. 루프 밖에서 부른 보드 쓰기는 그대로 보드 저장소의 메인을 확인한다. 조회 실패를 다른 저장소로 대체하지 않는다. 루프 한 틱은 자식에게 `ORCH_LOOP_CALLER` 로 자기 저장소와 등록 Run 을 넘긴다. 가드는 대상 저장소·첫 등록 Run·현재 루프 소유가 일치하고, PID 와 시작 시각·명령줄로 실제 루프의 자식임을 확인한 뒤 터미널 조회 없이 통과시켜, Orca 재시작이나 앞 터미널 종료가 자동 동작을 막지 않게 한다.

`Launch.main_guard` 는 처음 띄울 때 메인과 부른·대상 저장소를 남긴다. 표지가 없는 옛 기록과 메인이 없을 때 띄운 기록은 원래 Run 의 해당 worker 에만 예외다. 후속·재개는 그 예외를 보존한다. PR 일괄 작업은 모든 PR 의 브랜치 소유를 확인한다. 예외로 실행하는 정리는 해당 워크트리만 다루고 저장소 전체 fetch·prune·나머지 정리 단계와 after-cleanup 은 생략한다.

같은 쓰기 명령이 띄운 자식은 `ORCH_MAIN_GUARD_RECEIPT` 로 성공한 우회 기록을 이어받는다. 비밀값은 자식 체인의 환경 변수에만 넘기고 기록에는 SHA-256 을 남긴다. 긴 CI·배포 대기에도 이 체인은 유지한다. 대상 저장소와 기록 위치, 알림 성공 여부와 이유, 허용된 명령 전이를 확인해 바깥 명령의 기록과 알림을 재사용한다. 같은 프로세스의 별도 명령과 다른 저장소에는 적용하지 않는다.

## 검증 전략

| ID | 경계 | 확인 |
| --- | --- | --- |
| REQ11 | `main-guard.spec.ts` 의 실제 CLI·직접 명령 | 메인·비메인·Run 없는 셸, 조회·dry-run·잘못된 인자, 실제 dispatch·보드 저장소와 `--run` 사칭, Run 에 묶인 호출의 조회 실패 거절, handle 없는 사람 셸의 Orca 장애 중 쓰기 허용, 실제 루프 한 틱의 자식 허용과 위조 표시 거절 |
| REQ12 | `main-guard.spec.ts`, `launch-worker.spec.ts` | 빈 이유 거절, 별도 우회 기록·메인 알림, 자식 체인에서 기록과 알림 1회 재사용, 비밀값 없는 재사용과 다른 명령·저장소의 표시 거절과 긴 대기 뒤 체인 유지, 허용된 호출의 이유 무시, 기록·알림 실패 시 쓰기 없음, dispatch 이유 보존 |
| REQ13 | `main-guard.spec.ts`, `cleanup-sweep-launched.spec.ts` | 옛·메인 없을 때 worker 의 원래 Run 만 허용, 깨진 새 표지 거절, Run 옵션 없는 finish 와 직접 sweep → 실제 worktree 정리, 다른 워크트리와 전역 단계 보존, doctor 알림과 정리 뒤 제외 |
| REQ1 | `core` 단위 테스트, `orch status` 명령 테스트 | 판정 표(에이전트 있음·없음, 둘째 터미널, 등록 없음). 가짜 orca 로 `MAIN` 줄 |
| REQ1, REQ2, REQ3 | `orch-loop` 명령 테스트(가짜 orca, 임시 저장소) | `MAIN-EXISTS` 6, `TAKEOVER-CONFIRM` 6, 메인 없음에서 넘겨받기 뒤 등록이 새 Run 하나, `MAIN-UNKNOWN` 1 |
| REQ2 | `takeover` 단위 테스트(가짜 orca 호출 기록) | idle worker 는 abandon 뒤 worker-start, 작업 중이면 `WORKER-NOT-MOVED`, 다른 저장소 worker 는 건드리지 않음 |
| REQ4~REQ8 | `request` 명령 테스트(임시 저장소 둘, 가짜 orca, 가짜 보드) | 번호, 기록, 양쪽 보드 항목, 같은 저장소 항목 하나, 이유 필수, 닫힌 요청 3, 답 대상 대체 |
| REQ7 | `finish-pr` 테스트 | 요청 항목을 done 으로 바꾼 마무리가 `REQUEST-DONE` 을 내고 기록이 done |
| REQ9 | 루프 단계 테스트 | 기한 전 안 보냄, 지난 뒤 한 번, 두 번째 틱 안 보냄 |
| REQ2(DECISION19 가정) | 실제 Orca 확인 | 코디네이터 터미널에서 에이전트를 끝내 셸만 남기면 `terminal list` 의 그 터미널에 `agentIdentity` 가 없어지고 `orch status` 가 `MAIN-NONE` 을 낸다 |
| 실제 Orca | PR 뒤 수동 확인 | 이 저장소에서 `orch status` 의 `MAIN` 줄, 다른 Run 터미널의 `loop start` 가 `MAIN-EXISTS` |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| D1 | 저장소의 코디네이터 구조 | 메인 Run 하나가 루프를 맡고 교대와 넘겨받기를 둔다. architecture 결정이라 [ADR-035](../../adr/035-orch-main-coordinator.md) 가 [ADR-012](../../adr/superseded/012-orch-loop-multi-run.md) 를 대체한다. 현재 규칙의 원본은 이 설계와 `loop/lifecycle.ts`, `loop/takeover.ts` 머리 주석이다 | 사용자 2026-11-17 | 스펙 DECISION3, DECISION5, DECISION19, DECISION20 |
| D2 | 요청 기록의 자리 | 받는 저장소에 둔다. ADR 은 따로 두지 않는다. 스펙 REQ8 을 따른 배치이고 대안은 아래 표다 | 작성자 | 메인이 바뀌어도 지금 메인이 같은 자리에서 이어 맡는다 |
| D3 | 넘겨받기의 사용자 확인 받는 법 | `--confirmed "<사용자 답>"` 으로 받고 앞 메인에게 가는 알림에 남긴다 | 작성자 | 채팅 승인을 스크립트가 확인할 길이 없는 것은 보드 승인 설계의 기존 한계와 같다 |

| 기각한 대안 | 이유 |
| --- | --- |
| 새 세션이 `run-use --id <앞 메인 Run>` 으로 앞 Run 에 옮겨 붙는다 | worker 를 옮기지 않아도 되지만, 새 세션의 Run 메일을 끊는다(Orca: run-use keeps only the Run it names). 새 세션이 다른 저장소 worker 를 맡고 있으면 그 보고를 잃는다. 스펙 DECISION20 도 새 Run 으로 옮기기로 정했다 |
| 요청 기록을 보낸 저장소에 둔다 | 받는 메인이 바뀌면 새 메인이 요청을 찾을 곳이 없다. 30분 알림도 보낸 쪽 루프가 없을 수 있어 잴 수 없다(DECISION18) |
| 받음을 자동으로 보낸다 | 방치된 요청을 30분 알림이 잡지 못한다(DECISION22) |
| 넘겨받기 확인을 보드 승인(`check`)으로만 받는다 | 보드 창이 없는 세션에서 넘겨받을 수 없다. 채팅 승인을 인정하는 기존 규칙과도 어긋난다 |
