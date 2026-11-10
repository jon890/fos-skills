// 머지가 끝난 worktree 와 로컬 브랜치, 그 worker 터미널과 지시서를 찾아 정리한다.
//
// 머지마다 수동으로 정리하면 잊히고, 프로세스가 worktree 를 잡고 있어 그 자리에서 실패한 것은 다시 돌아보지 않는다.
// 이 명령은 상태로만 판정하므로 몇 번을 돌려도 같다. 건너뛴 항목은 다음 실행에서 다시 판정된다.
// 사용자가 말하지 않아도 깨어날 때마다 돈다. 코디네이터가 끝난 항목을 직접 지우지 않는다.
//
// 일하는 중 (--run 을 줬을 때, 워크트리마다 맨 처음):
//     worker 상태는 lib/worker-state.ts 의 판정이 정한다. 그 경로의 이 Run worker 행 가운데 살아 있는 dispatch 가 있으면
//     터미널 소유 확인과 PR 조회(gh) 앞에서 건너뛴다. 워크트리가 많을 때 그 조회가 루프의 제한 시간을 다 썼다.
//     판정이 working 이면 `건너뜀 <경로>: 살아 있는 worker <dispatch>. 근거: <이유>`, taken_over 면
//     `남김: 사용자 보유 터미널 (<경로>). 근거: <이유>` 다. user_takeover 로 표시된 행만 그 터미널 화면을 읽는다.
//     화면이 에이전트 작업 중이면 working 이다. 새 세션에서 띄운 worker 를 Orca 가 user_takeover 로 적는다
//
// 정리 대상 (브랜치마다):
//     - 그 브랜치의 PR 이 MERGED 다
//     - PR 이 없거나 MERGED 가 아니면, upstream 이 gone 이고 `git cherry` 로 base 에 없는 커밋이 0 개다
//     - 머지 없이 CLOSED 가 된 PR 의 터미널(아래 「머지 없이 CLOSED 가 된 PR 의 터미널」). 워크트리는 위 판정을 따른다
//     - PR 없이 끝난 워크트리(아래 「PR 없이 끝난 워크트리」)
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
//       - lib/worker-state.ts 의 판정이 done 이다. 그 경로의 worker 행이 하나 이상이고 모두 끝났으며(completed, failed, canceled, 반납),
//         브랜치에 origin/<기준> 보다 앞선 커밋이 없다. 살아 있는 터미널의 화면을 읽어 넘겨받은 터미널이나 작업 중인 화면이 있으면 아니다
//       - 커밋 안 된 변경이 없다
//       - 브랜치가 쓰는 원격 브랜치(upstream, `branch.<b>.merge`, 로컬 이름)가 있으면 그것도 앞선 커밋이 없다
//     원격 브랜치도 위 조건을 채웠을 때만 지운다(원격 브랜치 삭제의 끝점 확인은 그대로다).
//     하나라도 아니면 남기고 `남김 <경로>: PR 없음, upstream 이 남아 있다. 치우지 않는 이유: <이유>` 를 낸다.
//     치울 때는 PR 이 MERGED 일 때와 같게 그 경로의 터미널(Orca 가 다시 연 빈 셸 포함)을 모두 닫고, --kill-holders 면 남은 프로세스도 끈다
//
// 건너뜀 (이유를 낸다):
//     - 커밋 안 된 변경이 있다
//     - 원격에도 머지된 PR HEAD 에도 없는 커밋이 있다
//     - 살아 있는 worker 가 그 worktree 를 맡고 있다(위 「일하는 중」).
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
// 리뷰 워크트리 (워크트리마다. 위 「건너뛰는 경우」 를 지난 detached 워크트리):
//     launch-worker 는 리뷰 워크트리를 `review/pr-<N>` 브랜치로 만든 뒤 PR head 를 detached 로 꺼낸다. 브랜치가 없어 위 판정에 걸리지 않는다.
//     그것을 만든 브랜치(lib/review.ts 의 originBranch)가 리뷰 브랜치이거나, 그 경로의 띄우기 기록(lib/launched.ts) 지시서가 리뷰 지시서면
//     리뷰 워크트리다. 아래가 모두 참이면 저장소 안팎과 상관없이 `git worktree remove` 로 지운다. PR 상태는 보지 않는다.
//       - --run 과 상관없이 모든 Run 의 worker 행 가운데 그 실경로를 쓰는 살아 있는 dispatch 가 없다. 다른 PR 의 리뷰나 일반 작업이
//         그 경로를 이어 쓸 수 있고, 터미널 없는 구조화 worker 는 터미널 목록으로 보이지 않는다. 목록을 읽지 못하면 남긴다
//       - 모든 Run 의 살아 있는 dispatch 지시서 가운데 같은 번호의 리뷰 지시서가 없다. 목록을 읽지 못하면 남긴다
//       - 커밋 안 된 변경이 없다
//       - 그 경로를 작업 디렉터리로 쓰는 프로세스가 없고, 그 경로에 Orca 터미널이 없다
//     HEAD 가 원격에 있는지는 보지 않는다. 리뷰 워크트리의 HEAD 는 PR head 이고 `refs/pull/<N>/head` 는 원격 추적 브랜치가 아니다.
//     출력은 `리뷰 워크트리를 지울 것 <경로> (#<N>)`, `리뷰 워크트리 삭제 <경로> (#<N>)`, `건너뜀 리뷰 워크트리 <경로> (#<N>): <이유>` 다.
//     지운 뒤 아래 「리뷰 흔적」 이 그것을 만든 `review/pr-<N>` 브랜치를 PR 이 닫혔으면 지운다.
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
//     사용자가 의도해 넘겨받은 것과 이 자동 기록은 Orca 의 필드로 구분할 수 없어, 기본은 남긴다.
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
//     호출 터미널의 바인딩과 관계없이 `run-list` 를 따라 Run 마다 `worker-list --run` 으로 읽어 합친다.
//     터미널 소유 확인과 같은 행을 정리 실행 내내 쓴다. 삭제 직전에는 해당 경로와 새로 갱신된 Run 만 다시 읽는다.
//     그 조회가 실패하면 이 Run worker 의 터미널만 닫고, 다른 터미널이 있는 경로는 건너뛴다.
//
// 기준 브랜치 따라가기 (저장소마다 맨 처음):
//     기본 체크아웃이 기준 브랜치에 있고 origin/<기준> 의 조상이면 `git merge --ff-only` 로 맞춘다.
//     로컬에만 있는 커밋이 있거나 다른 브랜치가 체크아웃돼 있으면 건드리지 않고 이유를 낸다.
//     기준 브랜치가 뒤처지면 그 위에서 계획한 worker 가 옛 코드를 본다.
//
// 실행 순서 (worktree 마다):
//     그 경로의 Orca 터미널 close(PR 이 MERGED 이거나 PR 없이 끝난 워크트리일 때만. 머지 없이 CLOSED 가 된 내 PR 이면 그 dispatch 의 터미널만), 끝난 Dispatch release, `remove-worktree.ts --delete-branch --merged-head`,
//     원격 브랜치 삭제(이미 없으면 통과), 지시서와 PR 본문 파일 삭제.
//     remove-worktree.ts 는 lib/proc.ts 의 scriptCommand 로 같은 폴더의 것을 부른다.
//     기준 브랜치, `release/*`, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다.
//     worktree 없이 남은 로컬 브랜치도 같은 조건으로 판정해 지운다. 그다음 리뷰 흔적(위 「리뷰 흔적」)을 지운다. 로컬 브랜치 없이 직접 머지한 PR 과
//     다른 PR 에 합쳐 닫힌 PR 의 원격 브랜치는 `--remote-branches` 가 지운다.
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
// 끝난 dispatch 반납 (--run 을 줬을 때, 워크트리마다 「일하는 중」 다음):
//     그 경로의 worker 행 가운데 끝났고(lib/worker-state.ts 의 isFinished) terminalState 가 reclaimable 인 dispatch 는 워크트리를 치우기 전에,
//     치우지 않고 남기더라도 `worker-release` 로 반납한다(--apply 가 없으면 반납할 것만 낸다). reclaimable 은 Orca 가 거둘 수 있다고 적은
//     터미널이다. 반납하지 않으면 worker 프로세스가 워크트리를 쥔 채 남아 정리가 「남은 프로세스」 로 미뤘다(2026-11-02 ctx_ea9fb7dac42e)
//
// 마무리 빠짐: PR 이 MERGED 라 워크트리를 치울 때 그 PR 에 마무리(finish-pr.ts)가 돈 표시(lib/finish-marks.ts)가 없으면
//     `정리` 줄 다음에 `FINISH-MISSING #<PR> <브랜치>: …` 한 줄을 낸다. 치우기는 그대로 한다. 상주 루프가 이 줄을 알림 파일에 옮긴다.
//     `gh pr merge` 로 바로 머지해 배포 확인, 업무 완료, 보드 done 이 빠진 PR 을 코디네이터가 알게 하려는 것이다.
//     worker 터미널과 dispatch 는 여기서 닫고 반납하므로, 마무리를 뒤늦게 돌려도 정리는 다시 할 일이 없다
import type { Args, Json, Log, Pr, Report, Sweep, Terminal } from '../shared.ts'
import { BY_NO_PR, BY_PR, RUN_TIMEOUT_SEC, dirty, git, readText, resourceOf, run, truthy, under, worktrees } from '../shared.ts'
import { REAL_HOST, describe, holderPids, holdersOf, onlyIdleShells, sessionEndHooks, stopHolders, waitFree } from '../processes.ts'
import type { StepContext, StepResult, StepState } from './context.ts'
import type { Verdict } from '../../lib/worker-state.ts'
import type { WorkerRow } from '../../lib/ownership.ts'
import { allLiveSpecPaths } from '../../lib/spec.ts'
import { basename } from 'node:path'
import { closeForClosedPr, closeTerminals, emptyShells, foreignAt, idleAgentPath, launchedOwn, liveTerminals, releaseDispatches, takenOverOwn, terminalsAt, workersAt } from '../terminals.ts'
import { closeTerminal as closeOrcaTerminal } from '../../lib/orca.ts'
import { deleteRemote, merged, ownPr, prCandidates, protectedReason, remotePlan, unpushed } from '../prs.ts'
import { deleteSpecFiles, specsKept, trashLaunchedSpecs } from './specs.ts'
import { finishStarted } from '../../lib/finish-marks.ts'
import { fire } from '../../lib/events.ts'
import { forgetLaunch, launchesAt } from '../../lib/launched.ts'
import { idleShellVerdict } from '../../lib/idle-shells.ts'
import { isFinished, isLive, judge, readScreens, screenHandles } from '../../lib/worker-state.ts'
import { isObject } from '../../core/json.ts'
import { liveReviewPrs, originBranch, reviewPrOf, reviewPrOfBranch } from '../../lib/review.ts'
import { blocker as ownershipBlocker } from '../../lib/ownership.ts'
import { realPath } from '../../lib/fs.ts'
import { scriptCommand } from '../../lib/proc.ts'
import { scriptPath } from '../../lib/commands.ts'

const REMOVE = scriptPath('remove-worktree')

const KEPT_BY_HOOK = '저장소 핸들러 거부'

// 남은 프로세스를 끄면 안 되는 이유. 끌 수 있으면 null 이다. verdict 는 lib/worker-state.ts 의 판정이고 done 이어야 끈다.
// dry-run 은 터미널을 닫기 전이라 checkTerminals 를 끈다. 실제 실행은 끝난 워크트리면 터미널을 먼저 닫는다.
function killBlocker(verdict: Verdict | null, path: string, checkTerminals = true): string | null {
  if (verdict === null) return 'PR 이 MERGED 가 아니고 PR 없이 끝난 워크트리도 아니다'
  if (verdict.state !== 'done') return `끝남이 아니다(${verdict.state}): ${verdict.reason}`
  if (!checkTerminals) return null
  const terminals = liveTerminals()
  if (terminals === null || terminalsAt(terminals, path).length) return '그 경로에 Orca 터미널이 남아 있거나 터미널 목록을 읽지 못했다'
  return null
}

// 그 커밋이 원격 추적 브랜치 어딘가에 들어 있는지.
function onRemote(repo: string, commit: string): boolean {
  const done = git(repo, 'for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/remotes/')
  return done.code === 0 && done.out !== ''
}

// detached 워크트리가 리뷰 워크트리면 그 PR 번호. 만든 브랜치(originBranch)가 리뷰 브랜치이거나 띄우기 기록의 지시서가 리뷰 지시서다
function reviewOfWorktree(repo: string, path: string): number | null {
  const origin = originBranch(path)
  const byBranch = origin ? reviewPrOfBranch(origin) : null
  if (byBranch !== null) return byBranch
  for (const launch of launchesAt(repo, path)) {
    const n = launch.spec ? reviewPrOf(basename(launch.spec), readText(launch.spec)) : null
    if (n !== null) return n
  }
  return null
}

// 리뷰 워크트리를 지운다. 조건은 머리 주석의 「리뷰 워크트리」 가 정한다
async function sweepReviewWorktree(repo: string, path: string, n: number, args: Args, terminals: Terminal[], log: Log, report: Report): Promise<void> {
  const skip = (reason: string) => {
    log(`건너뜀 리뷰 워크트리 ${path} (#${n}): ${reason}`)
    report.skipped.push({ path, reason: `리뷰 워크트리: ${reason}` })
  }
  // 다른 Run 의 dispatch 가 이 경로를 이어 쓸 수 있다. 다른 PR 의 리뷰나 일반 작업, 터미널 없는 구조화 worker 도 있다
  let rows: WorkerRow[]
  try {
    rows = await args.allWorkers()
  } catch (e) {
    return skip(`모든 Run 의 worker 목록을 읽지 못했다: ${(e as Error)?.message ?? String(e)}`)
  }
  const target = realPath(path)
  const using = rows.filter((w) => {
    const id = String(resourceOf(w).worktreeId ?? '')
    const at = id.indexOf('::')
    return at >= 0 && realPath(id.slice(at + 2)) === target && isLive(w)
  })
  if (using.length) return skip(`그 경로를 쓰는 살아 있는 dispatch ${using.map((w) => String(w.dispatchId ?? '?')).join(', ')}`)
  const live = liveReviewPrs(allLiveSpecPaths())
  if (live === null) return skip('살아 있는 지시서 목록을 읽지 못했다')
  if (live.has(n)) return skip('리뷰 dispatch 가 살아 있다')
  if (dirty(path)) return skip('커밋 안 된 변경')
  const pids = holderPids(path, REAL_HOST)
  if (pids.length) return skip(`그 경로를 쓰는 프로세스 ${pids.length} 개(${describe(pids, REAL_HOST)})`)
  if (terminalsAt(terminals, path).length) return skip('Orca 터미널이 있다')
  if (!args.apply) {
    log(`리뷰 워크트리를 지울 것 ${path} (#${n})`)
    return
  }
  const done = git(repo, 'worktree', 'remove', path)
  if (done.code === 0) {
    log(`리뷰 워크트리 삭제 ${path} (#${n})`)
    report.removed.push(path)
  } else {
    skip(`삭제 실패: ${done.err}`)
  }
}

// 저장소 밖 detached 워크트리를 지운다. 조건은 머리 주석의 「저장소 밖 detached 워크트리」 가 정한다.
// 리뷰 워크트리는 저장소 안팎과 상관없이 「리뷰 워크트리」 의 조건으로 지운다
async function sweepDetached(repo: string, path: string, args: Args, terminals: Terminal[], log: Log, report: Report): Promise<void> {
  const skip = (reason: string, line: string) => {
    log(line)
    report.skipped.push({ path, reason })
  }
  const review = reviewOfWorktree(repo, path)
  if (review !== null) return sweepReviewWorktree(repo, path, review, args, terminals, log, report)
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

// 「PR 없이 끝난 워크트리」 를 치우지 못하는 이유. 치워도 되면 null 이다. 조건은 머리 주석이 정한다.
// dispatch 와 앞선 커밋, 화면은 lib/worker-state.ts 의 판정이 done 이어야 한다. own 은 코디네이터 것으로 확인한 터미널이다
function noPrBlocker(s: Sweep, branch: string, path: string, mine: WorkerRow[], terminals: Terminal[], own: ReadonlySet<unknown>): string | null {
  const { repo, args } = s
  if (mine.length === 0) return '그 경로의 dispatch 를 모른다(--run 이 없거나 그 Run 에 없다)'
  const ahead = (ref: string) => {
    const done = git(repo, 'rev-list', '--count', `origin/${args.base}..${ref}`)
    return done.code === 0 && /^\d+$/.test(done.out) ? Number(done.out) : -1
  }
  const local = ahead(`refs/heads/${branch}`)
  const screens = readScreens(screenHandles(mine, own, new Set(terminalsAt(terminals, path))))
  const verdict = judge({ rows: mine, pr: 'none', ahead: local < 0 ? null : local, screens, own })
  if (verdict.state !== 'done') return verdict.reason
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

// 머리 주석의 「머지 없이 CLOSED 가 된 PR 의 터미널」 조건을 채우면 닫을 터미널 목록, 아니면 null 이다.
// 닫는 것은 그 경로의 이 Run worker 행이 가리키는 살아 있는 터미널뿐이다. 다른 Run 의 worker 가 쥔 handle 은 뺀다.
// 모든 Run 의 worker 를 읽지 못했으면(foreign 이 null) foreignAt 처럼 agentTerminalHandle 만 이 Run 의 것으로 본다.
// 작성자 목록은 이 Run 의 끝난 worker 가 있는 CLOSED PR 을 만났을 때만 읽는다
function closedOwnTerminals(s: Sweep, pr: Pr | null, mine: WorkerRow[], terminals: Terminal[], path: string): string[] | null {
  if (!s.args.run || !pr || pr.state !== 'CLOSED') return null
  if (mine.length === 0 || !mine.every(isFinished)) return null
  const authors = s.owners()
  if (!authors || !ownPr(pr, authors)) return null
  const foreign = s.args.foreign
  const own = new Set<unknown>(
    mine.flatMap((w) => (foreign === null ? [w.agentTerminalHandle] : [resourceOf(w).terminalHandle, w.agentTerminalHandle])).filter(truthy),
  )
  return terminalsAt(terminals, path).filter((h) => own.has(h) && !foreign?.has(h))
}

async function sweepWorktree(s: Sweep, path: string, branch: string, listed: Terminal[]): Promise<void> {
  const { repo, args, workers, specsDir, log, report } = s
  let terminals = listed
  const name = basename(path)
  const keep = (reason: string, line: string) => {
    log(line)
    report.skipped.push({ path, reason })
  }
  const mine = workersAt(workers, path)
  // 살아 있는 dispatch 의 워크트리는 소유 확인과 PR 조회 앞에서 건너뛴다. 워크트리가 많으면 그 조회가 정리 시간을 다 쓴다(머리 주석의 「일하는 중」)
  if (mine.some(isLive)) {
    const verdict = judge({ rows: mine, screens: readScreens(screenHandles(mine)) })
    if (verdict.state === 'taken_over') return keep('사용자 보유 터미널', `남김: 사용자 보유 터미널 (${path}). 근거: ${verdict.reason}`)
    const reason = `살아 있는 worker ${mine.filter(isLive).map((w) => String(w.dispatchId ?? '?')).join(', ')}`
    return keep(reason, `건너뜀 ${path}: ${reason}. 근거: ${verdict.reason}`)
  }
  // 머리 주석의 「끝난 dispatch 반납」. 워크트리를 남기더라도 Orca 가 거둘 수 있다고 적은 터미널은 먼저 반납한다
  releaseDispatches(mine.filter((w) => isFinished(w) && w.terminalState === 'reclaimable'), args.apply, log, '')
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
    const why = noPrBlocker(s, branch, path, mine, terminals, taken)
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
  // 머지 없이 CLOSED 가 된 내 PR(closing)도 그 dispatch 의 터미널을 아래에서 닫으므로 같게 다룬다.
  // PR 없이 끝난 워크트리는 lib/worker-state.ts 의 판정이 그 터미널 화면까지 보고 done 으로 정했다
  const byPr = m.why === BY_PR
  // 터미널을 모두 닫고 치우는 판정. 남은 프로세스를 끄는 것도 이때뿐이다
  const byDone = byPr || byNoPr
  const live = mine.filter((w) => !byDone && closing === null && alive.has(w.agentTerminalHandle ?? null))
  if (live.length) {
    const reason = `살아 있는 worker ${live.map((w) => String(w.dispatchId ?? '?')).join(', ')}`
    return keep(reason, `건너뜀 ${path}: ${reason}`)
  }
  let theirs = foreignAt(args, mine, terminals, path)
  if (theirs.length && args.foreign === null && idleAgentPath(args, path)) {
    log(`  ${path}: 하위 에이전트 워크트리의 빈 셸 터미널이라 다른 Run 의 것으로 세지 않는다`)
    theirs = []
  }
  if (theirs.length && args.foreign === null && byDone && emptyShells(path, theirs, terminals)) {
    // 코디네이터가 worker 터미널을 닫으면 Orca 가 그 탭에 빈 셸을 다시 연다. 어느 Run 의 것도 아니다
    for (const handle of theirs) {
      if (args.apply) log(closeOrcaTerminal(handle, { checkResponse: false, timeoutMs: RUN_TIMEOUT_SEC * 1000 }) ? `  빈 셸을 닫았다: ${handle}` : `  빈 셸 닫기 실패 ${handle}`)
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
  const closable = closing ?? []
  if (!byDone && terminalsAt(terminals, path).some((h) => !closable.includes(h))) {
    const reason = '살아 있는 터미널이 있다. 끝난 워크트리(PR MERGED, PR 없이 끝남)가 아니면 터미널을 닫지 않는다'
    return keep(reason, `건너뜀 ${path}: ${reason}`)
  }

  log(`정리 ${path} (${branch}, ${m.why})`)
  // 머리 주석의 「마무리 빠짐」
  if (byPr && m.pr && !finishStarted(repo, String(m.pr.number))) {
    log(`FINISH-MISSING #${m.pr.number} ${branch}: 머지 뒤 마무리(finish-pr)가 돈 적이 없다. 배포 확인, 업무 완료, 보드 done 이 빠졌을 수 있다`)
  }
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
  // 경로의 터미널은 끝난 워크트리(PR MERGED, PR 없이 끝남)일 때만 모두 닫는다. cherry 로만 판정한 브랜치는 막 만든 브랜치일 수 있다.
  // 머지 없이 CLOSED 가 된 내 PR 이면 그 dispatch 가 쓴 터미널만 닫는다
  if (byDone) closeTerminals(terminalsAt(terminals, path), args.apply, log)
  else if (closing && m.pr) closeForClosedPr(closing, m.pr, args.apply, log, '  ')
  releaseDispatches(mine, args.apply, log, '  ')
  // 남은 프로세스를 끌지 정하는 판정. 터미널은 위에서 닫으므로 화면은 보지 않는다. PR 없이 끝난 워크트리는 화면까지 보고 이미 done 이다
  const finished = byDone ? judge({ rows: mine, pr: byPr ? (m.pr ?? { state: 'MERGED' }) : 'none', ahead: 0 }) : null
  if (!args.apply) {
    const pids = holderPids(path, REAL_HOST)
    if (pids.length && byDone && onlyIdleShells(pids, REAL_HOST)) {
      log(`  남은 프로세스 ${pids.length} 개가 유휴 셸뿐이면 그 Orca 터미널을 닫고 다시 시도한다`)
    } else if (pids.length && args.killHolders) {
      const blocker = killBlocker(finished, path, false)
      log(
        `  터미널을 닫은 뒤에도 프로세스 ${pids.length} 개가 남으면 ` +
          (blocker ? `다음 실행으로 미룬다. 끄지 않는 이유: ${blocker}` : 'TERM, HUP, KILL 순으로 끈다'),
      )
    } else if (pids.length) {
      log(`  터미널을 닫은 뒤에도 프로세스 ${pids.length} 개가 남으면 다음 실행으로 미룬다`)
    }
    log(`  worktree 와 로컬 브랜치를 지울 것 ${branch}`)
    deleteRemote(repo, plan, args.base, false, log)
    if (!specsKept(s, path, name, branch, m.pr)) {
      trashLaunchedSpecs(repo, specsDir, path, false, log, args.liveSpecs, args.trash)
      deleteSpecFiles(specsDir, name, false, log, args.liveSpecs, branch, m.pr)
    }
    return
  }

  let pids = await waitFree(path, args.wait, args.pollInterval)
  if (pids.length && byDone && onlyIdleShells(pids, REAL_HOST)) {
    // worker 를 반납한 뒤나 워크트리를 화면에서 열 때 Orca 가 띄운 빈 셸이 폴더를 붙잡는다. 터미널과 worker 를 다시 읽어 그 터미널을 닫는다.
    // 소유 상태는 캐시를 거치지 않고 새로 읽는다. 기다리는 사이 사용자가 넘겨받았을 수 있다
    const again = await ownershipBlocker(path, taken, () => args.worktreeWorkers(path))
    if (again) return keep(again, `남김: ${again} (${path})`)
    const listed = liveTerminals() ?? []
    const verdict = idleShellVerdict({ path, terminals: listed, holders: holdersOf(path, REAL_HOST), claimed: args.foreign ?? new Set() })
    if ('close' in verdict) {
      log(`  남은 프로세스 ${pids.length} 개가 유휴 셸뿐이다. Orca 터미널을 닫고 다시 시도한다`)
      closeTerminals(verdict.close, true, log, '유휴 셸 터미널')
      pids = await waitFree(path, args.wait, args.pollInterval)
    } else {
      log(`  유휴 셸 터미널을 닫지 않는다: ${verdict.keep}`)
    }
  }
  if (pids.length && args.killHolders) {
    const blocker = killBlocker(finished, path)
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
  deleteRemote(repo, plan, args.base, true, log)
  if (!specsKept(s, path, name, branch, m.pr)) {
    trashLaunchedSpecs(repo, specsDir, path, true, log, args.liveSpecs, args.trash)
    deleteSpecFiles(specsDir, name, true, log, args.liveSpecs, branch, m.pr)
  }
  // 지시서를 옮긴 뒤 지운다. 그 워크트리를 가리키는 다른 Run 의 기록도 워크트리와 함께 끝났다
  for (const w of mine) if (typeof w.dispatchId === 'string') forgetLaunch(repo, w.dispatchId)
  for (const launch of launchesAt(repo, path)) forgetLaunch(repo, launch.dispatch)
}

export async function cleanupWorktrees(ctx: StepContext, state: StepState): Promise<StepResult> {
  const { repo, args, workers, terminals, log } = ctx
  const s: Sweep = { repo, args, workers, log, ...state }
  for (const [path, branch] of state.listed) await sweepWorktree(s, path, branch, terminals)
  const remaining = new Set(worktrees(repo).map(([, branch]) => branch))
  remaining.add(git(repo, 'branch', '--show-current').out)
  return { report: s.report, remaining }
}
