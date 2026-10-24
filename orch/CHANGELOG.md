# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 3.3.0 (2026-10-25)

- 정리와 대기열 명령(`remove-worktree`, `cleanup-sweep`, `handoff-cleanup`, `board-sync`, `goal-progress`, `heavy-slot`, `mem-gate`, `orch_paths`)과 work-board 의 `board` 를 TypeScript 로 옮겼다. 옛 `.py` 경로는 shim 으로 남아 `DEPRECATED` 줄을 내고 `.ts` 로 넘긴다.
- `cleanup-sweep` 이 `before-cleanup` 과 `after-cleanup` 이벤트를 낸다. `--apply` 정리에서 `before-cleanup` 핸들러가 거부하거나 실패하면 그 워크트리를 남긴다.
- `cleanup-sweep --remote-branches` 를 더했다. 머지된 브랜치의 원격 삭제는 판정한 끝점을 `--force-with-lease` 로 붙여, 판정한 뒤 push 된 브랜치를 지우지 않는다. 열린 PR 의 head 인 브랜치와 fork 의 PR 이 있는 브랜치는 남긴다.
- `heavy` 절과 `heavy.wait_idle` 을 더했다. `wait_idle` 은 대기열 밖에서 도는 무거운 프로세스(이미지 빌드 같은 것)가 끝날 때까지 자리를 잡지 않고 기다린다.
- 쓰지 않는 모듈 `terminal_ownership.py`, `live_specs.py`, `orch_process.py` 를 지웠다. 소유 판정과 살아 있는 지시서 목록은 `scripts/lib/` 가 맡는다.
- 마지막 Python 테스트를 node:test 로 옮기고 `scripts/run-orch-tests.py` 를 지웠다. `node --test` 하나로 orch 와 work-board 테스트를 돌린다. CI 의 node 단계가 work-board 테스트를 함께 돌린다.
- 문서가 옮긴 명령을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<명령>.ts"` 로 부른다. `orch-doctor.py` 는 스킬을 열 때 node 버전을 보는 공식 진입점이라 그대로 둔다.

호환성:

- 무거운 검사의 자동 분류를 지웠다. `heavy-slot` 은 명령 이름을 보고 혼자 실행(`exclusive`)이나 대기열 건너뛰기(`light`)를 정하지 않는다. `.orch/config.json` 에 `heavy` 절이 없으면 모든 명령이 자리를 기다린다(`normal`). 옛 동작에 가까운 설정 예시는 아래와 같다. 명령 이름은 저장소에 맞게 바꾼다.

  ```json
  {
    "heavy": {
      "exclusive": ["local-ci", "playwright", "browser"],
      "light": ["^(pnpm( -s)?( exec)? )?(tsc|oxlint)\\b", "^pnpm( -s)? (type-check|lint)\\b", "^(echo|cd|git|ls|cat|true|test)(\\s|$)"]
    }
  }
  ```

- `wait_idle` 대기가 `HEAVY_IDLE_WAIT`(기본 1800초)를 넘으면 `heavy-slot` 이 종료 코드 124 로 끝난다. `HEAVY_POLL` 과 `HEAVY_IDLE_WAIT` 값은 등록 전에 검사해 틀리면 1 로 끝난다.
- `heavy-slot` 의 `queue.lock` 은 perl 자식이 flock 으로 쥔다. 옛 `heavy-slot.py` 와 같은 파일에 같은 종류의 잠금을 걸어, 옮기는 동안 두 버전이 같은 slot 폴더를 써도 서로를 막는다. perl 이 PATH 에 필요하다.
- `heavy-slot` 은 `queue.lock` 을 기다리는 중에 INT 나 TERM 을 받으면 기다림을 멈추고 128 에 신호 번호를 더한 값으로 끝난다.
- `cleanup-sweep` 의 지시서를 남기는 줄이 `살아 있는 지시서 목록을 읽지 못했다` 로 바뀌었다. 그 목록을 읽지 못하면 PR 본문 파일도 지우지 않는다.
  stderr 의 알림 줄도 `… 읽지 못해 지시서와 PR 본문은 지우지 않는다` 로 바뀌었다.
- `handoff-cleanup` 의 지시서 줄이 `지시서를 휴지통으로 옮길 것 …`, `지시서 옮김 … -> …`, `지시서를 남긴다 …` 로 바뀌었다. 경로는 절대경로다. 큐 로그, 폴더, 데이터 파일의 `후보`, `옮김` 줄은 그대로다.
  살아 있는 dispatch 가 쓰는 지시서는 끝난 지시서일 때만 `지시서를 남긴다` 줄을 낸다. 옛 명령은 끝나지 않은 지시서에도 남긴다 줄을 냈다.
- `handoff-cleanup` 은 `**보드 항목 id**:` 꼴도 보드 항목 줄로 읽는다. 그 꼴로 쓴 지시서는 보드 항목이 done 이 아니면 남는다.
- `handoff-cleanup` 은 원격 브랜치 조회(`git ls-remote --exit-code`)가 「그 브랜치가 없다」(2) 말고 다른 이유로 실패하면 지시서를 남긴다. 옛 명령은 네트워크 실패도 원격에 없다고 읽었다.
- `cleanup-sweep --remote-branches` 는 남은 워크트리의 브랜치나 그 upstream 인 원격 브랜치를 `원격 브랜치 남김 <이름>: 워크트리가 쓴다` 로, 워크트리 없는 로컬 브랜치의 upstream 을 `원격 브랜치 남김 <이름>: 로컬 브랜치가 쓴다` 로 남긴다.
  열린 PR 목록이 limit(1000)만큼 읽히면 잘렸을 수 있어 `원격 브랜치 정리 건너뜀: 열린 PR 이 1000 개 이상이라 …` 를 내고 종료 코드를 2 로 둔다.
- `cleanup-sweep` 은 `--run` 을 주면 머지 없이 CLOSED 가 된 내 PR 의 끝난 dispatch 터미널을 닫고 dispatch 를 반납한다. 워크트리를 지우는 조건은 바뀌지 않았다.
- 보드 명령의 기본(`BOARD_BIN` 이 없을 때)이 `work-board/bin/board.ts` 다. `board.py` 는 shim 으로 남는다.
- `--apply` 정리에서 `before-cleanup` 핸들러가 거부하거나 실패하면 그 워크트리를 남긴다.

## 3.2.0 (2026-10-24)

worker 가 PR 이 머지될 때까지 맡는다. `planning` 2.31.0 의 「plan 하나는 PR 하나」 와 이어진다.

- 공통 지시서 틀의 끝내기를 바꿨다. PR 이 열리면 `준비됨 #PR, head SHA` 를 보내고, 머지될 때까지 CI 실패, 충돌, 기준 브랜치 변경, 리뷰를 직접 처리하고, MERGED 를 확인한 뒤 `worker_done` 을 보낸다. PR 이 없는 일은 전과 같이 완료 기준을 채운 뒤 보낸다
- 지시서 하나는 PR 하나로 끝나는 크기로 쓰고, 더 큰 일은 나눠 앞 PR 이 머지된 뒤 다음 지시서를 쓴다
- 검증은 `준비됨` 을 받은 때 한다. `worker_done` 이 오기 전에 코디네이터가 diff 를 읽고 머지 큐에 넣는다는 순서를 `verification.md` 에 적었다
- 스크립트는 바꾸지 않았다. `준비됨` status 는 이미 `worker_done` 의 근거로 쓰이고(`lib/completion.ts`), 머지 뒤 터미널 정리는 `cleanup-sweep.py` 가 이미 한다

## 3.1.0 (2026-10-24)

- 머지 단계의 명령(`overlap_units`, `ci-ready`, `notify-conflicts`, `merge_queue`, `merge-with-finish`, `finish-pr`)과 `migrate-orch-dir` 를 TypeScript 로 옮겼다. 충돌 판정은 `scripts/lib/git.ts` 의 merge-tree 한 벌로, 열린 PR 의 충돌 찾기와 알린 기록은 `scripts/lib/conflicts.ts` 로 모았다.
- 옮긴 명령이 이벤트를 낸다. `ci-ready` 는 `before-ready` 와 `pr-ready`, `notify-conflicts` 는 `pr-conflict`, 머지 큐는 `before-merge`, `verify-merged`, `after-merge`, `after-queue`, `finish-pr` 는 `after-deploy` 다. 내는 명령의 표는 `references/hooks.md` 의 「이벤트 고르기」 에 두었다.
- `merge-with-finish` 의 `PR!` 를 머지 큐에 `--last-of-task` 로도 넘긴다. `before-merge` 입력의 `last_of_task` 가 이 값이다.
- 업무 완료를 `after-deploy` 이벤트로 바꿨다. 핸들러는 배포가 실패하거나 시간을 넘겨도 불리고 입력의 `deploy` 로 스스로 판단한다.
- `migrate-orch-dir --hooks` 를 더했다. `config.json` 의 옛 셸 명령 칸(`queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd` 와 `finish.task_pattern`)을 같은 일을 하는 `hooks/<이벤트>.ts` 로 바꾸고 그 칸을 지운다. 기본은 미리보기이고, 핸들러 파일이 이미 있거나 정규식을 옮길 수 없는 칸은 남긴다. 옮기는 순서는 `references/hooks.md` 의 「옛 설정 칸 옮기기」 에 두었다.
- `migrate-orch-dir` 가 막는 조건으로 찾는 머지 큐와 마무리 프로세스에 옮긴 명령의 `.ts` 명령줄을 더했다. 옛 `.py` 경로로 띄워도 명령줄은 `node … <이름>.ts` 라 옛 이름만 찾으면 돌고 있는 머지 큐를 놓친다.
- 문서가 옮긴 명령을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<명령>.ts"` 로 부른다. `references/overlay.md` 의 설정 표에 지울 키를 적고 `hooks` 절과 `pipeline` 절을 더했다.
- 핸들러 환경에 `ORCH_CHECKOUT` 을 더했다. 부른 명령이 `--repo` 로 받은 checkout 의 실경로이고, 연결된 워크트리면 그 워크트리다. `migrate-orch-dir --hooks` 가 만든 핸들러는 옛 명령을 이 경로에서 부른다.

호환성:

- `ci-ready` 는 GitHub `mergeable` 대신 로컬 merge-tree 로 충돌을 본다. `--repo` 의 origin 을 fetch 하고, `ORCH_READY_RETRY_SECONDS` 는 읽지 않는다. 다른 사람의 PR 은 보류한다.
- `notify-conflicts` 는 내 PR 만 보고, 끝난 dispatch 는 후속 지시서(`spec-conflict-<PR>-<base>.md`)로 남은 터미널에 이어 쓴다. send-to-worker 의 종료 코드 3 과 워크트리나 dispatch 를 찾지 못한 경우는 `CONFLICT-ORPHAN` 줄을 내고 기록해, 같은 (PR, base) 로 다시 알리지 않는다. 원본 테스트 `test_undelivered_message_is_not_recorded` 는 이 규칙으로 바뀌었고, 「기록하지 않는다」 는 종료 코드 5 와 끝난 dispatch 의 1 이 이어 받는다.
- 끝난 dispatch 에 보낸 `send-to-worker` 가 1 로 끝나면, 그 출력에 `LAUNCHED <id>` 줄이 있을 때만 worker 가 다시 뜬 것으로 보고 `resumed` 로 기록한다. `restart:` 줄만 있으면 다시 띄우기가 성공했는지 알 수 없어 기록하지 않고, 다음 실행이 다시 보낸다.
- `--shared-paths` 와 `finish.task_pattern` 은 JS 정규식으로 읽는다. `(?P<이름>`, `(?P=이름)`, `\A`, `\Z` 는 같은 뜻으로 바꾼다. 인라인 플래그(`(?i)`)처럼 JS 가 받지 않는 문법은 사용법 오류다.
- 옛 칸(`queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd`, 같은 이름의 명령줄 옵션)도 이벤트 실행기로 돈다. 옛 칸도 1800초 제한을 받는다. 더 길면 `hooks.timeouts.<이벤트>` 로 늘린다. 핸들러와 같은 가드 PATH 를 거치고, `DEPRECATED <옵션> → hooks/<이벤트>.ts` 줄을 낸다. `PR:명령` 은 시간 제한 없이 지금처럼 돈다.
- 머지 큐는 `after-merge` 나 `after-queue` 가 실패하면 모두 머지했어도 종료 코드 3 이다.
- 머지 큐는 SIGTERM 이나 SIGINT 를 받으면 진행 중인 자식(`PR:명령`, 정리, 핸들러와 옛 칸)에 TERM 을 보내고, 2초 뒤에도 남은 것에 KILL 을 보낸 뒤 사본을 지우고 끝난다. 핸들러와 옛 칸은 프로세스 그룹 전체에 보낸다. 종료 코드는 128 에 신호 번호를 더한 값(SIGTERM 143, SIGINT 130)이다. 그 사이에는 새 자식을 띄우지 않고 머지, base 합치기, base 옮기기, 원격 브랜치 삭제도 하지 않는다. 이전에는 핸들러의 프로세스 그룹이 머지 큐가 끝난 뒤에도 남았다.
- 머지한 브랜치를 base 로 둔 열린 PR 이 모두 내 PR 이면 머지 큐가 base 를 옮긴 뒤 원격 브랜치를 지운다.
- `finish-pr` 의 지시서 삭제는 살아 있는 dispatch 가 쓰는 지시서와 그 목록을 읽지 못한 실행에서는 지우지 않는다. 배포 대기 시간 초과는 `after-deploy` 의 `deploy: timeout` 이다.
- `merge-queue.sh` 는 한 버전 뒤 지운다고 했던 것을 바꿔 다음 major 까지 남긴다. 다른 저장소의 포장 스크립트가 이 경로를 부를 수 있어서다.
- 옮긴 명령의 옛 `.py` 경로는 남아 `DEPRECATED` 줄을 내고 `.ts` 로 넘긴다. ps 의 명령줄은 `node … <이름>.ts` 다.
- `migrate-orch-dir` 는 `--run` 도 설정의 `finish.run` 도 없으면 범위 없이 읽은 orca 목록이 모든 Run 의 것일 때만 옮긴다. 코디네이터 터미널처럼 한 Run 에 묶인 곳에서는 「orca 로 살아 있는 dispatch 와 worker 를 읽지 못했다」 로 막으므로 `--run` 을 준다. 지시서 폴더는 저장소마다 하나라 묶인 Run 만 본 결과로는 다른 Run 의 worker 를 지켜 주지 못한다.

## 3.0.0 (2026-10-24)

- PreToolUse hook 과 `shell_text.py` 를 TypeScript 로 옮기고 `hooks.json` 이 node 로 부르게 했다. worker 터미널 직접 입력 금지 hook 은 모든 Run 의 worker 를 보고, 대상이 변수이거나 orca 조회가 실패하거나 7초를 넘기면 통과시키지 않고 거부한다.
- 띄우기(`spec-line`, `spec-lint`, `make-worktree`, `worktree-deny`, `launch-worker`), 답하기(`send-to-worker`, `nudge-worker`, `worker-ask`), 기다리기(`wait-important`, `triage-messages`, `watch-questions`)와 `orch-doctor` 를 TypeScript 로 옮겼다. 옵션과 종료 코드는 그대로다. `ask-json.py` 는 `worker-ask.ts` 안으로, `questions.py` 와 완료 근거 판정은 `scripts/lib/` 로 합쳤다.
- 옮긴 명령이 이벤트를 낸다. `launch-worker` 는 `before-launch` 와 `worker-launched`, `watch-questions` 는 `worker-question`, `wait-important` 는 `worker-done` 과 `worker-lost`, `orch-doctor --run` 은 `session-resume` 이다. 핸들러 쓰는 법은 `references/hooks.md` 에 두었다.
- 코디네이터가 알아야 하는 조회 실패를 stderr 가 아니라 stdout 의 `WATCH-ERROR` 줄로 낸다. 하네스는 stderr 를 알림으로 보내지 않아 질문 감시가 계속 실패해도 코디네이터가 몰랐다.
- `orch-doctor` 가 저장소의 이름이 틀린 핸들러를 `UNKNOWN-HOOK`, 다음 major 에서 지울 설정 칸을 `DEPRECATED-CONFIG` 로 알린다. 둘 다 경고라 종료 코드를 바꾸지 않는다. `--repo` 로 볼 저장소를 준다.
- 문서, 공통 지시서 틀, hook 의 거부 이유가 옮긴 명령을 `node --disable-warning=ExperimentalWarning "$SKILL_DIR/scripts/<명령>.ts"` 로 부른다. 공통 지시서 틀의 설치 경로 풀이도 `python3 -c` 에서 `node -e` 로 바꿔 worker 환경에 Python 이 없어도 돈다. doctor 는 버전을 보는 진입점 `orch-doctor.py` 로 그대로 부른다.

호환성:

- 옛 `.py` 경로(`scripts/launch-worker.py` 같은 것)는 남아 같은 이름의 `.ts` 로 넘긴다. stderr 에 `DEPRECATED` 줄을 내고, 다음 major 에서 지운다. `orch-doctor.py` 는 진입점이라, `worker-ask.py` 는 답의 첫 줄 `answer:` 앞에 그 줄이 섞이지 않게 `DEPRECATED` 줄을 내지 않는다.
- 옛 `.py` 경로도 PATH 에 node 22.18 이상이 있어야 돈다. node 가 없거나 낮으면 넘기지 않고 종료 코드 127 로 끝난다. 낮으면 stdout 에 `NODE-TOO-OLD <버전>` 줄을 낸다.
- stdout 에 `WATCH-ERROR`, `HOOK-FAIL`, `[hook ...]` 줄이 새로 섞인다. 출력을 줄 단위로 읽는 도구는 이 접두를 건너뛰거나 따로 다룬다.
- 옮긴 명령의 ps 명령줄이 `python3 ... <이름>.py` 에서 `node ... <이름>.ts` 로 바뀐다. 옛 `.py` 경로로 띄워도 그렇다. `.py` 이름으로 프로세스를 찾는 도구는 확장자 없는 이름(`wait-important`)으로 찾는다.
- `watch-questions` 는 `ORCA_CLI_COMMAND` 를 읽지 않는다. 가짜 orca 는 `ORCA` 환경 변수로 넣는다.
- 옮긴 명령도 옛 argparse 처럼 옵션의 고유 접두를 받는다(`--work` 는 `--worktree`). 여러 옵션에 맞는 접두는 종료 코드 2 다.
- `send-to-worker --body`, `nudge-worker --text`, `worker-ask --question` 같은 값 옵션이 `-` 로 시작하는 값(`--body "-x"`)을 받는다. 옛 명령은 종료 코드 2 로 거부했다.
- 지시서의 브랜치 줄을 `- ` 목록에 더해 `* ` 목록 꼴(`` * 브랜치: `x` ``)로 적어도 읽는다. 옛 `make-worktree.py` 는 `- ` 만 받았다.
- `SPEC_LINE`, `MAKE_WORKTREE`, `NUDGE_WORKER`, `LAUNCH_WORKER` 로 바꾼 도구는 옛 명령처럼 확장자로 고른다. `.sh` 는 bash, `.zsh` 는 zsh, `.ts` 는 지금 도는 node 이고 `.py` 와 확장자 없는 파일을 포함한 나머지는 python3 이다.
- `wait-important` 는 SIGTERM, SIGINT, SIGHUP 을 받으면 띄운 `check --wait` 를 끝내고 128 에 신호 번호를 더한 종료 코드로 끝난다. `watch-questions` 의 stderr 줄은 `wait-important` 와 같은 `WATCH-ERROR <이유>` 꼴이다.

## 2.6.2 (2026-10-24)

- 코디네이터 터미널에서 돌린 `cleanup-sweep.py` 와 `remove-worktree.py` 가 모든 워크트리를 `남김: 터미널 소유 상태 조회 실패` 로 건너뛰던 것을 고쳤다. 범위 없는 `worker-list` 는 부른 터미널에 묶인 Run 만 주는데(scope `bound`), Orca CLI 는 `ORCA_TERMINAL_HANDLE` 이 없으면 작업 디렉터리의 활성 터미널로 호출자를 정해 환경 변수를 빼도 범위가 넓어지지 않았다. 이제 범위가 `all` 이 아니면 `run-list` 를 끝까지 따라 Run 마다 `worker-list --run` 을 병렬로 읽어 합친다. 조회 자체가 실패할 때만 실패로 남긴다.
- `terminal_ownership.py` 의 `all_workers()` 가 모든 Run 의 worker 행을 읽고, `blocker()` 와 `cleanup-sweep.py` 의 `foreign_handles()` 가 그 결과를 함께 쓴다. 정리 한 번 안에서는 읽은 지 60초가 지나야 다시 읽고, 유휴 셸을 닫기 직전 확인은 늘 새로 읽는다. 이전에는 `blocker()` 가 워크트리마다 모든 Run 을 다시 읽었다. 한 행의 `resource.terminalHandle` 과 `agentTerminalHandle` 이 다르면 둘 다 본다.
- `cleanup-sweep.py --run` 의 이 Run worker 목록을 첫 100행만 읽던 것을 끝 페이지까지 읽는다.

## 2.6.1 (2026-10-24)

- 명령을 TypeScript 로 옮길 공용 모듈을 `scripts/lib/` 에 더했다. 자식 프로세스 실행(`proc.ts`), orca, gh, git 호출, pid 생존 판정(`process.ts`), 경로(`paths.ts`), 설정(`config.ts`), 지시서(`spec.ts`)다. 지시서 삭제는 살아 있는 dispatch 를 확인하는 한 경로로 모았다.
- 이벤트 실행기 `scripts/lib/events.ts` 를 더했다. 저장소의 `<orch 루트>/hooks/<이벤트>.ts` 를 찾아 잠금, 시간 제한(그룹 TERM, 10초 뒤 KILL), 실행 기록(`state/hooks.jsonl`), 종료 코드 해석(0 통과, 10 거부)을 맡는다. 옛 설정 칸을 argv 로 받아 핸들러처럼 돌리는 `legacy` 어댑터를 함께 두었다. 죽은 pid 의 잠금은 고유 이름으로 옮겨 내용을 대조해 회수하고, 그 사이 다른 실행이 만든 새 잠금이면 덮어쓰지 않는 `link` 로 되돌린다.
- 핸들러는 끝났는데 백그라운드 손자 프로세스가 출력 파이프를 쥐고 있어도 시간 제한까지 기다리지 않는다. 2초 안에 파이프가 닫히지 않으면 그룹에 TERM, 다시 2초 뒤에도 닫히지 않으면 KILL 을 보내고 핸들러의 종료 코드로 판정한다. `runAsync` 도 자식이 끝나고 2초 뒤 파이프를 닫고 자식의 종료 코드를 낸다.
- 거부한 핸들러가 이유 줄을 내지 않으면 `HOOK-REJECT <이벤트> (이유 없음)` 으로 알린다.
- 실행 기록(`state/hooks.jsonl`)을 쓰지 못하면 예외로 멈추지 않고 stderr 에 경고 한 줄을 낸다. 결과와 `HOOK-*` 줄은 그대로 낸다.
- 핸들러 PATH 앞에 두는 가드 shim `scripts/lib/guard/orca`, `scripts/lib/guard/gh` 를 더했다. 핸들러의 `orca terminal send`, `gh pr merge`, `gh pr update-branch`, PR 머지와 브랜치 갱신 API, GraphQL 의 머지 mutation 을 126 으로 거부한다. GraphQL 의 `--input` 과 `@` 로 파일에서 읽는 필드는 내용을 확인할 수 없어 거부하고, orca 는 플래그를 건너뛴 낱말 열에서 `terminal` 뒤에 `send` 가 있으면 거부한다. 실수 방지 장치이고 보안 경계가 아니다.
- `node:test` 테스트(`tests/*.spec.ts`)를 더하고 CI 의 `Plugin tests` job 에서 돌린다.
- 명령은 아직 바꾸지 않았다. 코디네이터 지시도 그대로다.

## 2.6.0 (2026-10-24)

- 지시서의 `허락:` 줄을 PR 을 열게 하는지와 관계없이 모든 지시서에 필수로 정했다. 공통 지시서 틀에서 Run id 를 빼고, PR 생성은 지시서의 허락 줄을 따르게 했다.
- 충돌과 리뷰 반영은 PR 을 만든 worker 가 이어 받는다는 규칙을 문서끼리 맞췄다. `worker-start` 직접 호출은 `--task` 로 기존 Task 를 다시 띄울 때만 쓴다고 정리했다.
- 한 저장소 전용 오버레이 예시 문서와 그 테스트를 지우고, 무거운 검사 분류와 문서 PR 의 CI 를 오버레이에 적을 항목으로 더했다.
- reference 문서가 스크립트 머리 주석을 옮겨 적은 부분을 지우고 머리 주석이 소유하게 했다. 머리 주석에 없던 내용은 `wait-important.py`, `send-to-worker.py`, `heavy-slot.py`, `remove-worktree.py`, `terminal_ownership.py` 같은 스크립트의 머리 주석으로 옮겼다. 스크립트 동작은 바꾸지 않았다.
- 모델 행동 관측을 이유로 단 문장을 지우고, 규칙이 막는 실패로 이유를 다시 적었다. `agent-selection.md` 는 실측 절을 없애고 선택 기준만 남겼다.
- `README.md` 의 스크립트 목록에 빠진 파일을 더하고, 목록과 `scripts/` 를 대조하는 `tests/test_readme_script_list.py` 를 추가했다.
- 사용자 결정 질문의 형식(`결정:` 첫 줄, `- ` 선택지 둘 이상, `권장:` 줄 하나)을 정했다. `worker-ask.py --decision` 이 형식을 검사해 어긋나면 묻지 않고 종료 코드 2 로 끝난다. 형식이 없는 기술 질문과 막힘 보고는 그대로 묻는다. `결정:` 뒤가 비면 형식 위반이고 보드도 형식 없음으로 본다. work-board 의 결정 필요 항목은 형식이 있으면 `결정:` 제목을 굵게, `권장:` 줄을 그 아래에 보이고 없으면 본문 앞부분을 보인다.
- 사용자가 정할 질문은 코디네이터가 대신 답하지 않는다는 규칙을 `SKILL.md` 와 `references/replying.md` 에 더했다.

## 2.5.2 (2026-10-24)

- work-board, 질문 감시와 doctor 가 전체 inbox 대신 현재 Run 의 질문 기록과 각 발신자의 수신함만 읽는다. 답변은 코디네이터가 보낸 thread 메시지로 판정하므로 읽음·ack 만 된 질문은 남는다. `board-sync.py` 는 질문을 직접 조회하지 않아 변경하지 않았다.
- Orca 의 `check --all` 과 `--peek` 는 각각 100건까지 반환한다. 두 결과를 합쳐 읽지 않은 과거 질문도 확인하고, 상한에 닿으면 보드와 stderr 에 조회 범위를 알린다. 범위 밖 미답변이 빠질 수 있으며, 발신자 수신함의 200건 상한 때문에 답변 여부를 판단할 수 없으면 조회 오류로 처리한다.
- Claude Code 2.1.309 의 `$.process.run` 출력 한도는 stdout·stderr 각각 4MiB다. 보드가 `isStdoutTruncated` 를 확인해 잘린 JSON 을 파싱하기 전에 원인을 표시한다.
- 3만 건·40MB 이상의 전체 inbox 를 요청하지 않는 회귀 테스트와 조회 상한·잘린 출력 검사를 추가했다.

## 2.5.1 (2026-10-23)

- `make-worktree.py` 가 워크트리를 만들기 전에 `orca repo show` 로 저장소의 `externalWorktreeVisibility` 를 읽고, `hide` 면 만들지 않고 종료 코드 1 로 멈춘다. 안내에 사용자가 고를 두 조치(Orca 화면에서 등록, `orca repo set --repo path:<repo> --external-worktree-visibility show`)를 낸다. `show`, `inherit`, 읽지 못한 경우는 이전처럼 진행한다. 이전에는 `hide` 인 저장소에서 워크트리를 만든 뒤 Orca 가 숨겨 `launch-worker.py` 가 30초 대기 끝에 멈췄다.
- `launch-worker.py` 가 Orca 가 워크트리를 알아보지 못해 멈출 때 만든 경로, 그 저장소의 `externalWorktreeVisibility`, 사용자가 할 조치를 stderr 에 낸다. 설정은 바꾸지 않는다.
- 경로 계산은 바꾸지 않는다. Orca 가 직접 만드는 경로와 같다는 확인을 `references/launch.md` 에 적었다.
- Orca 에 묻는 `orca_repo.py` 를 더했다.

## 2.5.0 (2026-10-23)

- `watch-questions.py` 를 Monitor 의 질문 이벤트 소스로 추가했다. Run 별 알림 시각을 orch 작업 폴더에 남기고 미답변 질문을 기본 10분마다 다시 알린다.
- 질문 감시, doctor 와 work-board 는 `inbox` 의 양방향 thread 로 답변을 판정한다. 보드의 자동 결정 수는 ack 여부와 관계없이 답변 뒤 다음 조회에서 줄어든다. 깨진 응답이나 기록 한도 도달은 조회 오류로 표시한다.
- doctor 는 10분 이상 답이 없는 질문을 경고한다. 기다리기 문서에 압축 뒤 감시 복구를, 답하기 문서에 코디네이터 판단과 사용자 결정의 분류 기준을 추가했다.

## 2.4.0 (2026-10-23)

- `cleanup-sweep.py --close-own-taken-over` 를 더했다. `--run` 과 함께 줄 때, 그 Run 의 completed dispatch 터미널이 `user_owned` / `user_takeover` 로 남았어도 `agentIdentity` 가 없고 그 경로를 쓰는 프로세스가 자식 없는 로그인 셸뿐이면 소유 확인에서 빼고 닫는다. 이전에는 worker 가 끝난 뒤 그 셸에 입력이 들어가 자동으로 `user_takeover` 가 기록되면, 정리 단계가 매번 `남김: 사용자 보유 터미널` 로 건너뛰어 코디네이터가 터미널을 직접 닫아야 했다. Orca 필드로는 사용자가 의도해 넘겨받은 터미널과 가를 수 없어 기본은 꺼 두고, `--run` 없이 주면 종료 코드 2 다.
- `terminal_ownership.py` 의 `blocker()` 가 소유 확인에서 뺄 handle 집합을 받는다.
- `references/cleanup.md` 첫머리에 끝난 dispatch 터미널의 상태별 정리 표와 위 옵션을 쓰는 때를 적었다.

## 2.3.0 (2026-10-23)

- `mem-gate.py`, `worker-ask.py`, `make-worktree.py`, `launch-worker.py`, `remove-worktree.py` 로 기존 셸 스크립트 5개를 옮기고 문서·템플릿·내부 호출을 바꿨다. 명령줄 인자와 종료 코드는 유지한다.
- `launch-worker.py` 와 `make-worktree.py` 의 `--resume-remote` 로 원격 PR 브랜치의 최신 커밋을 새 워크트리에서 이어 받는다. 기존 로컬 브랜치와 경로는 덮어쓰지 않는다.
- worker 실행 전에 `orch_paths.py` 의 마이그레이션 확인을 유지한다. 메모리 조회가 실패하면 명령을 실행하지 않으며 명령 파일이 없거나 실행할 수 없으면 종료 코드 127·126 을 유지한다.
- 중첩 대기열 호출은 `exec` 로 명령을 이어받아 바깥 작업 종료 시 실제 명령도 함께 종료되고 자리가 반납되게 했다.

## 2.2.0 (2026-10-23)

- `merge-with-finish.py --run RUN_ID` 을 더했다. `finish-pr.py` 에 `--run` 을 넘기고, 머지 큐의 정리 단계에 `--sweep-arg --run --sweep-arg RUN_ID` 를 넘겨 다른 Run 의 worker 터미널을 건너뛰게 한다. 이전에는 `--finish-arg=--run` 으로 준 Run 이 정리 단계에 넘어가지 않아, 머지 뒤 정리가 다른 코디네이터의 워크트리 `board-steps-done` 을 지우고 터미널을 닫았다. `--finish-arg=--run` 으로만 준 값도 정리 단계에 넘긴다. 정리 인자에 `--run` 이 이미 있으면 두 번 넘기지 않는다. Run 이 어디에도 없으면 「정리 단계가 Run 으로 한정되지 않는다」 경고 한 줄을 낸다(`--no-sweep` 이면 내지 않는다). 값이 서로 다른 곳에 있으면 종료 코드 2 다.
- `references/cleanup.md` 의 `merge-with-finish.py` 예시에 `--run "$RUN_ID"` 를 더하고 이유를 한 줄 적었다.
- `remove-worktree.sh` 를 `bash` 나 `sh` 로 불러도 동작하게 했다. 첫머리에서 zsh 가 아니면 `exec zsh "$0" "$@"` 로 같은 인자를 넘겨 다시 실행한다. 이전에는 `bash remove-worktree.sh ...` 가 `${p:A}` 에서 `A: unbound variable` 로 끝났다. 사용법 오류와 정상 동작이 zsh 로 부른 것과 같은지 테스트를 더했다.

## 2.1.0 (2026-10-23)

- `heavy-slot.py` 로 여러 worker 의 무거운 검사를 FIFO 대기열과 기본 3개 자리로 제한한다. 독점 실행, 중첩 호출, 죽은 PID 회수와 `mem-gate.sh` 대기를 지원하며 경로와 자리 수를 인자나 환경 변수로 받는다.
- 대기열 사용법과 실행 수명 검사를 추가했다. 특정 저장소의 우선 검사 파일과 전역 Docker 프로세스 감시는 포함하지 않는다.
- 대기열 기본 경로를 `orch_paths.py` 의 `heavy-slot` 으로 받는다. 워크트리끼리 주 checkout 의 `.orch/state/heavy-slot/` 을 공유하며 `ORCH_DIR` 로 루트를 바꾼다.

## 2.0.0 (2026-10-23)

orch 의 파일을 oh-my-claudecode 의 `.omc/` 에서 떼어 주 checkout 의 `.orch/` 로 옮긴다. 쓰던 저장소는 한 번 옮겨야 하므로 major 로 올린다. 결정은 ADR-008 이 소유한다.

- `scripts/orch_paths.py`: 경로를 한 곳에서 정한다. `overlay.md`, `config.json`, `specs/`, `queue/`, `state/`(무거운 검사 대기열 자리 `state/heavy-slot/`), `bin/`. 루트는 `ORCH_DIR` 로 바꾸고, 처음 만들 때 `.git/info/exclude` 에 `/.orch/` 를 더한다. 워크트리에서 불러도 주 checkout 의 폴더를 쓴다
- 저장소 설정을 `.claude/orch-overlay.md` 에서 `.orch/overlay.md` 로, `.claude/orch-finish.json` 에서 `.orch/config.json` 으로 옮긴다
- `scripts/migrate-orch-dir.py`: 옛 위치의 파일을 옮긴다. 기본은 미리보기이고 `--apply` 로 옮긴다. `--move 옛=새` 로 저장소마다 다른 위치를 더한다. 살아 있는 dispatch, 터미널을 쥔 worker, 돌고 있는 머지 큐나 마무리가 있으면 거부한다. 옮긴 지시서, PR 본문, 설정, 오버레이 안의 옛 경로를 바꾸고, 바꾸지 않는 파일의 옛 경로는 보이기만 한다. board.json 은 옮기지 않는다
- 설정, 오버레이, 지시서 폴더를 읽는 진입점은 옛 위치에 파일이 남아 있으면 옮기는 명령을 알리고 종료 코드 2 로 멈춘다. `finish-pr.py`, `merge-with-finish.py`(`--finish-config`), `handoff-cleanup.py`(`--config` 나 `--orch-dir` 를 주면 막지 않음), `spec-lint.py`(`--overlay`), `cleanup-sweep.py`(`--specs-dir`), `launch-worker.sh`, `orch_paths.py --ensure` 가 여기 해당한다. 셸 스크립트용으로 `orch_paths.py check` 를 둔다. `wait-important.py`, `notify-conflicts.py` 는 알리기만 한다
- 스크립트마다 따로 두던 보드 탐색(`.omc/handoffs/board.json`, `.omc/board.json`)을 지우고 work-board 의 `board.py` 규칙을 쓴다. 보드는 work-board 소유라 옮기지 않는다
- `migrate-orch-dir.py` 는 빈 옛 폴더를 옮기지 않고 지운다. 옮긴 뒤 고치는 단계(옛 경로 문자열, 설정, git 무시, 빈 폴더)는 `.orch` 전체를 보고 옮길 것이 없어도 돈다. 옮기다 실패하면 남은 사본을 거두고 멈춘다. 상대경로 심볼릭 링크는 같은 대상을 가리키게 다시 만든다. `.omc/previews` 만 있고 설정이 없으면 `cleanup.previews` 만 담은 설정을 만든다
- `.omc/orch/` 에 있던 다른 폴더(예: 피드백 메모)는 `.orch/` 로 옮겨 가 `handoff-cleanup.py` 의 오래된 폴더 정리 후보가 된다. 남길 것은 `.orch/.keep` 에 적는다
- `handoff-cleanup.py`: `.orch/` 만 정리한다. 미리보기 폴더는 content-preview 의 것이라 `--previews`(설정 `cleanup.previews`)로 줄 때만 본다. `.omc` 의 다른 파일은 보지 않는다. `--omc`, `--handoffs` 를 지우고 `--orch-dir` 를 둔다. 휴지통 기본 이름은 `orch-cleanup-<날짜>` 다
- `wait-important.py` 와 `notify-conflicts.py` 의 기록은 `.orch/state/` 에 둔다
- `merge-with-finish.py`: 설정은 `.orch/config.json`, 마무리 출력과 pid 는 `.orch/queue/` 가 기본이다. 보드 기본 위치는 `finish-pr.py` 와 같이 work-board 규칙을 쓴다
- `references/cleanup.md`: 맡긴 작업은 다른 저장소의 것이어도 머지한 자리에서 정리한다는 원칙과 이유를 두고, 다른 저장소에 맡긴 PR 을 직접 머지했을 때의 정리 명령을 한 묶음으로 적었다. SKILL.md 7단계는 그 절을 가리킨다(사용자 결정 2026-10-23)
- `references/overlay.md` 에 폴더 구조와 옮기는 방법을 적고, 다른 문서의 경로 예시를 `.orch` 로 바꿨다
## 1.46.0 (2026-10-23)

- **경로 변경: `scripts/merge-queue.sh` 가 `scripts/merge_queue.py` 로 바뀌었다.** `merge-queue.sh` 를 Python 으로 옮겼다. 옛 경로를 직접 부르는 곳이 깨지지 않도록 `merge-queue.sh` 는 `exec python3 "$(dirname "$0")/merge_queue.py" "$@"` 한 줄만 남기고 이번 한 버전 동안 둔다. 다음 버전에서 지우니 호출하는 곳을 `merge_queue.py` 로 바꾼다. 옵션, 종료 코드, 출력 줄(`STOP`, `QUEUE-DONE`, `QUEUE-HELD`, `AFTER-MERGED-FAILED` 등)은 그대로고 기존 머지 큐 테스트를 호출 경로만 바꿔 그대로 돌려 통과시켰다. `merge-with-finish.py` 의 `MERGE_QUEUE` 기본값이 새 파일이다. 환경 변수 `MERGE_QUEUE_SLEEP_SCALE` 로 모든 대기 시간에 배율을 곱한다(테스트용, 기본 1). 이식하면서 `--verify-merged` 의 `bash -c` 실행, 사본 이름, 정리 인자 등 동작은 바꾸지 않았다.
- `merge_queue.py --up-to-date-when overlap`: `--require-up-to-date` 가 뒤처진 PR 마다 base 를 합치고 CI 를 다시 기다리던 것을, PR 이 바꾼 단위와 PR 이 갈라진 뒤 base 에 들어온 변경의 단위가 겹칠 때만 하게 한다. 기본은 `always` 라 동작이 달라지지 않는다. 판정은 PR 차례마다 하고 `<PR> 판정: 바로 머지` 또는 `<PR> 판정: 갱신 필요(이유)` 를 찍는다. 판정하지 못하면 갱신 필요로 다룬다. 판정은 처음 한 번으로 끝나지 않는다. 갱신하고 CI 를 기다리는 사이나 바로 머지로 판정한 뒤 머지 직전에 base 가 또 움직이면 다시 판정한다. 갱신을 마친 PR 은 새로 들어온 변경(PR 의 새 merge-base 기준)만 보고, 갱신하지 않은 PR 은 처음 갈라진 뒤 base 의 변경을 모두 다시 본다. 겹치지 않으면 다시 갱신하지 않고 머지하고, 겹칠 때만 또 갱신한다. PR HEAD 는 `--match-head-commit` 으로 계속 지킨다. 다시 판정하는 횟수는 PR 하나에 5번까지이고 넘으면 `STOP <PR> 다시 판정을 5번 했는데도 base(main) 가 계속 움직인다` 로 멈춘다(괄호 안은 base 브랜치 이름).
  - 단위는 `--unit-prefix`(기본 `modules/`) 아래 폴더 하나이고 그 밖의 파일은 경로 자체다. `--shared-paths` 정규식에 맞는 공용 경로는 어느 쪽에 있든 겹친 것으로 본다. `--docs-glob` 에 맞는 문서는 세지 않는다. `--unit-group a,b` 로 준 단위는 한 단위로 센다(계약 없이 서로의 응답 모양에 기대는 모듈 쌍). 묶음 설정 오류는 큐를 시작할 때 종료 코드 2 로 알린다.
  - 판정 로직은 Python 모듈 `scripts/overlap_units.py` 에 두고 단위 테스트를 붙였다. 머지 큐는 PR 차례마다 이 모듈을 부르고 결과로 최신화 여부만 정한다.
- `merge_queue.py`: 머지 전 명령은 PR HEAD 마다 한 번 돈다. 다시 판정하다 갱신해 PR HEAD 가 바뀌면 새 HEAD 로 한 번 더 돌고, HEAD 가 같으면 다시 돌지 않는다. `--up-to-date-when overlap` 이 아니면 갱신 뒤에도 한 번만 돈다. 옛 `.sh` 는 PR 하나에 한 번만 돌았다.
- `merge_queue.py`: 남은 임시 사본을 지울 때 pid 를 `kill -0` 으로 확인하다 권한 오류(EPERM)가 나면 그 프로세스가 살아 있는 것으로 보고 사본을 지우지 않는다. 옛 `.sh` 는 이 경우를 죽은 프로세스로 보고 다른 사용자의 사본을 지웠다.
- `merge-with-finish.py`: `queue` 절이 `up_to_date_when`, `shared_paths`, `unit_prefix`, `unit_groups`, `require_up_to_date`, `sweep_args` 를 받는다. `sweep_args` 는 항목마다 `--sweep-arg` 가 된다.
- `merge-with-finish.py`: `--board-item` 을 주지 않아도 보드 파일에서 `pr` 필드에 그 PR 이 든 항목을 찾는다. **업무의 마지막 PR(`!`)일 때만** 그 항목을 done 으로 바꿔, 중간 PR 이 항목을 끝내던 문제를 막는다. 같은 PR 이 든 항목이 둘 이상이면 건너뛴다. 이제 저장소별 래퍼 스크립트 없이 `merge-with-finish.py --repo <저장소> 492 '495!:<머지 전 명령>'` 한 줄로 부를 수 있다.
- `references/cleanup.md` 에 「겹치지 않는 PR 은 최신화하지 않기」 를 더했다. 언제 쓰는가, 놓치는 경우와 대응, 머지 뒤 안전망, 호출 예를 적었다.

## 1.45.1 (2026-10-23)

- 보드의 `next` 와 `details` 를 `{text, done}` 객체 목록으로 저장하도록 형식 설명을 고쳤다. PR 동기화와 목표 진행률 계산은 새 객체와 옛 문자열을 모두 읽는다.

## 1.45.0 (2026-10-23)

- `remove-worktree.sh` 가 OMC session-end hook worker 의 자손 프로세스도 hook 으로 센다. 대기 도중 hook 의 자식이 생겨 대기 시간이 `--wait` 로 줄고 첫 정리가 거부되던 문제를 고쳤다.
- `send-to-worker.py` 가 끝난 dispatch 에는 `--spec` 만으로 이어 쓴다. 살아 있는 dispatch 에 `--spec` 만 주면 보낼 글이 없다고 거부한다. 사용자 보유 터미널 거부 메시지에 화면 확인과 닫기, 새로 띄우기 명령을 적었고 `replying.md` 에 `worker_done` 뒤 터미널이 `owned` 로 남는다는 실측을 더했다.
- `finish-pr.py --complete` 가 `--complete-cmd` 없이도 동작한다. 업무 완료 단계만 건너뛰고 지시서는 지운다. `--complete-cmd` 를 주면 `--task-pattern` 이 필요하다.

## 1.44.0 (2026-10-23)

- 대기와 메시지 분류에서 `worker_done` 을 같은 Task·Dispatch·발신자의 앞선 `준비됨 #N, head <전체 SHA>` 상태와 대조한다. 근거가 없으면 `의심스러운 worker_done` 으로 분리하고 대기는 자동 ack 없이 종료 코드 6 을 반환한다. 이미 ack 한 상태는 읽기 전용 이력으로 확인하며, 이력을 읽지 못해도 완료로 간주하지 않는다.
- PR 없는 작업은 `--completion-contract none` 으로 PR 준비 검사를 끌 수 있다. 실패 보고는 준비 상태를 요구하지 않는다. 같은 터미널에서 부모 문맥을 복사한 하위 세션의 신호를 발신 터미널만으로 인증할 수 없으므로, 준비 상태 확인 뒤에도 지시서의 완료 기준을 대조한다.

## 1.43.1 (2026-10-23)

- 정리와 직접 워크트리 삭제 전에 모든 Run 의 터미널 소유 상태를 확인한다. 사용자 보유·해제된 터미널이 있거나 조회에 실패하면 워크트리와 터미널을 남긴다. 소유 상태를 확인하지 못한 빈 셸도 닫지 않는다.

## 1.43.0 (2026-10-23)

- `wait-important.py`: `--ack-lost` 로 확인한 끊긴 dispatch 를 Run 별로 기록한다. 다음 대기에서 같은 dispatch 의 경고를 생략하며, 확인 기록만 쓰고 대기 없이 끝난다. `--kill-stale` 은 일반 셸을 거쳐 PID 1 에 연결된 같은 사용자의 고아 대기도 종료한다.
- `merge-queue.sh`: 합친 사본의 검증 명령에 사본 경로, PR 번호, 양쪽 커밋과 변경·겹침 파일 목록을 환경 변수로 넘긴다. `--update-docs-on-overlap` 은 GitHub CLEAN 인 문서 PR 에 base 를 합치고 필수 CI 를 다시 기다린다. update-branch 요청에도 검사한 HEAD 를 지정한다.
- 기존 `--after-merged` 의 배포 기능을 재사용하고, 대기와 머지 문서에 한 저장소의 로컬 스크립트를 대신할 명령과 Vitest 검증 예시를 추가한다. 실제 Run 과 다른 저장소의 파일은 바꾸지 않는다.

## 1.42.0 (2026-10-23)

- `wait-important.py`: 완료·포기된 dispatch 의 터미널이 사라져도 `WORKER_LOST` 로 보고하지 않는다. worker 의 실패 보고와 코디네이터의 종료 기록은 camelCase 와 snake_case 를 모두 읽는다.
- `send-to-worker.py`: `--spec` 으로 터미널을 이어 쓰다가 `agent_unconfigured` 로 끝나면 터미널을 닫고 같은 워크트리에 새 worker 를 띄운다. 원래 에이전트·모델·effort 를 유지하며 인자로 바꿀 수 있다. 설정 누락, 소유권 변경, 활성 dispatch, 닫기 실패 시에는 멈춘다.
- 머지 스크립트 두 개의 CI 조회는 `statusCheckRollup` 을 사용하므로 최근 실행 목록의 검색 한도에 영향을 받지 않는다. 회귀 검사와 references 문서에 이 기준을 남긴다.

## 1.41.0 (2026-10-23)

머지 큐의 update-branch 뒤 merge commit 으로 머지된 브랜치를 `cleanup-sweep.py` 가 그 PR 의 것으로 알아보지 못해 정리가 남던 문제를 고친다.

- `scripts/cleanup-sweep.py`: `belongs_to` 가 base 위 커밋이 0 개인 브랜치를 끝 커밋이 PR HEAD 와 정확히 같을 때만 인정했다. update-branch 로 원격 PR HEAD 가 앞서 가고 merge commit 으로 머지되면 둘이 달라 `find_pr` 가 PR 을 못 찾았다. 그러면 `merged()` 가 `PR MERGED` 대신 `upstream gone, base 에 없는 커밋 0 개` 로 판정해 `sweep_worktree` 가 끝난 worker 의 남은 세션 터미널을 살아 있는 worker 로 세고, `--kill-holders` 도 폴더를 쥔 프로세스를 끄지 않았다. 이제 그 경우에 한해 `gh pr view --json commits` 의 커밋 목록에 끝 커밋이 있으면 그 PR 의 브랜치로 본다. 막 만든 브랜치와 목록을 읽지 못한 경우는 지금처럼 인정하지 않는다. 끝 커밋이 PR HEAD 와 같으면 목록을 조회하지 않는다
- `references/cleanup.md`: 같은 이름 새 브랜치 줄에 이 판정을 적었다
- 테스트를 더했다(update-branch 뒤 merge commit 으로 머지된 브랜치 인정, 막 만든 브랜치와 목록을 읽지 못한 경우 불인정, 끝 커밋이 PR HEAD 와 같은 경우 조회 없이 인정)

## 1.40.0 (2026-10-23)

한 저장소의 코디네이터가 저장소 로컬 스크립트를 스킬 것으로 바꾸지 못하게 막던 결함 넷을 고치고, 로컬 스크립트에만 있던 머지 기능을 옮긴다.

- `wait-important.py`: 2026-10-22 에 대기를 걸자마자 옛 dispatch 31개를 `WORKER_LOST` 로 내고 끝났다. worker_done 없이 같은 터미널에 일을 이어 준 dispatch 라 task 가 열린 채였다.
  - 일부러 끝낸 dispatch 를 빼고 본다. `dispatch-show` 의 termination_reason 이 operator_close 이거나 last_failure 의 provenance 가 worker_report 인 것이다. 실제 Run 의 30개 가운데 24개가 여기 해당했다
  - 한 번 알린 dispatch 는 `<git 루트>/.omc/state/wait-important-lost.json` 에 Run 별로 적고 다시 알리지 않는다. 경로는 `--lost-state` 로 바꾼다
  - 일부러 끝냈다고 판정한 dispatch 도 같은 파일에 적어, 다음 대기가 `dispatch-show` 를 다시 부르지 않는다. task 마다 한 번만 조회한다
  - 앞 대기가 알렸는데 아직 끊긴 채인 dispatch 는 깨우지 않고 stderr 에 한 줄로 남긴다
- `launch-worker.sh`
  - `${run:+--run "$run"}` 와 `${base:+--base "$base"}` 가 zsh 에서 한 낱말로 넘어가 `Unknown flag --run run_x` 로 실패했다. 배열로 두고 `${a[@]+"${a[@]}"}` 로 펼친다. 테스트가 bash 와 zsh 로 함께 돈다
  - `--worktree` 가 `path:` 를 붙인 경로도 받는다
  - `--repo/--name` 으로 워크트리를 만든 뒤 띄우지 못하면, `--worktree <만든 경로>` 로 이어 띄우는 명령과 남은 터미널 목록을 낸다. 같은 `--name` 으로 다시 부르면 make-worktree 가 거부했다. worker-start 가 성공한 뒤의 실패에는 내지 않는다. 다시 띄우면 같은 일의 task 가 하나 더 생긴다
  - `worker-start` 가 `agent-hooks-review-prompt` 로 실패하면 Codex 설치본 갱신 명령을 알린다
- Codex hook 신뢰 확인: Codex 는 `.codex-plugin/plugin.json` 이 없으면 `.claude-plugin/plugin.json` 의 hook 을 싣는다. fdf53e1 이 더한 orch hook 3개가 Codex 설치본 갱신(316ea9e)과 함께 나타나 Codex worker 가 「3 hooks are new or changed」 화면에서 멈췄다. hooks 를 배열로 바꾼 #169 가 원인은 아니다. 저장소에 hooks 없는 `.codex-plugin/plugin.json` 을 더해 Codex 가 hook 을 싣지 않게 했다(ADR-007). 머지 뒤 `codex plugin marketplace upgrade fos-skills` 로 갱신해야 반영된다
- `merge-queue.sh`: 한 저장소의 `merge-ready.sh` 에만 있던 기능을 옮긴다. 기본값은 지금 동작이다
  - `--after-merged CMD`: 이번 실행에서 머지한 PR 이 있으면 끝에 한 번 돌린다. `MERGED_PRS` 와 문서 PR 을 뺀 `CODE_PRS` 를 받는다. 실패하면 종료 코드 3 이다
  - `--skipped-is-missing`: 결론이 SKIPPED 인 체크를 아직 돌지 않은 것으로 본다
  - PR 조회가 실패하면 10초 간격으로 세 번까지 부른다. CI 를 통과한 PR 이 일시 실패로 보류되던 문제다
  - `merge-with-finish.py` 와 `orch-finish.json` 의 queue 절이 두 옵션을 받는다
- 테스트를 더했다(일부러 끝낸 dispatch, 한 번만 알림, zsh 낱말 분리, `path:` 경로, 이어 띄우기 안내, 머지 뒤 명령, SKIPPED 판정, 조회 재시도, Codex 매니페스트)

## 1.39.0 (2026-10-22)

보드 도구(work-board)가 이 저장소로 옮겨 와, orch 스크립트가 홈 폴더 경로 대신 저장소 안의 board.py 를 부른다(ADR-006).

- `board-sync.py`, `finish-pr.py`, `goal-progress.py`: `--board-bin` 기본값을 `~/.claude/mods/work-board/bin/board.py` 에서 저장소의 `work-board/bin/board.py` 로 바꿨다. `BOARD_BIN` 환경 변수는 그대로 우선한다. 세 스크립트의 기본 경로에 파일이 있는지 확인하는 테스트를 더했다
- `board-sync.py`: 단계 끝내기를 직접 하지 않고 board.py 의 `steps` 로 단계 목록을 받아 `step <id> <n>` 으로 끝낸다. 「✓ 」 접두사만 보던 탓에 `[ ]` 줄을 끝내면 「✓ [ ] 1 …」 이 되어 단계로 세지 않던 문제와, 번호 없는 참고 줄을 끝나지 않은 단계로 세던 문제가 사라진다. `steps` 를 모르는 옛 보드 명령이면 고치지 않고 종료 코드 1 로 멈춘다. 테스트는 가짜 보드 명령 대신 실제 board.py 로 보드 파일 결과를 확인한다
- `references/board.md`: 보드 명령의 자리와 단계 줄 형식(번호 점, `✓`, `[x]`), doing 항목의 진행률 필수 규칙을 적었다

## 1.38.0 (2026-10-22)

워크벤치 진행에서 막힌 두 곳을 고친다. 첫 화면 승인이 hook 에 거부되던 문제와, Orca 가 다시 연 빈 셸이 머지된 워크트리의 정리를 막던 문제다.

- `hooks/block-worker-terminal-send.py`: 본문 없이 `--enter` 만 보내는 `orca terminal send` 는, 그 worker 의 `worker-show --dispatch` 가 첫 화면 대기(`agent-trust-workspace`, `agent-update-prompt`, `agent-cwd-prompt`, `agent-hooks-review-prompt`)를 보일 때 통과시킨다. `--text` 나 `--interrupt` 가 있거나, 일하는 단계이거나, 단계를 읽지 못하면 지금처럼 거부한다. `launch.md` 「첫 화면에서 멈춤」 의 승인 명령이 그동안 이 hook 에 막혔다
- `scripts/cleanup-sweep.py`: 모든 Run 범위를 읽지 못해 건너뛰던 「다른 Run 의 것인지 확인하지 못한 터미널」 이 이 Run 의 머지된 워크트리에서 빈 셸이면 닫고 정리를 이어 간다. 빈 셸은 `agentIdentity` 가 없고, 그 경로의 프로세스가 자식 없는 로그인 셸뿐이며 터미널마다 셸이 하나씩 있는 것이다. `--apply` 없이는 닫지 않는다. `references/cleanup.md` 에 한 줄을 더했다
- 테스트를 더했다(첫 화면 `--enter` 통과와 거부 사례, 빈 셸 닫기와 건너뛰기 사례)

## 1.37.0 (2026-10-22)

끝난 worker 터미널에 새 dispatch 가 붙지 않던 문제와, 지시서에 박힌 스킬 스크립트 경로가 옛 번들을 가리키던 문제를 고친다.

- `launch-worker.sh`: `--terminal` 과 `--agent`, `--model`, `--effort` 를 함께 주면 Orca 를 부르기 전에 거부한다(Orca 는 `invalid_argument` 로 거절한다). `--terminal` 로 이어 쓰려던 터미널이 `agent_unconfigured` 면 종료 코드 3 과 다음 단계(push 확인, 이 세션이 띄운 터미널이면 닫기, `--terminal` 없이 새 worker)를 낸다. 터미널은 스크립트가 닫지 않는다. 다른 세션이나 사용자의 터미널을 닫지 않기 위해서다
- `references/replying.md`: 「이어 쓸 수 없는 터미널」 절을 더했다. 세 오류의 뜻과, 새 worker 로 이어받는 순서, 커밋 전에 끝난 worker 의 처리를 적었다. `references/launch.md` 는 그 절을 가리킨다
- `templates/spec-common.md`: `{{ORCH_SCRIPTS}}` 를 없애고, worker 가 자기 세션의 `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `plugins/installed_plugins.json` 에서 `fos-skills@fos-skills` 의 `installPath` 를 읽어 `orch/scripts` 를 푸는 명령을 넣었다. `user` 범위 항목을 먼저 쓴다. 캐시 폴더 이름이 해시라 `tail -1` 이나 `ls -t` 는 설치되지 않은 번들을 골랐다. `references/spec-writing.md` 는 경로를 채우지 않는다고 적는다
- 테스트를 더했다(`--terminal` 조합 거부, `agent_unconfigured` 종료 코드 3, 경로 해석)
- 끝난 worker 의 터미널은 재부팅 없이도 대개 `agent_unconfigured` 로 이어 쓰지 못하므로, 후속 일은 새 worker 로 띄우는 것을 기본으로 적었다(`replying.md`, `launch.md`, `launch-worker.sh` 주석).
- `templates/spec-common.md`: 틀의 ask 명령은 `FROM`, `QUESTION` 변수로 바꿔 `<…>` 플레이스홀더가 리다이렉션으로 읽히지 않게 했고, 틀의 bash 블록에 `<` 연산자가 없는지 테스트가 본다

## 1.36.0 (2026-10-22)

worker 를 띄우고 기다리다 막히는 세 곳을 고친다.

- `launch-worker.sh`: `worker-start` 전에 `orca worktree list` 에 그 경로가 보일 때까지 기다린다(기본 30초, 2초 간격, 환경 변수 `LAUNCH_WT_WAIT`, `LAUNCH_WT_POLL`). 넘기면 「Orca 가 워크트리를 알아보지 못했다」 와 종료 코드 1 로 멈추고, 기다린 초는 표준 오류에 한 줄 낸다. 그래도 `worker-start` 가 `selector_not_found` 로 끝나면 한 번만 다시 부른다. 다른 오류는 그대로 멈춘다. `make-worktree.sh` 로 만든 워크트리를 Orca 가 늦게 알아봐 곧바로 띄우면 실패하던 문제다
- `wait-important.py`: 대기하는 동안 `--lost-interval-sec`(기본 60, 0 이면 끔)마다 `worker-list --run` 으로 상태를 본다. 대기를 시작할 때 살아 있던 dispatch 가 abandoned, failed, stopped, `terminal_missing` 으로 바뀌면 `WORKER_LOST <dispatch> stage=<단계>` 줄과 `LAST_DELIVERY` 줄을 내고 종료 코드 5 로 끝난다. 기기가 재시작되어 worker 터미널이 사라졌을 때 대기가 52분 동안 깨어나지 않던 문제다
- `wait-important.py`: 대기를 시작할 때 이미 끊겨 있는데 처리하지 않은 dispatch 도 본다. 재시작 뒤 코디네이터 세션이 새로 건 대기가 이 경우다. `check` 를 부르지 않고 바로 `WORKER_LOST` 줄과 종료 코드 5 로 끝난다. 아래 셋 중 하나면 처리한 것으로 보고 뺀다: 같은 task 에 나중 dispatch 가 있다(`dispatch-show --task` 의 최신 id 로 판정한다. `worker-list` 행에는 만든 시각이 없다), task 가 completed 이거나 취소(failed 에 result 가 cancelled)다, `--ignore-lost <dispatch>`(여러 번 가능)로 뺐다. 판정에 필요한 목록을 읽지 못하면 그 dispatch 는 이전처럼 지켜보지 않는다. 테스트를 더했다(처음부터 끊겨 있음, 나중 dispatch 있음, `--ignore-lost`, 끝난 task)
- `references/launch.md`: 「끊긴 worker 다시 띄우기」 절과, Task 상태별로 `--retry-of` 를 쓸지 정하는 표를 더했다. Task 가 `ready` 인 `abandoned` dispatch 에 `--retry-of` 를 주면 `task_not_startable` 로 거절되므로 `--task` 와 `--worktree path:` 로 띄운다. 「시작 직후 실패」 에 같은 조건을 적었다
- `references/waiting.md`: 종료 코드 5 와 `WORKER_LOST` 줄, 그때 할 일을 적었다
- 테스트를 더했다(워크트리가 늦게 보이는 경우, 끝까지 안 보이는 경우, `selector_not_found` 재시도, 대기 중 abandoned, 처음부터 끝나 있던 dispatch)

## 1.35.0 (2026-10-21)

코디네이터가 되풀이한 명령 실수를 문서 대신 PreToolUse hook 으로 막고, 메모리 대기 스크립트를 옮긴다.

- 새 `hooks/block-git-after-cd.py`: `cd X;` 나 줄바꿈, `||`, `&` 뒤에 오는 git 쓰기(merge, commit, push, reset, rebase)를 거부하고 `&&` 나 `git -C` 를 요구한다. 워크트리 만들기가 실패해 cd 가 실패했는데 다음 줄의 `git merge` 가 메인 체크아웃에서 돈 일이 있었다. 따옴표 안, heredoc 본문, 주석, `2>&1` 같은 리다이렉션, 연산자 뒤 줄바꿈, `cd X || exit`, `cd X || { ...; exit 1; }`, cd 앞의 `set -e`, subshell 안의 cd, `git merge-base` 같은 읽기 명령, `git -C` 는 통과한다. 셸 글자를 가리고 명령 조각으로 나누는 일은 새 `hooks/shell_text.py` 가 맡는다
- 새 `hooks/block-worker-terminal-send.py`: `orca terminal send --terminal term_...` 의 대상이 `worker-list` 의 worker 터미널이면 거부하고 `send-to-worker.py` 를 쓰게 한다. `orca terminal send` 조각의 `--terminal` 만 보고, worker 가 아닌 터미널, 변수로 준 대상, 따옴표 안의 문구, orca 조회 실패는 통과한다
- 새 `hooks/require-spec-line.py`: `worker-start --spec` 의 글자 그대로인 값이 `spec-line.py` 출력 꼴(`지시서 <경로> 를 끝까지 읽고 수행한다. ... 못 읽으면 escalation 으로 알린다.`)이 아니면 거부한다. `worker-start` 조각의 `--spec` 만 보고, `$` 가 든 값과 커밋 메시지나 heredoc 에 든 문구는 통과한다. 지시서 경로만 주던 옛 형식도 거부한다
- 새 `scripts/mem-gate.sh`: macOS 의 `memory_pressure` free 와 swap 사용량이 기준 안에 들 때까지 기다린 뒤 `--` 뒤 명령을 실행한다. 저장소 값 없이 환경 변수로 기준을 바꾼다. `references/verification.md` 에 무거운 검사를 이것으로 감싼다는 줄을 더했다
- `send-to-worker.py`: hook 이 직접 `orca terminal send` 를 막으므로, 그 길로만 보내던 두 경우를 스크립트가 맡는다. (1) reply 대상에서 같은 thread 에 답이 보이는 question 을 빼고, orca 가 「already has a different answer」 로 거부하면 다음 후보 메시지로 한 번 더 시도한다(하루에 세 번 거부된 일이 있었다). (2) dispatch 가 끝났는데 `--spec` 이 없고 그 터미널 화면이 작업 중이면 `nudge-worker.py --text` 로 본문을 넣고 Task 기록에 묶이지 않는다고 경고한다. worker 가 phase 중간에 worker_done 을 보내 dispatch 가 닫혔지만 계속 일한 일이 있었다
- `nudge-worker.py`: `--text` 로 메시지 안내 대신 글을 그대로 넣는다. 작업 중이면 턴 시작을 기다리지 않고 넣고 `queued` 를 낸다. `--state` 는 그 터미널 화면 상태만 낸다
- `block-background-wait.py` 가 heredoc 본문의 글자로 거부하던 오탐을 고쳤다(here-string 과 `<<` 시프트는 heredoc 으로 보지 않는다)
- hook 마다 거부 사례와 오탐 기준별 통과 사례를, `mem-gate.sh` 는 가짜 `memory_pressure`, `sysctl`, `sleep` 으로 판정과 시간 초과와 종료 코드 전달을 테스트했다

## 1.34.0 (2026-10-21)

설치본이 낡았거나 문서와 오버레이가 없는 파일을 가리키는 것을 띄우기 전에 잡는다.

- 새 `scripts/orch-doctor.py`: 설치 경로 `<plugins>/cache/<마켓플레이스>/<플러그인>/<sha>/orch` 의 sha 를 원본 main 과 `git ls-remote` 로 비교한다. 다르면 설치본 스킬 디렉터리의 tree hash 를 마켓플레이스 clone 의 원본 커밋 tree 와 비교하고(clone 이 shallow 라 커밋 diff 는 쓰지 못한다), 다르거나 판정할 수 없으면 `STALE` 과 `claude plugin marketplace update`, `claude plugin update` 명령을 낸다. 원본을 읽지 못하면(오프라인) `SKIP-VERSION` 으로 넘어간다. git 은 표준 입력을 막고 20초로 제한해 인증 질문에 멈추지 않는다. 문서의 `$SKILL_DIR/scripts/<이름>`, `$PLANNING_SKILL_DIR` 같은 형제 번들 변수, 상대 링크가 가리키는 스크립트가 없으면 `MISSING` 을 낸다. 설치본이 옛 커밋이라 `spec-line.py` 를 쓰지 못한 일이 있었다. `SKILL.md` 머리에서 스킬을 열 때 돌린다
- 저장소 테스트 `scripts/tests/test_doc_script_refs.py`: 모든 스킬에 `orch-doctor.py --skip-version` 을 돌려 문서가 부르는 스크립트가 있는지 본다
- `spec-lint.py --check-overlay`: 오버레이의 백틱 값과 `orch-finish.json` 의 문자열 값에서 `/` 가 든 상대 경로를 읽어 `origin/<base>`(기본 main, `--base`)에 없으면 막는다. 파일 이름만 적은 것, 절대경로, `~`, `$`, glob, git 이 무시하는 경로, 첫 마디가 기준 브랜치의 최상위 항목이 아닌 경로(다른 저장소, 스킬 문서, scratchpad)는 보지 않고, `예외:` 줄은 건너뛴다. 이 옵션을 주면 지시서를 생략할 수 있다. 기존 `--overlay FILE` 은 오버레이 파일 위치라 그 뜻을 바꾸지 않으려고 새 이름을 썼다. `references/spec-writing.md` 의 띄우기 전 검사 명령에 붙였다
- `templates/spec-common.md`: 보고에서 phase 를 가리킬 때 계획 이름을 붙인다는 줄을 더했다. 두 계획이 함께 돌 때 phase 번호만으로 어느 계획인지 갈리지 않았다

## 1.33.0 (2026-10-21)

정리가 살아 있는 일을 지우지 않게 하고, 저장소 스크립트에만 있던 정리 두 가지를 옮긴다.

- `cleanup-sweep.py` 와 `handoff-cleanup.py` 는 살아 있는 dispatch 의 `--spec` 줄이 가리키는 지시서를 지우거나 옮기지 않는다. 지시서의 브랜치가 모두 머지됐다는 이유로 아직 일하는 worker 의 지시서가 지워진 일이 있었다. task-list 의 상태와 worker-list 의 dispatch 상태가 pending, dispatched, running 인 Task 의 spec 줄에서 `.md` 경로를 모으고, 그 목록을 읽지 못하면 그 실행에서는 지시서를 하나도 지우지 않는다. 경로 모으기는 새 `scripts/live_specs.py` 가 맡고 두 스크립트가 import 한다. `handoff-cleanup.py` 에 `--run` 을 더했다
- `cleanup-sweep.py` 가 저장소마다 처음에 기본 체크아웃이 기준 브랜치에 있으면 origin 으로 `--ff-only` 한다. 로컬에만 있는 커밋이 있으면 건드리지 않는다
- `cleanup-sweep.py` 가 머지된 PR 의 본문 파일(`<specs-dir>/../pr-<이름>.md`)을 지시서와 함께 지운다. 이름은 worktree 이름, 브랜치의 `/` 를 `-` 로 바꾼 것, 첫 `/` 뒤, PR 번호다
- `references/cleanup.md`, `references/overlay.md`, README 를 고치고, 위 동작마다 테스트를 더했다

## 1.32.0 (2026-10-21)

띄우기와 보내기를 스크립트로 묶어, 직접 부르다 단계를 빠뜨리는 길을 닫는다.

- 새 `scripts/launch-worker.sh`: `spec-line.py --require-permission` 으로 첫 지시 줄을 만들고, 새 워크트리는 `make-worktree.sh` 로 만든 뒤 `worker-start --worktree path:` 로 띄운다. 기존 워크트리는 그 경로에 붙은 터미널이 남아 있으면 목록을 보여 주고 거부한다(한 워크트리에 세션이 셋 쌓인 일이 있었다). `--terminal` 로 이어 쓰는 터미널은 세지 않는다. 띄운 뒤 `worker-show` 의 단계를 `--watch` 초(기본 90) 보고, `worktree_creating` 에서 넘어가지 않으면 abandon 하고 같은 Task 를 `--retry-of` 로 한 번 다시 띄운다. `worker-start` 자체가 실패하면 다시 띄우지 않는다
- 새 `scripts/send-to-worker.py`: dispatch 가 살아 있으면 그 worker 의 마지막 메시지에 `reply` 하고 `nudge-worker.py` 로 깨운다. 끝났고 터미널이 남았으면 `--spec` 의 후속 지시서로 그 터미널에 새 Task 를 띄우고, 터미널도 없으면 새로 띄우라고 알린다. 닫힌 dispatch 에 `reply` 해 전달되지 않던 일과 worker 터미널에 직접 `orca terminal send` 하던 길을 이것으로 바꾼다
- 새 `scripts/notify-conflicts.py`: 열린 PR 을 `git merge-tree` 로 origin/<base> 와 합쳐 충돌과 충돌 파일을 내고, (PR, base SHA) 마다 한 번만 그 브랜치 워크트리의 worker 에게 base 를 합치라고 보낸다. 보내지 못하면 기록하지 않아 다음 실행이 다시 본다
- `SKILL.md` 3, 5, 7단계와 `references/launch.md`, `references/replying.md`, `references/cleanup.md` 를 새 스크립트 기준으로 고쳤다. 세 스크립트의 흐름을 가짜 orca, gh 와 임시 git 저장소로 테스트했다

## 1.31.0 (2026-10-21)

머지 줄에서 저장소 스크립트에만 있던 장치를 코어로 옮긴다.

- `ci-ready.py`: PR 의 바뀐 파일을 `gh pr view --json files`(GraphQL) 대신 REST(`gh api repos/{owner}/{repo}/pulls/{n}/files --paginate`)로 읽는다. PR 이 많은 저장소에서 GraphQL 이 2차 한도에 걸려 오버레이가 이 조회를 금지했다. 호스트와 저장소는 PR URL 에서 읽고, 300 개까지 비교하며 넘으면 보류한다(전에는 100 개에서 잘려 보류)
- `merge-queue.sh --verify-merged-when overlap|code|always`: 기본 `overlap` 은 지금처럼 겹칠 때만 합친 사본을 검사한다. `code` 는 문서만 바꾼 PR 이 아니면 늘, `always` 는 모든 PR 을 검사한다. 각자 통과한 두 PR 이 파일은 겹치지 않았는데 합치니 같은 상한을 넘은 일이 있었다
- `merge-queue.sh --docs-glob`: 바꾼 파일이 모두 glob 에 맞는 PR 은 `overlap` 과 `code` 에서 합친 사본 검사 없이 머지한다
- `merge-queue.sh --continue-on-hold`: 보류한 PR 의 `STOP` 줄을 찍고 다음 PR 로 간다. 끝 줄은 `QUEUE-HELD <번호...>` 이고 종료 코드는 1 이다. 기본은 지금처럼 첫 보류에서 멈춘다. PR 하나의 처리를 서브셸로 옮겨 `stop` 이 그 PR 만 끝내게 했다
- `merge-queue.sh` 가 시작할 때 `--copy-dir` 에서 pid 가 죽은 `merge-queue-pr<PR>-<pid>` 사본을 지운다. EXIT trap 은 KILL 로 끝나면 돌지 못해 사본이 남았다
- `merge-with-finish.py` 가 `orch-finish.json` 의 `queue` 절(`before`, `required`, `verify_merged`, `verify_merged_when`, `docs_glob`, `method`)로 명령줄에 없는 머지 큐 옵션을 채운다. 명령줄이 우선하고, 모르는 키나 잘못된 값은 마무리를 걸기 전에 사용법 오류로 멈춘다
- `references/cleanup.md`, `references/overlay.md`, README 에 새 옵션과 `queue` 절을 적었다. 위 동작마다 테스트를 더했다

## 1.30.0 (2026-10-21)

`finish-pr.py` 가 업무의 중간 PR 이 머지될 때 지시서를 지우던 문제를 고친다.

- `--specs-dir` 를 줘도 `--complete`(업무의 마지막 PR)일 때만 그 브랜치의 지시서를 지운다. 중간 PR 에서는 남기고 로그에 한 줄 적는다. 업무 하나가 PR 여럿이면 중간 PR 머지 때 다음 PR 에 쓸 지시서가 사라졌다
- 머리 주석, `--specs-dir` 도움말, `references/cleanup.md` 「머지 뒤 마무리」 를 맞췄다. 테스트 두 건(중간 PR 은 지시서 유지, 마지막 PR 은 지시서 삭제)을 더했다

## 1.29.0 (2026-10-21)

`cleanup-sweep.py` 가 머지된 워크트리를 끝난 worker 의 터미널 때문에 건너뛰던 문제를 고친다.

- PR 이 MERGED 로 판정된 워크트리는 workerState 가 working, ready 가 아니면 남은 터미널만으로 「살아 있는 worker」 라 보지 않는다. worker 의 Claude 세션 터미널은 일이 끝나도 `orca terminal list` 에 남아, 기존 판정은 `close_terminals` 에 닿기 전에 건너뛰었다. 이제 그 터미널을 닫고 정리를 이어 간다
- cherry 로만 판정한 브랜치는 지금처럼 터미널이 남아 있으면 건너뛴다. 막 만든 브랜치에서 일하는 worker 를 지우지 않으려는 보호다. working, ready 인 worker 도 그대로 건너뛴다
- 머리 주석의 판정 설명을 바뀐 동작에 맞췄다. 테스트 세 건(MERGED 와 끝난 worker, MERGED 와 working, cherry 와 끝난 Dispatch)을 더했고, 옛 테스트 하나(MERGED 와 succeeded 의 터미널 유지)는 새 동작으로 바꿨다

## 1.28.0 (2026-10-21)

공통 지시서 틀에 커밋 attribution 줄을 더한다.

- `templates/spec-common.md`: 커밋 메시지 끝에 세션이 받은 attribution 지침의 `Co-Authored-By` 줄을 그대로 붙이고, 지시서에 모델 이름을 적지 않는다는 줄을 더했다. 사본을 만들 때 모델 이름을 직접 적으면 다른 모델로 띄운 worker 의 커밋에 틀린 이름이 남는다

## 1.27.0

머지 뒤 마무리와 handoff 산출물 정리를 스크립트로 두고, 머지 큐를 걸 때 마무리를 함께 거는 것을 기본 절차로 한다.

- 새 `scripts/finish-pr.py`: PR 이 MERGED 인 것을 `gh` 로 직접 확인한 뒤 `cleanup-sweep.py` 로 그 브랜치의 worker 를 정리한다. 머지 직후 정리가 GitHub 상태 반영보다 먼저 돌아 「살아 있는 터미널」 로 건너뛰고 워크트리를 남기던 문제를 막으려고, 브랜치의 워크트리가 사라질 때까지 다시 시도한다. 이어서 머지 커밋을 조상으로 가진 커밋의 배포 성공을 기다리고(`deploy_verdict`: 뒤 커밋 배포에 합쳐져 머지 커밋의 실행이 `skipped` 나 `cancelled` 여도 뒤 실행이 성공하면 성공), 업무를 완료 처리하고, 보드를 done 으로 바꾼다. 끝에 `FINISH-DONE` 이나 `FINISH-FAIL` 을 낸다
- 새 `scripts/merge-with-finish.py`: PR 마다 `finish-pr.py` 를 백그라운드로 걸고 `merge-queue.sh` 를 같은 인자로 돌린다. PR 번호 뒤 `!` 는 업무의 마지막 PR 이다. 같은 PR 의 마무리가 이미 돌면 pid 파일로 알아보고 다시 걸지 않는다. `merge-queue.sh` 의 출력 계약은 바꾸지 않았다
- 새 `scripts/handoff-cleanup.py`: 끝난 큐 로그, 보드 항목이 done 이고 원격 브랜치·워크트리·열린 PR 이 없는 지시서, 3일 넘게 바뀌지 않은 미참조 handoff 폴더와 미리보기, 하루 지난 csv·tsv 를 휴지통 폴더로 옮긴다. 기본은 후보만 보이고 `--apply` 로 옮긴다. 열린 PR 목록을 읽지 못하면 지시서는 옮기지 않는다. 남길 미리보기는 `previews/.keep` 에 적는다
- 저장소마다 다른 값(gh 호스트, Run id, 배포 워크플로와 브랜치, 업무 번호 정규식, 업무 완료 명령, 보드와 handoff 와 휴지통 경로)은 `<repo>/.claude/orch-finish.json` 이나 옵션으로 받는다. 키는 `references/overlay.md` 가 소유한다
- `references/cleanup.md` 의 머지 절을 `merge-with-finish.py` 기준으로 고치고 「머지 뒤 마무리」 와 「handoff 산출물 정리」 를 더했다. `references/waiting.md` 에 `finish-*.out` 확인을, `references/overlay.md` 에 마무리 설정 파일을 더했다
- 배포 판정, 업무 번호 추출, `!` 해석, 지시서 정리 조건, 미리보기 `.keep` 을 순수 함수로, 전체 흐름을 임시 git 저장소와 가짜 gh, sweep, 업무 명령, 보드 명령으로 테스트했다

## 1.26.0

테스트의 실제 대기를 줄이고 파일별 병렬 실행과 시간 측정을 추가한다.

- `cleanup-sweep.py`: `--wait`에 소수 초를 받고 `--poll-interval`로 확인 간격을 지정한다. 기본 대기 5초와 간격 1초, 신호별 재확인은 유지한다
- 테스트는 대기와 간격을 각각 0.01초로 지정한다. 검사하는 조건과 기존 테스트는 유지한다
- 정리, 머지 큐, 질문, 보드, CI ready, worker 깨우기 테스트의 가짜 실행 파일은 클래스마다 재사용해 macOS의 최초 실행 검사 비용을 줄인다. 상태 파일과 로그, 임시 저장소는 테스트마다 따로 둔다
- 저장소의 `scripts/run-orch-tests.py`는 파일별 별도 프로세스로 최대 4개를 동시에 실행한다. 파일별 시간과 느린 테스트 10개를 출력하고 전체 측정값을 JSON으로 남긴다
- 대기 기본값과 종료 조건, 잘못된 인자, 병렬 실행기의 프로세스 분리와 실패 전달을 검증한다

## 1.25.0

기다리기, 쉬는 worker 깨우기, Codex worker 의 PR 열기에서 반복된 세 가지 실패를 스크립트로 막는다.

- `scripts/wait-important.py`: `waiter_exists`(`already has an active actionable waiter`)를 받으면 되풀이하지 않고 종료 코드 4 로 끝난다. 앞 세션이 남긴 `check --wait` 가 자리를 쥐면 새 대기가 매번 이 오류로 바로 끝나, 되풀이하는 대기가 몇 초 만에 시간 초과로 끝나고 worker 보고를 놓쳤다. 같은 사용자의 프로세스에서 그 Run 의 대기를 찾아 고아인지 부모가 살아 있는지와 함께 보여 주고, `--kill-stale` 이면 고아와 그 밑의 대기만 종료한다
- 새 `scripts/nudge-worker.py`: 입력 대기인 worker 는 `send` 와 `reply` 를 다음 턴까지 읽지 않는다. 메시지를 보낸 뒤 화면 마지막 줄들로 Claude 와 Codex 의 입력 대기를 판정하고, 그때만 「check 로 읽어라」 를 넣고 `turn_started` 를 확인한다. 보이지 않으면 같은 request id 로 `--retry-request` 를 한 번 더 보낸다. 작업 중, 쓰다 만 입력, 권한 확인 창이면 입력하지 않는다
- 새 `scripts/spec-line.py`: 지시서의 `허락:` 줄을 `--spec` 의 첫 지시 줄에 붙인다. PR 허락이 지시서 파일 안에만 있으면 Codex worker 일부가 GitHub 게시가 금지됐다며 PR 을 열지 않고 멈췄다. `--require-permission` 은 그 줄이 없으면 띄우기 전에 멈춘다
- `references/launch.md` 의 `SPEC_LINE` 을 `spec-line.py` 로 만들게 바꾸고, `spec-writing.md` 에 `허락:` 줄 형식을 적었다. `templates/spec-common.md` 에 「끝내기」 절을 두고, 게시가 막히면 push 한 뒤 본문 파일 경로를 status 로 보내는 단계를 그 안으로 옮겼다
- `references/waiting.md` 에 종료 코드 4, `references/replying.md` 에 보낸 직후 `nudge-worker.py` 를 부르는 것과 종료 코드별 다음 행동을 적었다
- 남은 대기 목록과 판정, 메시지만으로 알아봄, 고아만 종료, Claude 와 Codex 화면의 네 상태 판정, 입력과 재확인 흐름, 허락 줄의 형식들을 테스트했다

## 1.24.0

지시서 브랜치 줄 파싱, 규칙 API 플랜 제한, 보안 리뷰 에이전트 선택을 고친다.

- `make-worktree.sh`: 본문 문장 안의 「브랜치: `x`」 언급을 브랜치로 읽던 문제를 고쳤다. 줄 머리(앞 공백, `-` 목록 기호, `**` 강조 허용)의 `브랜치:` 줄만 읽고, 그런 줄이 둘 이상이면 두 줄을 알리고 종료 코드 2 로 멈춘다
- `merge-queue.sh`: 무료 플랜 비공개 저장소의 규칙 API 가 내는 403(「Upgrade to GitHub Pro」)을 경고로 알리고 필수 체크 목록을 빈 것으로 다룬다. 인증, 네트워크, 404 와 다른 403 은 지금처럼 멈춘다. 기존 출력 계약의 변경이며 코디네이터가 승인했다
- `agent-selection.md`: 공격 경로를 재현하는 보안 리뷰는 Claude 에 맡기는 행과 근거(fos-home-infra PR #228 에서 Codex 가 보안 요청 제한으로 막힌 사례)를 더했다

## 1.23.0

메모리에 두던 정리와 결정 보고 지시를 `references/` 로 옮긴다.

- `cleanup.md`: 머지나 완료를 확인하는 즉시 사용자에게 묻지 않고 정리하는 범위(이 세션이 맡긴 다른 저장소 포함, 다른 세션이 띄운 작업은 제외)를 적었다. 문서 지우기에 `.omc/` 산출물(지시서, 조사 보고, 큐 로그, 임시 계획)을 더하고, `.omc/previews/` 는 사용자가 말할 때만 지운다고 적었다
- `board.md`: `decide` 항목이 생기거나 남아 있으면 사용자가 묻지 않아도 정리해 알리고 `AskUserQuestion` 으로 결정을 받는다. 보드를 갱신해 보고할 때 결정 대기 목록을 함께 알린다
- 진행 중 worker 의 정지 확인과 다시 띄우기는 `waiting.md` 의 「heartbeat 만 올 때」 가 이미 다뤄 더하지 않았다

## 1.22.0

`check --wait` 가 heartbeat 만 든 묶음으로 깨어날 때마다 코디네이터가 읽을 것 없이 ack 하고 다시 걸던 일을 스크립트로 옮긴다.
한 저장소 전용 `wait-important.sh` 를 일반화한 것이다.

- 새 `scripts/wait-important.py`: `--types`(기본 `worker_done,question,escalation,status`)가 든 묶음이 오면 ack 하지 않고 그 JSON 과 `LAST_DELIVERY <id>` 를 낸다. 그 밖의 묶음은 다음 호출의 `--ack` 로 넘기고 계속 기다린다. Run 은 `--run` 으로 받고, 전체 한도(`--timeout-ms`, 기본 7000000)가 지나면 `TIMEOUT LAST_DELIVERY <id>` 로 끝난다. 출력은 `triage-messages.py` 가 그대로 읽는다
- `hooks/block-background-wait.py` 가 `wait-important` 를 셸의 `&` 나 `nohup` 으로 띄우는 호출도 거부한다. 스크립트 이름만 있는 호출에는 `orchestration check` 가 없어 1.15.0 규칙에 걸리지 않았다
- `references/waiting.md` 의 대기 명령과 프로세스 찾기를 이 스크립트로 바꾸고, SKILL 4단계 통과 조건을 고쳤다
- 가짜 orca 로 heartbeat ack 뒤 worker_done 에서 멈춤, 네 종류 각각에서 멈춤, `--types`, 시간 한도와 남은 ack, orca 오류, triage 로 읽기, 사용법 오류를 테스트했다. hook 에는 거부할 두 꼴과 통과할 두 꼴을 더했다

## 1.21.0

`cleanup-sweep.py` 가 브랜치 없는 워크트리와 하위 에이전트 워크트리를 정리하지 못해 남던 두 경우를 다룬다.
한 저장소 전용 `sweep-merged.sh` 의 두 부분을 일반화한 것이다.

- 저장소 밖 detached 워크트리: worker 가 기준선 비교로 임시 폴더에 만들고 남긴 것이다. 커밋 안 된 변경, 쓰는 프로세스, Orca 터미널이 없고 HEAD 가 원격 추적 브랜치에 있으면 `git worktree remove` 로 지운다. 저장소 폴더 안의 detached 워크트리는 그대로 둔다
- 목록을 읽기 전에 `git worktree prune` 을 돌린다. dry-run 은 `-n` 으로 지울 등록만 낸다
- 하위 에이전트 워크트리(`--agent-glob`, 기본 `agent-*`): 모든 Run 범위를 읽지 못하면 Orca 가 띄운 빈 셸 터미널을 「확인하지 못한 터미널」 로 보고 경로를 건너뛰었다. 그 경로를 쓰는 프로세스가 자식 없는 로그인 셸뿐이면 다른 Run 의 것으로 세지 않는다. 다른 Run 의 worker 로 확인된 터미널은 그대로 건너뛴다
- `references/cleanup.md` 의 「스크립트가 다루는 것」 에 두 경우를 더했다
- 지움, dry-run, 변경과 프로세스와 터미널과 원격에 없는 HEAD 로 남김, 저장소 안은 남김, prune, 빈 셸 닫기, 자식 있는 셸과 glob 밖은 남김, glob 옵션, 확인된 다른 Run 터미널은 남김을 테스트했다

## 1.20.0

draft PR 로 CI 를 미루는 저장소에서, 파일이 겹치는 PR 을 함께 ready 로 바꿔 CI 를 두 번 돌리던 일을 스크립트로 막는다.
한 저장소 전용 `ci-ready.sh` 를 일반화한 것이다.

- 새 `scripts/ci-ready.py`: draft PR 을 `gh pr ready` 로 바꾼다. 같은 base 로 가는 열린 ready PR 과 바뀐 파일이 겹치거나 base 와 충돌하면 보류하고 이유를 낸다. 이번 실행에서 앞서 바꾼 PR 도 ready 로 센다. `mergeable` 이 `UNKNOWN` 이면 다시 묻고, 파일이 100 개 이상이면 목록이 잘렸을 수 있어 보류한다
- 저장소 이름과 경로를 박지 않고 `--repo` 의 origin 으로 찾는다
- `references/overlay.md` 에 「draft 로 CI 미루기」 행, `references/cleanup.md` 에 그 저장소의 절, 지시서 틀에 `{{DRAFT_PR_RULE}}` 줄을 더했다
- 가짜 gh 로 겹침 없음, ready PR 과 겹침, draft 나 다른 base 와의 겹침은 무시, 같은 실행 안의 겹침, dry-run, 충돌, `UNKNOWN` 재시도와 보류, 이미 ready 와 닫힌 PR, 파일 한도, 조회 실패, 사용법 오류를 테스트했다

## 1.19.0

같은 파일을 고친 PR 을 차례로 머지할 때, 합친 상태의 검사를 `verification.md` 의 손 절차로만 하던 것을 머지 큐 옵션으로 옮긴다.
한 저장소 전용 `merge-ready.sh`, `merge-tested.sh` 를 일반화한 것이다.

- `merge-queue.sh --stop-on-overlap`: PR 의 바뀐 파일이 PR 기준 이후 base 에서 바뀐 파일과 겹치면 겹친 파일을 찍고 멈춘다
- `merge-queue.sh --verify-merged CMD`: 겹치면 `origin/<base>` 에 PR HEAD 를 merge 한 임시 사본에서 `CMD` 를 사본 경로를 인자로 돌려 0 이면 머지한다. 충돌, 검사 실패, 검사 중 base 이동은 멈춘다. 사본은 멈출 때도 지운다
- `--copy-dir`: 사본 폴더. 기본은 `TMPDIR` 이고, 링크를 푼 실경로를 쓴다. macOS 의 `/var` 링크 때문에 실경로를 요구하는 검사가 사본 경로를 거부했다. 검사 명령의 `TMPDIR` 도 실경로로 준다
- 사용법 출력이 머리 주석의 줄 번호를 박지 않고 주석 끝까지 읽는다
- `references/cleanup.md` 에 「같은 파일을 고친 PR」 절, `references/overlay.md` 에 합친 사본 검사 행을 더하고, `references/verification.md` 의 손 절차를 이 옵션으로 바꿨다
- 진짜 git 저장소로 겹침에서 멈춤, 겹치지 않으면 머지, 겹치지 않으면 검사를 건너뜀, 합친 실경로 사본에서 검사하고 머지, 검사 실패와 충돌에서 멈추고 사본을 지움, 상대경로 사본 폴더를 테스트했다

## 1.18.0

지시서와 공통 틀에 「머지하지 않는다」 를 적어도 worker 가 자기 PR 을 직접 머지하던 문제(#141~#145)를 워크트리 권한 규칙으로 막는다.

- `scripts/worktree-deny.py` 의 deny 에 `Bash(gh pr merge:*)` 를 더했다. 코디네이터는 기본 체크아웃에서 `merge-queue.sh` 로 머지하므로 닿지 않는다
- 공통 지시서 틀의 머지 줄에 권한 설정이 막는다는 사실을 적었다
- 새 워크트리와 기존 설정에 넷째 규칙이 한 번만 들어가는지 테스트했다

## 1.17.0

모델 표에 Claude Haiku 5.5 의 worker 실측(2026-10-20)을 반영한다.

- `references/agent-selection.md`: 수정 위치와 검증 명령이 정해진 작은 수정 행을 따로 두고 Haiku 5.5 를 첫 후보로 올렸다. 단순 반영 행은 Haiku effort 를 지정하지 않고 지적 원문과의 대조를 조건으로 붙였다
- 같은 파일에 실측 표와 한계를 더했다. effort 별 비용 줄은 Haiku `low` 와 `medium` 의 품질, 시간이 같았다는 결과로 보완했다
- `references/verification.md`: 문구를 옮긴 작업은 diff 를 지적 원문과 한 줄씩 대조하는 줄을 더했다

## 1.16.0

하위 에이전트의 `pkill`, `browser-driver reset` 이 다른 worker 의 호스트와 탭을 닫던 문제를 워크트리 권한 규칙으로 막는다.

- 새 `scripts/worktree-deny.py`: 워크트리의 `.claude/settings.local.json` 에 `Bash(pkill:*)`, `Bash(killall:*)`, `Bash(browser-driver reset:*)` deny 를 더한다. 추적되는 설정 파일은 고치지 않고, 무시되지 않으면 `.git/info/exclude` 에 더해 워크트리를 dirty 하게 만들지 않는다
- `make-worktree.sh` 가 워크트리를 만든 뒤 이 스크립트를 부른다
- 지시서 틀에 `BROWSER_EGO_SPACE` 를 워크트리 이름으로 주는 줄과 자기 PID 만 끄는 줄을 더했다
- 새 워크트리의 deny 와 깨끗한 상태, 기존 설정 보존과 중복 없음, 추적되는 설정 파일 거부를 테스트했다

## 1.15.0

`orca orchestration check --wait` 를 셸의 `&` 로 띄워 완료 알림을 받지 못하던 문제를, 산문 대신 PreToolUse hook 으로 막는다.

- 새 `hooks/block-background-wait.py`: 한 줄에 `orchestration check` 와 `--wait` 가 함께 있고 `nohup`, `setsid`, `disown` 이나 백그라운드 `&` 가 있으면 거부하고 `run_in_background` 를 안내한다
- `hooks/hooks.json` 을 플러그인 매니페스트의 `hooks` 가 가리킨다. 근거는 저장소 ADR-005 가 소유한다
- `references/waiting.md` 의 산문을 hook 이 막는다는 사실로 바꿨다
- 백그라운드 대기 다섯 꼴과 통과해야 하는 일곱 꼴, 매니페스트 연결을 테스트했다

## 1.14.0

지시서를 띄우기 전에 지시서끼리 담당 파일이 겹치는지, 코디네이터 소유 파일을 건드리는지, 가리킨 함수가 있는지, 금지 명령을 요구하는지를 잡지 못해 worker 가 ask 로 멈추거나 뒤 PR 이 충돌하던 문제를 검사기로 막는다.

- 새 `scripts/spec-lint.py`: 겹침, 코디네이터 소유, 소유 계약, 없는 함수, 금지 문구를 막고 없는 파일 경로는 경고한다. 저장소 값은 오버레이의 `## spec-lint` 절에만 둔다
- 지시서의 담당 범위를 `` 담당: `glob` `` 줄로 적는 형식을 정했다. 금지 문구가 정말 필요한 줄은 `예외:` 로 시작한다
- 2단계 통과 조건에 `spec-lint.py` 종료 코드 0 을 더하고, `references/spec-writing.md` 에 「띄우기 전 검사」 절, `references/overlay.md` 표에 spec-lint 행을 더했다
- 실제 git 저장소로 겹침, 코디네이터 소유, 소유 계약과 그 주인, 없는 함수와 있는 메서드, 부정문과 `예외:` 줄, 없는 경로 경고, 없는 지시서를 테스트했다

## 1.13.0

공통 지시서 틀에 `planning`, `build-with-teams` 를 쓰라는 줄이 있어도 worker 는 사용자에게 묻지 못해, worker 마다 설계 문서 위치와 흐름을 다시 정하거나 ask 를 보내던 문제를 틀에서 막는다.

- `templates/spec-common.md` 에 「설계와 구현을 맡길 때」 절을 더했다. 사용자 확인 단계는 「판단이 필요할 때」 기준으로 가르고, 설계는 `{{DESIGN_DIR}}` 에 두고 `tasks/` 는 만들지 않는다. PR 단계는 공통 규칙을 따르고, 하위 에이전트는 이름 없이 띄우고, 저장소의 두 스킬 오버레이가 있으면 그 경로를 따른다
- `references/spec-writing.md` 의 채울 값에 `{{DESIGN_DIR}}` 를 더했다

## 1.12.0

`worker-ask.sh` 를 쓰는 worker 가 이미 온 답을 놓치거나 같은 것을 다시 묻던 세 경우를 스크립트로 막는다.

- 새 질문을 보내기 전에 `check --peek` 으로 읽지 않은 메시지를 본다. 자기가 보낸 것과 heartbeat 를 뺀 메시지가 있으면 그 메시지를 내고 묻지 않는다(종료 코드 5). 한 번 보여 준 메시지 ID 는 `ORCH_ASK_SEEN` 파일에 적어 다시 막지 않으므로, 읽고도 물어야 하면 같은 명령을 다시 부른다. worker 가 `check` 로 읽어도 ack 하지 않으면 `--peek` 에 계속 남기 때문이다(실측). `--force` 는 확인 없이 묻는다. 코디네이터가 이미 status 로 방향을 보냈는데 같은 것을 묻고 30분을 기다린 일이 있었다
- 시간 제한으로 끝나면 `check --peek` 을 한 번 더 읽어, 그 질문 스레드나 이 Dispatch 로 온 status 가 있으면 첫 줄 `answer: <본문>` 으로 내고 종료 코드 3 으로 끝난다. 코디네이터가 ask 에 reply 하지 않고 status 로 답하면 600초 뒤 종료 코드 4 로만 끝났다
- 답을 받으면 첫 줄이 `answer: <본문>` 이다. JSON 전체를 내서 `tail` 로 읽으면 `result.answer` 를 놓쳤다
- 셸에 흩어진 JSON 해석을 새 `scripts/ask-json.py` 로 모았다
- 지시서 틀의 ask 줄에 첫 줄 `answer:` 와 종료 코드 5 를 적었다
- 가짜 orca 로 읽지 않은 메시지에서 멈춤, 한 번 보여 준 메시지로는 다시 막지 않음, `--force`, 자기 메시지와 heartbeat 는 막지 않음, 질문 스레드와 이 Dispatch 로 온 status 회수, 다른 스레드의 status 는 무시, 첫 줄 `answer:` 를 테스트했다

## 1.11.0

`cleanup-sweep.py` 가 `--run` 을 줘도 터미널을 경로로 찾아, 같은 저장소의 다른 코디네이터(Codex run 같은 것)가 띄운 worker 터미널까지 닫던 문제를 막는다.

- `--run` 을 주면 `orca orchestration worker-list --terminal-state active` 를 모든 Run 범위로 읽는다. 다른 Run 의 worker 가 쥔 터미널이 그 경로에 있으면 그 경로를 통째로 건너뛴다. 그 경로는 그 Run 의 코디네이터가 정리한다
- worker-list 는 부른 터미널에 묶인 Run 으로 범위를 좁히므로 `ORCA_TERMINAL_HANDLE` 을 빼고 부른다. 그래도 범위가 `all` 이 아니거나 조회에 실패하면 이 Run worker 의 터미널만 닫고, 확인하지 못한 터미널이 있는 경로는 건너뛴다
- worker 를 반납한 뒤 남은 빈 셸 터미널을 닫을 때도 다른 Run 의 터미널은 뺀다
- `--run` 이 없으면 지금처럼 경로로만 찾는다
- 다른 Run 터미널이 있는 경로는 남김, 다른 경로에 있는 다른 Run worker 는 이 경로를 막지 않음, 범위를 읽지 못하면 모르는 터미널을 남김, 묶인 터미널 handle 을 빼고 부름, `--run` 없이는 예전대로 닫음을 테스트했다

## 1.10.0

worker 터미널을 닫은 직후 OMC session-end hook worker 가 워크트리를 작업 디렉터리로 1분 넘게 쥐어 `remove-worktree.sh` 가 「쓰는 프로세스 1 개」 로 거부하고, 코디네이터가 재시도를 되풀이하던 문제를 스크립트로 막는다.

- `remove-worktree.sh --wait <초>`: 그 경로를 쓰는 프로세스가 빠지기를 그 초만큼 기다린 뒤 판정한다. 기본은 0 이라 지금처럼 바로 거부한다
- 남은 프로세스가 모두 OMC session-end hook worker(`--omc-session-end-worker`)면 `ORCH_HOOK_WAIT` 초(기본 180)까지 기다린다. 그 hook 은 워크트리의 `.omc/` 를 쓰다 스스로 끝나므로, 빼고 지우면 지운 경로에 폴더가 다시 생긴다. 그래서 빼지 않고 기다린다
- 거부 줄에 기다린 초와 hook pid 를 낸다
- `cleanup-sweep.py`: 남은 프로세스가 hook 뿐이면 건너뛰지 않고 `remove-worktree.sh` 에 넘기고, `--kill-holders` 도 hook 은 끄지 않는다. `remove-worktree.sh` 호출의 시간 제한을 hook 대기보다 길게 잡았다
- 가짜 lsof, ps, sleep 으로 hook 이 끝나면 지움, 끝나지 않으면 거부, 다른 프로세스는 바로 거부, hook 과 다른 프로세스가 함께면 기다리지 않음, `--wait` 로 다른 프로세스를 기다림을 테스트했다. 정리 스크립트는 hook 을 넘기는 경우와 끄지 않는 경우를 테스트했다

## 1.9.0

GitHub Enterprise 저장소에서 머지 큐가 멈추던 문제와, 끝난 worker 의 프로세스가 워크트리를 쥐어 정리가 매번 거부되던 문제를 스크립트로 막는다.

- `merge-queue.sh`: `gh pr` 는 origin 으로 호스트를 찾지만 `gh api` 는 기본 호스트로 가서, GHE 저장소에서 필수 체크 규칙 조회와 `--require-up-to-date` 의 base 비교가 실패했다. PR URL 의 호스트(`gh pr` 가 origin 으로 정한 값)를 모든 `gh api` 에 `--hostname` 으로 넘기고, 스레드 조회 명령과 머지 전 명령에는 `GH_HOST` 로 넘긴다. 전역 `GH_HOST` 가 다른 호스트를 가리켜도 따르지 않는다
- `cleanup-sweep.py --kill-holders`: PR 이 MERGED 이고, 그 경로의 worker 가 모두 succeeded 나 fenced 이고, Orca 터미널이 남지 않았을 때만 작업 디렉터리가 그 경로 아래인 프로세스를 TERM, HUP, KILL 순으로 끈다. 자기와 그 조상, 그 경로 안의 다른 워크트리를 쓰는 프로세스, 조상에 Orca 와 `login` 말고 다른 앱(iTerm, VS Code 같은 것)이 있는 프로세스는 뺀다. 신호 사이에는 최소 1초를 기다린다. 열린 파일로만 쥔 프로세스는 다른 워크트리의 빌드도 맡을 수 있어 끄지 않는다
- 기본은 끔이다. 코디네이터 흐름 밖에서 돌릴 때 사용자 셸을 끄지 않게 하고, 대기와 정리 reference 의 코디네이터 명령에 옵션을 넣었다
- `remove-worktree.sh`: 거부 줄에 그 경로를 쓰는 pid 를 낸다
- 가짜 gh 로 GHE URL 의 호스트 전달과 전역 `GH_HOST` 무시를, 가짜 kill 로 TERM 을 무시하는 셸, KILL 까지 가는 경우, Orca 밖에서 띄운 셸과 language server, 스크립트 자신, 중첩 워크트리, 옵션 없음, worker 를 모름, 끝나지 않은 dispatch, 남은 터미널, dry-run 을 테스트했다

## 1.8.0

정리 스크립트가 예전에 머지된 PR 과 이름만 같은 새 브랜치의 워크트리를 「머지됨」 으로 지우던 문제와, 워크트리 브랜치 이름이 지시서와 어긋나던 문제를 구조로 막는다.

- `cleanup-sweep.py`: 어느 이름으로 찾았든 브랜치 끝 커밋이 PR HEAD 와 같거나 그 조상일 때만 그 PR 로 본다. base 위 커밋이 0 개면 PR HEAD 와 정확히 같을 때만 인정한다. 걸린 PR 만 있으면 「이름만 같은 PR」 로 남긴다
- `remove-worktree.sh --merged-head`: HEAD 가 그 커밋과 같거나 그 조상이 아니면 거부한다
- 새 `make-worktree.sh`: 지시서의 `` 브랜치: `<이름>` `` 줄을 읽어 `origin/<기준 브랜치>` 위에 그 이름으로 워크트리를 만들고, exclude 와 로컬 설정 복사를 같이 한다. 같은 이름의 로컬, 원격 브랜치나 경로가 있으면 거부한다. `--check` 는 push 한 브랜치가 지시서 값과 같은지 본다
- 띄우기 reference 를 `make-worktree.sh` 다음 `--worktree path:` 로 바꾸고, 완료 검증에 `--check` 를 더했다. 지시서 reference 에 `브랜치:` 줄 형식과 push 명령을 정했다
- 이름 변형으로 PR 을 찾는 코드는 Orca 이름으로 만든 옛 워크트리를 위해 남긴다. 모든 후보에 커밋 검사를 하므로 이름이 우연히 맞아도 지우지 않는다
- 「옛 머지 PR 과 같은 이름의 새 브랜치」 세 경우, 일반 merge PR, `remove-worktree.sh` 거부, `make-worktree.sh` 를 테스트했다

## 1.7.0

끝난 워크트리, 세션, 브랜치가 말하지 않아도 정리되게 `cleanup-sweep.py` 가 건너뛰던 경우를 처리한다. 운영에서 코디네이터가 매번 직접 지우던 다섯 경우다.

- PR 찾기: upstream 의 원격 브랜치 이름, `branch.<b>.merge`, 로컬 이름, 이름 변형(사용자 접두 제거, 첫 하이픈을 슬래시로) 순으로 `gh pr list --head` 를 부른다. 변형으로 찾은 PR 은 브랜치의 커밋이 모두 PR HEAD 의 조상일 때만 쓰고, fork 에서 온 PR 은 건너뛴다
- PR 조회 결과를 JSON 으로 읽는다. 빈 목록은 「PR 없음」, 파싱 실패나 모르는 state 는 「조회 실패」 이고 둘 다 머지로 읽지 않는다
- PR HEAD 가 로컬에 없으면 `refs/pull/<번호>/head` 를 받아 와 `--merged-head` 로 넘긴다. 머지 큐의 update-branch 로 PR HEAD 가 앞서 간 squash 머지도 지워진다
- 터미널을 닫고 기다린 뒤에도 남은 프로세스가 전부 자식 없는 로그인 셸이고 그 경로에 Orca 터미널이 있으면, PR 이 MERGED 일 때 그 터미널을 `orca terminal close` 로 닫고 다시 기다린다. 다른 프로세스가 남으면 건너뛴다
- `--repo` 를 여러 번 받는다. 저장소 하나를 읽지 못해도 나머지는 돌고 종료 코드만 2 다. `--base` 를 주지 않으면 저장소마다 `origin/HEAD` 를 읽는다
- 원격 브랜치는 PR 의 head 이름, upstream, 로컬 이름으로 찾아 지운다. 기준 브랜치, `release/*`, 다른 열린 PR 의 base 는 지우지 않고, 끝점이 머지된 PR HEAD 와 다르면 그 뒤에 커밋이 더해진 것이므로 남긴다
- 대기와 정리 reference 에 「사용자가 말하지 않아도 깨어날 때마다 자동으로 돈다」 와 여러 저장소 예시를 적었다
- 가짜 gh, orca, lsof, ps 로 다섯 경우와 「PR 조회가 비거나 깨지면 지우지 않는다」 를 테스트했다

## 1.6.0

지시서를 scratchpad 가 아니라 대상 저장소의 git 무시 폴더에 쓰게 한다. 코디네이터 세션이 다시 시작되면 scratchpad 가 정리돼 지시서가 사라지던 문제를 막는다.

- `spec-writing.md`: 기본 폴더 `<repo>/.omc/orch/specs/`, 파일 이름 `spec-<worktree 이름>.md`, 공통 지시서 `spec-common.md` 를 정했다. 오버레이가 다른 폴더를 정하면 그것을 따른다
- 쓰기 전에 `git check-ignore` 로 무시 여부를 보고, 무시되지 않으면 공유 `.gitignore` 가 아니라 `.git/info/exclude` 에 더한다

## 1.5.1

korean-check 새 금지어(`손으로`, `거르다`)에 걸린 문구를 고친다.

- 보드, 정리, 검증, 대기 reference 의 `손으로` 와 `거르다` 활용형을 권장 표현으로 바꿨다. 동작은 그대로다

## 1.5.0

보드 동기화가 단계가 남은 항목을 끝낸 것으로 바꾸던 문제와, 목표 진행률이 추적 id 목록에 매이던 문제를 고친다. 실제 보드에서 먼저 고쳐 실측한 규칙을 옮겼다.

- `board-sync.py`: PR 이 MERGED 여도 끝나지 않은 단계가 2개 이상이면 done 으로 바꾸지 않는다. 그 PR 번호가 적힌 단계에만 「✓ 」 를 붙이고 pr 칸을 비운다. 1개 이하일 때만 done 과 남은 단계 ✓ 다
- `goal-progress.py`: 추적 항목을 주지 않으면 목표 항목 자신의 단계 줄(숫자로 시작, 끝나면 「✓ 」)을 센다. 숫자로 시작하지 않는 줄은 세지 않는다. 추적 id 를 주는 기존 사용법은 그대로다
- `board-sync.py --goal` 은 `--goal-items` 없이도 쓴다
- 보드 reference 에 새 규칙과, mod 가 단계로 세면 `goal-progress.py` 를 걷어 낸다는 것을 적었다

## 1.4.0

필수가 아닌 체크가 코드와 무관한 이유로 실패했을 때 코디네이터가 직접 머지하던 일을 막는다. 2026-10-13 fos-accountbook PR #469 에서 `claude-review` 가 리뷰 계정의 주간 한도로 실패했고, 스크립트가 멈출지 미리 알 수 없었다.

- `merge-queue.sh` 에 `--allow-fail A,B` 를 더했다. 이름이 든 체크의 실패는 멈춤 조건에서 빼고 머지 전에 `경고: <PR> 실패를 허용한 체크 <이름>` 줄을 찍는다. 기본 동작(실패하면 멈춤)은 그대로다
- `--required` 나 저장소 규칙의 필수 체크에 든 이름은 허용하지 않는다. 옵션 값이 겹치면 종료 코드 2, 규칙에서 읽은 이름과 겹치면 `STOP` 이다. 따옴표와 역슬래시는 `--required` 처럼 막는다
- 진행 중인 체크는 이 옵션과 상관없이 끝날 때까지 기다린다
- 정리 reference 의 머지 절에 쓰는 때와, 실패를 허용하는 이유를 사용자에게 알린다는 규칙을 적었다

## 1.3.0

머지 뒤 정리와 보드 갱신을 손에서 스크립트로 옮긴다. 머지된 worktree 와 브랜치, worker 터미널과 지시서가 남고, 보드가 늦게 반영되던 문제다.

- `scripts/cleanup-sweep.py` 를 더했다. PR 이 MERGED 이거나 upstream 이 gone 이고 base 에 없는 커밋이 0 개인 브랜치의 worktree 를 정리한다. 커밋 안 된 변경, 원격에 없는 커밋, 살아 있는 worker, 경로를 잡은 프로세스가 있으면 이유를 내고 건너뛰며, 다음 실행에서 다시 판정한다. 기본은 dry-run 이다
- 살아 있는 worker 는 workerState 가 working 이나 ready 이거나, Dispatch 상태와 상관없이 터미널이 `orca terminal list` 에 살아 있는 worker 다. 터미널은 PR 이 MERGED 일 때만 닫고, 아니면 그 경로에 살아 있는 터미널이 있을 때 건너뛴다
- `remove-worktree.sh` 에 `--merged-head` 를 더했다. squash 머지된 커밋을 원격에 없는 커밋으로 세지 않는다
- `merge-queue.sh` 가 모든 PR 을 머지한 뒤 `cleanup-sweep.py --apply` 를 부른다. `--sweep-arg` 로 인자를 넘기고 `--no-sweep` 으로 끈다
- `scripts/board-sync.py` 를 더했다. PR 이 MERGED 인 항목을 done 으로 바꾸고 남은 단계에 「✓ 」 를 붙인 뒤 `goal-progress.py` 를 부른다. 상태 줄은 쓰지 않고, 예전 버전이 남긴 「자동: 」 줄은 지운다
- 보드 reference 에 하위 줄은 번호 붙은 단계만 두고 끝나면 「✓ 」, 진행은 `--progress 끝낸/전체` 로 적는 규칙을 적었다
- 기다리기 단계에 깨어날 때와 5분마다 두 스크립트를 돌린다고 적고, 오버레이 표에 지시서 폴더 칸을 더했다
- 가짜 gh, orca, lsof 와 실제 git 저장소로 각 판정 갈래를 테스트했다

## 1.2.0

worker 의 ask 가 도구 시간 제한에 걸리거나 끝난 Dispatch 에서 거절되던 문제를 스크립트로 막는다.

- `scripts/worker-ask.sh` 를 더했다. ask 를 부르고, 시간 제한이면 종료 코드 4 와 메시지 ID 를, ask 가 실패하면 `send --to run:<id> --type question` 으로 대신 보내고 종료 코드 3 을 낸다. Run 은 `--run` 이 없으면 `check --peek` 의 runId 로 찾는다
- 공통 지시서 틀에 worker 가 이 스크립트를 `run_in_background` 로 돌리고 완료 알림을 기다린다는 줄과 `{{ORCH_SCRIPTS}}`, `{{RUN_ID}}` 를 더했다
- 가짜 orca 로 성공, 시간 제한, 대신 보내기, zsh 에서 부르는 경우를 테스트했다

## 1.1.0

`merge-queue.sh` 가 체크가 시작되기 전에 머지하는 문제와 오래된 base 위에서 통과한 PR 이 머지되는 문제를 막는다.

- 필수 체크가 모두 나타나고 끝날 때까지 기다린다. 이름은 `--required a,b,c` 로 받고, 없으면 저장소 규칙의 `required_status_checks` 에서 읽는다. 규칙 조회가 실패하면 멈추고, 목록이 비어 있으면 경고하고 예전처럼 지금 있는 체크만 기다린다
- `--require-up-to-date` 선택 옵션을 더했다. PR 이 base 최신을 품지 않으면 `update-branch` 로 base 를 merge 하고 필수 체크를 다시 기다린 뒤 머지한다. 기본은 끔이고 저장소 오버레이가 켠다
- 정리와 머지 단계 reference 에 두 동작의 이유를 적었고, 오버레이 항목 표의 머지 조건에 두 값을 더했다
- 가짜 gh 로 두 동작의 테스트를 더했다

## 1.0.0

개인 지침에 있던 Orca orchestration 운영 절차를 스킬로 옮겼다.

- 7단계(에이전트 고르기, 지시서 쓰기, 띄우기, 기다리기, 답하고 지시 보내기, 완료 검증, 머지와 정리)를 개요 표와 단계별 reference 로 나눴다
- `merge-queue.sh` 를 더했다. 저장소 경로와 호스트, 스레드 조회 명령을 인자로 받고, PR 마다 머지 전 명령을 `PR:명령` 이나 `--before` 로 받는다. 체크 완료 대기, mergeable UNKNOWN 재시도, 미해결 스레드 확인을 하고, 체크를 보기 전에 고정한 HEAD 를 머지 직전의 PR HEAD, 원격 브랜치 HEAD 와 대조한다. release 브랜치와 다른 열린 PR 의 base 인 브랜치는 지우지 않는다
- `triage-messages.py` 를 더했다. `worker_done`, `escalation`, `question` 을 따로 모으고 heartbeat 는 개수만 낸다. `--live --since` 로 지난 시각부터 다시 본다
- `remove-worktree.sh` 를 옮겼다. 쓰는 프로세스, 미커밋 변경, 원격에 없는 커밋이 있으면 지우지 않는다
- `goal-progress.py` 를 더했다. 추적 항목 목록을 인자나 파일로 받아 보드 목표 항목의 진행 표시줄을 다시 계산한다
- `templates/spec-common.md` 에 저장소와 무관한 공통 지시서 틀을 두었다
- 저장소 오버레이 `<repo>/.claude/orch-overlay.md` 를 먼저 읽고, 적을 항목은 `references/overlay.md` 가 정한다
- 머지마다 정리, 충돌 파일을 한쪽으로 통째 고르지 않기, worker 의 확인 창을 대신 승인하지 않기, 막힌 PR 생성과 리뷰 회신을 코디네이터가 대신 하기를 해당 단계에 넣었다
