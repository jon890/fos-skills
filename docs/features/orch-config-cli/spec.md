# orch: 설정 파일을 `orch config` 명령으로 보고 고친다

확인: 2026-11-12

## 목표

코디네이터와 사용자가 `<orch 루트>/config.json` 의 값을 `orch config` 명령으로 보고 바꾼다. 편집기로 파일을 열어 고치지 않고, 틀린 값은 저장하기 전에 거절돼 상주 루프의 틱이 설정 오류로 실패하지 않는다.

- 배경(사용자 요청 2026-11-12): orch CLI 에 설정을 바꾸는 명령이 있는지 확인했더니 없었고, 사용자가 만들자고 했다.

## 조사한 사실

| 대상 | 사실 | 근거 |
| --- | --- | --- |
| 지금 명령 | 명령 표에 `config` 묶음이 없다 | `skills/orch/scripts/lib/commands.ts` |
| 설정을 쓰는 코드 | `orch doctor migrate`, `migrate-hooks` 의 `--apply` 만 쓴다. 옛 칸을 옮기거나 지우는 일만 한다 | `skills/orch/scripts/doctor/migrate-orch-dir.ts` 의 `writeJson`(272행)과 호출(620, 1073행) |
| 설정 파일 자리 | 주 checkout 의 orch 루트(`ORCH_DIR` 이 있으면 그 폴더) 아래 `config.json` 이다. 워크트리에서 불러도 같은 파일이다. orch 루트를 만들 때는 `ensure` 가 `/.orch/` 를 git 무시 목록에 더한다 | `skills/orch/scripts/lib/paths.ts` 의 `orchDir`, `pathOf`, `ensure`(135~139행) |
| 키 이름 검사 | 모르는 최상위 절은 `loadConfig` 가, 절 안의 모르는 키는 `section` 이 막는다. 절마다 아는 키 목록이 있고, `cleanup` 절의 목록은 내보내지 않는 지역 상수다 | `skills/orch/scripts/lib/config.ts`, `core/config.ts`, `core/finish-options.ts` 의 `FINISH_KEYS`, `lib/docker.ts` 의 `DOCKER_KEYS`, `cleanup/handoff-cleanup.ts` 109행의 `CLEANUP_KEYS` |
| 값 검사 | 값의 꼴은 그 값을 읽는 스크립트가 따로 검사하고 처리도 제각각이다. 틀리면 설정 오류(종료 코드 2)인 키(`pipeline.tick_sec`), 받아 주는 키(글자 `"30"` 인 `finish.merge_timeout`), 조용히 무시하는 키(글자가 아닌 `finish.deploy_workflow`), doctor 만 알리는 키(모르는 `queue.auto_review.require` 조건)가 있다 | `loop/steps/context.ts` 93행, `queue/finish-pr.ts` 263행, `core/milestones.ts` 130행, `doctor/orch-doctor.ts` 422~425행 |
| 틀린 값의 결과 | 루프 틱 자식이 설정 오류로 끝나면 부모가 `WATCH-ERROR` 를 알리고 다음 틱을 돈다. 루프가 멈추지는 않고 틱마다 실패한다 | `loop/lifecycle.ts` 562~597행 |
| 키 타입의 문서 | `docs/data-schema.md` 「config.json 에 더하는 절」 과 `skills/orch/references/overlay.md` 「마무리 설정 파일」 이 키 타입을 적는다. 두 문서가 겹치는 절이 있고 몇 키는 타입이 다르다(`pipeline.ready_slots` 는 `number` 와 「1 이상의 정수」). `finish` 의 `repo`, `sweep_arg`, `board_id`, `merge_timeout`, `deploy_timeout`, `poll_interval`, `worker_done_timeout`, `pid_file` 과 `cleanup` 의 `repo`, `run`, `gh_host` 는 두 문서 표에 없다 | 두 문서, `core/finish-options.ts`, `cleanup/handoff-cleanup.ts` |
| 루프가 읽는 때 | 틱마다 새 자식 프로세스가 설정을 다시 읽어 대부분의 키는 다음 틱에 반영된다. 부모가 시작할 때만 읽는 것은 `pipeline.tick_sec` 과, `--run` 없이 띄운 루프의 `finish.run`·`finish.specs_dir` 이다 | `loop/orch-loop.ts` 249행, `loop/lifecycle.ts` 의 `passArgs`(100~101행), 523, 562, 597행 |
| doctor 의 설정 검사 | 옛 설정 칸, 모르는 리뷰 조건, `inbox` 절의 모르는 키만 `INVALID-CONFIG` 로 알린다. 깨진 JSON 과 모르는 절은 stderr 에만 쓰고 종료 코드에 넣지 않는다 | `doctor/orch-doctor.ts` 415~432행 |
| 옛 설정 칸 | `queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd` 는 5.2.0 에서 지웠고, 남아 있으면 읽기가 실패한다. `orch doctor migrate-hooks --apply` 가 핸들러로 옮긴다 | `core/config.ts` 의 `REMOVED_CONFIG_KEYS`, `docs/data-schema.md` 119~124행 |
| `-` 로 시작하는 인자 | 진입점은 명령 표의 위치 인자 설정이 있으면 `-` 로 시작하는 낱말을 위치 인자로 받지 않는다 | `lib/commands.ts` 294행 |
| 파일을 직접 고치라는 안내 | 여러 참조 문서가 `.orch/config.json` 의 값을 직접 두라고 안내한다 | `skills/orch/references/replying.md` 199행, `heavy-checks.md` 11행, `board.md` 4행, `overlay.md`, `hooks.md` |
| 추적 여부 | 이 저장소는 `config.json` 을 git 이 무시한다. 다른 저장소는 커밋해 둘 수 있다 | `.gitignore` 5행, `skills/orch/references/spec-writing.md` 119행 |

## 범위

이번 범위:

- `orch config` 의 동작 넷: `show`, `get`, `set`, `unset`
- 아는 키마다 값 검사를 두고, `set`·`unset`·`orch doctor` 가 그 검사를 쓰게 하기
- 루프를 다시 띄워야 반영되는 키를 바꿨을 때 알리기
- 파일을 직접 고치라는 문서 안내를 명령으로 바꾸기, 공통 지시서에 worker 금지 글 규칙 두기

범위 밖:

- 루프와 기존 명령이 설정을 읽을 때의 검사를 바꾸는 것. 지금 받아 주는 값은 계속 받아 준다
- 파일에 없는 키의 기본값 보이기. 기본값이 읽는 스크립트마다 흩어져 있어 모으는 일은 따로 정한다
- 목록에 항목 하나를 더하고 빼는 동작(`add`, `remove`). 목록은 `set --json` 으로 통째로 바꾼다
- 루프를 자동으로 다시 띄우기
- 바뀐 값 자리만 고쳐 나머지 줄 모양을 지키기
- worker 가 이 명령을 부르는 것을 코드로 막기
- `overlay.md` 같은 설정 파일이 아닌 orch 루트 파일 고치기, 다른 경로의 설정 파일을 지정하는 옵션

## 요구사항과 인수 조건

경로는 `<절>.<키>` 이고 그 아래로 `.` 을 이어 더 깊이 간다(`queue.auto_review.require`). 「아는 이름」 은 절과 절 바로 아래 키는 아는 키 목록, 그 아래는 그 키의 값 검사가 정한다. 값 검사가 이름을 정해 둔 객체(`hooks.timeouts` 의 이벤트 이름, `queue.auto_review` 의 키, `pipeline.stall_ticks` 의 키)는 그 밖의 이름을 모른다. 이름을 마음대로 쓰는 객체(`migrations.dirs` 의 모듈 이름)는 어떤 이름이든 안다.

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | `orch config show [<절>]`, `orch config get <경로>`, `orch config set <경로> <값> [<경로> <값>...] [--json]`, `orch config unset <경로>...` 를 부를 수 있다. `set` 과 `unset` 은 여러 경로를 한 호출에 받아 한꺼번에 바꾸고 한꺼번에 검사한다. 하나라도 거절되면 아무것도 바꾸지 않는다. 어느 폴더에서 불러도 주 checkout 의 설정 파일을 쓰고, `--repo` 로 저장소를 정할 수 있다 | `orch config --help` 와 명령 표(`lib/commands.ts`)가 네 동작을 보인다. 워크트리 안에서 `set` 을 부르면 주 checkout 의 `config.json` 이 바뀌고 워크트리에 사본이 생기지 않는다. 인자를 빠뜨리면 종료 코드 2 와 사용법이 나온다. `set finish.deploy_workflow deploy.yml finish.deploy_branch main` 이 짝 규칙에 걸리지 않고 저장되고, `unset contracts.merge_command contracts.paths` 가 두 키를 함께 지운다 |
| REQ2 | `show` 는 파일 내용을 2칸 들여쓰기 JSON 으로 낸다. 절을 주면 그 절만 내고, 아는 절이 파일에 없으면 `{}` 를 낸다. 파일이 없으면 `{}` 를 낸다. 파일을 고치지 않는다. 옛 설정 칸, 모르는 이름, 틀린 값이 있어도 내용을 내고(종료 코드 0) 문제를 stderr 에 알린다. JSON 이 깨진 파일은 종료 코드 1 과 읽지 못한 이유를 낸다 | 절 하나를 준 `show` 가 그 절의 JSON 만 낸다. 파일이 없는 저장소에서 `{}` 가 나오고 파일이 생기지 않는다. 모르는 절 이름을 준 `show` 는 종료 코드 1 이고 아는 절 목록이 stderr 에 나온다. 오타 키가 든 파일의 `show` 는 종료 코드 0 이고 stderr 에 그 키가 나온다 |
| REQ3 | `get` 은 그 경로의 값을 JSON 한 줄로 낸다. 파일에 없으면 기본값을 내지 않고 종료 코드 1 과 「설정 파일에 없다」 를 낸다. 모르는 이름은 「모르는 키」 로 따로 알린다. 파일의 다른 곳에 문제가 있어도 값을 내고 문제를 stderr 에 알린다 | `set routing.review_author jon890` 뒤 `get routing.review_author` 가 `"jon890"` 한 줄을 낸다. 적지 않은 `pipeline.tick_sec` 은 종료 코드 1 과 「설정 파일에 없다」, `pipeline.tick_secs` 와 `queue.auto_review.prass` 는 종료 코드 1 과 「모르는 키」 다 |
| REQ4 | `set` 은 값을 글자로 저장한다. `--json` 이면 값을 JSON 으로 읽어 숫자, 참거짓, 목록, 객체를 넣는다. JSON 이 깨졌으면 저장하지 않고 종료 코드 1 이다. `-` 로 시작하는 값도 값으로 받는다. 경로의 중간 객체가 없으면 만든다 | `set routing.review_author jon890` 은 글자, `set pipeline.tick_sec 60 --json` 은 숫자, `set queue.required '["Tests"]' --json` 은 목록이 저장된다. `set hooks.timeouts.after-queue 30 --json` 이 `hooks` 절과 `timeouts` 객체가 없던 파일에서도 돈다. `set pipeline.tick_sec -1 --json` 은 사용법 오류가 아니라 값 검사의 거절(종료 코드 1)이다 |
| REQ5 | `set` 과 `unset` 은 바꾼 결과를 저장하기 전에 검사한다. `set` 은 모르는 이름을 거절한다. 바꾼 키(절 바로 아래 키)의 값은 그 키의 값 검사로 확인한다. 바꾼 뒤 그 절에 새로 생긴 문제가 있으면 저장하지 않고 종료 코드 1 과 이유를 낸다. 글자로 받은 값을 숫자·참거짓·목록·객체 키가 거절하면 이유에 `--json` 을 붙이라는 안내를 더한다. 바꾸기 전부터 있던 다른 문제(다른 키의 틀린 값, 오타 키, 모르는 절)는 막지 않고 stderr 에 알린다 | `set pipeline.tick_sec 60`(글자)은 종료 코드 1 이고 stderr 에 `--json` 안내가 나오며 파일 바이트가 그대로다. `set hooks.timeouts.foo 30 --json` 은 「모르는 키」 로 종료 코드 1 이다. 다른 키가 이미 틀린 파일이나 `queu` 절이 든 파일에서 맞는 값을 `set` 하면 저장되고 그 문제가 stderr 에 나온다. `contracts.paths` 를 `unset` 해 `merge_command` 만 남게 되면 거절된다 |
| REQ6 | 아는 키는 모두 값 검사를 가진다. 지금 검사가 없는 키는 지금 그 키를 읽는 코드가 받는 꼴을 기준으로 검사를 더한다. 두 문서의 타입이 다르거나 문서에 없는 키는 그 기준에 맞춰 문서를 고친다. 이 검사는 `set`, `unset`, `orch doctor` 가 쓴다. 루프와 기존 명령의 읽기는 지금 동작을 바꾸지 않는다 | 아는 키 목록의 키마다 맞는 값과 틀린 값 하나씩을 넣은 테스트가 있고, 틀린 값은 `set` 이 거절한다. 키 목록에 키를 더했는데 검사가 없으면 테스트가 실패한다. 글자 `"30"` 인 `finish.merge_timeout` 이 든 파일에서 `orch queue finish` 가 지금처럼 돈다. `docs/data-schema.md` 와 `overlay.md` 의 같은 키 타입이 같다 |
| REQ7 | `orch doctor` 는 설정 파일의 문제를 모두 `INVALID-CONFIG <경로> <이유>` 로 알리고 종료 코드 1 로 끝난다. 문제는 깨진 JSON, 모르는 절과 이름, 틀린 값, 옛 설정 칸이다 | 틀린 값, 오타 키, `queu` 절, 깨진 JSON 을 하나씩 넣은 파일마다 `orch doctor` 가 그 `INVALID-CONFIG` 줄과 종료 코드 1 을 낸다. 문제가 없는 파일에는 `INVALID-CONFIG` 줄이 없다 |
| REQ8 | `unset` 은 그 경로의 값을 지운다. 파일에 있는 모르는 이름(오타 키, 모르는 절)도 지운다. 이미 없으면 바꾸지 않고 종료 코드 0 이다. 지워서 빈 객체가 되면 그 객체를 지우고, 그래서 절이 비면 절도 지운다. 옛 설정 칸(`REMOVED_CONFIG_KEYS`)은 지우지 않고 종료 코드 1 과 `orch doctor migrate-hooks --apply` 안내를 낸다 | `unset queue.required` 뒤 `get queue.required` 가 「설정 파일에 없다」 다. 같은 `unset` 을 다시 불러도 종료 코드 0 이다. `unset pipeline.tick_secs` 가 파일의 오타 키를 지운다. 하나뿐인 `hooks.timeouts.after-queue` 를 지우면 `hooks` 절이 사라진다. `queue.before` 가 남은 파일에서 `unset queue.before` 는 종료 코드 1 이고 파일 바이트가 그대로다 |
| REQ9 | `set`·`unset` 은 파일 전체를 2칸 들여쓰기와 끝 줄바꿈으로 다시 쓴다. 키 순서는 그대로 두고 새 키는 그 객체 끝에, 새 절은 파일 끝에 둔다. 옆 파일에 쓴 뒤 이름을 바꾸고, 읽기부터 쓰기까지 파일 잠금을 지킨다. 파일이 없으면 다른 orch 파일과 같은 규칙으로 orch 루트를 만들고 stderr 에 「새로 만듦」 을 알린다. JSON 이 깨진 파일은 덮어쓰지 않고 거절한다. 옛 설정 칸이 남은 파일에서 다른 키의 `set` 은 옛 칸을 그대로 두고 쓴다 | 두 프로세스가 동시에 서로 다른 키를 `set` 해도 두 값이 모두 남는다. 파일이 없는 저장소에서 `set` 이 `.orch/config.json` 을 만든다. JSON 이 깨진 파일에서 `set` 은 종료 코드 1 이고 파일 바이트가 그대로다. 옛 설정 칸이 남은 파일에서 다른 키의 `set` 이 돌고 옛 칸이 남아 있다 |
| REQ10 | 성공 출력은 바꾼 경로마다 한 줄이다. `CONFIG-SET <경로> <새 값 JSON> (이전: <옛 값 JSON 또는 없음>)`, `CONFIG-UNSET <경로> (이전: <옛 값 JSON 또는 없음>)`. 거절은 stderr 에 이유를 쓴다. 종료 코드는 0 반영(또는 조회 성공), 1 거절, 2 사용법 오류다 | 성공한 `set` 의 stdout 이 한 줄이고 이전 값이 들어 있다. 거절한 호출은 파일 바이트가 그대로이고 종료 코드 1 이다 |
| REQ11 | 루프가 시작할 때만 읽는 키(`pipeline.tick_sec`, `--run` 없이 띄운 루프의 `finish.run`·`finish.specs_dir`)를 `set`·`unset` 으로 바꿨고 그 저장소의 상주 루프가 살아 있으면, stderr 에 「루프를 다시 띄워야 반영된다(orch loop stop 뒤 orch loop start)」 한 줄을 낸다. 저장은 그대로 한다 | 루프가 도는 저장소에서 `set pipeline.tick_sec 60 --json` 이 저장되고 그 한 줄이 나온다. 루프가 없으면 나오지 않는다. 틱마다 다시 읽는 키(`pipeline.digest_sec`, `queue.auto_merge`)에는 나오지 않는다 |
| REQ12 | orch 스킬 문서가 설정을 바꿀 때 이 명령을 쓰라고 안내한다. 값을 직접 두라는 안내는 명령 예시로 바꾼다. 키의 타입과 뜻의 원본은 지금 문서에 그대로 둔다 | `skills/orch/references/overlay.md` 에 `orch config` 소개가 있고, `replying.md` 의 `board.auto_advance` 안내 같은 직접 고치기 안내가 `orch config set` 예시로 바뀌었다 |
| REQ13 | worker 는 `orch config set`, `unset` 을 부르지 않는다. 코드로 막지 않고 공통 지시서의 글 규칙으로 둔다 | 공통 지시서에 그 규칙 한 줄이 있다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 명령의 동작 | `show`, `get`, `set`, `unset` 넷. 목록 항목 더하기와 빼기는 두지 않는다 | 사용자 2026-11-12 | 직접 고치던 일을 모두 대신하는 가장 작은 묶음이다 |
| DECISION2 | 값 검사 수준 | 키 이름과 값의 꼴까지 검사하고, 틀리면 저장하지 않는다 | 사용자 2026-11-12 | 틀린 값이 저장되면 루프 틱이 설정 오류로 실패하거나 값이 조용히 무시된다(「조사한 사실」 의 값 검사 행) |
| DECISION3 | 값 입력 꼴 | 기본은 글자, `--json` 일 때만 JSON 으로 읽는다 | 사용자 2026-11-12 | 사용자가 골랐다. 값의 뜻이 플래그로 드러난다 |
| DECISION4 | worker 의 사용 | 코드로 막지 않고 공통 지시서의 글 규칙으로 막는다 | 사용자 2026-11-12 | worker 인지 알아내는 장치가 새로 필요하다. 「orch board 명령」 스펙의 DECISION8 과 같다 |
| DECISION5 | 루프를 다시 띄워야 하는 키 | 저장하고 루프가 살아 있으면 다시 띄우라고 한 줄 알린다. 자동으로 다시 띄우지 않는다 | 사용자 2026-11-12 | 루프를 언제 끊을지는 사람이 정한다 |
| DECISION6 | 검사가 없는 키 | 검사를 더해 아는 키가 모두 검사를 가진다 | 사용자 2026-11-12 | 검사가 없는 키로 틀린 값이 들어가는 길을 남기지 않는다 |
| DECISION7 | 다시 쓰는 파일 모양 | 2칸 들여쓰기와 끝 줄바꿈. 키 순서는 그대로 | 사용자 2026-11-12 | `doctor migrate` 의 `writeJson` 과 같다. 커밋하는 저장소는 처음 한 번 diff 가 커질 수 있다 |
| DECISION8 | 파일이 없을 때 `set` | 새로 만들고 stderr 에 알린다 | 사용자 2026-11-12 | 편집기로 만들 때와 같은 결과다 |
| DECISION9 | 옛 설정 칸의 `unset` | 거절하고 `orch doctor migrate-hooks --apply` 를 안내한다 | 사용자 2026-11-12 | 지우면 그 명령이 핸들러로 옮겨지지 않고 사라진다 |
| DECISION10 | `get` 의 기본값 | 파일에 적힌 값만 낸다. 없으면 종료 코드 1 | 사용자 2026-11-12 | 기본값은 읽는 스크립트마다 흩어져 있어 모으는 일은 따로 정한다 |
| DECISION11 | 엄격한 검사의 범위 | `set`·`unset` 과 `orch doctor` 만 엄격하다. 루프와 기존 명령의 읽기는 지금처럼 둔다. doctor 는 설정 문제를 모두 `INVALID-CONFIG` 와 종료 코드 1 로 알린다 | 사용자 2026-11-12 (스펙 검토 뒤) | 검토자가 지금 받아 주는 값(글자 `"30"` 인 `merge_timeout`, 모르는 리뷰 조건)을 찾았다. 읽기를 엄격하게 하면 플러그인 업데이트만으로 돌던 저장소가 실패한다 |
| DECISION12 | 파일에 있는 오타 키 | `unset` 으로 지울 수 있다. `set` 은 모르는 이름을 거절한다. 같은 파일에서 다른 키의 `set` 은 돌고 오타는 stderr 로 알린다 | 사용자 2026-11-12 (스펙 검토 뒤) | 편집기를 열지 않고 고칠 길을 남긴다 |
| DECISION13 | 설정 파일 자리 | 주 checkout 의 orch 루트 `config.json`. `--repo` 를 받는다. 새로 만들 때는 orch 루트를 만드는 기존 규칙(`ensure`, git 무시 목록에 더함)을 쓴다 | 작성자 | 다른 orch 명령과 같은 규칙이다(`lib/paths.ts` 의 `orchDir`, `ensure`, `lib/context.ts`) |
| DECISION14 | 출력과 종료 코드 | 성공은 한 줄(`CONFIG-SET`, `CONFIG-UNSET`)에 이전 값을 붙인다. 0 반영, 1 거절, 2 사용법 오류 | 작성자 | 「orch board 명령」 스펙의 DECISION3 과 같은 관례다. 이전 값이 있으면 추적하지 않는 파일도 `set` 으로 되돌릴 수 있다 |
| DECISION15 | 이미 있던 다른 문제 | 바꾼 뒤 새로 생긴 문제만 거절하고, 전부터 있던 문제는 stderr 에 알린다. `show`·`get` 도 문제를 알리되 내용을 낸다 | 작성자 | 파일 전체를 검사해 거절하면 틀린 키가 둘일 때 하나를 고치는 `set` 도 막혀 명령으로 고칠 길이 없다. 문제를 보려고 부른 `show` 가 거절되면 안 된다 |
| DECISION16 | 동시 쓰기 | 읽기부터 쓰기까지 파일 잠금을 쥐고 옆 파일에 쓴 뒤 이름을 바꾼다 | 작성자 | 보드와 승인 파일이 쓰는 잠금 규약이다(`docs/adr/029-board-write-lock.md`, `docs/data-schema.md` 의 `state/approvals.json.lock`) |
| DECISION17 | `unset` 의 반복과 빈 객체 | 이미 없으면 종료 코드 0, 지워서 빈 객체와 빈 절은 지운다 | 작성자 | 같은 호출을 다시 불러도 안전하다. 빈 객체는 없는 것과 뜻이 같다 |
| DECISION18 | 셋째 단계 아래 이름 | 이름을 정해 둔 객체는 그 밖의 이름을 모르는 키로 보고, 이름을 마음대로 쓰는 객체는 어떤 이름이든 받는다 | 작성자 | `docs/data-schema.md` 가 `hooks.timeouts` 의 모르는 이벤트 이름을 사용법 오류로 정했고, `migrations.dirs` 는 모듈 이름을 키로 쓴다 |
| DECISION19 | 키 타입의 기준 | 지금 그 키를 읽는 코드가 받는 꼴. 문서가 다르면 문서를 고친다 | 작성자 | 읽기를 바꾸지 않으므로(DECISION11) 읽는 코드가 받아 주는 값을 `set` 이 거절하면 안 되고, 읽는 코드가 거절하는 값을 `set` 이 받아도 안 된다 |
| DECISION20 | `-` 로 시작하는 값 | 값으로 받는다 | 작성자 | `-1` 처럼 값 검사가 거절해야 할 값이 사용법 오류로 바뀌면 거절 이유가 흐려진다 |
| DECISION22 | 짝으로만 유효한 키 | `set`·`unset` 이 여러 경로를 한 호출에 받아 함께 바꾸고 함께 검사한다 | 사용자 2026-11-12 (설계 검토 뒤) | 키를 하나씩 바꾸면 `contracts.merge_command`·`paths`, `finish.deploy_workflow`·`deploy_branch` 를 넣을 수도 지울 수도 없다(설계 검토). 짝 규칙을 경고로 낮추면 그 사이 루프와 머지 큐가 틀린 파일을 읽는다 |
| DECISION21 | 문서 안내 | 직접 고치기 안내를 명령 예시로 바꾸고 키의 원본 문서는 그대로 둔다 | 작성자 | 「orch board 명령」 스펙의 REQ14 와 같은 방식이다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 설정 파일의 절과 키는 `docs/data-schema.md` 와 `skills/orch/references/overlay.md` 가 정한 그대로 두고, 보고 고치는 입구와 값 검사만 더한다. 두 문서의 타입이 어긋난 곳은 지금 코드에 맞춰 바로잡는다.
