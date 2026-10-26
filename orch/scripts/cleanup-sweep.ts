// 머지가 끝난 worktree 와 로컬 브랜치, 그 worker 터미널과 지시서를 찾아 정리한다.
//
// 머지마다 수동으로 정리하면 잊히고, 프로세스가 worktree 를 잡고 있어 그 자리에서 실패한 것은 다시 돌아보지 않는다.
// 이 명령은 상태로만 판정하므로 몇 번을 돌려도 같다. 건너뛴 항목은 다음 실행에서 다시 판정된다.
// 사용자가 말하지 않아도 깨어날 때마다 돈다. 코디네이터가 끝난 항목을 직접 지우지 않는다.
//
// 사용법 (기본은 dry-run. 무엇을 할지만 낸다):
//     cleanup-sweep.ts --repo DIR [--repo DIR ...] [--base main] [--run RUN_ID] [--specs-dir DIR] [--kill-holders]
//                      [--agent-glob 'agent-*'] [--close-own-taken-over] [--remote-branches] [--trash DIR] [--wait SEC] [--poll-interval SEC] [--apply]
//
//     --repo        대상 저장소의 기본 체크아웃. 여러 번 줄 수 있다. 여기서 git worktree 목록과 gh 를 읽는다.
//                   하나를 읽지 못해도 나머지는 돌고, 종료 코드만 2 가 된다
//     --base        기준 브랜치. 없으면 저장소마다 origin/HEAD 를 읽고, 그것도 없으면 main
//     --run         worker 를 찾을 Orca Run. 없으면 worker 확인과 release 를 건너뛰고 터미널만 경로로 찾는다.
//                   주면 다른 Run 의 worker 터미널이 있는 경로는 건너뛴다(아래 「다른 Run」)
//     --specs-dir   지시서 폴더(저장소 기준 상대경로 또는 절대경로). worktree 이름과 같은
//                   `<이름>.md` 와 `spec-<이름>.md` 를 지운다. 없으면 지시서는 건드리지 않는다.
//                   살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서는 지우지 않는다(lib/spec.ts 의 liveSpecPaths).
//                   그 목록을 읽지 못하면 이번 실행에서는 지시서와 PR 본문을 하나도 지우지 않는다.
//                   같은 폴더의 부모(`<specs-dir>/..`)에 있는 그 PR 의 본문 파일 `pr-<이름>.md` 도 지운다.
//                   이름은 worktree 이름, 브랜치의 `/` 를 `-` 로 바꾼 것, 브랜치의 첫 `/` 뒤, PR 번호다.
//                   고르기와 지우기는 lib/spec.ts 의 specCandidates 와 deleteSpecs 다
//     --kill-holders  터미널을 닫은 뒤에도 그 경로를 쓰는 프로세스를 끈다(아래 「남은 프로세스 끄기」)
//     --agent-glob  하위 에이전트 워크트리 폴더 이름의 glob. 기본 `agent-*`(아래 「하위 에이전트 워크트리」)
//     --close-own-taken-over
//                   --run 과 함께 줄 때만 쓴다. 이 Run 의 끝난 dispatch 가 쓴 터미널이 `user_takeover` 로 남았어도
//                   아래 「넘겨받은 터미널」 조건을 모두 채우면 닫고 정리한다. 없으면 예전처럼 남긴다
//     --remote-branches
//                   저장소마다 워크트리와 로컬 브랜치 정리가 끝난 뒤, 로컬 브랜치가 없어도 내 PR 의 원격 브랜치를 지운다
//                   (아래 「원격 브랜치 삭제」 의 --remote-branches). 없으면 하지 않는다
//     --trash       머지 큐 로그를 옮길 휴지통 폴더(아래 「머지 큐 로그」). 기본 ~/.Trash/orch-cleanup-<날짜>
//     --wait        터미널을 닫은 뒤 프로세스가 빠지기를 기다리는 초. 0 이상의 유한한 수. 기본 5
//     --poll-interval  프로세스 확인 간격(초). 0 초과의 유한한 수. 기본 1
//     --apply       실제로 정리한다
//     옵션은 고유 접두로 줄여 쓸 수 있다(lib/args.ts)
//
// PR 찾기 (브랜치마다):
//     로컬 브랜치 이름과 PR 의 head 브랜치 이름이 다르면(`<user>/<접두>-<주제>` 와 `<접두>/<주제>`) 이름 하나로는 못 찾는다.
//     아래 순서로 `gh pr list --head` 를 부르고 처음 나온 PR 을 쓴다. fork 에서 온 PR 은 건너뛴다.
//       1. 브랜치의 upstream 에서 읽은 원격 브랜치 이름
//       2. `git config branch.<b>.merge`
//       3. 로컬 브랜치 이름
//       4. 이름 변형(사용자 접두 제거, 첫 하이픈을 슬래시로). 지시서의 브랜치 이름으로 만들지 않은 옛 워크트리용이다
//     어느 이름으로 찾았든 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 을 쓴다.
//     base 위 커밋이 0 개인 브랜치는 끝 커밋이 PR HEAD 와 정확히 같을 때만 쓴다.
//     단, 머지 큐의 update-branch 뒤 merge commit 으로 머지돼 base 위 커밋이 0 개가 된 브랜치는 끝 커밋이
//     `gh pr view --json commits` 의 커밋 목록에 있을 때 그 PR 의 브랜치로 본다. 막 만든 브랜치의 끝 커밋은
//     base 의 옛 커밋이라 목록에 없고, 목록을 읽지 못해도 인정하지 않는다.
//     예전에 머지된 PR 과 이름만 같은 새 브랜치를 「머지됨」 으로 읽어 일하는 워크트리를 지우지 않으려는 것이다.
//     이름은 맞는데 이 검사에 걸린 PR 만 있으면 「이름만 같은 PR」 로 보고 PR 없음과 같이 다룬다.
//     조회 결과는 JSON 으로 읽는다. 빈 목록이면 「PR 없음」 이고, JSON 이 아니거나 필드가 없으면 「조회 실패」 다.
//     둘 다 머지로 읽지 않는다. PR HEAD 가 로컬에 없으면(머지 큐의 update-branch 로 앞서 간 경우) `refs/pull/<번호>/head` 를 받아 온다.
//     조회 필드의 title, isDraft, url 은 before-cleanup 의 pr 입력을 채우는 데만 쓰고 판정에는 쓰지 않는다.
//     author 는 그 입력과, CLOSED PR 이 내 PR 인지 가리는 데 쓴다(아래 「내 PR」).
//
// 정리 대상 (브랜치마다):
//     - 그 브랜치의 PR 이 MERGED 다
//     - PR 이 없거나 MERGED 가 아니면, upstream 이 gone 이고 `git cherry` 로 base 에 없는 커밋이 0 개다
//     - 머지 없이 CLOSED 가 된 PR 의 터미널(아래 「머지 없이 CLOSED 가 된 PR 의 터미널」). 워크트리는 위 판정을 따른다
//     - PR 없이 끝난 워크트리(아래 「PR 없이 끝난 워크트리」)
//
// 내 PR:
//     lib/gh.ts 의 ownAuthors 와 isOwnPr 로 가린다. 작성자는 config.json 의 pipeline.authors, 없으면 그 호스트의 gh 현재 사용자다.
//     호스트는 `gh repo view --json url` 의 URL 을 apiTarget 으로 읽는다.
//     목록은 --remote-branches 를 받았거나, 이 Run 의 끝난 worker 가 있는 CLOSED PR 을 처음 만났을 때 저장소마다 한 번 읽는다.
//     무조건 읽으면 pipeline.authors 가 없는 저장소의 모든 정리가 gh 현재 사용자를 조회하고, 그 조회가 실패하면 2 로 끝난다.
//     읽지 못하면(null 이거나 ConfigError) 그 저장소에서 원격 브랜치 정리와 CLOSED PR 의 터미널 정리를 하지 않고
//     stderr 에 이유를 내고 종료 코드를 2 로 둔다. 누가 내 PR 인지 모른 채 지우거나 닫지 않는다.
//
// 머지 없이 CLOSED 가 된 PR 의 터미널 (--run 을 줬을 때만):
//     worker 터미널은 worker_done 뒤에도 그 PR 이 머지되거나 닫힐 때까지 남긴다. 충돌과 리뷰 반영을 같은 worker 가 이어 받는다.
//     PR 찾기로 찾은 PR 이 아래를 모두 채우면 그 dispatch 가 쓴 터미널을 닫고 dispatch 를 반납한다.
//       - state 가 CLOSED 다(MERGED 가 아니다)
//       - 내 PR 이다
//       - --run 으로 찾은 그 경로의 worker 가 하나 이상이고 모두 workerState 가 succeeded 나 fenced 다
//       - 터미널 소유 확인(lib/ownership.ts)을 통과한다. 사용자 보유 터미널이면 `남김: 사용자 보유 터미널` 이다
//     닫는 터미널은 그 worker 행의 terminalHandle 과 agentTerminalHandle 가운데 그 경로에 살아 있는 것이다.
//     모든 Run 의 worker 를 읽지 못했으면 agentTerminalHandle 만 닫는다.
//     같은 경로의 다른 터미널과 다른 Run 의 worker 가 쥔 터미널은 닫지 않는다. --apply 가 없으면 `닫을 것: <터미널> (CLOSED #<PR>)` 만 낸다.
//       - 워크트리가 지우기 대상이 아니면 터미널을 닫고 dispatch 를 반납한 뒤 `남김 <경로>: <이유>` 를 낸다
//       - 지우기 대상(upstream 이 없고 cherry 가 0)이면 살아 있는 worker 와 살아 있는 터미널 판정에서 MERGED PR 과 같게 다루고,
//         `정리` 줄과 before-cleanup 뒤에 터미널을 닫는다. before-cleanup 이 거부하면 터미널도 닫지 않는다
//       - cherry 판정은 통과했는데 커밋 안 된 변경이나 원격에 없는 커밋으로 `건너뜀` 이 되면 터미널을 닫지 않고 dispatch 도 반납하지 않는다.
//         그 변경과 커밋은 그 터미널의 worker 가 만든 것일 수 있어, 워크트리와 함께 남겨 다음 실행이 다시 판정한다
//     --kill-holders 와 --merged-head 는 MERGED 일 때만이다. CLOSED PR 의 head 는 머지된 커밋이 아니다.
//     열린 PR 의 끝난 dispatch 터미널은 그대로 남긴다.
//
// 코디네이터가 띄운 터미널 (--run 을 줬을 때만):
//     `launch-worker.ts` 가 띄운 worker 는 dispatch 마다 기록이 남는다(lib/launched.ts). Orca 는 끝난 worker 의 터미널에 입력이 들어가면
//     `user_owned` 로 적어, 코디네이터가 띄웠고 사람이 넘겨받은 적 없는 터미널도 「사용자 보유 터미널」 로 보였다.
//     아래가 모두 참인 터미널은 소유 확인에서 뺀다. 그다음 PR 상태, 남은 커밋, 변경으로 정리를 판단한다.
//       - --run 으로 찾은 그 경로의 worker 행의 dispatchId 에 기록이 있다
//       - 기록한 워크트리가 이 경로이고, 기록한 터미널이 있으면 그 행이 가리키는 터미널이다
//       - 그 행의 dispatchStatus 가 completed, failed, canceled 다
//       - 같은 터미널을 끝나지 않은 dispatch 가 이어 쓰지 않는다
//     기록이 없는 터미널(사람이 연 것, 기록 도입 전에 띄운 것)은 예전처럼 「남김: 사용자 보유 터미널」 이다.
//     터미널을 닫는 시점은 그대로 PR 이 MERGED 일 때(아래 PR 없는 경우는 따로)이고, 워크트리를 지우면 그 dispatch 의 기록도 지운다.
//
// PR 없이 끝난 워크트리 (--run 을 줬을 때만):
//     측정처럼 PR 을 만들지 않는 지시서는 PR 이 없고 upstream 이 남아 있어 위 정리 대상 판정을 통과하지 못했다.
//     PR 이 「없음」 이면(조회 실패는 아니다. 이름만 같은 PR 은 없음과 같다) 아래가 모두 참일 때 치운다.
//       - 그 경로의 worker 행이 하나 이상이고 모두 dispatchStatus 가 completed 다. failed 나 canceled 는 같은 워크트리로 다시 맡길 수 있어 뺀다
//       - 브랜치에 origin/<기준> 보다 앞선 커밋이 없다
//       - 커밋 안 된 변경이 없다
//       - 브랜치가 쓰는 원격 브랜치(upstream, `branch.<b>.merge`, 로컬 이름)가 있으면 그것도 앞선 커밋이 없다
//     원격 브랜치도 위 조건을 채웠을 때만 지운다(원격 브랜치 삭제의 끝점 확인은 그대로다).
//     하나라도 아니면 남기고 `남김 <경로>: PR 없음, upstream 이 남아 있다. 치우지 않는 이유: <이유>` 를 낸다.
//     그 경로의 터미널은 위 「코디네이터가 띄운 터미널」 만 닫는다. 기록 없는 터미널이 있으면 `살아 있는 터미널이 있다` 로 남긴다.
//     터미널을 닫은 뒤 Orca 가 다시 연 빈 셸은 MERGED 일 때와 같게 닫는다
//
// 머지 큐 로그 (저장소마다 워크트리와 브랜치 정리 뒤에 한 번. --run 이 없어도 한다):
//     <orch>/queue(lib/paths.ts 의 queue, merge-with-finish.ts 의 --finish-log-dir 기본값)에 남은 끝난 로그를 휴지통으로 옮긴다.
//     지우지 않고 handoff-cleanup.ts 와 같은 방식(--trash, <휴지통>/queue/<이름>)으로 옮긴다.
//     마무리 로그(finish-<PR>.out 과 .pid), 머지 큐 로그의 조건과 실패 로그를 남기는 시간은 lib/queue-logs.ts 머리 주석이 소유한다.
//     돌고 있는 프로세스의 로그와 모르는 파일은 건드리지 않는다. 출력은 `머지 큐 로그를 휴지통으로 옮길 것`, `머지 큐 로그 옮김`, `머지 큐 로그를 남긴다` 다.
//
// 건너뜀 (이유를 낸다):
//     - 커밋 안 된 변경이 있다
//     - 원격에도 머지된 PR HEAD 에도 없는 커밋이 있다
//     - 살아 있는 worker 가 그 worktree 를 맡고 있다. workerState 가 working 이나 ready 이면 살아 있다고 본다.
//       PR 이 MERGED 가 아닌 브랜치(cherry 판정)는 Dispatch 상태와 상관없이 그 worker 의 터미널이
//       `orca terminal list` 에 살아 있어도 살아 있다고 본다.
//       Dispatch 가 succeeded 여도 같은 터미널에서 후속 일을 하는 worker 가 있고,
//       그 브랜치가 막 만든 상태(base 와 같고 커밋 0)면 머지 판정을 통과해 일하는 worker 를 지우게 된다.
//       PR 이 MERGED 인 브랜치는 workerState 가 working, ready 가 아니면 남은 터미널만으로 건너뛰지 않는다.
//       worker 의 Claude 세션 터미널은 일이 끝나도 목록에 남기 때문이다. 그 터미널은 아래에서 닫는다
//     - --run 을 줬고, 그 경로에 다른 Run 의 worker 터미널이 있다(아래 「다른 Run」)
//     - 터미널을 닫은 뒤에도 그 경로를 작업 디렉터리로 쓰는 프로세스가 있다. 다음 실행에서 다시 시도한다.
//       OMC session-end hook worker 는 세지 않는다. 스스로 끝나므로 `remove-worktree.ts` 가 끝날 때까지 기다린다
//       단, PR 이 MERGED 이고 남은 프로세스가 전부 자식 없는 로그인 셸(Orca 가 worker 를 반납한 뒤 띄운 빈 셸)이고
//       그 경로에 Orca 터미널이 있으면, 그 터미널을 `orca terminal close` 로 닫고 한 번 더 기다린다
//     - before-cleanup 핸들러가 거부하거나 실패하거나 시간을 넘겼다(아래 「이벤트」)
//
// 저장소 밖 detached 워크트리:
//     worker 가 기준선 비교나 임시 검사로 저장소 밖(임시 폴더 같은 곳)에 만든 detached 워크트리는 끝나도
//     `git worktree remove` 를 하지 않아 남는다. 브랜치가 없어 위 판정에 걸리지 않는다.
//     먼저 `git worktree prune` 으로 폴더가 이미 없는 등록을 지운다(dry-run 은 `-n` 으로 무엇을 지울지만 낸다).
//     그다음 저장소 폴더 밖의 detached 워크트리마다 아래가 모두 참이면 `git worktree remove` 로 지운다.
//       - 커밋 안 된 변경이 없다
//       - 그 경로를 작업 디렉터리로 쓰는 프로세스가 없고, 그 경로에 Orca 터미널이 없다
//       - HEAD 가 원격 추적 브랜치 어딘가에 들어 있다. 아니면 그 커밋이 사라진다
//     저장소 폴더 안(`worktrees/` 아래 같은 곳)의 detached 워크트리는 코디네이터가 쓰는 것일 수 있어 건드리지 않는다.
//
// 하위 에이전트 워크트리 (--agent-glob):
//     하위 에이전트가 만든 워크트리에는 Orca 가 빈 셸 터미널을 띄운다. 그 터미널은 어느 Run 의 worker 도 아니다.
//     --run 을 줬는데 모든 Run 의 worker 를 읽지 못하면 그 터미널을 「다른 Run 의 것인지 확인하지 못한 터미널」 로 보고
//     경로를 건너뛰어, 하위 에이전트 워크트리가 머지된 뒤에도 남았다.
//     폴더 이름이 glob 에 맞고, 그 경로를 쓰는 프로세스가 모두 자식 없는 로그인 셸이면 그 터미널은 빈 셸로 보고
//     다른 Run 의 것으로 세지 않는다. claude 나 node 가 도는 worker 터미널은 이 조건에 걸리지 않는다.
//     다른 Run 의 worker 로 확인된 터미널은 그대로 건너뛴다. 터미널을 닫는 조건(PR 이 MERGED)은 같다.
//     glob 은 Python fnmatch 와 같게 `*`, `?`, `[...]`, `[!...]` 를 받고 대소문자를 가린다.
//
// 빈 셸 (--run 을 줬는데 모든 Run 의 worker 를 읽지 못하고, 이 Run 의 dispatch 가 쓴 워크트리의 PR 이 MERGED 일 때):
//     코디네이터가 끝난 worker 터미널을 닫으면 Orca 가 그 탭에 에이전트 없는 셸(「Terminal 1」)을 다시 연다.
//     남은 터미널이 모두 `agentIdentity` 가 없고, 그 경로를 쓰는 프로세스가 모두 자식 없는 로그인 셸이며
//     터미널마다 셸이 하나씩 있으면 빈 셸로 보고 `빈 셸을 닫았다: term_…` 를 남긴 뒤 정리를 이어 간다.
//     하나라도 확인하지 못하면 건너뛴다. --apply 가 없으면 닫지 않고 닫을 것만 낸다.
//
// 넘겨받은 터미널 (--close-own-taken-over 와 --run):
//     worker 가 끝나 claude 가 빠진 뒤 그 터미널에 입력이 들어가면 Orca 가 `user_owned` / `user_takeover` 로 기록한다.
//     사용자가 의도해 넘겨받은 것과 이 자동 기록은 Orca 의 필드로 가를 수 없어, 기본은 남긴다.
//     코디네이터가 그 워크트리가 자기 worker 것임을 알고 옵션을 켰을 때만, 아래가 모두 참인 터미널을 소유 확인에서 뺀다.
//       - --run 으로 찾은 dispatch 이고 `dispatchStatus` 가 completed 다(workerState 는 succeeded)
//       - 그 터미널의 `ownershipState` 가 user_owned, `retainedReason` 이 user_takeover 다
//       - `orca terminal list` 의 그 터미널에 `agentIdentity` 가 없다
//       - 그 경로를 쓰는 프로세스가 모두 자식 없는 로그인 셸이다
//     하나라도 아니면 예전처럼 「남김: 사용자 보유 터미널」 이다. 닫는 시점은 PR 이 MERGED 일 때뿐이다.
//
// 다른 Run (--run 을 줬을 때):
//     터미널은 경로로 찾으므로, 같은 저장소에서 다른 코디네이터(Codex run 같은 것)가 띄운 worker 터미널도 걸린다.
//     모든 Run 의 worker 행(lib/ownership.ts 의 allWorkers)에서 terminalState 가 active 인 행을 골라
//     --run 과 다른 Run 의 worker 가 쥔 터미널이 그 경로에 있으면 그 경로를 통째로 건너뛴다. 그 Run 의 코디네이터가 정리한다.
//     범위 없는 worker-list 가 부른 터미널에 묶인 Run 만 주면(scope bound, 코디네이터에서 부르면 늘 그렇다)
//     `run-list` 를 따라 Run 마다 `worker-list --run` 으로 읽어 합친다. 터미널 소유 확인과 같은 행을 쓰고, 읽은 지 60초가 지나면 다시 읽는다.
//     그 조회가 실패하면 이 Run worker 의 터미널만 닫고, 다른 터미널이 있는 경로는 건너뛴다.
//
// 남은 프로세스 끄기 (--kill-holders):
//     `worker-stop` 이 `process=none` 을 돌려줘도 그 worker 의 claude 세션, 로그인 셸, 플러그인 node, Gradle 같은
//     프로세스가 그 경로를 작업 디렉터리로 쥐고 남아 `remove-worktree.ts` 가 매번 거부한다.
//     이 옵션은 아래가 모두 참일 때만 그 프로세스를 TERM, HUP, KILL 순으로 끈다. 신호마다 --wait 초(최소 --poll-interval 초) 기다리고,
//     그때도 그 경로를 쓰는 pid 만 다시 골라 다음 신호를 보낸다. 로그인 셸은 TERM 을 무시해 HUP 이 필요하다.
//       - PR 이 MERGED 다
//       - --run 으로 찾은 그 경로의 worker 가 하나 이상이고, 모두 workerState 가 succeeded 나 fenced 다
//       - 그 경로에 Orca 터미널이 남아 있지 않다
//       - 프로세스의 작업 디렉터리가 그 경로이거나 그 아래다
//     하나라도 거짓이면 끄지 않고 이유를 낸다. 위가 참이어도 아래 프로세스는 빼고 끈다.
//       - 이 명령과 그 조상
//       - 그 경로 안에 놓인 다른 워크트리를 작업 디렉터리로 쓰는 프로세스
//       - 조상에 Orca(`Orca.app/` 아래 실행 파일), `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있는 것.
//         Orca 터미널은 `Orca` → `Orca Helper` → `login` → 로그인 셸로 이어진다(실측). iTerm 이나 VS Code 에서
//         그 폴더로 들어간 사용자 셸과 language server 는 조상이 그 앱이라 빠진다. 부모를 잃어 launchd(pid 1)
//         아래로 간 프로세스는 끈다
//     열린 파일로만 그 경로를 쥔 프로세스는 끄지 않는다.
//     워크트리 삭제를 막는 것은 작업 디렉터리이고, 작업 디렉터리가 밖에 있는 Gradle daemon 같은 프로세스는
//     다른 워크트리의 빌드도 맡을 수 있다.
//
// 기준 브랜치 따라가기 (저장소마다 맨 처음):
//     기본 체크아웃이 기준 브랜치에 있고 origin/<기준> 의 조상이면 `git merge --ff-only` 로 맞춘다.
//     로컬에만 있는 커밋이 있거나 다른 브랜치가 체크아웃돼 있으면 건드리지 않고 이유를 낸다.
//     기준 브랜치가 뒤처지면 그 위에서 계획한 worker 가 옛 코드를 본다.
//
// 실행 순서 (worktree 마다):
//     그 경로의 Orca 터미널 close(PR 이 MERGED 일 때만. 머지 없이 CLOSED 가 된 내 PR 이면 그 dispatch 의 터미널만. PR 없이 끝난 워크트리면 코디네이터가 띄운 터미널만), 끝난 Dispatch release, `remove-worktree.ts --delete-branch --merged-head`,
//     원격 브랜치 삭제(이미 없으면 통과), 지시서와 PR 본문 파일 삭제.
//     remove-worktree.ts 는 lib/proc.ts 의 scriptCommand 로 같은 폴더의 것을 부른다.
//     기준 브랜치, `release/*`, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다.
//     worktree 없이 남은 로컬 브랜치도 같은 조건으로 판정해 지운다. 로컬 브랜치 없이 직접 머지한 PR 과
//     다른 PR 에 합쳐 닫힌 PR 의 원격 브랜치는 `--remote-branches` 가 지운다.
//
// 원격 브랜치 삭제:
//     지울 이름은 PR 의 head 브랜치, upstream, `branch.<b>.merge`, 로컬 이름이다. 이름마다 기준 브랜치, `release/*`,
//     다른 열린 PR 의 base 는 지우지 않는다. 원격 끝점이 머지된 PR HEAD(PR 이 없으면 로컬 브랜치 끝점)와 다르면
//     그 뒤에 커밋이 더해진 것이므로 지우지 않는다. fork 에서 온 PR 의 head 이름은 쓰지 않는다.
//
//     --remote-branches 는 로컬 브랜치와 상관없이 내 PR 의 원격 브랜치를 판정한다. 기본은 지울 것만 보이고,
//     --apply 이면 `git push origin --delete` 로 지운다. 판정한 끝점을 --force-with-lease 로 걸어, 그사이 push 된 브랜치는 지우지 않는다.
//     후보는 작성자마다 `gh pr list --state closed --author <작성자> --limit 100`(MERGED 와 CLOSED 가 함께 온다),
//     `git ls-remote --heads origin` 한 번, 열린 PR 의 base 와 head(`gh pr list --state open --limit 1000`) 한 번,
//     로컬 브랜치와 그 upstream(`git for-each-ref refs/heads/`) 한 번으로 읽는다.
//     하나라도 읽지 못하면 그 저장소의 원격 브랜치를 지우지 않고 `원격 브랜치 정리 건너뜀: <이유>` 를 내고 종료 코드를 2 로 둔다.
//     열린 PR 이 limit 과 같은 1000 개 읽혔으면 목록이 잘렸을 수 있어 읽지 못한 것과 같게 다룬다.
//     원격에 있는 이름마다 한 번 판정한다. 그 이름을 head 로 둔 PR 가운데 headRefOid 가 원격 끝점과 같은 PR 을 쓴다.
//     원격에 없는 이름은 줄을 내지 않는다. 위에서부터 처음 걸린 줄로 정한다.
//
//       차례  조건                                                         걸리면
//       1     그 이름의 PR 가운데 isCrossRepository 가 true 인 것이 있다   `fork 의 브랜치다` 로 남긴다
//       2     이름이 기준 브랜치이거나 `release/` 로 시작한다              `보호 브랜치다` 로 남긴다
//       3     남은 워크트리의 브랜치이거나 그 upstream 이다                `워크트리가 쓴다` 로 남긴다
//       4     워크트리 없는 남은 로컬 브랜치의 upstream 이다               `로컬 브랜치가 쓴다` 로 남긴다
//       5     끝점이 같은 PR 이 없다                                       `원격 끝점이 PR head 와 다르다` 로 남긴다
//       6     열린 PR 의 base 다                                           `열린 PR 의 base 다` 로 남긴다
//       7     열린 PR 의 head 다(지우면 그 PR 이 닫힌다)                   `열린 PR 의 head 다` 로 남긴다
//       8     MERGED 다                                                    지운다
//       9     CLOSED 이고 `git merge-base --is-ancestor <headRefOid>        지운다. head 커밋이 로컬에 없으면 먼저 `git fetch -q origin <headRefName>`
//             origin/<baseRefName>` 가 0 이다(다른 PR 에 합쳐 닫혔다)        로 받는다. 받지 못하면 `head 커밋을 받지 못했다`,
//                                                                          origin/<baseRefName> 이 없으면 `base 를 찾지 못했다` 로 남긴다
//       10    그 밖(CLOSED 이고 head 가 base 에 없다. 버린 작업일 수 있다)  `CLOSED 이고 head 가 base 에 없다` 로 남긴다
//
//     3 과 4 는 워크트리와 로컬 브랜치 정리가 끝난 뒤의 목록으로 본다. 남은 브랜치는 아직 그 원격 브랜치로 push 할 수 있다.
//     dry-run 은 워크트리를 지우지 않으므로, 이번에 지울 워크트리의 원격 브랜치도 3 으로 남긴다고 낸다.
//     그 원격 브랜치는 워크트리 정리의 「원격 브랜치 삭제」 가 지운다
//
//     origin/<baseRefName> 은 저장소마다 처음에 하는 `git fetch -q --prune origin` 이 갱신한 원격 추적 브랜치다.
//     출력은 `원격 브랜치 남김 <이름>: <이유>`, `원격 브랜치를 지울 것 <이름> (#<PR> <state>)`,
//     `원격 브랜치 삭제 <이름> (#<PR> <state>)`, `원격 브랜치 삭제 실패 <이름>: <오류>` 다.
//     열린 PR 의 base 인 브랜치는 base 를 옮기지 않고 남긴다. 머지 큐의 deleteBranch 는 머지 직후에 그 브랜치를 base 로 둔
//     내 PR 의 base 를 옮기지만, 이 정리는 머지 직후가 아닌 뒤늦은 정리라 열린 PR 의 base 를 바꾸는 판단을 하지 않는다.
//
// 이벤트 (--apply 일 때만. 핸들러가 바깥에 부작용을 낼 수 있어 dry-run 에서는 내지 않는다):
//     before-cleanup  워크트리 하나가 지울 대상으로 판정되고(소유, 미커밋 변경, 원격에 없는 커밋 확인을 통과)
//                     `정리` 줄을 낸 직후, 그 경로의 터미널을 닫기 앞에서 낸다. 빈 셸 닫기는 그보다 앞이다.
//                     터미널을 닫고 dispatch 를 반납한 뒤에 거부되면 터미널 없는 워크트리가 남기 때문이다.
//                     입력은 worktree(절대경로), branch, pr(찾았으면), worker(그 경로의 worker 행 가운데 dispatchId 가 있는 첫 행.
//                     없으면 넣지 않는다)다. 거부하면 `HOOK-REJECT` 줄에, 실패하거나 시간을 넘기면 `HOOK-FAIL` 줄에 더해
//                     `남김 <경로>: 저장소 핸들러 거부` 를 내고 다음 항목으로 간다.
//                     브랜치가 없는 저장소 밖 detached 워크트리와 워크트리 없는 로컬 브랜치에는 내지 않는다.
//                     입력의 worktree 와 branch 를 채울 수 없다
//     after-cleanup   --repo 하나의 정리가 끝난 뒤 낸다. 입력은 removed(그 저장소에서 지운 워크트리 경로 목록)와
//                     skipped(그 저장소에서 남기거나 건너뛴 워크트리의 { path, reason } 목록)다.
//                     핸들러의 실패와 시간 초과는 `HOOK-FAIL` 줄만 내고 종료 코드에 반영하지 않는다.
//                     정리의 2 는 사용법 오류와 저장소 조회 실패를 뜻한다(아래 「종료 코드」). after-cleanup 의 실패를 2 에 섞으면
//                     정리 자체가 실패한 경우와 구별할 수 없다
//     ctx 는 { repo: --repo 의 체크아웃, base: 그 저장소의 기준 브랜치, run: --run 값 또는 null } 이다.
//
// ORCA, GH, ORCH_KILL 환경 변수로 실행 파일을 바꾼다. 기본 orca, gh, kill.
// ORCH_HOOK_WAIT(정수 초, 기본 180)에 60초를 더한 만큼 remove-worktree.ts 를 기다린다. 그 명령이 session-end hook 을 그만큼 기다린다.
//
// 종료 코드:
//     0  돌았다. 건너뛴 항목이 있어도 0 이다
//     2  사용법 오류, 또는 저장소를 읽지 못했다. --specs-dir 없이 orch 작업 폴더를 옮기기 전인 저장소를 만나도
//        그 저장소를 건너뛰고 2 다(lib/paths.ts 의 requireMigrated). 설정 파일 오류(lib/config.ts 의 ConfigError)도
//        그 저장소를 거기서 멈추고 2 다. 내 PR 의 작성자나 --remote-branches 의 후보를 읽지 못해도
//        그 동작만 하지 않고 2 다
//
// 테스트가 waitFree, stopHolders 를 import 한다. 명령으로 실행했을 때만 main 을 부른다.

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { expandArgs } from './lib/args.ts'
import { ConfigError } from './lib/config.ts'
import { fire } from './lib/events.ts'
import { realPath } from './lib/fs.ts'
import { apiTarget, ghBin, ghJson, isOwnPr, ownAuthors } from './lib/gh.ts'
import { defaultBase } from './lib/git.ts'
import { forgetLaunch, readLaunch } from './lib/launched.ts'
import { orcaBin } from './lib/orca.ts'
import { allWorkers, blocker as ownershipBlocker, cached, LookupError, rowHandles, runWorkers } from './lib/ownership.ts'
import type { WorkerRow } from './lib/ownership.ts'
import { pathOf, requireMigrated } from './lib/paths.ts'
import { lsofOpenedBy, sweepQueueLogs } from './lib/queue-logs.ts'
import { run as runProcess, scriptCommand } from './lib/proc.ts'
import { deleteSpecs, LINE_BREAK, liveSpecPaths, specCandidates } from './lib/spec.ts'

const USAGE =
  "사용법: cleanup-sweep.ts --repo DIR [--repo DIR ...] [--base main] [--run RUN_ID] [--specs-dir DIR] [--kill-holders] [--agent-glob 'agent-*'] [--close-own-taken-over] [--remote-branches] [--trash DIR] [--wait SEC] [--poll-interval SEC] [--apply]"
const HERE = dirname(fileURLToPath(import.meta.url))
const REMOVE = join(HERE, 'remove-worktree.ts')
const LIVE_STATES = new Set(['working', 'ready'])
// 이 상태의 worker 만 남은 프로세스를 끌 수 있다. failed 나 abandoned 는 같은 워크트리로 다시 맡길 수 있어 뺀다
const FINISHED_STATES = new Set(['succeeded', 'fenced'])
const STOP_SIGNALS = ['TERM', 'HUP', 'KILL']
// 이 dispatch 상태면 끝났다고 본다. 코디네이터가 띄운 터미널을 알아보는 조건이다
const FINISHED_DISPATCH = new Set(['completed', 'failed', 'canceled'])
const PR_STATES = new Set(['MERGED', 'OPEN', 'CLOSED'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh'])
const BY_PR = 'PR MERGED'
const BY_NO_PR = 'PR 없음, 끝난 dispatch, base 보다 앞선 커밋 0 개'
// 조상에 이 문자열이 든 실행 파일이 있으면 Orca 가 띄운 프로세스다
const ORCA_APP = 'Orca.app/'
const MAX_VARIANTS = 4
// OMC session-end hook worker 의 명령줄에 든 문자열. 끄지도 세지도 않고 remove-worktree.ts 가 기다린다
const SESSION_END_MARKS = ['--omc-session-end-worker', 'hooks/session-end/worker.js']
const RUN_TIMEOUT_SEC = 120
// title, isDraft, url 은 before-cleanup 의 pr 입력용이다. author 는 그 입력과 CLOSED PR 의 내 PR 판정에 쓴다
const PR_FIELDS = 'number,state,headRefOid,headRefName,isCrossRepository,title,author,isDraft,url'
const KEPT_BY_HOOK = '저장소 핸들러 거부'
// --remote-branches 가 읽는 닫힌 PR 의 필드. --state closed 는 MERGED 와 CLOSED 를 함께 준다
const CLOSED_FIELDS = 'number,state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt'
const OPEN_PR_LIMIT = 1000

type Json = Record<string, unknown>
type Terminal = Json
type Pr = Json & { number: number; state: string }
type Log = (line: string) => void
type Report = { removed: string[]; skipped: { path: string; reason: string }[] }

type Args = {
  base: string
  run: string | null
  specsDir: string | null
  killHolders: boolean
  agentGlob: string
  closeOwnTakenOver: boolean
  remoteBranches: boolean
  trash: string
  apply: boolean
  wait: number
  pollInterval: number
  removeTimeoutSec: number
  // 다른 Run 의 worker 가 쥔 살아 있는 터미널 handle. --run 이 없거나 모든 Run 을 읽지 못하면 null 이다
  foreign: Set<unknown> | null
  allWorkers: () => Promise<WorkerRow[]>
  liveSpecs: Set<string> | null
}

// 저장소 하나를 읽지 못했다. main 이 stderr 에 내고 종료 코드를 2 로 하고 다음 저장소로 간다
class RepoError extends Error {}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Python 의 참거짓 판정. 옛 명령의 `if x` 와 `x or y` 를 같게 옮긴다. 빈 목록과 빈 객체도 거짓이다
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isObject(value)) return Object.keys(value).length > 0
  return value !== undefined && value !== null && value !== '' && value !== 0 && value !== false
}

function resourceOf(row: Json): Json {
  return isObject(row.resource) ? row.resource : {}
}

function lines(text: string): string[] {
  return text ? text.split(LINE_BREAK) : []
}

// 옛 명령의 run 과 같게 stdout 과 stderr 의 앞뒤 공백을 지운다. 시간을 넘기면 1 과 그 이유다
function run(argv: string[], opts: { cwd?: string; timeoutSec?: number } = {}): { code: number; out: string; err: string } {
  const seconds = opts.timeoutSec ?? RUN_TIMEOUT_SEC
  const done = runProcess(argv, { cwd: opts.cwd, timeoutMs: seconds * 1000 })
  if (done.timedOut) return { code: 1, out: '', err: `${argv.join(' ')} 가 ${seconds}초 안에 끝나지 않았다` }
  return { code: done.code, out: done.stdout.trim(), err: done.stderr.trim() }
}

function git(repo: string, ...args: string[]): { code: number; out: string; err: string } {
  return run(['git', '-C', repo, ...args])
}

function killBin(): string {
  return process.env.ORCH_KILL || 'kill'
}

// 기본 체크아웃을 뺀 [경로, 브랜치] 목록. 브랜치가 없으면 빈 문자열이다.
function worktrees(repo: string): [string, string][] {
  const listed = git(repo, 'worktree', 'list', '--porcelain')
  if (listed.code !== 0) throw new RepoError(`git worktree list 실패: ${repo}`)
  const items: [string, string][] = []
  let path: string | null = null
  let branch = ''
  for (const line of [...lines(listed.out), '']) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
      branch = ''
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (!line && path) {
      items.push([path, branch])
      path = null
    }
  }
  return items.slice(1)
}

// `gh pr list --head` 를 JSON 으로 읽는다. 빈 목록은 ok 와 [] 다.
// JSON 이 아니거나 목록이 아니거나 state 가 모르는 값이면 error 다.
// 출력 문자열을 비교하지 않고 파싱한다. `null` 같은 문자열이 PR 로 읽히지 않게 한다.
function prList(repo: string, head: string): { ok: boolean; prs: Pr[] } {
  const done = run([ghBin(), 'pr', 'list', '--head', head, '--state', 'all', '--limit', '5', '--json', PR_FIELDS], { cwd: repo })
  if (done.code !== 0) return { ok: false, prs: [] }
  let prs: unknown
  try {
    prs = done.out ? JSON.parse(done.out) : []
  } catch {
    return { ok: false, prs: [] }
  }
  if (!Array.isArray(prs)) return { ok: false, prs: [] }
  for (const pr of prs) {
    if (!isObject(pr) || !PR_STATES.has(pr.state as string) || !Number.isInteger(pr.number)) return { ok: false, prs: [] }
  }
  return { ok: true, prs: prs as Pr[] }
}

// 로컬 브랜치 `<user>/<접두>-<주제>` 에 대응할 법한 PR head 이름. `<접두>/<주제>` 가 대표적이다.
function nameVariants(branch: string): string[] {
  const slash = branch.indexOf('/')
  const rest = slash >= 0 ? branch.slice(slash + 1) : branch
  const names = rest !== branch ? [rest] : []
  let pos = -1
  const more = MAX_VARIANTS - names.length
  for (let i = 0; i < more; i++) {
    pos = rest.indexOf('-', pos + 1)
    if (pos <= 0) break
    names.push(`${rest.slice(0, pos)}/${rest.slice(pos + 1)}`)
  }
  return names
}

// [PR head 이름, 이름이 확실한지]. upstream, branch.<b>.merge, 로컬 이름이 확실하고 변형은 확인이 필요하다.
function prCandidates(repo: string, branch: string): [string, boolean][] {
  const names: [string, boolean][] = []
  const remote = git(repo, 'config', '--get', `branch.${branch}.remote`).out
  const upstream = git(repo, 'for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`).out
  const prefix = `refs/remotes/${remote || 'origin'}/`
  if (upstream.startsWith(prefix)) names.push([upstream.slice(prefix.length), true])
  const merge = git(repo, 'config', '--get', `branch.${branch}.merge`).out
  if (merge.startsWith('refs/heads/')) names.push([merge.slice('refs/heads/'.length), true])
  names.push([branch, true])
  for (const name of nameVariants(branch)) names.push([name, false])
  const seen = new Set<string>()
  return names.filter(([name]) => {
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}

// PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 로 받아 온다. 머지 큐의 update-branch 로 앞서 간 HEAD 가 그런 경우다.
function ensureCommit(repo: string, pr: Pr): void {
  const head = pr.headRefOid
  if (!truthy(head) || git(repo, 'cat-file', '-e', `${String(head)}^{commit}`).code === 0) return
  git(repo, 'fetch', '-q', 'origin', `refs/pull/${pr.number}/head`)
}

// `gh pr view --json commits` 가 돌려주는 PR 의 커밋 해시 집합. 조회가 실패하거나 모양이 다르면 null 이다.
// update-branch 로 합친 머지 커밋도 목록에 든다. gh 는 커밋을 앞쪽 100 개까지만 준다.
function prCommitOids(repo: string, pr: Pr): Set<string> | null {
  const done = run([ghBin(), 'pr', 'view', String(pr.number), '--json', 'commits'], { cwd: repo })
  if (done.code !== 0) return null
  let data: unknown
  try {
    data = JSON.parse(done.out)
  } catch {
    return null
  }
  if (!isObject(data) || !Array.isArray(data.commits)) return null
  const oids = new Set<string>()
  for (const commit of data.commits) if (isObject(commit) && typeof commit.oid === 'string') oids.add(commit.oid)
  return oids
}

// 그 PR 이 이 브랜치의 것인지. 끝 커밋이 PR HEAD 와 같거나 그 조상이어야 한다.
//
// base 위 커밋이 0 개면 막 만든 브랜치일 수 있다. 그 끝 커밋은 옛 PR HEAD 의 조상(base 의 옛 커밋)이기도 하므로
// PR HEAD 와 정확히 같을 때만 인정하는 것이 기본이다. 다만 머지 큐의 update-branch 로 PR HEAD 가 앞서 가고
// 저장소가 merge commit 으로 머지하면, 머지 뒤 브랜치의 커밋이 모두 base 에 들어가 0 개이면서 끝 커밋이 PR HEAD 와 다르다.
// 이때는 끝 커밋이 그 PR 의 커밋 목록에 있을 때만 인정한다. 막 만든 브랜치의 끝 커밋은 base 의 옛 커밋이라 목록에 없다.
// 목록을 읽지 못하면 인정하지 않는다.
function belongsTo(repo: string, ref: string, base: string, pr: Pr): boolean {
  const head = pr.headRefOid
  if (!truthy(head)) return false
  const tip = git(repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`)
  if (tip.code !== 0) return false
  if (tip.out === head) return true
  const count = git(repo, 'rev-list', '--count', `origin/${base}..${ref}`)
  if (count.code !== 0) return false
  if (count.out === '' || count.out === '0') return (prCommitOids(repo, pr) ?? new Set()).has(tip.out)
  return git(repo, 'merge-base', '--is-ancestor', ref, String(head)).code === 0
}

// 그 브랜치의 PR. 조회 실패가 있었는지(failed), 이름만 같은 PR 이 있었는지(foreign)도 낸다.
function findPr(repo: string, branch: string, base: string): { pr: Pr | null; failed: boolean; foreign: boolean } {
  let failed = false
  let foreign = false
  for (const [name] of prCandidates(repo, branch)) {
    const listed = prList(repo, name)
    if (!listed.ok) {
      failed = true
      continue
    }
    for (const pr of listed.prs) {
      if (truthy(pr.isCrossRepository)) continue
      ensureCommit(repo, pr)
      if (belongsTo(repo, `refs/heads/${branch}`, base, pr)) return { pr, failed, foreign }
      foreign = true
    }
  }
  return { pr: null, failed, foreign }
}

// noPr: PR 이 없어서 정리하지 않은 것(조회 실패는 아니다). 「PR 없이 끝난 워크트리」 판정의 대상이다
type Merged = { ok: boolean; mergedHead: string | null; why: string; pr: Pr | null; noPr?: boolean }

function merged(repo: string, branch: string, base: string): Merged {
  const { pr, failed, foreign } = findPr(repo, branch, base)
  if (pr && pr.state === 'MERGED') {
    return { ok: true, mergedHead: truthy(pr.headRefOid) ? String(pr.headRefOid) : null, why: BY_PR, pr }
  }
  const state = pr ? pr.state : failed ? '조회 실패' : foreign ? '이름만 같은 PR(이 브랜치의 커밋이 아니다)' : '없음'
  const track = git(repo, 'for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`).out
  if (track !== '[gone]') return { ok: false, mergedHead: null, why: `PR ${state}, upstream 이 남아 있다`, pr, noPr: !pr && !failed }
  const cherry = git(repo, 'cherry', `origin/${base}`, branch)
  if (cherry.code !== 0) return { ok: false, mergedHead: null, why: 'git cherry 실패', pr }
  const plus = lines(cherry.out).filter((line) => line.startsWith('+')).length
  if (plus) return { ok: false, mergedHead: null, why: `upstream gone 이지만 base 에 없는 커밋 ${plus} 개`, pr }
  return { ok: true, mergedHead: null, why: 'upstream gone, base 에 없는 커밋 0 개', pr }
}

// 원격에도 머지된 PR HEAD 에도 없는 커밋 수. cherry 로 판정했으면 이미 base 에 있으므로 0 이다. 확인하지 못하면 -1 이다.
function unpushed(repo: string, ref: string, mergedHead: string | null, byCherry: boolean): number {
  if (byCherry) return 0
  const args = ['rev-list', ref, '--not', '--remotes']
  if (mergedHead && git(repo, 'cat-file', '-e', `${mergedHead}^{commit}`).code === 0) args.push(mergedHead)
  const done = git(repo, ...args)
  return done.code === 0 ? lines(done.out).length : -1
}

function dirty(path: string): boolean {
  const done = git(path, 'status', '--porcelain')
  return done.code !== 0 || done.out !== ''
}

function under(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

// 프로세스 조회와 대기. 테스트가 대역으로 바꾼다
export type Host = {
  // 그 경로나 하위를 작업 디렉터리로 쓰는 프로세스의 pid 에서 작업 디렉터리로
  holderCwds: (path: string) => Map<string, string>
  // pid 에서 [ppid, command] 로
  psRows: () => Map<string, [string, string]>
  sleep: (seconds: number) => Promise<void>
  kill: (signal: string, pids: string[]) => void
}

const REAL_HOST: Host = {
  holderCwds(path) {
    const found = new Map<string, string>()
    let pid: string | null = null
    for (const line of lines(run(['lsof', '-d', 'cwd', '-Fpn']).out)) {
      if (line.startsWith('p')) pid = line.slice(1)
      else if (line.startsWith('n') && pid !== null && under(line.slice(1), path)) found.set(pid, line.slice(1))
    }
    return found
  },
  psRows() {
    const rows = new Map<string, [string, string]>()
    for (const line of lines(run(['ps', '-axo', 'pid=,ppid=,command=']).out)) {
      const m = /^\s*(\S+)\s+(\S+)\s+(\S.*)$/.exec(line)
      if (m) rows.set(m[1], [m[2], m[3]])
    }
    return rows
  },
  sleep: (seconds) => sleepMs(seconds * 1000).then(() => undefined),
  kill(signal, pids) {
    run([killBin(), `-${signal}`, ...pids])
  },
}

function holderPids(path: string, host: Host): string[] {
  return [...host.holderCwds(path).keys()]
}

function firstWord(command: string): string {
  return command ? command.split(/\s+/)[0] : ''
}

// 그 pid 가운데 OMC session-end hook worker 인 것. 세션이 끝난 뒤 `.omc/` 를 쓰다 스스로 끝난다.
function sessionEndHooks(pids: string[], host: Host): string[] {
  const rows = host.psRows()
  return pids.filter((pid) => {
    const row = rows.get(pid)
    return row !== undefined && SESSION_END_MARKS.some((mark) => row[1].includes(mark))
  })
}

// 그 프로세스가 모두 자식 없는 로그인 셸이면 true. 로그인 셸은 argv[0] 이 `-` 로 시작한다(`-/bin/zsh`).
function onlyIdleShells(pids: string[], host: Host): boolean {
  if (pids.length === 0) return false
  const table = host.psRows()
  const parents = new Set([...table.values()].map(([ppid]) => ppid))
  for (const pid of pids) {
    const argv0 = firstWord(table.get(pid)?.[1] ?? '')
    if (!argv0.startsWith('-') || !SHELLS.has(basename(argv0.slice(1))) || parents.has(pid)) return false
  }
  return true
}

// `orca <args> --json` 응답의 result. 실패하거나 result 가 없으면 null 이다.
function orcaResult(args: string[]): unknown {
  const done = run([orcaBin(), ...args, '--json'])
  if (done.code !== 0) return null
  try {
    const data: unknown = JSON.parse(done.out)
    return isObject(data) ? (data.result ?? null) : null
  } catch {
    return null
  }
}

// 다른 Run 의 worker 가 쥔 살아 있는 터미널 handle 집합. 모든 Run 의 worker 를 읽지 못하면 null 이다.
async function foreignHandles(runId: string, workers: () => Promise<WorkerRow[]>): Promise<Set<unknown> | null> {
  try {
    const handles = new Set<unknown>()
    for (const w of await workers()) {
      if (w.runId !== runId && w.terminalState === 'active') for (const h of rowHandles(w)) handles.add(h)
    }
    return handles
  } catch (e) {
    if (e instanceof LookupError) return null
    throw e
  }
}

// 그 경로에서 이 Run 이 닫으면 안 되는 터미널. --run 이 없으면 빈 목록이다.
function foreignAt(args: Args, mine: WorkerRow[], terminals: Terminal[], path: string): string[] {
  if (!args.run) return []
  const here = terminalsAt(terminals, path)
  if (args.foreign === null) {
    const own = new Set(mine.map((w) => w.agentTerminalHandle))
    return here.filter((h) => !own.has(h))
  }
  const foreign = args.foreign
  return here.filter((h) => foreign.has(h))
}

function workersAt(workers: WorkerRow[], path: string): WorkerRow[] {
  return workers.filter((w) => String(resourceOf(w).worktreeId ?? '').endsWith(`::${path}`))
}

// 살아 있는 터미널 목록. 조회에 실패하면 null 이다.
function liveTerminals(): Terminal[] | null {
  const result = orcaResult(['terminal', 'list'])
  if (!isObject(result)) return null
  const terminals = result.terminals ?? []
  if (!Array.isArray(terminals)) return null
  return terminals.filter(isObject)
}

function terminalsAt(terminals: Terminal[] | null, path: string): string[] {
  const handles: string[] = []
  for (const t of terminals ?? []) if (t.worktreePath === path && typeof t.handle === 'string' && t.handle) handles.push(t.handle)
  return handles
}

function closeTerminal(handle: string): boolean {
  return run([orcaBin(), 'terminal', 'close', '--terminal', handle, '--json']).code === 0
}

function closeTerminals(handles: string[], apply: boolean, log: Log, what = '터미널'): void {
  for (const handle of handles) {
    if (apply) log(closeTerminal(handle) ? `  ${what} 닫음 ${handle}` : `  ${what} 닫기 실패 ${handle}`)
    else log(`  ${what}을 닫을 것 ${handle}`)
  }
}

// 그 경로를 쓰는 프로세스가 빠지기를 기다린다. 남은 pid 목록을 돌려준다.
// seconds 동안 interval 마다 다시 본다. 마지막 간격은 남은 시간만큼 줄인다. seconds 가 0 이면 한 번만 본다.
export async function waitFree(path: string, seconds: number, interval = 1, host: Host = REAL_HOST): Promise<string[]> {
  let pids = holderPids(path, host)
  let remaining = seconds
  while (pids.length && remaining > 0) {
    const delay = Math.min(interval, remaining)
    await host.sleep(delay)
    remaining -= delay
    pids = holderPids(path, host)
  }
  return pids
}

// 이 명령과 그 조상의 pid. 이 명령을 부른 셸이 그 경로에 있어도 끄지 않는다.
function ownAncestors(host: Host): Set<string> {
  const parent = new Map([...host.psRows()].map(([pid, [ppid]]) => [pid, ppid] as const))
  const seen = new Set<string>()
  let pid: string | undefined = String(process.pid)
  while (pid && !seen.has(pid) && pid !== '0' && pid !== '1') {
    seen.add(pid)
    pid = parent.get(pid)
  }
  return seen
}

// 남은 프로세스를 끄면 안 되는 이유. 끌 수 있으면 null 이다.
// dry-run 은 터미널을 닫기 전이라 checkTerminals 를 끈다. 실제 실행은 MERGED 면 터미널을 먼저 닫는다.
function killBlocker(mine: WorkerRow[], path: string, byPr: boolean, checkTerminals = true): string | null {
  if (!byPr) return 'PR 이 MERGED 가 아니다'
  if (mine.length === 0) return '그 경로의 worker 를 모른다(--run 이 없거나 그 Run 에 없다)'
  const unfinished = mine.filter((w) => !FINISHED_STATES.has(w.workerState as string)).map((w) => String(w.dispatchId ?? '?'))
  if (unfinished.length) return `끝나지 않은 dispatch ${unfinished.join(', ')}`
  if (!checkTerminals) return null
  const terminals = liveTerminals()
  if (terminals === null || terminalsAt(terminals, path).length) return '그 경로에 Orca 터미널이 남아 있거나 터미널 목록을 읽지 못했다'
  return null
}

function describe(pids: string[], host: Host): string {
  const rows = host.psRows()
  return pids
    .map((pid) => {
      const row = rows.get(pid)
      return row ? `${pid} ${basename(firstWord(row[1]).replace(/^-+/, ''))}` : pid
    })
    .join(', ')
}

// 조상에 Orca, `login`, 같은 경로를 쥔 프로세스 말고 다른 프로세스가 있으면 true. 조상을 못 읽어도 true 다.
function startedOutsideOrca(pid: string, rows: Map<string, [string, string]>, holders: Map<string, string>): boolean {
  const seen = new Set<string>()
  let current = pid
  for (;;) {
    const row = rows.get(current)
    if (row === undefined) return true
    current = row[0]
    if (current === '0' || current === '1') return false
    if (seen.has(current)) return true
    seen.add(current)
    const command = rows.get(current)?.[1] ?? ''
    if (!(holders.has(current) || command.includes(ORCA_APP) || basename(firstWord(command)) === 'login')) return true
  }
}

// 끌 pid 목록. 빼는 것은 머리 주석의 「남은 프로세스 끄기」 가 정한다.
function targets(path: string, nested: string[], host: Host, log?: Log): string[] {
  const cwds = host.holderCwds(path)
  const rows = host.psRows()
  const keep = ownAncestors(host)
  for (const pid of sessionEndHooks([...cwds.keys()], host)) keep.add(pid)
  const chosen: string[] = []
  const skipped: string[] = []
  for (const [pid, cwd] of cwds) {
    if (keep.has(pid) || nested.some((other) => under(cwd, other)) || startedOutsideOrca(pid, rows, cwds)) skipped.push(pid)
    else chosen.push(pid)
  }
  if (skipped.length && log) log(`  Orca 밖에서 띄웠거나 다른 워크트리를 쓰는 프로세스라 끄지 않는다: ${describe(skipped, host)}`)
  return chosen
}

// targets 가 고른 프로세스를 TERM, HUP, KILL 순으로 끈다. 그 경로를 아직 쓰는 pid 목록을 돌려준다.
// 신호마다 max(seconds, interval) 초 기다리고 대상을 다시 고른다. 앞 신호로 빠진 pid 가 다른 프로세스로 재사용돼도 닿지 않는다.
export async function stopHolders(
  path: string,
  nested: string[],
  seconds: number,
  log: Log,
  interval = 1,
  host: Host = REAL_HOST,
): Promise<string[]> {
  let pids = targets(path, nested, host, log)
  for (const signal of STOP_SIGNALS) {
    if (pids.length === 0) break
    log(`  ${signal} 를 보낸다: ${describe(pids, host)}`)
    host.kill(signal, pids)
    await waitFree(path, Math.max(seconds, interval), interval, host)
    pids = targets(path, nested, host)
  }
  return holderPids(path, host)
}

function protectedReason(repo: string, branch: string, base: string): string | null {
  if (branch === base || branch.startsWith('release/')) return '기준 브랜치나 release 브랜치'
  const done = run([ghBin(), 'pr', 'list', '--state', 'open', '--base', branch, '--json', 'number', '--jq', 'length'], { cwd: repo })
  if (done.code !== 0 || (done.out !== '' && done.out !== '0')) return '다른 열린 PR 의 base 이거나 조회 실패'
  return null
}

type RemotePlan = { names: string[]; expect: string | null }

// 지울 원격 브랜치 이름과, 그 끝점이 가져야 할 커밋. 로컬 브랜치를 지우기 전에 만든다.
function remotePlan(repo: string, branch: string, pr: Pr | null): RemotePlan {
  const names = prCandidates(repo, branch)
    .filter(([, exact]) => exact)
    .map(([name]) => name)
  if (pr && !truthy(pr.isCrossRepository) && truthy(pr.headRefName)) names.unshift(String(pr.headRefName))
  const expect =
    pr && pr.state === 'MERGED' ? (truthy(pr.headRefOid) ? String(pr.headRefOid) : null) : git(repo, 'rev-parse', `refs/heads/${branch}`).out
  return { names: [...new Set(names)], expect }
}

function deleteRemote(repo: string, plan: RemotePlan, base: string, apply: boolean, log: Log): void {
  for (const name of plan.names) {
    const reason = protectedReason(repo, name, base)
    if (reason) {
      log(`  원격 브랜치 남김 ${name}: ${reason}`)
      continue
    }
    const listed = git(repo, 'ls-remote', '--heads', 'origin', `refs/heads/${name}`)
    if (listed.code !== 0) {
      log(`  원격 브랜치 확인 실패 ${name}`)
      continue
    }
    if (!listed.out) {
      log(`  원격 브랜치 이미 없음 ${name}`)
      continue
    }
    const tip = listed.out.split(/\s+/)[0]
    if (plan.expect && tip !== plan.expect) {
      log(`  원격 브랜치 남김 ${name}: 끝점이 머지된 커밋과 다르다`)
      continue
    }
    if (apply) {
      const done = git(repo, 'push', '-q', 'origin', '--delete', name)
      log(done.code === 0 ? `  원격 브랜치 삭제 ${name}` : `  원격 브랜치 삭제 실패 ${name}: ${done.err}`)
    } else {
      log(`  원격 브랜치를 지울 것 ${name}`)
    }
  }
}

// 지시서와 PR 본문 파일을 지운다. live 는 살아 있는 dispatch 의 지시서 실경로 집합이고 null 이면 둘 다 남긴다.
// root 는 지시서 폴더 실경로의 부모다. 지시서와 PR 본문은 그 아래에 있어 lib/spec.ts 의 「orch 루트 밖」 에 걸리지 않는다.
function deleteSpecFiles(specsDir: string | null, name: string, apply: boolean, log: Log, live: Set<string> | null, branch: string, pr: Pr | null): void {
  if (!specsDir) return
  const prNumber = pr && truthy(pr.number) ? pr.number : undefined
  const { specs, prBodies } = specCandidates({ specsDir, name, branch, prNumber })
  deleteSpecs({ root: dirname(realPath(specsDir)), specs, prBodies, live, mode: 'delete', apply, log: (line) => log(`  ${line}`) })
}

// 기본 체크아웃이 기준 브랜치에 있으면 origin/<기준> 으로 fast-forward 한다.
function followBase(repo: string, base: string, apply: boolean, log: Log): void {
  const current = git(repo, 'branch', '--show-current').out
  if (current !== base) return
  const head = git(repo, 'rev-parse', 'HEAD')
  const remote = git(repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`)
  if (head.code || remote.code || head.out === remote.out) return
  const range = `${head.out.slice(0, 8)}..${remote.out.slice(0, 8)}`
  if (git(repo, 'merge-base', '--is-ancestor', head.out, remote.out).code !== 0) {
    log(`기준 브랜치를 맞추지 않는다: ${base} 에 origin/${base} 에 없는 커밋이 있다`)
    return
  }
  if (!apply) {
    log(`기준 브랜치를 fast-forward 할 것 ${base} ${range}`)
    return
  }
  const done = git(repo, 'merge', '--ff-only', '-q', `origin/${base}`)
  log(done.code === 0 ? `기준 브랜치 fast-forward ${base} ${range}` : `기준 브랜치 fast-forward 실패 ${base}: ${done.err}`)
}

// 그 커밋이 원격 추적 브랜치 어딘가에 들어 있는지.
function onRemote(repo: string, commit: string): boolean {
  const done = git(repo, 'for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes/')
  return done.code === 0 && done.out !== ''
}

// 저장소 밖 detached 워크트리를 지운다. 조건은 머리 주석의 「저장소 밖 detached 워크트리」 가 정한다.
function sweepDetached(repo: string, path: string, args: Args, terminals: Terminal[], log: Log, report: Report): void {
  const skip = (reason: string, line: string) => {
    log(line)
    report.skipped.push({ path, reason })
  }
  if (under(realPath(path), realPath(repo))) return skip('브랜치가 없다(detached)', `건너뜀 ${path}: 브랜치가 없다(detached)`)
  if (dirty(path)) return skip('커밋 안 된 변경', `건너뜀 detached ${path}: 커밋 안 된 변경`)
  const pids = holderPids(path, REAL_HOST)
  if (pids.length) {
    const reason = `그 경로를 쓰는 프로세스 ${pids.length} 개(${describe(pids, REAL_HOST)})`
    return skip(reason, `건너뜀 detached ${path}: ${reason}`)
  }
  if (terminalsAt(terminals, path).length) return skip('Orca 터미널이 있다', `건너뜀 detached ${path}: Orca 터미널이 있다`)
  const head = git(path, 'rev-parse', 'HEAD')
  if (head.code !== 0 || !onRemote(repo, head.out)) return skip('HEAD 가 원격에 없다', `건너뜀 detached ${path}: HEAD 가 원격에 없다`)
  if (!args.apply) {
    log(`detached 워크트리를 지울 것 ${path}`)
    return
  }
  const done = git(repo, 'worktree', 'remove', path)
  if (done.code === 0) {
    log(`detached 워크트리 삭제 ${path}`)
    report.removed.push(path)
  } else {
    skip(`detached 워크트리 삭제 실패: ${done.err}`, `detached 워크트리 삭제 실패 ${path}: ${done.err}`)
  }
}

// Python fnmatch 와 같은 glob 판정. `*` 와 `?` 는 `/` 에도 맞고, 닫는 `]` 가 없는 `[` 는 글자 그대로다.
function globMatch(name: string, pattern: string): boolean {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      let j = i + 1
      if (pattern[j] === '!') j++
      if (pattern[j] === ']') j++
      while (j < pattern.length && pattern[j] !== ']') j++
      if (j >= pattern.length) {
        re += '\\['
        continue
      }
      let body = pattern.slice(i + 1, j).replaceAll('\\', '\\\\')
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      else if (body.startsWith('^')) body = `\\${body}`
      re += `[${body}]`
      i = j
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 's').test(name)
}

// 하위 에이전트 워크트리이고 그 경로를 쓰는 프로세스가 빈 로그인 셸뿐인지.
function idleAgentPath(args: Args, path: string): boolean {
  return globMatch(basename(path), args.agentGlob) && onlyIdleShells(holderPids(path, REAL_HOST), REAL_HOST)
}

// theirs 가 모두 Orca 가 다시 연 빈 셸이면 true. 하나라도 확인하지 못하면 false.
// Orca 는 PTY pid 를 주지 않아 `agentIdentity` 와 그 경로를 쓰는 프로세스로 판정한다.
//   - 이 Run 의 dispatch 가 쓴 워크트리다(mine). 그 터미널에 에이전트가 없다(`agentIdentity` 없음)
//   - 그 경로를 작업 디렉터리로 쓰는 프로세스가 모두 자식 없는 로그인 셸이고, 터미널마다 셸이 하나씩 있다
// 터미널 수보다 셸이 적으면 작업 폴더를 옮긴 터미널이 있다는 뜻이라 닫지 않는다.
function emptyShells(path: string, mine: WorkerRow[], theirs: string[], terminals: Terminal[]): boolean {
  if (mine.length === 0 || theirs.length === 0) return false
  const entries = new Map(terminals.map((t) => [t.handle, t] as const))
  for (const handle of theirs) {
    const entry = entries.get(handle)
    if (!entry || truthy(entry.agentIdentity) || entry.worktreePath !== path) return false
  }
  const pids = holderPids(path, REAL_HOST)
  return pids.length >= theirs.length && onlyIdleShells(pids, REAL_HOST)
}

// --close-own-taken-over 로 소유 확인에서 뺄 터미널 handle 집합. 조건 하나라도 어긋나면 빈 집합이다.
function takenOverOwn(args: Args, mine: WorkerRow[], terminals: Terminal[], path: string): Set<unknown> {
  if (!(args.closeOwnTakenOver && args.run)) return new Set()
  const entries = new Map(terminals.map((t) => [t.handle, t] as const))
  const handles = new Set<unknown>()
  for (const w of mine) {
    const resource = resourceOf(w)
    const handle = truthy(resource.terminalHandle) ? resource.terminalHandle : w.agentTerminalHandle
    const entry = entries.get(handle)
    const runId = 'runId' in w ? w.runId : args.run
    if (
      runId === args.run &&
      w.dispatchStatus === 'completed' &&
      resource.ownershipState === 'user_owned' &&
      resource.retainedReason === 'user_takeover' &&
      entry &&
      entry.worktreePath === path &&
      !truthy(entry.agentIdentity)
    ) {
      handles.add(handle)
    }
  }
  if (handles.size && !onlyIdleShells(holderPids(path, REAL_HOST), REAL_HOST)) return new Set()
  return handles
}

// 코디네이터가 launch-worker.ts 로 띄운 것으로 기록돼 있고 끝난 dispatch 의 터미널 handle.
// worker 행의 dispatchId 에 기록이 있고, 기록한 워크트리가 이 경로이며, 기록한 터미널이 그 행의 터미널이어야 한다.
// 같은 터미널을 아직 끝나지 않은 dispatch 가 이어 쓰면 뺀다. 사람이 연 터미널은 기록이 없어 들지 않는다.
function launchedOwn(repo: string, mine: WorkerRow[], terminals: Terminal[], path: string): Set<unknown> {
  const here = new Set<unknown>(terminalsAt(terminals, path))
  const own = new Set<unknown>()
  const busy = new Set<unknown>()
  try {
    for (const w of mine) {
      const handles = rowHandles(w)
      const live = [...handles].filter((h) => here.has(h))
      if (!FINISHED_DISPATCH.has(w.dispatchStatus as string)) {
        for (const h of live) busy.add(h)
        continue
      }
      const record = typeof w.dispatchId === 'string' ? readLaunch(repo, w.dispatchId) : null
      if (!record || realPath(record.worktree) !== realPath(path)) continue
      if (record.terminal && !handles.has(record.terminal)) continue
      for (const h of live) own.add(h)
    }
  } catch (e) {
    if (e instanceof LookupError) return new Set()
    throw e
  }
  for (const h of busy) own.delete(h)
  return own
}

// 「PR 없이 끝난 워크트리」 를 치우지 못하는 이유. 치워도 되면 null 이다. 조건은 머리 주석이 정한다
function noPrBlocker(s: Sweep, branch: string, path: string, mine: WorkerRow[]): string | null {
  const { repo, args } = s
  if (mine.length === 0) return '그 경로의 dispatch 를 모른다(--run 이 없거나 그 Run 에 없다)'
  const open = mine.filter((w) => w.dispatchStatus !== 'completed').map((w) => String(w.dispatchId ?? '?'))
  if (open.length) return `끝나지 않은 dispatch ${open.join(', ')}`
  const ahead = (ref: string) => {
    const done = git(repo, 'rev-list', '--count', `origin/${args.base}..${ref}`)
    return done.code === 0 && /^\d+$/.test(done.out) ? Number(done.out) : -1
  }
  const local = ahead(`refs/heads/${branch}`)
  if (local !== 0) return local < 0 ? 'base 보다 앞선 커밋을 세지 못했다' : `base 보다 앞선 커밋 ${local} 개`
  if (dirty(path)) return '커밋 안 된 변경'
  for (const [name, exact] of prCandidates(repo, branch)) {
    const ref = `refs/remotes/origin/${name}`
    if (!exact || git(repo, 'rev-parse', '--verify', '-q', ref).code !== 0) continue
    const remote = ahead(ref)
    if (remote !== 0) return remote < 0 ? `원격 브랜치 ${name} 의 앞선 커밋을 세지 못했다` : `원격 브랜치 ${name} 에 base 보다 앞선 커밋 ${remote} 개`
  }
  return null
}

function prInput(pr: Pr): Json {
  const author = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : null
  return {
    number: pr.number,
    title: pr.title ?? null,
    branch: pr.headRefName ?? null,
    head: pr.headRefOid ?? null,
    author,
    draft: typeof pr.isDraft === 'boolean' ? pr.isDraft : null,
    url: pr.url ?? null,
  }
}

function workerInput(row: WorkerRow, path: string): Json {
  return {
    task: row.taskId ?? null,
    dispatch: row.dispatchId,
    terminal: row.agentTerminalHandle ?? resourceOf(row).terminalHandle ?? null,
    worktree: path,
    spec: null,
  }
}

// 「내 PR」 의 작성자 목록. 읽지 못했으면 null 이다
type Owners = () => string[] | null

// 작성자 목록을 저장소마다 처음 쓸 때 한 번 읽는다. 머리 주석의 「내 PR」 이 정한다.
// 읽지 못하면(null 이거나 ConfigError) onFail 을 한 번 부르고, 그 뒤로도 null 을 돌려준다
function ownersOf(repo: string, onFail: (why: string) => void): Owners {
  let read = false
  let found: string[] | null = null
  return () => {
    if (read) return found
    read = true
    try {
      const view = ghJson<unknown>(['repo', 'view', '--json', 'url'], { cwd: repo })
      const url = view.ok && isObject(view.data) && typeof view.data.url === 'string' ? view.data.url : ''
      const host = apiTarget(url)?.host
      if (!view.ok) onFail(view.error)
      else if (!host) onFail(`gh repo view 의 URL 을 읽지 못했다: ${JSON.stringify(url)}`)
      else {
        found = ownAuthors(repo, host)
        if (!found) onFail(`${host} 의 gh api user 실패. config.json 의 pipeline.authors 로 준다`)
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e
      onFail(e.message)
    }
    return found
  }
}

// 작성자를 읽지 못한 PR 은 내 PR 로 보지 않는다
function ownPr(pr: Pr, authors: string[]): boolean {
  const login = isObject(pr.author) && typeof pr.author.login === 'string' ? pr.author.login : ''
  return login !== '' && isOwnPr({ author: { login } }, authors)
}

// 머리 주석의 「머지 없이 CLOSED 가 된 PR 의 터미널」 조건을 채우면 닫을 터미널 목록, 아니면 null 이다.
// 닫는 것은 그 경로의 이 Run worker 행이 가리키는 살아 있는 터미널뿐이다. 다른 Run 의 worker 가 쥔 handle 은 뺀다.
// 모든 Run 의 worker 를 읽지 못했으면(foreign 이 null) foreignAt 처럼 agentTerminalHandle 만 이 Run 의 것으로 본다.
// 작성자 목록은 이 Run 의 끝난 worker 가 있는 CLOSED PR 을 만났을 때만 읽는다
function closedOwnTerminals(s: Sweep, pr: Pr | null, mine: WorkerRow[], terminals: Terminal[], path: string): string[] | null {
  if (!s.args.run || !pr || pr.state !== 'CLOSED') return null
  if (mine.length === 0 || !mine.every((w) => FINISHED_STATES.has(w.workerState as string))) return null
  const authors = s.owners()
  if (!authors || !ownPr(pr, authors)) return null
  const foreign = s.args.foreign
  const own = new Set<unknown>(
    mine.flatMap((w) => (foreign === null ? [w.agentTerminalHandle] : [resourceOf(w).terminalHandle, w.agentTerminalHandle])).filter(truthy),
  )
  return terminalsAt(terminals, path).filter((h) => own.has(h) && !foreign?.has(h))
}

function closeForClosedPr(handles: string[], pr: Pr, apply: boolean, log: Log, indent: string): void {
  const tag = `(CLOSED #${pr.number})`
  for (const handle of handles) {
    if (apply) log(closeTerminal(handle) ? `${indent}터미널 닫음 ${handle} ${tag}` : `${indent}터미널 닫기 실패 ${handle} ${tag}`)
    else log(`${indent}닫을 것: ${handle} ${tag}`)
  }
}

function releaseDispatches(mine: WorkerRow[], apply: boolean, log: Log, indent: string): void {
  for (const w of mine) {
    const dispatch = w.dispatchId
    if (!truthy(dispatch) || resourceOf(w).releaseState === 'released') continue
    if (apply) {
      const done = run([orcaBin(), 'orchestration', 'worker-release', '--dispatch', String(dispatch), '--json'])
      log(done.code === 0 ? `${indent}dispatch release ${dispatch}` : `${indent}dispatch release 실패 ${dispatch}`)
    } else {
      log(`${indent}dispatch 를 release 할 것 ${dispatch}`)
    }
  }
}

type ClosedPr = { number: number; state: string; headRefName: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }

// `gh pr list` 의 JSON 목록. 실패하거나 목록이 아니면 이유 문자열이다
function ghList(repo: string, args: string[]): unknown[] | string {
  const done = ghJson<unknown>(args, { cwd: repo })
  if (!done.ok) return done.error
  return Array.isArray(done.data) ? done.data : `gh ${args.join(' ')} 의 출력이 목록이 아니다`
}

function isClosedPr(pr: unknown): pr is ClosedPr {
  return (
    isObject(pr) &&
    Number.isInteger(pr.number) &&
    (pr.state === 'MERGED' || pr.state === 'CLOSED') &&
    typeof pr.headRefName === 'string' &&
    pr.headRefName !== '' &&
    typeof pr.headRefOid === 'string' &&
    pr.headRefOid !== '' &&
    typeof pr.baseRefName === 'string' &&
    typeof pr.isCrossRepository === 'boolean'
  )
}

// 작성자마다 닫힌 PR 을 읽는다. 하나라도 실패하거나 형식이 다르면 이유 문자열이다
function closedPrs(repo: string, authors: string[]): ClosedPr[] | string {
  const prs: ClosedPr[] = []
  for (const author of authors) {
    const listed = ghList(repo, ['pr', 'list', '--state', 'closed', '--author', author, '--limit', '100', '--json', CLOSED_FIELDS])
    if (typeof listed === 'string') return listed
    for (const pr of listed) {
      if (!isClosedPr(pr)) return `gh pr list --author ${author} 의 PR 형식이 다르다`
      prs.push(pr)
    }
  }
  return prs
}

// 원격 브랜치 이름에서 끝점으로
function remoteHeads(repo: string): Map<string, string> | string {
  const done = git(repo, 'ls-remote', '--heads', 'origin')
  if (done.code !== 0) return `git ls-remote 실패: ${done.err}`
  const heads = new Map<string, string>()
  for (const line of lines(done.out)) {
    const [oid, ref] = line.split(/\s+/)
    if (oid && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), oid)
  }
  return heads
}

// 열린 PR 의 base 와 head 이름. 열린 PR 의 head 는 지우면 그 PR 이 닫히므로 함께 남긴다
// limit 만큼 읽혔으면 뒤가 잘렸을 수 있다. 잘린 목록으로는 열린 PR 의 base 와 head 를 지켜 주지 못한다
function openRefs(repo: string): { bases: Set<string>; heads: Set<string> } | string {
  const listed = ghList(repo, ['pr', 'list', '--state', 'open', '--limit', String(OPEN_PR_LIMIT), '--json', 'baseRefName,headRefName'])
  if (typeof listed === 'string') return listed
  if (listed.length >= OPEN_PR_LIMIT) return `열린 PR 이 ${OPEN_PR_LIMIT} 개 이상이라 목록을 다 읽었는지 알 수 없다`
  const bases = new Set<string>()
  const heads = new Set<string>()
  for (const pr of listed) {
    if (!isObject(pr) || typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string') return '열린 PR 목록의 형식이 다르다'
    bases.add(pr.baseRefName)
    heads.add(pr.headRefName)
  }
  return { bases, heads }
}

// 남은 로컬 브랜치가 쓰는 원격 브랜치 이름에서 남길 이유로. worktreeBranches 는 정리 뒤 남은 워크트리의 브랜치다.
// 워크트리의 브랜치는 이름 자체와 upstream 을, 워크트리 없는 로컬 브랜치는 upstream 만 본다. 읽지 못하면 이유 문자열이다
function usedRemoteNames(repo: string, worktreeBranches: Set<string>): Map<string, string> | string {
  const listed = git(repo, 'for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads/')
  if (listed.code !== 0) return `로컬 브랜치를 읽지 못했다: ${listed.err}`
  const used = new Map<string, string>()
  const remote = 'refs/remotes/origin/'
  for (const line of lines(listed.out)) {
    const [branch, upstream = ''] = line.split('\0')
    const name = upstream.startsWith(remote) ? upstream.slice(remote.length) : ''
    if (worktreeBranches.has(branch)) {
      used.set(branch, '워크트리가 쓴다')
      if (name) used.set(name, '워크트리가 쓴다')
    } else if (name && !used.has(name)) {
      used.set(name, '로컬 브랜치가 쓴다')
    }
  }
  return used
}

function hasCommit(repo: string, oid: string): boolean {
  return git(repo, 'cat-file', '-e', `${oid}^{commit}`).code === 0
}

// 원격 브랜치 하나의 판정. 지울 PR 이나 남길 이유다. 차례는 머리 주석의 「원격 브랜치 정리」 표다
function remoteVerdict(
  repo: string,
  name: string,
  tip: string,
  prs: ClosedPr[],
  base: string,
  open: { bases: Set<string>; heads: Set<string> },
  used: Map<string, string>,
): { pr: ClosedPr } | { keep: string } {
  if (prs.some((pr) => pr.isCrossRepository)) return { keep: 'fork 의 브랜치다' }
  if (name === base || name.startsWith('release/')) return { keep: '보호 브랜치다' }
  const user = used.get(name)
  if (user) return { keep: user }
  const same = prs.filter((pr) => pr.headRefOid === tip)
  const pr = same.find((p) => p.state === 'MERGED') ?? same[0]
  if (!pr) return { keep: '원격 끝점이 PR head 와 다르다' }
  if (open.bases.has(name)) return { keep: '열린 PR 의 base 다' }
  if (open.heads.has(name)) return { keep: '열린 PR 의 head 다' }
  if (pr.state === 'MERGED') return { pr }
  if (!hasCommit(repo, tip)) {
    git(repo, 'fetch', '-q', 'origin', pr.headRefName)
    if (!hasCommit(repo, tip)) return { keep: 'head 커밋을 받지 못했다' }
  }
  const target = `refs/remotes/origin/${pr.baseRefName}`
  if (!pr.baseRefName || git(repo, 'rev-parse', '--verify', '-q', target).code !== 0) return { keep: 'base 를 찾지 못했다' }
  if (git(repo, 'merge-base', '--is-ancestor', tip, target).code === 0) return { pr }
  return { keep: 'CLOSED 이고 head 가 base 에 없다' }
}

// --remote-branches. 후보를 모두 읽은 뒤에 지운다. 하나라도 읽지 못하면 아무것도 지우지 않고 false 다
// worktreeBranches 는 워크트리 정리 뒤 남은 워크트리의 브랜치다
function sweepRemoteBranches(repo: string, base: string, apply: boolean, owners: Owners, worktreeBranches: Set<string>, log: Log): boolean {
  const skipped = (why: string): boolean => {
    log(`원격 브랜치 정리 건너뜀: ${why}`)
    return false
  }
  const authors = owners()
  if (!authors) return skipped('내 PR 의 작성자를 정하지 못했다')
  const prs = closedPrs(repo, authors)
  if (typeof prs === 'string') return skipped(prs)
  const heads = remoteHeads(repo)
  if (typeof heads === 'string') return skipped(heads)
  const open = openRefs(repo)
  if (typeof open === 'string') return skipped(open)
  const used = usedRemoteNames(repo, worktreeBranches)
  if (typeof used === 'string') return skipped(used)
  const byName = new Map<string, ClosedPr[]>()
  for (const pr of prs) byName.set(pr.headRefName, [...(byName.get(pr.headRefName) ?? []), pr])
  for (const [name, group] of byName) {
    const tip = heads.get(name)
    if (tip === undefined) continue
    const verdict = remoteVerdict(repo, name, tip, group, base, open, used)
    if ('keep' in verdict) {
      log(`원격 브랜치 남김 ${name}: ${verdict.keep}`)
      continue
    }
    const tag = `(#${verdict.pr.number} ${verdict.pr.state})`
    if (!apply) {
      log(`원격 브랜치를 지울 것 ${name} ${tag}`)
      continue
    }
    // 판정한 끝점일 때만 지운다. 그사이 push 된 커밋이 있으면 거부된다
    const done = git(repo, 'push', '-q', `--force-with-lease=refs/heads/${name}:${tip}`, 'origin', '--delete', name)
    log(done.code === 0 ? `원격 브랜치 삭제 ${name} ${tag}` : `원격 브랜치 삭제 실패 ${name}: ${done.err}`)
  }
  return true
}

type Sweep = { repo: string; args: Args; workers: WorkerRow[]; specsDir: string | null; log: Log; report: Report; owners: Owners }

async function sweepWorktree(s: Sweep, path: string, branch: string, listed: Terminal[]): Promise<void> {
  const { repo, args, workers, specsDir, log, report } = s
  let terminals = listed
  const name = basename(path)
  const keep = (reason: string, line: string) => {
    log(line)
    report.skipped.push({ path, reason })
  }
  const mine = workersAt(workers, path)
  const launched = launchedOwn(repo, mine, terminals, path)
  const taken = new Set<unknown>([...takenOverOwn(args, mine, terminals, path), ...launched])
  const owner = await ownershipBlocker(path, taken, args.allWorkers)
  if (owner) return keep(owner, `남김: ${owner} (${path})`)
  if (!branch) return sweepDetached(repo, path, args, terminals, log, report)
  const prot = protectedReason(repo, branch, args.base)
  if (prot) return keep(`${prot} (${branch})`, `건너뜀 ${path}: ${prot} (${branch})`)
  let m = merged(repo, branch, args.base)
  // PR 을 만들지 않는 일은 dispatch 가 끝나고 남긴 것이 없으면 치운다. 아니면 이유를 덧붙여 남긴다
  let byNoPr = false
  if (!m.ok && m.noPr) {
    const why = noPrBlocker(s, branch, path, mine)
    if (why === null) {
      m = { ...m, ok: true, why: BY_NO_PR }
      byNoPr = true
    } else {
      m = { ...m, why: `${m.why}. 치우지 않는 이유: ${why}` }
    }
  }
  // 머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널. 워크트리를 남기더라도 터미널은 닫고 dispatch 를 반납한다
  const closing = closedOwnTerminals(s, m.pr, mine, terminals, path)
  if (!m.ok) {
    if (closing && m.pr) {
      closeForClosedPr(closing, m.pr, args.apply, log, '')
      releaseDispatches(mine, args.apply, log, '')
    }
    return keep(m.why, `남김 ${path}: ${m.why}`)
  }
  if (dirty(path)) return keep('커밋 안 된 변경', `건너뜀 ${path}: 커밋 안 된 변경`)
  const lost = unpushed(path, 'HEAD', m.mergedHead, m.mergedHead === null)
  if (lost) {
    const reason = `원격에 없는 커밋 ${lost > 0 ? lost : '확인 실패'}`
    return keep(reason, `건너뜀 ${path}: ${reason}`)
  }
  const alive = new Set(terminals.map((t) => t.handle ?? null))
  // PR 이 MERGED 면 끝난 worker 의 세션 터미널이 남아 있어도 살아 있다고 보지 않는다. 아래에서 그 터미널을 닫는다.
  // 머지 없이 CLOSED 가 된 내 PR(closing)도 그 dispatch 의 터미널을 아래에서 닫으므로 같게 다룬다
  const byPr = m.why === BY_PR
  // 터미널을 닫고 치우는 판정. 코디네이터가 띄운 끝난 터미널은 아래에서 닫으므로 살아 있다고 보지 않는다
  const byDone = byPr || byNoPr
  const live = mine.filter(
    (w) =>
      LIVE_STATES.has(w.workerState as string) ||
      (!byPr && closing === null && alive.has(w.agentTerminalHandle ?? null) && !(byNoPr && launched.has(w.agentTerminalHandle))),
  )
  if (live.length) {
    const reason = `살아 있는 worker ${live.map((w) => String(w.dispatchId ?? '?')).join(', ')}`
    return keep(reason, `건너뜀 ${path}: ${reason}`)
  }
  let theirs = foreignAt(args, mine, terminals, path)
  if (theirs.length && args.foreign === null && idleAgentPath(args, path)) {
    log(`  ${path}: 하위 에이전트 워크트리의 빈 셸 터미널이라 다른 Run 의 것으로 세지 않는다`)
    theirs = []
  }
  if (theirs.length && args.foreign === null && byDone && emptyShells(path, mine, theirs, terminals)) {
    // 코디네이터가 worker 터미널을 닫으면 Orca 가 그 탭에 빈 셸을 다시 연다. 어느 Run 의 것도 아니다
    for (const handle of theirs) {
      if (args.apply) log(closeTerminal(handle) ? `  빈 셸을 닫았다: ${handle}` : `  빈 셸 닫기 실패 ${handle}`)
      else log(`  빈 셸을 닫을 것: ${handle}`)
    }
    const closed = new Set<unknown>(theirs)
    terminals = terminals.filter((t) => !closed.has(t.handle))
    theirs = []
  }
  if (theirs.length) {
    const what = args.foreign !== null ? '다른 Run 의 worker 터미널' : '다른 Run 의 것인지 확인하지 못한 터미널'
    const reason = `${what} ${theirs.join(', ')}`
    return keep(reason, `건너뜀 ${path}: ${reason}. 그 Run 의 코디네이터가 정리한다`)
  }
  const closable = closing ?? (byNoPr ? [...launched] : [])
  if (!byPr && terminalsAt(terminals, path).some((h) => !closable.includes(h))) {
    const reason = '살아 있는 터미널이 있다. PR 이 MERGED 가 아니면 터미널을 닫지 않는다'
    return keep(reason, `건너뜀 ${path}: ${reason}`)
  }

  log(`정리 ${path} (${branch}, ${m.why})`)
  if (args.apply) {
    // 터미널을 닫고 dispatch 를 반납한 뒤에 거부되면 터미널 없는 워크트리가 남으므로 그 앞에서 묻는다
    const input: Json = { worktree: path, branch }
    if (m.pr) input.pr = prInput(m.pr)
    const worker = mine.find((w) => truthy(w.dispatchId))
    if (worker) input.worker = workerInput(worker, path)
    const verdict = await fire('before-cleanup', input, { repo, base: args.base, run: args.run, out: log })
    if (verdict.result !== 'pass' && verdict.result !== 'none') return keep(KEPT_BY_HOOK, `남김 ${path}: ${KEPT_BY_HOOK}`)
  }
  const plan = remotePlan(repo, branch, m.pr)
  // 경로의 터미널은 PR 이 MERGED 일 때만 모두 닫는다. cherry 로만 판정한 브랜치는 막 만든 브랜치일 수 있다.
  // 머지 없이 CLOSED 가 된 내 PR 이면 그 dispatch 가 쓴 터미널만 닫는다
  if (byPr) closeTerminals(terminalsAt(terminals, path), args.apply, log)
  else if (closing && m.pr) closeForClosedPr(closing, m.pr, args.apply, log, '  ')
  else if (byNoPr) closeTerminals(terminalsAt(terminals, path).filter((h) => launched.has(h)), args.apply, log)
  releaseDispatches(mine, args.apply, log, '  ')
  if (!args.apply) {
    const pids = holderPids(path, REAL_HOST)
    if (pids.length && byDone && onlyIdleShells(pids, REAL_HOST)) {
      log(`  남은 프로세스 ${pids.length} 개가 유휴 셸뿐이면 그 Orca 터미널을 닫고 다시 시도한다`)
    } else if (pids.length && args.killHolders) {
      const blocker = killBlocker(mine, path, byPr, false)
      log(
        `  터미널을 닫은 뒤에도 프로세스 ${pids.length} 개가 남으면 ` +
          (blocker ? `다음 실행으로 미룬다. 끄지 않는 이유: ${blocker}` : 'TERM, HUP, KILL 순으로 끈다'),
      )
    } else if (pids.length) {
      log(`  터미널을 닫은 뒤에도 프로세스 ${pids.length} 개가 남으면 다음 실행으로 미룬다`)
    }
    log(`  worktree 와 로컬 브랜치를 지울 것 ${branch}`)
    deleteRemote(repo, plan, args.base, false, log)
    deleteSpecFiles(specsDir, name, false, log, args.liveSpecs, branch, m.pr)
    return
  }

  let pids = await waitFree(path, args.wait, args.pollInterval)
  if (pids.length && byDone && onlyIdleShells(pids, REAL_HOST)) {
    // worker 를 반납한 뒤 Orca 가 띄운 빈 셸이 폴더를 붙잡는다. 터미널과 worker 를 다시 읽어 그 터미널을 닫는다.
    // 소유 상태는 캐시를 거치지 않고 새로 읽는다. 기다리는 사이 사용자가 넘겨받았을 수 있다
    const again = await ownershipBlocker(path, taken, allWorkers)
    if (again) return keep(again, `남김: ${again} (${path})`)
    const foreign = args.foreign ?? new Set<unknown>()
    const handles = terminalsAt(liveTerminals(), path).filter((h) => !foreign.has(h))
    if (handles.length) {
      log(`  남은 프로세스 ${pids.length} 개가 유휴 셸뿐이다. Orca 터미널을 닫고 다시 시도한다`)
      closeTerminals(handles, true, log, '유휴 셸 터미널')
      pids = await waitFree(path, args.wait, args.pollInterval)
    }
  }
  if (pids.length && args.killHolders) {
    const blocker = killBlocker(mine, path, byPr)
    if (blocker) {
      log(`  남은 프로세스를 끄지 않는다: ${blocker}`)
    } else {
      const nested = worktrees(repo)
        .map(([other]) => other)
        .filter((other) => other.startsWith(`${path}/`))
      pids = await stopHolders(path, nested, args.wait, log, args.pollInterval)
    }
  }
  const hooks = sessionEndHooks(pids, REAL_HOST)
  if (hooks.length) {
    log(`  OMC session-end hook ${hooks.join(', ')} 은 끄지 않는다. remove-worktree.ts 가 끝날 때까지 기다린다`)
    pids = pids.filter((pid) => !hooks.includes(pid))
  }
  if (pids.length) {
    const reason = `그 경로를 쓰는 프로세스 ${pids.length} 개(${describe(pids, REAL_HOST)})`
    log(`  건너뜀: ${reason}. 다음 실행에서 다시 시도한다`)
    report.skipped.push({ path, reason })
    return
  }
  const removeArgs = [path, '--delete-branch', ...(m.mergedHead ? ['--merged-head', m.mergedHead] : [])]
  // remove-worktree.ts 는 OMC session-end hook 이 끝나기를 ORCH_HOOK_WAIT 초(기본 180)까지 기다린다
  const removed = run(scriptCommand(REMOVE, removeArgs), { timeoutSec: args.removeTimeoutSec })
  const said = removed.out || removed.err
  log(`  ${said.replaceAll('\n', '\n  ')}`)
  if (removed.code !== 0) {
    report.skipped.push({ path, reason: said })
    return
  }
  report.removed.push(path)
  for (const w of mine) if (typeof w.dispatchId === 'string') forgetLaunch(repo, w.dispatchId)
  deleteRemote(repo, plan, args.base, true, log)
  deleteSpecFiles(specsDir, name, true, log, args.liveSpecs, branch, m.pr)
}

function sweepBranches(repo: string, args: Args, checkedOut: Set<string>, log: Log): void {
  const listed = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  if (listed.code !== 0) return
  for (const branch of lines(listed.out)) {
    if (checkedOut.has(branch) || protectedReason(repo, branch, args.base)) continue
    const m = merged(repo, branch, args.base)
    if (!m.ok) continue
    const lost = unpushed(repo, branch, m.mergedHead, m.mergedHead === null)
    if (lost) {
      log(`건너뜀 브랜치 ${branch}: 원격에 없는 커밋 ${lost > 0 ? lost : '확인 실패'}`)
      continue
    }
    const plan = remotePlan(repo, branch, m.pr)
    if (args.apply) {
      const done = git(repo, 'branch', '-D', branch)
      log(done.code === 0 ? `브랜치 삭제 ${branch} (${m.why})` : `브랜치 삭제 실패 ${branch}: ${done.err}`)
    } else {
      log(`브랜치를 지울 것 ${branch} (${m.why})`)
    }
    deleteRemote(repo, plan, args.base, args.apply, log)
  }
}

// 머지 큐 로그 정리가 쓰는 실제 조회. PR 은 번호마다 `gh pr view` 로 읽고 읽지 못한 번호는 담지 않는다
function queueLogHost(repo: string) {
  return {
    now: () => Date.now(),
    openedBy: lsofOpenedBy,
    prStates: (numbers: number[]) => {
      const states = new Map<number, string>()
      for (const n of numbers) {
        const done = ghJson<{ state?: unknown }>(['pr', 'view', String(n), '--json', 'state'], { cwd: repo })
        if (done.ok && isObject(done.data) && PR_STATES.has(done.data.state as string)) states.set(n, done.data.state as string)
      }
      return states
    },
  }
}

// 종료 코드를 돌려준다. 내 PR 의 작성자나 원격 브랜치 후보를 읽지 못하면 그 동작만 하지 않고 2 다
async function sweepRepo(repo: string, given: Args, workers: WorkerRow[], terminals: Terminal[], log: Log): Promise<number> {
  const base = given.base || (defaultBase(repo) ?? 'main')
  const args: Args = { ...given, base }
  if (!args.specsDir && !requireMigrated(repo, 'cleanup-sweep', '지시서 폴더를 --specs-dir 로 직접 준다')) {
    throw new RepoError(`${repo}: orch 작업 폴더를 옮기기 전이라 건너뛴다`)
  }
  const specsDir = args.specsDir ? (isAbsolute(args.specsDir) ? args.specsDir : join(repo, args.specsDir)) : null
  git(repo, 'fetch', '-q', '--prune', 'origin')
  log(`cleanup-sweep ${args.apply ? 'apply' : 'dry-run'}: ${repo} (base ${base})`)
  followBase(repo, base, args.apply, log)
  // 폴더가 이미 없는 워크트리 등록을 먼저 지운다. 남으면 그 브랜치 삭제가 `used by worktree` 로 거절된다
  // -v 의 목록은 stderr 로 나온다
  const pruned = git(repo, 'worktree', 'prune', '-v', ...(args.apply ? [] : ['-n'])).err
  for (const line of lines(pruned)) log(`prune: ${line}`)
  const report: Report = { removed: [], skipped: [] }
  let code = 0
  const owners = ownersOf(repo, (why) => {
    err(`cleanup-sweep: ${repo}: 내 PR 의 작성자를 정하지 못해 원격 브랜치 정리와 CLOSED PR 의 터미널 정리를 하지 않는다: ${why}`)
    code = 2
  })
  const s: Sweep = { repo, args, workers, specsDir, log, report, owners }
  for (const [path, branch] of worktrees(repo)) await sweepWorktree(s, path, branch, terminals)
  const remaining = new Set(worktrees(repo).map(([, branch]) => branch))
  remaining.add(git(repo, 'branch', '--show-current').out)
  sweepBranches(repo, args, remaining, log)
  if (args.remoteBranches && !sweepRemoteBranches(repo, base, args.apply, owners, remaining, log)) code = 2
  sweepQueueLogs({ dir: pathOf('queue', repo), trash: args.trash, apply: args.apply, log, host: queueLogHost(repo) })
  if (!args.apply) return code
  try {
    // 실패와 시간 초과는 HOOK-FAIL 줄만 남긴다. 정리의 2 는 사용법 오류와 저장소 조회 실패를 뜻한다(머리 주석의 「종료 코드」).
    // after-cleanup 의 실패를 2 에 섞으면 정리 자체가 실패한 경우와 구별할 수 없다
    await fire('after-cleanup', { removed: report.removed, skipped: report.skipped }, { repo, base, run: args.run, out: log })
  } catch (e) {
    process.stderr.write(`cleanup-sweep: after-cleanup 을 내지 못했다: ${(e as Error)?.message ?? String(e)}\n`)
  }
  return code
}

// argparse 의 float 와 같은 꼴만 받는다. 무한대와 NaN 도 받아 범위 검사가 거부하게 한다. 수가 아니면 null 이다
function parseFloatArg(text: string): number | null {
  const t = text.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t)
  const word = /^([+-]?)(inf|infinity|nan)$/i.exec(t)
  if (!word) return null
  if (word[2].toLowerCase() === 'nan') return Number.NaN
  return word[1] === '-' ? -Infinity : Infinity
}

// 휴지통 폴더. 안 주면 handoff-cleanup.ts 와 같은 ~/.Trash/orch-cleanup-<날짜> 다
function trashDir(given: string | undefined): string {
  if (given) return given === '~' ? homedir() : given.startsWith('~/') ? join(homedir(), given.slice(2)) : given
  const day = new Date()
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  return join(homedir(), '.Trash', `orch-cleanup-${stamp}`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

export async function main(argv: string[]): Promise<number> {
  const options = {
    repo: { type: 'string', multiple: true },
    base: { type: 'string' },
    run: { type: 'string' },
    'specs-dir': { type: 'string' },
    'kill-holders': { type: 'boolean', default: false },
    'agent-glob': { type: 'string', default: 'agent-*' },
    'close-own-taken-over': { type: 'boolean', default: false },
    'remote-branches': { type: 'boolean', default: false },
    trash: { type: 'string' },
    apply: { type: 'boolean', default: false },
    wait: { type: 'string', default: '5' },
    'poll-interval': { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h' },
  } as const
  let values
  try {
    const expanded = expandArgs(argv, options, ['repo', 'base', 'run', 'specs-dir', 'agent-glob', 'trash', 'wait', 'poll-interval'])
    ;({ values } = parseArgs({ args: expanded, options, allowPositionals: false }))
  } catch (e) {
    err(`${USAGE}\ncleanup-sweep: ${(e as Error).message}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!values.repo?.length) {
    err(`${USAGE}\ncleanup-sweep: --repo 가 필요하다`)
    return 2
  }
  const wait = parseFloatArg(values.wait)
  const pollInterval = parseFloatArg(values['poll-interval'])
  if (wait === null || pollInterval === null) {
    err(`${USAGE}\ncleanup-sweep: --wait 와 --poll-interval 은 수다`)
    return 2
  }
  if (!(wait >= 0 && wait < Infinity) || !(pollInterval > 0 && pollInterval < Infinity)) {
    err('cleanup-sweep: --wait 는 0 이상, --poll-interval 은 0 초과의 유한한 수다')
    return 2
  }
  const run = values.run || null
  if (values['close-own-taken-over'] && !run) {
    err('cleanup-sweep: --close-own-taken-over 는 --run 과 함께 쓴다')
    return 2
  }
  const hookWait = process.env.ORCH_HOOK_WAIT ?? '180'
  if (!/^\s*[+-]?\d+\s*$/.test(hookWait)) {
    err('cleanup-sweep: ORCH_HOOK_WAIT 는 정수다')
    return 2
  }
  const repos = [...new Set(values.repo.map((repo) => realPath(repo)))]
  const log: Log = (line) => {
    process.stdout.write(`${line}\n`)
  }

  const terminals = liveTerminals()
  if (terminals === null) {
    err('cleanup-sweep: orca terminal list 를 읽지 못해 살아 있는 worker 를 판정할 수 없다')
    return 2
  }
  const specsDir = values['specs-dir'] || null
  const args: Args = {
    base: values.base ?? '',
    run,
    specsDir,
    killHolders: values['kill-holders'],
    agentGlob: values['agent-glob'],
    closeOwnTakenOver: values['close-own-taken-over'],
    remoteBranches: values['remote-branches'],
    trash: trashDir(values.trash),
    apply: values.apply,
    wait,
    pollInterval,
    removeTimeoutSec: Number(hookWait) + 60,
    foreign: null,
    // 정리 한 번 안에서 모든 Run 의 소유 상태를 한 번만 읽는다. 소유 확인과 다른 Run 판정이 같은 행을 쓴다
    allWorkers: cached(allWorkers),
    liveSpecs: new Set(),
  }
  let workers: WorkerRow[] = []
  if (run) {
    try {
      workers = await runWorkers(run)
    } catch (e) {
      if (!(e instanceof LookupError)) throw e
    }
    args.foreign = await foreignHandles(run, args.allWorkers)
    if (args.foreign === null) err('cleanup-sweep: 모든 Run 의 worker 를 읽지 못해 이 Run worker 의 터미널만 닫는다')
  }
  args.liveSpecs = specsDir ? liveSpecPaths(run) : new Set()
  if (args.liveSpecs === null) err('cleanup-sweep: 살아 있는 dispatch 의 지시서 목록을 읽지 못해 지시서와 PR 본문은 지우지 않는다')
  let code = 0
  for (const repo of repos) {
    try {
      if ((await sweepRepo(repo, args, workers, terminals, log)) !== 0) code = 2
    } catch (e) {
      if (!(e instanceof RepoError || e instanceof ConfigError)) throw e
      err(`cleanup-sweep: ${e.message}`)
      code = 2
    }
  }
  return code
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (e: unknown) => {
      err(`cleanup-sweep: ${(e as Error)?.stack ?? String(e)}`)
      process.exitCode = 1
    },
  )
}
