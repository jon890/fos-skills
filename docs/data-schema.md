# 저장 모델

이 저장소는 데이터베이스를 쓰지 않는다. 이 문서는 orch 가 저장소와 주고받는 파일 계약을 소유한다.
지금 쓰는 `.orch/` 폴더 구조와 설정 키는 [`orch/references/overlay.md`](../orch/references/overlay.md) 가 소유하고, 이 문서는 개편으로 바뀌는 부분만 적는다.
아래는 개편 뒤의 계약이다([ADR-009](adr/009-orch-event-handlers.md), [ADR-010](adr/010-orch-typescript.md)).
상주 루프의 자동 진행(ready 슬롯, base 합치기, 순서 머지, 문서 PR 머지)과 배포 묶기, `ci-missing` 은 아직 구현하지 않았다.
이 문서의 그 부분은 설계이고, 지금 동작은 `orch/SKILL.md` 와 `orch/references/` 가 소유한다.

## orch 이벤트 핸들러 입력

### 위치와 실행

| 항목 | 값 |
| --- | --- |
| 위치 | `<orch 루트>/hooks/<이벤트>.ts`. orch 루트는 `ORCH_DIR` 이 없으면 주 checkout 의 `.orch/` 다 |
| 이벤트당 파일 | 하나다. 한 이벤트에 여러 일을 하려면 그 파일이 모듈을 import 해 순서를 정한다 |
| 실행 | `node --disable-warning=ExperimentalWarning <파일>`. 작업 디렉터리는 주 checkout 이다. `verify-merged` 만 합친 사본이다. 옛 셸 명령 칸은 `ORCH_CHECKOUT` 에서 돈다(`verify-merged` 는 사본) |
| 입력 | stdin 의 JSON 객체 하나 |
| 환경 | `ORCH_EVENT`, `ORCH_REPO`, `ORCH_DIR`, `ORCH_CHECKOUT`. `ORCH_CHECKOUT` 은 이벤트를 낸 명령이 `--repo` 로 받은 경로의 실경로이고, 연결된 워크트리면 그 워크트리다. 옮기는 명령이 만든 핸들러가 옛 명령을 이 경로에서 부른다. `PATH` 앞에 가드 shim 폴더를 두고 `ORCA`, `GH` 도 그 shim 을 가리킨다. `ORCH_REAL_ORCA`, `ORCH_REAL_GH` 는 가드 shim 이 부를 진짜 실행 파일의 절대경로이고, 찾지 못하면 넘기지 않는다. worker 에게 입력하는 코어 명령(`nudge-worker`, `send-to-worker`)은 `ORCH_REAL_ORCA` 로 orca 를 불러 가드를 거치지 않는다. `ORCH_SCRIPTS` 는 그 코어 명령이 든 orch `scripts` 폴더의 절대경로다. 가드는 보안 경계가 아니다([ADR-013](adr/013-orch-worker-stalled.md)) |
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
`worker-stalled` 에서는 막을 동작이 없어 10 과 그 밖의 코드가 넘김이다. 핸들러가 처리하지 않고, 코어가 그 Run 의 알림 파일에 `WORKER-STALLED` 를 쓴다. 로그에는 10 이면 `HOOK-REJECT`, 그 밖이면 `HOOK-FAIL` 이 남는다.
거부를 1 이 아니라 10 으로 둔 것은 의도한 거부와 예외로 죽은 핸들러를 가르기 위해서다. node 는 잡지 않은 예외에 1 을 낸다.

### 공통 필드와 이벤트별 필드

입력 필드의 표는 `orch/scripts/lib/events.ts` 머리 주석이 소유한다. 「공통 필드」 와 「이벤트별 필드」 가 그것이다.

5.2.0 전 설정의 환경 변수와 입력 필드 대응이다. `migrate-orch-dir.ts --hooks`가 만드는 핸들러는 이 대응대로 이전 설정의 명령에 환경 변수를 채워 부른다.

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
| 형식이 없는 질문 | 기술 질문이나 막힘 보고다. 보드는 지금처럼 본문 앞부분을 보인다 |

## config.json 에 더하는 절

`.orch/config.json` 의 지금 절(`finish`, `cleanup`, `queue`)은 그대로 읽는다. 모르는 키에 사용법 오류로 멈추는 규칙도 그대로다. 모르는 최상위 절도 같은 사용법 오류다.
아래 절을 더한다.

| 절 | 키 | 타입 | 기본값 | 담는 것 |
| --- | --- | --- | --- | --- |
| `hooks` | `timeouts` | 이벤트 이름에서 초로. 모르는 이벤트 이름이나 양수가 아닌 값은 사용법 오류다 | 위 「위치와 실행」 | 핸들러 시간 제한 |
| `pipeline` | `enabled` | bool | false | 상주 루프의 자동 진행(ready 슬롯, 문서 PR 바로 머지, 배포 묶기)을 켠다. 질문 확인과 원격 브랜치 정리는 이 값과 무관하게 돈다 |
| `pipeline` | `tick_sec` | number | 300 | 틱 간격 |
| `pipeline` | `ready_slots` | number | 1 | 동시에 ready 로 둘 내 PR 수. CI runner 수에 맞춘다 |
| `pipeline` | `docs_merge` | bool | false | 바꾼 파일이 모두 `queue.docs_glob` 에 맞는 PR 을 필수 체크 통과 뒤 바로 머지한다 |
| `pipeline` | `after_queue_interval_sec` | number | 0 | `after-queue` 를 이 간격 안에서는 한 번으로 묶는다. 0 이면 묶지 않는다 |
| `pipeline` | `ci_missing_after_sec` | number | 600 | ready 뒤 필수 체크가 나타나지 않으면 `ci-missing` 을 내는 시간 |
| `pipeline` | `update_behind_drafts` | bool | false | base 에 뒤처진 내 draft PR 에 틱마다 base 를 합친다. ready PR 은 합치지 않는다 |
| `pipeline` | `authors` | 문자열 목록 | gh 의 현재 사용자 | 「내 PR」 로 볼 작성자. 루프, 원격 브랜치 정리, 충돌 알림이 이 PR 만 본다 |
| `pipeline` | `stall_ticks` | `{"error": 정수, "idle": 정수}`. 모르는 키나 0 미만, 정수가 아닌 값은 사용법 오류다 | `{"error": 2, "idle": 0}` | 상주 루프가 같은 멈춤 화면을 몇 틱 보면 `worker-stalled` 를 낼지. 0 이면 그 상태를 보지 않는다. 판정은 `orch-loop.ts` 머리 주석의 「멈춤 확인」 이 소유한다 |
| `board` | `steps` | 비지 않은 문자열 목록. 줄 앞 꼬리표는 `[pr]`, `[merge]`, `[deploy]`, `[release]` 중 하나이고 한 번씩만 쓴다. 다른 꼬리표는 사용법 오류다 | `["[pr] PR", "[merge] 머지"]` | 띄울 때 만드는 보드 마일스톤 단계. 지시서의 `## 보드 단계` 절이 앞선다. 근거는 [ADR-018](adr/018-board-milestone-steps.md) 가 소유한다 |
| `board` | `task_line` | 정규식 문자열. 이름 붙은 묶음 `number` 가 있어야 하고 `title` 은 선택이다. `m`, `u` 플래그로 읽는다 | `두레이 업무: <프로젝트>/<번호>` 뒤 같은 줄의 「」 안을 제목으로 읽는 꼴(`lib/milestones.ts` 의 `DEFAULT_TASK_LINE`) | 띄울 때 지시서에서 업무 번호와 제목을 읽는다. 번호는 보드 항목 제목 앞에 붙고, 같은 번호의 끝나지 않은 항목을 이어 쓰는 기준이 된다 |
| `board` | `done_after` | `merge`, `deploy`, `release` 중 하나 | `merge` | 마지막 PR 이 이 사건 단계에 닿으면 보드 항목을 done 으로 바꾼다. 항목에 그 단계가 없으면 가장 늦은 사건 단계에서 바꾼다 |
| `heavy` | `exclusive`, `normal`, `light` | 정규식 목록 | 빈 목록 | 무거운 검사 분류. 앞의 목록부터 맞춰 본다. 어디에도 맞지 않으면 `normal` 이다 |
| `heavy` | `wait_idle` | 정규식 목록 | 빈 목록 | 자리를 잡기 전에, 명령줄이 이 정규식에 맞는 프로세스가 없을 때까지 기다린다. 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스가 대상이다 |
| `queue` | `auto_merge` | bool | false | 상주 루프가 머지할 수 있는 PR 을 스스로 `merge-with-finish.ts` 에 건다. 대상과 순서는 `orch-loop.ts` 머리 주석의 「자동 머지」 가, 근거는 [ADR-016](adr/016-orch-auto-merge.md) 가 소유한다. `pipeline.enabled` 와 무관하다 |
| `queue` | `auto_review` | `{"pass": 정규식, "block": 정규식}`. 둘 다 비지 않은 문자열이다 | 없음(리뷰 판정을 보지 않는다) | 자동 리뷰의 판정 문구. PR 의 리뷰와 댓글 가운데 어느 하나에 맞는 마지막 본문이 `pass` 에만 맞아야 자동 머지 대상이다. 둘 다 맞으면 `block` 이다. Python 정규식이고 본문 어디든 맞으면 된다 |
| `migrations` | `dirs` | 모듈 이름에서 저장소 루트 기준 폴더로. 폴더는 비지 않은 문자열이다 | 없음(마이그레이션을 보지 않는다) | `reserve-migration.ts` 가 그 모듈의 SQL 예약 경로를 만드는 폴더다. 자동 머지는 이 폴더도 감시한다. Flyway 버전 마이그레이션(`V<버전>__<설명>`)의 버전은 `.` 과 `_` 로 나눈 숫자 목록으로 비교한다 |
| `migrations` | `watch` | 모듈 이름에서 저장소 루트 기준 추가 감시 폴더의 문자열 목록으로. 목록의 폴더는 비지 않은 문자열이다 | 빈 객체 | `dirs`에 자동으로 더해 자동 머지의 번호 충돌과 순서를 판정할 감시 전용 폴더다. 예를 들어 `src/main/java/db/migration`을 같은 모듈에 넣을 수 있다. `watch`에만 있는 모듈은 감시하지만 예약 폴더가 없어 `reserve-migration.ts`로 번호를 받을 수 없다 |
| `migrations` | `before` | 모듈 이름에서 셸 명령으로. `*` 는 나머지 모듈의 명령이고 `{module}` 을 모듈 이름으로 바꾼다 | 없음(머지 전 명령을 붙이지 않는다) | 마이그레이션이 든 PR 을 자동 머지할 때 붙일 머지 전 명령(DB 백업). 모듈이 여럿이면 ` && ` 로 잇는다. 이 키가 있는데 규칙이 없는 모듈의 PR 은 걸지 않는다. 명령은 `merge_queue.ts` 의 `PR:명령` 처럼 돈다 |
| `migrations` | `blocked_after_sec` | 양수 | 3600 | 같은 모듈에 더 낮은 번호를 더한 열린 PR 이나 PR 이 없는 다른 브랜치의 예약(`state/migration-reservations.json`) 때문에 기다린 시간이 이 값을 넘으면 `MIGRATION-BLOCKED` 를 한 번 낸다 |

orch 5.2.0은 `queue.before`, `queue.verify_merged`, `queue.after_merged`,
`finish.complete_cmd`와 대응 명령줄 옵션 `--before`, `--verify-merged`,
`--after-merged`, `--complete-cmd`를 받지 않는다. 일반 런타임 명령은 남은 설정을
사용법 오류(종료 코드 2)로 거부하고, `orch-doctor`만 `INVALID-CONFIG`과 종료 코드 1로
알린다. worker와 머지 큐가 끝난 뒤 `migrate-orch-dir.ts --hooks --apply`로 이벤트
핸들러로 옮긴다. `queue.verify_merged_when`과 `finish.task_pattern`은 계속 쓴다.

## orch 루트에 더하는 파일

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `hooks/<이벤트>.ts` | 저장소의 핸들러 | 저장소가 정한다. 추적하려면 `git add -f` 다 |
| `state/hooks.jsonl` | 핸들러 실행 기록. 한 줄에 `time`, `event`, `handler`, `exit`, `result`(`pass`, `reject`, `fail`, `timeout`), `duration_ms`, `reason`. `exit` 는 시간 초과와 잠금 실패에서 null 이다. `duration_ms` 는 잠금 대기를 포함한다 | 1MB 를 넘으면 `hooks.jsonl.1` 로 돌리고 하나만 남긴다 |
| `state/hooks/<이벤트>.lock` | 핸들러 잠금 | 실행이 끝나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다 |
| `state/loop.json` | 상주 루프의 상태. `pid`, `run`(주 Run id 또는 null), `repo`, `tick_sec`, `started_at`, `alive_at`(생존 타이머가 쓴 마지막 시각), `runs`(마지막 틱이 본 등록된 Run id 목록. 앞이 주 Run 이다. 이 키가 없으면 Run 등록을 모르는 옛 루프다), `bound_run`(루프 프로세스가 묶인 Run id. Orca 는 호출자를 그 프로세스가 나온 터미널로 정한다. 묶이지 않았으면 null 이고, 시작할 때 `run-current` 를 읽지 못했으면 키가 없다. `--start` 는 이 값이 합류하려는 Run 과 다르거나 키가 없으면 합류하지 않는다), `last_tick`(마지막으로 끝난 틱의 시각 또는 null), `ticks`, `errors`(출처마다 마지막 오류 이유 또는 null. 키는 `<출처>@<Run>` 이고, 저장소 공유 일의 출처(`prs`, `board`, `ci`, `auto-merge`, `conflicts`, `tick`)는 Run 자리에 주 Run 을 둔다. Run 이 없는 루프는 출처 이름 그대로다), `ci`(PR 번호에서 `{ head, state }`. `head` 는 판정한 HEAD SHA, `state` 는 `passed`, `failed`, `pending`), `stalls`(dispatch id 에서 `{ run, terminal, state, hash, errors, since, ticks, fired }`. `state` 는 `error` 나 `idle`, `hash` 는 마지막 메시지 묶음과 화면의 오류 줄 수로 만든 해시, `errors` 는 그 멈춤에서 본 가장 많은 오류 줄 수, `since` 는 그 상태를 처음 본 시각(같은 상태에서 hash 만 바뀌면 그대로다), `ticks` 는 같은 상태와 같은 hash 를 본 틱 수, `fired` 는 `worker-stalled` 를 냈는지. 오류 줄 수가 `errors` 보다 늘 때만 다시 false 가 된다). 시각은 ISO 8601 UTC 다 | 루프의 부모 프로세스만 옆 파일에 쓴 뒤 rename 으로 덮어쓴다. 같은 실패를 두 번 알리지 않는 데 쓴다. `ci` 는 같은 HEAD 의 같은 상태를, `stalls` 는 같은 멈춤을 두 번 알리지 않는 데 쓴다 |
| `state/decision-pending/<Run>.json` | 사용자 결정 notifier의 `announced`(알림 파일에 쓴 결정 열쇠), `notified`(핸들러로 전달한 열쇠), `coordinator`(전달 대상 터미널). 질문은 dispatch와 본문, 보드는 항목과 남은 줄로 구분한다 | 이 notifier가 사용자 결정과 보드 결정을 함께 소유한다. 틱마다 해결된 결정을 빼고 현재 코디네이터가 바뀌면 다시 알린다. 조회가 실패하면 앞 기록을 보존하고 전달 실패는 다음 틱에 다시 시도한다 |
| `state/loop.lock` | 한 저장소에 루프 하나. 쥔 루프의 pid | 루프가 끝나면 푼다. 죽은 pid 와 루프가 아닌 프로세스의 pid 가 든 잠금은 다음 루프가 회수한다 |
| `state/order.json` | 머지 순서. PR 번호 목록 | 머지되거나 닫힌 PR 은 루프가 뺀다 |
| `state/auto-merge.json` | 상주 루프의 자동 머지 기록. `ready`(PR 번호에서 `{"head", "at"}` 로. 그 HEAD 에서 준비를 처음 본 시각), `tried`(`<PR>@<HEAD>` 에서 건 시각으로. 같은 HEAD 는 다시 걸지 않는다), `clashes`(`<PR>@<HEAD>` 에서 알린 `MIGRATION-CLASH` 이유로), `blocked`(PR 번호에서 `{"head", "since", "fired"}` 로), `queue`(루프가 건 큐 하나. `{"pid", "log", "run", "prs", "at"}` 또는 null. `log` 는 아래 `state/auto-merge/` 의 파일이다). 틱 자식이 옆 파일에 쓰고 rename 한다 | 닫히거나 머지된 PR 의 항목은 틱이 뺀다. `blocked` 는 그 틱의 걸 후보에서 빠진 PR 의 항목도 지운다. `queue` 는 그 pid 가 끝난 것을 본 틱이 `AUTO-MERGE-END` 를 쓰고 비운다 |
| `state/auto-merge/<YYYYMMDDTHHMMSSZ>.log` | 루프가 건 `merge-with-finish` 의 출력. 머지 큐 로그 폴더(`queue/`)에 두지 않는 것은 정리가 끝난 큐 로그를 휴지통으로 옮겨 루프가 끝 줄을 읽기 전에 사라지기 때문이다 | 마지막으로 바뀐 지 7일이 넘은 로그를 자동 머지 단계가 지운다. `queue` 기록이 가리키는 로그는 남긴다 |
| `state/migration-reservations.json` | 마이그레이션 번호 예약 목록. `{"reservations": [{"module", "version"(숫자 목록), "label"(`V13`), "branch", "name"(설명의 slug. 같은 예약인지 이 값으로 가리고 파일 이름 조각도 이 값이다), "path"(저장소 루트 기준 파일 경로), "at"(ISO 8601 UTC)}]}`. (module, version) 은 한 항목에만 있고, (branch, module, name) 도 한 항목에만 있다. `reserve-migration.ts` 가 잠금 안에서 옆 파일에 쓰고 rename 한다. 상주 루프는 잠금 없이 읽기만 한다 | `reserve-migration.ts` 가 부를 때마다(`--prune` 포함) 그 브랜치에 열린 PR 이 없고, 예약 시각 뒤에 머지된 PR 이 있거나 브랜치가 원격과 로컬에 모두 없는 항목을 지운다. 닫히기만 한 PR 은 세지 않는다. 브랜치가 없다는 이유로 지우는 항목은 지우기 직전에 로컬 브랜치를 다시 보고, 있으면 남긴다. 판정하지 못한 항목은 남긴다. `--again` 은 그 브랜치, 모듈, 설명의 항목을 새 번호로 바꾼다 |
| `state/migration-reservations.lock` | 예약 잠금. 쥔 프로세스의 pid | 예약을 쓰고 나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다(`lib/events.ts` 의 `reclaim`) |
| `state/loop.log` | 상주 루프의 출력 | 1MB 를 넘으면 `loop.log.1` 로 돌리고 하나만 남긴다 |
| `state/loop-events/<Run>.jsonl` | 코디네이터를 깨워야 하는 루프의 알림. 그 Run 의 것만 든다. PR 에 붙는 알림은 그 PR 워크트리의 worker 를 띄운 Run, 주인을 모르는 알림(공유 일의 `WATCH-ERROR`, 보드 결정의 `DECISION-PENDING`, worker 가 없는 PR)은 주 Run 의 파일에 간다. 기술 질문과 일반 escalation의 `REMINDER`는 그 질문의 Run에 간다. 사용자 결정의 재알림은 이 파일에 쓰지 않고 루프 로그에만 남긴다. Run 이 등록되지 않은 루프는 옛 경로 `state/loop-events.jsonl` 에 쓴다. 한 줄에 `seq`(1 부터 단조 증가하는 정수), `time`(ISO 8601 UTC), `kind`(`DECISION-PENDING`, `REMINDER`, `WATCH-ERROR`, `HOOK-FAIL`, `CI-FAILED`, `CONFLICT-ORPHAN`, `WORKER-STALLED`, `QUEUE-CONFLICT`, `AUTO-MERGE`, `AUTO-MERGE-END`, `MIGRATION-CLASH`, `MIGRATION-BLOCKED`, `HEAVY-SLOT-HELD`. `CI-MISSING` 은 `ci-missing` 을 낼 때 더한다. `QUEUE-CONFLICT` 는 루프가 아니라 머지 큐가 쓴다. PR 의 worker 를 띄운 Run 이 아니라 머지 큐의 정리 인자 `--run` 의 Run 이고, 없으면 옛 경로다. `AUTO-MERGE`, `AUTO-MERGE-END` 는 루프가 건 큐의 Run(`state/auto-merge.json` 의 `queue.run`)에, `MIGRATION-CLASH`, `MIGRATION-BLOCKED` 는 그 PR 지시서의 Run 에 간다), `pr`(번호 또는 null), `text`(줄에서 `kind` 를 뺀 나머지. `WATCH-ERROR` 는 `questions: offline`, `HOOK-FAIL` 은 `tick 1`, `CONFLICT-ORPHAN` 과 `QUEUE-CONFLICT` 는 이유, `WORKER-STALLED` 는 `<dispatch> <state> <ticks>틱 <terminal>`, `HEAVY-SLOT-HELD` 는 `orch-loop.ts` 머리 주석의 「자리 보유 확인」 이 정한 꼴. 자동 머지의 알림 text 는 `orch-loop.ts` 머리 주석의 「자동 머지」 가 소유한다) | 더한 뒤 1000 줄을 넘으면 쓰는 쪽이 마지막 1000 줄만 남긴다. 새 `seq` 는 파일의 마지막 `seq` 와 커서 가운데 큰 것의 다음 값이다. `wait-important` 가 마지막으로 읽은 `seq` 하나를 `state/loop-events/<Run>.cursor`(옛 경로는 `state/loop-events.cursor`) 에 적고, 커서보다 큰 `seq` 만 읽는다. 커서가 없으면 0 이다. 옛 경로는 Run 마다 나뉘지 않아, `--run` 을 준 대기는 `loop.json` 에 `runs` 가 없고 `run` 이 그 Run 이거나 비었을 때, 또는 `runs` 가 빈 목록일 때만 읽는다. `orch-loop --stop` 이 등록을 지운 Run 은 커서 뒤의 줄이 없으면 알림 파일과 커서를 함께 지우고, 읽지 않은 줄이 있으면 둘 다 남긴다 |
| `specs/spec-conflict-<PR>.md` | 상주 루프와 `notify-conflicts` 가 끝난 dispatch 에 보내는 충돌 후속 지시서. `중간 과정: PR #<PR>` 줄을 담는다. PR 마다 하나이고 base 가 움직이면 덮어쓴다 | 그 PR 의 마무리(`finish-pr.ts`)가 머지 뒤 지운다. 살아 있는 dispatch 가 쓰는 지시서는 남긴다. 옛 이름 `spec-conflict-<PR>-<base SHA 앞 8자리>.md` 도 함께 지운다 |
| `state/loop-runs/<Run>.json` | 루프에 등록된 Run 하나. `run`, `specs_dir`(정리에 넘길 지시서 폴더 또는 null), `registered_at`(ISO 8601 UTC), `coordinator_terminal`(`--start` 한 현재 코디네이터 터미널 또는 null) | `orch-loop --start --run` 이 옆 파일에 쓴 뒤 rename 으로 만들고 `--stop --run` 이 지운다. 루프는 틱마다 이 폴더를 읽는다. 살아 있는 루프 없이 `--start` 하거나, 잠금을 쥐었지만 아직 `loop.json` 을 쓰지 않은 뜨는 루프에 `--start` 로 합류하면 `registered_at` 을 지금으로 새로 쓴다. 새로 뜬 루프는 시작할 때 자기 Run 밖의 등록 가운데 `registered_at` 이 앞 `loop.json` 의 `alive_at` 이전인 것을 지운다. 주 Run 은 `registered_at` 이 가장 이른 Run 이다. 파일 이름의 Run 은 영문, 숫자, `_`, `.`, `-` 밖의 글자를 `_` 로 바꾼 것이다 |
