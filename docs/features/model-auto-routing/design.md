# orch: 새 모델 감지와 같은 계열 자동 전환의 기술 설계 (PR 1)

> 시작 전 제공자 선택 순서는 [같은 등급 모델 교대 설계](../model-alternation/design.md)가 대신한다.

스펙: [spec.md](spec.md). 이 설계는 「PR 1. 새 모델 감지와 같은 계열 자동 전환」(REQ1~REQ6, REQ23)만 다룬다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 루프 부모가 틱이 끝날 때마다 `loop/model-watch.ts` 의 `watchModels` 를 부른다. 머신 폴더의 `model-watch.json` 의 `checked_at` 에서 24시간이 지났을 때만 `codex debug models` 를 읽고 목록을 저장한다. 첫 목록(목록에 보이는 모델, `FIRST_COMPARE` 의 `gpt-6.2-astra` 는 뺀다)을 기준점으로 두고, 그 뒤 나타난 현재 세대 모델을 `found` 에 넣는다. 저장소마다 아직 알리지 않은 `found` 모델을 그 저장소 보드에 decide 항목 「새 모델 <모델>」 로 더하고, `MODEL-NEW <모델> <설명>` 을 등록된 Run 에 보낸다 |
| REQ2 | `launch-worker` 의 차례 0-0-1 이 사용량 판정 뒤의 WORKER_ARGS 로 `codexGeneration` 을 부른다. 같은 계열의 더 높은 세대가 effort 를 지원하면 `--model` 을 바꾸고 `effective.generation` 에 남긴다. 지시서가 `후보 밖:` 으로 모델을 정했으면 바꾸지 않는다. 바꾸는 대상은 행의 값을 그대로 적은 지시서다. 모델 목록은 Orca 가 새 worker 에 쓸 Codex 계정(`orca account list --agent codex` 의 activeAccountId 홈)으로 읽는다. `worker relaunch` 의 사전 모델 검사도 같은 판정 뒤의 모델을 본다. 지시서 대조(`lib/selection.ts` 의 `sameWorker`)는 같은 계열이면 세대가 달라도 같은 worker 로 본다 |
| REQ3 | `watchModels` 가 저장된 목록으로 모델 표의 행마다 `staleRows`(`chooseGeneration` 기준)로 옛 세대를 찾는다. 표 문서는 이 저장소에 있으면 origin 기본 브랜치를 받아 읽고, 없으면 번들의 것을 읽는다. 행마다 `MODEL-TABLE-STALE <행> <옛> → <새>` 를 Run 에 한 번, 새 세대마다 보드 decide 항목 「모델 표를 <새> 로 바꿀 때」 를 한 번 남긴다. 루프는 표를 고치지 않고, 코디네이터가 작은 worker 로 PR 을 내 고친다(아래 결정 「표를 고치는 주체」) |
| REQ4 | `codexGeneration` 은 적힌 모델을 그 계정 목록이 받지 못하면(없거나 effort 미지원) 받을 수 있는 같은 계열 최신으로 그 띄우기만 바꾸고, 이유 `<모델> 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다` 를 남긴다. 판단은 띄우기마다 다시 한다 |
| REQ5 | `claudeGeneration` 이 `claude-<계열>-<세대>` 를 계열 이름(`fable`)으로 바꿔 넘긴다. 띄운 뒤 그 워크트리의 Claude 세션 가운데 띄우기 뒤에 시작한(첫 `timestamp` 가 시작 시각 뒤인) 세션 하나의 첫 응답 모델 ID 를 읽어(`lib/session-tokens.ts` 의 `claudeModelOf`) 띄우기 기록의 `model` 과 `effective.modelId` 에 남긴다. 그런 세션이 없거나 둘 이상이면 모르는 것으로 둔다. 실측 기록(`lib/routing-log.ts`)의 `effective.model` 에도 이 ID 를 넣어 보고서가 같은 계열의 다른 모델을 나눠 집계하고 단가를 찾는다 |
| REQ6 | `doctor/codex-version.ts` 가 `codex` 명령(CODEX_BIN 또는 PATH)을 찾고, 있으면 `codex --version` 과 GitHub 최신 릴리스의 `tag_name` 을 비교해 `CODEX-OUTDATED <설치> <최신>` 과 `  codex update` 를 낸다. codex 가 없거나 둘 중 하나를 읽지 못하면 줄이 없다 |
| REQ23 | 지시서가 `후보 밖:` 으로 Codex 모델을 직접 골랐으면 `pinnedCheck` 가 판정한다. worker 계정 목록에 같은 계열의 그 effort 를 지원하는 새 세대가 있으면 `MODEL-OUTDATED <옛> → <새>` 와 「지시서를 새 세대로 고친다」 로 launch 는 4, relaunch 는 abandon 전에 `RELAUNCH-REFUSED` 다. 목록 조회가 실패해도 감지 기록(`model-watch.json` 의 `models`)이 그런 새 세대를 알면 같게 거절하고, 모르면 `MODEL-CHECK-SKIP` 경고를 낸다. 새 세대를 알지만 그 계정이 받지 못하거나 effort 를 지원하지 않을 때만 옛 세대로 띄우고 `effective.generation`(from 과 to 가 같다)에 이유를 남긴다. 사용량 전환은 `후보 밖` 지시서를 바꾸지 않으므로 대상이 아니다 |

## 책임과 경계

- **`lib/model-generation.ts`(새 파일)**: 이름의 계열과 세대 읽기, 세대 비교, `codex debug models` 읽기와 캐시, 띄울 세대 판정, 표 문서의 바꿀 모델과 다시 쓰기를 소유한다. `lib/model-check.ts` 는 이 파일의 목록을 쓴다.
- **`lib/usage-boost.ts`**: 「사용 한도에 걸렸을 때」 표 읽기를 `limitRows`, `limitRowOf` 로 내놓는다. 같은 계열이면 세대가 달라도 그 줄을 찾는다. 시작 전 모델 검사의 대체 후보 안내도 이 줄의 「같은 등급 대응」 칸을 쓴다. 코드에 박힌 `previousSol`, `otherProvider` 는 지웠다.
- **`worker/launch-worker.ts`**: 차례는 선택 검사(0) → 사용량 판정(0-0) → 세대 판정과 직접 고른 옛 세대 거절(0-0-1) → 모델 검사(0-1)다. 이 차례는 `decideSettings` 하나가 소유하고, `worker/relaunch-worker.ts` 가 옛 worker 를 abandon 하기 전에 같은 함수를 부른다. 원격 환경 옵션(`--on`, `--environment`, `--pairing-code`)이면 이 머신의 Codex 목록으로 세대를 바꾸지 않고 0-1 도 하지 않는다. 원격의 직접 고른 옛 세대는 감지 기록만으로 판정한다. 사용량 판정이 Codex 행을 Claude 로 바꾸면 그 Claude 가 세대 판정을 받는다. 사용량 판정은 지시서의 선택을 보므로 세대 판정과 겹치지 않는다.
- **`loop/model-watch.ts`(새 파일)**: 하루 한 번 감지, 기준점, 알림, 보드 항목, 낡은 표 행 알림을 소유한다. 표를 고치거나 PR 을 열지 않는다. 틱 자식이 아니라 루프 부모가 부른다. 플러그인 자동 갱신과 같은 자리라 `--once` 테스트와 틱 테스트가 실제 codex 를 부르지 않는다.
- **`doctor/codex-version.ts`(새 파일)**: 낡은 Codex CLI 판정만 한다. 갱신하지 않는다.
- **`lib/review-spec.ts`**: 리뷰 worker 의 Codex 모델을 모델 표의 review 행에서 읽는다. 표를 고치는 PR 이 머지되면 리뷰 지시서도 따라간다.

## Claude 계열 이름의 근거

Claude Code 2.1.329 에서 2026-11-20 에 `claude -p --model <계열> --output-format json` 을 돌려 응답의 `modelUsage` 키를 봤다.

| 넘긴 이름 | 실제 모델 |
| --- | --- |
| `fable` | `claude-fable-5-2` |
| `opus` | `claude-opus-5-5` |
| `sonnet` | `claude-sonnet-5-5` |
| `haiku` | `claude-haiku-5-5` |

모두 그 계열의 최신 모델이다. 그래서 launch 는 계열 이름을 넘기고, 최신을 고르는 일은 Claude Code 에 맡긴다.
띄울 때 따로 모델을 물어 확인하지 않는다. 같은 확인을 `--bare` 없이 돌리면 한 번에 약 $0.74 어치 사용량이 들었고, `--bare` 는 키체인을 읽지 않아 로그인되지 않았다.
대신 worker 의 세션 기록(`projects/<워크트리>/*.jsonl`)의 첫 assistant 줄의 `message.model` 을 읽는다. `LAUNCH_MODEL_WAIT`(기본 60초)까지 기다리고, 못 읽으면 `effective.modelId` 는 null, 기록의 `model` 은 표의 모델 ID 다. 가격 집계가 모델 ID 로 단가를 찾아서다.

## 기준점

스펙은 첫 실행의 목록을 기준점으로 두되 오늘 나온 `gpt-6.2-astra` 를 첫 새 모델로 정했다(DECISION15). 목록만으로는 「오늘 나온 모델」 을 알 수 없어 `FIRST_COMPARE` 상수에 그 모델을 적었다. 기준점이 한 번 생기면 이 상수는 쓰이지 않는다.
`gpt-6.2-sol` 은 기준점에 든다. 같은 계열의 새 세대는 REQ2, REQ3 이 기준점과 상관없이 표와 목록을 비교해 다룬다.

## 실패와 일관성

- 띄우기: 목록을 읽지 못하면 세대를 바꾸지 않는다. 그때는 차례 0-1 이 지금처럼 경고만 낸다.
- 감지: codex 가 없거나 실패해도 `checked_at` 을 쓰고 다음 날 다시 본다. 알림은 기록을 쓴 뒤 보낸다. 보내다 죽어도 같은 모델을 다시 알리지 않는다. 보드에 쓰지 못하면 `MODEL-BOARD-FAIL` 로 알리고, 다음에 목록을 읽을 때 보드 쓰기만 같은 항목 ID 로 다시 한다(Run 알림은 다시 보내지 않는다).
- 낡은 목록: 새로 읽은 목록에서 어느 계열의 최신 세대가 이미 본 세대(저장된 목록의 현재 세대, 기준점, `found`)보다 낮으면(현재 세대끼리 비교) `models` 를 덮지 않고 `MODEL-LIST-OLDER <이유>` 를 한 번 알린다. `checked_at` 은 쓰고 다음 날 다시 읽는다. Codex CLI 는 서버 목록을 받지 못하면 실행 파일에 든 기본 목록을 내고, 2026-11-22 감지 기록이 그 목록으로 덮였다([verification.md](verification.md) 「관찰 1」). 목록에서 사라진 계열은 보지 않는다.
- 감지의 동시 실행: 여러 저장소의 루프가 같은 머신 파일을 쓴다. 파일 옆 잠금(`modules/file-lock.ts`) 안에서 읽고 쓴다.
- 낡은 표 행: 같은 행과 같은 바꿈은 저장소마다 한 번만 알린다. 보드 쓰기에 실패하면 `MODEL-BOARD-FAIL` 이고 다음에 목록을 읽을 때 다시 한다. 보드 파일이 없어 건너뛴 항목은 기록하지 않아, 보드를 나중에 만든 저장소도 다음에 목록을 읽을 때 항목을 받는다. 표 문서를 읽기 전에 origin 기본 브랜치를 refspec 으로 받는다(`+refs/heads/<기본>:refs/remotes/origin/<기본>`). 받지 않으면 다른 체크아웃이 올린 옛 세대 행을 놓치고, refspec 이 없으면 작업 브랜치만 받은 체크아웃에 `origin/<기본>` 이 생기지 않는다.
- 낡은 표 행은 「## 모델」 절의 표 줄만 본다. 한도 표와 산문의 모델은 표를 고치는 worker 가 함께 고친다.
- doctor: 최신 버전 조회는 5초 안에 끝나지 않으면 줄을 내지 않는다. 읽은 값은 12시간 머신 폴더에 둔다.

## 다음 PR 과의 경계

PR 2(여러 계정의 사용량)는 하지 않는다(스펙 DECISION31). PR 3(비교)는 코드를 더하지 않는다(스펙 DECISION32). 코디네이터가 보드의 「새 모델 <모델>」 항목을 보고 [model-compare.md](../../../skills/orch/references/model-compare.md) 의 절차대로 비교한다. 두 비교 worker 는 `후보 밖:` 줄로 모델을 정하므로 세대 판정과 사용량 판정이 바꾸지 않는다. 지금 세대를 고르므로 REQ23 의 거절 대상도 아니다.

## 검증 전략

- `tests/lib-model-generation.spec.ts`: 이름 읽기, 세대 비교, 현재 세대, 띄울 세대(새 세대, 옛 세대로 내림, 바꾸지 않음), Claude 계열 이름, 실제 표의 바꿀 모델과 다시 쓰기, 자리의 effort, worker 계정 홈, 한도 표의 대체 후보.
- `tests/model-watch.spec.ts`: 가짜 codex 로 기준점, 하루 한 번, 한 번만 알림, codex 없음, 보드 항목, 저장소마다의 알림, 번들 표와 저장소 표의 `MODEL-TABLE-STALE`, 보드 항목, 다른 체크아웃이 기본 브랜치에 더한 행, 낡은 목록으로 덮지 않기(`olderList`).
- `tests/codex-version.spec.ts`: 가짜 codex 와 `file:` 주소로 낡음, 최신, codex 없음, 읽기 실패.
- `tests/launch-worker.spec.ts` 「모델 세대」: 가짜 orca 와 가짜 codex 로 `worker-start` 인자, `LAUNCH-EFFECTIVE`, 띄우기 기록, 가짜 Claude 세션 기록으로 `modelId`, 직접 고른 옛 세대의 거절과 예외, 조회 실패와 감지 기록, 원격 worker.
- `tests/relaunch-worker.spec.ts`: 직접 고른 옛 세대 거절, 세대 판정 뒤 모델 검사, 사용량 판정이 먼저인 차례.
- `tests/session-model.spec.ts`: 띄우기 뒤 시작한 세션만 읽기, 옛 세션의 늦은 갱신, 후보가 둘일 때.

## 결정

| 결정 | 고른 안 | 이유 |
| --- | --- | --- |
| 「보드에 알린다」 의 자리 | 그 저장소 보드의 decide 항목 「새 모델 <모델>」 과 Run 메시지 `MODEL-NEW` | 보드는 Run 의 status 메시지를 읽지 않는다(`extensions/work-board/hooks/register.js` 는 question, escalation 만 읽는다). 보드 파일이 없는 저장소는 Run 메시지만 간다 |
| 감지 주기의 기록 자리 | 머신 폴더 하나. 목록 읽기는 머신에 한 번, 알림과 표는 저장소마다 | Codex CLI 와 계정이 머신에 하나라 목록은 한 번만 읽는다. 알림은 저장소의 일이라, 먼저 돈 루프가 다른 저장소의 일을 막지 않게 한다 |
| 낡은 표 행을 알리는 저장소 | 루프가 도는 저장소마다 그 저장소의 표(없으면 번들 표)로 | 표를 고치는 일은 코디네이터가 맡아, 어느 저장소의 루프가 먼저 알아도 된다 |
| Claude 모델 ID 확인 | 세션 기록 읽기 | 별도 호출은 사용량이 들고 띄우기마다 수 초가 늘어난다 |
| 낡은 CLI 의 최신 출처 | GitHub 최신 릴리스 | Codex CLI 의 자체 갱신 확인이 같은 곳을 본다. `~/.codex/version.json` 은 시작 때 갱신 확인을 꺼 두어 2026-09 값에 멈춰 있었다 |
| 사람이 고른 모델 | `후보 밖:` 이 있으면 세대를 바꾸지 않는다. 고른 Codex 모델이 낡았으면 거절한다(DECISION30) | 조용히 바꾸면 고른 사람이 모르고, 그대로 두면 낡은 모델로 8건이 뜬 일이 되풀이된다. PR 3 의 비교 worker 도 `후보 밖:` 으로 지금 세대를 고르므로 이 규칙을 그대로 받는다 |
| 모델 목록의 계정 | Orca 가 새 worker 에 쓸 Codex 계정. system 이면 Codex 기본 홈(`~/.codex`), 계정 조회가 실패하면 목록을 읽지 못한 것으로 본다. 원격 worker 는 이 머신의 목록을 쓰지 않는다 | 부른 셸이나 이 머신의 계정과 worker 의 계정이 다르면 받지 못하는 모델을 넘기거나 새 세대를 놓친다. 원격 서버의 목록을 읽는 길은 아직 없어, 바꾸지도 거절하지도 않는 쪽이 안전하다 |
| 조회 실패와 직접 고른 옛 세대 | 감지 기록이 새 세대를 알면 거절 | 조회 장애 중에 낡은 모델로 띄우는 일을 막는다. 감지 기록도 모르면 근거가 없어 경고만 낸다 |
| 「계열의 지금 세대」 | `chooseGeneration` 하나가 띄우기, 직접 고른 옛 세대 판정, 낡은 표 행 알림에서 함께 쓴다. 현재 세대(Legacy, Previous generation 이 아닌 것) 가운데 그 effort 를 지원하는 가장 높은 세대로만 올린다 | 알림과 띄우기가 서로 다른 세대를 고르면 알림대로 표를 고쳐도 표와 실제가 다르다. 현재 세대가 그 effort 를 지원하지 않으면 바꾸지 않고 `effective.generation`(from 과 to 가 같다)에 이유를 남긴다 |
| 표를 고치는 주체 | 코디네이터가 작은 worker 로 PR 을 낸다(사용자 2026-11-20, 자동 PR 을 바꿈) | 561·565 리뷰에서 자동 PR 경로의 경계 상황(계정마다 다른 목록, 로그인 끊긴 계정의 번들 목록, 열린 PR 과 main 의 새 행, 머지와 닫힘, 사람이 손본 브랜치)이 6건 나왔다. 실제 띄우는 모델은 launch 가 계정마다 고르므로 표는 늦게 고쳐져도 띄우기에 영향이 없다 |
| 대체 후보 안내 | 한도 표 칸을 그대로 | 코드에 모델 이름을 박으면 표를 바꿀 때마다 코드도 고쳐야 한다(스펙 model-table-6-2 REQ3) |
