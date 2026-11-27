# 저장 모델

이 저장소는 데이터베이스를 쓰지 않는다. 이 문서는 orch 가 저장소와 주고받는 파일 계약을 소유한다.
지금 쓰는 `.orch/` 폴더 구조와 설정 키는 [`skills/orch/references/overlay.md`](../skills/orch/references/overlay.md) 가 소유하고, 이 문서는 개편으로 바뀌는 부분만 적는다.
아래는 개편 뒤의 계약이다([ADR-009](adr/009-orch-event-handlers.md), [ADR-010](adr/010-orch-typescript.md)).
머지 순서 파일(`state/order.json`), 뒤처진 draft 의 base 합치기(`pipeline.update_behind_drafts`), 문서 PR 바로 머지, 배포 묶기, `ci-missing` 은 아직 구현하지 않았다.
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

거부할 수 있는 이벤트는 `before-launch`, `before-merge`, `verify-merged`, `before-cleanup`, `worker-stalled` 다.
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
| 여러 결정 | `결정:` 줄마다 블록이 나뉜다. 블록마다 위 선택지와 권장 규칙을 따른다. 보드는 첫 결정 제목에 「외 N개」 를 붙이고 첫 권장안을 보인다. spec 인터뷰가 한 라운드의 결정을 한 질문으로 보낼 때 쓴다. 한 질문에는 4개까지 담는다(사용자에게 묻는 구조화 질문 도구가 한 번에 4개까지라서). 넘으면 `worker-ask` 가 묻지 않고 종료 코드 2 로 끝나며 4개씩 나눠 질문마다 보내게 한다 |
| 답 | 블록이 둘 이상이면 답은 블록 순서대로 `D1=<고른 답>` 한 줄씩이다. `worker-ask` 가 바로 받은 답은 빠진 번호를 stderr 로 알리고, 깨운 뒤 읽은 답은 `--check-answer <답> --question-file <보낸 파일>` 로 대조한다(빠지면 `MISSING D3` 와 종료 코드 2) |
| 긴 본문 | `--question-file <파일>` 로 보낸다. `--question` 과 함께 줄 수 없고, `--decision` 이면 파일 내용의 첫 줄을 검사한다 |
| 형식이 없는 질문 | 기술 질문이나 막힘 보고다. 보드는 지금처럼 본문 앞부분을 보인다 |

## config.json 에 더하는 절

`.orch/config.json` 의 지금 절(`finish`, `cleanup`, `queue`)은 그대로 읽는다. 모르는 키에 사용법 오류로 멈추는 규칙도 그대로다. 모르는 최상위 절도 같은 사용법 오류다.
아래 절을 더한다. 값은 `orch config set`, 삭제는 `orch config unset` 으로 바꾼다([설정 바꾸기](../skills/orch/references/overlay.md#설정-바꾸기)). `finish`·`cleanup` 과 나머지 `queue` 키의 타입은 [마무리 설정 파일](../skills/orch/references/overlay.md#마무리-설정-파일)이 소유한다. 설정 명령과 doctor 의 값 검사는 `skills/orch/scripts/core/config-schema.ts` 가 맡고, 기존 명령이 읽을 때의 검사는 그대로다.

`orch config` 로 값을 바꾸거나 doctor 로 설정을 마이그레이션할 때는 `config.json.lock` 을 잡은 상태로 설정을 읽고 저장한다. [공용 파일 잠금 규칙](adr/029-board-write-lock.md)에 따라 저장을 마치면 잠금을 푼다.

| 절 | 키 | 타입 | 기본값 | 담는 것 |
| --- | --- | --- | --- | --- |
| `queue` | `allow_no_checks` | bool | false | true 면 지금 HEAD 에 CI 체크가 없어도 관문, 머지 큐, 상주 루프가 체크를 통과로 본다. 필수 체크 이름이 설정되어 있으면 해당 체크가 나타나야 한다. CI 가 없는 저장소는 플러그인을 갱신한 뒤 켠다 |
| `feedback` | `reviewer` | 영문이나 숫자로 시작하고 영문, 숫자, 밑줄, 점, 콜론, 하이픈만 쓰는 문자열 | 없음 | 스킬 개선 후보의 판정을 맡는 이름. [피드백 검토 주기](../skills/orch/references/feedback-review.md#주기)를 따른다 |
| `routing` | `review_author` | 비지 않은 GitHub 로그인 문자열 | 없음 | 첫 자동 리뷰를 남기는 계정. 절이 없으면 첫 리뷰와 크기 등급은 null이다 |
| `routing` | `review_pattern` | JS 정규식 문자열(`m`). P1~P5 수를 순서대로 캡처한다 | P1~P5 머리의 Markdown 표 | 첫 자동 리뷰 본문의 지적 수를 읽는 꼴 |
| `routing` | `size_pattern` | JS 정규식 문자열(`m`). 첫 캡처가 크기 등급이다 | 없음 | 저장소가 리뷰 본문에 적은 등급을 읽는다. 새 등급을 계산하지 않는다 |
| `routing` | `usage_boost` | 값이 남아 있으면 시작할 때 삭제를 안내한다 | 없음 | [모델 사용 한도 회피](features/exhausted-model-avoid/spec.md)가 시작 전에 고른 모델의 한도를 확인한다. 옛 설정은 제거할 때까지 읽을 수 있다 |
| `inbox` | `enabled`, `dooray`, `slack` | `enabled` 는 bool, 나머지는 이름이 자유로운 객체. 값은 문자열이나 유한한 수의 목록(빈 목록 허용) | 절이 없으면 필터 없이 모두 보인다 | [저장소별 알림 필터](../skills/inbox/references/config.md#저장소-필터). `dooray.excludeProjects` 와 `dooray.excludeChannels` 는 이 보드에서 숨길 범위다. `enabled: false` 면 이 보드의 알림을 끈다. 옛 자리 `config/notification.json` 은 `inbox` 절이 없을 때 한 major 동안 읽는다 |
| `hooks` | `timeouts` | 이벤트 이름에서 양수이며 타이머 상한 이하의 초로 가는 객체. 모르는 이벤트 이름은 받지 않는다 | 위 「위치와 실행」 | 핸들러 시간 제한. 폐기된 `before-ready`, `pr-ready` 값은 무시하고 doctor 가 알린다 |
| `pipeline` | `enabled` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. 상주 루프가 하는 일은 모두 이 값과 무관하게 돈다 |
| `pipeline` | `tick_sec` | 양수, 타이머 상한 이하 | 300 | 틱 간격 |
| `pipeline` | `slow_sec` | 양수, 타이머 상한 이하 | 없음(느린 단계도 틱마다 함께 돈다) | 느린 단계(보드 동기화, 업무 주소 채우기, 정리)를 빠른 틱과 따로 도는 주기. 느린 틱이 3 × `slow_sec`(적어도 30분)을 넘기면 끊고 `WATCH-ERROR slow-tick` 을 낸다. 있으면 부모가 느린 틱 자식을 따로 띄워 빠른 틱을 막지 않는다. 동작은 `loop/orch-loop.ts` 머리 주석의 「느린 단계」 가 소유한다 |
| `pipeline` | `digest_sec` | 양수, 타이머 상한 이하 | 1800 | 안내성 루프 알림을 DIGEST 하나로 모아 보내는 주기(초). 대상은 [`lib/notice-digest.ts`](../skills/orch/scripts/lib/notice-digest.ts) 맨 위 설명을 따른다 |
| `pipeline` | `request_ack_sec` | 양수, 타이머 상한 이하 | 1800 | 받은 요청에 받음·보류·거절 답이 없을 때 보낸 쪽에 REQUEST-NO-ACK 를 한 번 보내기까지의 시간(초). 틱마다 다시 읽는다([ADR-035](adr/035-orch-main-coordinator.md)) |
| `pipeline` | `docs_merge` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. 문서 PR 바로 머지는 하지 않는다 |
| `pipeline` | `after_queue_interval_sec` | 0 이상의 유한한 수 | 0 | 읽는 코드가 없다. 설정 검사만 통과시킨다. `after-queue` 는 묶이지 않는다 |
| `pipeline` | `ci_missing_after_sec` | 0 이상의 유한한 수 | 600 | 읽는 코드가 없다. 설정 검사만 통과시킨다. `ci-missing` 을 내는 코드도 아직 없다 |
| `pipeline` | `update_behind_drafts` | bool | false | 읽는 코드가 없다. 설정 검사만 통과시킨다. draft PR 에 base 를 합치지 않는다 |
| `pipeline` | `ready_slots` | 옛 설정 값 | 없음 | 폐기된 draft CI 슬롯 키다. 남아 있으면 doctor 가 `DRAFT-CI-RETIRED` 로 알린다 |
| `pipeline` | `refresh_slots` | 0 이상의 정수. 아니면 설정 오류다 | 0 | 상주 루프가 머지 차례 전에 뒤처진 ready PR 에 base 를 미리 합치는 최신화를 켠다. 값은 루프가 건 최신화 가운데 CI 가 아직 도는 것의 상한이다. 0 이면 끈다. CI runner 수보다 작게 둔다. 대상과 순서는 `loop/steps/refresh.ts` 머리 주석의 「최신화」 가, 근거는 [ADR-020](adr/020-orch-loop-refresh.md) 가 소유한다 |
| `pipeline` | `refresh_worker_paths` | 정규식 문자열이나 그 목록(Python 정규식. 목록은 `\|` 로 잇는다) | 없음 | 최신화할 PR 과 base 가 모두 바꾼 파일이 이 정규식에 맞으면 update-branch 대신 그 PR 의 살아 있는 worker 에게 합치기를 보낸다. 계약 버전 파일처럼 글자 충돌이 없어도 worker 가 판단해야 하는 파일을 적는다. `refresh_slots` 가 0 이면 읽지 않는다 |
| `pipeline` | `authors` | 비지 않은 문자열 목록(빈 목록 허용) | gh 의 현재 사용자 | 「내 PR」 로 볼 작성자. 루프, 원격 브랜치 정리, 충돌 알림이 이 PR 만 본다 |
| `pipeline` | `stall_ticks` | `{"error": 정수, "idle": 정수}`. 모르는 키나 0 미만, 정수가 아닌 값은 사용법 오류다 | `{"error": 2, "idle": 0}` | 상주 루프가 같은 멈춤 화면을 몇 틱 보면 `worker-stalled` 를 낼지. 0 이면 그 상태를 보지 않는다. 판정은 `loop/steps/stalls.ts` 머리 주석의 「멈춤 확인」 이 소유한다 |
| `pipeline` | `stall_error_retries` | 0 이상의 정수. 아니면 설정 오류다 | 3 | 저장소에 `worker-stalled` 핸들러가 없을 때, 상주 루프가 `error` 로 멈춘 worker 에게 멈춤(`since`)마다 보내는 「계속 진행해」 의 최대 횟수. 0 이면 보내지 않고 바로 코디네이터에게 알린다. 핸들러가 있으면 읽지 않는다. 횟수 기록은 `state/stall-retries.json` 이다. 근거는 [ADR-013](adr/013-orch-worker-stalled.md) 이 소유한다 |
| `pipeline` | `idle_min` | 0 이상의 수(분). 아니면 설정 오류다 | `30` | 열린 dispatch 의 워크트리 파일, 브랜치 커밋, 화면이 이 분 넘게 그대로면 멈춘 worker 로 본다. worker 없이 남은 보드 단계도 이 분이 지나면 알린다. 0 이면 둘 다 보지 않는다. 보드 창의 worker 줄 표시(멈춤, worker 없음 경과 시간)도 같은 값을 쓴다. 판정은 `lib/movement.ts` 머리 주석이 소유한다 |
| `pipeline` | `idle_exited` | true 나 false. 아니면 설정 오류다 | `true` | Orca 가 프로세스가 끝났다고 본(liveness `exited`) 열린 dispatch 를 멈춘 worker 로 볼지. 보드 창의 「멈춤 · 터미널 종료」 도 같은 값을 쓴다 |
| `contracts` | `merge_command` | bash 명령 문자열. `paths` 와 함께 둔다 | 없음 | 계약 머리만 충돌한 PR 을 합치다 멈춘 임시 워크트리에서 돌릴 명령. 0 으로 끝나고 풀리지 않은 파일이 없어야 orch 가 커밋해 push 한다. 절차는 `skills/orch/scripts/lib/contract-merge.ts` 머리 주석이 소유한다 |
| `contracts` | `paths` | 정규식 문자열이나 그 목록(Python 정규식. 목록은 `\|` 로 잇는다) | 없음 | 계약 파일. 충돌 파일이 모두 여기 맞을 때만 자동 합치기를 한다. 통합 테스트 기록과 리뷰 판정도 이 파일만 푼 base 합치기 커밋을 받아들인다 |
| `board` | `task` | `dooray`: adapter, web_url(http·https 주소), project(기본 프로젝트). `url-template`: adapter, url({number} 포함), name(선택) | 없음(주소를 만들지 않는다) | 보드 항목의 업무 번호를 맞추고 주소를 만드는 어댑터. 칩의 도구 이름도 정한다 |
| `board` | `steps` | 비지 않은 문자열 목록. 줄 앞 꼬리표는 `[pr]`, `[merge]`, `[deploy]`, `[release]` 중 하나이고 한 번씩만 쓴다. 다른 꼬리표는 사용법 오류다 | `["[pr] PR", "[merge] 머지"]` | 띄울 때 만드는 보드 마일스톤 단계. 지시서의 `## 보드 단계` 절이 앞선다. 근거는 [ADR-018](adr/018-board-milestone-steps.md) 가 소유한다 |
| `board` | `task_line` | 정규식 문자열. 이름 붙은 묶음 `number` 가 있어야 하고 `title` 은 선택이다. `m`, `u` 플래그로 읽는다 | `두레이 업무: <프로젝트>/<번호>` 뒤 같은 줄의 「」 안을 제목으로 읽는 꼴(`lib/milestones.ts` 의 `DEFAULT_TASK_LINE`) | 띄울 때 지시서에서 업무 번호와 제목을 읽는다. 번호는 보드 항목의 업무 번호 칸(`task-ref`)에 들어가고, 같은 번호의 끝나지 않은 항목을 이어 쓰는 기준이 된다 |
| `board` | `auto_advance` | `true` 나 `false`. 아니면 설정 오류다 | `true` | `false` 면 `STEP-READY` 를 끄고 `orch board auto-check` 가 거절한다. `[auto]`·`[ask]` 는 기존 멈춤 알림으로 보고, `[wait]` 는 깨우지 않으며 시각 wait 는 그대로 끝낸다 |
| `board` | `done_after` | `merge`, `deploy`, `release` 중 하나 | `merge` | 마지막 PR 이 이 사건 단계에 닿으면 보드 항목을 done 으로 바꾼다. 항목에 그 단계가 없으면 가장 늦은 사건 단계에서 바꾼다 |
| `heavy` | `exclusive`, `normal`, `light` | 비지 않은 JS 정규식 문자열 목록(빈 목록 허용) | 빈 목록 | 무거운 검사 분류. 앞의 목록부터 맞춰 본다. 어디에도 맞지 않으면 `normal` 이다 |
| `heavy` | `wait_idle` | 비지 않은 JS 정규식 문자열 목록(빈 목록 허용) | 빈 목록 | 자리를 잡기 전에, 명령줄이 이 정규식에 맞는 프로세스가 없을 때까지 기다린다. 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스가 대상이다 |
| `review` | `prepare` | bash 명령 문자열. 문자열이 아니면 사용법 오류다 | 없음(준비하지 않는다) | `launch-worker` 가 지시서에 `리뷰 PR: #<N>` 줄이 있는 리뷰 worker 의 워크트리를 PR head 에 둔 뒤 그 워크트리에서 한 번 돌리는 생성물 준비 명령. 실패해도 worker 는 뜬다. 차례와 환경 변수는 `launch-worker.ts` 머리 주석의 2-1 이 소유한다 |
| `docker` | `containers`, `images` | 객체 목록. 컨테이너 규칙은 `label` 과 `name` 가운데 하나 이상, 이미지 규칙은 `repository` 와 `keep`(0 이상의 정수, 기본 1)이다. 모르는 키는 설정 오류다 | 절이 없으면 빈 규칙(지우지 않는다) | 정리가 지울 임시 컨테이너와 쌓인 이미지의 규칙. 칸의 뜻은 [마무리 설정 파일](../skills/orch/references/overlay.md#마무리-설정-파일)의 `docker` 행, 판정은 `core/docker.ts` 의 `dockerRules` 가 소유한다 |
| `worker` | `commit_check` | bool. true 나 false 가 아니면 사용법 오류다 | true(건다) | `launch-worker` 가 worker 워크트리에 커밋 검사 훅(한국어 검사, 공개 저장소의 비공개 낱말 검사)을 걸지 정한다. false 면 그 저장소의 worker 에는 걸지 않고, 앞서 건 훅이 있으면 다시 띄울 때 푼다. 훅이 하는 일은 `lib/commit-check.ts` 머리 주석이 소유한다([ADR-036](adr/036-worker-commit-korean-check.md)). 이 절을 모르는 옛 orch 번들은 설정 오류로 멈추므로 플러그인을 갱신한 뒤에 둔다 |
| `worker` | `readonly_tools` | 도구 이름 문자열의 목록. 첫 글자는 영문, 숫자, 밑줄 중 하나이고, 뒤에는 점과 하이픈도 쓸 수 있다 | 빈 목록 | worker 가 `orch config get worker.readonly_tools` 로 확인한다. 등록한 도구의 읽기 전용 호출만 직접 한다 |
| `plugin` | `auto_update` | bool. true 나 false 가 아니면 설정 오류다 | true | 상주 루프가 설치된 플러그인의 새 버전을 확인하고 갱신할지 정한다. false 면 확인과 갱신을 모두 건너뛴다. 동작은 [플러그인 자동 갱신 설계](features/plugin-auto-update/design.md)가 소유한다 |
| `queue` | `auto_merge` | bool | false | 상주 루프가 머지할 수 있는 PR 을 스스로 `merge-with-finish.ts` 에 건다. 대상과 순서는 `loop/steps/auto-merge.ts` 머리 주석의 「자동 머지」 가, 근거는 [ADR-016](adr/016-orch-auto-merge.md) 가 소유한다. `pipeline.enabled` 와 무관하다 |
| `queue` | `auto_review` | `{"review_checks": [체크 이름], "trusted_bots": [{"login": 봇 이름, "receipt_marker": 표지, "reviewed_commit": 정규식, "request_comment": 한 줄}], "request_after_sec": 양수}`. `review_checks` 는 없거나 비지 않은 문자열의 비지 않은 목록, `trusted_bots` 는 없거나 비지 않은 목록이다. 옛 문구 판정 키(`pass`, `block`, `require`, `feature_head`, `fixed_after_block`, `fallback`)는 오류로 막지 않고 읽지 않는다 | 없음(리뷰 조건을 보지 않는다). `review_checks` 와 `trusted_bots` 가 모두 없어도 같다 | 자동 머지와 머지 관문이 독립 리뷰로 인정하는 것. 지금 HEAD 에서 `review_checks` 의 체크가 success 이거나 `trusted_bots` 의 봇이 지금 HEAD 를 확인한 영수증을 남겼으면 통과다. 리뷰 댓글의 문구로는 판정하지 않는다(사용자 결정 2026-11-24). 규칙은 `core/auto-merge.ts` 머리 주석의 「judgeReview」 가 소유한다. 둘 다 없으면 `AUTO-MERGE-NO-REVIEW` 로 알린다. 이 설정이 없으면 루프는 자동 머지하지 않는다. 믿는 봇의 마지막 리뷰에 P1·P2 지적이 없으면 앞 커밋의 영수증도 지금 HEAD 의 리뷰로 인정한다. `review_checks` 는 지금 HEAD 의 success 만 인정한다. 옛 키는 `orch-doctor` 가 `LEGACY-REVIEW-KEY` 로 알린다. `request_comment` 는 선택 값이다. 적으면 루프가 같은 HEAD 에 대해 영수증이나 진행 중 표시가 없고 앞 리뷰도 인정하지 못할 때 요청 댓글을 한 번 단다. `request_after_sec` 는 루프가 Ready PR 의 HEAD 를 본 뒤 기다리는 시간이다(기본 180초). 키 형식과 판정 방식은 [믿는 리뷰 봇의 영수증](../skills/orch/references/overlay.md#믿는-리뷰-봇의-영수증)을 본다 |
| `queue` | `integration_tests` | `[{paths, command, modules?}]`. `paths` 는 `<모듈>` 을 하나 포함한 glob 문자열이나 그 목록, `command` 는 통합 테스트 명령, `modules` 는 확인할 모듈 이름 목록(생략하면 경로에 맞는 모든 모듈) | 없음 | 머지 관문과 머지 큐가 바뀐 모듈의 통합 테스트 기록을 PR 본문에서 확인한다. 기록 형식과 통과 조건은 [`core/integration-evidence.ts`](../skills/orch/scripts/core/integration-evidence.ts) 맨 위 설명을 따른다 |
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

타이머 상한은 `skills/orch/scripts/core/config-schema.ts` 의 `TIMER_MAX_SEC` 가 정한다. `contracts.merge_command` 와 `contracts.paths` 는 함께 넣거나 함께 지운다. 큐·마무리의 짝 조건은 [마무리 설정 파일](../skills/orch/references/overlay.md#마무리-설정-파일)을 따른다.

## 보드 파일

보드의 기본 위치는 Git 작업 트리의 `.orch/board.json`이다. Git 밖에서 시작한 세션은 `~/.orch/board.json`을 사용한다. 새 파일이 없으면 기존 `.omc` 경로를 찾는다. `finish.board`로 명시한 위치가 기본값보다 앞선다. 경로 선택과 이전 방법은 [work-board README](../extensions/work-board/README.md#보드에-항목-적기)와 [orch 설정 문서](../skills/orch/references/overlay.md#옛-구조에서-옮기기)에 있다.

| 보드 항목의 칸 | 값 |
| --- | --- |
| `priority` | 선택 값. 1부터 `Number.MAX_SAFE_INTEGER`까지의 정수로, 숫자가 작을수록 같은 상태 묶음에서 먼저 보인다. 같은 값이거나 값이 없는 항목끼리는 파일 순서를 따른다. 값을 지우면 이 칸을 생략한다 |
| `feature` | 저장소 기준 기능 폴더 경로. 스펙 PR 에서 기능 폴더를 확인하기 전에는 생략한다 |
| `feature-repo` | 기능 폴더가 속한 저장소의 주 checkout 실경로. `feature` 와 함께 쓴다 |
| `feature-final-pr` | 기능의 마지막 단계를 머지한 PR 번호. 끝난 단계 줄을 정리한 뒤에도 남은 단계가 끝나면 항목을 닫는 데 쓴다 |
| `feature-final-report` | PR 없이 기능의 마지막 단계를 끝낸 worker 의 dispatch id |

## 보드 항목의 worker 줄

항목의 `workers`는 worker 줄 목록이다. 필드가 없는 옛 항목은 대표 칸(`worktree`, `branch`)으로 읽는다. 선택 이유는 [ADR-033](adr/033-board-item-worker-rows.md)에 있다.

| 칸 | 값 |
| --- | --- |
| `role` | `impl`(구현), `follow`(후속), `review`(리뷰), `verify`(검증) |
| `dispatch` | dispatch id 또는 `null` |
| `worktree` | 워크트리 이름. 줄의 열쇠 |
| `branch` | 브랜치 이름 또는 `null` |
| `pr` | PR 번호 또는 `null`. 리뷰·검증은 대상 PR |
| `stages` | `pr=N,merge=M`. 앞 PR 이 열린 채 새 브랜치로 붙은 후속 줄만 갖는다. 그 PR 의 단계 번호이고 없으면 칸이 없다. 끝난 단계 지우기(`orch board clear-done`)가 끝난 PR 단계를 지우면 `merge=M` 만 남고, merge 단계까지 지우면 칸을 지운다 |
| `feature-steps` | 이 PR 이 맡은 기능 단계 번호를 쉼표로 이은 값. 끝난 단계를 지우면 남은 번호를 다시 매긴다 |
| `feature-report` | PR 없이 맡은 기능 단계의 성공 보고 반영 상태. `pending` 은 반영 전이고 `done` 은 반영 후다 |
| `status` | `working`, `done`, `lost`(보고 없이 끊김) |
| `at` | 더하거나 다시 띄운 시각 |
| `endedAt` | 끝난 시각 또는 `null` |

같은 워크트리로 다시 띄우면 기존 줄을 바꾸고 역할은 유지한다. 브랜치는 줄의 값이며 열쇠에 넣지 않는다.
대표 칸은 가장 최근의 작업 중 구현·후속 줄이다. 그런 줄이 없으면 마지막 값을 두고, 리뷰·검증 줄은 대표가 되지 않는다. 대상 항목을 못 찾아 새로 만든 리뷰 항목은 기존처럼 리뷰 worker 를 대표로 둔다.

띄우기는 `board.ts worker-add`로 줄을 쓰고, 보드 맞추기는 루프가 넘긴 `--worker-ends`와 사라진 워크트리를 보고 `worker-end`를 부른다. 줄과 대표 칸은 같은 보드 잠금 안에서 바뀐다. 옛 대표 워크트리가 비었으면 옮길 줄을 만들지 않는다. 옛 대표를 처음 옮길 때 이력의 워크트리와 현재 Orca dispatch 가 살아 있는지 확인하고, 끝났으면 끝난 줄로 남긴다. Orca 조회 실패는 모름으로 보고 dispatch 를 작업 중으로 옮겨 다음 동기화에서 확인한다. worker 줄만 바꾸면 `stepAt`과 단계 줄 지문은 그대로다.

## orch 루트에 더하는 파일

이 표에는 다른 저장소나 보드가 읽는 파일만 적는다.

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `state/approvals.json` | 승인 대기. 저장 꼴과 상태는 [승인 설계의 저장 꼴](features/board-approval/design.md#저장-꼴)이 소유한다. 잠금 안에서 옆 파일에 쓰고 이름을 바꾼다 | 쓰기마다 끝난 지 7일이 지난 기록을 지운다. 열린 기록과 마지막 버전 번호는 남긴다 |
| `state/approvals.json.lock` | 승인 파일 잠금. [보드 쓰기 잠금](adr/029-board-write-lock.md)의 `withFileLock` 규약을 쓴다 | 쓰기를 끝내면 푼다. 30초 넘은 잠금은 넘겨받는다 |
| `state/auto-merge.json` | 상주 루프의 자동 머지 기록. `ready`(PR 번호에서 `{"head", "at"}` 로. 그 HEAD 에서 준비를 처음 본 시각), `tried`(`<PR>@<HEAD>` 에서 건 시각으로. 같은 HEAD 는 다시 걸지 않는다. 큐가 `QUEUE-DUP` 나 `QUEUE-CLAIM-FAIL` 로 걸지 못하고 끝났으면 그때 건 PR 의 항목을 지워 다시 건다), `clashes`(`<PR>@<HEAD>` 에서 알린 `MIGRATION-CLASH` 이유로), `unreviewed`(`<PR>@<HEAD>` 에서 `AUTO-MERGE-NO-REVIEW` 를 쓴 시각으로. 같은 HEAD 는 다시 알리지 않는다), `blocked`(PR 번호에서 `{"head", "since", "fired"}` 로), `queue`(루프가 건 큐 하나. `{"pid", "log", "run", "prs", "at", "announced"}` 또는 null. `announced` 가 false 면 시작 알림을 다시 보낸다. 옛 기록에는 없다. `log` 는 아래 `state/auto-merge/` 의 파일이다). 틱 자식이 옆 파일에 쓰고 rename 한다 | 닫히거나 머지된 PR 의 항목은 틱이 뺀다. `blocked` 는 그 틱의 걸 후보에서 빠진 PR 의 항목도 지운다. `queue` 는 그 pid 가 끝난 것을 본 틱이 `AUTO-MERGE-END` 를 쓰고 비운다 |
| `state/queue-turn/<pid>.json` | 머지 큐 하나의 차례 기록. `pid`, `prs`(남은 PR. 차례 PR 이 맨 앞이다), `pr`(차례 PR 또는 null), `phase`(단계 이름. 끝나면 `끝`), `since`(그 단계를 시작한 시각), `held`(이번 실행에서 뺀 PR 과 이유 `[{"pr", "reason"}]`). 누가 큐를 걸었든 머지 큐가 쓴다. 상주 루프가 `AUTO-MERGE-HELD`, `QUEUE-DROPPED` 줄과 최신화 판정에 읽는다. 형식과 단계 이름은 `lib/queue-turn.ts` 가 소유한다 | 머지 큐는 지우지 않는다. pid 의 명령줄이 머지 큐가 아니게 된 뒤의 틱이 `held` 를 루프 로그에 옮기고 지운다 |
| `state/auto-merge/<YYYYMMDDTHHMMSSZ>.log` | 루프가 건 `merge-with-finish` 의 출력. 머지 큐 로그 폴더(`queue/`)에 두지 않는 것은 정리가 끝난 큐 로그를 휴지통으로 옮겨 루프가 끝 줄을 읽기 전에 사라지기 때문이다 | 마지막으로 바뀐 지 7일이 넘은 로그를 자동 머지 단계가 지운다. `queue` 기록이 가리키는 로그는 남긴다 |
| `state/board-unmatched.json` | 못 맞춘 머지 기록. `{"items":{"<항목 id>":{"<PR 번호>":{"at":"<ISO 시각>","notified":null}}}}`. 성공한 알림 뒤 `notified` 에 ISO 시각을 쓴다. 읽기와 갱신을 파일 옆 잠금으로 보호한다. 전송은 별도 `board-unmatched.json.notify.lock` 으로 직렬화해 기록 쓰기를 막지 않는다. 같은 항목·PR 을 다시 기록해도 전송 시각은 보존한다 | 보드 동기화가 항목 없음, 남은 단계 없음, 해당 PR 의 끝난 줄 끝 꼬리표를 확인하면 지운다. 조회 실패는 보존한다 |
| `state/loop.log` | 상주 루프의 출력 | 1MB 를 넘으면 `loop.log.1` 로 돌리고 하나만 남긴다 |
| `state/movement.json` | 상주 루프의 움직임 확인 기록. `screens`(dispatch 에서 `{"hash", "changedAt"}` 로. 화면 끝 줄의 hash 와 그 hash 를 처음 본 시각(ms)), `workers`(dispatch 에서 알린 `{"run", "reason", "movedAt"}` 로), `stages`(보드 항목 id 에서 `{"step", "since", "fired"}` 로) | 틱 자식이 옆 파일에 쓴 뒤 rename 한다. 열린 dispatch 가 아닌 화면 기록과 지금 멈추지 않은 알림 기록은 그 틱에 지운다. `stalled-workers` 와 work-board 의 `bin/worker-marks.ts` 는 `screens` 만 읽는다. 형식은 `lib/movement.ts` 머리 주석이 소유한다 |
| `state/requests/R<n>.json` | 이 저장소가 받은 요청 하나. `id`, `number`, `repo`(받는 저장소), `title`, `body`, `state`(sent, accepted, held, rejected, done, failed), `reason`, `from`(`repo`, `run`, `terminal`), `to_run`, `created_at`, `updated_at`, `ack_notice_at`, `board`(`to`, `from` 보드 항목 id. 새 id 는 `req-<받는 저장소 이름>-<n>`, 같은 보드면 `from` 은 null, `pending` 은 아직 만들지 못한 쪽. 옛 기록은 `req-<n>` 과 생략된 `pending` 을 허용한다), `history`(`at`, `state`, `reason`, `run`), `pending_done`(보내지 못한 자동 완료 또는 null) | `orch request` 명령, `finish-pr` 의 자동 완료, 루프의 답 없음 알림이 `R<n>.json.lock` 파일 잠금 안에서 다시 읽고 쓴다. 보낸 저장소에는 기록이 없고 보드 항목만 있다([ADR-035](adr/035-orch-main-coordinator.md)) |
| `feedback/<slug>.md` | 스킬 개선 후보 하나. `orch feedback add` 가 만들고 `orch feedback set` 이 상태를 고친다. 칸과 순서는 [후보 파일](../skills/orch/references/feedback-review.md#후보-파일)이 소유한다 | `orch feedback notify` 가 반영·기각 결과를 원래 저장소에 알린 뒤 휴지통(`~/.Trash/orch-feedback/`)으로 옮긴다 |
| `state/feedback-board-cache.json` | 보드의 `f` 개수가 읽는 마지막 `orch feedback collect` 결과. `at`(ms)과 보낼 알림 항목(`repo`, `slug`, `status`) 목록이다. 형식은 `lib/feedback-loop.ts` 가 소유한다 | collect 와 notify 가 덮어쓴다. 30분이 지난 값은 보드가 세지 않는다 |
| `study/<slug>.md` | 공부 후보 하나. `orch study add` 가 만들고 `orch study set` 이 상태를 고친다. 형식과 상태 전이는 `lib/study.ts` 머리 주석이 소유한다 | 명령이 지우지 않는다 |

## 머신 폴더에 두는 파일

저장소가 아니라 이 머신의 orch 상태다. 루트는 `ORCH_MACHINE_DIR`, 없으면 `~/.cache/orch` 다(`skills/orch/scripts/lib/machine.ts`).
터미널 handle 과 메시지 id 는 Orca 전체에서 하나라 저장소마다 나누지 않는다. 지워지면 예전 동작으로 돌아갈 뿐인 값만 둔다.

| 경로 | 담는 것 | 지우는 때 |
| --- | --- | --- |
| `worker-limited.json` | 마지막 `WORKER-LIMITED` 전송 성공 시각 `at`(ms)과 선택 필드 `checks`. `checks` 는 Run·제공자 쌍의 JSON 문자열을 키로 `run`, `provider`, `at`, 마지막 확인 알림 성공 시각 `checkedAt`(선택, ms), 전송 예약 `claim`(선택, `id`와 `at`)을 둔다. | 파일 옆 잠금 안에서 다시 읽고 더 늦은 시각만 rename 으로 저장한다. 이 머신의 저장소들이 함께 읽고, 한도 확인 알림은 잠금 안에서 예약·성공 시각만 저장하고 잠금 밖에서 보낸다. 예약은 3분 뒤 다시 시도하며 한도 기록은 발생 후 24시간에 정리한다 |
| `questions-closed/<해시>.json` | 루프가 확인한 종료 근거 `{run, id, reason}`. 파일 이름은 Run 과 질문 id 의 SHA-256 이다. 질문별 파일을 옆 파일에 쓴 뒤 rename 해 여러 저장소의 동시 쓰기가 서로 덮지 않게 한다. 질문 조회가 저장소와 무관하게 미답변에서 뺀다. 저장소의 옛 `state/questions-closed.json` 은 루프가 읽을 때 이 기록으로 옮긴다 | 루프가 마지막 조회나 저장 뒤 30일이 지난 파일을 지운다. 질문 조회는 여전히 관측되는 닫힌 질문의 시각을 갱신한다. 갱신과 정리 실패는 질문 판정이나 틱을 막지 않는다 |
| `questions-dismissed.json` | 닫은 질문 `{<질문 id>: <이유>}`. 이유는 `dispatch_inactive` 나 `answer_conflict` 다. `send-to-worker` 가 reply 를 그 코드로 거절받으면 쓰고, 질문 조회(`lib/questions.ts` 의 `snapshot`)가 미답변에서 뺀다 | 지우지 않는다 |
| `send-hook-cache.json` | worker 터미널 send hook 이 worker 가 아니라고 정한 에이전트 터미널 `{<handle>: <epoch ms>}` | 쓸 때마다 기한(`ORCH_SEND_HOOK_CACHE_SEC`, 기본 600초)이 지난 항목을 지운다 |
| `model-watch.json` | 루프의 하루 한 번 모델 감지 기록. `checked_at`(목록을 마지막으로 읽은 시각, ms 또는 null), `baseline`(첫 목록의 기준점 모델 목록 또는 null), `models`(마지막으로 읽은 목록), `found`(기준점 뒤에 나타난 현재 세대 모델), `decided`(보드에서 닫은 새 모델 결정. 모델에서 `{at, via}` 로. via 는 닫힌 항목을 본 보드 경로다. 든 모델은 어느 저장소에도 다시 알리지 않는다), `repos`(저장소 경로에서 `{checked_at, announced, boarded, tables}` 로. `boarded` 는 보드 쓰기에 성공한 모델이다. `tables` 는 `"table-pr"` 를 마지막으로 올린 표 PR `{pr, at, keys}` 로, `"<옛>><새>"` 나 `"skip:<옛>><새>@<effort>"` 를 `{pr, at}` 로). 옆 잠금 파일 안에서 읽고 rename 으로 쓴다. 형식과 판정은 `skills/orch/scripts/loop/model-watch.ts` 머리 주석이 소유한다 | 지우지 않는다. 지우면 다음 감지가 그때 목록을 기준점으로 새로 잡는다 |
| `step-ready.json` | 다음 단계 알림 기록. 보드 파일마다 하나다. `boards` 의 보드 실경로 아래 `notices` 를 두고, 그 항목 id 아래 `step`(사건 꼬리표를 뗀 글), `mark`(auto/ask), `at`(ms), `again`(재알림에 쓴 한도 알림 시각 또는 null)을 둔다. 같은 보드를 보는 여러 저장소의 루프가 이 기록 하나를 나눠 써서 같은 단계를 한 번만 알린다. 보드의 기록이 없으면 그 저장소의 옛 `state/step-ready.json` 을 이어받는다. 형식은 `skills/orch/scripts/lib/step-ready.ts` 머리 주석이 소유한다 | 틱 자식이 옆 잠금 파일 안에서 읽고 옆 파일에 쓴 뒤 rename 한다. 같은 단계는 worker 가 떠도 유지하며 글 변경·항목 완료 때 지운다. 보드 파일이 없어진 기록은 쓸 때 지운다 |
| `repo-visibility.json` | 저장소마다 기억한 GitHub 공개 여부 `{<공통 git 폴더의 실제 경로>: {visibility, at}}`. visibility 는 `public`, `private`, `unknown`(읽지 못함), at 은 ms 다. 비공개 낱말 검사(worker 훅, 머지 관문, doctor)가 쓴다. 옆 파일에 쓴 뒤 rename 한다. 형식과 기한은 `skills/orch/scripts/lib/private-words.ts` 머리 주석이 소유한다 | 지우지 않는다. 읽은 값은 1시간, `unknown` 은 10분이 지나면 다음 조회가 덮는다 |
| `codex-latest.json` | `orch doctor` 가 읽은 Codex CLI 최신 버전 `{version, at}`(ms). `skills/orch/scripts/doctor/codex-version.ts` 가 쓴다 | 12시간이 지나면 다음 doctor 가 다시 읽어 덮는다 |

루프 알림은 Orca 의 Run 메일함이 소유한다. `source: orch-loop`, `kind`, `pr` payload 로 구분한다. 종류는 알림을 내는 `skills/orch/scripts/loop/steps/` 의 단계 파일과 `loop/lifecycle.ts`, `loop/model-watch.ts` 가, 전송 실패 처리는 `lib/notice-transport.ts` 가 소유한다.
완료 보고의 본 id·마지막 시각·의심 dispatch·이벤트 기록은 `state/done-seen/<Run>.json`, 미답변 질문 묶음은 `state/unanswered/<Run>.json` 에 둔다. PR 없는 작업은 띄우기 기록의 `completion: "none"` 으로 구분한다.

loop.json 의 restart_notices 는 보내지 못한 재시작 알림을 Run 에서 이전 alive_at 으로 연결한다. 성공한 알림은 목록에서 뺀다. 앞 루프에서 등록을 뺀 Run 은 전송 실패도 한 번 시도한 뒤 목록에서 뺀다. 지금 등록된 Run 의 실패는 다음 틱이 재시도한다.

## 사용자 설정 파일

저장소에도 머신 폴더에도 두지 않고 사용자가 직접 관리하는 파일이다. 어느 저장소에도 커밋하지 않는다.

| 경로 | 담는 것 | 읽는 곳 |
| --- | --- | --- |
| `~/.config/orch/private-words.txt` | 공개 저장소에 들어가면 안 되는 낱말 목록. 한 줄에 낱말 하나이고 앞뒤 빈칸은 뺀다. 빈 줄과 `#` 로 시작하는 줄은 건너뛴다. 대소문자를 가리지 않는 부분 문자열로 찾는다 | 공개 저장소의 worker 커밋 훅, `orch queue gate` 와 머지 큐, 루프의 보류 이유 가리기, `orch doctor`(없으면 `PRIVATE-WORDS-MISSING`). 없거나 비었으면 검사하지 않는다. 동작은 [비공개 낱말 검사 설계](features/private-leak-guard/design.md)가 소유한다 |
