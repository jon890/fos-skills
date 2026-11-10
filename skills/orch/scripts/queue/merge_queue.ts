// 사용: merge_queue.ts [옵션] PR[:머지 전 명령] ...
//
// 받은 순서대로 PR 을 하나씩 머지한다. 조건에 못 미친 PR 은 이유를 찍고 큐에서 빼고 다음 PR 로 간다(아래 「보류」).
// 끝에 뺀 PR 이 있으면 종료 코드 1 이다. --stop-on-hold 면 첫 보류에서 멈춘다.
// base 와 충돌하는 PR 도 빼고 다음 PR 로 간다(아래 「충돌」). 묶음(--chain) 안에서는 앞 PR 이 빠지면 뒤 PR 도 뺀다.
// 차례 PR 이 update-branch 뒤 체크를 기다려야 하면 그동안 겹치지 않고 준비된 뒤 PR 을 먼저 머지한다(아래 「앞지르기」).
// PR 마다 하는 일:
//   1. 이미 MERGED 면 건너뛴다. OPEN 이 아니면 멈춘다
//   2. 필수 체크가 모두 나타나고 끝날 때까지 기다린다(--check-timeout 분까지. 진행 중인 체크 없이 필수 체크가 --missing-timeout 분 동안 나타나지 않으면 먼저 멈춘다).
//      PR 을 연 직후에는 체크 목록이 비어 있어 「대기 0」이 「모두 끝남」이 아니기 때문이다.
//      체크가 끝나면 새 체크가 붙는지 60초 뒤 다시 본다. 차례가 왔을 때 이미 모두 끝나 있었고 마지막 체크가 끝난 지
//      60초가 지났으면 그 대기를 건너뛴다(`<PR> 체크가 60초 넘게 전에 끝나 있어 다시 보는 대기를 건너뛴다`)
//      --require-up-to-date 이면 PR 이 base 최신을 품는지 보고, 아니면 base 를 merge 한 뒤 2 를 다시 한다
//      (--up-to-date-when overlap 이면 base 최신을 품지 않아도 단위가 겹치지 않으면 merge 없이 3 으로 간다)
//   3. 실패한 체크, 미해결 리뷰 스레드, 기능 완료 근거 블록 불일치(독립 리뷰 줄의 「대기」 포함)가 있으면 멈춘다. 충돌(mergeable 이 CONFLICTING)이면 큐에서 뺀다.
//      mergeable 이 UNKNOWN 이면 몇 번 다시 묻는다. 체크 대기를 넘지 못해도(실패, 시간 초과) 이 조건을 모두 보고, 걸린 이유를
//      `; ` 로 이어 STOP 줄 하나와 worker 에게 보내는 이유 하나에 낸다. 판정은 steps/gate.ts 의 gateReasons 이고 `orch queue gate`(gate.ts)가 같은 함수를 쓴다.
//      이 조건은 겹침 판정, 합친 사본 검사, before-merge 보다 먼저 본다
//      --allow-fail 로 준 체크의 실패는 세지 않고 경고 줄만 찍는다
//   3-1. --stop-on-overlap 이나 hooks/verify-merged.ts 가 있으면, PR 이 바꾼 파일과 PR 이 갈라진 뒤 base 에서 바뀐 파일이
//      겹치는지 본다. 겹치면 --stop-on-overlap 은 겹친 파일을 찍고 멈추고, verify-merged 핸들러는 base 와 합친
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
//                  hooks/verify-merged.ts 가 있으면 겹침 판정을 켠다
//   after-merge    7 의 자리
//   after-queue    큐가 끝난 자리. 실패와 시간 초과면 HOOK-FAIL 줄에 더해 `AFTER-MERGED-FAILED <종료 코드|timeout>` 이다
//   config.json 이 깨졌거나 삭제한 설정 키가 있거나, pipeline.authors 의 타입이나
//   큐가 낼 이벤트의 hooks.timeouts 값이 틀리면 첫 머지 전에 사용법 오류로 끝난다.
//   큐 도중에 설정 오류가 나면(핸들러 파일을 그 사이에 더했다 같은 것) 그 자리에서 멈추고 종료 코드 2 다.
//   이번 실행에서 머지한 PR 이 있으면 그 전에 after-queue만 돌리고 정리(cleanup-sweep)는 부르지 않는다.
//   보류로 멈출 때, 큐 끝의 after-queue 가 설정 오류를 낼 때와 같은 규칙이다
//
// 보류: 조건에 못 미친 PR 은 `STOP <PR> <이유>` 를 찍고 큐에서 뺀다. 기본은 다음 PR 로 가고(`<PR> 보류. 다음 PR 로 간다`),
//   --stop-on-hold 면 그 자리에서 앞서 머지한 PR 의 after-queue 만 돌리고 1 로 끝난다. 뺀 PR 과 이유는 차례 기록의 held 에 남는다.
//   기본 모드에서는 미해결 스레드와 검사 뒤 HEAD 변경으로 뺀 PR 만 정리 전에 한 번 다시 판정한다.
//   재판정의 CI 대기 합계는 PR 마다 최대 5분(--check-timeout 이 더 짧으면 그 값)이고, 실패한 체크 등 다른 보류는 다시 보지 않는다.
//   worker 가 고쳐야 하는 보류(기능 완료 근거 블록 불일치, 미해결 리뷰 스레드, 합친 사본 검사 실패. 이유가 여럿이면 모두 한 번에)는 그 PR 브랜치의 살아 있는 worker 에게
//   `PR #<PR> 을 머지 큐에서 뺐다: <이유>. 고쳐 push 한 뒤 status 로 알린다.` 를 보낸다(lib/tell-worker.ts). Run 은 --sweep-arg 로 준 --run 이고,
//   Run 이나 worker 가 없으면 `<PR> worker 에게 알리지 않…` 줄만 찍는다. 체크 실패와 충돌은 보내지 않는다. 상주 루프의 CI 감시와
//   충돌 처리가 그 worker 에게 이미 보낸다
//
// 앞지르기: --require-up-to-date 와 --up-to-date-when overlap 이고 --stop-on-hold 가 아닐 때만 한다. 차례 PR 이 update-branch 로 base 를
//   합쳐 체크를 다시 기다려야 하면, 기다리기 전에 그 뒤의 PR 을 차례로 보고 아래를 모두 채우는 PR 을 먼저 머지한다.
//   묶음(--chain)에 들지 않았다. 필수 체크가 지금 모두 통과했고 마지막 체크가 끝난 지 60초가 지났다. base 최신화가 필요 없다.
//   차례 PR 이 갈라진 뒤 바꾼 파일과 겹치지 않는다. 이름 변경은 --no-renames 로 옛 경로까지 본다(lib/overlap.ts 의 judge. 읽지 못하면 겹친 것으로 본다).
//   채우지 못한 PR 은 `<PR> 앞지르지 않는다: <이유>` 를 찍고 제 차례에 다시 본다. 채운 PR 은 보통 차례와 같은 확인을 거쳐 머지하거나 보류한다.
//   그 뒤 `<PR> 차례로 돌아와 체크를 기다린다` 를 찍고 차례 PR 로 돌아온다. 앞질러 머지한 PR 은 차례 PR 과 겹치지 않으므로
//   돌아온 차례 PR 은 다시 최신화하지 않는다. 겹치는 PR 을 앞질러 머지하면 차례 PR 이 다시 뒤처져 방금 돌린 CI 가 쓸모없어진다
//
// 체크 확인 간격: 진행 중인 체크를 다시 보기까지 --poll-min-sec(기본 60)에서 시작해 두 배씩 늘리고 --poll-max-sec(기본 300)에서 멈춘다.
//   --ci-expected-sec 를 주면 지금 도는 체크 가운데 가장 먼저 시작한 것에서 그 초가 지나는 시각을 넘겨 자지 않고, 그 뒤로는 --poll-min-sec 마다 본다.
//   CI 가 끝난 뒤 다음 확인까지 최대 간격만큼 늦게 알아채지 않게 하려는 것이다(lib/gh-budget.ts 의 queuePollSeconds)
//
// 차례 기록: 큐를 도는 동안 <orch 루트>/state/queue-turn/<pid>.json 에 남은 PR, 차례 PR, 단계, 단계 시작 시각을 적는다.
//   형식과 단계 이름은 lib/queue-turn.ts 가 소유한다. 상주 루프가 읽어, 큐 때문에 자동 머지를 미룬 틱에 큐가 무엇을 기다리는지
//   로그에 남기고(AUTO-MERGE-HELD), 차례 PR 은 미리 최신화하지 않는다. 차례 PR 의 HEAD 가 큐 밖에서 바뀌면 그 PR 이 STOP 으로 멈추기 때문이다.
//   큐가 끝나거나 신호로 끝나면 단계를 `끝` 으로 남긴다. 지우는 것은 상주 루프다. 쓰지 못해도 머지는 이어 가고 첫 실패만 stderr 에 경고한다
//
// 충돌: update-branch 가 충돌로 실패하거나 mergeable 이 CONFLICTING 인 PR 은 `CONFLICT <PR> <이유>` 를 찍고 큐에서 뺀다.
//   --stop-on-hold 여도 다음 PR 로 간다. 충돌한 PR 하나 때문에 머지할 수 있는 뒤 PR 이 함께 멈추지 않게 하기 위해서다.
//   정리 인자의 --run 으로 지정한 Run 에 QUEUE-CONFLICT 메시지를 보낸다. Run 이 없으면 로그에만 남긴다.
//   그 PR 의 worker 에게 base 를 합치라고 보내는 일은 상주 루프의 충돌 처리와 notify-conflicts.ts 가 한다(pr-conflict).
//   충돌로 뺀 PR 은 큐 끝에 `QUEUE-CONFLICT 번호...` 로 다시 모으고 `QUEUE-HELD` 에도 든다. 종료 코드는 1 이다.
//   update-branch 의 다른 실패(검사한 HEAD 와 다르다 같은 것)는 지금처럼 멈춘다
// 묶음: `--chain 101,102,103` 은 앞 PR 이 먼저 머지돼야 하는 PR 들이다(마이그레이션 순서 같은 것). 묶음 안 앞 PR 이 머지되지 않고
//   빠지면(충돌, 보류, 묶음으로 뺌) 뒤 PR 은 `SKIP <PR> 묶음의 앞 PR <번호> 가 머지되지 않았다` 를 찍고 머지하지 않는다.
//   묶음 밖의 PR 은 이어 머지한다. 묶음의 PR 은 큐에 있어야 하고 큐의 순서와 같은 순서로 적는다. PR 하나는 묶음 하나에만 든다
//
// origin 은 PR 이 속한 저장소를 가리켜야 한다. fork 를 origin 으로 둔 체크아웃에서는 HEAD 대조가 STOP 으로 끝난다.
//
// 옵션
//   옵션은 이름을 다 적어 `--옵션 값` 으로 준다. 옛 merge_queue.py 와 같이 고유 접두로 줄여 쓰거나 `--옵션=값` 으로 붙여 쓸 수 없다.
//   값은 `-` 로 시작해도 값으로 읽는다. 빈 값은 사용법 오류다. 값을 받는 옵션 목록은 lib/queue-options.ts 가 소유한다
//   --repo DIR            대상 저장소 경로. 기본은 현재 디렉터리. gh 호스트와 저장소는 이 저장소의 origin 이 정한다.
//                         gh 의 owner/name 이 아니라 로컬 경로다. git 작업 트리 안의 디렉터리가 아니면 사용법 오류다(lib/git.ts 의 repoArgProblem)
//                         `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 찾지 않고 기본 호스트(보통 github.com)로 간다.
//                         그래서 `gh api` 에는 PR URL 의 호스트(`gh pr` 가 origin 으로 정한 값)를 --hostname 으로 넘긴다.
//                         GH_HOST 환경 변수는 보지 않는다. 전역 GH_HOST 가 다른 호스트를 가리켜도 `gh pr` 와 같은 호스트로 간다
//   PR:명령              그 PR 의 before-merge 핸들러 다음에 시간 제한 없이 bash -c 로 실행한다.
//   --last-of-task PR     그 PR 이 task 의 마지막 PR 이다. before-merge 입력의 last_of_task 가 true 다. 여러 번 준다.
//                         큐에 없는 번호면 사용법 오류다
//   --method M            merge | squash | rebase. 기본 merge
//   --threads-cmd CMD     미해결 스레드 수를 정수로 내는 명령. 기본은 형제 스킬 review-fix 의 review_threads.ts
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
//   --verify-merged-when W  합친 사본 검사를 언제 할지. overlap(기본, 겹칠 때만), code(문서만 바꾼 PR 이 아니면 늘),
//                         always(모든 PR). 파일이 겹치지 않아도 합쳐서 깨질 수 있다(두 PR 이 각자 통과했지만 합치니
//                         같은 상한을 함께 넘었다). code 와 always 는 hooks/verify-merged.ts 가 있어야 한다
//   --docs-glob G1,G2     문서 파일의 glob. PR 이 바꾼 파일이 모두 이것에 맞으면 overlap 과 code 에서 합친 사본 검사 없이
//                         머지한다. 충돌은 mergeable 로 이미 걸렀다. case 패턴이라 `*` 가 `/` 도 넘는다
//                         (예: --docs-glob 'docs/*,*.md'). 여러 번 주면 이어 붙인다.
//                         hooks/verify-merged.ts, hooks/after-queue.ts, --update-docs-on-overlap 가운데 하나와 함께 쓴다
//   --update-docs-on-overlap  문서 PR 의 파일이 base 와 겹치면 GitHub mergeStateStatus 가 CLEAN 일 때 base 를 합치고
//                         필수 CI 를 다시 기다린다. --docs-glob 과 필수 체크 목록이 필요하다. --stop-on-overlap 과도 쓴다
//   --copy-dir DIR        임시 사본을 둘 폴더. 기본은 TMPDIR(없으면 /tmp). 상대경로는 --repo 기준이다.
//                         저장소 hook 이 워크트리 위치를 막으면 오버레이가 허용된 폴더를 준다.
//                         링크를 푼 실경로로 바꿔 쓴다. macOS 의 TMPDIR(/var/folders/...)는 /var 가 /private/var 를
//                         가리키는 링크라, 실경로를 요구하는 검사가 사본 경로를 거부한다. 검사 명령의 TMPDIR 도 실경로로 준다
//                         사본 이름은 merge-queue-pr<PR>-<pid> 다. 시작할 때 이 폴더에서 pid 가 죽은 사본을 지운다.
//                         SIGTERM 이나 SIGINT 로 끝나면 사본을 지우지만, KILL 로 끝나면 사본이 남기 때문이다
//   --stop-on-hold        한 PR 이 조건에 못 미치면 STOP 줄을 찍고 그 자리에서 멈춘다(옛 기본). 정리는 부르지 않는다.
//                         기본은 STOP 줄을 찍은 뒤 다음 PR 로 가고, 끝에 `QUEUE-HELD 번호...` 를 찍고 정리를 부른 뒤 종료 코드 1 로 끝난다
//   --continue-on-hold    기본과 같다. 옛 호출을 위해 받는다
//   --poll-min-sec N, --poll-max-sec N, --ci-expected-sec N  위 「체크 확인 간격」. 1 이상의 정수(초)다
//   --skipped-is-missing  결론이 SKIPPED 인 체크는 나타나지 않은 것으로 본다. 필수 체크가 SKIPPED 로만 있으면
//                         실제로 돌 때까지 기다린다. draft 에서는 CI 를 건너뛰게 둔 저장소용이다. 기본은 끔
//                         (GitHub 처럼 SKIPPED 를 통과로 본다). 필수 체크 목록이 있어야 뜻이 있다
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
// 신호: SIGTERM 이나 SIGINT 를 받으면 진행 중인 자식(`PR:명령`, --threads-cmd, 정리, 이벤트의 핸들러)에 TERM 을 보내고,
// 2초 뒤에도 살아 있으면 KILL 을 보낸다. 핸들러는 프로세스 그룹 전체에 보낸다(lib/proc.ts 의 stopChildren).
// 그 뒤 사본을 지우고 128 + 신호 번호로 끝난다. 그 사이에는 새 자식을 띄우지 않고, 머지와 base 합치기, base 옮기기,
// 원격 브랜치 삭제도 하지 않는다. git, gh 처럼 동기로 부르는 호출(머지 포함) 중에 받은 신호는 그 호출이 끝난 뒤 처리된다.
// `PR:명령`, --threads-cmd, 정리는 새 그룹(detached) 없이 띄우므로 TERM 과 KILL 이 그 자식에게만 간다. 복합 명령
// (`a; b`, 파이프)이 띄운 손자 프로세스는 남을 수 있다. 옛 명령은 이 자식도 끊지 않고 끝났다.
// 쓰는 gh 호출(머지, update-branch, base 옮기기)과 원격 브랜치 삭제는 옛 명령처럼 시간 제한이 없다. 읽는 gh 호출은 60초다.
//
// 머지 전 명령(`PR:명령`)과 --threads-cmd 는 bash -c 로 돈다. 환경 변수 PR(번호), BRANCH(head 브랜치),
// OWNER, REPO, GH_HOST(위 --hostname 과 같은 값)를 받는다.
// 예: merge_queue.ts 101 102:'./bin/backup-db.sh orders "pr-$PR"' 103
//
// 짧은 출력(진입점의 orch queue run, 또는 merge-with-finish 가 이어 준 신호, lib/output.ts): 시각 붙은 진행 줄 대신 `MERGED <PR>` 을 내고,
// 머지 실패는 gh 의 마지막 줄을 붙인 `STOP <PR> 머지 실패: <그 줄>`, `경고:` 줄은 `WARN <내용>` 이다. 정리(cleanup-sweep)에 신호를 넘긴다.
// 상주 루프는 이 명령을 경로로 불러 지금 출력 그대로 읽는다.
//
// 종료 코드: 0 모두 머지(또는 이미 MERGED), 1 어느 PR 에서 멈춤(기본은 보류한 PR 이 있음. 충돌이나 묶음으로 뺀 PR 이 있음.
//           3 보다 우선한다),
//           2 사용법 오류(설정 파일 오류, 삭제한 옵션, 큐에 없는 --last-of-task 포함),
//           3 모두 머지했지만 after-merge 나 after-queue가 하나라도 실패하거나 시간을 넘겼다,
//           143 SIGTERM 을 받았다, 130 SIGINT 를 받았다
//
// 큐 시작: 같은 저장소의 state/merge-queue.lock 을 wx 로 잡는다. 다른 큐가 돌면 QUEUE-BUSY 이유와 코드 2 로 거절한다.
//   정상 종료와 SIGTERM/SIGINT 에 잠금을 풀고, 죽은 pid 나 시작 시각·명령줄이 달라진 pid 의 잠금은 다음 실행이 회수한다. 워크트리도 주 checkout 의 잠금을 쓴다.
//   migrations 설정이 있으면 queueOrder 로 낮은 번호부터 정렬하고 자동 --chain 을 만든다. 수동 묶음도 함께 지키되 모순되면 코드 2 다.
//   순서가 바뀌면 QUEUE-ORDER <번호...>: <이유> 를 낸다. 설정이 없으면 입력 순서를 유지한다.
//   gate 와 머지 직전에 새 origin/<base> 의 최고 번호를 judgeMigrations 로 확인한다. 최고 이하이면 --again 안내와 함께 worker 에게 보류를 보낸다.
//
// MERGE_QUEUE_SLEEP_SCALE 는 모든 대기 시간에 곱할 배율이다(기본 1). tests 가 0 으로 둔다.

import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from '../lib/config.ts'
import { repoArgProblem } from '../lib/git.ts'
import { run, signalCode, stopChildren, withRun } from '../lib/proc.ts'
import { TURN_PHASES } from '../lib/queue-turn.ts'
import { afterQueue, stopOnConfig, sweep } from './steps/finish.ts'
import type { StepContext } from './steps/model.ts'
import { StepState, Usage } from './steps/model.ts'
import { parseArgs, usageText } from './steps/options.ts'
import { endTurn, turn } from './steps/pr.ts'
import { out } from './steps/runtime.ts'
import { selectQueue } from './steps/select.ts'
import { dropCopy, setup, unlockQueue } from './steps/setup.ts'

const SCRIPT = fileURLToPath(import.meta.url)
const stepContext: StepContext = { script: SCRIPT, here: dirname(SCRIPT), sleepScale: 1 }

async function runQueue(stepContext: StepContext, state: StepState): Promise<number> {
  const selected = await selectQueue(stepContext, state)
  Object.assign(state, selected.changes)
  if (selected.kind === 'config') return await stopOnConfig(stepContext, state, selected.error)
  turn(stepContext, state, TURN_PHASES.after, null)
  if (selected.kind === 'done') {
    if (state.conflicted.length > 0) out(`QUEUE-CONFLICT ${state.conflicted.join(' ')}`)
    out(state.held.length > 0 ? `QUEUE-HELD ${state.held.join(' ')}` : 'QUEUE-DONE')
  }
  // 보류로 멈춰도 앞에서 머지한 PR 의 머지 뒤 명령은 돌린다.
  const after = await afterQueue(stepContext, state)
  Object.assign(state, after.changes)
  if (after.kind === 'config') throw after.error
  if (selected.kind === 'held') return 1
  if (state.o.sweep) Object.assign(state, (await sweep(stepContext, state)).changes)
  if (state.held.length > 0) return 1
  return state.afterFailed || state.notifyFailed ? 3 : 0
}

let active: StepState | null = null

// 동기 자식 실행(spawnSync) 중에는 신호 처리기가 돌지 않는다. 오래 걸리는 사용자 명령과 대기는 비동기로 부르므로
// 그동안 받은 신호는 바로 처리되고, 짧은 git, gh 조회 중에 받은 것은 그 호출이 끝난 뒤 처리된다.
// 진행 중인 자식을 끊은 뒤에 끝낸다. 그냥 끝내면 핸들러의 프로세스 그룹(detached)과 bash -c 자식이 남는다
let exiting = false
function onSignal(signal: NodeJS.Signals): void {
  if (exiting) return
  exiting = true
  void stopChildren(signal).finally(() => {
    active && dropCopy(stepContext, active)
    active && endTurn(stepContext, active)
    active && unlockQueue(active)
    process.exit(signalCode(signal))
  })
}
// active, stepContext, exiting 은 이 모듈의 상태다. main 은 프로세스마다 한 번만 호출한다.
// 같은 프로세스에서 재호출하거나 동시에 호출하지 않는다. 테스트도 호출별 프로세스로 격리한다.
export function main(argv: string[], runner?: typeof run): Promise<number> {
  return runner ? withRun(runner, () => mainImpl(argv)) : mainImpl(argv)
}

async function mainImpl(argv: string[]): Promise<number> {
  let queue: StepState
  try {
    const scale = process.env.MERGE_QUEUE_SLEEP_SCALE ?? '1'
    stepContext.sleepScale = Number(scale)
    // 옛 명령은 float() 로 읽지 못하면 시작하지 못했다. 빈 값을 0 으로 읽으면 모든 대기가 사라져 체크 대기가 바로 끝난다
    if (!scale.trim() || !Number.isFinite(stepContext.sleepScale) || stepContext.sleepScale < 0) throw new Usage(`MERGE_QUEUE_SLEEP_SCALE 는 0 이상의 수다: ${scale}`)
    const opts = parseArgs(argv)
    const repoProblem = repoArgProblem(opts.repo)
    if (repoProblem) throw new Usage(repoProblem)
    queue = new StepState(opts)
    active = queue
    const prepared = await setup(stepContext, queue)
    Object.assign(queue, prepared.changes)
    if (prepared.kind === 'error') throw prepared.error
    // 래퍼가 시작 전 거절과 머지 도중 설정 오류를 구분한다. 파일은 래퍼가 임시 폴더에서 만들고 지운다.
    if (process.env.MERGE_QUEUE_ACCEPTED_FILE) writeFileSync(process.env.MERGE_QUEUE_ACCEPTED_FILE, '1')
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`)
      return 2
    }
    if (!(e instanceof Usage)) throw e
    if (e.message) process.stderr.write(`${e.message}\n`)
    else out(usageText(stepContext))
    return 2
  }
  try {
    return await runQueue(stepContext, queue)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    process.stderr.write(`${e.message}\n`)
    return 2
  } finally {
    dropCopy(stepContext, queue)
    endTurn(stepContext, queue)
    unlockQueue(queue)
  }
}

if (import.meta.main || (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) {
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e) => {
      process.stderr.write(`${(e as Error)?.stack ?? String(e)}\n`)
      process.exitCode = 1
    },
  )

}
