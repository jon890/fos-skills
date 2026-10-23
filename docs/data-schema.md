# 저장 모델

이 저장소는 데이터베이스를 쓰지 않는다. 이 문서는 orch 가 저장소와 주고받는 파일 계약을 소유한다.
지금 쓰는 `.orch/` 폴더 구조와 설정 키는 [`orch/references/overlay.md`](../orch/references/overlay.md) 가 소유하고, 이 문서는 개편으로 바뀌는 부분만 적는다.
아래는 개편 뒤의 계약이다([ADR-009](adr/009-orch-event-handlers.md), [ADR-010](adr/010-orch-typescript.md)). 구현 PR 이 머지되면 사용법은 `orch/references/` 로 옮기고 이 문서에는 계약만 남긴다.

## orch 이벤트 핸들러 입력

### 위치와 실행

| 항목 | 값 |
| --- | --- |
| 위치 | `<orch 루트>/hooks/<이벤트>.ts`. orch 루트는 `ORCH_DIR` 이 없으면 주 checkout 의 `.orch/` 다 |
| 이벤트당 파일 | 하나다. 한 이벤트에 여러 일을 하려면 그 파일이 모듈을 import 해 순서를 정한다 |
| 실행 | `node --disable-warning=ExperimentalWarning <파일>`. 작업 디렉터리는 주 checkout 이다. `verify-merged` 만 합친 사본이다 |
| 입력 | stdin 의 JSON 객체 하나 |
| 환경 | `ORCH_EVENT`, `ORCH_REPO`, `ORCH_DIR`. `PATH` 앞에 가드 shim 폴더를 두고 `ORCA`, `GH` 도 그 shim 을 가리킨다 |
| 출력 | stdout 과 stderr 를 코어 출력에 `[hook <이벤트>] ` 를 붙여 옮긴다. 거부 이유는 stdout 의 마지막 줄이다 |
| 시간 제한 | 기본 120초. `before-merge`, `verify-merged`, `after-queue`, `after-deploy` 는 1800초. `config.json` 의 `hooks.timeouts.<이벤트>` 로 바꾼다. 넘으면 TERM, 10초 뒤 KILL 이다 |
| 동시 실행 | 같은 저장소의 같은 이벤트는 `<orch 루트>/state/hooks/<이벤트>.lock` 을 잡고 하나씩 돈다. 잠금 파일은 배타 생성(`wx`)으로 만들고 pid 를 적는다. 다른 실행이 쥐고 있으면 0.5초 간격으로 다시 보며 그 이벤트의 시간 제한에 15초를 더한 만큼 기다린다. 쥔 쪽은 시간 제한과 KILL 유예 10초 안에 끝나기 때문이다. 넘으면 실패로 보고 `HOOK-FAIL <이벤트> lock` 이다. 같은 이벤트가 셋 이상 겹쳐 앞의 실행들이 시간 제한 가까이 돌면 뒤 실행이 이 실패로 끝나는 것은 의도한 동작이다. 죽은 pid 의 잠금은 고유 이름으로 옮긴 뒤 내용을 대조해 회수한다 |

### 종료 코드

| 코드 | 거부할 수 있는 이벤트 | 나머지 이벤트 |
| --- | --- | --- |
| 0 | 통과 | 성공 |
| 10 | 거부. `HOOK-REJECT` | 실패로 본다 |
| 그 밖, 시간 초과 | 실패. 거부처럼 멈추고 `HOOK-FAIL` | 실패. 코어 동작은 이어 가고 `HOOK-FAIL` |

거부할 수 있는 이벤트는 `before-launch`, `before-ready`, `before-merge`, `verify-merged`, `before-cleanup` 이다.
거부를 1 이 아니라 10 으로 둔 것은 의도한 거부와 예외로 죽은 핸들러를 가르기 위해서다. node 는 잡지 않은 예외에 1 을 낸다.

### 공통 필드

모든 입력에 아래 필드가 있다. 이벤트별 필드는 그 위에 더한다.

| 필드 | 타입 | 뜻 |
| --- | --- | --- |
| `version` | number | 계약 버전. 지금은 `1`. 필드를 빼거나 뜻을 바꾸면 올린다 |
| `event` | string | 이벤트 이름 |
| `repo` | string | 주 checkout 의 절대경로 |
| `base` | string | 기준 브랜치 |
| `run` | string 또는 null | Orca Run id. 모르면 null |
| `time` | string | ISO 8601 UTC |

### 이벤트별 필드

PR 을 다루는 이벤트는 `pr` 객체를 받는다. 필드는 `number`, `title`, `branch`, `head`(40자리 SHA), `author`, `draft`, `url` 이다.
worker 를 다루는 이벤트는 `worker` 객체를 받는다. 필드는 `task`, `dispatch`, `terminal`, `worktree`, `spec` 이고, 모르는 값은 null 이다.

| 이벤트 | 더하는 필드 |
| --- | --- |
| `before-launch`, `worker-launched` | `worker`, `branch`, `agent`, `model`, `effort` |
| `worker-question` | `worker`, `message`(`id`, `type`, `subject`, `body`), `reminder`(bool), `age_sec` |
| `worker-done` | `worker`, `outcome`, `evidence`(`ready` 또는 `suspicious`), `pr`(있으면) |
| `worker-lost` | `worker`, `stage` |
| `before-ready`, `pr-ready` | `pr`, `ready_count`(이미 ready 인 내 PR 수), `slots` |
| `ci-passed`, `ci-failed`, `ci-missing` | `pr`, `checks`(이름, 상태, 결론, URL 의 목록), `required`(이름 목록) |
| `pr-conflict` | `pr`, `base_head`, `files`, `worker`(터미널이 없으면 null), `action`(`notified` 살아 있는 dispatch 에 보냄, `resumed` 남은 터미널에 후속 지시서로 이어 씀, `orphan` 이어 쓰지 못함) |
| `before-merge` | `pr`, `owner`, `name`(GitHub 저장소 이름), `last_of_task`(bool) |
| `verify-merged` | `pr`, `copy`(사본 절대경로), `base_head`, `changed_files`, `overlap_files` |
| `after-merge` | `pr`, `merge_commit`, `remote_branch_deleted`(bool), `retargeted`(base 를 옮긴 PR 번호 목록) |
| `after-queue` | `merged_prs`, `code_prs`, `held_prs` |
| `after-deploy` | `pr`, `merge_commit`, `deploy`(`success`, `failure`, `none`), `last_of_task`(bool) |
| `before-cleanup` | `worktree`, `branch`, `pr`(있으면), `worker`(있으면) |
| `after-cleanup` | `removed`(경로 목록), `skipped`(경로와 이유의 목록) |
| `tick` | `tick`(루프 시작 뒤 몇 번째인지), `open_prs`(내 열린 PR 번호 목록) |
| `session-resume` | `loop_alive`(bool), `waiters`(살아 있는 대기 pid 목록), `unanswered`(질문 id 목록) |

옛 셸 명령의 환경 변수와 입력 필드의 대응이다. 옮기는 명령이 만드는 핸들러는 이 대응대로 옛 명령에 환경 변수를 채워 부른다.

| 옛 칸 | 이벤트 | 옛 환경 변수 → 입력 필드 |
| --- | --- | --- |
| `queue.before`, 명령줄 `--before` | `before-merge` | `PR` → `pr.number`, `BRANCH` → `pr.branch`, `OWNER` → `owner`, `REPO` → `name` |
| `queue.verify_merged`, 명령줄 `--verify-merged` | `verify-merged` | `$1`, `MERGE_COPY` → `copy`, `PR_HEAD` → `pr.head`, `BASE_HEAD` → `base_head`, `CHANGED_FILES` → `changed_files`, `OVERLAP_FILES` → `overlap_files` |
| `queue.after_merged`, 명령줄 `--after-merged` | `after-queue` | `MERGED_PRS` → `merged_prs`, `CODE_PRS` → `code_prs` |
| `finish.complete_cmd`, `finish.task_pattern` | `after-deploy` | `{number}` 은 핸들러가 `pr.title` 에서 뽑는다 |

명령줄의 `PR번호:명령` 형식은 그대로 둔다. 그 PR 하나에만 붙이는 일회성 명령이라 핸들러로 옮기지 않는다. `before-merge` 핸들러 다음에 돈다.

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
| `hooks` | `timeouts` | 이벤트 이름에서 초로 | 위 「위치와 실행」 | 핸들러 시간 제한 |
| `pipeline` | `enabled` | bool | false | 상주 루프의 자동 진행(ready 슬롯, 문서 PR 바로 머지, 배포 묶기)을 켠다. 질문 확인과 원격 브랜치 정리는 이 값과 무관하게 돈다 |
| `pipeline` | `tick_sec` | number | 300 | 틱 간격 |
| `pipeline` | `ready_slots` | number | 1 | 동시에 ready 로 둘 내 PR 수. CI runner 수에 맞춘다 |
| `pipeline` | `docs_merge` | bool | false | 바꾼 파일이 모두 `queue.docs_glob` 에 맞는 PR 을 필수 체크 통과 뒤 바로 머지한다 |
| `pipeline` | `after_queue_interval_sec` | number | 0 | `after-queue` 를 이 간격 안에서는 한 번으로 묶는다. 0 이면 묶지 않는다 |
| `pipeline` | `ci_missing_after_sec` | number | 600 | ready 뒤 필수 체크가 나타나지 않으면 `ci-missing` 을 내는 시간 |
| `pipeline` | `update_behind_drafts` | bool | false | base 에 뒤처진 내 draft PR 에 틱마다 base 를 합친다. ready PR 은 합치지 않는다 |
| `pipeline` | `authors` | 문자열 목록 | gh 의 현재 사용자 | 「내 PR」 로 볼 작성자. 루프, 원격 브랜치 정리, 충돌 알림이 이 PR 만 본다 |
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
| `state/hooks.jsonl` | 핸들러 실행 기록. 한 줄에 `time`, `event`, `handler`, `exit`, `result`(`pass`, `reject`, `fail`, `timeout`), `duration_ms`, `reason` | 1MB 를 넘으면 `hooks.jsonl.1` 로 돌리고 하나만 남긴다 |
| `state/hooks/<이벤트>.lock` | 핸들러 잠금 | 실행이 끝나면 푼다. 죽은 pid 의 잠금은 다음 실행이 회수한다 |
| `state/loop.json` | 상주 루프의 pid, 시작 시각, 마지막 틱, PR 마다 마지막으로 본 체크 상태와 알린 이벤트 | 루프가 덮어쓴다. 같은 상태를 두 번 알리지 않는 데 쓴다 |
| `state/order.json` | 머지 순서. PR 번호 목록 | 머지되거나 닫힌 PR 은 루프가 뺀다 |
| `state/loop.log` | 상주 루프의 출력 | 1MB 를 넘으면 `loop.log.1` 로 돌리고 하나만 남긴다 |
| `state/loop-events.jsonl` | 코디네이터를 깨워야 하는 루프의 알림. 한 줄에 `time`, `kind`(`REMINDER`, `WATCH-ERROR`, `CI-FAILED`, `CI-MISSING`, `CONFLICT-ORPHAN`, `HOOK-FAIL`), `pr`, `text` | `wait-important` 가 읽은 위치를 `state/loop-events.cursor` 에 적는다. 읽은 줄이 1000 줄을 넘으면 루프가 앞부분을 잘라 낸다 |
