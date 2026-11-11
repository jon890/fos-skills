# orch: 짧은 `orch` 명령, 문맥 기본값, 짧은 출력, 기능별 scripts 폴더

확인: 2026-11-04

## 목표

코디네이터, worker, 저장소 스크립트와 상태를 확인하는 사람이 orch 스크립트를 번들 경로 없이 `orch <묶음> <동작>` 으로 부른다. 문맥으로 알 수 있는 인자(저장소, Run, 지시서 폴더)는 적지 않는다. 기본 출력은 판정에 필요한 짧은 줄이다. 플러그인 갱신이나 프로필 전환 뒤에도 기억해 둔 명령이 다른 범위의 옛 번들로 새지 않는다. 진입 스크립트는 명령 묶음과 같은 폴더로 나눈다.

- 배경(실측 2026-11-04): 문서 16개에서 `"$SKILL_DIR/bin/orch.ts"` 를 68번 부른다(사용자 환경 전체 70개 문서, 310번). 경로에 공백(`Application Support`)이 있고 프로필과 버전마다 바뀐다. `wait-important` 의 `NEXT_WAIT` 는 400자쯤이다(`skills/orch/scripts/wait-important.ts` 의 `nextWait`).
- 배경(실측 2026-11-04): #329 폴더 이동 뒤 옛 진입점(3.x `orch/bin/orch.ts`)이 user 범위 4.0.1 을 건너뛰고 다른 프로필의 project 범위 3.6.0 을 조용히 실행했다(`.orch/feedback/coordinator-20261104-b.md` 2절).
- 배경(실측 2026-11-04): 진입 스크립트 37개와 lib 54개가 `skills/orch/scripts` 한 층에 있다.
- 배경(공식 문서): Claude Code 는 켜진 플러그인 루트의 `bin/` 을 Bash 도구의 PATH 에 넣는다(plugins-reference 「Standard layout」). Codex 와 사람이 직접 연 터미널은 받지 못한다.

## 범위

이번 범위:

- 짧은 명령 `orch` 와 PATH 에 두는 방법, 묶음 하위 명령 표, 사람용 요약 `orch status`
- 문맥 기본값(저장소, Run, 지시서 폴더, 대기의 루프 저장소)
- 새 꼴의 짧은 기본 출력과 `--full`
- 옛 호출(`bin/orch.ts <이름>`, 기억해 둔 옛 `NEXT_WAIT`)의 호환과 끝내는 시점
- 진입점의 번들 고르기 규칙(다른 범위의 옛 번들로 넘어가지 않기)과 doctor 의 알림
- 문서의 orch 호출을 새 꼴로 바꾸기
- 진입 스크립트를 묶음과 같은 폴더로 옮기기

범위 밖:

- 스크립트의 판정 규칙. 같은 입력이면 지금과 같은 판정을 낸다. 바뀌는 것은 부르는 꼴과 출력의 꼴이다
- lib 두 층(어댑터, 순수 판정) 분리와 중복 코드 합치기, `orch-loop.ts` 틱 단계 모듈화, Orca 기능으로 자체 상태 파일 대체. 뒤 기능으로 따로 spec 을 쓴다(DECISION9)
- 다른 스킬(spec, plan 등)의 스크립트와 work-board 의 `board.ts`

## 명령 표

`orch <묶음> <동작> [인자]` 이다. 동작이 하나뿐인 묶음은 동작을 생략한다(`orch wait`). 왼쪽의 옛 꼴은 호환 기간(DECISION3) 동안 그대로 받는다.
지금 모드 플래그로 고르던 동작은 하위 명령이 된다. 새 꼴은 옛 모드 플래그(`--start`, `--ack-lost` 같은 것)를 받지 않는다. 그 밖의 플래그와 위치 인자는 이름과 뜻이 같다.

| 묶음(폴더) | 새 꼴 | 옛 꼴 | 인자 계약이 바뀌는 곳 |
| --- | --- | --- | --- |
| `wait` | `orch wait` | `wait-important` | `--run`, `--loop-repo` 를 문맥에서 읽는다 |
| | `orch wait ack-lost <dispatch>...` | `wait-important --ack-lost` | 플래그가 동작과 위치 인자로 |
| | `orch wait triage <파일>...`, `orch wait triage --live` | `triage-messages` | 없음 |
| | `orch wait user-active` | `user-active` | 없음 |
| | `orch wait questions` | `watch-questions` | 없음 |
| `loop` | `orch loop start`, `stop [--all]`, `status`, `run [--once]` | `orch-loop --start`, `--stop`, `--status`, `--foreground` | 모드 플래그가 동작으로. `--tick` 은 내부용이라 옛 꼴만 |
| | `orch loop stalled` | `stalled-workers` | 없음 |
| `worker` | `orch worker launch` | `launch-worker` | 없음 |
| | `orch worker send` | `send-to-worker` | 없음 |
| | `orch worker nudge`, `orch worker screen <터미널>` | `nudge-worker`, `nudge-worker --state` | `--state` 가 동작으로 |
| | `orch worker ask` | `worker-ask` | 없음 |
| | `orch worker adopt [--apply <터미널>]` | `adopt-sessions` | 없음 |
| | `orch worker resume --dispatch <id>` | `resume-worker` | 없음(새 명령, docs/features/limit-resume) |
| | `orch worker worktree <저장소> --name …`, `orch worker check <워크트리> --spec …` | `make-worktree`, `make-worktree --check` | `--check` 가 동작으로 |
| | `orch worker deny <워크트리>` | `worktree-deny` | 없음 |
| | `orch worker link-profile [대상]` | `link-claude-profile` | 없음 |
| `queue` | `orch queue merge <PR>...` | `merge-with-finish` | 없음 |
| | `orch queue run <PR>...` | `merge_queue` | 없음(마무리 없는 머지 큐. 직접 부를 일은 드물다) |
| | `orch queue finish <PR>` | `finish-pr` | 없음 |
| | `orch queue ready <PR>...` | `ci-ready` | 없음 |
| | `orch queue gate <PR>` | (새로) | 머지 전 조건을 머지 없이 돌려 본다. worker 가 「준비됨」 을 보내기 전에 쓴다 |
| | `orch queue conflicts` | `notify-conflicts` | 없음 |
| | `orch queue overlap` | `overlap_units` | 없음 |
| | `orch queue reserve`, `orch queue reserve prune` | `reserve-migration`, `--prune` | `--prune` 이 동작으로 |
| `cleanup` | `orch cleanup sweep` | `cleanup-sweep` | `--repo`, `--run`, `--specs-dir` 를 문맥에서 읽는다 |
| | `orch cleanup worktree <워크트리>` | `remove-worktree` | 없음 |
| | `orch cleanup handoff` | `handoff-cleanup` | 없음 |
| `board` | `orch board sync`, `release`, `goal <id>` | `board-sync`, `board-release`, `goal-progress` | 없음 |
| `board` | `orch board auto-check <항목>` | `auto-check` | `--repo`, `--run` 을 문맥에서 읽는다 |
| `study` | `orch study list`, `add`, `set`, `migrate` | `study-candidates <동작>` | 없음 |
| `spec` | `orch spec lint`, `orch spec line <지시서>` | `spec-lint`, `spec-line` | 없음 |
| `doctor` | `orch doctor` | `orch-doctor.py`, `orch-doctor` | 없음 |
| | `orch doctor migrate`, `orch doctor migrate-hooks` | `migrate-orch-dir`, `migrate-orch-dir --hooks` | `--hooks` 가 동작으로 |
| | `orch doctor gh-usage` | `gh-usage` | 없음 |
| | `orch doctor install-cli` | (새로) | DECISION4 의 `~/.local/bin/orch` 설치 |
| | `orch paths <이름>`, `orch paths check` | `orch_paths` | 묶음 없이 한 단어 |
| `status` | `orch status` | (새로) | 사람용 요약. 루프 상태, 멈춘 worker 와 단계, 보드 항목 수를 읽기만 한다(DECISION12) |
| `slot` | `orch slot heavy -- <명령>`, `orch slot mem -- <명령>` | `heavy-slot`, `mem-gate` | 없음 |

## 출력

새 꼴의 기본 출력은 판정 줄만 낸다(DECISION5). 한 줄이 판정 하나이고 줄 머리가 대문자 판정 낱말이다(`LOOP-ALIVE`, `QUEUE-DONE` 같은 것). 설명과 진행 줄은 내지 않는다. `--full` 은 지금 출력을 그대로 낸다. `--json` 이 있는 명령은 그대로 둔다. `--help` 는 사람이 읽을 수 있게 길게 쓴다(DECISION10).
명령마다 어떤 줄을 남길지는 technical-design 이 표로 정한다. 지금 판정 낱말이 없는 명령(`cleanup-sweep` 의 `건너뜀 …`, `남김 …` 같은 것)은 판정 낱말을 새로 정한다.
옛 꼴(`bin/orch.ts <옛 이름>`, 기억해 둔 옛 `NEXT_WAIT`)로 불러도 같은 짧은 출력을 낸다(DECISION11). 스크립트 파일을 경로로 직접 실행하면 지금 출력 그대로다(DECISION16).

읽는 쪽(실측 2026-11-04, `skills/orch` 와 `docs`):

| 읽는 쪽 | 무엇을 읽나 | 새 꼴 출력이 바뀌면 |
| --- | --- | --- |
| 스크립트가 다른 스크립트를 부르는 자리 | `launch-worker` → `make-worktree`(경로 한 줄), `spec-line`, `spec-lint`. `send-to-worker` → `launch-worker`(`LAUNCHED`), `nudge-worker`(첫 낱말). `lib/conflicts.ts`, `lib/tell-worker.ts`, `finish-pr` → `send-to-worker`(종료 코드, `LAUNCHED`). `merge-with-finish` → `finish-pr`, `merge_queue`. `merge_queue` → `overlap_units`(`바로 머지`, 종료 코드), `cleanup-sweep`. `orch-loop` → `board-sync`, `cleanup-sweep`, `merge-with-finish`(큐 로그 끝 줄 `QUEUE-DONE`, `QUEUE-HELD`, `STOP`), `nudge-worker`, `send-to-worker`, `user-active`. `cleanup-sweep` → `remove-worktree`, `launch-worker`. `heavy-slot` → `mem-gate`. `board-sync` → `goal-progress`. `orch-doctor` → `orch-loop --status`, `spec-line`. `handlers/decision-pending.ts`, `lib/decisions.ts`, `lib/machine.ts` → `user-active`, `nudge-worker` | 스크립트 파일을 경로로 직접 실행해 `orch` 진입점을 거치지 않으므로 지금 출력 그대로다. 고치지 않는다 |
| work-board 요청문 | `extensions/work-board/hooks/register.js` 가 코디네이터에게 `skills/orch/scripts/send-to-worker.ts` 직접 경로를 지시한다 | 요청문을 `orch worker send` 로 바꾼다(PR1). 테스트는 문자열 포함만 보므로 PR3 뒤 경로가 깨져도 통과한다 |
| 훅 | `block-background-wait.ts` 가 명령 문자열의 `wait-important` 를 본다. `block-worker-terminal-send.ts` 가 `send-to-worker`, `nudge-worker`, `adopt-sessions` 를 안내한다. `require-spec-line.ts` 가 `spec-line` 을 본다 | 새 꼴(`orch wait`, `orch worker send` 같은 것)도 알아보게 고친다 |
| 코디네이터가 읽는 문서 | `skills/orch/SKILL.md`, `references/` 의 `waiting.md`(`LAST_DELIVERY`, `NEXT_WAIT`, `LOOP-EVENT`, 종료 코드), `launch.md`(`LAUNCHED`), `cleanup.md`(`QUEUE-DONE`, `FINISH-DONE`, `FINISH-FAIL`), `replying.md`, `verification.md`(`일치`, `불일치`), `board.md`, `heavy-checks.md`, `hooks.md`, `overlay.md`, `spec-writing.md`, `study-candidates.md`, `gh-call-budget.md`, `agent-selection.md`, `feature-loop.md`. `templates/spec-common.md` 의 `worker-ask`, `study-candidates` 블록. `docs/flow.md`, `docs/code-architecture.md`, `docs/data-schema.md` | 호출을 새 꼴로 바꾸고, 읽으라고 적은 줄을 새 기본 출력에 맞춘다 |
| worker 가 읽는 문서 | `skills/spec/references/interview.md`(`worker-ask` 의 `answer: `), `skills/implementation/references/no-spec-workflow.md`, `skills/mac-cleanup/references/git-and-sessions.md` | 같다 |
| 테스트 | `skills/orch/tests` 의 스크립트별 테스트 | 스크립트를 직접 실행하는 테스트는 그대로다. 새 꼴 출력과 이름표, 문맥 기본값, 훅은 테스트를 더한다 |
| 대기 출력을 다시 읽는 명령 | `triage-messages` 가 `wait-important` 의 출력 파일(한 줄 JSON 과 `LAST_DELIVERY`)을 읽는다(`references/waiting.md`) | `orch wait` 가 분류까지 하므로 코디네이터는 triage 를 따로 부르지 않는다(DECISION21). `orch wait triage` 는 `--full` 출력이나 저장한 원문 파일을 읽는다 |

저장소 밖에서 orch 를 부르거나 출력을 읽는 곳(실측 2026-11-04, `.orch/` 가 있는 저장소 14개):

| 저장소와 파일 | 하는 일 | 짧은 출력(PR2)의 영향 | 폴더 이동(PR3)의 영향 | 처리 |
| --- | --- | --- | --- | --- |
| ai-analysis `.orch/bin/wait-summary.py` | 대기 출력 파일의 한 줄 JSON 과 `LAST_DELIVERY`, `NEXT_WAIT` 줄을 읽어 메시지마다 한 줄로 줄인다 | 옛 꼴 `NEXT_WAIT` 로 건 대기가 짧은 출력을 내면 JSON 을 못 읽는다 | 없음 | doctor 가 알린다. `orch wait` 의 짧은 출력이 같은 일을 하므로 그 저장소는 이 파일을 지울 수 있다 |
| 13개 저장소 `.orch/specs/spec-common.md` 사본 | worker 가 `$ORCH_SCRIPTS/worker-ask.ts`, `study-candidates.ts`, `heavy-slot.ts`, `reserve-migration.ts` 를 경로로 직접 부르고 `answer: ` 줄을 읽는다 | 없음(직접 실행) | 경로가 사라진다 | 틀(`templates/spec-common.md`)은 PR1 에서 새 꼴로 바꾼다. 사본은 doctor 가 알리고 코디네이터가 PR3 머지 전에 고친다(DECISION17) |
| gersang-lab `.orch/overlay.md` | `$SKILL_DIR/scripts/merge-with-finish.ts`, `remove-worktree.ts` 를 경로로 직접 부른다 | 없음 | 경로가 사라진다 | doctor 가 알리고 코디네이터가 PR3 머지 전에 고친다(DECISION17) |
| gersang-lab `.orch/bin/orch.mts`, `with-heavy-slot.sh` | 3.x 진입점 사본의 `--path mem-gate` 로 경로 한 줄을 읽는다 | 없음 | 3.x 사본은 `orch/scripts` 만 찾아 이미 엇나간다 | doctor 가 알린다 |
| fos-assistant, fos-graphrag, fos-home-infra `.orch/hooks/after-cleanup.ts` | `<installPath>/orch/scripts/handoff-cleanup.ts` 를 박아 부르고 출력을 그대로 넘긴다 | 없음 | 경로가 사라진다(코디네이터가 2026-11-04 에 4.x 경로를 더했다) | doctor 가 알리고 코디네이터가 PR3 머지 전에 고친다(DECISION17) |
| ai-analysis `.orch/bin/release.sh`, `.claude/skills/release/scripts/release.py` | `*/orch/scripts/board-release.ts` 를 찾는다 | 없음 | 경로가 사라진다(코디네이터가 2026-11-04 에 4.x 경로를 더했다) | doctor 가 알리고 코디네이터가 PR3 머지 전에 고친다(DECISION17) |
| 다른 세션이 기억한 명령, 도는 루프와 대기 | 옛 꼴과 옛 `NEXT_WAIT` | 짧은 출력을 받는다 | 진입점 이름표가 새 경로로 넘긴다 | 바꿀 일 없음. 옛 번들로 도는 것은 doctor 의 `LOOP-STALE` 이 알린다 |

이 저장소 안의 읽는 쪽(위 표)은 해당 PR 에서 고친다. 저장소 밖은 고치지 않고 doctor 가 판정 줄과 고칠 꼴을 알린다(REQ7). 고치는 일은 코디네이터가 그 저장소 worker 에게 맡긴다.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | Claude 세션의 Bash 도구와, `orch doctor install-cli` 를 한 번 돌린 머신의 셸(Codex, 사람)에서 `orch` 가 PATH 에 있다 | 새 셸에서 `orch loop status` 가 번들 경로 없이 돈다. PATH 의 어느 `orch` 사본이 먼저 와도 같은 번들의 스크립트가 돈다 |
| REQ2 | 위 「명령 표」 의 새 꼴이 그 스크립트를 부르고, 동작으로 바뀐 모드 플래그는 새 꼴에서 받지 않는다 | 표의 행마다 새 꼴과 옛 꼴이 같은 입력에 같은 판정과 종료 코드를 낸다. `orch loop --start` 는 사용법 오류다 |
| REQ3 | `--repo`, `--run`, `--specs-dir`, `--loop-repo` 를 받는 새 꼴 명령은(DECISION23 의 예외 빼고) 그 값을 주지 않으면 명시 > 문맥 > 설정 순서로 읽고(DECISION18), 명시하지 않은 값을 어디서 읽었는지 stderr 에 한 줄 남긴다 | 주 checkout 이나 워크트리 안에서 인자 없이 부른 결과가 명시한 결과와 같다. 문맥도 설정도 없으면 사용법 오류로 무엇을 줘야 하는지 알린다 |
| REQ4 | 새 꼴의 기본 출력은 판정 줄이고 `--full` 은 지금 출력이다(DECISION20). `NEXT_WAIT` 는 `orch wait --ack <id>` 에 기본값과 다른 인자와 루프 저장소만 붙인 꼴이다(DECISION19) | 명령마다 기본 출력에 설명 줄이 없고 `--full` 출력이 옛 꼴 출력과 같다. 기본값만 쓰고 루프 저장소가 하나인 대기의 `NEXT_WAIT` 는 `orch wait --ack <id> --loop-repo <저장소>` 다. `orch` 가 PATH 에 없는 셸에서는 같은 인자를 진입점 절대경로 앞에 붙인 꼴이다 |
| REQ5 | 옛 꼴(`"$SKILL_DIR/bin/orch.ts" <옛 이름>`, 옛 `NEXT_WAIT`)이 호환 기간 동안 같은 스크립트를 같은 인자로 부르고, 새 꼴과 같은 짧은 출력을 내며, stderr 에 새 꼴을 한 줄 안내한다 | 옛 꼴의 판정과 종료 코드가 새 꼴과 같고 stderr 에 `orch: 새 꼴: orch …` 한 줄이 있다 |
| REQ6 | 진입점은 `$CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 설치 기록에서 user 범위 항목이 있으면 그 번들만 쓰고, 그 번들에 스크립트가 없으면 다른 범위로 넘어가지 않고 실패한다. user 범위 항목이 없을 때의 차례(project 범위, 진입점이 든 번들)는 지금과 같다 | user 범위 설치본에 스크립트 폴더가 없는 설치 기록에서 이유와 새 진입점 경로를 내고 종료 코드 3 으로 끝난다 |
| REQ7 | doctor 가 옛 번들로 도는 루프와 대기, `orch` 가 PATH 에 없는 셸, 옛 꼴이 남은 오버레이·저장소 스크립트·공통 지시서를 알린다 | 각 경우에 판정 줄과 고칠 명령 한 줄이 나온다 |
| REQ8 | 문서의 orch 호출이 새 꼴이다 | `skills` 와 `docs` 의 문서에 `"$SKILL_DIR/bin/orch.ts"` 호출이 없다. 남은 것은 호환을 설명하는 자리뿐이다 |
| REQ9 | 진입 스크립트가 묶음과 같은 폴더에 있다. 파일 이름은 그대로이고 옛 경로에 사본을 남기지 않는다 | 폴더 이동 뒤 기존 테스트가 모두 통과하고, 옛 꼴 호출(진입점 이름표)과 ps 명령줄의 `merge_queue.`, `merge-with-finish.` 판정이 그대로 돈다. PR3 은 「부록: 알려진 저장소의 직접 경로 호출」 의 모든 행이 고쳐진 뒤에 머지한다 |
| REQ10 | 사람용 요약 `orch status` 가 루프, worker, 보드의 상태를 한 번에 판정 줄로 낸다. Run 을 주지 않으면 작업 폴더 저장소의 루프에 등록된 Run 을 모두 요약한다 | 루프가 살았는지, 멈춘 worker 와 단계, 보드의 doing·decide 항목 수가 한 번의 호출로 나온다. 읽기만 하고 아무것도 고치지 않는다 |
| REQ11 | `orch wait` 의 기본 출력은 받은 메시지마다 판정 줄 하나를 triage 와 같은 차례로 내고 `LAST_DELIVERY`, `NEXT_WAIT` 로 끝난다. 원문 JSON 은 `--full` 이나 저장한 파일 경로 한 줄로 본다 | worker_done, escalation, question 이 섞인 묶음에서 줄 차례가 `triage-messages` 와 같고, 원문 경로의 파일을 `orch wait triage` 로 읽으면 같은 분류가 나온다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 명령 이름 체계 | 기능별 묶음 하위 명령(`orch loop start`, `orch queue merge`, `orch worker launch`). 모드 플래그가 하위 명령으로 바뀐 곳은 「명령 표」 의 마지막 칸 | 사용자 2026-11-04 | 권장안(한 단어, 플래그 유지)이 아니라 묶음을 골랐다 |
| DECISION2 | 문맥 기본값 | 명시 > 문맥 > 설정. 저장소는 작업 폴더의 주 checkout, Run 은 `orca orchestration run-current`, 지시서 폴더는 `finish.specs_dir` 없으면 `.orch/specs`, 대기의 루프 저장소는 작업 폴더 저장소에 이 Run 을 등록한 루프가 있으면 넣는다. 어디서 읽었는지 stderr 한 줄 | 사용자 2026-11-04 | 권장안 |
| DECISION3 | 옛 호출 호환 기간 | 옛 이름을 지우는 PR(DECISION13)이 머지될 때까지 받고 그동안 stderr 에 새 꼴을 안내한다. 그 뒤 옛 이름은 사용법 오류. 다른 스킬의 호환성 변경으로 메이저가 먼저 올라도 옛 이름은 남는다. 옛 진입점의 `--path [이름]` 도 옛 꼴로 함께 받는다 | 사용자 2026-11-04 | 권장안(기한 없음)이 아니다 |
| DECISION4 | PATH 에 두는 방법 | 둘 다. 플러그인 루트 `bin/orch` 와 doctor 의 `~/.local/bin/orch`. [ADR-004](../../adr/004-no-plugin-bin.md) 를 `orch` 하나만 허용하도록 고친다. 두 사본은 설치 기록에서 번들을 찾아 넘기기만 한다 | 사용자 2026-11-04 | 권장안 |
| DECISION5 | 짧은 출력 | 명령마다 기본 출력을 새로 설계한다(판정 줄과 `--full`). 읽는 쪽을 「출력」 절에 목록으로 적는다 | 사용자 2026-11-04 | 권장안(판정 줄 계약 유지)이 아니다 |
| DECISION6 | 폴더 구조 | 하위 명령 묶음과 같은 폴더(`scripts/<묶음>/`). 파일 이름은 그대로, lib 는 이번에 그대로 | 사용자 2026-11-04 | 권장안 |
| DECISION7 | 옛 진입점이 다른 범위 번들로 넘어가는 문제 | 새 진입점은 다른 범위로 넘어가지 않고 실패한다. doctor 가 옛 번들로 도는 루프와 대기, 옛 경로를 알린다 | 사용자 2026-11-04 | 권장안 |
| DECISION8 | PR 나누기 | DECISION14 로 바뀌었다(PR1 명령 → PR2 출력 → PR3 폴더) | 사용자 2026-11-04 | 처음 답은 PR1 명령, PR2 폴더였다 |
| DECISION9 | 이번 범위 | 짧은 명령, 문맥 기본값, 옛 진입점 범위 문제, 문서 호출 정리, 기능별 폴더. lib 두 층, orch-loop 모듈화, Orca 상태 파일 대체는 뒤로 | 사용자 2026-11-04 | 1라운드 답 |
| DECISION10 | 쓰는 사람 | 에이전트가 주로 쓰고 사람도 상태 확인(루프, worker, 보드)은 직접 친다. 출력은 짧은 판정 줄이 기본, `--help` 는 사람이 읽을 수 있게 | 사용자 2026-11-04 | 1라운드 답 |
| DECISION11 | 옛 꼴로 부를 때의 출력 | 새 짧은 출력을 낸다. 옛 출력을 읽는 곳을 「출력」 절에 적고, 이 저장소 안은 그 PR 에서 고치고 저장소 밖은 doctor 가 알린다. 스크립트끼리 경로로 부르는 자리는 그대로다 | 사용자 2026-11-04 | 권장안(옛 출력 유지)이 아니다 |
| DECISION12 | 명령 표 | 「명령 표」 대로 하고 사람용 요약 `orch status` 를 더한다. `orch status` 는 PR2 에 넣는다 | 사용자 2026-11-04 | 권장안이 아니다. PR 자리는 작성자가 정했다: 판정 줄을 모아 보이는 일이라 짧은 출력을 설계하는 PR2 와 함께 해야 줄 꼴이 맞는다 |
| DECISION13 | 옛 이름을 끝내는 때 | 옛 이름을 지우는 PR 을 따로 둔다. doctor 가 옛 꼴을 찾지 못한 뒤 열고, 그 PR 의 `- 호환성:` 줄로 메이저를 올린다 | 사용자 2026-11-04 | 권장안. 메이저는 아무 스킬의 호환성 줄로도 오른다([ADR-019](../../adr/019-plugin-version-auto-bump.md)) |
| DECISION14 | PR 나누기 | PR1 명령(새 꼴, 문맥, PATH, 범위 규칙, 훅, `NEXT_WAIT` 줄이기, 문서 호출) → PR2 명령마다 짧은 출력과 `--full`, `orch status` → PR3 폴더 이동. PR1 동안 새 꼴은 지금 출력을 낸다 | 사용자 2026-11-04 | 권장안 |
| DECISION15 | `~/.local/bin/orch` 설치 방식 | doctor 는 `CLI-MISSING` 과 `orch doctor install-cli` 명령을 알리기만 하고 설치는 그 명령이 한다. 다른 `orch` 가 있으면 덮지 않는다 | 사용자 2026-11-04 | 권장안 |
| DECISION17 | 폴더 이동 때 경로로 직접 부르는 곳 | 옛 경로에 사본을 두지 않고 옮긴다. doctor 가 직접 경로 호출을 알린다. 알려진 저장소(부록)는 코디네이터가 PR3 머지 전에 worker 로 고치고, 그 고침이 끝난 것이 PR3 머지 조건이다 | 사용자 2026-11-04 | 권장안(옛 경로에 사본)이 아니다 |
| DECISION18 | 문맥 기본값을 쓰는 명령 | 「명령 표」 에서 `--repo`, `--run`, `--specs-dir`, `--loop-repo` 를 받는 모든 새 꼴 명령. `orch loop stop` 은 문맥의 Run 하나만 빼고, 모두 멈추려면 `--all` 을 준다. 예외는 DECISION23 이다 | 작성자 | DECISION2 를 명령마다 적용한 것이다. 옛 꼴은 지금처럼 문맥을 읽지 않는다. 자기 Run 만 빼는 것은 다른 세션의 루프를 끊지 않는 지금 규칙과 같다 |
| DECISION19 | `NEXT_WAIT` 에 남기는 인자 | `--run` 은 빼고(코디네이터 터미널에 묶인 Run 이라 다시 걸어도 같다), `--loop-repo` 는 절대경로로 늘 적는다. 다시 걸 때의 작업 폴더가 지워진 워크트리일 수 있다(`references/waiting.md` 「wait-important 는 시작하면 작업 폴더를 옮긴다」). `orch` 가 PATH 에 없으면 진입점 절대경로로 낸다 | 작성자 | 다시 건 대기가 다른 저장소를 보지 않게 하고, PATH 가 없는 Codex 코디네이터에서도 그대로 돈다 |
| DECISION20 | 판정 줄이 아닌 결과를 내는 명령 | 경로나 데이터가 결과인 명령(`orch paths`, `orch worker worktree`, `orch spec line`, `orch study list`)과 감싼 명령의 출력(`orch slot heavy`, `orch slot mem`)은 결과를 그대로 낸다. 설명 줄만 뺀다. `--json` 의 출력은 바꾸지 않는다 | 작성자 | 셸이 `$(orch paths specs)` 로 받고 worker 가 감싼 검사의 실패 출력을 읽는다. 판정 낱말을 붙이면 그 쓰임이 깨진다 |
| DECISION21 | `orch wait` 의 짧은 출력 | 대기가 분류까지 한다. 메시지마다 판정 줄을 triage 와 같은 차례(의심스러운 worker_done, worker_done, 멈춘 worker, escalation, question)로 내고 `LAST_DELIVERY`, `NEXT_WAIT` 로 끝낸다. 원문 JSON 은 `--full` 이나 저장한 파일 경로로 본다 | 사용자 2026-11-04 | 권장안 |
| DECISION22 | Run 문맥 없는 `orch status` | 작업 폴더 저장소의 루프에 등록된 Run 을 모두 요약한다. Run 을 주면 그 Run 만 본다 | 사용자 2026-11-04 | 권장안 |
| DECISION23 | Run 을 문맥으로 채우지 않는 명령 | `orch doctor` 와 `orch loop stalled` 는 Run 을 문맥으로 채우지 않고 지금처럼 동작한다. Run 을 보려면 `--run` 을 준다 | 사용자 2026-11-04 | 권장안. 스킬 첫 점검이 `--run` 없이 doctor 를 불러 Run 별 점검과 `session-resume` 을 하지 않고, `loop stalled` 는 등록된 Run 을 모두 본다. 계획 검토가 DECISION18 과의 어긋남을 찾았다 |
| DECISION16 | 스크립트끼리 부를 때의 출력 | 지금 출력 그대로. 스크립트는 다른 스크립트 파일을 경로로 직접 실행해 `orch` 진입점을 거치지 않는다. 짧은 출력은 진입점이 새 꼴로 부를 때만 켠다 | 작성자 | 읽는 쪽 코드와 테스트를 고치지 않고 판정을 지킨다. 내부 이름과 배치의 선택이다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 스크립트의 판정 규칙은 바꾸지 않는다.

## 부록: 알려진 저장소의 직접 경로 호출

실측 2026-11-04(두 번째, technical-design 때 디스크의 파일을 다시 읽었다). `.orch/` 가 있는 저장소의 `.orch/overlay.md`, `.orch/config.json`, `.orch/bin`, `.orch/hooks`, `.orch/specs/spec-common.md`, `.claude/skills` 에서 orch 스크립트를 파일 경로로 부르는 곳이다. `installPath` 는 설치 기록의 번들 경로다. 「4.x 경로」 는 `installPath/skills/orch/...` 라 지금은 돈다는 뜻이고, 「옛 경로」 는 `installPath/orch/...` 라 4.0 이후 깨져 있다는 뜻이다. PR3 머지 전에 이 표를 다시 찾아 갱신하고, 모든 행이 새 꼴로 고쳐진 것을 PR3 머지 조건으로 본다(DECISION17).

| 저장소 | 파일 | 부르는 경로 | 지금 상태 |
| --- | --- | --- | --- |
| ai-analysis | `.orch/specs/spec-common.md` | `installPath/orch/scripts` 의 `worker-ask.ts`, `study-candidates.ts`, `reserve-migration.ts` | 옛 경로 |
| ai-analysis | `.orch/bin/release.sh`, `.claude/skills/release/scripts/release.py` | `skills/orch/scripts/board-release.ts` 와 `orch/scripts/board-release.ts` 를 차례로 찾는다 | 4.x 경로 |
| AiSdtSkill | `.orch/specs/spec-common.md` | `installPath/skills/orch/scripts/worker-ask.ts` | 4.x 경로 |
| dooray-cli | `.orch/specs/spec-common.md` | `installPath/orch/scripts/worker-ask.ts` | 옛 경로 |
| fos-accountbook | `.orch/specs/spec-common.md` | `installPath/orch/scripts` 의 `worker-ask.ts`, `heavy-slot.ts` | 옛 경로 |
| fos-agents, fos-blog | `.orch/specs/spec-common.md` | `installPath/skills/orch/scripts` 의 `worker-ask.ts`, `heavy-slot.ts` | 4.x 경로 |
| fos-assistant | `.orch/specs/spec-common.md` | `installPath/skills/orch/scripts/worker-ask.ts`. 18줄의 무거운 검사 블록은 `installPath/orch/bin/orch.ts heavy-slot` | 18줄은 옛 경로, 나머지는 4.x 경로 |
| fos-graphrag, fos-home-infra, gersang-lab, spring-next-starter | `.orch/specs/spec-common.md` | `installPath/skills/orch/scripts/worker-ask.ts` | 4.x 경로 |
| nhncloud-cli | `.orch/specs/spec-common.md` | 옛 캐시 경로 `cache/fos-skills/fos-skills/88daf0fe2fe7/orch/scripts/worker-ask.ts` 를 직접 적었다 | 옛 경로 |
| fos-assistant, fos-graphrag, fos-home-infra | `.orch/hooks/after-cleanup.ts` | `installPath/orch/scripts/handoff-cleanup.ts` 와 `installPath/skills/orch/scripts/handoff-cleanup.ts` | 4.x 경로 |
| gersang-lab | `.orch/overlay.md` | `$SKILL_DIR/scripts/merge-with-finish.ts`, `$SKILL_DIR/scripts/remove-worktree.ts` | 4.x 경로 |
| gersang-lab | `.orch/bin/orch.mts`(진입점 사본), `.orch/bin/with-heavy-slot.sh` | `installPath/skills/orch/scripts/<이름>.ts` | 4.x 경로. PR3 의 폴더 이동 뒤에는 이 사본이 새 경로를 모른다. `orch` 로 바꾸거나 플러그인 루트의 실행기 `bin/orch` 를 복사한다(새 진입점은 lib 를 import 해 파일 하나로 돌지 않는다) |
| fos-skills | `.orch/specs/spec-common.md` | `installPath/skills/orch/scripts` 의 `worker-ask.ts`, `study-candidates.ts` | 4.x 경로. PR1 이 틀(`templates/spec-common.md`)을 새 꼴로 바꾼 뒤 사본도 맞춘다 |

모든 행은 PR3 머지 전에 새 꼴(`orch <묶음> <동작>`)로 고친다. 옛 경로 행은 지금도 깨져 있어 먼저 고칠 수 있다.
