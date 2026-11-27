# 저장소 오버레이

`<repo-root>/.orch/overlay.md` 는 이 스킬의 코어가 모르는 저장소 고유 사정을 담는다.
코디네이터가 그 저장소의 worker 를 띄우기 전에 먼저 읽고, 코어와 어긋나면 오버레이를 따른다.
없으면 코어 기본값으로 동작한다. `.orch/` 폴더의 구조는 아래 「orch 작업 폴더」 가 소유한다.

**오버레이에는 저장소마다 달라지는 값과 절차만 둔다.** 코어의 단계와 규칙을 옮겨 적지 않는다.
옮겨 적으면 코어가 바뀔 때 오버레이의 사본이 낡는다.
기능 루프의 다음 단계 worker 를 바로 띄우는 규칙은 [`feature-loop.md`](feature-loop.md#전이) 에 있으므로 저장소 오버레이에서 같은 규칙을 지워도 된다.

## 적을 것

| 항목 | 담는 것 | 쓰는 단계 |
| --- | --- | --- |
| 기준 브랜치 | PR 의 base, `--base-branch` 에 줄 원격 브랜치 | 3, 7 |
| 공통 지시서 위치 | `templates/spec-common.md` 를 채운 파일 경로 | 2 |
| 검증 명령 | worker 와 코디네이터가 돌릴 포맷, lint, 테스트 명령 | 2, 6 |
| 머지 조건 | 필수 체크 이름(`--required` 로 넘길 값), base 최신을 품게 할지(`--require-up-to-date`), 관리자 우회 가능 여부, 머지 방식(merge, squash) | 7 |
| 합친 사본 검사 | 같은 파일을 고친 PR 을 base 와 합친 사본에서 돌릴 `hooks/verify-merged.ts`, 사본 폴더(`--copy-dir`), 겹치지 않아도 검사할지(`--verify-merged-when`), 검사 없이 머지할 문서 glob(`--docs-glob`). 폴더는 저장소 hook 이 워크트리를 허용하는 곳이다 | 6, 7 |
| 무거운 검사 분류 | 같은 PC 에서 혼자 돌아야 하는 전체 검사와 브라우저 검사 명령, 대기열을 거치지 않아도 되는 가벼운 명령 | 6 |
| 문서 PR 의 CI | 문서만 바꾼 PR 이 CI 를 생략하는지, 그때 머지 큐에 줄 `--docs-glob` | 7 |
| 머지 전 명령 | DB 마이그레이션이 든 PR 앞의 백업 명령과 인자, 보관 개수 | 7 |
| 머지 뒤 명령 | `hooks/after-queue.ts`가 머지 뒤 한 번 돌릴 배포 명령. 문서 PR 만 머지했을 때 건너뛸지(`CODE_PRS`) | 7 |
| 마이그레이션 순서 | 마이그레이션 PR 끼리의 머지 순서, 모듈별 선후, 공유 DB 에 적용하지 않는 규칙. 번호는 `orch queue reserve` 로 예약한다. SQL 은 `migrations.dirs` 에, `--kind java` 는 `migrations.watch` 폴더에 경로를 받는다. 번호 붙은 ADR 은 `--kind adr` 로 `adr.dirs` 폴더에 받는다 | 2, 7 |
| CI runner 장애 대응 | runner 가 offline 이 됐을 때 누가 무엇을 하는지, 끊긴 실행을 다시 돌리는 명령 | 4, 7 |
| 원격 접속 규칙 | 개발 서버 조회에 쓸 접속 설정, 읽기만 허용하는지 | 2 |
| 비밀값 규칙 | 읽지 않을 파일, 비밀값을 넘기는 방법 | 2 |
| 업무 시스템 연동 | 업무 등록 양식, 상태 전환 시점, 링크 규칙 | 7 |
| 머지 뒤 정리에서 지울 문서 위치 | 지시서 사본, 설계 메모, PR 본문을 두는 폴더 | 7 |
| 지시서 폴더 | `orch cleanup sweep --specs-dir` 에 줄 경로. worktree 이름과 같은 지시서를 지운다. PR 본문 파일은 이 폴더에 두지 않는다(게시가 막혔을 때만 `handoff/pending/<워크트리 이름>/`) (예: `.orch/specs/`) | 4, 7 |
| spec-lint | `## spec-lint` 절에 코디네이터 소유 경로, 소유 계약, 금지 문구. 형식은 `scripts/spec/spec-lint.ts` 머리 주석. 오버레이가 가리키는 경로는 `--check-overlay` 가 `origin/<base>` 와 대조한다 | 2 |
| 공부 후보 | 사용자가 고른 후보를 글로 쓸 스킬 이름과 글이 놓일 저장소. 없으면 글을 쓸 때 어디에 쓸지 묻는다. 절차는 [`study-candidates.md`](study-candidates.md) | - |
| 진행 보드 | 보드 파일 위치 | 4, 7 |
| 머지 뒤 마무리 | `<repo>/.orch/config.json` 의 `finish` 절. gh 호스트, Run id, 배포 워크플로 파일과 브랜치, 업무 번호를 PR 제목에서 뽑는 정규식, 업무 완료 명령 틀, 보드 파일과 지시서 폴더. 키는 아래 표가 소유한다 | 7 |
| 산출물 정리 | 같은 파일의 `cleanup` 절. 함께 정리할 미리보기 폴더, 보드 파일, 휴지통 폴더, 기준 일수 | 7 |
| Docker 자원 | 같은 파일의 `docker` 절. 검사 스크립트가 띄우는 임시 컨테이너의 표식과 이름, 해시 태그로 쌓이는 이미지 이름. 판정은 [`cleanup.md`](cleanup.md) 의 「Docker 자원 반납」 이 소유한다 | 7 |
| 머지 큐 기본 옵션 | 같은 파일의 `queue` 절. 머지 큐에 매번 붙일 필수 체크, 머지 전 명령, 합친 사본 검사, 문서 glob, 머지 방식 | 7 |

## 설정 바꾸기

설정을 볼 때는 `orch config show` 나 `orch config get` 을, 바꿀 때는 `orch config set` 과 `orch config unset` 을 쓴다. 워크트리에서도 주 checkout 의 orch 루트에 있는 `config.json` 을 쓴다. 다른 저장소는 `--repo` 로 고른다. worker 는 공유 설정을 바꾸지 않고 필요한 변경을 코디네이터에게 요청한다.

```bash
orch config show
orch config show pipeline
orch config get pipeline.tick_sec
orch config set routing.review_author 'review-bot[bot]'
orch config set pipeline.tick_sec 60 --json
orch config set queue.required '["Tests"]' --json
orch config set finish.deploy_workflow deploy.yml finish.deploy_branch main
orch config unset contracts.merge_command contracts.paths
```

- `set` 은 기본으로 문자열을 저장한다. 숫자, 참거짓, 목록, 객체는 `--json` 을 붙인다. 이 옵션은 함께 준 모든 값에 적용된다.
- `--` 로 시작하는 값은 `--` 뒤에 둔다. 그때 `--json` 은 `--` 앞에 둔다. 예: `orch config set routing.review_author -- --literal`, `orch config set --json routing.review_author -- '"--literal"'`.
- 여러 경로는 한 호출에서 함께 바꾸고 검사한다. 짝으로 두어야 하는 값도 함께 바꾼다. 하나라도 거절되면 파일을 바꾸지 않는다.
- `show` 는 파일에 적힌 JSON 을, `get` 은 적힌 값 하나만 보여 준다. 기본값은 보이지 않는다. 기존 설정 문제는 stderr 로 알리며 읽기는 허용한다. 깨진 JSON 은 먼저 고쳐야 한다.
- `unset` 은 오타 키와 모르는 절도 지우고 빈 객체를 정리한다. 옛 명령 칸은 지우지 않고 `orch doctor migrate-hooks --apply` 로 옮긴다.
- 경로는 점으로 나눈다. 점이 든 이름이나 목록 항목은 경로로 고르지 않고 윗 객체나 목록 전체를 `set --json` 으로 바꾼다. 중간 값이 이미 객체가 아닌 경우에는 그 윗 값을 먼저 고친다.
- 성공 줄 `CONFIG-SET`, `CONFIG-UNSET` 은 이전 값을 보여 준다. 거절은 종료 코드 1, 인자 오류는 2 다. `set` 과 `unset` 은 잠금 안에서 다시 읽고 검사한 뒤 옆 파일을 이름 바꿔 저장한다.
- 대부분의 값은 다음 틱에 반영된다. 살아 있는 루프의 `pipeline.tick_sec` 이나 `pipeline.slow_sec` 을 바꾸면 다시 시작하라는 안내가 나온다. `finish.run`, `finish.specs_dir` 은 루프를 `--run` 없이 띄운 경우에 다시 시작한다. 명령이 루프를 자동으로 다시 시작하지는 않는다.

## 마무리 설정 파일

`merge-with-finish.ts`, `finish-pr.ts`, `handoff-cleanup.ts` 는 `<repo>/.orch/config.json` 이 있으면 읽는다.
`--config FILE` 로 다른 파일을 줄 수 있고, 명령줄 옵션이 파일 값보다 우선한다. 파일에 없는 값은 옵션이나 기본값을 쓴다.
스크립트마다 자기 절만 읽고, 어느 명령이 어느 절을 읽는지는 `scripts/lib/config.ts` 머리 주석과 각 스크립트 머리 주석이 소유한다. 절 안에 모르는 키가 있으면 사용법 오류로 멈춘다. 키 이름은 옵션 이름의 하이픈을 밑줄로 바꾼 것이다. 설정 명령의 타입과 짝 조건은 `core/config-schema.ts` 가 검사한다. 타이머 상한은 그 파일의 `TIMER_MAX_SEC` 다. 공백뿐인 숫자 문자열은 받지 않는다. 아래 표에 없는 키(더하는 절)는 [데이터 스키마](../../../docs/data-schema.md#configjson-에-더하는-절)가 소유한다.

| 절 | 키 | 담는 것 |
| --- | --- | --- |
| `routing` | `review_author`, `review_pattern`, `size_pattern` | PR 관측값을 읽을 자동 리뷰 계정과 본문 형식. 형식은 [데이터 스키마](../../../docs/data-schema.md#configjson-에-더하는-절)가 소유한다 |
| `inbox` | `enabled`, `dooray`, `slack` | inbox 스킬의 저장소별 알림 필터. 꼴은 `skills/inbox/references/config.md` 「저장소 필터」 와 [데이터 스키마](../../../docs/data-schema.md#configjson-에-더하는-절)가 소유한다 |
| `finish` | `gh_host` | 문자열이나 null. gh 에 줄 호스트. github.com 이 아닌 저장소에서만 |
| `finish` | `repo`, `run`, `pid_file` | 문자열이나 null. 저장소 경로, worker 를 찾을 Orca Run id, 마무리 프로세스 PID 파일 |
| `finish` | `base_branch` | 문자열이나 null. `cleanup-sweep.ts` 의 기준 브랜치. 없으면 origin/HEAD |
| `finish` | `deploy_workflow`, `deploy_branch` | 문자열이나 null. 배포 워크플로 파일 이름과 브랜치. 둘 다 비지 않거나 둘 다 비어야 한다 |
| `finish` | `task_pattern` | 문자열이나 null. 비지 않으면 Python 정규식이고 캡처가 있어야 한다. PR 제목에서 업무 번호를 뽑는다. 첫 그룹이 번호다. 마지막 PR 판정([`cleanup.md`](cleanup.md) 의 「마지막 PR 판정」)이 쓴다 |
| `finish` | `spec_task_pattern` | 문자열이나 null. 비지 않으면 Python 정규식이고 캡처가 있어야 한다. 지시서의 줄에서 업무 번호를 뽑는다. 첫 그룹이 번호다. 마지막 PR 판정이 같은 업무의 남은 지시서를 찾는다. `specs_dir` 를 두면 함께 둔다 |
| `finish` | `complete`, `intermediate` | 참거짓. 둘을 함께 true 로 둘 수 없다. true 면 모든 PR 을 판정 없이 마지막(`--complete`)이나 중간(`--intermediate`)으로 본다. 보통은 두지 않는다 |
| `finish` | `board`, `board_bin`, `board_id` | `board`는 보드 파일 경로다. 상대경로는 주 checkout 기준이고 생략하면 Git 루트 또는 홈의 `.orch/board.json`을 사용한다. `board_bin`은 보드 명령, `board_id`는 지정할 보드 항목 id로 문자열 또는 null이다. 마무리가 `pr` 필드나 브랜치로 항목을 찾아 마지막 PR에서 done으로 바꾼다. 직접 줄 때는 `--board-item 101=ITEM`이다 |
| `finish` | `specs_dir` | 문자열. 지시서 폴더. 마지막 PR 이면 그 PR 브랜치의 지시서를 지운다. 마지막 PR 판정이 같은 업무의 남은 지시서를 여기서 찾는다 |
| `finish` | `sweep_arg` | 문자열 목록(빈 목록과 빈 문자열 허용). 정리 명령에 넘길 인자 |
| `finish` | `merge_timeout`, `deploy_timeout`, `poll_interval` | null, 또는 양수인 유한한 수나 그렇게 읽히는 문자열. `poll_interval` 은 타이머 상한 이하 |
| `finish` | `worker_done_timeout` | null, 또는 0 이상의 유한한 수나 그렇게 읽히는 문자열. 0 은 기다리지 않음 |
| `cleanup` | `repo`, `gh_host`, `run` | 문자열이나 null. 정리할 저장소, GitHub 호스트, Orca Run id |
| `cleanup` | `orch_dir`, `previews`, `board` | 문자열이나 null. orch 작업 폴더, 함께 정리할 미리보기 폴더, 보드 파일. 미리보기는 content-preview 의 산출물이라 주지 않으면 보지 않는다 |
| `cleanup` | `trash` | 문자열이나 null. 휴지통 폴더. 기본은 `~/.Trash/orch-cleanup-<날짜>` |
| `cleanup` | `queue_days`, `state_days`, `gh_log_days`, `handoff_days`, `specs_days`, `folder_days`, `data_days` | null, 또는 0 이상의 유한한 수나 그렇게 읽히는 문자열. 큐 로그, 상태 파일, GitHub 조회 로그, 폴더, 데이터 파일의 기준 일수. 파일 범위와 기본값은 [정리](cleanup.md#정리)를 따른다 |
| `cleanup` | `data_ext` | 문자열이나 null. 데이터 파일 확장자 |
| `cleanup` | `apply` | 참거짓. true 면 정리를 적용한다 |
| `queue` | `required` | 비지 않은 문자열, 또는 비지 않은 문자열 목록(빈 목록 허용). 필수 체크 이름 |
| `queue` | `method` | `merge`, `squash`, `rebase` 중 하나 |
| `queue` | `verify_merged_when` | `overlap`, `code`, `always` 중 하나 |
| `queue` | `docs_glob` | 비지 않은 문자열, 또는 비지 않은 문자열만 든 비지 않은 목록 |
| `queue` | `require_up_to_date`, `up_to_date_when` | `--require-up-to-date` 와 `--up-to-date-when`. `require_up_to_date` 는 true 나 false 이고, `up_to_date_when` 은 `always` 나 `overlap` 이다 |
| `queue` | `shared_paths`, `unit_prefix` | `--shared-paths` 와 `--unit-prefix`. `unit_prefix` 는 비지 않은 문자열이다. `shared_paths` 는 비지 않은 Python 정규식 문자열이나 그 비지 않은 목록이고 `\|` 로 잇는다. 의미는 [`cleanup.md`](cleanup.md) 의 「겹치지 않는 PR 은 최신화하지 않기」 가 소유한다 |
| `queue` | `shared_groups` | 이름마다 `--shared-group 이름=정규식` 하나. 값은 이름(영문, 숫자, `_`, `-`)에서 비지 않은 Python 정규식 문자열이나 그 목록(`\|` 로 잇는다)으로 가는 비지 않은 객체다. PR 과 base 가 같은 묶음을 둘 다 바꿨을 때만 겹침이다. 의미와 전제는 [`cleanup.md`](cleanup.md) 의 「언제 overlap 을 쓰는가」 가 소유한다 |
| `queue` | `poll_min_sec`, `poll_max_sec`, `ci_expected_sec` | 머지 큐가 진행 중인 체크를 다시 보는 간격(초, 1 이상이며 타이머 상한 이하의 정수). `poll_min_sec`(기본 60)에서 시작해 두 배씩 늘리고 `poll_max_sec`(기본 300)에서 멈춘다. `ci_expected_sec`(기본 없음)는 그 저장소의 보통 PR CI 시간이다. 주면 지금 도는 체크가 시작된 뒤 그 초가 지나는 시각을 넘겨 자지 않고, 그 뒤로는 `poll_min_sec` 마다 본다. 없으면 지금 동작과 같다. 각각 `--poll-min-sec`, `--poll-max-sec`, `--ci-expected-sec` 가 된다 |
| `queue` | `unit_groups` | 한 단위로 세는 단위 이름의 목록의 목록(`[["web", "bff"]]`). 바깥 목록은 비지 않고 안쪽은 항목이 2개 이상이다. 항목은 쉼표 없는 비지 않은 문자열이며 중복 단위는 둘 수 없다. 안쪽 목록마다 `--unit-group a,b` 가 된다 |
| `queue` | `sweep_args` | 머지 뒤 정리(`cleanup-sweep.ts`)에 넘길 인자의 비지 않은 문자열 목록(빈 목록 허용). 항목마다 `--sweep-arg` 가 된다. 명령줄에 `--sweep-arg` 가 있으면 쓰지 않는다 |
| `queue` | `update_docs_on_overlap` | true 면 `--update-docs-on-overlap`. CLEAN 인 문서 PR 의 겹침은 base 를 합친 뒤 필수 CI 로 확인한다 |
| `queue` | `allow_no_checks` | CI 가 없는 저장소에서 사용한다. 키 뜻은 저장소 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다 |
| `queue` | `auto_merge`, `auto_review` | 상주 루프의 자동 머지. 키 뜻은 저장소 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이 소유한다 |
| `queue` | `integration_tests` | 머지 관문(`orch queue gate`, 머지 큐)이 바뀐 모듈의 통합 테스트 기록을 확인하는 규칙 목록. 규칙의 `modules` 에 이름을 지정하면 경로가 맞아도 목록에 있는 모듈만 확인한다. 모듈 목록을 생략하면 경로가 맞는 모든 모듈을 확인한다. 플러그인을 먼저 갱신한 뒤 `modules` 를 추가한다. 설정 예시와 기록 형식은 `docs/features/gate-integration-evidence/design.md` 에 있다 |
| `hooks` | `timeouts` | 이벤트 이름에서 초(양수, 타이머 상한 이하)로 가는 객체. 핸들러의 시간 제한을 바꾼다. 기본값과 모르는 이벤트 처리는 `scripts/lib/events.ts` 머리 주석이 소유한다 |
| `pipeline` | `authors` | 「내 PR」 로 볼 작성자의 비지 않은 문자열 목록(빈 목록 허용). 없으면 gh 의 현재 사용자다. 머지 큐의 쌓인 PR base 옮기기, `notify-conflicts.ts`, 상주 루프가 이 PR 만 본다 |
| `pipeline` | `tick_sec` | 상주 루프의 틱 간격(초)이다. 양수이며 타이머 상한 이하이고 기본 300 이다. `orch-loop.ts` 가 읽는다 |
| `pipeline` | `slow_sec` | 보드 동기화와 정리 같은 느린 단계를 따로 도는 주기(초)다. 양수이며 타이머 상한 이하이고 기본은 없음(틱마다 함께 돈다)이다. 주면 느린 단계가 빠른 틱(머지, CI, 메시지 확인)을 막지 않아 `tick_sec` 을 짧게 둘 수 있다. 예: `tick_sec` 60, `slow_sec` 600 |
| `pipeline` | `request_ack_sec` | 받은 요청에 받음·보류·거절 답이 없을 때 보낸 쪽에 알리기까지의 시간(초)이다. 양수이며 타이머 상한 이하이고 기본 1800 이다. 루프가 틱마다 읽는다([`requests.md`](requests.md)) |
| `pipeline` | `digest_sec` | 안내성 루프 알림을 DIGEST 하나로 모아 보내는 주기(초)다. 양수이며 타이머 상한 이하이고 기본 1800 이다. `orch-loop.ts` 가 읽는다 |
| `pipeline` | `stall_error_retries` | 저장소에 `worker-stalled` 핸들러가 없을 때 상주 루프가 모델 오류로 멈춘 worker 에게 멈춤마다 「계속 진행해」 를 보내는 최대 횟수다. 0 이상의 정수이고 기본 3 이며 0 이면 끄고 바로 코디네이터에게 알린다. 아래 `references/hooks.md` 의 「멈춘 worker 다시 시도시키기」 |
| `pipeline` | `refresh_slots`, `refresh_worker_paths` | 상주 루프가 머지 차례 전에 뒤처진 PR 에 base 를 미리 합치는 최신화. 아래 「뒤처진 PR 미리 최신화」 |
| `pipeline` | `enabled`, `docs_merge`, `after_queue_interval_sec`, `ci_missing_after_sec`, `update_behind_drafts` | `enabled`, `docs_merge`, `update_behind_drafts` 는 참거짓, 나머지는 0 이상의 유한한 수다. 아직 읽는 명령은 없다 |
| `plugin` | `auto_update` | 기본은 true 다. false 면 그 저장소의 상주 루프가 fos-skills 새 버전을 확인하거나 이 머신의 설치본을 갱신하지 않는다. 다른 저장소의 루프에는 영향을 주지 않는다 |
| `heavy` | `exclusive`, `normal`, `light`, `wait_idle` | 비지 않은 JS 정규식 문자열 목록(빈 목록 허용)이다. `heavy-slot.ts` 가 읽는다. 사용법은 [`heavy-checks.md`](heavy-checks.md) 가 소유한다 |
| `migrations` | `dirs`, `watch`, `before`, `blocked_after_sec` | SQL 예약 폴더, 모듈별 추가 감시 경로 목록(Java 예약 폴더), 자동 머지의 머지 전 명령, 막힘 알림 시간 |
| `adr` | `dirs` | 이름에서 ADR 폴더로 가는 객체. `orch queue reserve --kind adr` 가 이 폴더에 번호를 예약한다. 폴더마다 번호가 따로이고 자동 머지는 읽지 않는다 |
| `contracts` | `merge_command`, `paths` | 계약 머리만 충돌한 PR 을 로컬에서 합쳐 push 하는 명령과 계약 파일 정규식. 아래 「계약 머리 자동 합치기」 |
| `board` | `task` | 업무 도구 어댑터 객체. 아래 「업무 도구 설정」 을 따른다 |
| `board` | `task_line` | 이름 붙은 캡처 `number` 가 있는 JS 정규식 문자열(`m`, `u`). `title` 캡처는 선택이다 |
| `board` | `steps` | 띄울 때 만드는 보드 마일스톤 단계의 문자열 목록. 줄 앞 꼬리표 `[pr]`, `[merge]`, `[deploy]`, `[release]` 가 그 단계를 끝낼 사건이다. 없으면 `[pr] PR`, `[merge] 머지` 다. 규칙은 [`board.md`](board.md) 의 「마일스톤 단계」 가 소유한다 |
| `board` | `auto_advance` | 자동 진행 여부. 기본은 `true` 이고 `false` 면 `STEP-READY` 와 자동 띄우기를 끈다. `[wait]` 는 깨우지 않고 시각 wait 는 그대로 끝낸다. `orch board auto-check` 가 거절하며 루프도 같은 값을 읽는다. boolean 이 아니면 설정 오류다 |
| `board` | `wait_events` | 사건 대기 줄 `[wait: 사건 <이름>]` 의 확인 명령. 사건 이름에서 `{ "command": <비지 않은 문자열>, "timeout_sec": <1–600 정수, 기본 60> }` 로 가는 객체이고, 이름은 영문 소문자·숫자로 시작하는 영문 소문자·숫자·하이픈 32자 이하다. 명령은 주 checkout 에서 `sh -c` 로 돌고 0 이면 끝남, 1 이면 아직, 그 밖은 실패다. 동작은 [`board.md`](board.md) 의 「자동 진행 표시」 가 소유한다. 아래 「사건 대기 설정」 |
| `board` | `done_after` | 보드 항목을 done 으로 바꾸는 사건. `merge`, `deploy`, `release` 중 하나이고 기본은 `merge` 다 |
| `docker` | `containers` | 정리가 지울 컨테이너 규칙의 목록. 규칙은 `label`(`키` 나 `키=값`)과 `name`(이름 전체에 맞출 정규식) 가운데 하나 이상을 둔 객체이고, 둘 다 두면 둘 다 맞아야 한다. `name` 에 이름 붙은 묶음 `pid` 가 있으면 그 프로세스가 없을 때만, 없으면 멈춘 컨테이너만 지운다. `cleanup-sweep.ts` 가 읽는다. 언제 무엇을 지우는지는 [`cleanup.md`](cleanup.md) 의 「Docker 자원 반납」 이 소유한다 |
| `docker` | `images` | 정리가 지울 이미지 규칙의 목록. 규칙은 `repository`(저장소 이름 전체에 맞출 정규식)와 `keep`(저장소 이름마다 남길 최근 태그 수, 0 이상의 정수, 기본 1)이다. 컨테이너가 쓰는 이미지는 남긴다 |
| `review` | `prepare` | 리뷰 worker 를 띄울 때 PR head 의 워크트리에서 한 번 돌리는 생성물 준비 명령(bash 문자열). 쓰는 법은 [`spec-writing.md`](spec-writing.md) 의 「리뷰 worker 지시서」 가 소유한다 |
| `worker` | `commit_check` | worker 워크트리에 커밋 검사 훅(한국어 검사, 공개 저장소의 비공개 낱말 검사)을 걸지(bool, 기본 true). false 면 그 저장소의 worker 에는 걸지 않는다. 동작은 [`launch.md`](launch.md) 의 「한국어 커밋 검사」 가 소유한다 |
| `worker` | `readonly_tools` | worker 가 직접 쓸 수 있는 읽기 전용 도구 이름 목록. 영문, 숫자, 밑줄, 점, 하이픈을 쓰고 첫 글자는 영문, 숫자, 밑줄 중 하나다. 기본은 빈 목록이다. `ssh`, 셸, 파일 전송 도구처럼 쓰기도 가능한 범용 도구는 등록하지 않는다. 사용 기준은 [`launch.md`](launch.md#worker-가-직접-쓰는-조회-도구)를 따른다 |

짝 조건도 함께 검사한다. `contracts.merge_command` 와 `contracts.paths` 는 함께 넣거나 함께 지운다. `finish.deploy_workflow` 와 `finish.deploy_branch` 는 함께 채우거나 비운다. `finish.complete` 와 `finish.intermediate` 를 함께 true 로 둘 수 없다. `queue.up_to_date_when` 이 `overlap` 이면 `require_up_to_date` 가 true 여야 하고 `shared_paths`·`unit_groups` 와 `shared_groups` 는 이때만 둔다. `update_docs_on_overlap` 이 true 면 `docs_glob` 이 있어야 한다. `poll_min_sec` 은 `poll_max_sec` 이하여야 하며, 생략한 쪽은 기본값과 비교한다.

아래는 저장된 파일의 모양이다. 값 변경은 위 「설정 바꾸기」 의 명령을 쓴다.

```json
{
  "finish": {
    "gh_host": "github.example.com",
    "run": "run_0123456789ab",
    "deploy_workflow": "deploy-dev.yml",
    "deploy_branch": "develop",
    "specs_dir": ".orch/specs"
  },
  "cleanup": {
    "gh_host": "github.example.com",
    "previews": ".omc/previews",
    "trash": "~/.Trash/orch-cleanup"
  },
  "queue": {
    "required": ["backend", "frontend"],
    "verify_merged_when": "code",
    "docs_glob": ["docs/*", "*.md"]
  },
  "hooks": {
    "timeouts": { "verify-merged": 3600 }
  }
}
```

업무 완료와 합친 사본 검사 명령은 설정 칸이 아니라 `.orch/hooks/after-deploy.ts`, `.orch/hooks/verify-merged.ts` 에 둔다. 쓰는 법은 [`hooks.md`](hooks.md) 다.

### 뒤처진 PR 미리 최신화

**`pipeline.refresh_slots` 는 상주 루프가 건 최신화 가운데 동시에 CI 가 도는 PR 수의 상한이다. 기본 0 이고 0 이면 끈다.**
동작과 효과는 [`cleanup.md`](cleanup.md) 의 「머지 차례 전에 미리 최신화하기」 가 소유한다. 최신화할지는 머지 큐와 같은 `queue` 키(`require_up_to_date`, `up_to_date_when`, `shared_paths`, `shared_groups`, `unit_groups`, `docs_glob`)로 정한다. `require_up_to_date` 가 false 면 돌지 않는다.
대상과 미루는 경우는 `loop/steps/refresh.ts` 머리 주석의 「최신화」 가, 근거는 저장소 `docs/adr/020-orch-loop-refresh.md` 가 소유한다.

**값은 CI runner 수보다 작게 둔다.** 최신화 하나가 PR CI 한 벌을 돌린다. worker 의 push, 머지 큐 차례의 CI, base 브랜치의 CI 도 같은 runner 를 쓰므로 runner 를 모두 주면 그쪽이 줄을 선다.
runner 5대 저장소는 2~3 을 권한다. PR CI 한 벌이 job 여럿을 함께 돌려 runner 를 여럿 쓰면 그만큼 줄인다.

**`pipeline.refresh_worker_paths` 는 PR 과 base 가 모두 바꾼 파일이 맞으면 `update-branch` 대신 그 PR 의 살아 있는 worker 에게 합치기를 보낸다.** 계약 버전처럼 글자 충돌이 없어도 worker 가 판단해야 하는 파일을 적는다. worker 가 없으면 루프 로그에 `REFRESH-ORPHAN` 만 남긴다.

```json
{
  "pipeline": {
    "refresh_slots": 2,
    "refresh_worker_paths": ["^contracts/.*version"]
  },
  "queue": {
    "require_up_to_date": true,
    "up_to_date_when": "overlap",
    "shared_paths": ["^contracts/", "^modules/common/"]
  }
}
```

### 계약 머리 자동 합치기

**`contracts.merge_command` 와 `contracts.paths` 를 함께 두면, base 와의 충돌 파일이 모두 계약 파일인 PR 을 orch 가 로컬에서 합쳐 push 한다.** 병렬 PR 이 계약 파일 맨 위의 버전과 변경 설명 줄을 함께 고쳐 나는 충돌을 worker 없이 푼다.
상주 루프의 충돌 처리와 `notify-conflicts` 는 worker 에게 알리기 전에, 머지 큐는 차례가 온 PR 의 update-branch 앞에서 같은 절차를 쓴다.
다른 파일도 충돌하거나, 명령이 0 이 아닌 코드로 끝나거나, 풀리지 않은 파일이나 충돌 표시가 남으면 `CONTRACT-MERGE-FAIL` 을 남기고 지금처럼 worker 에게 넘긴다. 절이 없으면 지금 동작 그대로다.

- `merge_command`: bash 명령 문자열. `git merge` 가 충돌로 멈춘 임시 워크트리(MERGE_HEAD 가 base)에서 돈다. 푼 파일은 `git add` 하고, 풀지 못한 파일이 있으면 0 이 아닌 코드로 끝낸다. 환경에 `ORCH_BASE`, `ORCH_BASE_SHA`, `ORCH_PR`, `ORCH_PR_BRANCH` 가 있다
- `paths`: 계약 파일 정규식 문자열이나 그 목록(Python 정규식, 목록은 `|` 로 잇는다). 충돌 파일이 하나라도 여기 맞지 않으면 합치지 않는다
- 합친 merge 커밋은 저장소 훅 없이(`--no-verify`) 만들고 강제 push 없이 올린다. 합친 결과는 PR CI 가 검증한다. 통합 테스트 기록은 이 커밋을 base 합치기로 받아들인다

절차와 출력 줄은 `lib/contract-merge.ts` 머리 주석이 소유한다.

```json
{
  "contracts": {
    "merge_command": "python3 scripts/dev/merge-contract-versions.py",
    "paths": "^contracts/[^/]+\\.yaml$"
  }
}
```

## orch 작업 폴더

orch 의 파일은 주 checkout 의 `.orch/` 아래에 둔다. 워크트리에서 불러도 같은 폴더다.
이름과 경로는 `scripts/lib/paths.ts` 의 `NAMES` 가 정하고, 셸과 문서에서는 `orch paths specs` 처럼 이름으로 받는다.
루트를 옮기려면 `ORCH_DIR` 을 orch 스크립트를 부르는 모든 환경(코디네이터 셸, 훅)에 같은 값으로 둔다.

| 경로 | 담는 것 |
| --- | --- |
| `overlay.md` | 이 문서가 다루는 저장소 규칙 |
| `config.json` | 위 「마무리 설정 파일」 |
| `specs/` | 지시서와 `spec-common.md`. 지우는 때는 아래 「작업 산출물의 자리와 지우는 때」 |
| `queue/` | 머지 큐와 마무리(`finish-<PR>.out`, `.pid`) 출력 |
| `state/` | 상주 루프와 충돌 알림이 기억하는 것. 생존·완료·끊김·미답변 기록과 무거운 검사 대기열이 있다. 알림은 Orca Run 메일함이 소유한다([`data-schema.md`](../../../docs/data-schema.md)) |
| `hooks/` | 이벤트 핸들러 `<이벤트>.ts`. 쓰는 법은 [`hooks.md`](hooks.md) |
| `bin/` | 저장소 포장 스크립트 |
| `feedback/` | worker 가 쌓은 스킬 개선 후보. 다시 보는 법은 [`feedback-review.md`](feedback-review.md) |
| `study/` | 일하다 생긴 공부 후보. 후보마다 `<slug>.md` 하나다. 모으고 글로 잇는 법은 [`study-candidates.md`](study-candidates.md) |

### 작업 산출물의 자리와 지우는 때

작업 중에 생기는 파일은 아래 표대로 둔다. 지시서 검사(`spec-lint`)가 표 밖의 자리를 막고, 정기 정리(`orch cleanup sweep`, 루프도 부른다)가 표대로 휴지통 폴더로 옮긴다. 사람이 확인하고 지울 일을 없애려는 것이다(사용자 결정 2026-11-24).
정리는 모두 미리 보기와 `--apply` 를 나누고, 기한은 `cleanup` 절의 설정으로 바꾼다. 판정 코드는 `scripts/lib/folder-retention.ts`, `scripts/lib/queue-logs.ts`, `scripts/cleanup/steps/state.ts`, `scripts/cleanup/steps/specs.ts` 에 있다.

| 폴더 | 담는 것 | 이름 꼴 | 지우는 때 |
| --- | --- | --- | --- |
| 세션 임시 폴더 | 한 번 쓰고 끝나는 파일(PR 본문 초안, 미리보기, 조사 결과) | 자유 | OS 가 지운다 |
| `handoff/` | 코디네이터가 읽어야 하는 것만(대신 게시할 본문, ask 로 확인받을 본문) | `pr-<번호>/`, `pending/<워크트리 이름>/` 두 꼴만 | `pr-<번호>/` 는 그 PR 이 머지되거나 닫히면 바로. `pending/` 은 그 워크트리가 없어지고 `cleanup.handoff_days`(기본 3)일 뒤. 두 꼴 밖의 이름은 이름에 든 PR 이 닫혔으면 바로, 아니면 같은 기한 뒤 |
| `data/` | 여러 날 다시 돌리는 검증 도구와 그 기준값(모델 비교 자료 포함) | `data/<보드 항목 id>/` | 그 보드 항목을 지우면(`orch board del`, `del --done` 포함) 다음 정기 정리 때. 폴더가 아닌 파일은 `cleanup.handoff_days` 일 뒤 |
| `queue/` | 머지 큐와 마무리 출력(`finish-<PR>.out`, `.pid`) | 지금 이름 규칙 | 든 PR 이 모두 머지되거나 닫히고 그 큐나 마무리가 끝났으면 `cleanup.queue_days`(기본 3)일 뒤. 열린 PR 과 실행 중인 것은 남긴다 |
| `state/` | 상주 루프와 정리가 기억하는 것 | 지금 이름 규칙 | 띄우기 기록, 마무리 표시, GitHub 조회 로그만 기한 뒤. 대상과 기한은 [정리](cleanup.md#정리)의 보존 기한 표 |
| `specs/` | 지시서와 `spec-common.md` | 지금 이름 규칙 | 워크트리 정리 때. 워크트리 없이 남은 지시서는 PR 이 모두 머지됐으면 바로, 열린 PR, 살아 있는 worker, 대기 중인 배포 뒤 확인 어디에도 속하지 않으면 `cleanup.specs_days`(기본 3)일 뒤. `spec-common.md` 는 남긴다 |

## 저장소 스크립트에서 orch 부르기

**저장소의 `.orch/bin/` 스크립트와 `.orch/queue-env.sh` 같은 파일은 번들 경로를 박지 않는다.** 플러그인 경로는 프로필과 버전마다 바뀌어(`<설정 폴더>/plugins/cache/<마켓플레이스>/<플러그인>/<해시>/`), 박아 둔 경로는 갱신 뒤 옛 스크립트를 조용히 부른다. 저장소 체크아웃 경로도 그 체크아웃이 다른 브랜치에 있으면 main 과 다른 스크립트가 돈다.
아래 한 줄이 설치 기록에서 orch 실행기(플러그인 루트의 `bin/orch`)의 위치를 풀고, 스크립트는 `"$ORCH" <묶음> <동작> [인자]` 로 부른다. 저장소 스크립트는 PATH 의 `orch` 를 믿을 수 없어(Codex, 훅, cron) 경로를 푼다. 실행기가 그 호출의 설치 기록을 다시 읽어 현재 번들의 진입점에 넘긴다. 스크립트마다 새 셸이 뜨면 스크립트마다 이 줄을 둔다.
고르는 규칙은 `scripts/lib/install-record.ts` 의 `selectBundle` 과 같다. user 범위 설치본이 있으면 그것만 보고, 스크립트 폴더가 없으면 다른 범위로 넘어가지 않고 3 으로 끝난다.

```bash
ORCH=$(node -e 'const fs=require("fs"),os=require("os");const d=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";let l=[];try{l=JSON.parse(fs.readFileSync(d+"/plugins/installed_plugins.json","utf8")).plugins["fos-skills@fos-skills"]||[]}catch{}l=l.filter(e=>e&&e.installPath);const u=l.filter(e=>e.scope==="user");const e=(u.length?u:l).find(e=>fs.existsSync(e.installPath+"/skills/orch/scripts"));if(!e||!fs.existsSync(e.installPath+"/bin/orch")){console.error("orch: fos-skills 설치본이 없거나 실행기가 없는 옛 번들이다. claude plugin update fos-skills@fos-skills");process.exit(3)}console.log(e.installPath+"/bin/orch")') && "$ORCH" slot mem --help
```

<!-- orch-compat -->
옛 꼴 `"$ORCH" --path [이름]`(진입점 경로를 풀던 예전 한 줄)도 스크립트 폴더와 그 스크립트의 파일 경로를 낸다. 스크립트를 `node` 가 아닌 다른 방식으로 불러야 할 때 쓴다.
고치는 중인 체크아웃의 스크립트를 확인하려면 `ORCH_SCRIPTS_DIR` 에 그 체크아웃의 `skills/orch/scripts` 를 준다. 설치 기록보다 앞서고, 실행기와 진입점이 그 체크아웃의 진입점으로 넘긴다.
저장소에 복사해 둘 것은 실행기 `bin/orch` 다. Node 내장 모듈만 쓰는 한 파일이라 복사해도 설치 기록을 따라간다. 진입점 `skills/orch/bin/orch.ts` 는 같은 번들의 lib 를 읽어 한 파일로 돌지 않는다.

보드 파일도 기본값은 `.orch/board.json`이다. 경로 선택은 [work-board README](../../../extensions/work-board/README.md#보드에-항목-적기)에 있다.

스크립트가 `.orch/` 아래를 처음 만들 때 `.git/info/exclude` 에 `/.orch/` 를 더해 git 이 무시하게 한다. 저장소의 `.gitignore` 는 바꾸지 않는다.
오버레이와 설정을 저장소에 커밋해 함께 쓰려면 `git add -f .orch/overlay.md` 로 추적한다.
공개 저장소에 올리면 안 되는 값(서버 이름, 접속 설정 경로, 호스트 이름, 프로젝트 코드)이 있으면 추적하지 않는다.

## 옛 구조에서 옮기기

`.claude/orch-overlay.md`, `.claude/orch-finish.json`, `.omc/orch/`, `.omc/handoffs/specs/` 에 파일이 남은 저장소에서는
설정, 오버레이, 지시서 폴더를 읽는 진입점이 옮기는 명령을 알리고 종료 코드 2 로 멈춘다. 옛 위치는 읽지 않는다.

머지 큐와 worker 가 모두 끝난 때에 옮긴다. 먼저 미리보기로 옮길 것과 옛 경로를 적은 파일을 본다.
`$REPO` 는 대상 저장소의 주 checkout 이다.

```bash
orch doctor migrate --repo "$REPO"
orch doctor migrate --repo "$REPO" --apply
```

- 옮기는 쌍, `--move`, `--apply` 를 거부하는 조건과 종료 코드는 `scripts/doctor/migrate-orch-dir.ts` 머리 주석이 소유한다
- `OLD-REF <파일>:<줄>` 로 나온 파일(포장 스크립트, 추적 문서, 로컬 설정)은 스크립트가 바꾸지 않는다. 그 저장소가 고친다
- `TRACKED <명령>` 으로 나온 추적 파일은 보인 `git mv` 명령으로 옮겨 커밋한다
- `OLD-REF-SCRIPT` 로 나온 스크립트는 옮긴 뒤 바로 고친다. 그 스크립트가 옛 폴더를 다시 만들면 진입점이 다시 멈춘다
- 폴더를 옮긴 뒤 `config.json` 에 지운 칸이 남았으면 [`hooks.md`](hooks.md) 의 「옛 설정 칸 옮기기」 를 따른다

옛 위치의 보드는 평소대로 읽고 쓴다. `orch doctor`의 `OLD-BOARD` 안내가 보이면 보드를 쓰는 세션을 멈춘 뒤 위 명령으로 옮긴다. Git 밖에서 실행하면 홈 보드를 옮긴다.
같은 보드를 가리키는 `finish.board`는 보드가 있는 저장소와 Orca 등록 저장소에서 찾아 함께 바꾼다. 미리보기의 `WOULD-BOARD-CONFIG` 줄에서 갱신할 설정을 확인한다. 새 경로에 별개 보드가 있으면 `CONFLICT`가 표시되고 두 파일이 남는다.
Git이 추적하는 보드는 `TRACKED` 줄의 명령으로 직접 옮기고, `MANUAL-BOARD-CONFIG` 줄에 나오는 설정 값을 함께 바꾼다.

## 예시

```markdown
# orch 오버레이

- 기준 브랜치: develop. 필수 체크 `backend`, 관리자 우회 불가
- 머지 큐는 `--require-up-to-date --required backend` 로 돌린다
- 같은 파일을 고친 PR 은 `hooks/verify-merged.ts`에서 `cd "$copy" && ./gradlew test`를 돌리고 `--copy-dir worktrees/repo`로 머지한다
- 공통 지시서: `.orch/specs/spec-common.md`
- 검증: `scripts/verify.sh format`, `scripts/verify.sh test`
- 머지 전 명령: DB 마이그레이션이 든 PR 은 `PR:./bin/backup-db.sh <db> "before-pr-$PR"`. DB 마다 최근 2개만 보관
- CI runner 가 offline 이면 묻지 않고 runner 호스트를 재부팅하고, 끊긴 실행은 `gh run rerun --failed` 로 다시 돌린다
- 공부 후보: 글쓰기 스킬은 `blog-writer`, 글은 `~/blog` 저장소에 둔다
```

자동 머지를 켠 저장소의 `config.json` 조각이다.

```json
{
  "queue": { "auto_merge": true, "auto_review": { "review_checks": ["claude-review"] } },
  "migrations": {
    "dirs": { "api": "modules/api/src/main/resources/db/migration" },
    "watch": { "api": ["src/main/java/db/migration"] },
    "before": { "*": ".orch/bin/backup-db.sh {module} \"pre-$PR\"" }
  }
}
```

`dirs` 는 SQL 예약 자리이고 자동 감시에도 들어간다. `watch` 는 같은 모듈에 더할 Java 감시 폴더라 Java 경로의 Flyway 번호도 SQL 예약과 같은 번호 공간으로 본다. Java 마이그레이션은 `orch queue reserve --kind java` 로 받는다. 이름 규칙과 `--dir` 은 `queue reserve` 머리 주석이 소유한다.

### 모델 선택 관측 설정

`routing` 절은 이 절을 지원하는 새 번들을 설치한 뒤에만 `orch config set routing.review_author` 로 설정한다(옛 번들은 모르는 절을 설정 오류로 거부한다). 키와 형식은 [데이터 스키마](../../../docs/data-schema.md#configjson-에-더하는-절)가 소유한다.

```json
{
  "routing": {
    "review_author": "review-bot[bot]",
    "size_pattern": "PR 크기 등급: \\**([A-D])"
  }
}
```

`review_pattern` 의 기본 꼴과 `size_grade` 규칙은 데이터 스키마가 소유한다.

### 업무 도구 설정

새 번들을 설치하고 상주 루프를 다시 띄운 뒤에만 넣는다. 옛 번들은 `board` 절 전체를 설정 오류로 읽는다.

```bash
orch config set board.task.adapter dooray board.task.web_url https://x.dooray.com board.task.project P
orch config set board.task --json '{"adapter":"url-template","url":"https://jira.example.com/browse/{number}","name":"Jira"}'
```

`dooray` 는 사내 주소와 기본 프로젝트가 필수다. `url-template` 은 `{number}` 가 든 주소가 필수이고 이름은 생략하면 「업무」 다.
짝 키는 한 호출에 함께 준다. 어댑터를 바꿀 때는 위 두 번째 명령처럼 객체 전체를 바꾼다.

### 사건 대기 설정

`board.wait_events` 도 새 번들을 설치하고 상주 루프를 다시 띄운 뒤에만 넣는다. 옛 번들의 설정 검사기는 모르는 키로 읽어 설정 오류를 낸다.

```bash
orch config set board.wait_events --json '{"dev-eval":{"command":"node scripts/dev-eval-done.ts","timeout_sec":60}}'
```

확인 명령은 끝났으면 0, 아직이면 1 로 끝낸다. 출력은 1MB 를 넘기지 않는다.

### 알림 필터 설정

`inbox` 절도 새 번들을 설치한 뒤에만 넣는다. 옛 번들에서는 상주 루프가 틱마다 실패한다. 옛 자리 `config/notification.json` 의 내용을 그대로 `inbox` 절에 옮기고 옛 파일을 지운다. `orch doctor --repo` 가 옛 파일을 찾으면 `OLD-INBOX-FILTER` 로 알린다.

### 자동 머지 리뷰 조건

**리뷰 댓글의 문구로 통과나 막힘을 정하지 않는다(사용자 결정 2026-11-24).** 누가 쓴 댓글이든 문구만 있으면 통과하던 가짜 통과를 막으려는 것이다.
자동 머지와 `orch queue gate` 는 지금 HEAD 에 아래 가운데 하나가 있을 때 독립 리뷰가 있다고 본다. 규칙은 `scripts/core/auto-merge.ts` 머리 주석의 「judgeReview」, 키 형식은 저장소 `docs/data-schema.md` 가 소유한다.

- 믿는 리뷰 봇의 영수증(`trusted_bots`). 아래 「믿는 리뷰 봇의 영수증」
- 리뷰로 인정하는 CI 체크(`review_checks`)가 지금 HEAD 에서 success

```json
{ "queue": { "auto_merge": true, "auto_review": { "review_checks": ["claude-review"] } } }
```

리뷰 체크는 리뷰가 반영할 곳을 찾으면 체크를 실패시키는 워크플로여야 한다. 그 체크를 필수 체크로도 두면 머지 큐가 실패한 리뷰로 머지하지 않는다.
리뷰 체크의 실패는 다른 체크처럼 CI 감시가 worker 에게 고치라고 보낸다. 리뷰 체크가 그 HEAD 에서 도는 동안 최신화(`pipeline.refresh_slots`)는 HEAD 를 옮기지 않는다.

둘 다 없으면 루프는 기능 PR 인지와 관계없이 어떤 PR 도 자동 머지에 걸지 않고 기다린다. 코디네이터가 직접 거는 머지 큐와 `orch queue gate` 는 리뷰 조건은 보지 않고, 나머지 조건(CI, 미해결 스레드, draft, 충돌, 통합 테스트 기록, 비공개 낱말, 보류)은 그대로 본다.
리뷰 체크는 지금 HEAD 의 success 만 인정한다. 롤업이 지금 HEAD 의 체크만 담고 지적 등급을 알 수 없어서다. 리뷰 체크는 push 마다 CI 로 다시 돈다.
옛 문구 판정 키(`pass`, `block`, `require`, `feature_head`, `fixed_after_block`, `fallback`)는 읽지 않는다. `orch doctor --repo` 가 `LEGACY-REVIEW-KEY` 로 지우라고 알린다. 리뷰 봇 장애 때 대체 리뷰 worker 를 띄우던 기능도 그 판정 댓글로 통과시키던 것이라 함께 없앴다.

큐를 걸면 PR 마다 `AUTO-MERGE-BASIS` 줄에 통과 근거를 루프 로그에 남긴다.

#### 믿는 리뷰 봇의 영수증

`queue.auto_review.trusted_bots` 에 봇 계정과 영수증 형식을 목록으로 적으면, 자동 머지와 `orch queue gate` 가 봇 영수증을 확인한다.

```json
{
  "trusted_bots": [
    {
      "login": "chatgpt-codex-connector[bot]",
      "receipt_marker": "<!-- codex-review-receipt:v1 -->",
      "reviewed_commit": "^\\*\\*Reviewed commit:\\*\\* `([0-9a-fA-F]{7,40})`[ \\t]*\\r?$",
      "request_comment": "@codex review"
    }
  ]
}
```

GitHub 에서 계정 종류가 봇이고 `login` 이 같은 댓글과 리뷰만 본다. 표지는 한 줄 전체가 `receipt_marker` 와 같아야 한다.

봇의 마지막 리뷰에 P1·P2 지적이 없으면 그 뒤 커밋에도 그 리뷰를 인정한다(스펙 [merge-readiness](../../../docs/features/merge-readiness/spec.md) 의 DECISION15). 등급은 봇이 연 줄 댓글 첫 줄의 배지(`![P1 Badge]`)로 읽는다.
막는 지적은 줄 댓글(첫 배지가 P1·P2 이거나 읽지 못함), 리뷰 state(`CHANGES_REQUESTED`, 영수증이 맞지 않는 의견 리뷰), 리뷰 본문의 P1·P2 배지, 이슈 댓글 본문의 P1·P2 배지에서 온다. 시각은 보지 않고 그 지적이 본 커밋으로 묶는다.
해결했더라도 인정하려는 리뷰의 커밋과 같거나 그 뒤 커밋에 묶인 막는 지적이 있으면, 또는 커밋을 모르는 막는 지적이 있으면 인정하지 않는다. 같은 커밋을 다시 리뷰받아도 풀리지 않는다. 앞 리뷰의 커밋이 지금 PR 커밋 목록에 없으면(force-push 로 지웠다) 인정하지 않는다. 지금 HEAD 에서 봇 리뷰가 도는 중이면 그 결과를 기다린다. 앞 리뷰로 통과하면 `AUTO-MERGE-BASIS` 에 리뷰한 커밋과 `앞 리뷰 인정(P1·P2 없음)` 이 남는다.
`reviewed_commit` 은 각 줄의 시작과 끝을 쓸 수 있는 JavaScript 정규식이다. 첫 번째 캡처 그룹에서 7~40자리 16진수를 읽고 영수증에 적힌 자리 전체를 현재 HEAD 와 비교한다. 리뷰에 달린 영수증은 GitHub 가 기록한 리뷰 커밋 전체도 현재 HEAD 와 같아야 한다.

기준 브랜치를 합친 뒤에도 영수증은 갱신한 HEAD 를 가리켜야 한다.
봇을 여러 개 등록하면 그중 하나의 유효한 영수증으로 통과한다. 지적을 남긴 봇마다 그 봇이 발행한 새 영수증이 필요하다.
믿는 봇이 연 줄 댓글 스레드가 미해결이거나 그 봇이 지적을 남긴 뒤 현재 HEAD 의 새 영수증을 받지 못했으면 머지를 기다린다. GitHub 의 변경 요청과 영수증이 없는 의견 리뷰를 지적으로 읽는다.
GitHub 는 스레드 해결 시각을 제공하지 않는다. 관문은 스레드가 지금 해결됐는지와 영수증이 지적보다 늦게 달렸는지를 함께 확인한다.

믿는 봇을 설정하면 `orch spec review <PR>` 와 `orch queue gate <PR>` 는 봇 리뷰를 기다리라고 안내한다. 별도 리뷰 worker 가 필요하면 `orch spec review <PR> --review-worker` 를 쓴다.

`request_comment` 를 적으면 루프가 Ready PR 의 현재 HEAD 를 처음 발견한 뒤 `request_after_sec`(기본 180초) 이상 지난 틱에서 현재 상태를 다시 읽는다. 믿는 봇의 영수증이나 현재 HEAD 에 대한 진행 중 표시가 하나라도 있으면 요청을 미룬다. 진행 중 표시는 GitHub 리뷰 상태와 Codex 요약 댓글에서 읽는다. 요청이 필요하면 첫 번째로 `request_comment` 를 적은 봇에 현재 HEAD 당 한 번 댓글을 단다. 이전 HEAD 에 대한 봇 결과는 새 요청을 막지 않는다. 댓글을 달면 `BOT-REVIEW-REQUEST` 를 루프 로그에 남긴다.

