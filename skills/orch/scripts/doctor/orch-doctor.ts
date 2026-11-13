// 스킬을 열 때 설치본이 낡지 않았는지, 문서가 부르는 스크립트가 모두 있는지, 저장소의 핸들러와 설정을 본다.
//
// 플러그인 스킬은 체크아웃이 아니라 설치 캐시의 복사본이 실행된다. 캐시가 옛 커밋이면
// 문서가 부르는 스크립트(`spec-line.ts` 같은 것)가 없어 그 단계를 건너뛰게 된다.
// 갱신 명령을 보여 주는 것까지만 하고 갱신은 하지 않는다. 다른 세션이 같은 캐시를 쓰고 있을 수 있다.
//
// Node 버전은 여기서 보지 않는다. 타입 제거를 지원하지 않는 낮은 node 는 이 파일을 읽지 못하고 ERR_UNKNOWN_FILE_EXTENSION 으로 죽는다.
// 그래서 SKILL.md 가 부르는 `orch doctor` 의 실행기(플러그인 루트 bin/orch, CommonJS)가 먼저 버전을 보고 낮으면 NODE-TOO-OLD 를 낸다.
// 옛 진입점 `orch-doctor.py` 는 ts_shim.py 로 같은 판정을 한다.
//
// 사용법:
//     orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]
//
//     --skill-dir       볼 스킬 디렉터리. 기본은 이 스크립트의 상위 디렉터리($SKILL_DIR)
//     --remote          원본 저장소. 주지 않으면 설치 경로의 마켓플레이스 clone 의 origin 을 쓴다
//     --branch          원본의 기준 브랜치. 기본 main
//     --skip-version    설치본 비교를 건너뛴다. 저장소 문서 테스트는 checkScripts 를 직접 부른다
//     --run             미답변 질문과 worker 판정을 볼 Run. 주면 session-resume 이벤트도 낸다
//     --skip-questions  질문 상태 조회를 건너뛴다
//     --repo            핸들러와 설정을 볼 저장소. 기본은 작업 디렉터리의 주 checkout
//
// 설치본 판정:
//     설치 경로는 `<plugins>/cache/<마켓플레이스>/<플러그인>/<sha 또는 버전>/<스킬>` 이다.
//     폴더 이름이 sha 면 설치한 커밋이고, 버전이면 installed_plugins.json 에서 같은 installPath 의 gitCommitSha 를 읽는다.
//     원본 브랜치의 커밋을 `git ls-remote` 로 읽어 앞자리가 같으면 최신이다.
//     다르면 설치본 스킬 디렉터리의 tree hash 를 마켓플레이스 clone 의 `<원본 커밋>:<스킬>` 과 비교한다.
//     같으면 최신으로 본다. 다른 스킬만 바뀐 커밋에 갱신하라고 하지 않기 위해서다.
//     마켓플레이스 clone 은 커밋 하나뿐인 shallow clone 이라 커밋끼리 diff 하지 못한다. 그래서 tree 를 비교한다.
//     clone 에 원본 커밋이 없거나(마켓플레이스를 아직 갱신하지 않았다) 그 경로가 없으면 판정할 수 없어 낡은 것으로 본다.
//     설치 경로가 이 꼴이 아니거나 버전 폴더의 설치 기록을 찾지 못하면 비교하지 않는다.
//     (`--plugin-dir` 로 체크아웃을 실은 경우도 비교하지 않는다.)
//     원본을 읽지 못하면(오프라인) 비교하지 않고 SKIP-VERSION 을 낸다. 스킬을 여는 일을 막지 않는다.
//
// 스크립트 판정:
//     SKILL.md 와 그 아래 .md 에서 `$SKILL_DIR/scripts/<이름>` 과 상대 링크 `](scripts/<이름>)`, `](../scripts/<이름>)` 를 읽는다.
//     확장자는 가리지 않는다. `.py` 와 `.ts` 가 함께 쓰인다.
//     형제 번들 변수 `$PLAN_SKILL_DIR/scripts/<이름>` 은 같은 플러그인의 `skills/plan/scripts/<이름>` 으로 본다
//     (변수 이름의 `_SKILL_DIR` 앞을 소문자로 바꾸고 `_` 를 `-` 로 바꾼 디렉터리).
//     백틱 안의 `scripts/verify.sh` 처럼 앞에 아무것도 없는 경로는 저장소 쪽 예시일 수 있어 보지 않는다.
//     진입점으로 부르는 `$SKILL_DIR/bin/orch.ts <이름>` 은 `bin/orch.ts` 와 명령 표가 푼 `scripts/<묶음>/<이름>.ts` 를 모두 본다.
//     새 꼴 `orch <묶음> <동작>` 은 백틱 안이나 코드 블록 안에서 `orch ` 뒤에 ASCII 소문자 낱말이 오는 것만 명령으로 본다(산문의 「orch 루트」 는 보지 않는다).
//     그 낱말이 명령 표(lib/commands.ts)의 묶음이 아니거나 동작을 풀지 못하거나 그 스크립트가 orch 의 scripts 에 없으면 MISSING 이다.
//     줄이나 바로 윗줄에 `orch-compat` 가 있으면 보지 않는다(옛 꼴의 호환을 설명하는 자리).
//
// 저장소 판정(--repo):
//     <orch 루트>/hooks/ 바로 아래의 .ts 가운데 이벤트 이름이 아닌 파일은 UNKNOWN-HOOK 이다(lib/events.ts 의 unknownHandlers).
//     <orch 루트>/config.json 의 문제는 모두 INVALID-CONFIG <경로> <이유> 와 종료 코드 1 이다. 문제는 설정 검사표(core/config-schema.ts)의 problems 가 모은다.
//     JSON 이 깨졌으면 경로가 config.json 이다. 종류는 모르는 절·키·이름, 틀린 값, 짝 규칙 위반, 5.2.0 에서 지운 옛 칸이다.
//     모르는 리뷰 조건 이름(queue.auto_review.require)도 여기 든다. 상주 루프는 이 설정으로 멈추지 않고 PR 만 걸지 않아, 여기서 알리지 않으면 자동 머지가 조용히 서 있다.
//     검사표는 zod 에 기대므로 불러오지 못하면(의존 설치 실패) CLI-DEPS-MISSING <이유> 한 줄을 내고 설정 검사만 건너뛴다. 종료 코드는 바꾸지 않는다.
//     ORCH_CONFIG_SCHEMA 는 테스트 전용이다. 검사표 모듈 대신 그 경로의 파일을 불러와 불러오기 실패를 흉내 낸다.
//     UNKNOWN-HOOK 은 종료 코드를 바꾸지 않는다. 오타 난 핸들러는 불리지 않아 조용히 빠지므로 알려야 한다.
//
// 개선 후보 판정(늘 본다):
//     --repo 의 <orch 루트>/feedback/(lib/paths.ts 의 feedback) 바로 아래 새 양식의 후보·보류와 아직 옮기지 않은 옛 메모 파일을 센다.
//     하나 이상이면 FEEDBACK-OPEN 줄을 낸다. 다시 보는 주기와 판정은 references/feedback-review.md 가 소유한다.
//     폴더가 없거나 읽지 못하면 내지 않는다. 경고라 종료 코드를 바꾸지 않는다.
//
// 공부 후보 판정(늘 본다):
//     --repo 의 <orch 루트>/study/ 의 후보 파일 가운데 상태가 `후보` 나 `리뷰함` 인 것을 센다. 파일 형식은 lib/study.ts 가 소유한다.
//     하나 이상이면 STUDY-OPEN 줄을 낸다. 알리는 말과 고른 뒤의 절차는 references/study-candidates.md 가 소유한다.
//     폴더가 없으면 내지 않는다. 머리를 읽지 못한 파일과 옛 표 파일(candidates.md)은 세지 않고 stderr 에 알린다.
//     옛 표 파일은 `orch study migrate` 로 옮기라고 알린다. 경고라 종료 코드를 바꾸지 않는다.
//
// 설치 기록 판정(늘 본다):
//     `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `plugins/installed_plugins.json` 에 적힌 모든 플러그인의 installPath 가 실제로 있는지 본다.
//     Orca 가 세션을 새 설정 폴더로 열면 기록의 installPath 가 옛 설정 폴더를 가리킨 채 남을 수 있다. 그 경로에 복사본이 없으면
//     Claude Code 는 그 플러그인을 싣지 않는다(디버그 로그의 `Plugin "<이름>" not cached at <경로>`). 스킬과 슬래시 명령이 통째로 빠지는데
//     위의 설치본 판정은 실린 스킬의 버전만 보므로 알아채지 못한다. 없는 것만 낸다. fos-skills 도 같은 규칙이다.
//     installPath 에서 `/plugins/` 뒤를 현재 설정 폴더의 plugins 아래에 붙인 경로가 있으면 그 경로를 함께 낸다(복사본이 옮겨 간 경우).
//     기록 파일이 없거나 읽지 못하면 판정하지 않는다. 파일은 고치지 않는다. 경고라 종료 코드를 바꾸지 않는다.
//
// orch 명령 판정(늘 본다):
//     Claude 세션의 Bash 는 플러그인 bin/ 이 PATH 에 있어 사람 셸(Codex 포함)의 PATH 를 볼 수 없다. 그래서 ~/.local/bin/orch 사본을 본다.
//     스킬 번들의 플러그인 루트에 실행기 bin/orch 가 없으면(이 기능 이전 배치) 판정하지 않는다.
//     사본이 없거나 표지(fos-skills orch launcher)가 없으면 CLI-MISSING, 내용이 지금 실행기와 다르면 CLI-STALE 이고 다음 줄에 고칠 명령이 온다.
//     PATH 에서 플러그인 bin/ 폴더를 뺀 나머지에 ~/.local/bin 이 없으면 CLI-NOT-ON-PATH 와 셸 설정 안내다. 경고라 종료 코드를 바꾸지 않는다.
//
// 옛 꼴과 직접 경로 판정(늘 본다):
//     --repo 의 <orch 루트>/overlay.md, config.json, specs/spec-common.md, bin/*, hooks/* 와 저장소의 .claude/skills/** 를 줄마다 본다.
//     진입점 옛 꼴(`orch.ts` 나 `orch.mts`, `"$ORCH"` 뒤의 옛 이름, `--path <옛 이름>`, orch-doctor.py)은 OLD-CALL,
//     orch 스크립트 파일 경로 호출(`orch/scripts/<이름>.ts`, `$SKILL_DIR/scripts/<이름>.ts`, `$ORCH_SCRIPTS/<이름>.ts`, `join(ORCH_SCRIPTS, '<이름>.ts')`,
//     그 사이에 묶음 폴더가 든 지금 배치 `scripts/<묶음>/<이름>.ts`, `join(ORCH_SCRIPTS, '<묶음>', '<이름>.ts')`)은
//     DIRECT-PATH 다. <이름> 은 명령 표의 스크립트로 한정한다. 한 줄에 둘이 걸리면 OLD-CALL 하나다. 다음 줄에 새 꼴이 온다.
//     줄이나 바로 윗줄에 `orch-compat` 가 있으면 내지 않는다. 고치는 일은 코디네이터가 그 저장소 worker 에게 맡긴다. 경고라 종료 코드를 바꾸지 않는다.
//     같은 파일 가운데 Markdown 과 JSON 이 아닌 파일(저장소 스크립트)이 대기 출력의 `LAST_DELIVERY` 를 읽는 줄은 WAIT-READER 다.
//     짧은 출력의 orch wait 은 JSON 대신 메시지마다 판정 줄을 내므로, JSON 을 읽던 스크립트는 그 줄을 쓰거나 RAW 파일을 읽어야 한다. 다음 줄에 고칠 것이 온다.
//
// 대기 번들 판정(늘 본다):
//     아래 루프 번들 판정과 같은 규칙을 ps 의 wait-important.ts 행(그것이 띄운 orchestration check 행은 뺀다)에 쓴다. 판정이면 WAIT-STALE 이다.
//
// 루프 번들 판정(늘 본다):
//     `ps -axo pid=,command=`(PS 환경 변수로 바꾼다)에서 `orch-loop.ts` 와 `--foreground` 가 든 행(상주 루프의 부모)을 읽는다.
//     --tick 자식과 --start 는 뺀다. 스크립트 경로는 첫 낱말(node) 뒤 처음 `/` 로 시작하는 곳부터 `orch-loop.ts` 까지다(경로에 빈칸이 있을 수 있다).
//     아래 줄은 옛 번들의 경로 꼴을 그대로 적는다(orch-compat).
//     그 경로가 설치 캐시 꼴(`<plugins>/cache/<마켓플레이스>/<플러그인>/<sha 나 버전>/orch/scripts/orch-loop.ts`, 묶음 폴더가 든 `…/scripts/loop/orch-loop.ts` 도 같다.
//     스킬 폴더는 경로의 마지막 `/scripts/` 앞이다)이면
//     지금 세션 프로필(`CLAUDE_CONFIG_DIR`, 없으면 `~/.claude`)의 installed_plugins.json 에서 `<플러그인>@<마켓플레이스>` 의 user 범위 installPath 를 읽는다.
//     그 installPath 가 루프의 번들 폴더와 같지 않고 마지막 폴더 이름도 다르면 LOOP-STALE 이다. 이미 고친 결함이 옛 번들의 루프에서 계속 난다.
//     project 범위 행은 보지 않는다. 다른 프로필이 남긴 옛 행(3.6.0)과 같다고 옛 번들의 루프를 통과시킨 일이 있었다(2026-11-04).
//     user 범위 행이 없으면 판정하지 않는다. 판정 규칙은 이 기능 전과 같다(진입점의 번들 고르기 lib/install-record.ts 와 따로 둔다).
//     캐시 꼴이 아니면(저장소 체크아웃에서 띄운 개발 중인 루프) 보지 않는다. installed_plugins.json 을 읽지 못하면 판정하지 않는다.
//     다시 띄우는 명령은 그 루프의 Run 코디네이터 세션에서 돌리라는 안내와 함께 낸다. 루프는 띄운 터미널의 Run 명의를 물려받는다
//     (loop/lifecycle.ts 머리 주석의 「명의」). Run 은 그 저장소 loop.json 의 bound_run, 없으면 run 이다. 경고라 종료 코드를 바꾸지 않는다.
//
// Orca 형식 판정(늘 본다):
//     `orca orchestration worker-list --limit 1 --full --json` 의 첫 행에 lib/workers.ts 의 ROW_KEYS 가 모두 있는지 본다.
//     빠진 키가 있으면 ORCA-SHAPE 줄과 안내 줄을 낸다. Orca 가 자동 갱신으로 출력 형식을 바꾸면 스크립트는 오류 없이 빈 값으로 판정한다.
//     orca 를 10초 안에 읽지 못했거나 행이 없으면 판정하지 않는다(다른 판정이 조회 실패를 알린다). 경고라 종료 코드를 바꾸지 않는다.
//
// worker 판정(--run 을 줄 때):
//     그 Run 의 worker-list 행 가운데 살아 있는 dispatch 이고 터미널의 ownershipState 가 user_owned 인 것을 lib/worker-state.ts 로 판정한다.
//     새 세션에서 띄운 worker 를 Orca 가 user_takeover 로 적어, 일하는 worker 가 사용자에게 넘어간 것처럼 보인다.
//     그 터미널 화면을 읽어 에이전트가 작업 중이면 working, 아니면 taken_over 다. 판정마다 WORKER-STATE 줄을 낸다.
//     worker-list 를 30초 안에 읽지 못하면 SKIP-WORKERS 다. 경고라 종료 코드를 바꾸지 않는다.
//     실패한 dispatch 나 작업 중이 아닌 user_owned 터미널이 있으면 `orch worker adopt` 를 안내한다.
//
// session-resume 이벤트(--run 을 줄 때, lib/events.ts 머리 주석의 「이벤트별 필드」):
//     loop_alive  --repo 의 주 checkout 에서 상주 루프가 살아 있는지(lib/loop.ts 의 loopStatus).
//                 죽었으면 `LOOP-DEAD <repo> <이유>` 줄과, 다음 줄에 다시 띄울 `orch loop start` 명령을 낸다. 종료 코드는 바꾸지 않는다.
//                 Run 등록을 아는 살아 있는 루프(loop.json 에 runs 가 있다)에 이 Run 이 등록되지 않았으면 그 루프는 이 Run 을 맡지 않는다.
//                 false 로 보고 `LOOP-DEAD <repo> run <Run> 미등록` 줄과 같은 --start 명령을 낸다(wait-important 의 미등록 판정과 같다).
//                 pid 가 살아 있는 루프 프로세스인데 alive_at 만 오래됐으면(loopStatus 의 recheck) lib/loop.ts 의 recheckMs 를
//                 기다린 뒤 한 번 더 판정한다. 잠들었다 깬 macOS 에서 루프의 타이머가 아직 alive_at 을 쓰지 못했을 수 있다
//     waiters     이 Run 의 살아 있는 대기(wait-important)와 질문 감시(watch-questions) pid. 찾는 규칙은 lib/waiters.ts 가 소유한다.
//                 PS 환경 변수로 ps 실행 파일을 바꾼다
//     unanswered  질문 조회가 낸 미답변 질문 id 전부. 조회하지 못했거나 --skip-questions 면 빈 목록
//     repo 는 --repo, base 는 그 저장소의 origin/HEAD 브랜치(없으면 빈 문자열), run 은 --run 이다.
//     핸들러의 실패는 `HOOK-FAIL` 줄만 남기고 종료 코드를 바꾸지 않는다.
//
// 출력 (한 줄에 하나):
//     OK-VERSION <sha>                           설치본이 원본과 같거나 그 스킬이 바뀌지 않았다
//     STALE <설치 sha> <원본 sha>                설치본이 낡았다. 다음 줄에 갱신 명령이 온다
//     SKIP-VERSION <이유>                        비교하지 않았다
//     MISSING <문서>:<줄> <경로>                 문서가 부르는 스크립트가 없다
//     OK-SCRIPTS <개수>                          문서가 부르는 스크립트가 모두 있다
//     UNKNOWN-HOOK <파일>                        이벤트 이름이 아닌 핸들러 파일
//     INVALID-CONFIG <경로> <이유>                설정 파일의 문제 하나. 깨진 JSON(경로 config.json), 모르는 절·키, 틀린 값, 짝 규칙 위반, 삭제한 옛 설정 칸(이유에 고칠 명령이 든다)
//     CLI-DEPS-MISSING <이유>                    설정 검사표가 쓰는 의존(zod)을 불러오지 못했다. 설정 검사만 건너뛴다. 플러그인을 다시 설치하거나 플러그인 폴더에서 npm ci 를 돈다. 종료 코드에는 영향이 없다
//     OLD-INBOX-FILTER <옛 파일> ...              옛 알림 필터(<orch 루트>/config/notification.json)가 있다. config.json 의 inbox 절로 옮기는 법을 알린다. 종료 코드에는 영향이 없다
//     끝난 dispatch 의 질문은 lib/questions.ts 와 같은 PR 종료 근거로 제외한다.
//     UNANSWERED <id> <설명>                     10분 이상 답이 없는 질문이 있다
//     SKIP-QUESTIONS <이유>                      질문 상태를 조회하지 못했다. orca 가 조회마다 30초(ORCH_QUESTIONS_TIMEOUT_SEC) 안에 답하지 않은 경우도 여기다
//     PLUGIN-PATH-MISSING <플러그인> <scope> <경로>   설치 기록의 installPath 가 없다. 이어서 현재 설정 폴더에 같은 상대 경로가 있으면 그 경로,
//                                                고치는 방법과 `/reload-plugins` 안내가 온다
//     LOOP-DEAD <repo> <이유>                    --run 을 줬는데 상주 루프가 죽었다. 다음 줄에 다시 띄울 명령이 온다
//     LOOP-STALE <repo> <pid> <번들 sha 나 버전>  지금 세션의 설치본이 아닌 번들로 도는 상주 루프. 다음 줄에 안내와 다시 띄울 명령이 온다
//     WORKER-STATE <dispatch> <상태> <근거>       --run 의 살아 있는 dispatch 가운데 user_owned 로 표시된 것의 판정(위 「worker 판정」)
//     SKIP-WORKERS <이유>                         worker 판정을 하지 못했다
//     FEEDBACK-OPEN <개수> <폴더>                 다시 보지 않은 스킬 개선 후보 파일이 있다(위 「개선 후보 판정」)
//     STUDY-OPEN <개수> <폴더>                    글을 쓰지도 빼지도 않은 공부 후보가 있다(위 「공부 후보 판정」)
//     ORCA-SHAPE worker-list <키,키>              worker-list 행에 orch 가 읽는 키가 없다(위 「Orca 형식 판정」). 다음 줄에 안내가 온다
//     CLI-MISSING <경로>, CLI-STALE <경로>        ~/.local/bin/orch 가 없거나 낡았다(위 「orch 명령 판정」). 다음 줄에 고칠 명령이 온다
//     CLI-NOT-ON-PATH <폴더>                      그 폴더가 셸 PATH 에 없다. 다음 줄에 셸 설정 안내가 온다
//     OLD-CALL <파일>:<줄> <옛 이름>              저장소 파일이 진입점 옛 꼴로 부른다(위 「옛 꼴과 직접 경로 판정」). 다음 줄에 새 꼴이 온다
//     DIRECT-PATH <파일>:<줄> <스크립트>          저장소 파일이 orch 스크립트를 파일 경로로 부른다. 다음 줄에 새 꼴이 온다
//     WAIT-READER <파일>:<줄>                    저장소 스크립트가 대기 출력(LAST_DELIVERY)을 읽는다(위 「옛 꼴과 직접 경로 판정」). 다음 줄에 고칠 것이 온다
//     WAIT-STALE <pid> <번들 sha 나 버전>          지금 세션의 설치본이 아닌 번들로 도는 대기. 다음 줄에 다시 거는 안내가 온다
//     질문이 많은 Run 의 조회 범위 안내는 stderr 로 낸다(lib/questions.ts 머리 주석).
//
// 짧은 출력(진입점의 orch doctor, lib/output.ts): 판정 줄과 그 뒤 들여 쓴 고칠 줄(고칠 명령, 새 꼴, 명령)만 낸다. `  안내:` 줄은 --full 이다.
//
// 종료 코드:
//     0  STALE, MISSING, UNANSWERED, INVALID-CONFIG 가 없다(SKIP, UNKNOWN-HOOK, PLUGIN-PATH-MISSING, LOOP-DEAD, LOOP-STALE, WAIT-STALE, WORKER-STATE, OLD-INBOX-FILTER, FEEDBACK-OPEN, STUDY-OPEN, ORCA-SHAPE, CLI-*(CLI-DEPS-MISSING 포함), OLD-CALL, DIRECT-PATH, WAIT-READER, HOOK-FAIL 줄은 있을 수 있다)
//     1  STALE, MISSING, UNANSWERED 나 INVALID-CONFIG 가 있다
//     2  사용법 오류
//
// 옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts).

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { bundleRoot, installLayout, staleBundle, staleLoopBundles } from '../lib/loop-bundle.ts'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from '../lib/args.ts'
import { isObject } from '../core/json.ts'
import { COMMANDS, isGroup, LAUNCHER_MARK, legacyNames, orchWord, resolveLegacy, resolveNew, scriptIn, SCRIPTS_DIR } from '../lib/commands.ts'
import { LEGACY_INBOX_FILTER, readConfigFile } from '../lib/config.ts'
import type { Config } from '../lib/config.ts'
import { fire, unknownHandlers } from '../lib/events.ts'
import { isFile, real, realPath } from '../lib/fs.ts'
import { defaultBase, mainCheckout } from '../lib/git.ts'
import { isRegistered, loopStatus, readLoop, recheckMs } from '../lib/loop.ts'
import { orchDir, pathOf } from '../lib/paths.ts'
import { isOpen as feedbackOpen, scan as scanFeedback } from '../lib/feedback.ts'
import { isOpen, scan as scanStudy } from '../lib/study.ts'
import { run, withRun } from '../lib/proc.ts'
import type { Runner } from '../lib/proc.ts'
import { shQuote } from '../lib/py.ts'
import { ageSeconds, closedReason, snapshot } from '../lib/questions.ts'
import { waiterPids as findWaiters } from '../lib/waiters.ts'
import { missingRowKeys, workerRows } from '../lib/workers.ts'
import { orcaJson } from '../lib/orca.ts'
import { adoptHint } from '../lib/sessions.ts'
import { isLive, judge, readScreens, screenHandles } from '../lib/worker-state.ts'
import { emit } from '../lib/output.ts'

const USAGE =
  '사용법: orch-doctor.ts [--skill-dir DIR] [--remote URL] [--branch main] [--skip-version] [--run ID] [--skip-questions] [--repo DIR]'
const SHA = /^[0-9a-f]{7,40}$/
const REF = /(?:\$(?:(?<sibling>[A-Z][A-Z0-9_]*)_)?SKILL_DIR\/|\]\((?<up>(?:\.\.\/)*))scripts\/(?<name>[A-Za-z0-9_.-]+)/g
// 진입점(bin/orch.ts)이 부르는 스크립트. `"$SKILL_DIR/bin/orch.ts" wait-important --run ...` 의 이름을 명령 표가 scripts/<묶음>/ 의 .ts 로 푼다
const BIN_REF = /\$SKILL_DIR\/bin\/(?<name>[A-Za-z0-9_.-]+)/g
const VIA_ENTRY = /\$SKILL_DIR\/bin\/orch\.ts"?\s+(?<name>[A-Za-z0-9_][A-Za-z0-9_-]*)/g
const GIT_TIMEOUT_MS = 20_000
const OVERDUE_SEC = 600
const WORKERS_TIMEOUT_MS = 30_000
const SHAPE_TIMEOUT_MS = 10_000

type Checked = { lines: string[]; code: number }

function git(args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): { code: number; out: string } {
  // ls-remote 가 ssh 나 인증을 표준 입력으로 물으면 스킬을 열 때 멈춘다. 입력을 막고 시간을 제한한다
  const env = {
    ...opts.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
  }
  const done = run(['git', ...args], { cwd: opts.cwd, env, input: '', timeoutMs: GIT_TIMEOUT_MS })
  return { code: done.code, out: done.stdout.trim() }
}

// 디렉터리 내용의 git tree hash. 임시 저장소에 쓰므로 원본과 clone 을 건드리지 않는다.
function treeHash(directory: string, excludes: string): string | null {
  const tmp = mkdtempSync(join(tmpdir(), 'orch-doctor-'))
  try {
    const env = { GIT_DIR: join(tmp, 'git'), GIT_INDEX_FILE: join(tmp, 'index'), GIT_WORK_TREE: directory }
    git(['init', '-q'], { env })
    const config = isFile(excludes) ? ['-c', `core.excludesFile=${excludes}`] : []
    if (git([...config, 'add', '-A', '.'], { env, cwd: directory }).code !== 0) return null
    const written = git(['write-tree'], { env })
    return written.code === 0 ? written.out : null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function marketplaceClone(plugins: string, marketplace: string): string | null {
  let location: unknown
  try {
    const known = JSON.parse(readFileSync(join(plugins, 'known_marketplaces.json'), 'utf8')) as Record<string, { installLocation?: unknown }>
    location = known[marketplace].installLocation
  } catch {
    return null
  }
  if (typeof location !== 'string') return null
  try {
    statSync(join(location, '.git'))
    return location
  } catch {
    return null
  }
}

function checkVersion(skillDir: string, remote: string | undefined, branch: string, configDir: string): Checked {
  const layout = installLayout(skillDir, true)
  if (!layout) return { lines: [`SKIP-VERSION 설치 캐시가 아니다: ${skillDir}`], code: 0 }
  const [plugins, marketplace, plugin, folder] = layout
  let installed = folder
  if (!SHA.test(folder)) {
    let entries: unknown
    try {
      entries = (JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> }).plugins?.[
        `${plugin}@${marketplace}`
      ]
    } catch {
      return { lines: [`SKIP-VERSION 버전 설치 기록을 읽지 못했다: ${plugin}@${marketplace}`], code: 0 }
    }
    if (!Array.isArray(entries)) {
      return { lines: [`SKIP-VERSION 설치 기록에서 ${plugin}@${marketplace} 항목을 찾지 못했다`], code: 0 }
    }
    const bundle = real(bundleRoot(skillDir))
    const matching = (entries as { installPath?: unknown; gitCommitSha?: unknown }[]).filter(
      (entry) => typeof entry?.installPath === 'string' && real(entry.installPath) === bundle,
    )
    if (matching.length === 0) {
      return { lines: [`SKIP-VERSION 설치 기록에서 현재 설치 경로를 찾지 못했다: ${bundle}`], code: 0 }
    }
    const sha = matching.find((entry) => typeof entry.gitCommitSha === 'string' && SHA.test(entry.gitCommitSha))?.gitCommitSha
    if (typeof sha !== 'string') {
      return { lines: [`SKIP-VERSION 현재 설치 경로의 gitCommitSha 가 없거나 SHA 형식이 아니다: ${bundle}`], code: 0 }
    }
    // SHA 폴더 이름과 같은 출력 형식을 유지한다.
    installed = sha.slice(0, 12)
  }
  const clone = marketplaceClone(plugins, marketplace)
  let found: { code: number; out: string }
  if (remote) found = git(['ls-remote', remote, `refs/heads/${branch}`])
  else if (clone) found = git(['-C', clone, 'ls-remote', 'origin', `refs/heads/${branch}`])
  else return { lines: [`SKIP-VERSION 마켓플레이스 clone 을 찾지 못했다: ${marketplace}`], code: 0 }
  const latest = found.code === 0 && found.out ? found.out.split(/\s+/)[0] : ''
  if (!latest) return { lines: [`SKIP-VERSION 원본 ${branch} 의 커밋을 읽지 못했다(오프라인이면 그대로 진행한다)`], code: 0 }
  if (latest.startsWith(installed) || installed.startsWith(latest)) return { lines: [`OK-VERSION ${installed}`], code: 0 }
  if (clone) {
    const name = basename(skillDir)
    const candidates = new Set([relative(bundleRoot(skillDir), skillDir), `skills/${name}`, `export-only-skills/${name}`, name])
    const current = treeHash(skillDir, join(clone, '.gitignore'))
    for (const path of candidates) {
      const upstream = git(['-C', clone, 'rev-parse', '--verify', '-q', `${latest}:${path}`])
      if (upstream.code === 0 && upstream.out === current) return { lines: [`OK-VERSION ${installed}`], code: 0 }
    }
  }
  return {
    lines: [
      `STALE ${installed} ${latest.slice(0, 12)}`,
      `  claude plugin marketplace update ${marketplace}`,
      `  claude plugin update ${plugin}@${marketplace}`,
    ],
    code: 1,
  }
}

// skillDir 아래의 .md. tests 폴더 안은 뺀다. 링크된 폴더는 따라가지 않는다. 경로 마디 차례로 정렬한다.
function markdownFiles(skillDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md') && isFile(full)) found.push(full)
    }
  }
  walk(skillDir)
  const parts = (file: string) => relative(skillDir, file).split(sep)
  return found
    .filter((file) => !parts(file).slice(0, -1).includes('tests'))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)]
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
      }
      return x.length - y.length
    })
}

function exists(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch {
    return false
  }
}

export function checkScripts(skillDir: string): Checked {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const doc of markdownFiles(skillDir)) {
    const rows = readFileSync(doc, 'utf8').split(/\r\n|\r|\n/)
    lines.push(...newFormMissing(doc, rows, skillDir, seen))
    rows.forEach((text, index) => {
      const entry = [
        ...[...text.matchAll(BIN_REF)].map((m) => ['bin', `bin/${m.groups?.name}`] as const),
        // 옛 꼴 이름은 명령 표가 묶음 폴더 아래 파일로 푼다. 표에 없는 이름은 scripts 바로 아래 같은 이름이다
        ...[...text.matchAll(VIA_ENTRY)].map((m) => ['scripts', relative(skillDir, scriptIn(join(skillDir, 'scripts'), m.groups?.name ?? '') ?? join(skillDir, 'scripts', `${m.groups?.name}.ts`))] as const),
      ]
      for (const [, shown] of entry) {
        const target = join(skillDir, shown)
        seen.add(target)
        if (!exists(target)) lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
      }
      for (const m of text.matchAll(REF)) {
        const { sibling, up, name } = m.groups as { sibling?: string; up?: string; name: string }
        let target: string
        if (sibling) target = join(dirname(skillDir), (sibling === 'PLANNING' ? 'plan' : sibling.toLowerCase().replaceAll('_', '-')), 'scripts', name)
        else if (up === undefined) target = join(skillDir, 'scripts', name)
        else target = realPath(resolve(dirname(doc), up, 'scripts', name))
        seen.add(target)
        if (!exists(target)) {
          const shown = sibling ? relative(dirname(skillDir), target) : `scripts/${name}`
          lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
        }
      }
    })
  }
  if (lines.length === 0) lines.push(`OK-SCRIPTS ${seen.size}`)
  return { lines, code: lines.some((line) => line.startsWith('MISSING')) ? 1 : 0 }
}

// 머리 주석의 「설치 기록 판정」. 없는 installPath 마다 줄을 내고, 하나라도 있으면 고치는 방법을 한 번 안내한다.
function checkInstallPaths(configDir: string): string[] {
  let plugins: unknown
  try {
    plugins = (JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: unknown }).plugins
  } catch {
    return []
  }
  if (typeof plugins !== 'object' || plugins === null) return []
  const lines: string[] = []
  for (const [name, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries as { installPath?: unknown; scope?: unknown }[]) {
      const path = entry?.installPath
      if (typeof path !== 'string' || !path || exists(path)) continue
      lines.push(`PLUGIN-PATH-MISSING ${name} ${typeof entry.scope === 'string' ? entry.scope : '-'} ${path}`)
      const tail = path.split(`${sep}plugins${sep}`).slice(1).join(`${sep}plugins${sep}`)
      const moved = tail ? join(configDir, 'plugins', tail) : ''
      if (moved && exists(moved)) lines.push(`  현재 설정 폴더에 같은 경로가 있다: ${moved}`)
    }
  }
  if (lines.length > 0) {
    lines.push(
      '  이 플러그인들은 실리지 않아 스킬과 슬래시 명령이 빠진다. 아래는 사용자가 한다(doctor 는 설치 기록을 고치지 않는다)',
      `  고치기: ${join(configDir, 'plugins', 'installed_plugins.json')} 을 백업한 뒤 installPath 를 위의 현재 설정 폴더 경로로 고치거나, 플러그인을 다시 설치한다(claude plugin install <플러그인>@<마켓플레이스>)`,
      '  반영: /reload-plugins',
    )
  }
  return lines
}

// 설정 검사표(core/config-schema.ts)를 불러온다. zod 를 쓰는 유일한 모듈이라 의존 설치가 실패한 머신에서는 못 불러온다.
// 그때도 나머지 doctor 검사는 돌아야 하므로 정적으로 import 하지 않고 이유를 돌려준다.
// ORCH_CONFIG_SCHEMA 는 테스트 전용이다. 검사표 모듈 대신 그 경로의 파일을 불러와 불러오기 실패를 흉내 낸다.
type Schema = typeof import('../core/config-schema.ts')

async function loadSchema(): Promise<{ schema: Schema | null; problem: string | null }> {
  const target = process.env.ORCH_CONFIG_SCHEMA ? pathToFileURL(resolve(process.env.ORCH_CONFIG_SCHEMA)).href : new URL('../core/config-schema.ts', import.meta.url).href
  try {
    return { schema: (await import(target)) as Schema, problem: null }
  } catch (e) {
    const why = String((e as Error)?.message ?? e).split('\n')[0]
    return { schema: null, problem: `의존을 읽지 못했다(${why}). 플러그인을 다시 설치하거나 플러그인 폴더에서 npm ci 를 돈다` }
  }
}

function checkRepo(repo: string, schema: Schema | null): string[] {
  const lines = unknownHandlers(repo).map((file) => `UNKNOWN-HOOK ${file}`)
  const read = readConfigFile(repo)
  if (schema) {
    // 깨진 JSON, 모르는 절과 키, 틀린 값, 짝 규칙 위반, 옛 칸이 모두 INVALID-CONFIG 다(종료 코드 1). 검사표를 못 불러왔으면 건너뛴다
    if (read.error !== undefined) lines.push(`INVALID-CONFIG config.json ${read.error}`)
    else if (read.exists) {
      const migrate = `${orchWord()} doctor migrate-hooks --repo ${shQuote(repo)} --apply`
      for (const problem of schema.problems(read.value)) {
        const reason = problem.kind === 'removed' ? problem.reason.replace('orch doctor migrate-hooks --apply', migrate) : problem.reason
        lines.push(`INVALID-CONFIG ${problem.path} ${reason.replace(/\s*\n\s*/g, ' ')}`)
      }
    }
  }
  const config = (isObject(read.value) ? read.value : {}) as Config
  lines.push(...legacyInboxFilter(repo, config))
  return lines
}

// 옛 알림 필터 파일이 있으면 옮기는 법을 알린다. 옛 파일은 아직 읽히므로 종료 코드에는 영향이 없다
function legacyInboxFilter(repo: string, config: Config): string[] {
  const legacy = join(orchDir(repo), LEGACY_INBOX_FILTER)
  if (!existsSync(legacy)) return []
  const target = pathOf('config', repo)
  if (config.inbox) return [`OLD-INBOX-FILTER ${legacy} 는 ${target} 의 inbox 절이 있어 읽히지 않는다. 지운다`]
  return [`OLD-INBOX-FILTER ${legacy} 의 내용을 ${target} 의 "inbox" 절로 옮긴다(옮긴 뒤 옛 파일을 지운다). 새 번들을 설치한 뒤에만 옮긴다. 옛 파일 읽기는 inbox 의 다음 major 에 없어진다`]
}

function checkFeedback(repo: string): string[] {
  const dir = pathOf('feedback', repo)
  const found = scanFeedback(dir)
  if (found.legacy.length) process.stderr.write(`orch-doctor: 옛 개선 후보 메모 ${found.legacy.length}개는 feedback migrate 로 미리 본다: ${dir}\n`)
  const count = found.candidates.filter(feedbackOpen).length + found.legacy.length
  return count > 0 ? [`FEEDBACK-OPEN ${count} ${dir}`] : []
}

function checkStudy(repo: string): string[] {
  const dir = pathOf('study', repo)
  const found = scanStudy(dir)
  if (found.legacy) process.stderr.write(`orch-doctor: 옛 공부 후보 표 파일이 남아 있다. ${orchWord()} study migrate 로 옮긴다: ${found.legacy}\n`)
  for (const file of found.broken) process.stderr.write(`orch-doctor: 공부 후보 파일의 머리를 읽지 못했다: ${file}\n`)
  const count = found.candidates.filter(isOpen).length
  return count > 0 ? [`STUDY-OPEN ${count} ${dir}`] : []
}

function checkQuestions(runId: string | null, repo: string): Checked & { pending: string[] } {
  let found
  try {
    found = snapshot(runId)
  } catch (e) {
    const reason = String((e as Error)?.message ?? e).replace(/\r?\n|\r/g, ' ')
    return { lines: [`SKIP-QUESTIONS ${reason}`], code: 0, pending: [] }
  }
  // 조회를 마친 뒤의 시각으로 잰다. 조회가 오래 걸려도 그만큼 질문이 덜 늦은 것으로 보이지 않게 한다
  const now = Date.now() / 1000
  const lookup = {}
  found.pending = found.pending.filter((m) => !closedReason(m, found.run, repo, lookup))
  const overdue = found.pending.filter((m) => ageSeconds(m, now) >= OVERDUE_SEC)
  return {
    lines: overdue.map((m) => `UNANSWERED ${String(m.id)} 10분 이상 답이 없다 (Run ${found.run})`),
    code: overdue.length > 0 ? 1 : 0,
    pending: found.pending.map((m) => String(m.id)),
  }
}

// 이 Run 의 살아 있는 대기와 질문 감시 pid(lib/waiters.ts). ps 를 읽지 못하면 stderr 에 알리고 빈 목록이다.
function waiterPids(runId: string): number[] {
  const found = findWaiters(runId)
  if (found.ok) return found.pids
  process.stderr.write(`orch-doctor: ${found.error}\n`)
  return []
}

function staleLoops(configDir: string): string[] {
  const lines: string[] = []
  for (const { pid, repo, sha } of staleLoopBundles(configDir)) {
    const state = repo === '<repo>' ? null : readLoop(repo)
    const named = typeof state?.bound_run === 'string' && state.bound_run ? state.bound_run : state?.run
    const runId = typeof named === 'string' && named ? named : '<Run>'
    lines.push(
      `LOOP-STALE ${repo} ${pid} ${sha}`,
      `  안내: 이 루프는 설치되지 않은 번들(${sha})로 돈다. 아래 두 명령은 그 루프의 Run(${runId}) 코디네이터 세션에서 돌린다. ` +
        '다른 세션에서 띄우면 새 루프가 그 세션의 Run 명의를 물려받아 원래 Run 의 질문을 읽지 못한다',
      `  ${orchWord()} loop stop --repo ${shQuote(repo)} --all`,
      `  ${orchWord()} loop start --repo ${shQuote(repo)} --run ${shQuote(runId)}`,
    )
  }
  return lines
}

// 머리 주석의 「Orca 형식 판정」. 읽지 못했거나 행이 없으면 빈 목록이다
function checkOrcaShape(): string[] {
  const got = orcaJson<{ workers?: unknown }>(['orchestration', 'worker-list', '--limit', '1'], { timeoutMs: SHAPE_TIMEOUT_MS })
  if (!got.ok || !Array.isArray(got.data?.workers)) return []
  const row = got.data.workers[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
  const missing = missingRowKeys(row as Record<string, unknown>)
  if (missing.length === 0) return []
  return [
    `ORCA-SHAPE worker-list ${missing.join(',')}`,
    '  안내: Orca 출력 형식이 바뀌어 orch 가 읽는 키가 없다. worker 판정, 정리, 질문 감시가 빈 값으로 엇나갈 수 있다. orch 를 갱신하고, 최신에도 나오면 사용자에게 알린다',
  ]
}

// 머리 주석의 「worker 판정」. 살아 있는 dispatch 가운데 터미널이 user_owned 로 표시된 것만 판정해 낸다
function checkWorkers(runId: string, repo: string): string[] {
  const got = workerRows(runId, { timeoutMs: WORKERS_TIMEOUT_MS })
  if (!got.ok) return [`SKIP-WORKERS ${got.error}`]
  const lines: string[] = []
  let disconnected = false
  for (const row of got.rows) {
    if (row.dispatchStatus === 'failed' || ['failed', 'stopped', 'abandoned'].includes(String(row.workerState))) disconnected = true
    const resource = row.resource as Record<string, unknown> | undefined
    if (!isLive(row) || resource?.ownershipState !== 'user_owned') continue
    const verdict = judge({ rows: [row], screens: readScreens(screenHandles([row])) })
    lines.push(`WORKER-STATE ${String(row.dispatchId ?? '?')} ${verdict.state} ${verdict.reason}`)
    if (verdict.state !== 'working') disconnected = true
  }
  if (disconnected) lines.push(adoptHint(repo))
  return lines
}

// 머리 주석의 「orch 명령 판정」. Claude 세션의 Bash 는 플러그인 bin/ 이 PATH 에 있어 사람 셸의 PATH 를 볼 수 없다.
// 그래서 ~/.local/bin/orch 사본이 있는지, 지금 실행기와 같은지, 플러그인 bin/ 을 뺀 PATH 에 그 폴더가 있는지를 본다
function checkCli(skillDir: string): string[] {
  const launcher = join(bundleRoot(skillDir), 'bin', 'orch')
  if (!isFile(launcher)) return []
  const file = join(homedir(), '.local', 'bin', 'orch')
  const fix = `  고칠 명령: ${orchWord()} doctor install-cli`
  let body = ''
  try {
    body = readFileSync(file, 'utf8')
  } catch {
    // 없거나 읽지 못하면 깔리지 않은 것이다
  }
  if (!body.slice(0, 400).includes(LAUNCHER_MARK)) return [`CLI-MISSING ${file}`, fix]
  const lines: string[] = []
  if (body !== readFileSync(launcher, 'utf8')) lines.push(`CLI-STALE ${file}`, fix)
  const pluginBin = real(dirname(launcher))
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && real(dir) !== pluginBin)
  if (!dirs.some((dir) => real(dir) === real(dirname(file)))) {
    lines.push(`CLI-NOT-ON-PATH ${dirname(file)}`, `  셸 설정(비대화형 셸도 읽는 ~/.zshenv 같은 것)에 export PATH="${dirname(file)}:$PATH" 를 더한다`)
  }
  return lines
}

// 머리 주석의 「대기 번들 판정」. 루프 번들 판정과 같은 규칙을 wait-important 프로세스에 쓴다
function staleWaiters(configDir: string): string[] {
  const done = run([process.env.PS || 'ps', '-axo', 'pid=,command='], { env: { LC_ALL: 'C' } })
  if (done.code !== 0) return []
  const lines: string[] = []
  for (const row of done.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(row)
    if (!m || /\borchestration\s+check\b/.test(m[3])) continue
    const found = /(?:^|\s)(\/.*?wait-important\.ts)(?=\s|$)/.exec(m[3])
    if (!found) continue
    const stale = staleBundle(found[1], configDir)
    if (!stale) continue
    lines.push(
      `WAIT-STALE ${m[1]} ${stale.sha}`,
      `  안내: 이 대기는 설치되지 않은 번들(${stale.sha})로 돈다. 그 대기의 코디네이터 세션에서 끝내고(kill ${m[1]}) Orca 메시지로 이어받는다`,
    )
  }
  return lines
}

// 머리 주석의 「옛 꼴과 직접 경로 판정」이 보는 파일. 저장소 루트 기준 상대경로와 절대경로다. __pycache__ 폴더와 *.pyc 는 건너뛴다
function callFiles(repo: string): string[] {
  const root = mainCheckout(repo)
  const orch = orchDir(root)
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // __pycache__ 와 *.pyc 는 파이썬이 만든 옛 바이트코드라 소스에 없는 호출이 남아 있다. 보지 않는다
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue
      if (entry.isDirectory() && depth > 0 && entry.name !== 'node_modules') walk(full, depth - 1)
      else if (entry.isFile()) files.push(full)
    }
  }
  for (const name of ['overlay.md', 'config.json', join('specs', 'spec-common.md')]) {
    if (isFile(join(orch, name))) files.push(join(orch, name))
  }
  walk(join(orch, 'bin'), 0)
  walk(join(orch, 'hooks'), 0)
  walk(join(root, '.claude', 'skills'), 6)
  return files
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 옛 이름과 스크립트 파일 이름. 긴 이름부터 맞춘다(merge_queue 와 merge-with-finish, orch-doctor 와 orch)
const LEGACY = [...legacyNames(), 'orch-doctor'].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => b.length - a.length)
const SCRIPTS = [...new Set(COMMANDS.map((c) => basename(c.script, '.ts')))].sort((a, b) => b.length - a.length)
// 스크립트 폴더 아래의 묶음 폴더. 지금 배치(`scripts/<묶음>/<파일>.ts`)의 직접 경로도 직접 경로 호출이다
const FOLDERS = [...new Set(COMMANDS.map((c) => dirname(c.script)))].map(escapeRe).join('|')
const OLD_CALL = new RegExp(
  `(?:orch\\.m?ts['"]?|"\\$ORCH"|\\$ORCH|\\$\\{ORCH\\})\\s+(?:--path\\s+)?(${LEGACY.map(escapeRe).join('|')})(?:\\.ts)?(?![\\w-])|(orch-doctor)\\.py`,
)
const DIRECT_PATH = new RegExp(
  `(?:orch/scripts/|\\$SKILL_DIR/scripts/|\\$\\{?ORCH_SCRIPTS\\}?/)(?:(?:${FOLDERS})/)?(${SCRIPTS.map(escapeRe).join('|')})\\.ts|` +
    `join\\(\\s*ORCH_SCRIPTS\\s*,\\s*(?:['"](?:${FOLDERS})['"]\\s*,\\s*)?['"](?:(?:${FOLDERS})/)?(${SCRIPTS.map(escapeRe).join('|')})\\.ts['"]`,
)

function hintFor(name: string, rest: string): string {
  // 경로를 감싼 따옴표와 괄호의 닫는 글자가 남으면 동작 낱말을 읽지 못한다
  const tokens = rest.replace(/^["')]+/, '').split(/\s+/).filter(Boolean)
  const legacy = resolveLegacy(name, tokens) ?? resolveLegacy(name, [])
  const row = legacy?.command ?? COMMANDS.find((c) => basename(c.script) === `${name}.ts`)
  return row ? `  새 꼴: ${legacy?.hint ?? ['orch', row.group, ...(row.verb ? [row.verb] : [])].join(' ')}` : ''
}

const WAIT_READER_FIX = '  고칠 것: orch wait 은 없어졌다. Orca 깨움으로 바꾸고 references/waiting.md 를 읽는다'

function checkCalls(repo: string): string[] {
  const root = mainCheckout(repo)
  const lines: string[] = []
  for (const file of callFiles(root)) {
    const script = !/\.(?:md|json)$/i.test(file)
    let rows: string[]
    try {
      rows = readFileSync(file, 'utf8').split(/\r\n|\r|\n/)
    } catch {
      continue
    }
    rows.forEach((text, i) => {
      if (text.includes('orch-compat') || (i > 0 && rows[i - 1].includes('orch-compat'))) return
      const where = `${relative(root, file)}:${i + 1}`
      const old = OLD_CALL.exec(text)
      if (old) {
        const name = old[1] ?? old[2]
        lines.push(`OLD-CALL ${where} ${name}`)
        const hint = hintFor(name, text.slice(old.index + old[0].length))
        if (hint) lines.push(hint)
        return
      }
      const direct = DIRECT_PATH.exec(text)
      if (direct) {
        const name = direct[1] ?? direct[2]
        lines.push(`DIRECT-PATH ${where} ${name}.ts`)
        const hint = hintFor(name, text.slice(direct.index + direct[0].length))
        if (hint) lines.push(hint)
        return
      }
      if (script && text.includes('LAST_DELIVERY')) lines.push(`WAIT-READER ${where}`, WAIT_READER_FIX)
    })
  }
  return lines
}

// 문서의 새 꼴 호출. 백틱 안이나 코드 블록 안에서 `orch ` 뒤에 ASCII 소문자 낱말이 오는 것만 명령으로 본다
const NEW_FORM = /(?:^|[\s(;|&{"'`$])orch\s+([a-z][a-z0-9-]*(?:\s+[^\s`;|&)]+)*)/g

function codeParts(rows: string[]): { index: number; text: string }[] {
  const parts: { index: number; text: string }[] = []
  let fenced = false
  rows.forEach((row, index) => {
    if (/^\s*(```|~~~)/.test(row)) {
      fenced = !fenced
      return
    }
    if (fenced) parts.push({ index, text: row })
    else for (const m of row.matchAll(/`([^`]+)`/g)) parts.push({ index, text: m[1] })
  })
  return parts
}

function newFormMissing(doc: string, rows: string[], skillDir: string, seen: Set<string>): string[] {
  const lines: string[] = []
  for (const { index, text } of codeParts(rows)) {
    if (text.includes('orch-compat') || (index > 0 && rows[index - 1].includes('orch-compat'))) continue
    for (const m of text.matchAll(NEW_FORM)) {
      const tokens = m[1].split(/\s+/)
      const shown = `orch ${tokens.slice(0, 2).join(' ')}`
      if (!isGroup(tokens[0])) {
        lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
        continue
      }
      const resolved = resolveNew(tokens)
      if ('error' in resolved) {
        lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
        continue
      }
      const target = join(SCRIPTS_DIR, resolved.command.script)
      seen.add(target)
      if (!exists(target)) lines.push(`MISSING ${relative(skillDir, doc)}:${index + 1} ${shown}`)
    }
  }
  return lines
}

export function main(argv: string[], runner?: Runner): Promise<number> {
  return runner ? withRun(runner, () => executeMain(argv)) : executeMain(argv)
}

async function executeMain(argv: string[]): Promise<number> {
  let values
  try {
    const options = {
      'skill-dir': { type: 'string' },
      remote: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      'skip-version': { type: 'boolean', default: false },
      run: { type: 'string' },
      'skip-questions': { type: 'boolean', default: false },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } as const
    values = parseArgs({ args: expandArgs(argv, options), options }).values
  } catch (e) {
    process.stderr.write(`${USAGE}\norch-doctor: ${(e as Error).message}\n`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const skillDir = real(values['skill-dir'] ?? fileURLToPath(new URL('../..', import.meta.url)))
  if (!isFile(join(skillDir, 'SKILL.md'))) {
    process.stderr.write(`orch-doctor: SKILL.md 가 없다: ${skillDir}\n`)
    return 2
  }
  const repo = mainCheckout(values.repo ?? process.cwd())
  const runId = values.run ?? null

  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const version = values['skip-version'] ? { lines: [], code: 0 } : checkVersion(skillDir, values.remote, values.branch as string, configDir)
  const scripts = checkScripts(skillDir)
  const installLines = checkInstallPaths(configDir)
  const { schema, problem: schemaProblem } = await loadSchema()
  const repoLines = [...(schemaProblem ? [`CLI-DEPS-MISSING ${schemaProblem}`] : []), ...checkRepo(repo, schema), ...checkFeedback(repo), ...checkStudy(repo), ...checkCalls(repo)]
  const hookDir = join(pathOf('hooks', repo))
  if (existsSync(hookDir)) {
    for (const name of readdirSync(hookDir)) {
      const file = join(hookDir, name)
      if (isFile(file) && /(?:worker[\s'",]+nudge|nudge-worker)/.test(readFileSync(file, 'utf8'))) repoLines.push(`NUDGE-HANDLER ${file}: orch worker send 로 바꾼다`)
    }
  }
  if (runId) for (const pid of waiterPids(runId)) repoLines.push(`WAITER-LEFT ${pid}: 옛 대기를 직접 종료한다: kill ${pid}`)
  const questions = values['skip-questions'] ? { lines: [], code: 0, pending: [] } : checkQuestions(runId, repo)
  let loop = runId ? loopStatus(repo, Date.now()) : null
  if (loop && !loop.alive && loop.recheck) {
    await sleep(recheckMs())
    loop = loopStatus(repo, Date.now())
  }
  // 살아 있어도 이 Run 이 등록되지 않았으면 이 Run 에는 루프가 없다(머리 주석의 loop_alive)
  const unregistered = loop?.alive === true && Array.isArray(loop.state.runs) && !isRegistered(repo, runId as string)
  const loopLines =
    loop && (!loop.alive || unregistered)
      ? [
          loop.alive ? `LOOP-DEAD ${repo} run ${runId} 미등록` : `LOOP-DEAD ${repo} ${loop.reason}`,
          `  ${orchWord()} loop start --repo ${shQuote(repo)} --run ${shQuote(runId as string)}`,
        ]
      : []
  const workerLines = runId ? checkWorkers(runId, repo) : []
  const shapeLines = checkOrcaShape()
  // 짧은 출력(진입점의 orch doctor)은 판정 줄과 들여 쓴 고칠 줄만 낸다. `  안내:` 줄은 --full 이다(lib/output.ts 의 emit)
  emit(`${[...version.lines, ...scripts.lines, ...installLines, ...checkCli(skillDir), ...repoLines, ...questions.lines, ...loopLines, ...staleLoops(configDir), ...staleWaiters(configDir), ...workerLines, ...shapeLines].join('\n')}`, [], { fix: true })

  if (runId) {
    try {
      await fire(
        'session-resume',
        { loop_alive: (loop?.alive ?? false) && !unregistered, waiters: waiterPids(runId), unanswered: questions.pending },
        { repo, base: defaultBase(repo) ?? '', run: runId },
      )
    } catch (e) {
      // 진단 줄은 이미 냈다. 이벤트 실행기의 오류(설정 파일 오류 포함)로 진단 결과의 종료 코드를 바꾸지 않는다
      process.stderr.write(`orch-doctor: session-resume 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    }
  }
  return Math.max(version.code, scripts.code, questions.code, repoLines.some((line) => line.startsWith('INVALID-CONFIG')) ? 1 : 0)
}

export function reportError(e: unknown): void {
  process.stderr.write(`orch-doctor: ${(e as Error)?.stack ?? String(e)}\n`)
  process.exitCode = 1
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    reportError,
  )
}
