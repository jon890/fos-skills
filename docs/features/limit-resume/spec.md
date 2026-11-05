# orch: 사용 한도로 멈춘 worker 를 resume 으로 다시 띄운다

## 목표

사용자가 한도에 걸린 계정을 다른 계정으로 바꾼 뒤, 코디네이터가 명령 하나로 멈춘 worker 를 `claude --resume <세션 id>` 나 `codex resume <세션 id>` 로 같은 워크트리에 다시 띄워 Task 에 잇는다. 새 worker 는 이전 대화를 그대로 이어 간다.

- 배경(2026-11-04): 계정 사용 한도로 worker 셋이 멈췄다. `adopt-sessions` 가 낸 `LIMITED` 줄의 명령(`worker-abandon`, `worker-start --task … --retry-of … --worktree path:…`)대로 띄우자 이전 세션을 잇지 않은 새 에이전트가 떴다. 새 worker 가 같은 조사와 판단을 다시 했다. 근거는 `.orch/feedback/coordinator-20261104-b.md` 3번이다.
- 사용자 운영(2026-11-05): Claude 계정 한도가 차면 사용자가 다른 계정으로 바꿔 작업을 이어 간다. 코디네이터는 그 뒤 확인하고 resume 으로 다시 띄운다.

## 조사한 사실

코드와 실측으로 답이 정해져 묻지 않은 것이다(2026-11-05).

| 대상 | 사실 | 근거 |
| --- | --- | --- |
| 지금 복구 명령 | `LIMITED` 는 `worker-abandon`, `worker-start --task --retry-of --worktree path:`, `terminal close` 를, `RESTART` 는 `--retry-of` 없는 `worker-start` 를 낸다. 둘 다 새 에이전트를 띄운다 | `skills/orch/scripts/lib/sessions.ts` 의 `limitedWorkers`, `restartable`, `startCommand` |
| Orca 의 이어받기 | `worker-start` 에 세션 이어받기 옵션이 없다. `--terminal <handle>` 은 이미 열린 터미널에 새 dispatch 를 넣고, `--agent`, `--model`, `--effort` 와 함께 쓰지 못한다 | `orca orchestration worker-start --help` |
| 터미널 만들기 | `orca terminal create --worktree path:<경로> --command <명령>` 으로 워크트리에 터미널을 열고 명령을 돌린다 | `orca terminal create --help` |
| Orca 의 Claude 실행 줄 | `claude --plugin-dir <orca>/claude-agent-view/<해시>/orca-agent-view --permission-mode auto --model <모델> --effort <effort>` | 실행 중인 worker 의 `ps` |
| Claude 세션 기록 | `<CLAUDE_CONFIG_DIR>/projects/<워크트리 실제 경로의 영숫자 밖 글자를 - 로 바꾼 이름>/<세션 id>.jsonl`. 기록 안에 dispatch 머리말의 dispatch id 가 남는다 | 이 worker 의 기록(dispatch id 8회) |
| 계정 전환과 기록 | 준비된 Claude 프로필 7개 가운데 5개는 `projects` 가 `~/.claude/projects` 로 링크돼 기록을 함께 본다. 다른 계정 프로필에서 `claude -p --resume <id>` 로 연 세션이 앞 대화를 이어 답했다 | 프로필 폴더 조사, 임시 세션 실측 |
| Codex 세션 기록 | `CODEX_HOME` 이 계정마다 `<orca>/codex-accounts/<id>/home` 이다. 그 아래 `state_5.sqlite` 의 `threads` 표가 세션 id, `cwd`, `rollout_path` 를 갖고 rollout 파일에 dispatch id 가 남는다 | 실행 중인 Codex worker 의 환경 변수와 그 계정 폴더 |
| Codex 이어 열기 | `codex resume <세션 id>` | `codex resume --help` |
| 한도 알림 | 상주 루프는 한도 화면을 `WORKER-LIMITED` 로 dispatch 마다 한 번 알리고 입력하지 않는다 | `skills/orch/scripts/orch-loop.ts`, `references/waiting.md` |

## 범위

이번 범위:

- 멈춘 worker 의 세션 id 를 찾아 같은 워크트리, 같은 제공자로 resume 해 띄우고 그 Task 에 잇는 코디네이터 명령.
- 대상은 `adopt-sessions` 가 내는 `LIMITED`(한도로 멈춤)와 `RESTART`(재부팅으로 끊김) worker 다.
- `adopt-sessions` 의 `LIMITED`, `RESTART` 안내 줄과 상주 루프의 `WORKER-LIMITED` 알림 문구, orch `references/launch.md`, `waiting.md`, `agent-selection.md` 의 복구 절차.

범위 밖:

- 세션 기록을 다른 프로필·계정 폴더로 복사, 이동, 링크하는 일. 새 터미널의 계정에서 기록이 보이지 않으면 실패로 알린다. Claude 는 `projects` 를 공유하는 프로필끼리면 계정을 바꿔도 보이고, Codex 는 계정을 바꾸면 보이지 않는다(DECISION14).
- 제공자를 바꿔 다시 띄우는 일과 지시서 「재개」 절 자동 작성. 지금처럼 코디네이터가 `references/launch.md` 「끊긴 worker 다시 띄우기」 로 한다.
- 터미널이 없는 구조화 worker 의 이어받기.
- 상주 루프가 스스로 이어받는 일.
- Orca 자체에 이어받기 옵션을 더하는 일.
- 스크립트 폴더 이동(orch-cli PR3). 이 기능의 PR 은 PR3 머지 뒤에 시작한다.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 코디네이터가 멈춘 dispatch 하나를 명령 하나로 resume 해 다시 띄운다 | 한도로 멈춘 Claude worker 의 dispatch 로 명령을 부르면, 같은 워크트리에 `claude --resume <그 세션 id>` 로 연 터미널이 생기고 같은 Task 의 새 dispatch 를 받는다. 새 worker 에게 앞 대화의 내용을 물으면 답한다. Codex worker 는 `codex resume <세션 id>` 로 같다 |
| REQ2 | 재부팅으로 끊긴 worker 도 같은 명령으로 다시 띄운다 | `RESTART` 대상 dispatch 로 부르면 화면 읽기와 정리를 건너뛰고(DECISION11) REQ1 과 같이 열린다 |
| REQ3 | 옛 터미널이 새 세션과 겹치지 않는다 | 세션 id 와 마지막 화면을 읽어 출력에 남긴 뒤 옛 dispatch 를 abandon 하고 옛 터미널을 닫고 나서 새 터미널을 연다. 같은 세션 기록에 두 프로세스가 동시에 붙지 않는다 |
| REQ4 | 실패를 숨기지 않는다 | 세션 기록을 찾지 못하거나(지금 프로필에서 보이지 않음 포함), 터미널 열기나 `worker-start --terminal` 이 실패하면 실패한 단계와 이유, 다음에 부를 명령을 내고 0 이 아닌 종료 코드로 끝난다. 자동으로 새 worker 를 띄우지 않고 다시 시도하지 않는다 |
| REQ5 | 안내가 새 명령을 가리킨다 | `adopt-sessions` 의 `LIMITED`, `RESTART` 판정 줄 아래 들여 쓴 줄이 새 명령 한 줄이다. 판정 줄 형식은 그대로다. 상주 루프의 `WORKER-LIMITED` 알림과 `agent-selection.md` 「사용 한도에 걸렸을 때」 가 DECISION13 의 순서(계정 전환 요청 뒤 resume, 안 되면 제공자·모델 변경)를 안내한다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 이어받는 범위 | 같은 제공자, 같은 워크트리에서 `claude --resume` / `codex resume` 만. 기록 옮기기, 제공자 변경, 재개 절 자동 작성은 하지 않는다 | 사용자 2026-11-05 | 「claude resume 이나 codex resume 만」. 계정은 사용자가 바꾼다 |
| DECISION2 | 옛 터미널을 닫는 시점 | 세션 id 와 마지막 화면을 확보한 뒤 먼저 닫고 이어 연다 | 사용자 2026-11-05 | 기록은 디스크에 남아 잃을 것이 없고 동시 쓰기를 구조로 막는다 |
| DECISION3 | 누가 시작하나 | 코디네이터 명령. 사용자가 계정을 바꾼 뒤 코디네이터가 확인하고 부른다 | 사용자 2026-11-05 | 계정 전환이 끝났는지 루프는 모른다 |
| DECISION4 | 실패 알림 | 멈추고 실패 단계, 이유, 다음 명령을 낸다. 자동 대체와 재시도는 없다 | 사용자 2026-11-05 | `worker-start` 실패 뒤에는 연결이 이미 일어났을 수 있다(`adopt-sessions.ts` 와 같은 원칙) |
| DECISION5 | `adopt-sessions` 의 `LIMITED`, `RESTART` 출력 | 들여 쓴 명령 줄을 새 명령 한 줄로 바꾼다. 판정 줄과 `--json` 의 다른 키는 그대로 둔다 | 사용자 2026-11-05 | 옛 명령이 남으면 11-04 처럼 새 에이전트를 띄운다 |
| DECISION6 | PR 단위와 순서 | PR 하나. orch-cli PR3 머지 뒤 시작 | 사용자 2026-11-05 | 제공자별 차이는 기록 위치와 실행 줄뿐이다 |
| DECISION7 | 세션 기록을 찾는 열쇠 | 지금 환경의 기록 폴더에서 그 워크트리의 기록 가운데 옛 dispatch id 가 든 것. 여럿이면 가장 최근 것 | 작성자 | 기록 안에 dispatch 머리말이 남는다(실측). 한 세션에 dispatch 여럿이 쌓일 수 있어 dispatch id 로 고른다 |
| DECISION8 | 다시 여는 실행 줄의 모델, effort, 권한 | 모델과 effort 는 옛 dispatch 의 `launch.effective` 값을 쓴다. 권한 모드와 Orca 인자(`--plugin-dir … orca-agent-view`, Codex 의 `-c` 와 승인 옵션)는 Orca 가 처음 띄울 때와 같게 둔다 | 작성자 | resume 은 같은 worker 를 잇는 것이라 지시서의 `worker 선택:` 을 바꾸지 않는다. 권한이 다르면 resume 한 worker 가 매번 승인을 묻는다 |
| DECISION9 | resume 한 세션이 받을 dispatch | 같은 Task 를 `worker-start --task <Task> --terminal <새 터미널>` 로 잇는다. Orca 가 넣는 머리말과 원래 지시서를 그대로 받는다 | 작성자 | `--spec` 은 새 Task 를 만들어 보드와 기록이 갈린다. 앞 대화가 남아 있어 worker 는 끝난 일을 기록에서 본다 |
| DECISION10 | 세션 기록을 찾는 환경 | 새 터미널이 실제로 쓸 계정의 기록 폴더. Claude 는 Orca 가 지금 고른 프로필(`selected-host`)의 `projects`, Codex 는 Orca 가 지금 고른 계정의 `CODEX_HOME` | 작성자 | 코디네이터 셸의 환경과 새 터미널의 계정이 다를 수 있다. 새 터미널이 열 수 있는 기록만 찾아야 「찾았는데 열리지 않음」 이 없다 |
| DECISION11 | 대상별로 하는 단계 | `LIMITED` 는 화면 읽기, abandon, 옛 터미널 닫기, 열기, 잇기를 모두 한다. `RESTART` 는 dispatch 가 이미 `failed` 이고 터미널이 없으므로 화면 읽기, abandon, 닫기를 건너뛰고 열기와 잇기만 한다 | 작성자 | `lib/sessions.ts` 의 `restartable` 은 터미널 없는 failed dispatch 만 고른다 |
| DECISION12 | 정리한 뒤 실패했을 때 낼 다음 명령 | 옛 dispatch 를 정리한 뒤 실패하면 다시 부를 수 있는 명령(같은 명령에 Task 와 세션 id 를 직접 주는 꼴)을 낸다. 터미널은 열렸는데 `worker-start --terminal` 만 실패하면 그 터미널을 닫지 않고 handle 을 출력에 남긴다 | 작성자 | 정리 뒤에는 `LIMITED`, `RESTART` 판정에 걸리지 않는다. 잇기 실패 뒤에는 연결이 이미 일어났을 수 있어 닫지 않는다(DECISION4) |
| DECISION13 | 한도 알림이 안내할 기본 대응 | 먼저 사용자에게 계정 전환을 요청하고, 바꾼 뒤 resume 명령을 부른다. 바꿀 계정이 없거나 resume 이 실패하면 지금처럼 같은 등급의 다른 제공자나 한 단계 아래 모델로 새로 띄우고 재개 절은 코디네이터가 쓴다 | 사용자 2026-11-05 | 사용자 운영(계정 전환 뒤 이어 가기)을 기본으로 두고, 계정이 모두 찼을 때는 지침의 한도 표가 길을 준다 |
| DECISION14 | Codex 계정을 바꾼 뒤의 이어받기 | 하지 않는다. 기록이 보이지 않아 실패로 알린다. Codex 이어받기는 같은 계정(재부팅, 한도가 풀린 뒤)에서만 된다 | 사용자 2026-11-05 | Codex 는 계정마다 `sessions` 폴더와 `state_5.sqlite` 가 따로다(계정 2개 확인). 기록 옮기기는 범위 밖이다(DECISION1) |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 의 복구 절차는 `skills/orch/references/launch.md` 가 소유하고, 여러 기능이 참조하는 도메인 규칙 문서가 없다.
