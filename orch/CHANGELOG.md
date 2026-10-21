# CHANGELOG: orch

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

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
gersang-lab 전용 `wait-important.sh` 를 일반화한 것이다.

- 새 `scripts/wait-important.py`: `--types`(기본 `worker_done,question,escalation,status`)가 든 묶음이 오면 ack 하지 않고 그 JSON 과 `LAST_DELIVERY <id>` 를 낸다. 그 밖의 묶음은 다음 호출의 `--ack` 로 넘기고 계속 기다린다. Run 은 `--run` 으로 받고, 전체 한도(`--timeout-ms`, 기본 7000000)가 지나면 `TIMEOUT LAST_DELIVERY <id>` 로 끝난다. 출력은 `triage-messages.py` 가 그대로 읽는다
- `hooks/block-background-wait.py` 가 `wait-important` 를 셸의 `&` 나 `nohup` 으로 띄우는 호출도 거부한다. 스크립트 이름만 있는 호출에는 `orchestration check` 가 없어 1.15.0 규칙에 걸리지 않았다
- `references/waiting.md` 의 대기 명령과 프로세스 찾기를 이 스크립트로 바꾸고, SKILL 4단계 통과 조건을 고쳤다
- 가짜 orca 로 heartbeat ack 뒤 worker_done 에서 멈춤, 네 종류 각각에서 멈춤, `--types`, 시간 한도와 남은 ack, orca 오류, triage 로 읽기, 사용법 오류를 테스트했다. hook 에는 거부할 두 꼴과 통과할 두 꼴을 더했다

## 1.21.0

`cleanup-sweep.py` 가 브랜치 없는 워크트리와 하위 에이전트 워크트리를 정리하지 못해 남던 두 경우를 다룬다.
gersang-lab 전용 `sweep-merged.sh` 의 두 부분을 일반화한 것이다.

- 저장소 밖 detached 워크트리: worker 가 기준선 비교로 임시 폴더에 만들고 남긴 것이다. 커밋 안 된 변경, 쓰는 프로세스, Orca 터미널이 없고 HEAD 가 원격 추적 브랜치에 있으면 `git worktree remove` 로 지운다. 저장소 폴더 안의 detached 워크트리는 그대로 둔다
- 목록을 읽기 전에 `git worktree prune` 을 돌린다. dry-run 은 `-n` 으로 지울 등록만 낸다
- 하위 에이전트 워크트리(`--agent-glob`, 기본 `agent-*`): 모든 Run 범위를 읽지 못하면 Orca 가 띄운 빈 셸 터미널을 「확인하지 못한 터미널」 로 보고 경로를 건너뛰었다. 그 경로를 쓰는 프로세스가 자식 없는 로그인 셸뿐이면 다른 Run 의 것으로 세지 않는다. 다른 Run 의 worker 로 확인된 터미널은 그대로 건너뛴다
- `references/cleanup.md` 의 「스크립트가 다루는 것」 에 두 경우를 더했다
- 지움, dry-run, 변경과 프로세스와 터미널과 원격에 없는 HEAD 로 남김, 저장소 안은 남김, prune, 빈 셸 닫기, 자식 있는 셸과 glob 밖은 남김, glob 옵션, 확인된 다른 Run 터미널은 남김을 테스트했다

## 1.20.0

draft PR 로 CI 를 미루는 저장소에서, 파일이 겹치는 PR 을 함께 ready 로 바꿔 CI 를 두 번 돌리던 일을 스크립트로 막는다.
gersang-lab 전용 `ci-ready.sh` 를 일반화한 것이다.

- 새 `scripts/ci-ready.py`: draft PR 을 `gh pr ready` 로 바꾼다. 같은 base 로 가는 열린 ready PR 과 바뀐 파일이 겹치거나 base 와 충돌하면 보류하고 이유를 낸다. 이번 실행에서 앞서 바꾼 PR 도 ready 로 센다. `mergeable` 이 `UNKNOWN` 이면 다시 묻고, 파일이 100 개 이상이면 목록이 잘렸을 수 있어 보류한다
- 저장소 이름과 경로를 박지 않고 `--repo` 의 origin 으로 찾는다
- `references/overlay.md` 에 「draft 로 CI 미루기」 행, `references/cleanup.md` 에 그 저장소의 절, 지시서 틀에 `{{DRAFT_PR_RULE}}` 줄을 더했다
- 가짜 gh 로 겹침 없음, ready PR 과 겹침, draft 나 다른 base 와의 겹침은 무시, 같은 실행 안의 겹침, dry-run, 충돌, `UNKNOWN` 재시도와 보류, 이미 ready 와 닫힌 PR, 파일 한도, 조회 실패, 사용법 오류를 테스트했다

## 1.19.0

같은 파일을 고친 PR 을 차례로 머지할 때, 합친 상태의 검사를 `verification.md` 의 손 절차로만 하던 것을 머지 큐 옵션으로 옮긴다.
gersang-lab 전용 `merge-ready.sh`, `merge-tested.sh` 를 일반화한 것이다.

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
