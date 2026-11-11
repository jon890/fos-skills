# 저장 모델

이 저장소는 데이터베이스를 쓰지 않는다. 이 문서는 orch 가 저장소와 주고받는 파일 계약을 소유한다.
지금 쓰는 `.orch/` 폴더 구조와 설정 키는 [`skills/orch/references/overlay.md`](../skills/orch/references/overlay.md) 가 소유하고, 이 문서는 개편으로 바뀌는 부분만 적는다.
아래는 개편 뒤의 계약이다([ADR-009](adr/009-orch-event-handlers.md), [ADR-010](adr/010-orch-typescript.md)).
상주 루프의 자동 진행(ready 슬롯, base 합치기, 순서 머지, 문서 PR 머지)과 배포 묶기, `ci-missing` 은 아직 구현하지 않았다.
이 문서의 그 부분은 설계이고, 지금 동작은 `skills/orch/SKILL.md` 와 `skills/orch/references/` 가 소유한다.

## orch 이벤트 핸들러 입력

### 위치와 실행

| 항목 | 값 |
| --- | --- |
| 위치 | `<orch 루트>/hooks/<이벤트>.ts`. orch 루트는 `ORCH_DIR` 이 없으면 주 checkout 의 `.orch/` 다 |
| 이벤트당 파일 | 하나다. 한 이벤트에 여러 일을 하려면 그 파일이 모듈을 import 해 순서를 정한다 |
| 실행 | `node --disable-warning=ExperimentalWarning <파일>`. 작업 디렉터리는 주 checkout 이다. `verify-merged` 만 합친 사본이다. 옛 셸 명령 칸은 `ORCH_CHECKOUT` 에서 돈다(`verify-merged` 는 사본) |
| 입력 | stdin 의 JSON 객체 하나 |
| 환경 | `ORCH_EVENT`, `ORCH_REPO`, `ORCH_DIR`, `ORCH_CHECKOUT`. `ORCH_CHECKOUT` 은 이벤트를 낸 명령이 `--repo` 로 받은 경로의 실경로이고, 연결된 워크트리면 그 워크트리다. 옮기는 명령이 만든 핸들러가 옛 명령을 이 경로에서 부른다. `PATH` 앞에 가드 shim 폴더를 두고 `ORCA`, `GH` 도 그 shim 을 가리킨다. `ORCH_REAL_ORCA`, `ORCH_REAL_GH` 는 가드 shim 이 부를 진짜 실행 파일의 절대경로이고, 찾지 못하면 넘기지 않는다. worker 지시는 `orch worker send` 로 보내고 Orca 가 깨운다. `ORCH_BIN` 은 orch 진입점(`skills/orch/bin/orch.ts`)의 절대경로로, 핸들러는 `node "$ORCH_BIN" worker send …` 처럼 새 꼴로 부른다. `ORCH_SCRIPTS` 는 orch `scripts` 폴더의 절대경로다. 다른 저장소 핸들러가 쓰는 계약이라 계속 넘기지만 스크립트는 그 아래 묶음 폴더(`worker/nudge-worker.ts` 꼴)에 있다. 코어 명령은 `ORCH_BIN` 으로 부른다. 가드는 보안 경계가 아니다([ADR-013](adr/013-orch-worker-stalled.md)) |
| 출력 | stdout 과 stderr 를 코어 출력에 `[hook <이벤트>] ` 를 붙여 옮긴다. 거부 이유는 stdout 의 마지막 빈 줄 아닌 줄이고, 없으면 `(이유 없음)` 이다 |
| 시간 제한 | 기본 120초. `before-merge`, `verify-merged`, `after-queue`, `after-deploy` 는 1800초. `config.json` 의 `hooks.timeouts.<이벤트>` 로 바꾼다. 넘으면 TERM, 10초 뒤 KILL 이다. 핸들러가 끝난 뒤 출력 파이프를 쥔 프로세스가 남으면 2초 뒤 그룹에 TERM, 다시 2초 뒤 KILL 이고, 판정은 핸들러의 종료 코드로 한다. 핸들러보다 오래 돌 일은 stdout 과 stderr 를 넘기지 않고 띄운다 |
| 동시 실행 | 같은 저장소의 같은 이벤트는 `<orch 루트>/state/hooks/<이벤트>.lock` 을 잡고 하나씩 돈다. 잠금 파일은 배타 생성(`wx`)으로 만들고 pid 를 적는다. 다른 실행이 쥐고 있으면 0.5초 간격으로 다시 보며 그 이벤트의 시간 제한에 15초를 더한 만큼 기다린다. 쥔 쪽은 시간 제한과 KILL 유예 10초 안에 끝나기 때문이다. 넘으면 실패로 보고 `HOOK-FAIL <이벤트> lock` 이다. 같은 이벤트가 셋 이상 겹쳐 앞의 실행들이 시간 제한 가까이 돌면 뒤 실행이 이 실패로 끝나는 것은 의도한 동작이다. 죽은 pid 의 잠금은 고유 이름으로 옮긴 뒤 내용을 대조해 회수한다. 보장 범위와 남긴 경합은 `lib/events.ts` 머리 주석의 「잠금」 이 소유한다 |

### 종료 코드

| 코드 | 거부할 수 있는 이벤트 | 나머지 이벤트 |
| --- | --- | --- |
| 0 | 통과 | 성공 |
| 10 | 거부. `HOOK-REJECT` | 실패로 본다 |
| 그 밖, 시간 초과 | 실패. 거부처럼 멈추고 `HOOK-FAIL` | 실패. 코어 동작은 이어 가고 `HOOK-FAIL` |

거부할 수 있는 이벤트는 `before-launch`, `before-ready`, `before-merge`, `verify-merged`, `before-cleanup`, `worker-stalled` 다.
`worker-stalled` 에서는 막을 동작이 없어 10 과 그 밖의 코드가 넘김이다. 핸들러가 처리하지 않고, 코어가 그 Run 메일함에 `WORKER-STALLED` 를 쓴다. 로그에는 10 이면 `HOOK-REJECT`, 그 밖이면 `HOOK-FAIL` 이 남는다.
거부를 1 이 아니라 10 으로 둔 것은 의도한 거부와 예외로 죽은 핸들러를 구분하기 위해서다. node 는 잡지 않은 예외에 1 을 낸다.

### 공통 필드와 이벤트별 필드

입력 필드의 표는 `skills/orch/scripts/lib/events.ts` 머리 주석이 소유한다. 「공통 필드」 와 「이벤트별 필드」 가 그것이다.

5.2.0 전 설정의 환경 변수와 입력 필드 대응이다. `orch doctor migrate-hooks` 가 만드는 핸들러는 이 대응대로 이전 설정의 명령에 환경 변수를 채워 부른다.

| 옛 칸 | 이벤트 | 옛 환경 변수 → 입력 필드 |
| --- | --- | --- |
| `queue.before` | `before-merge` | `PR` → `pr.number`, `BRANCH` → `pr.branch`, `OWNER` → `owner`, `REPO` → `name` |
| `queue.verify_merged` | `verify-merged` | `$1`, `MERGE_COPY` → `copy`, `PR_HEAD` → `pr.head`, `BASE_HEAD` → `base_head`, `CHANGED_FILES` → `changed_files`, `OVERLAP_FILES` → `overlap_files` |
| `queue.after_merged` | `after-queue` | `MERGED_PRS` → `merged_prs`, `CODE_PRS` → `code_prs` |
| `finish.complete_cmd` | `after-deploy` | `{number}` 은 핸들러가 `pr.title` 에서 뽑는다. 정규식은 `finish.task_pattern` 을 옮겨 적고 설정의 그 칸은 남긴다 |

명령줄의 `PR번호:명령` 형식은 그대로 둔다. 그 PR 하나에만 붙이는 일회성 명령이라 핸들러로 옮기지 않는다. `before-merge` 핸들러 다음에 돈다. 입력의 `has_pr_command`는 빈 `PR:`도 true다.
`queue.before`에서 만든 핸들러만 이 값이 true면 기본 명령을 건너뛰어 기존 대체 동작을 지킨다. 수동 핸들러는 항상 실행한다.

## 사용자 결정 질문 형식

worker 가 `worker-ask` 로, 코디네이터가 사용자에게 묻는 결정 질문의 본문 형식이다. 보드가 이 형식을 읽어 결정 필요 항목을 그린다.

```text
결정: <무엇을 정하는지 한 줄>
배경: <왜 지금 정해야 하는지>
선택지:
- <선택지 이름>: <고르면 생기는 결과>
- <선택지 이름>: <고르면 생기는 결과>
권장: <선택지 이름>. <이유>
```

| 규칙 | 값 |
| --- | --- |
| 첫 줄 | `결정:` 으로 시작하고 그 뒤에 제목이 있다. 보드가 이 줄을 항목 제목으로 쓴다. 제목이 비면 보드는 형식이 없는 질문처럼 본문 앞부분을 보인다 |
| 선택지 | `- ` 로 시작하는 줄이 둘 이상이다 |
| 권장 | `권장:` 으로 시작하는 줄이 하나다. 보드가 제목 아래에 이 줄을 보인다 |
| 검사 | `worker-ask --decision` 이 형식을 보고, 어긋나면 묻지 않고 빠진 줄을 알리며 종료 코드 2 로 끝난다 |
| 여러 결정 | `결정:` 줄마다 블록이 나뉜다. 블록마다 위 선택지와 권장 규칙을 따른다. 보드는 첫 결정 제목에 「외 N개」 를 붙이고 첫 권장안을 보인다. spec 인터뷰가 한 라운드의 결정을 한 질문으로 보낼 때 쓴다 |
| 형식이 없는 질문 | 기술 질문이나 막힘 보고다. 보드는 지금처럼 본문 앞부분을 보인다 |

## config.json 에 더하는 절

`.orch/config.json` 의 지금 절(`finish`, `cleanup`, `queue`)은 그대로 읽는다. 모르는 키에 사용법 오류로 멈추는 규칙도 그대로다. 모르는 최상위 절도 같은 사용법 오류다.
아래 절을 더한다.

| 절 | 키 | 타입 | 기본값 | 담는 것 |
| --- | --- | --- | --- | --- |
| `routing` | `review_author` | GitHub 로그인 문자열 | 없음 | 첫 자동 리뷰를 남기는 계정. 절이 없으면 첫 리뷰와 크기 등급은 null이다 |
| `routing` | `review_pattern` | 정규식 문자열. P1~P5 수를 순서대로 캡처한다 | P1~P5 머리의 Markdown 표 | 첫 자동 리뷰 본문의 지적 수를 읽는 꼴 |
| `routing` | `size_pattern` | 정규식 문자열. 첫 캡처가 크기 등급이다 | 없음 | 저장소가 리뷰 본문에 적은 등급을 읽는다. 새 등급을 계산하지 않는다 |
| `inbox` | `enabled`, `dooray`, `slack` | `enabled` 는 bool, 나머지는 adapter 이름 아래 값 목록(두레이는 `projects`·`channels`, Slack 은 `channels`) | 절이 없으면 필터 없이 모두 보인다 | inbox 스킬의 저장소별 알림 필터. `enabled: false` 면 그 저장소의 보드가 알림을 보지 않는다. 옛 자리 `config/notification.json` 은 inbox 스킬이 한 major 동안 함께 읽고, `inbox` 절이 있으면 무시한다 |
| `hooks` | `timeouts` | 이벤트 이름에서 초로. 모르는 이벤트 이름이나 양수가 아닌 값은 사용법 오류다 | 위 「위치와 실행」 | 핸들러 시간 제한 |
| `pipeline` | `enabled` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. 상주 루프가 하는 일은 모두 이 값과 무관하게 돈다 |
| `pipeline` | `tick_sec` | number | 300 | 틱 간격 |
| `pipeline` | `digest_sec` | number | 1800 | 안내성 루프 알림(WATCH-ERROR, LEGACY-NOTICE, STAGE-STALLED, LOOP-RESTARTED)을 DIGEST 하나로 모아 보내는 주기(초) |
| `pipeline` | `ready_slots` | number | 1 | 동시에 ready 로 둘 내 PR 수. `orch queue ready` 가 읽는다. CI runner 수에 맞춘다 |
| `pipeline` | `docs_merge` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. 문서 PR 바로 머지는 하지 않는다 |
| `pipeline` | `after_queue_interval_sec` | number | 0 | 읽는 코드가 없다. 설정 검사만 통과시킨다. `after-queue` 는 묶이지 않는다 |
| `pipeline` | `ci_missing_after_sec` | number | 600 | 읽는 코드가 없다. 설정 검사만 통과시킨다. `ci-missing` 을 내는 코드도 아직 없다 |
| `pipeline` | `update_behind_drafts` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. draft PR 에 base 를 합치지 않는다 |
| `pipeline` | `refresh_slots` | 0 이상의 정수. 아니면 설정 오류다 | 0 | 상주 루프가 머지 차례 전에 뒤처진 ready PR 에 base 를 미리 합치는 최신화를 켠다. 값은 루프가 건 최신화 가운데 CI 가 아직 도는 것의 상한이다. 0 이면 끈다. CI runner 수보다 작게 둔다. 대상과 순서는 `loop/steps/refresh.ts` 머리 주석의 「최신화」 가, 근거는 [ADR-020](adr/020-orch-loop-refresh.md) 가 소유한다 |
| `pipeline` | `refresh_worker_paths` | 정규식 문자열이나 그 목록(Python 정규식. 목록은 `\|` 로 잇는다) | 없음 | 최신화할 PR 과 base 가 모두 바꾼 파일이 이 정규식에 맞으면 update-branch 대신 그 PR 의 살아 있는 worker 에게 합치기를 보낸다. 계약 버전 파일처럼 글자 충돌이 없어도 worker 가 판단해야 하는 파일을 적는다. `refresh_slots` 가 0 이면 읽지 않는다 |
| `pipeline` | `authors` | 문자열 목록 | gh 의 현재 사용자 | 「내 PR」 로 볼 작성자. 루프, 원격 브랜치 정리, 충돌 알림이 이 PR 만 본다 |
| `pipeline` | `stall_ticks` | `{"error": 정수, "idle": 정수}`. 모르는 키나 0 미만, 정수가 아닌 값은 사용법 오류다 | `{"error": 2, "idle": 0}` | 상주 루프가 같은 멈춤 화면을 몇 틱 보면 `worker-stalled` 를 낼지. 0 이면 그 상태를 보지 않는다. 판정은 `loop/steps/stalls.ts` 머리 주석의 「멈춤 확인」 이 소유한다 |
| `pipeline` | `idle_min` | 0 이상의 수(분). 아니면 설정 오류다 | `30` | 열린 dispatch 의 워크트리 파일, 브랜치 커밋, 화면이 이 분 넘게 그대로면 멈춘 worker 로 본다. worker 없이 남은 보드 단계도 이 분이 지나면 알린다. 0 이면 둘 다 보지 않는다. 보드 창의 worker 줄 표시(멈춤, worker 없음 경과 시간)도 같은 값을 쓴다. 판정은 `lib/movement.ts` 머리 주석이 소유한다 |
| `pipeline` | `idle_exited` | true 나 false. 아니면 설정 오류다 | `true` | Orca 가 프로세스가 끝났다고 본(liveness `exited`) 열린 dispatch 를 멈춘 worker 로 볼지. 보드 창의 「멈춤 · 터미널 종료」 도 같은 값을 쓴다 |
| `board` | `steps` | 비지 않은 문자열 목록. 줄 앞 꼬리표는 `[pr]`, `[merge]`, `[deploy]`, `[release]` 중 하나이고 한 번씩만 쓴다. 다른 꼬리표는 사용법 오류다 | `["[pr] PR", "[merge] 머지"]` | 띄울 때 만드는 보드 마일스톤 단계. 지시서의 `## 보드 단계` 절이 앞선다. 근거는 [ADR-018](adr/018-board-milestone-steps.md) 가 소유한다 |
| `board` | `task_line` | 정규식 문자열. 이름 붙은 묶음 `number` 가 있어야 하고 `title` 은 선택이다. `m`, `u` 플래그로 읽는다 | `두레이 업무: <프로젝트>/<번호>` 뒤 같은 줄의 「」 안을 제목으로 읽는 꼴(`lib/milestones.ts` 의 `DEFAULT_TASK_LINE`) | 띄울 때 지시서에서 업무 번호와 제목을 읽는다. 번호는 보드 항목 제목 앞에 붙고, 같은 번호의 끝나지 않은 항목을 이어 쓰는 기준이 된다 |
| `board` | `done_after` | `merge`, `deploy`, `release` 중 하나 | `merge` | 마지막 PR 이 이 사건 단계에 닿으면 보드 항목을 done 으로 바꾼다. 항목에 그 단계가 없으면 가장 늦은 사건 단계에서 바꾼다 |
| `heavy` | `exclusive`, `normal`, `light` | 정규식 목록 | 빈 목록 | 무거운 검사 분류. 앞의 목록부터 맞춰 본다. 어디에도 맞지 않으면 `normal` 이다 |
| `heavy` | `wait_idle` | 정규식 목록 | 빈 목록 | 자리를 잡기 전에, 명령줄이 이 정규식에 맞는 프로세스가 없을 때까지 기다린다. 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스가 대상이다 |
| `review` | `prepare` | bash 명령 문자열. 문자열이 아니면 사용법 오류다 | 없음(준비하지 않는다) | `launch-worker` 가 지시서에 `리뷰 PR: #<N>` 줄이 있는 리뷰 worker 의 워크트리를 PR head 에 둔 뒤 그 워크트리에서 한 번 돌리는 생성물 준비 명령. 실패해도 worker 는 뜬다. 차례와 환경 변수는 `launch-worker.ts` 머리 주석의 2-1 이 소유한다 |
| `queue` | `auto_merge` | bool | false | 상주 루프가 머지할 수 있는 PR 을 스스로 `merge-with-finish.ts` 에 건다. 대상과 순서는 `loop/steps/auto-merge.ts` 머리 주석의 「자동 머지」 가, 근거는 [ADR-016](adr/016-orch-auto-merge.md) 가 소유한다. `pipeline.enabled` 와 무관하다 |
| `queue` | `auto_review` | `{"pass": 정규식, "block": 정규식, "require": [조건 이름], "feature_head": 참·거짓}`. `pass`, `block` 은 비지 않은 문자열이고 `require` 는 없거나 비지 않은 문자열의 비지 않은 목록이다. `feature_head` 는 없거나 `true`, `false` 다 | 없음(리뷰 판정을 보지 않는다). `require` 가 없으면 `["verdict-on-head"]`, `feature_head` 가 없으면 `true` | 자동 리뷰의 판정 문구와 판정 조건의 조합. `pass` 나 `block` 에 맞는 리뷰나 댓글이 「판정」 이고 둘 다 맞으면 `block` 이다. Python 정규식이고 본문 어디든 맞으면 된다. `require` 의 조건을 모두 만족해야 자동 머지 대상이다. 조건은 `verdict-on-head`(지금 HEAD 범위의 마지막 판정이 `pass`), `verdict-seen`(PR 에 판정이 하나 이상), `last-verdict-pass`(PR 전체의 마지막 판정이 `pass`. HEAD 가 달라도 된다), `rereview-after-block`(마지막 `block` 뒤에 같은 커밋이나 그 뒤 커밋의 `pass` 가 있다. `block` 이 없으면 통과)이다. 조건의 정확한 뜻은 `lib/auto-merge.ts` 머리 주석의 「judgeReview」, HEAD 범위는 「reviewScope」 가 소유한다. `feature_head` 가 `true`(기본)면 기능 PR 에는 `require` 와 상관없이 `verdict-on-head` 를 더한다. `false` 면 기능 PR 도 `require` 만 본다. 반영 push 마다 재리뷰를 받지 않으려는 저장소가 쓴다. 미해결 스레드 0 은 조합에 넣지 않고 늘 본다. 모르는 조건 이름은 사용법 오류가 아니다. 상주 루프는 PR 을 걸지 않고 이유를 로그에 남기며, `orch-doctor` 가 `INVALID-CONFIG` 로 알린다. 판정 문구가 든 본문이 없어 멈추면 `AUTO-MERGE-NO-REVIEW` 로 알린다. 조합 예시는 `skills/orch/references/overlay.md` 의 「자동 머지 리뷰 조건」 에 있다 |
| `migrations` | `dirs` | 모듈 이름에서 저장소 루트 기준 폴더로. 폴더는 비지 않은 문자열이다 | 없음(마이그레이션을 보지 않는다) | `reserve-migration.ts` 가 그 모듈의 SQL 예약 경로를 만드는 폴더다. 자동 머지는 이 폴더도 감시한다. Flyway 버전 마이그레이션(`V<버전>__<설명>`)의 버전은 `.` 과 `_` 로 나눈 숫자 목록으로 비교한다 |
| `migrations` | `watch` | 모듈 이름에서 저장소 루트 기준 추가 감시 폴더의 문자열 목록으로. 목록의 폴더는 비지 않은 문자열이다 | 빈 객체 | `dirs`에 자동으로 더해 자동 머지의 번호 충돌과 순서를 판정할 감시 전용 폴더다. 예를 들어 `src/main/java/db/migration`을 같은 모듈에 넣을 수 있다. `orch queue reserve --kind java` 는 이 폴더(여럿이면 `--dir` 로 고른 것)에 `V<버전>__<이름>.java` 경로를 예약한다. `watch`에만 있는 모듈은 `--kind java` 로만 번호를 받는다 |
| `migrations` | `before` | 모듈 이름에서 셸 명령으로. `*` 는 나머지 모듈의 명령이고 `{module}` 을 모듈 이름으로 바꾼다 | 없음(머지 전 명령을 붙이지 않는다) | 마이그레이션이 든 PR 을 자동 머지할 때 붙일 머지 전 명령(DB 백업). 모듈이 여럿이면 ` && ` 로 잇는다. 이 키가 있는데 규칙이 없는 모듈의 PR 은 걸지 않는다. 명령은 `merge_queue.ts` 의 `PR:명령` 처럼 돈다 |
| `migrations` | `blocked_after_sec` | 양수 | 3600 | 같은 모듈에 더 낮은 번호를 더한 열린 PR 이나 PR 이 없는 다른 브랜치의 예약(`state/migration-reservations.json`) 때문에 기다린 시간이 이 값을 넘으면 `MIGRATION-BLOCKED` 를 한 번 낸다 |
| `adr` | `dirs` | 모듈 이름에서 저장소 루트 기준 ADR 폴더로. 폴더는 비지 않은 문자열이다 | 없음(ADR 번호를 예약하지 않는다) | `orch queue reserve --kind adr` 가 그 이름의 ADR 경로(`<번호>-<설명>.md`)를 만드는 폴더다. 폴더마다 번호가 따로다. 번호로 세는 파일 꼴과 자릿수는 `lib/reservations.ts` 머리 주석의 「ADR 번호」 가 소유한다. 자동 머지는 이 절을 읽지 않는다. 있으면 `spec-lint` 가 공통 지시서의 `adr` 표지를 요구한다 |

orch 5.2.0은 `queue.before`, `queue.verify_merged`, `queue.after_merged`,
`finish.complete_cmd`와 대응 명령줄 옵션 `--before`, `--verify-merged`,
`--after-merged`, `--complete-cmd`를 받지 않는다. 일반 런타임 명령은 남은 설정을
사용법 오류(종료 코드 2)로 거부하고, `orch-doctor`만 `INVALID-CONFIG`과 종료 코드 1로
알린다. worker와 머지 큐가 끝난 뒤 `orch doctor migrate-hooks --apply` 로 이벤트
핸들러로 옮긴다. `queue.verify_merged_when`과 `finish.task_pattern`은 계속 쓴다.

## orch 루트에 더하는 파일

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `state/approvals.json` | 승인 대기. 저장 꼴과 상태는 [승인 설계의 저장 꼴](features/board-approval/design.md#저장-꼴)이 소유한다. 잠금 안에서 옆 파일에 쓰고 이름을 바꾼다 | 쓰기마다 끝난 지 7일이 지난 기록을 지운다. 열린 기록과 마지막 버전 번호는 남긴다 |
| `state/approvals.json.lock` | 승인 파일 잠금. [보드 쓰기 잠금](adr/029-board-write-lock.md)의 `withFileLock` 규약을 쓴다 | 쓰기를 끝내면 푼다. 30초 넘은 잠금은 넘겨받는다 |
| `state/launch-history.jsonl` | 띄울 때마다 남기는 영구 이력. `dispatch`, `task`, `run`, `terminal`, `at`, `branch`, `worktree`, `spec`, `title`, `agent`, `model`, `effort`, `effective`, `row`, `completion`, `experiment`, `retry_of`. 모르는 값은 null. 필드와 선택 검사 계약은 [orch-routing 설계](features/orch-routing/design.md) 가 소유한다 | 자동으로 지우지 않는다. launched-workers 정리와 별개다 |
| `state/routing-log.jsonl` | worker PR이 머지되거나 닫힐 때 남기는 관측 기록. 필드는 [orch-routing 스펙의 기록 항목](features/orch-routing/spec.md#기록-항목), 수집과 쓰기는 [설계](features/orch-routing/design.md)가 소유한다. `version`과 `recorded_at`을 함께 둔다. 토큰 키는 `input`, `output`, `cache_read`, `cache_write`이고 입력은 캐시 읽기를 제외한 값이다. `tokens_source`는 토큰을 읽은 곳(`session`, `orca-usage`)이거나 `tokens`가 `null`인 이유(`stale`, `unavailable`)다 | PR마다 한 줄. 같은 결과는 보존하고 closed에서 merged로 바뀌면 교체한다. 자동으로 지우지 않는다 |
| `state/routing-log.lock` | routing 기록을 원자적으로 바꿀 때 잡는 pid 잠금 | 쓰기를 끝내면 반납하고 죽은 잠금은 회수한다 |
| `hooks/<이벤트>.ts` | 저장소의 핸들러 | 저장소가 정한다. 추적하려면 `git add -f` 다 |
| `state/hooks.jsonl` | 핸들러 실행 기록. 한 줄에 `time`, `event`, `handler`, `exit`, `result`(`pass`, `reject`, `fail`, `timeout`), `duration_ms`, `reason`. `exit` 는 시간 초과와 잠금 실패에서 null 이다. `duration_ms` 는 잠금 대기를 포함한다 | 1MB 를 넘으면 `hooks.jsonl.1` 로 돌리고 하나만 남긴다 |
| `state/hooks/<이벤트>.lock` | 핸들러 잠금 | 실행이 끝나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다 |
| `state/loop.json` | 상주 루프의 상태. `pid`, `run`(주 Run id 또는 null), `repo`, `tick_sec`, `started_at`, `alive_at`(생존 타이머가 쓴 마지막 시각), `runs`(마지막 틱이 본 등록된 Run id 목록. 앞이 주 Run 이다. 이 키가 없으면 Run 등록을 모르는 옛 루프다), `bound_run`(루프 프로세스가 묶인 Run id. Orca 는 호출자를 그 프로세스가 나온 터미널로 정한다. 묶이지 않았으면 null 이고, 시작할 때 `run-current` 를 읽지 못했으면 키가 없다. `--start` 는 이 값이 합류하려는 Run 과 다르거나 키가 없으면 합류하지 않는다), `last_tick`(마지막으로 끝난 틱의 시각 또는 null), `ticks`, `errors`(출처마다 마지막 오류 이유 또는 null. 키는 `<출처>@<Run>` 이고, 저장소 공유 일의 출처(`prs`, `board`, `ci`, `auto-merge`, `conflicts`, `tick`)는 Run 자리에 주 Run 을 둔다. Run 이 없는 루프는 출처 이름 그대로다), `ci`(PR 번호에서 `{ head, state }`. `head` 는 판정한 HEAD SHA, `state` 는 `passed`, `failed`, `pending`), `stalls`(dispatch id 에서 `{ run, terminal, state, hash, errors, since, ticks, fired }`. `state` 는 `error` 나 `idle`, `hash` 는 마지막 메시지 묶음과 화면의 오류 줄 수로 만든 해시, `errors` 는 그 멈춤에서 본 가장 많은 오류 줄 수, `since` 는 그 상태를 처음 본 시각(같은 상태에서 hash 만 바뀌면 그대로다), `ticks` 는 같은 상태와 같은 hash 를 본 틱 수, `fired` 는 `worker-stalled` 를 냈는지. 오류 줄 수가 `errors` 보다 늘 때만 다시 false 가 된다). 시각은 ISO 8601 UTC 다 | 루프의 부모 프로세스만 옆 파일에 쓴 뒤 rename 으로 덮어쓴다. 같은 실패를 두 번 알리지 않는 데 쓴다. `ci` 는 같은 HEAD 의 같은 상태를, `stalls` 는 같은 멈춤을 두 번 알리지 않는 데 쓴다 |
| `state/decision-pending/<Run>.json` | 이미 알린 결정 묶음과 성공한 전달, 실패 재시도 시각. 정확한 필드는 `skills/orch/scripts/lib/decisions.ts` 의 Seen 이 소유한다. 대화 중에도 이벤트를 즉시 전달한다 | 질문과 결정이 해결되면 해당 키를 뺀다 |
| `state/loop.lock` | 한 저장소에 루프 하나. 쥔 루프의 pid | 루프가 끝나면 푼다. 죽은 pid 와 루프가 아닌 프로세스의 pid 가 든 잠금은 다음 루프가 회수한다 |
| `state/order.json` | 머지 순서. PR 번호 목록 | 머지되거나 닫힌 PR 은 루프가 뺀다 |
| `state/auto-merge.json` | 상주 루프의 자동 머지 기록. `ready`(PR 번호에서 `{"head", "at"}` 로. 그 HEAD 에서 준비를 처음 본 시각), `tried`(`<PR>@<HEAD>` 에서 건 시각으로. 같은 HEAD 는 다시 걸지 않는다), `clashes`(`<PR>@<HEAD>` 에서 알린 `MIGRATION-CLASH` 이유로), `unreviewed`(`<PR>@<HEAD>` 에서 `AUTO-MERGE-NO-REVIEW` 를 쓴 시각으로. 같은 HEAD 는 다시 알리지 않는다), `blocked`(PR 번호에서 `{"head", "since", "fired"}` 로), `queue`(루프가 건 큐 하나. `{"pid", "log", "run", "prs", "at", "announced"}` 또는 null. `announced` 가 false 면 시작 알림을 다시 보낸다. 옛 기록에는 없다. `log` 는 아래 `state/auto-merge/` 의 파일이다). 틱 자식이 옆 파일에 쓰고 rename 한다 | 닫히거나 머지된 PR 의 항목은 틱이 뺀다. `blocked` 는 그 틱의 걸 후보에서 빠진 PR 의 항목도 지운다. `queue` 는 그 pid 가 끝난 것을 본 틱이 `AUTO-MERGE-END` 를 쓰고 비운다 |
| `state/refresh.json` | 상주 루프의 최신화 기록. PR 번호에서 `{"base", "from", "at", "action", "value"}` 로. 마지막으로 건 것 하나다. `base` 는 그때의 base SHA, `from` 은 그때의 PR HEAD, `action` 은 `update` 나 `worker`, `value` 는 `updated`, `failed`, 보낸 dispatch id, `orphan` 가운데 하나다. 같은 (PR, base SHA) 에는 다시 걸지 않는다. 틱 자식이 옆 파일에 쓰고 rename 한다. 형식은 `lib/refresh.ts` 머리 주석의 「기록」 이 소유한다 | 닫히거나 머지된 PR 의 항목은 틱이 뺀다 |
| `state/queue-turn/<pid>.json` | 머지 큐 하나의 차례 기록. `pid`, `prs`(남은 PR. 차례 PR 이 맨 앞이다), `pr`(차례 PR 또는 null), `phase`(단계 이름. 끝나면 `끝`), `since`(그 단계를 시작한 시각), `held`(이번 실행에서 뺀 PR 과 이유 `[{"pr", "reason"}]`). 누가 큐를 걸었든 머지 큐가 쓴다. 상주 루프가 `AUTO-MERGE-HELD`, `QUEUE-DROPPED` 줄과 최신화 판정에 읽는다. 형식과 단계 이름은 `lib/queue-turn.ts` 가 소유한다 | 머지 큐는 지우지 않는다. pid 의 명령줄이 머지 큐가 아니게 된 뒤의 틱이 `held` 를 루프 로그에 옮기고 지운다 |
| `state/queue-dropped.json` | 상주 루프가 `QUEUE-DROPPED` 로 옮긴 차례 기록의 `held` 항목. `<pid>:<PR>` 에서 옮긴 시각으로. 같은 항목을 틱마다 다시 쓰지 않게 한다 | 그 pid 의 차례 기록을 지울 때 그 pid 의 키도 지운다 |
| `state/auto-merge/<YYYYMMDDTHHMMSSZ>.log` | 루프가 건 `merge-with-finish` 의 출력. 머지 큐 로그 폴더(`queue/`)에 두지 않는 것은 정리가 끝난 큐 로그를 휴지통으로 옮겨 루프가 끝 줄을 읽기 전에 사라지기 때문이다 | 마지막으로 바뀐 지 7일이 넘은 로그를 자동 머지 단계가 지운다. `queue` 기록이 가리키는 로그는 남긴다 |
| `state/migration-reservations.json` | 마이그레이션 번호 예약 목록. `{"reservations": [{"module", "version"(숫자 목록), "label"(`V13`), "branch", "name"(파일 이름의 설명 조각. SQL 은 설명의 slug, Java 는 받은 클래스 이름 조각 그대로다. 같은 예약인지 이 값으로 가린다), "path"(저장소 루트 기준 파일 경로), "at"(ISO 8601 UTC)}]}`. (module, version) 은 한 항목에만 있고, (branch, module, name) 도 한 항목에만 있다. `reserve-migration.ts` 가 잠금 안에서 옆 파일에 쓰고 rename 한다. 상주 루프는 잠금 없이 읽기만 한다 | `reserve-migration.ts` 가 부를 때마다(`--prune` 포함) 그 브랜치에 열린 PR 이 없고, 예약 시각 뒤에 머지된 PR 이 있거나 브랜치가 원격과 로컬에 모두 없는 항목을 지운다. 닫히기만 한 PR 은 세지 않는다. 브랜치가 없다는 이유로 지우는 항목은 지우기 직전에 로컬 브랜치를 다시 보고, 있으면 남긴다. 예약 시각에서 24시간(`RESERVE_GONE_GRACE_MS`)이 지나지 않은 항목은 브랜치가 없어도 남긴다. 판정하지 못한 항목은 남긴다. `--again` 은 그 브랜치, 모듈, 설명의 항목을 새 번호로 바꾼다 |
| `state/adr-reservations.json` | ADR 번호 예약 목록. 항목 꼴은 `migration-reservations.json` 과 같고, `module` 은 `adr.dirs` 의 이름, `label` 은 `ADR-084` 꼴, `name` 은 설명을 하이픈으로 이은 조각이다. 마이그레이션 예약과 따로 둔 것은 상주 루프의 자동 머지가 ADR 번호를 마이그레이션 번호로 세지 않게 하려는 것이다 | `orch queue reserve --kind adr` 가 부를 때와 `--prune` 이 `migration-reservations.json` 과 같은 기준으로 지운다. 마이그레이션 예약 호출은 이 파일을 읽지 않는다 |
| `state/migration-reservations.lock` | 예약 잠금. 쥔 프로세스의 pid. 마이그레이션 예약과 ADR 예약 파일을 함께 지킨다 | 예약을 쓰고 나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다(`lib/events.ts` 의 `reclaim`) |
| `state/merge-queue.lock` | 머지 큐 잠금. `pid`, `identity`(시작 시각·명령줄), `token`(소유권 확인용 난수). 같은 저장소의 워크트리가 공유하고, 다른 큐가 잡고 있으면 새 큐는 `QUEUE-BUSY` 이유와 코드 2 로 거절한다 | 큐의 정상 종료와 SIGTERM/SIGINT 에 푼다. 죽은 pid 또는 시작 시각·명령줄이 다른 pid 의 잠금은 다음 실행이 회수한다(`lib/queue-lock.ts`) |
| `state/board-unmatched.json` | 못 맞춘 머지 기록. `{"items":{"<항목 id>":{"<PR 번호>":{"at":"<ISO 시각>","notified":null}}}}`. 성공한 알림 뒤 `notified` 에 ISO 시각을 쓴다. 읽기와 갱신을 파일 옆 잠금으로 보호한다. 전송은 별도 `board-unmatched.json.notify.lock` 으로 직렬화해 기록 쓰기를 막지 않는다. 같은 항목·PR 을 다시 기록해도 전송 시각은 보존한다 | 보드 동기화가 항목 없음, 남은 단계 없음, 해당 PR 의 끝난 줄 끝 꼬리표를 확인하면 지운다. 조회 실패는 보존한다 |
| `state/loop.log` | 상주 루프의 출력 | 1MB 를 넘으면 `loop.log.1` 로 돌리고 하나만 남긴다 |
| `state/movement.json` | 상주 루프의 움직임 확인 기록. `screens`(dispatch 에서 `{"hash", "changedAt"}` 로. 화면 끝 줄의 hash 와 그 hash 를 처음 본 시각(ms)), `workers`(dispatch 에서 알린 `{"run", "reason", "movedAt"}` 로), `stages`(보드 항목 id 에서 `{"step", "since", "fired"}` 로) | 틱 자식이 옆 파일에 쓴 뒤 rename 한다. 열린 dispatch 가 아닌 화면 기록과 지금 멈추지 않은 알림 기록은 그 틱에 지운다. `stalled-workers` 와 work-board 의 `bin/worker-marks.ts` 는 `screens` 만 읽는다. 형식은 `lib/movement.ts` 머리 주석이 소유한다 |
| `specs/spec-conflict-<PR>.md` | 상주 루프와 `notify-conflicts` 가 끝난 dispatch 에 보내는 충돌 후속 지시서. `중간 과정: PR #<PR>` 줄을 담는다. PR 마다 하나이고 다시 알릴 때 덮어쓴다 | 그 PR 의 마무리(`finish-pr.ts`)가 머지 뒤 지운다. 살아 있는 dispatch 가 쓰는 지시서는 남긴다. 옛 이름 `spec-conflict-<PR>-<base SHA 앞 8자리>.md` 도 함께 지운다 |
| `state/loop-runs/<Run>.json` | 루프에 등록된 Run 하나. `run`, `specs_dir`(정리에 넘길 지시서 폴더 또는 null), `registered_at`(ISO 8601 UTC), `coordinator_terminal`(`--start` 한 현재 코디네이터 터미널 또는 null) | `orch-loop --start --run` 이 옆 파일에 쓴 뒤 rename 으로 만들고 `--stop --run` 이 지운다. 루프는 틱마다 이 폴더를 읽는다. 살아 있는 루프 없이 `--start` 하거나, 잠금을 쥐었지만 아직 `loop.json` 을 쓰지 않은 뜨는 루프에 `--start` 로 합류하면 `registered_at` 을 지금으로 새로 쓴다. 새로 뜬 루프는 시작할 때 자기 Run 밖의 등록 가운데 `registered_at` 이 앞 `loop.json` 의 `alive_at` 이전인 것을 지운다. 주 Run 은 `registered_at` 이 가장 이른 Run 이다. 파일 이름의 Run 은 영문, 숫자, `_`, `.`, `-` 밖의 글자를 `_` 로 바꾼 것이다 |

## 머신 폴더에 두는 파일

저장소가 아니라 이 머신의 orch 상태다. 루트는 `ORCH_MACHINE_DIR`, 없으면 `~/.cache/orch` 다(`skills/orch/scripts/lib/machine.ts`).
터미널 handle 과 메시지 id 는 Orca 전체에서 하나라 저장소마다 나누지 않는다. 지워지면 예전 동작으로 돌아갈 뿐인 값만 둔다.

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `questions-closed/<해시>.json` | 루프가 확인한 종료 근거 `{run, id, reason}`. 파일 이름은 Run 과 질문 id 의 SHA-256 이다. 질문별 파일을 옆 파일에 쓴 뒤 rename 해 여러 저장소의 동시 쓰기가 서로 덮지 않게 한다. 질문 조회가 저장소와 무관하게 미답변에서 뺀다. 저장소의 옛 `state/questions-closed.json` 은 루프가 읽을 때 이 기록으로 옮긴다 | 루프가 마지막 조회나 저장 뒤 30일이 지난 파일을 지운다. 질문 조회는 여전히 관측되는 닫힌 질문의 시각을 갱신한다. 갱신과 정리 실패는 질문 판정이나 틱을 막지 않는다 |
| `questions-dismissed.json` | 닫은 질문 `{<질문 id>: <이유>}`. 이유는 `dispatch_inactive` 나 `answer_conflict` 다. `send-to-worker` 가 reply 를 그 코드로 거절받으면 쓰고, 질문 조회(`lib/questions.ts` 의 `snapshot`)가 미답변에서 뺀다 | 지우지 않는다 |
| `send-hook-cache.json` | worker 터미널 send hook 이 worker 가 아니라고 정한 에이전트 터미널 `{<handle>: <epoch ms>}` | 쓸 때마다 기한(`ORCH_SEND_HOOK_CACHE_SEC`, 기본 600초)이 지난 항목을 지운다 |

루프 알림은 Orca 의 Run 메일함이 소유한다. `source: orch-loop`, `kind`, `pr` payload 로 구분한다. 종류는 알림을 내는 `skills/orch/scripts/loop/steps/` 의 단계 파일과 `loop/lifecycle.ts` 가, 전송 실패 처리는 `lib/run-notice.ts` 가 소유한다.
완료 보고의 본 id·마지막 시각·의심 dispatch·이벤트 기록은 `state/done-seen/<Run>.json`, 미답변 질문 묶음은 `state/unanswered/<Run>.json` 에 둔다. PR 없는 작업은 띄우기 기록의 `completion: "none"` 으로 구분한다.

loop.json 의 restart_notices 는 보내지 못한 재시작 알림을 Run 에서 이전 alive_at 으로 연결한다. 성공한 알림은 목록에서 뺀다. 앞 루프에서 등록을 뺀 Run 은 전송 실패도 한 번 시도한 뒤 목록에서 뺀다. 지금 등록된 Run 의 실패는 다음 틱이 재시도한다.
