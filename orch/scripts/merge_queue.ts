// 사용: merge_queue.ts [옵션] PR[:머지 전 명령] ...
//
// 받은 순서대로 PR 을 하나씩 머지한다. 한 PR 이라도 조건에 못 미치면 이유를 찍고 종료 코드 1 로 멈춘다.
// base 와 충돌하는 PR 은 멈추지 않고 큐에서 빼고 다음 PR 로 간다(아래 「충돌」). 묶음(--chain) 안에서는 앞 PR 이 빠지면 뒤 PR 도 뺀다.
// PR 마다 하는 일:
//   1. 이미 MERGED 면 건너뛴다. OPEN 이 아니면 멈춘다
//   2. 필수 체크가 모두 나타나고 끝날 때까지 기다린다(--check-timeout 분까지. 진행 중인 체크 없이 필수 체크가 --missing-timeout 분 동안 나타나지 않으면 먼저 멈춘다).
//      PR 을 연 직후에는 체크 목록이 비어 있어 「대기 0」이 「모두 끝남」이 아니기 때문이다
//      --require-up-to-date 이면 PR 이 base 최신을 품는지 보고, 아니면 base 를 merge 한 뒤 2 를 다시 한다
//      (--up-to-date-when overlap 이면 base 최신을 품지 않아도 단위가 겹치지 않으면 merge 없이 3 으로 간다)
//   3. 실패한 체크, 미해결 리뷰 스레드가 있으면 멈춘다. 충돌(mergeable 이 CONFLICTING)이면 큐에서 뺀다.
//      mergeable 이 UNKNOWN 이면 몇 번 다시 묻는다
//      --allow-fail 로 준 체크의 실패는 세지 않고 경고 줄만 찍는다
//   3-1. --stop-on-overlap 이나 --verify-merged 를 주면, PR 이 바꾼 파일과 PR 이 갈라진 뒤 base 에서 바뀐 파일이
//      겹치는지 본다. 겹치면 --stop-on-overlap 은 겹친 파일을 찍고 멈추고, --verify-merged 는 base 와 합친
//      임시 사본에서 그 명령을 돌려 0 일 때만 이어 간다. 체크는 PR 기준으로 돌아 같은 파일을 고친 base 와 합친
//      상태는 아무도 검사하지 않았기 때문이다. 겹치지 않으면 그대로 이어 간다.
//      --verify-merged-when 으로 겹치지 않아도 검사하게 하고, --docs-glob 에 맞는 문서 PR 은 검사 없이 머지한다
//   4. before-merge 이벤트를 내고, 그 PR 에 붙인 `PR:명령` 이 있으면 그 뒤에 돌린다. 거부나 실패면 멈춘다(DB 백업 같은 것).
//      같은 HEAD 에는 한 번만 돈다. base 가 움직여 다시 판정해도 HEAD 가 같으면 다시 내지 않는다
//   5. 체크를 보기 전에 읽어 둔 HEAD 와 지금 PR HEAD, 원격 브랜치 HEAD 가 모두 같은지 본다.
//      검사나 머지 전 명령이 도는 사이에 push 된 커밋이 검사 없이 머지되는 것을 막는다
//   6. 처음 읽은 HEAD 로 --match-head-commit 머지하고 MERGED 를 확인한 뒤 원격을 fetch 하고 원격 브랜치를 지운다.
//      fork PR, release/* 브랜치, --keep-branch 면 지우지 않는다. 그 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면
//      (작성자 목록은 lib/gh.ts 의 ownAuthors) 각각 `gh pr edit <n> --base <머지한 PR 의 base>` 로 옮긴 뒤 지운다.
//      다른 사람의 PR 이 하나라도 있거나, 조회나 옮기기가 하나라도 실패하면 지우지 않는다
//   7. after-merge 이벤트를 낸다. 실패하면 HOOK-FAIL 줄만 남기고 다음 PR 로 간다
//
// 이벤트: <orch 루트>/hooks/<이벤트>.ts 핸들러를 lib/events.ts 의 fire 로 부른다. 입력 필드는 lib/events.ts 머리 주석의 「이벤트별 필드」 다.
//   before-merge   4 의 자리. 거부면 `STOP <PR> HOOK-REJECT`, 실패와 시간 초과면 `STOP <PR> HOOK-FAIL`
//   verify-merged  합친 사본 검사의 자리. 작업 디렉터리는 사본이다. 거부, 실패, 시간 초과는 검사 실패와 같은 STOP 이다.
//                  hooks/verify-merged.ts 가 있으면 --verify-merged 를 준 것과 같이 겹침 판정을 켠다
//   after-merge    7 의 자리
//   after-queue    --after-merged 의 자리. 실패와 시간 초과면 HOOK-FAIL 줄에 더해 `AFTER-MERGED-FAILED <종료 코드|timeout>` 이다
//   --before, --verify-merged, --after-merged 는 옛 칸이라 그 이벤트의 핸들러처럼 돌고 `DEPRECATED <옵션> → hooks/<이벤트>.ts` 줄을 낸다.
//   시간 제한도 핸들러와 같다(기본값은 lib/events.ts 의 EVENTS, config.json 의 hooks.timeouts.<이벤트> 가 덮는다).
//   옛 칸의 작업 디렉터리는 --repo 로 준 경로다(--verify-merged 는 사본). 옛 명령과 같아, 연결된 워크트리를 --repo 로 주면
//   상대경로 명령이 그 워크트리에서 돈다. 핸들러의 작업 디렉터리는 주 checkout 이다(lib/events.ts 머리 주석).
//   같은 이벤트의 핸들러 파일과 옛 칸이 함께 있으면 큐를 시작하기 전에 사용법 오류로 끝난다. config.json 이 깨졌거나
//   pipeline.authors 의 타입이 틀리거나, 큐가 낼 이벤트의 hooks.timeouts 값이 틀려도 첫 머지 전에 사용법 오류로 끝난다.
//   큐 도중에 설정 오류가 나면(핸들러 파일을 그 사이에 더했다 같은 것) 그 자리에서 멈추고 종료 코드 2 다.
//   이번 실행에서 머지한 PR 이 있으면 그 전에 after-queue(--after-merged 포함)만 돌리고 정리(cleanup-sweep)는 부르지 않는다.
//   보류로 멈출 때, 큐 끝의 after-queue 가 설정 오류를 낼 때와 같은 규칙이다
//
// 충돌: update-branch 가 충돌로 실패하거나 mergeable 이 CONFLICTING 인 PR 은 `CONFLICT <PR> <이유>` 를 찍고 큐에서 뺀다.
//   --continue-on-hold 가 없어도 다음 PR 로 간다. 충돌한 PR 하나 때문에 머지할 수 있는 뒤 PR 이 함께 멈추지 않게 하기 위해서다.
//   상주 루프의 알림 파일(lib/loop.ts 의 appendEvent)에 `QUEUE-CONFLICT` 를 쓴다. Run 은 --sweep-arg 로 준 --run 이고, 없으면 Run 이 없는 루프의 파일이다.
//   그 PR 의 worker 에게 base 를 합치라고 보내는 일은 상주 루프의 충돌 처리와 notify-conflicts.ts 가 한다(pr-conflict).
//   충돌로 뺀 PR 은 큐 끝에 `QUEUE-CONFLICT 번호...` 로 다시 모으고 `QUEUE-HELD` 에도 든다. 종료 코드는 1 이다.
//   update-branch 의 다른 실패(검사한 HEAD 와 다르다 같은 것)는 지금처럼 멈춘다
// 묶음: `--chain 101,102,103` 은 앞 PR 이 먼저 머지돼야 하는 PR 들이다(마이그레이션 순서 같은 것). 묶음 안 앞 PR 이 머지되지 않고
//   빠지면(충돌, --continue-on-hold 의 보류, 묶음으로 뺌) 뒤 PR 은 `SKIP <PR> 묶음의 앞 PR <번호> 가 머지되지 않았다` 를 찍고 머지하지 않는다.
//   묶음 밖의 PR 은 이어 머지한다. 묶음의 PR 은 큐에 있어야 하고 큐의 순서와 같은 순서로 적는다. PR 하나는 묶음 하나에만 든다
//
// origin 은 PR 이 속한 저장소를 가리켜야 한다. fork 를 origin 으로 둔 체크아웃에서는 HEAD 대조가 STOP 으로 끝난다.
//
// 옵션
//   옵션은 이름을 다 적어 `--옵션 값` 으로 준다. 옛 merge_queue.py 와 같이 고유 접두로 줄여 쓰거나 `--옵션=값` 으로 붙여 쓸 수 없다.
//   값은 `-` 로 시작해도 값으로 읽는다. 빈 값은 사용법 오류다. 값을 받는 옵션 목록은 lib/queue-options.ts 가 소유한다
//   --repo DIR            대상 저장소 경로. 기본은 현재 디렉터리. gh 호스트와 저장소는 이 저장소의 origin 이 정한다
//                         `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 찾지 않고 기본 호스트(보통 github.com)로 간다.
//                         그래서 `gh api` 에는 PR URL 의 호스트(`gh pr` 가 origin 으로 정한 값)를 --hostname 으로 넘긴다.
//                         GH_HOST 환경 변수는 보지 않는다. 전역 GH_HOST 가 다른 호스트를 가리켜도 `gh pr` 와 같은 호스트로 간다
//   --before CMD          모든 PR 에 쓸 머지 전 명령. before-merge 의 옛 칸이다. `PR:명령` 으로 준 PR 에서는 그 명령이 대신한다.
//                         `PR:명령` 은 이벤트가 아니라 시간 제한 없이 bash -c 로 돌고, before-merge 핸들러가 있으면 그 다음에 돈다.
//                         콜론 뒤가 빈 `PR:` 는 그 PR 에서 --before 를 끈다(핸들러는 그대로 돈다)
//   --chain A,B,C         앞 PR 이 먼저 머지돼야 하는 묶음(위 「묶음」). 여러 번 준다
//   --last-of-task PR     그 PR 이 task 의 마지막 PR 이다. before-merge 입력의 last_of_task 가 true 다. 여러 번 준다.
//                         큐에 없는 번호면 사용법 오류다
//   --method M            merge | squash | rebase. 기본 merge
//   --threads-cmd CMD     미해결 스레드 수를 정수로 내는 명령. 기본은 형제 스킬 review-fix 의 review_threads.py
//   --check-timeout MIN   체크 대기 한도(분). 기본 60
//   --missing-timeout MIN 진행 중인 체크가 없는데 필수 체크가 나타나지 않은 채로 이 시간(분)이 지나면 --check-timeout 전에 멈춘다. 기본 5, 0 이면 끈다.
//                         멈출 때 나타나지 않은 이름과 PR 에 붙은 체크 이름을 함께 찍는다. 필수 체크 이름이 틀린 경우(예: 쉼표로 나뉜 이름)를 60분 기다리지 않게 한다.
//                         기본값은 workflow 가 늦게 시작해도 놓치지 않을 만큼 잡았다. push 뒤 체크가 붙기까지 보통 1분 안이고 대기열이 길어도 몇 분이다
//   --required A,B,C      나타나야 하는 필수 체크 이름. 없으면 저장소 규칙(rules/branches/BASE 의
//                         required_status_checks)에서 읽는다. 둘 다 비면 목록이 비었다는 경고를 찍고
//                         지금 있는 체크만 기다린다(예전 동작). 규칙 조회가 실패하면 멈춘다.
//                         예전 방식의 브랜치 보호 규칙은 규칙 조회에 나오지 않으므로 이 옵션으로 준다.
//                         무료 플랜의 비공개 저장소는 규칙 API 가 403(플랜 제한)을 내는데, 이때는 경고를 찍고 목록을 빈 것으로 다룬다.
//                         인증, 네트워크, 404 는 멈춘다
//   --required-check NAME 필수 체크 이름 하나를 쉼표로 나누지 않고 받는다. 여러 번 줄 수 있고 --required 와 함께 쓰면 이어 붙는다.
//                         GitHub Actions 의 job 이름에는 `Lint, Test & Build` 처럼 쉼표가 흔하다.
//                         `--required "Lint, Test & Build"` 는 `Lint` 와 ` Test & Build` 두 이름으로 나뉘어, 생기지 않는 체크를 기다리게 된다
//   --allow-fail A,B      실패해도 멈추지 않을 비필수 체크 이름. 실패한 체크마다 `경고: PR 실패를 허용한 체크 이름` 을
//                         찍고 머지한다. 코드와 무관한 이유(사용량 한도, 외부 장애)로 실패했고 그 대신 할 검증을
//                         끝냈을 때만 쓴다. 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다.
//                         필수 체크(--required 나 저장소 규칙)에 든 이름은 허용할 수 없다
//   --allow-fail-check NAME  --allow-fail 의 이름 하나를 쉼표로 나누지 않고 받는다. 여러 번 줄 수 있다
//   --require-up-to-date  머지 전에 PR 이 base 최신을 품지 않으면 update-branch 로 base 를 merge 하고
//                         필수 체크를 다시 기다린 뒤 머지한다. 기본은 끔. 필수 체크 목록이 있어야 켤 수 있다
//   --up-to-date-when W   --require-up-to-date 가 base 를 merge 하는 때. always(기본, 뒤처졌으면 늘) 또는 overlap.
//                         overlap 은 PR 이 바꾼 단위와 PR 이 갈라진 뒤 base 에 들어온 변경의 단위가 겹치지 않으면
//                         최신화와 CI 재대기 없이 머지한다. 판정은 PR 차례마다 하고 `<PR> 판정: 바로 머지` 나
//                         `<PR> 판정: 갱신 필요(이유)` 한 줄을 찍는다. 판정은 overlap_units.ts 가 소유한다.
//                         단위는 --unit-prefix 아래 폴더 하나이고 그 밖의 파일은 경로 자체다. --shared-paths 에 맞는 파일과
//                         --docs-glob 에 맞는 문서 파일은 각각 겹친 것으로 보거나 세지 않는다.
//                         판정하지 못하면 갱신 필요로 다룬다. --require-up-to-date 가 있어야 한다.
//                         판정은 한 번으로 끝나지 않는다. 갱신하고 CI 를 기다리는 사이나, 바로 머지로 판정한 뒤 머지 직전에
//                         base 가 또 움직이면 다시 판정한다. 갱신을 마친 PR 은 새로 들어온 변경(PR 의 새 merge-base 기준)만 보고,
//                         갱신하지 않은 PR 은 처음 갈라진 뒤 base 의 변경을 모두 다시 본다.
//                         겹치지 않으면 다시 갱신하지 않고 머지하고, 겹칠 때만 또 갱신한다. PR HEAD 는 --match-head-commit 으로 계속 지킨다.
//                         다시 판정하는 횟수는 PR 하나에 5번까지이고 넘으면 `STOP <PR> 다시 판정을 5번 했는데도 base(<브랜치>) 가 계속 움직인다` 로 멈춘다
//                         GitHub 의 「브랜치를 최신으로 유지」 보호 규칙이 켜진 저장소는 머지가 거부되므로 쓰지 않는다
//   --shared-paths RE     overlap 에서 어느 쪽에 있든 겹친 것으로 보는 공용 경로의 정규식(Python 정규식, re.search 라 경로 어디든 맞는다).
//                         모든 모듈에 영향을 주는 경로(공용 모듈, 루트 빌드 파일, 계약, CI 설정)를 적는다
//   --unit-prefix P       overlap 에서 폴더 하나를 단위로 보는 접두. 기본 modules/
//   --unit-group A,B      overlap 에서 한 단위로 세는 단위 묶음. 여러 번 줄 수 있다. 계약 파일 없이 서로의 응답 모양에
//                         기대는 모듈 쌍(화면 모듈과 그 BFF)은 폴더가 달라도 묶음 안 어느 쪽이 바뀌든 겹친 것으로 본다
//   --stop-on-overlap     PR 의 바뀐 파일이 PR 기준 이후 base 에서 바뀐 파일과 겹치면 `STOP PR 겹침: 파일...` 로 멈춘다
//   --verify-merged CMD   겹치면 origin/BASE 에 PR HEAD 를 merge 한 임시 사본을 만들고, 그 안에서 CMD 를 bash -c 로
//                         돌린다. verify-merged 의 옛 칸이다. 사본의 절대경로를 첫 인자($1)로 받는다. 0 이면 이어 가고 아니면 멈춘다.
//                         합치다 충돌하거나, 검사하는 동안 원격 base 가 움직였으면 멈춘다. 사본은 끝나면 지운다.
//                         검사 명령은 저장소마다 달라 오버레이가 정한다(예: --verify-merged 'cd "$1" && make test')
//                         MERGE_COPY(사본), PR(번호), PR_HEAD, BASE_HEAD, CHANGED_FILES, OVERLAP_FILES 를 환경 변수로
//                         받는다. 파일 목록은 줄바꿈으로 이으며 삭제된 파일도 포함한다. $1 도 사본 경로다
//   --verify-merged-when W  합친 사본 검사를 언제 할지. overlap(기본, 겹칠 때만), code(문서만 바꾼 PR 이 아니면 늘),
//                         always(모든 PR). 파일이 겹치지 않아도 합쳐서 깨질 수 있다(두 PR 이 각자 통과했지만 합치니
//                         같은 상한을 함께 넘었다). code 와 always 는 --verify-merged 나 hooks/verify-merged.ts 가 있어야 한다
//   --docs-glob G1,G2     문서 파일의 glob. PR 이 바꾼 파일이 모두 이것에 맞으면 overlap 과 code 에서 합친 사본 검사 없이
//                         머지한다. 충돌은 mergeable 로 이미 걸렀다. case 패턴이라 `*` 가 `/` 도 넘는다
//                         (예: --docs-glob 'docs/*,*.md'). 여러 번 주면 이어 붙인다.
//                         --verify-merged, --after-merged, --update-docs-on-overlap 가운데 하나와 함께 쓴다
//                         (hooks/verify-merged.ts 와 hooks/after-queue.ts 는 각각 앞의 두 옵션을 준 것으로 본다)
//   --update-docs-on-overlap  문서 PR 의 파일이 base 와 겹치면 GitHub mergeStateStatus 가 CLEAN 일 때 base 를 합치고
//                         필수 CI 를 다시 기다린다. --docs-glob 과 필수 체크 목록이 필요하다. --stop-on-overlap 과도 쓴다
//   --copy-dir DIR        임시 사본을 둘 폴더. 기본은 TMPDIR(없으면 /tmp). 상대경로는 --repo 기준이다.
//                         저장소 hook 이 워크트리 위치를 막으면 오버레이가 허용된 폴더를 준다.
//                         링크를 푼 실경로로 바꿔 쓴다. macOS 의 TMPDIR(/var/folders/...)는 /var 가 /private/var 를
//                         가리키는 링크라, 실경로를 요구하는 검사가 사본 경로를 거부한다. 검사 명령의 TMPDIR 도 실경로로 준다
//                         사본 이름은 merge-queue-pr<PR>-<pid> 다. 시작할 때 이 폴더에서 pid 가 죽은 사본을 지운다.
//                         SIGTERM 이나 SIGINT 로 끝나면 사본을 지우지만, KILL 로 끝나면 사본이 남기 때문이다
//   --continue-on-hold    한 PR 이 조건에 못 미치면 멈추지 않고 STOP 줄을 찍은 뒤 다음 PR 로 간다. 끝에
//                         `QUEUE-HELD 번호...` 를 찍고 정리를 부른 뒤 종료 코드 1 로 끝난다. 기본은 첫 보류에서 멈춘다
//   --skipped-is-missing  결론이 SKIPPED 인 체크는 나타나지 않은 것으로 본다. 필수 체크가 SKIPPED 로만 있으면
//                         실제로 돌 때까지 기다린다. draft 에서는 CI 를 건너뛰게 둔 저장소용이다. 기본은 끔
//                         (GitHub 처럼 SKIPPED 를 통과로 본다). 필수 체크 목록이 있어야 뜻이 있다
//   --after-merged CMD    이번 실행에서 PR 을 하나라도 머지했으면, 큐가 끝나거나 보류로 멈춘 뒤 CMD 를 한 번 bash -c 로
//                         돌린다(배포 같은 것). after-queue 의 옛 칸이다. 환경 변수 MERGED_PRS(머지한 PR 번호, 공백으로 이음)와 CODE_PRS(그 가운데
//                         --docs-glob 에 맞는 문서 PR 을 뺀 것. --docs-glob 이 없으면 MERGED_PRS 와 같다)를 받는다.
//                         실패하면 `AFTER-MERGED-FAILED 종료코드` 를 찍는다. 머지 결과는 바뀌지 않는다
//   --keep-branch         머지 뒤 원격 브랜치를 지우지 않는다
//   --sweep-arg ARG       머지가 끝난 뒤 부르는 cleanup-sweep.ts 에 넘길 인자. 하나씩 준다
//                         (예: --sweep-arg --run --sweep-arg run_x --sweep-arg --specs-dir --sweep-arg .orch/specs)
//   --no-sweep            머지 뒤 cleanup-sweep.ts --apply 를 부르지 않는다
//
// 모든 PR 이 머지되면 cleanup-sweep.ts --apply 로 머지된 worktree, 브랜치, 터미널, 지시서를 정리한다.
// 정리가 실패해도 머지 결과는 바뀌지 않으므로 경고만 찍고 종료 코드는 0 이다.
// CLEANUP_SWEEP 환경 변수로 정리 스크립트 경로를, OVERLAP_UNITS 로 판정 명령 경로를, GH 로 gh 실행 파일을 바꾼다.
// 두 스크립트는 확장자로 인터프리터를 고른다(lib/proc.ts 의 scriptCommand).
//
// PR 조회(gh pr view)가 실패하면 MERGE_QUEUE_GH_RETRIES 번(기본 3)까지 MERGE_QUEUE_GH_RETRY_SECONDS 초(기본 10)
// 간격으로 다시 부른다. 일시 실패로 CI 를 통과한 PR 이 「체크 조회 실패」 로 보류되지 않게 하기 위해서다.
//
// 신호: SIGTERM 이나 SIGINT 를 받으면 진행 중인 자식(`PR:명령`, --threads-cmd, 정리, 이벤트의 핸들러와 옛 칸)에 TERM 을 보내고,
// 2초 뒤에도 살아 있으면 KILL 을 보낸다. 핸들러와 옛 칸은 프로세스 그룹 전체에 보낸다(lib/proc.ts 의 stopChildren).
// 그 뒤 사본을 지우고 128 + 신호 번호로 끝난다. 그 사이에는 새 자식을 띄우지 않고, 머지와 base 합치기, base 옮기기,
// 원격 브랜치 삭제도 하지 않는다. git, gh 처럼 동기로 부르는 호출(머지 포함) 중에 받은 신호는 그 호출이 끝난 뒤 처리된다.
// `PR:명령`, --threads-cmd, 정리는 새 그룹(detached) 없이 띄우므로 TERM 과 KILL 이 그 자식에게만 간다. 복합 명령
// (`a; b`, 파이프)이 띄운 손자 프로세스는 남을 수 있다. 옛 명령은 이 자식도 끊지 않고 끝났다.
// 쓰는 gh 호출(머지, update-branch, base 옮기기)과 원격 브랜치 삭제는 옛 명령처럼 시간 제한이 없다. 읽는 gh 호출은 60초다.
//
// 머지 전 명령(--before, `PR:명령`), --threads-cmd, --verify-merged 는 bash -c 로 돈다. 환경 변수 PR(번호), BRANCH(head 브랜치),
// OWNER, REPO, GH_HOST(위 --hostname 과 같은 값)를 받는다.
// 예: merge_queue.ts 101 102:'./bin/backup-db.sh orders "pr-$PR"' 103
//
// 종료 코드: 0 모두 머지(또는 이미 MERGED), 1 어느 PR 에서 멈춤(--continue-on-hold 면 보류한 PR 이 있음. 충돌이나 묶음으로 뺀 PR 이 있음.
//           3 보다 우선한다),
//           2 사용법 오류(설정 파일 오류, 핸들러와 옛 칸이 함께 있음, 큐에 없는 --last-of-task 포함),
//           3 모두 머지했지만 after-merge 나 after-queue(--after-merged 포함)가 하나라도 실패하거나 시간을 넘겼다,
//           143 SIGTERM 을 받았다, 130 SIGINT 를 받았다
//
// MERGE_QUEUE_SLEEP_SCALE 는 모든 대기 시간에 곱할 배율이다(기본 1). tests 가 0 으로 둔다.

import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, HOOKS_KEYS, loadConfig, PIPELINE_KEYS, section } from './lib/config.ts'
import { checkLegacy, eventTimeoutSec, fire, handlerFile } from './lib/events.ts'
import type { FireContext, FireResult } from './lib/events.ts'
import { apiTarget, checkSnapshot, currentChecks, FAILED_CONCLUSIONS, FAILED_STATES, gh, ghJson, isOwnPr, ownAuthors, parseNames, RULES_JQ, rulesPlanLimited, updateBranch } from './lib/gh.ts'
import { pollSeconds } from './lib/gh-budget.ts'
import { groupMap, isDoc } from './lib/overlap.ts'
import { NO_LIMIT_MS, run, runAsync, runInherit, scriptCommand, signalCode, stopChildren, stopping } from './lib/proc.ts'
import type { RunResult } from './lib/proc.ts'
import { appendEvent } from './lib/loop.ts'
import { alive } from './lib/process.ts'
import { pyJson } from './lib/py.ts'
import { QUEUE_VALUE_OPTIONS } from './lib/queue-options.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const HERE = dirname(SCRIPT)
// 첫 판정 뒤에 base 가 움직여 다시 판정하는 횟수의 상한. 넘으면 멈춘다
const REJUDGE_LIMIT = 5
const DOCS_ONLY_NOTE = '--docs-glob 은 --after-merged 나 --verify-merged 와 함께 쓴다(--up-to-date-when overlap 과도 쓴다)'
// 옛 명령은 git, 판정, 사용자 명령에 시간 제한을 두지 않았다. lib/proc.ts 의 기본 60초로 끊으면 큰 저장소의 fetch 나
// 검사 명령이 실패로 읽혀, 그 호출에는 NO_LIMIT_MS(lib/proc.ts)를 준다
// 사본 이름(merge-queue-pr<PR>-<pid>)을 찾는 glob `merge-queue-pr[0-9]*-[0-9]*` 와 같다
const COPY_NAME = /^merge-queue-pr[0-9].*-[0-9].*$/s
// 머지 큐가 내는 이벤트. 옛 칸(--before, --verify-merged, --after-merged)은 옵션 이름을 legacy 의 key 로 넘긴다
const QUEUE_EVENTS = ['before-merge', 'verify-merged', 'after-merge', 'after-queue'] as const
type QueueEvent = (typeof QUEUE_EVENTS)[number]
type GhPr = { number: number; author: { login: string } | null; url: string }

// 롤업에 나타난 체크 이름(체크 실행은 name, 커밋 상태는 context)
const ROLL_NAMES = '[.statusCheckRollup[] | (.name // .context)]'
const ROLL_NAMES_NO_SKIPPED = '[.statusCheckRollup[] | select((.conclusion // "") != "SKIPPED") | (.name // .context)]'
const PENDING =
  '[.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or (.state // "") == "PENDING" ' +
  'or (.state // "") == "EXPECTED")] | length'
// 실패 판정의 목록은 상주 루프와 한 벌이다(lib/gh.ts 머리 주석의 「필수 체크 판정」)
const FAIL_SEL =
  `select(((.conclusion // "") | test("${FAILED_CONCLUSIONS.join('|')}")) ` + `or ((.state // "") | test("${FAILED_STATES.join('|')}")))`

// 사용법 오류. 종료 코드 2 로 끝난다. 메시지가 비면 머리 주석을 찍는다
class Usage extends Error {}

// PR 하나가 조건에 못 미쳐 멈춘다. 종료 코드 1 이고 --continue-on-hold 면 다음 PR 로 간다
class Stop extends Error {}

// PR 하나가 base 와 충돌한다. 머리 주석의 「충돌」 대로 큐에서 빼고 다음 PR 로 간다
class Conflict extends Stop {}

type Options = {
  repo: string
  beforeAll: string
  method: string
  threadsCmd: string
  checkTimeout: string
  missingTimeout: string
  required: string[]
  allowFail: string[]
  upToDate: boolean
  upToDateWhen: string
  sharedPaths: string
  unitPrefix: string
  unitGroups: string[]
  keepBranch: boolean
  sweep: boolean
  sweepArgs: string[]
  overlap: boolean
  verifyMerged: string
  verifyWhen: string
  docsGlob: string
  updateDocs: boolean
  continueOnHold: boolean
  skippedMissing: boolean
  afterMerged: string
  copyDir: string
  lastOfTask: string[]
  chains: string[][]
  items: string[]
}

// PR 하나를 처리하는 동안 쓰는 값
type Pr = {
  n: string
  ph: string
  branch: string
  cross: boolean
  apiHost: string
  owner: string
  repo: string
  base: string
  beforeHead: string | null
  judgments: number
  judgedBase: string | null
  ov: string[]
  title: string | null
  author: string | null
  draft: boolean
  url: string
}

let sleepScale = 1

function now(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function log(message: string): void {
  out(`${now()} ${message}`)
}

// Python 의 rstrip("\n") 과 같다. 끝의 줄바꿈만 지운다
function chomp(text: string): string {
  return text.replace(/\n+$/, '')
}

function nap(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * sleepScale * 1000))
}

function stop(message: string): never {
  throw new Stop(message)
}

// 이름 목록을 jq 배열 리터럴로 바꾼다
function namesJson(names: readonly string[]): string {
  return pyJson(names)
}

// `--required A,B` 처럼 쉼표로 이은 값을 이름으로 나눈다. 쉼표가 든 이름 하나는 나누지 않는 `--required-check` 로 받는다
function splitNames(value: string): string[] {
  return value.split(',').filter((x) => x)
}

function isDigits(text: string): boolean {
  return /^[0-9]+$/.test(text)
}

function isDir(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

function git(...args: string[]): RunResult {
  return run(['git', ...args], { timeoutMs: NO_LIMIT_MS })
}

// 머리 주석이 사용법을 소유한다. 사용법 오류에 메시지가 없으면(인자 없음, -h) 그것을 찍는다
function usageText(): string {
  const lines: string[] = []
  for (const line of readFileSync(SCRIPT, 'utf8').split('\n')) {
    if (!line.startsWith('//')) break
    lines.push(line.replace(/^\/\/ ?/, ''))
  }
  return lines.join('\n')
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    repo: '.',
    beforeAll: '',
    method: 'merge',
    threadsCmd: '',
    checkTimeout: '60',
    missingTimeout: '5',
    required: [],
    allowFail: [],
    upToDate: false,
    upToDateWhen: 'always',
    sharedPaths: '',
    unitPrefix: 'modules/',
    unitGroups: [],
    keepBranch: false,
    sweep: true,
    sweepArgs: [],
    overlap: false,
    verifyMerged: '',
    verifyWhen: 'overlap',
    docsGlob: '',
    updateDocs: false,
    continueOnHold: false,
    skippedMissing: false,
    afterMerged: '',
    copyDir: '',
    lastOfTask: [],
    chains: [],
    items: [],
  }
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') throw new Usage('')
    if (QUEUE_VALUE_OPTIONS.includes(arg)) {
      const value = i + 1 < argv.length ? argv[i + 1] : ''
      if (!value) throw new Usage(`${arg} 에 값이 없다`)
      i += 2
      if (arg === '--repo') o.repo = value
      else if (arg === '--before') o.beforeAll = value
      else if (arg === '--method') o.method = value
      else if (arg === '--threads-cmd') o.threadsCmd = value
      else if (arg === '--check-timeout') o.checkTimeout = value
      else if (arg === '--missing-timeout') o.missingTimeout = value
      else if (arg === '--required') o.required.push(...splitNames(value))
      else if (arg === '--required-check') o.required.push(value)
      else if (arg === '--allow-fail') o.allowFail.push(...splitNames(value))
      else if (arg === '--allow-fail-check') o.allowFail.push(value)
      else if (arg === '--up-to-date-when') o.upToDateWhen = value
      else if (arg === '--shared-paths') o.sharedPaths = value
      else if (arg === '--unit-prefix') o.unitPrefix = value
      else if (arg === '--unit-group') o.unitGroups.push(value)
      else if (arg === '--verify-merged') {
        o.verifyMerged = value
        o.overlap = true
      } else if (arg === '--verify-merged-when') o.verifyWhen = value
      else if (arg === '--docs-glob') o.docsGlob = o.docsGlob ? `${o.docsGlob},${value}` : value
      else if (arg === '--copy-dir') o.copyDir = value
      else if (arg === '--after-merged') o.afterMerged = value
      else if (arg === '--sweep-arg') o.sweepArgs.push(value)
      else if (arg === '--last-of-task') o.lastOfTask.push(value)
      else if (arg === '--chain') o.chains.push(value.split(','))
      continue
    }
    if (arg === '--require-up-to-date') o.upToDate = true
    else if (arg === '--keep-branch') o.keepBranch = true
    else if (arg === '--continue-on-hold') o.continueOnHold = true
    else if (arg === '--skipped-is-missing') o.skippedMissing = true
    else if (arg === '--stop-on-overlap') o.overlap = true
    else if (arg === '--update-docs-on-overlap') o.updateDocs = o.overlap = true
    else if (arg === '--no-sweep') o.sweep = false
    else if (arg.startsWith('-')) throw new Usage(`모르는 옵션: ${arg}`)
    else o.items.push(arg)
    i += 1
  }
  return validate(o)
}

function validate(o: Options): Options {
  if (o.items.length === 0) throw new Usage('')
  if (!['merge', 'squash', 'rebase'].includes(o.method)) throw new Usage('--method 는 merge, squash, rebase 중 하나다')
  if (!isDigits(o.checkTimeout)) throw new Usage('--check-timeout 은 분 단위 정수다')
  if (!isDigits(o.missingTimeout)) throw new Usage('--missing-timeout 은 분 단위 정수다')
  if (!['overlap', 'code', 'always'].includes(o.verifyWhen)) throw new Usage('--verify-merged-when 은 overlap, code, always 중 하나다')
  if (!['always', 'overlap'].includes(o.upToDateWhen)) throw new Usage('--up-to-date-when 은 always, overlap 중 하나다')
  if (o.upToDateWhen === 'overlap') {
    if (!o.upToDate) throw new Usage('--up-to-date-when overlap 은 --require-up-to-date 와 함께 쓴다')
  } else if (o.sharedPaths || o.unitGroups.length > 0) {
    throw new Usage('--shared-paths 와 --unit-group 은 --up-to-date-when overlap 과 함께 쓴다')
  }
  // --verify-merged 와 --after-merged 가 있어야 하는 옵션은 핸들러 파일도 봐야 해서 Queue.preflight 가 본다
  if (o.updateDocs && !o.docsGlob) throw new Usage('--update-docs-on-overlap 은 --docs-glob 이 필요하다')
  if (o.required.some((name) => /["\\]/.test(name))) throw new Usage('--required 에 따옴표나 역슬래시를 넣을 수 없다')
  if (o.allowFail.some((name) => /["\\]/.test(name))) throw new Usage('--allow-fail 에 따옴표나 역슬래시를 넣을 수 없다')
  for (const name of o.allowFail) {
    if (o.required.includes(name)) {
      throw new Usage(`--allow-fail 의 ${name} 는 --required 에도 있다. 필수 체크의 실패는 허용할 수 없다`)
    }
  }
  try {
    groupMap(o.unitGroups.map((group) => group.split(',')))
  } catch (e) {
    throw new Usage(`--unit-group: ${(e as Error).message}`)
  }
  for (const item of o.items) {
    if (!isDigits(item.split(':')[0])) throw new Usage(`PR 번호가 아니다: ${item}`)
  }
  const queued = o.items.map((item) => item.split(':')[0])
  for (const n of o.lastOfTask) {
    if (!queued.includes(n)) throw new Usage(`--last-of-task ${n} 는 큐에 없는 PR 이다`)
  }
  const chained = new Set<string>()
  for (const chain of o.chains) {
    const label = chain.join(',')
    if (chain.length < 2 || !chain.every(isDigits)) throw new Usage(`--chain ${label} 은 PR 번호 둘 이상을 쉼표로 잇는다`)
    for (const n of chain) {
      if (!queued.includes(n)) throw new Usage(`--chain ${label} 의 ${n} 는 큐에 없는 PR 이다`)
      if (chained.has(n)) throw new Usage(`--chain ${label} 의 ${n} 는 다른 묶음에도 있다`)
      chained.add(n)
    }
    const order = chain.map((n) => queued.indexOf(n))
    if (order.some((at, i) => i > 0 && at <= order[i - 1])) throw new Usage(`--chain ${label} 은 큐의 순서와 같게 적는다`)
  }
  return o
}

// 결과 줄과 STOP 이유에 쓰는 실패 표시. 종료 코드가 없으면 시간 초과나 잠금 실패다
function failLabel(r: FireResult): string {
  if (r.code !== null) return String(r.code)
  return r.result === 'timeout' ? 'timeout' : 'lock'
}

function failed(r: FireResult): boolean {
  return r.result === 'fail' || r.result === 'timeout'
}

class Queue {
  o: Options
  overlapUnits: string
  sweepBase = ''
  // [번호, code|docs]. --after-merged 가 읽는다
  merged: [string, 'code' | 'docs'][] = []
  held: string[] = []
  // 충돌로 뺀 PR. held 에도 든다
  conflicted: string[] = []
  copy = ''
  afterFailed = false
  // after-merge 가 실패하거나 시간을 넘겼다. 모두 머지했으면 종료 코드 3 이다
  notifyFailed = false
  // 주 checkout 이 아니라 --repo 로 옮겨 간 작업 디렉터리다. 이벤트의 repo 와 핸들러 위치는 fire 가 이것으로 정한다
  repoDir = ''
  // 큐를 시작할 때 있던 핸들러 파일의 이벤트. 입력에 조회가 드는 이벤트(after-merge)와 검사를 켜는 이벤트(verify-merged)가 본다
  hooks = new Set<QueueEvent>()
  // 합친 사본 검사를 하는가. --verify-merged 나 hooks/verify-merged.ts 가 있으면 한다
  verify = false
  // 호스트마다 「내 PR」 작성자 목록. null 은 정하지 못한 것이다
  authors = new Map<string, string[] | null>()
  realTmp = ''
  copyDir = ''
  ghRetries = 3
  ghRetrySeconds = 10
  pr: Pr | null = null
  q: { missing: string; failed: string; allowedFailed: string } = { missing: '', failed: '', allowedFailed: '' }

  constructor(opts: Options) {
    this.o = opts
    this.overlapUnits = process.env.OVERLAP_UNITS ?? `${HERE}/overlap_units.ts`
  }

  get p(): Pr {
    if (!this.pr) throw new Error('처리 중인 PR 이 없다')
    return this.pr
  }

  // ---- 준비 -------------------------------------------------------------------------------------

  setup(): void {
    const o = this.o
    try {
      process.chdir(o.repo)
    } catch (e) {
      throw new Usage(`${o.repo} 로 이동하지 못했다: ${(e as Error).message}`)
    }
    this.repoDir = process.cwd()
    this.preflight()
    const tmp = process.env.TMPDIR || '/tmp'
    if (!isDir(tmp)) throw new Usage(`TMPDIR 를 읽지 못했다: ${tmp}`)
    this.realTmp = realpathSync(tmp)
    this.copyDir = o.copyDir || this.realTmp
    if (!o.threadsCmd) {
      // 옛 명령과 같은 글자를 내려고 정규화하지 않고 잇는다
      const rt = `${HERE}/../../review-fix/scripts/review_threads.py`
      let found = false
      try {
        found = statSync(rt).isFile()
      } catch {
        found = false
      }
      if (!found) throw new Usage(`review_threads.py 를 찾지 못했다: ${rt}. --threads-cmd 로 준다`)
      o.threadsCmd = `python3 '${rt}' list --count "$OWNER" "$REPO" "$PR"`
    }
    // 빈 값은 설정하지 않은 것으로 보고 기본값을 쓴다
    const retries = process.env.MERGE_QUEUE_GH_RETRIES || '3'
    const seconds = process.env.MERGE_QUEUE_GH_RETRY_SECONDS || '10'
    for (const [name, value] of [
      ['MERGE_QUEUE_GH_RETRIES', retries],
      ['MERGE_QUEUE_GH_RETRY_SECONDS', seconds],
    ]) {
      if (!isDigits(value)) throw new Usage(`${name} 는 정수다: '${value}'`)
    }
    this.ghRetries = Number(retries)
    this.ghRetrySeconds = Number(seconds)
    this.dropStaleCopies()
  }

  // 큐를 시작하기 전에 설정과 핸들러를 본다. 여기서 내는 ConfigError 와 Usage 는 사용법 오류(종료 코드 2)다.
  // fire 도 핸들러와 옛 칸이 함께 있으면 ConfigError 를 내지만, after-queue 는 머지가 끝난 뒤에 나므로 fire 에만 맡기면
  // 앞 PR 이 머지된 뒤에야 멈춘다. 설정 파일도 after-merge, after-queue, 쌓인 PR 판정이 머지 뒤에 읽으므로 여기서 먼저 읽는다
  preflight(): void {
    const o = this.o
    const repo = this.repoDir
    const config = loadConfig(repo)
    section(config, 'hooks', HOOKS_KEYS)
    const authors = section<{ authors?: unknown }>(config, 'pipeline', PIPELINE_KEYS).authors
    // 비지 않은 값이면 ownAuthors 는 gh 를 부르지 않고 타입만 본다. 틀리면 ConfigError 다
    if (authors !== undefined && !(Array.isArray(authors) && authors.length === 0)) ownAuthors(repo, '')
    for (const event of QUEUE_EVENTS) {
      if (handlerFile(event, repo)) this.hooks.add(event)
    }
    const legacy: [string, string, QueueEvent][] = [
      ['--before', o.beforeAll, 'before-merge'],
      ['--verify-merged', o.verifyMerged, 'verify-merged'],
      ['--after-merged', o.afterMerged, 'after-queue'],
    ]
    for (const [key, value, event] of legacy) {
      if (value) checkLegacy(event, repo, key)
    }
    // 핸들러만 있고 옵션이 없어도 사본 검사가 빠지지 않게 겹침 판정을 켠다
    this.verify = Boolean(o.verifyMerged) || this.hooks.has('verify-merged')
    if (this.verify) o.overlap = true
    const afterQueue = Boolean(o.afterMerged) || this.hooks.has('after-queue')
    if (!this.verify) {
      if (o.verifyWhen !== 'overlap') throw new Usage(`--verify-merged-when ${o.verifyWhen} 은 --verify-merged 와 함께 쓴다`)
      if (o.docsGlob && !(afterQueue || o.updateDocs || o.upToDateWhen === 'overlap')) throw new Usage(DOCS_ONLY_NOTE)
    }
    // 큐가 낼 이벤트의 시간 제한 값을 본다. after-merge 와 after-queue 는 머지 뒤에 나므로 fire 에만 맡기면 머지한 뒤에야 멈춘다
    const firing: [QueueEvent, boolean][] = [
      ['before-merge', Boolean(o.beforeAll) || this.hooks.has('before-merge')],
      ['verify-merged', this.verify],
      ['after-merge', this.hooks.has('after-merge')],
      ['after-queue', afterQueue],
    ]
    for (const [event, fires] of firing) if (fires) eventTimeoutSec(event, repo)
  }

  // 앞 실행이 KILL 로 끝나 남긴 사본을 지운다. 이름 끝의 pid 가 살아 있으면 다른 큐가 쓰는 중이다
  dropStaleCopies(): void {
    if (!isDir(this.copyDir)) return
    const names = readdirSync(this.copyDir)
      .filter((name) => COPY_NAME.test(name))
      .sort()
    for (const name of names) {
      const old = join(this.copyDir, name)
      if (!isDir(old)) continue
      const pid = name.slice(name.lastIndexOf('-') + 1)
      if (isDigits(pid) && alive(Number(pid))) continue
      this.removeCopy(old)
      log(`끝난 실행(pid ${pid})이 남긴 사본을 지웠다: ${old}`)
    }
    git('worktree', 'prune')
  }

  removeCopy(path: string): void {
    if (git('worktree', 'remove', '--force', path).code !== 0) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // 옛 명령의 shutil.rmtree(ignore_errors=True) 와 같이 지우지 못한 것은 넘긴다. 다음 실행이 다시 지운다
      }
    }
  }

  dropCopy(): void {
    if (!this.copy) return
    this.removeCopy(this.copy)
    git('worktree', 'prune')
    this.copy = ''
  }

  // ---- gh 조회 ----------------------------------------------------------------------------------

  // PR 하나의 필드. 호출이 실패하면 ghRetries 번까지 다시 부르고, 그래도 실패하면 빈 문자열이다
  async field(n: string, jsonField: string, jq: string, fresh = false): Promise<string> {
    let attempt = 1
    for (;;) {
      const rollup = jsonField === 'statusCheckRollup'
      if (rollup) {
        const got = checkSnapshot(this.o.repo, n, this.p.ph, fresh)
        if (!got.ok) {
          if (attempt >= this.ghRetries) return ''
          attempt++
          await nap(this.ghRetrySeconds)
          continue
        }
        try {
          const pr = got.data
          if (!pr.headRefOid || pr.headRefOid !== this.p.ph) stop(`${n} 체크 조회 중 HEAD 가 바뀌었다 checked=${this.p.ph} now=${pr.headRefOid || '?'}`)
          pr.statusCheckRollup = currentChecks(pr.statusCheckRollup, pr.headRefOid)
          const filtered = run(['jq', '-r', jq], { input: JSON.stringify(pr) })
          if (filtered.code === 0) return chomp(filtered.stdout)
        } catch (e) {
          if (e instanceof Stop) throw e
        }
        return ''
      }
      const done = gh(['pr', 'view', n, '--json', jsonField, '--jq', jq], { cache: false })
      if (done.code === 0) return chomp(done.stdout)
      if (attempt >= this.ghRetries) return ''
      attempt += 1
      await nap(this.ghRetrySeconds)
    }
  }

  api(...args: string[]): RunResult {
    return gh(['api', '--hostname', this.p.apiHost, ...args], { cache: false })
  }

  // ---- 겹침 -------------------------------------------------------------------------------------

  fetchPrRefs(): boolean {
    const p = this.p
    // 단일 브랜치 clone 이어도 origin/BASE 가 갱신되도록 대상 ref 를 명시한다
    if (git('fetch', '-q', 'origin', `+refs/heads/${p.base}:refs/remotes/origin/${p.base}`).code !== 0) return false
    if (git('cat-file', '-e', `${p.ph}^{commit}`).code !== 0) {
      git('fetch', '-q', 'origin', p.cross ? `refs/pull/${p.n}/head` : p.branch)
    }
    return git('cat-file', '-e', `${p.ph}^{commit}`).code === 0
  }

  names(...args: string[]): string[] | null {
    const done = git('diff', '--name-only', ...args)
    return done.code !== 0 ? null : done.stdout.split('\n').filter((x) => x)
  }

  // PR 이 바꾼 파일 가운데 PR 이 갈라진 뒤 base 에서도 바뀐 파일. 판정하지 못하면 null
  overlapFiles(): string[] | null {
    const p = this.p
    if (!this.fetchPrRefs()) return null
    const mb = git('merge-base', `origin/${p.base}`, p.ph)
    if (mb.code !== 0) return null
    const mine = this.names(mb.stdout.trim(), p.ph)
    const theirs = this.names(mb.stdout.trim(), `origin/${p.base}`)
    if (mine === null || theirs === null) return null
    const other = new Set(theirs)
    return [...new Set(mine)].filter((file) => other.has(file)).sort()
  }

  // PR 이 바꾼 파일이 모두 --docs-glob 에 맞으면 true. 바꾼 파일이 없거나 판정하지 못하면 false
  docsOnly(): boolean {
    const p = this.p
    const mb = git('merge-base', `origin/${p.base}`, p.ph)
    if (mb.code !== 0) return false
    const files = this.names(mb.stdout.trim(), p.ph)
    const patterns = this.o.docsGlob.split(',').filter((g) => g)
    return files !== null && files.length > 0 && files.every((file) => isDoc(file, patterns))
  }

  // --up-to-date-when overlap: 최신화가 필요하면(판정하지 못한 경우 포함) true. 판정 한 줄은 여기서 찍는다
  needsUpdate(): boolean {
    const p = this.p
    const o = this.o
    if (!this.fetchPrRefs()) {
      log(`${p.n} 판정: 갱신 필요(판정 실패: PR HEAD 나 base 를 받지 못했다)`)
      return true
    }
    const judgedBase = git('rev-parse', '-q', '--verify', `origin/${p.base}`).stdout.trim()
    const done = run(
      scriptCommand(this.overlapUnits, [
        '--base',
        `origin/${p.base}`,
        '--head',
        p.ph,
        // 값이 `-` 로 시작해도 옵션으로 읽히지 않도록 `=` 로 붙여 넘긴다
        `--shared-paths=${o.sharedPaths}`,
        `--unit-prefix=${o.unitPrefix}`,
        `--docs-glob=${o.docsGlob}`,
        ...o.unitGroups.map((group) => `--unit-group=${group}`),
      ]),
      { timeoutMs: NO_LIMIT_MS },
    )
    // 옛 명령은 stderr 를 stdout 에 합쳐 읽었다. 판정 줄은 stdout 에, 오류는 stderr 에 나온다
    const verdict = chomp(done.stdout + done.stderr)
    if (done.code === 0) {
      log(`${p.n} 판정: ${verdict}`)
      // 판정한 base 를 적어 둔다. 머지 직전에 base 가 움직였는지 다시 본다
      p.judgedBase = judgedBase
      return false
    }
    if (done.code === 1) {
      log(`${p.n} 판정: ${verdict}`)
      return true
    }
    log(`${p.n} 판정: 갱신 필요(판정 실패: ${verdict.replaceAll('\n', ' ')})`)
    return true
  }

  // origin/BASE 에 PR HEAD 를 merge 한 임시 사본에서 verify-merged 를 낸다(옛 칸은 --verify-merged). 통과하지 않으면 멈춘다
  async verifyMerged(): Promise<void> {
    const p = this.p
    const o = this.o
    let parent = ''
    try {
      mkdirSync(this.copyDir, { recursive: true })
      parent = realpathSync(this.copyDir)
    } catch {
      stop(`${p.n} 사본 폴더를 만들지 못했다: ${this.copyDir}`)
    }
    const bhDone = git('rev-parse', '-q', '--verify', `origin/${p.base}`)
    if (bhDone.code !== 0) stop(`${p.n} origin/${p.base} 를 읽지 못했다`)
    const bh = bhDone.stdout.trim()
    const mb = git('merge-base', bh, p.ph)
    if (mb.code !== 0) stop(`${p.n} 파일 목록의 기준을 읽지 못했다`)
    const changed = this.names(mb.stdout.trim(), p.ph)
    if (changed === null) stop(`${p.n} 바뀐 파일 목록을 읽지 못했다`)
    this.copy = `${parent}/merge-queue-pr${p.n}-${process.pid}`
    if (git('worktree', 'add', '-q', '--detach', this.copy, bh).code !== 0) stop(`${p.n} 사본을 만들지 못했다: ${this.copy}`)
    const merged = git(
      '-C',
      this.copy,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=merge-queue',
      '-c',
      'user.email=merge-queue@localhost',
      'merge',
      '-q',
      '--no-edit',
      p.ph,
    )
    if (merged.code !== 0) stop(`${p.n} base(${p.base}) 와 합치면 충돌한다`)
    log(`${p.n} 합친 사본에서 검사: ${o.verifyMerged || 'hooks/verify-merged.ts'}`)
    const env = {
      ...this.prEnv(),
      TMPDIR: this.realTmp,
      GH_HOST: p.apiHost,
      MERGE_COPY: this.copy,
      PR_HEAD: p.ph,
      BASE_HEAD: bh,
      CHANGED_FILES: changed.join('\n'),
      OVERLAP_FILES: p.ov.join('\n'),
    }
    const input = { pr: this.prInput(), copy: this.copy, base_head: bh, changed_files: changed, overlap_files: p.ov }
    const ctx: FireContext = { ...this.ctx(), cwd: this.copy }
    if (o.verifyMerged) ctx.legacy = { key: '--verify-merged', argv: ['bash', '-c', o.verifyMerged, 'verify-merged', this.copy], env }
    const done = await fire('verify-merged', input, ctx)
    this.dropCopy()
    // 핸들러를 큐 시작 뒤에 지웠으면 none 이다. 검사하지 않은 조합을 머지하지 않도록 통과로 읽지 않는다
    if (done.result === 'none') stop(`${p.n} 합친 사본의 검사 실패(hooks/verify-merged.ts 가 없다)`)
    if (done.result !== 'pass') stop(`${p.n} 합친 사본의 검사 실패(종료 코드 ${failLabel(done)})`)
    // 검사하는 동안 base 가 움직였으면 검사한 조합과 머지할 조합이 다르다
    if (this.remoteBase() !== bh) stop(`${p.n} 검사하는 동안 base(${p.base}) 가 움직였다. 다시 돌린다`)
    log(`${p.n} 합친 사본의 검사 통과`)
  }

  prEnv(): Record<string, string> {
    const p = this.p
    return { PR: p.n, BRANCH: p.branch, OWNER: p.owner, REPO: p.repo }
  }

  // 이벤트 입력의 pr 객체(lib/events.ts 머리 주석의 「이벤트별 필드」)
  prInput(): Record<string, unknown> {
    const p = this.p
    return { number: Number(p.n), title: p.title, branch: p.branch, head: p.ph, author: p.author, draft: p.draft, url: p.url }
  }

  ctx(): FireContext {
    return { repo: this.repoDir, base: this.p.base, run: null }
  }

  // ---- PR 하나 ----------------------------------------------------------------------------------

  async processPr(item: string): Promise<void> {
    const o = this.o
    const colon = item.indexOf(':')
    const n = colon >= 0 ? item.slice(0, colon) : item
    // `PR:명령` 은 그 PR 에서 --before 를 대신한다. 이벤트가 아니라 before-merge 다음에 따로 돈다.
    // 콜론이 있으면 명령이 비어도 --before 를 끈다(옛 명령과 같이 콜론 유무로 가른다). 콜론이 없으면 null 이다
    const prCommand = colon >= 0 ? item.slice(colon + 1) : null
    const p: Pr = (this.pr = {
      n,
      ph: '',
      branch: '',
      cross: false,
      apiHost: '',
      owner: '',
      repo: '',
      base: '',
      beforeHead: null,
      judgments: 0,
      judgedBase: null,
      ov: [],
      title: null,
      author: null,
      draft: false,
      url: '',
    })

    const st = await this.field(n, 'state', '.state')
    if (st === 'MERGED') {
      log(`${n} 이미 MERGED`)
      this.sweepBase = this.sweepBase || (await this.field(n, 'baseRefName', '.baseRefName'))
      return
    }
    if (st !== 'OPEN') stop(`${n} state=${st || '조회 실패'}`)

    // 검사 대상 HEAD 를 체크를 보기 전에 고정한다
    p.ph = await this.field(n, 'headRefOid', '.headRefOid')
    p.branch = await this.field(n, 'headRefName', '.headRefName')
    const cross = await this.field(n, 'isCrossRepository', '.isCrossRepository')
    if (!p.ph) stop(`${n} headRefOid 조회 실패`)
    if (!p.branch) stop(`${n} headRefName 조회 실패`)
    if (cross !== 'true' && cross !== 'false') stop(`${n} isCrossRepository 조회 실패`)
    p.cross = cross === 'true'

    // https://<호스트>/<owner>/<repo>/pull/<번호>. `://` 가 없으면 호스트가 비어 조회 실패다
    const url = await this.field(n, 'url', '.url')
    const scheme = url.indexOf('://')
    const [host, owner, repo] = (scheme >= 0 ? url.slice(scheme + 3) : '').split('/')
    p.apiHost = host ?? ''
    p.owner = owner ?? ''
    p.repo = repo ?? ''
    if (!(p.owner && p.repo && p.apiHost)) stop(`${n} url 조회 실패`)
    p.url = url
    // 이벤트 입력의 pr 을 채운다. 조회하지 못했으면 핸들러에 틀린 값을 넘기지 않도록 멈춘다
    const info = await this.field(n, 'title,author,isDraft', '{title, author: .author.login, isDraft} | tojson')
    try {
      const parsed = JSON.parse(info) as { title: unknown; author: unknown; isDraft: unknown }
      p.title = typeof parsed.title === 'string' ? parsed.title : null
      p.author = typeof parsed.author === 'string' ? parsed.author : null
      p.draft = parsed.isDraft === true
    } catch {
      stop(`${n} title, author, isDraft 조회 실패`)
    }
    p.base = await this.field(n, 'baseRefName', '.baseRefName')
    if (!p.base) stop(`${n} baseRefName 조회 실패`)
    this.sweepBase = p.base

    const req = this.requiredChecks()
    for (const name of o.allowFail) {
      if (req.includes(name)) stop(`${n} --allow-fail 의 ${name} 는 필수 체크다. 필수 체크의 실패는 허용할 수 없다`)
    }
    const roll = o.skippedMissing ? ROLL_NAMES_NO_SKIPPED : ROLL_NAMES
    const allowed = `(.name // .context) as $nm | (${namesJson(o.allowFail)} | any(. == $nm))`
    this.q = {
      missing: `((${namesJson(req)}) - ${roll})`,
      failed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed} | not)] | length`,
      allowedFailed: `[.statusCheckRollup[] | ${FAIL_SEL} | select(${allowed}) | (.name // .context)] | unique | .[]`,
    }

    p.beforeHead = null
    p.judgments = 0
    await this.readyToMerge(prCommand)

    // 머지 뒤에는 merge-base 가 바뀌어 문서 PR 인지 다시 판정할 수 없다. 머지 전에 정한다
    const kind = o.docsGlob && this.docsOnly() ? 'docs' : 'code'
    refuseWhenStopping(n)
    const merge = gh(['pr', 'merge', n, `--${o.method}`, '--match-head-commit', p.ph], { timeoutMs: NO_LIMIT_MS })
    // 옛 명령은 stderr 를 stdout 에 합쳐 마지막 줄만 찍었다
    const last = chomp(merge.stdout + merge.stderr).split('\n').pop() ?? ''
    if (last) out(last)
    let merged = false
    for (let i = 0; i < 3; i++) {
      await nap(5)
      if ((await this.field(n, 'state', '.state')) === 'MERGED') {
        merged = true
        break
      }
    }
    if (!merged) stop(`${n} 머지 실패`)
    log(`${n} MERGED`)
    this.merged.push([n, kind])
    // 머지 뒤 원격 추적 브랜치를 갱신해야 remove-worktree.ts 가 워크트리 커밋을 원격에 있다고 본다
    git('fetch', '-q', 'origin')
    const branch = !o.keepBranch && !p.cross ? this.deleteBranch() : { retargeted: [], deleted: false }
    await this.afterMerge(branch)
  }

  // after-merge 를 낸다. PR 은 이미 머지됐으므로 실패해도 멈추지 않고 HOOK-FAIL 줄만 남긴다(종료 코드 3)
  async afterMerge(branch: { retargeted: number[]; deleted: boolean }): Promise<void> {
    if (!this.hooks.has('after-merge')) return
    const p = this.p
    const commit = await this.field(p.n, 'mergeCommit', '.mergeCommit.oid // ""')
    const input = { pr: this.prInput(), merge_commit: commit || null, remote_branch_deleted: branch.deleted, retargeted: branch.retargeted }
    try {
      if (failed(await fire('after-merge', input, this.ctx()))) this.notifyFailed = true
    } catch (e) {
      // 설정 오류는 사용법 오류로 올린다. 그 밖의 오류로 머지된 PR 을 보류로 읽지 않는다
      if (e instanceof ConfigError) throw e
      process.stderr.write(`after-merge 를 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
      out('HOOK-FAIL after-merge error')
      this.notifyFailed = true
    }
  }

  // 머지 직전까지의 확인을 끝낸다. 바로 머지로 판정한 뒤 base 가 움직였으면 다시 판정한다
  async readyToMerge(prCommand: string | null): Promise<void> {
    const o = this.o
    const p = this.p
    const n = p.n
    for (;;) {
      await this.bringUpToDate()

      const f = await this.field(n, 'statusCheckRollup', this.q.failed)
      for (const name of (await this.field(n, 'statusCheckRollup', this.q.allowedFailed)).split('\n')) {
        if (name) out(`경고: ${n} 실패를 허용한 체크 ${name}`)
      }
      const threads = await runAsync(['bash', '-c', o.threadsCmd], { env: { ...this.prEnv(), GH_HOST: p.apiHost, ORCH_GH_CACHE: '0' }, timeoutMs: NO_LIMIT_MS })
      // 옛 명령은 스레드 명령의 stderr 를 받지 않고 그대로 흘렸다
      if (threads.stderr) process.stderr.write(threads.stderr)
      if (threads.code !== 0) stop(`${n} 스레드 조회 실패`)
      const t = chomp(threads.stdout)

      let m = await this.field(n, 'mergeable', '.mergeable')
      for (let i = 0; i < 4; i++) {
        if (m !== 'UNKNOWN') break
        await nap(20)
        m = await this.field(n, 'mergeable', '.mergeable')
      }

      log(`${n} fails=${f} threads=${t} mergeable=${m}`)
      if (m === 'CONFLICTING') throw new Conflict(`${n} base(${p.base}) 와 충돌한다(mergeable=CONFLICTING)`)
      if (f !== '0' || t !== '0' || m !== 'MERGEABLE') stop(n)

      p.ov = []
      if (o.overlap) {
        const ov = this.overlapFiles()
        if (ov === null) stop(`${n} 겹침 판정 실패(PR HEAD 나 base 를 받지 못했다)`)
        p.ov = ov
        const listing = ov.join(' ')
        if (!this.verify) {
          if (ov.length > 0) stop(`${n} 겹침: ${listing}`)
        } else {
          if (ov.length > 0) log(`${n} 겹침: ${listing}`)
          if (o.verifyWhen !== 'overlap' || ov.length > 0) {
            if (o.verifyWhen !== 'always' && o.docsGlob && this.docsOnly()) {
              log(`${n} 문서만 바꿨다(--docs-glob). 합친 사본 검사 없이 머지한다`)
            } else {
              await this.verifyMerged()
            }
          }
        }
      }

      // 같은 HEAD 에는 한 번만 낸다. base 가 움직여 다시 판정해도 HEAD 가 같으면 다시 내지 않는다
      if (p.beforeHead !== p.ph) {
        p.beforeHead = p.ph
        await this.beforeMerge(prCommand)
      }

      const ph2 = await this.field(n, 'headRefOid', '.headRefOid')
      if (p.ph !== ph2) stop(`${n} 검사 뒤 HEAD 가 바뀌었다 checked=${p.ph.slice(0, 8)} now=${ph2.slice(0, 8)}`)
      // 같은 HEAD 에 재실행만 생겨도 캐시의 완료 결과로 머지하지 않는다. 머지 전 명령 뒤에 읽는다.
      const latestFailed = await this.field(n, 'statusCheckRollup', this.q.failed, true)
      const latestPending = await this.field(n, 'statusCheckRollup', PENDING)
      const latestMissing = await this.field(n, 'statusCheckRollup', `${this.q.missing} | length`)
      if (latestFailed !== '0' || latestPending !== '0' || latestMissing !== '0') stop(`${n} 머지 직전 체크가 바뀌었다 fails=${latestFailed} pending=${latestPending} missing=${latestMissing}`)
      if (!p.cross) {
        if (git('fetch', '-q', 'origin', p.branch).code !== 0) stop(`${n} 원격 브랜치 fetch 실패`)
        const rh = git('rev-parse', '-q', '--verify', `origin/${p.branch}`).stdout.trim()
        if (p.ph !== rh) stop(`${n} head 불일치 pr=${p.ph.slice(0, 8)} remote=${rh.slice(0, 8)}`)
      }
      if (!p.judgedBase) return
      if (this.remoteBase() === p.judgedBase) return
      log(`${n} 판정한 뒤 base(${p.base}) 가 움직였다. 새로 들어온 변경으로 다시 판정한다`)
    }
  }

  // before-merge 를 내고 `PR:명령` 을 돌린다. 옛 칸 --before 는 콜론 없이 준 PR 에서만 넘긴다
  async beforeMerge(prCommand: string | null): Promise<void> {
    const o = this.o
    const p = this.p
    const n = p.n
    const env = { ...this.prEnv(), GH_HOST: p.apiHost }
    const legacy = prCommand === null ? o.beforeAll : ''
    if (legacy || this.hooks.has('before-merge')) {
      if (legacy) log(`${n} 머지 전 명령: ${legacy}`)
      const ctx = this.ctx()
      if (legacy) ctx.legacy = { key: '--before', argv: ['bash', '-c', legacy], env }
      const input = { pr: this.prInput(), owner: p.owner, name: p.repo, last_of_task: o.lastOfTask.includes(n) }
      const done = await fire('before-merge', input, ctx)
      if (done.result === 'reject') stop(`${n} HOOK-REJECT`)
      if (failed(done)) stop(`${n} HOOK-FAIL`)
    }
    if (!prCommand) return
    log(`${n} 머지 전 명령: ${prCommand}`)
    const done = await runInherit(['bash', '-c', prCommand], { env, timeoutMs: NO_LIMIT_MS })
    if (done.code !== 0) stop(`${n} 머지 전 명령 실패`)
  }

  // 원격 base 의 지금 SHA. 조회하지 못하면 base 가 움직인 것으로 읽지 않고 멈춘다
  remoteBase(): string {
    const p = this.p
    const done = git('ls-remote', 'origin', `refs/heads/${p.base}`)
    const sha = done.code === 0 ? done.stdout.split('\t')[0].trim() : ''
    if (!sha) stop(`${p.n} base 조회 실패`)
    return sha
  }

  requiredChecks(): string[] {
    const o = this.o
    const p = this.p
    let req = o.required
    if (req.length === 0) {
      const done = this.api(`repos/${p.owner}/${p.repo}/rules/branches/${p.base}`, '--jq', RULES_JQ)
      if (done.code === 0) {
        req = parseNames(chomp(done.stdout))
      } else if (rulesPlanLimited(done.stderr)) {
        // 무료 플랜의 비공개 저장소는 규칙 API 를 읽을 수 없다. 필수 체크 목록이 없는 것으로 다룬다
        log(`${p.n} 경고: 이 플랜은 저장소 규칙을 읽을 수 없다(HTTP 403, 플랜 제한). 필수 체크 목록을 비어 있는 것으로 본다`)
        req = []
      } else {
        stop(`${p.n} 필수 체크 규칙 조회 실패. --required 로 준다`)
      }
    }
    if (req.length === 0) {
      if (o.upToDate) stop(`${p.n} 필수 체크 목록이 비어 있어 --require-up-to-date 를 쓸 수 없다. --required 로 준다`)
      if (o.updateDocs) stop(`${p.n} 문서 PR 갱신에는 필수 체크 목록이 필요하다. --required 로 준다`)
      log(`${p.n} 필수 체크 목록이 비어 있다. 지금 있는 체크만 기다린다`)
    }
    return req
  }

  async waitChecks(): Promise<void> {
    const n = this.p.n
    const q = this.q
    const limit = Number(this.o.checkTimeout) * 60
    const missingLimit = Number(this.o.missingTimeout) * 60
    let waited = 0
    // 진행 중인 체크가 없는데 나타나지 않은 필수 체크가 남은 채로 지난 초
    let idle = 0
    let attempt = 0
    for (;;) {
      let f = await this.field(n, 'statusCheckRollup', q.failed, waited >= limit || (missingLimit > 0 && idle >= missingLimit))
      if (f !== '0') f = await this.field(n, 'statusCheckRollup', q.failed, true)
      if ((f || '0') !== '0') stop(`${n} 실패한 체크 ${f} 개`)
      const pending = await this.field(n, 'statusCheckRollup', PENDING)
      const missing = await this.field(n, 'statusCheckRollup', `${q.missing} | length`)
      if (!pending || !missing) stop(`${n} 체크 조회 실패`)
      if (pending === '0' && missing === '0') break
      if (waited >= limit) {
        const names = await this.field(n, 'statusCheckRollup', `${q.missing} | join(",")`)
        stop(`${n} 체크 대기 ${this.o.checkTimeout}분 초과(진행 중 ${pending}, 나타나지 않은 필수 체크 ${names})`)
      }
      if (pending !== '0') idle = 0
      if (missingLimit > 0 && idle >= missingLimit) {
        const names = await this.field(n, 'statusCheckRollup', `${q.missing} | join(", ")`)
        const seen = await this.field(n, 'statusCheckRollup', `${ROLL_NAMES} | unique | tojson`)
        stop(
          `${n} 진행 중인 체크가 없는데 필수 체크가 ${this.o.missingTimeout}분째 나타나지 않는다(나타나지 않은 필수 체크 ${names}). ` +
            `PR 에 붙은 체크: ${seen || '[]'}. 필수 체크 이름이 틀렸을 수 있다(쉼표가 든 이름은 --required-check 로 준다)`,
        )
      }
      const seconds = Math.min(pollSeconds(attempt++), Math.max(0, limit - waited),
        pending === '0' && missingLimit > 0 ? Math.max(0, missingLimit - idle) : Infinity)
      await nap(seconds)
      waited += seconds
      if (pending === '0') idle += seconds
      else idle = 0
    }
    // 체크가 끝난 직후에 새 체크가 붙는 경우가 있어 잠시 뒤 다시 본다
    await nap(60)
    const pending = await this.field(n, 'statusCheckRollup', PENDING, true)
    const missing = await this.field(n, 'statusCheckRollup', `${q.missing} | length`)
    if (!(pending === '0' && missing === '0')) {
      stop(`${n} 새로 붙은 체크가 아직 돈다(진행 중 ${pending || '?'}, 미등장 ${missing || '?'}). 다시 돌린다`)
    }
  }

  // 필수 체크를 기다리고, 켜져 있으면 base 최신화와 문서 PR 갱신을 한다
  async bringUpToDate(): Promise<void> {
    const o = this.o
    const p = this.p
    const n = p.n
    let rounds = 0
    p.judgedBase = null
    for (;;) {
      p.judgedBase = null
      await this.waitChecks()
      let updateDocs = false
      if (o.updateDocs) {
        const ov = this.overlapFiles()
        if (ov === null) stop(`${n} 문서 PR 의 겹침 판정 실패`)
        if (ov.length > 0 && this.docsOnly()) {
          const ms = await this.field(n, 'mergeStateStatus', '.mergeStateStatus')
          if (ms !== 'CLEAN') stop(`${n} 문서 PR 을 갱신하려면 GitHub CLEAN 이 필요하다(현재 ${ms})`)
          updateDocs = true
        }
      }
      if (!(o.upToDate || updateDocs)) return
      // 비교보다 먼저 읽는다. 그 사이 base 가 움직였으면 나중에 다른 값으로 보여 다시 판정한다
      const baseAtCompare = o.upToDateWhen === 'overlap' ? this.remoteBase() : null
      const compared = this.api(`repos/${p.owner}/${p.repo}/compare/${p.base}...${p.ph}`, '--jq', '.behind_by')
      const behind = compared.code === 0 ? chomp(compared.stdout) : ''
      if (!isDigits(behind)) stop(`${n} base 와 비교 실패`)
      if (behind === '0') {
        // 최신이라 판정은 거치지 않는다. 이 뒤(스레드 조회, mergeable 재시도, 머지 전 명령)에 base 가
        // 움직이면 readyToMerge 가 다시 판정하도록 지금 base 를 적어 둔다
        if (o.upToDateWhen === 'overlap') p.judgedBase = baseAtCompare
        return
      }
      // 문서 PR 갱신(updateDocs)은 겹침을 이미 확인한 뒤의 결정이라 판정을 거치지 않는다
      if (o.upToDateWhen === 'overlap' && !updateDocs) {
        // 갱신하고 CI 를 기다리는 사이 base 가 또 움직였을 수 있어, 이 자리에 올 때마다 새로 판정한다
        p.judgments += 1
        if (p.judgments > REJUDGE_LIMIT + 1) stop(`${n} 다시 판정을 ${REJUDGE_LIMIT}번 했는데도 base(${p.base}) 가 계속 움직인다`)
        if (!this.needsUpdate()) return
      }
      rounds += 1
      if (rounds > (o.upToDateWhen === 'overlap' ? REJUDGE_LIMIT + 1 : 3)) {
        stop(`${n} base 를 ${rounds - 1}번 merge 해도 최신이 아니다. base 가 계속 움직인다`)
      }
      log(`${n} base(${p.base}) 보다 ${behind} 커밋 뒤처졌다. update-branch 후 체크를 다시 기다린다`)
      // 차례가 온 이 PR 에만 base 를 합친다. 검사한 HEAD 를 넘겨, 그 뒤에 push 된 커밋이 있으면 GitHub 가 거부하게 한다.
      // merge-turn 은 draft 여부를 보지 않는다
      refuseWhenStopping(n)
      const updated = updateBranch(`${p.owner}/${p.repo}`, { number: Number(n), isDraft: false }, 'merge-turn', {
        host: p.apiHost,
        expectedHead: p.ph,
      })
      if (updated.code !== 0) {
        if (/conflict/i.test(updated.stderr + updated.stdout)) throw new Conflict(`${n} update-branch 가 충돌로 실패했다`)
        stop(`${n} update-branch 실패`)
      }
      // update-branch 는 비동기라 PR HEAD 가 바뀔 때까지 기다린다
      let next = ''
      for (let i = 0; i < 12; i++) {
        await nap(5)
        next = await this.field(n, 'headRefOid', '.headRefOid')
        if (next && next !== p.ph) break
      }
      if (!next || next === p.ph) stop(`${n} update-branch 뒤 HEAD 가 바뀌지 않았다`)
      p.ph = next
    }
  }

  // 머지한 브랜치를 base 로 둔 열린 PR. 조회하지 못하면 null
  basedOn(): GhPr[] | null {
    const found = ghJson<GhPr[]>(['pr', 'list', '--state', 'open', '--base', this.p.branch, '--json', 'number,author,url'])
    return found.ok && Array.isArray(found.data) ? found.data : null
  }

  // 「내 PR」 인지. 작성자 목록은 PR URL 의 호스트마다 한 번 읽는다. 정하지 못하면 null
  ownPr(pr: GhPr): boolean | null {
    const host = apiTarget(pr.url)?.host
    if (!host) return null
    if (!this.authors.has(host)) this.authors.set(host, ownAuthors(this.repoDir, host))
    const authors = this.authors.get(host)
    if (!authors) return null
    return Boolean(pr.author?.login) && isOwnPr(pr as { author: { login: string } }, authors)
  }

  // 머지한 PR 의 원격 브랜치를 지운다. 그 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 먼저 머지한 PR 의 base 로 옮긴다.
  // 지우면 그 브랜치를 base 로 둔 열린 PR 이 닫히므로, 다른 사람의 PR 이 있거나 조회나 옮기기가 실패하면 남긴다
  deleteBranch(): { retargeted: number[]; deleted: boolean } {
    const p = this.p
    const retargeted: number[] = []
    const kept = (why: string) => {
      log(`${p.n} ${why} ${p.branch}`)
      return { retargeted, deleted: false }
    }
    if (p.branch.startsWith('release/')) {
      log(`${p.n} release 브랜치는 남긴다 ${p.branch}`)
      return { retargeted, deleted: false }
    }
    const based = this.basedOn()
    if (based === null) return kept('열린 PR 조회에 실패해 남긴다')
    if (based.length > 0) {
      const owns = based.map((pr) => this.ownPr(pr))
      if (owns.includes(null)) return kept('쌓인 PR 의 작성자를 정하지 못해 남긴다')
      const others = based.filter((_, i) => !owns[i]).map((pr) => pr.number)
      if (others.length > 0) return kept(`다른 사람의 열린 PR(${others.join(' ')}) 의 base 라 남긴다`)
      for (const pr of based) {
        if (stopping()) return kept(`${stopping()} 를 받아 끝내는 중이라 남긴다`)
        if (gh(['pr', 'edit', String(pr.number), '--base', p.base], { timeoutMs: NO_LIMIT_MS }).code !== 0) {
          return kept(`쌓인 PR ${pr.number} 의 base 를 옮기지 못해 남긴다`)
        }
        retargeted.push(pr.number)
        log(`${p.n} 쌓인 PR ${pr.number} 의 base 를 ${p.base} 로 옮겼다`)
      }
      // 옮기는 사이 새로 열린 PR 이 있으면 지우면서 닫는다. 다시 읽어 남은 것이 없을 때만 지운다
      const left = this.basedOn()
      if (left === null || left.length > 0) return kept('다른 열린 PR 의 base 이거나 조회 실패라 남긴다')
    }
    if (stopping()) return kept(`${stopping()} 를 받아 끝내는 중이라 남긴다`)
    const deleted = git('push', '-q', 'origin', '--delete', p.branch).code === 0
    if (deleted) log(`${p.n} 원격 브랜치 삭제 ${p.branch}`)
    git('fetch', '-q', '--prune', 'origin')
    return { retargeted, deleted }
  }

  // ---- 큐 ---------------------------------------------------------------------------------------

  // 이번 실행에서 머지한 PR 이 있으면 after-queue 를 한 번 낸다(옛 칸은 --after-merged)
  async runAfterMerged(): Promise<void> {
    const command = this.o.afterMerged
    if (!(this.merged.length > 0 && (command || this.hooks.has('after-queue')))) return
    const merged = this.merged.map(([n]) => n)
    const code = this.merged.filter(([, kind]) => kind === 'code').map(([n]) => n)
    const mergedPrs = merged.join(' ')
    const codePrs = code.join(' ')
    log(`머지 뒤 명령(머지 ${mergedPrs}, 코드 ${codePrs || '없음'}): ${command || 'hooks/after-queue.ts'}`)
    const input = { merged_prs: merged.map(Number), code_prs: code.map(Number), held_prs: this.held.map(Number) }
    const ctx: FireContext = { repo: this.repoDir, base: this.sweepBase, run: null }
    if (command) ctx.legacy = { key: '--after-merged', argv: ['bash', '-c', command], env: { MERGED_PRS: mergedPrs, CODE_PRS: codePrs } }
    this.merged = []
    let label: string | null = null
    try {
      const done = await fire('after-queue', input, ctx)
      if (failed(done)) label = failLabel(done)
    } catch (e) {
      // 설정 오류는 사용법 오류로 올린다. 그 밖의 오류는 머지 결과를 바꾸지 않고 실패로 남긴다
      if (e instanceof ConfigError) throw e
      process.stderr.write(`after-queue 를 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
      out('HOOK-FAIL after-queue error')
      label = 'error'
    }
    if (label !== null) {
      out(`AFTER-MERGED-FAILED ${label}`)
      this.afterFailed = true
    }
  }

  // 머지가 끝난 뒤 cleanup-sweep --apply 로 정리한다. 실패해도 머지 결과는 그대로라 경고만 찍는다
  async sweep(): Promise<void> {
    const sweep = process.env.CLEANUP_SWEEP ?? `${HERE}/cleanup-sweep.ts`
    const done = await runInherit(
      scriptCommand(sweep, ['--repo', process.cwd(), '--base', this.sweepBase || 'main', '--apply', ...this.o.sweepArgs]),
      { timeoutMs: NO_LIMIT_MS },
    )
    if (done.code !== 0) out('경고: cleanup-sweep.ts 가 실패했다. 머지 결과는 그대로다')
  }

  // 큐 도중의 설정 오류로 멈춘다. 종료 코드 2 다. 이번 실행에서 머지한 PR 이 있으면 그 전에 after-queue 만 돌린다.
  // 옛 명령은 보류로 멈춘 자리에서도 앞에서 머지한 PR 의 머지 뒤 명령을 돌리고 정리는 부르지 않았다. 그 규칙을 따른다
  async stopOnConfig(e: ConfigError): Promise<number> {
    process.stderr.write(`${e.message}\n`)
    if (this.merged.length === 0) return 2
    try {
      await this.runAfterMerged()
    } catch (again) {
      if (!(again instanceof ConfigError)) throw again
      process.stderr.write(`${again.message}\n`)
      out('AFTER-MERGED-FAILED error')
    }
    return 2
  }

  // 충돌로 뺀 PR 을 상주 루프의 알림 파일에 쓴다. 쓰지 못해도 큐는 이어 간다
  notifyConflict(n: string, reason: string): void {
    const sweep = this.o.sweepArgs
    const at = sweep.indexOf('--run')
    const run = at >= 0 && at + 1 < sweep.length ? sweep[at + 1] : null
    try {
      appendEvent(this.repoDir, 'QUEUE-CONFLICT', Number(n), reason, run)
    } catch (e) {
      process.stderr.write(`경고: QUEUE-CONFLICT 알림을 쓰지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
    }
  }

  // 묶음 안에서 n 보다 앞에 있고 머지되지 않고 빠진 PR. 없으면 null
  droppedBefore(n: string): string | null {
    const chain = this.o.chains.find((c) => c.includes(n))
    if (!chain) return null
    return chain.slice(0, chain.indexOf(n)).find((m) => this.held.includes(m)) ?? null
  }

  async run(): Promise<number> {
    const o = this.o
    for (const item of o.items) {
      const n = item.split(':')[0]
      const before = this.droppedBefore(n)
      if (before !== null) {
        out(`SKIP ${n} 묶음의 앞 PR ${before} 가 머지되지 않았다`)
        this.held.push(n)
        continue
      }
      let code = 0
      try {
        await this.processPr(item)
      } catch (e) {
        // 설정 오류는 그 PR 의 보류가 아니라 사용법 오류다. --continue-on-hold 여도 큐를 멈춘다
        if (e instanceof ConfigError) {
          this.dropCopy()
          return await this.stopOnConfig(e)
        }
        if (e instanceof Conflict) {
          out(`CONFLICT ${e.message}`)
          this.conflicted.push(n)
          this.notifyConflict(n, e.message)
        } else if (e instanceof Stop) {
          out(`STOP ${e.message}`)
        } else {
          // 예상 못 한 오류도 그 PR 의 보류로 다룬다
          process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
          out(`STOP ${n} 예상 못 한 오류`)
        }
        code = 1
      } finally {
        this.dropCopy()
      }
      if (code === 0) continue
      this.held.push(n)
      if (this.conflicted.includes(n)) {
        log(`${n} 충돌. 큐에서 빼고 다음 PR 로 간다`)
        continue
      }
      if (!o.continueOnHold) {
        // 보류로 멈춰도 앞에서 머지한 PR 의 머지 뒤 명령은 돌린다
        await this.runAfterMerged()
        return 1
      }
      log(`${n} 보류. 다음 PR 로 간다`)
    }
    if (this.conflicted.length > 0) out(`QUEUE-CONFLICT ${this.conflicted.join(' ')}`)
    out(this.held.length > 0 ? `QUEUE-HELD ${this.held.join(' ')}` : 'QUEUE-DONE')
    await this.runAfterMerged()
    if (o.sweep) await this.sweep()
    if (this.held.length > 0) return 1
    return this.afterFailed || this.notifyFailed ? 3 : 0
  }
}

let active: Queue | null = null

// 신호를 받아 끝내는 중이면 쓰는 호출을 하지 않고 그 PR 을 멈춘다. 처리기가 자식을 끊는 유예 동안에도 큐는 이어 돌아,
// TERM 을 받고 0 으로 끝난 핸들러 뒤에 머지가 나갈 수 있기 때문이다
function refuseWhenStopping(n: string): void {
  const signal = stopping()
  if (signal) stop(`${n} ${signal} 를 받아 끝내는 중이라 멈춘다`)
}

// 동기 자식 실행(spawnSync) 중에는 신호 처리기가 돌지 않는다. 오래 걸리는 사용자 명령과 대기는 비동기로 부르므로
// 그동안 받은 신호는 바로 처리되고, 짧은 git, gh 조회 중에 받은 것은 그 호출이 끝난 뒤 처리된다.
// 진행 중인 자식을 끊은 뒤에 끝낸다. 그냥 끝내면 핸들러의 프로세스 그룹(detached)과 bash -c 자식이 남는다
let exiting = false
function onSignal(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  void stopChildren(signal).finally(() => {
    active?.dropCopy()
    process.exit(signalCode(signal))
  })
}
process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)

async function main(argv: string[]): Promise<number> {
  let queue: Queue
  try {
    const scale = process.env.MERGE_QUEUE_SLEEP_SCALE ?? '1'
    sleepScale = Number(scale)
    // 옛 명령은 float() 로 읽지 못하면 시작하지 못했다. 빈 값을 0 으로 읽으면 모든 대기가 사라져 체크 대기가 바로 끝난다
    if (!scale.trim() || !Number.isFinite(sleepScale) || sleepScale < 0) throw new Usage(`MERGE_QUEUE_SLEEP_SCALE 는 0 이상의 수다: ${scale}`)
    const opts = parseArgs(argv)
    queue = new Queue(opts)
    active = queue
    queue.setup()
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    if (!(e instanceof Usage)) throw e
    if (e.message) process.stderr.write(`${e.message}\n`)
    else out(usageText())
    return 2
  }
  try {
    return await queue.run()
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`${e.message}\n`)
    return 2
  } finally {
    queue.dropCopy()
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
    process.exitCode = 1
  },
)
