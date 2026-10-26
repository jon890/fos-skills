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

거부할 수 있는 이벤트는 `before-launch`, `before-ready`, `before-merge`, `verify-merged`, `before-cleanup` 이다.
거부를 1 이 아니라 10 으로 둔 것은 의도한 거부와 예외로 죽은 핸들러를 가르기 위해서다. node 는 잡지 않은 예외에 1 을 낸다.

### 공통 필드와 이벤트별 필드

입력 필드의 표는 `orch/scripts/lib/events.ts` 머리 주석이 소유한다. 「공통 필드」 와 「이벤트별 필드」 가 그것이다.

옛 셸 명령의 환경 변수와 입력 필드의 대응이다. 옮기는 명령(`migrate-orch-dir.ts --hooks`)이 만드는 핸들러는 이 대응대로 옛 명령에 환경 변수를 채워 부른다.

| 옛 칸 | 이벤트 | 옛 환경 변수 → 입력 필드 |
| --- | --- | --- |
| `queue.before`, 명령줄 `--before` | `before-merge` | `PR` → `pr.number`, `BRANCH` → `pr.branch`, `OWNER` → `owner`, `REPO` → `name` |
| `queue.verify_merged`, 명령줄 `--verify-merged` | `verify-merged` | `$1`, `MERGE_COPY` → `copy`, `PR_HEAD` → `pr.head`, `BASE_HEAD` → `base_head`, `CHANGED_FILES` → `changed_files`, `OVERLAP_FILES` → `overlap_files` |
| `queue.after_merged`, 명령줄 `--after-merged` | `after-queue` | `MERGED_PRS` → `merged_prs`, `CODE_PRS` → `code_prs` |
| `finish.complete_cmd`, `finish.task_pattern`, 명령줄 `--complete-cmd`, `--task-pattern` | `after-deploy` | `{number}` 은 핸들러가 `pr.title` 에서 뽑는다 |

명령줄의 `PR번호:명령` 형식은 그대로 둔다. 그 PR 하나에만 붙이는 일회성 명령이라 핸들러로 옮기지 않는다. `before-merge` 핸들러 다음에 돈다.
명령줄 `--before` 가 있으면 그 PR 에서는 `PR번호:명령` 이 대신한다.

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
| `heavy` | `exclusive`, `normal`, `light` | 정규식 목록 | 빈 목록 | 무거운 검사 분류. 앞의 목록부터 맞춰 본다. 어디에도 맞지 않으면 `normal` 이다 |
| `heavy` | `wait_idle` | 정규식 목록 | 빈 목록 | 자리를 잡기 전에, 명령줄이 이 정규식에 맞는 프로세스가 없을 때까지 기다린다. 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스가 대상이다 |

다음 major 에서 지우는 키다. 그때까지는 읽되 `DEPRECATED` 줄을 낸다.

| 키 | 옮길 곳 |
| --- | --- |
| `queue.before` | `hooks/before-merge.ts` |
| `queue.verify_merged` | `hooks/verify-merged.ts`. 사본을 만들 조건 `queue.verify_merged_when` 은 남는다 |
| `queue.after_merged` | `hooks/after-queue.ts` |
| `finish.complete_cmd`, `finish.task_pattern` | `hooks/after-deploy.ts` |

## orch 루트에 더하는 파일

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `hooks/<이벤트>.ts` | 저장소의 핸들러 | 저장소가 정한다. 추적하려면 `git add -f` 다 |
| `state/hooks.jsonl` | 핸들러 실행 기록. 한 줄에 `time`, `event`, `handler`, `exit`, `result`(`pass`, `reject`, `fail`, `timeout`), `duration_ms`, `reason`. `exit` 는 시간 초과와 잠금 실패에서 null 이다. 옛 설정 칸 실행의 `handler` 는 `legacy:<키>` 다. `duration_ms` 는 잠금 대기를 포함한다 | 1MB 를 넘으면 `hooks.jsonl.1` 로 돌리고 하나만 남긴다 |
| `state/hooks/<이벤트>.lock` | 핸들러 잠금 | 실행이 끝나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다 |
| `state/loop.json` | 상주 루프의 상태. `pid`, `run`(주 Run id 또는 null), `repo`, `tick_sec`, `started_at`, `alive_at`(생존 타이머가 쓴 마지막 시각), `runs`(마지막 틱이 본 등록된 Run id 목록. 앞이 주 Run 이다. 이 키가 없으면 Run 등록을 모르는 옛 루프다), `last_tick`(마지막으로 끝난 틱의 시각 또는 null), `ticks`, `errors`(출처마다 마지막 오류 이유 또는 null. 키는 `<출처>@<Run>` 이고, 저장소 공유 일의 출처(`prs`, `board`, `ci`, `conflicts`, `tick`)는 Run 자리에 주 Run 을 둔다. Run 이 없는 루프는 출처 이름 그대로다), `ci`(PR 번호에서 `{ head, state }`. `head` 는 판정한 HEAD SHA, `state` 는 `passed`, `failed`, `pending`), `stalls`(dispatch id 에서 `{ run, terminal, state, hash, since, ticks, fired }`. `state` 는 `error` 나 `idle`, `hash` 는 마지막 메시지 묶음의 해시, `since` 는 그 멈춤을 처음 본 시각, `ticks` 는 같은 멈춤을 본 틱 수, `fired` 는 `worker-stalled` 를 냈는지). 시각은 ISO 8601 UTC 다 | 루프의 부모 프로세스만 옆 파일에 쓴 뒤 rename 으로 덮어쓴다. 같은 실패를 두 번 알리지 않는 데 쓴다. `ci` 는 같은 HEAD 의 같은 상태를, `stalls` 는 같은 멈춤을 두 번 알리지 않는 데 쓴다 |
| `state/loop.lock` | 한 저장소에 루프 하나. 쥔 루프의 pid | 루프가 끝나면 푼다. 죽은 pid 와 루프가 아닌 프로세스의 pid 가 든 잠금은 다음 루프가 회수한다 |
| `state/order.json` | 머지 순서. PR 번호 목록 | 머지되거나 닫힌 PR 은 루프가 뺀다 |
| `state/loop.log` | 상주 루프의 출력 | 1MB 를 넘으면 `loop.log.1` 로 돌리고 하나만 남긴다 |
| `state/loop-events/<Run>.jsonl` | 코디네이터를 깨워야 하는 루프의 알림. 그 Run 의 것만 든다. PR 에 붙는 알림은 그 PR 워크트리의 worker 를 띄운 Run, 주인을 모르는 알림(공유 일의 `WATCH-ERROR`, 보드 결정의 `REMINDER`, worker 가 없는 PR)은 주 Run 의 파일에 간다. Run 이 등록되지 않은 루프는 옛 경로 `state/loop-events.jsonl` 에 쓴다. 한 줄에 `seq`(1 부터 단조 증가하는 정수), `time`(ISO 8601 UTC), `kind`(`REMINDER`, `WATCH-ERROR`, `HOOK-FAIL`, `CI-FAILED`, `CONFLICT-ORPHAN`, `WORKER-STALLED`. `CI-MISSING` 은 `ci-missing` 을 낼 때 더한다), `pr`(번호 또는 null), `text`(줄에서 `kind` 를 뺀 나머지. `WATCH-ERROR` 는 `questions: offline`, `HOOK-FAIL` 은 `tick 1`, `CONFLICT-ORPHAN` 은 이유, `WORKER-STALLED` 는 `<dispatch> <state> <ticks>틱 <terminal>`) | 더한 뒤 1000 줄을 넘으면 쓰는 쪽이 마지막 1000 줄만 남긴다. 새 `seq` 는 파일의 마지막 `seq` 와 커서 가운데 큰 것의 다음 값이다. `wait-important` 가 마지막으로 읽은 `seq` 하나를 `state/loop-events/<Run>.cursor`(옛 경로는 `state/loop-events.cursor`) 에 적고, 커서보다 큰 `seq` 만 읽는다. 커서가 없으면 0 이다. 옛 경로는 Run 마다 나뉘지 않아, `--run` 을 준 대기는 `loop.json` 에 `runs` 가 없고 `run` 이 그 Run 이거나 비었을 때, 또는 `runs` 가 빈 목록일 때만 읽는다. `orch-loop --stop` 이 등록을 지운 Run 은 커서 뒤의 줄이 없으면 알림 파일과 커서를 함께 지우고, 읽지 않은 줄이 있으면 둘 다 남긴다 |
| `state/loop-runs/<Run>.json` | 루프에 등록된 Run 하나. `run`, `specs_dir`(정리에 넘길 지시서 폴더 또는 null), `registered_at`(ISO 8601 UTC) | `orch-loop --start --run` 이 옆 파일에 쓴 뒤 rename 으로 만들고 `--stop --run` 이 지운다. 루프는 틱마다 이 폴더를 읽는다. 살아 있는 루프 없이 `--start` 하거나, 잠금을 쥐었지만 아직 `loop.json` 을 쓰지 않은 뜨는 루프에 `--start` 로 합류하면 `registered_at` 을 지금으로 새로 쓴다. 새로 뜬 루프는 시작할 때 자기 Run 밖의 등록 가운데 `registered_at` 이 앞 `loop.json` 의 `alive_at` 이전인 것을 지운다. 주 Run 은 `registered_at` 이 가장 이른 Run 이다. 파일 이름의 Run 은 영문, 숫자, `_`, `.`, `-` 밖의 글자를 `_` 로 바꾼 것이다 |
