# orch: 새 모델 감지와 같은 계열 자동 전환의 기술 설계 (PR 1)

스펙: [spec.md](spec.md). 이 설계는 「PR 1. 새 모델 감지와 같은 계열 자동 전환」(REQ1~REQ6)만 다룬다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 루프 부모가 틱이 끝날 때마다 `loop/model-watch.ts` 의 `watchModels` 를 부른다. 머신 폴더의 `model-watch.json` 의 `checked_at` 에서 24시간이 지났을 때만 `codex debug models` 를 읽는다. 첫 목록(목록에 보이는 모델, `FIRST_COMPARE` 의 `gpt-6.2-astra` 는 뺀다)을 기준점으로 두고, 기준점과 `announced` 에 없는 현재 세대 모델마다 `MODEL-NEW <모델> <설명>` 을 등록된 Run 에 보낸다 |
| REQ2 | `launch-worker` 의 차례 0-0-1 이 사용량 판정 뒤의 WORKER_ARGS 로 `codexGeneration` 을 부른다. 같은 계열의 더 높은 세대가 effort 를 지원하면 `--model` 을 바꾸고 `effective.generation` 에 남긴다. 지시서 대조(`lib/selection.ts` 의 `sameWorker`)는 같은 계열이면 세대가 달라도 같은 worker 로 본다 |
| REQ3 | `watchModels` 가 모델 표의 Codex 모델과 목록을 `tableUpgrades` 로 비교한다. 이 저장소에 `skills/orch/references/agent-selection.md` 가 있으면 `openTablePr` 가 임시 워크트리에서 표와 변경 조각을 고쳐 PR 을 열고 `MODEL-TABLE-PR` 을 보낸다. 없으면 `MODEL-GENERATION` 만 보낸다. 이 PR 은 같은 바꿈을 손으로 한 결과(`gpt-6.1-sol` → `gpt-6.2-sol`)를 담는다 |
| REQ4 | `codexGeneration` 은 적힌 모델을 그 계정 목록이 받지 못하면(없거나 effort 미지원) 받을 수 있는 같은 계열 최신으로 그 띄우기만 바꾸고, 이유 `<모델> 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다` 를 남긴다. 판단은 띄우기마다 다시 한다 |
| REQ5 | `claudeGeneration` 이 `claude-<계열>-<세대>` 를 계열 이름(`fable`)으로 바꿔 넘긴다. 띄운 뒤 worker 의 Claude 세션 기록에서 첫 응답의 모델 ID 를 읽어(`lib/session-tokens.ts` 의 `claudeModelOf`) 띄우기 기록의 `model` 과 `effective.modelId` 에 남긴다 |
| REQ6 | `doctor/codex-version.ts` 가 `codex` 명령(CODEX_BIN 또는 PATH)을 찾고, 있으면 `codex --version` 과 GitHub 최신 릴리스의 `tag_name` 을 비교해 `CODEX-OUTDATED <설치> <최신>` 과 `  codex update` 를 낸다. codex 가 없거나 둘 중 하나를 읽지 못하면 줄이 없다 |

## 책임과 경계

- **`lib/model-generation.ts`(새 파일)**: 이름의 계열과 세대 읽기, 세대 비교, `codex debug models` 읽기와 캐시, 띄울 세대 판정, 표 문서의 바꿀 모델과 다시 쓰기를 소유한다. `lib/model-check.ts` 는 이 파일의 목록을 쓴다.
- **`lib/usage-boost.ts`**: 「사용 한도에 걸렸을 때」 표 읽기를 `limitRows`, `limitRowOf` 로 내놓는다. 같은 계열이면 세대가 달라도 그 줄을 찾는다. 시작 전 모델 검사의 대체 후보 안내도 이 줄의 「같은 등급 대응」 칸을 쓴다. 코드에 박힌 `previousSol`, `otherProvider` 는 지웠다.
- **`worker/launch-worker.ts`**: 차례는 선택 검사(0) → 사용량 판정(0-0) → 세대 판정(0-0-1) → 모델 검사(0-1)다. 사용량 판정이 Codex 행을 Claude 로 바꾸면 그 Claude 가 세대 판정을 받는다. 사용량 판정은 지시서의 선택을 보므로 세대 판정과 겹치지 않는다.
- **`loop/model-watch.ts`(새 파일)**: 하루 한 번 감지, 기준점, 알림, 표 PR 을 소유한다. 틱 자식이 아니라 루프 부모가 부른다. 플러그인 자동 갱신과 같은 자리라 `--once` 테스트와 틱 테스트가 실제 codex 를 부르지 않는다.
- **`doctor/codex-version.ts`(새 파일)**: 낡은 Codex CLI 판정만 한다. 갱신하지 않는다.
- **`lib/review-spec.ts`**: 리뷰 worker 의 Codex 모델을 모델 표의 review 행에서 읽는다. 표 PR 이 머지되면 리뷰 지시서도 따라간다.

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
- 감지: codex 가 없거나 실패해도 `checked_at` 을 쓰고 다음 날 다시 본다. 알림은 기록을 쓴 뒤 보낸다. 보내다 죽어도 같은 모델을 다시 알리지 않는다.
- 감지의 동시 실행: 여러 저장소의 루프가 같은 머신 파일을 쓴다. 파일 옆 잠금(`extensions/work-board/bin/file-lock.ts`) 안에서 읽고 쓴다.
- 표 PR: `gh pr create` 가 실패하면 올린 브랜치를 지우고 기록하지 않는다. 다음 날 다시 연다. 원격에 같은 브랜치가 있으면 열지 않고 `MODEL-TABLE-FAIL` 로 알린다.
- 표 다시 쓰기는 「## 모델」 절과 「### 사용 한도에 걸렸을 때」 절의 표 줄만 바꾼다. 「기본 후보에서 뺀 모델」 의 `gpt-6-astra` 처럼 산문에 적힌 모델은 세대를 바꾸면 뜻이 바뀌어 건드리지 않는다.
- doctor: 최신 버전 조회는 5초 안에 끝나지 않으면 줄을 내지 않는다. 읽은 값은 12시간 머신 폴더에 둔다.

## 다음 PR 과의 경계

PR 2(여러 계정의 사용량)는 `launch-worker` 의 차례 0-0 을 넓힌다. 고른 짝(REQ9)의 모델은 그 뒤 차례 0-0-1 이 그 계열의 최신 세대로 바꾸므로, PR 2 는 짝 표에 계열만 적으면 된다. PR 3(비교)는 `model-watch.json` 의 `announced` 에 든 같은 계열이 아닌 새 모델(`MODEL-NEW`)을 비교 후보로 읽는다. 비교 worker 는 `후보 밖` 으로 모델을 고정하므로 세대 판정은 적힌 계열 안에서만 바꾼다. 비교 대상 모델을 바꾸지 않으려면 PR 3 이 세대 판정을 건너뛰는 표시를 더한다.

## 검증 전략

- `tests/lib-model-generation.spec.ts`: 이름 읽기, 세대 비교, 현재 세대, 띄울 세대(새 세대, 옛 세대로 내림, 바꾸지 않음), Claude 계열 이름, 실제 표의 바꿀 모델과 다시 쓰기, 한도 표의 대체 후보.
- `tests/model-watch.spec.ts`: 가짜 codex 로 기준점, 하루 한 번, 한 번만 알림, codex 없음, 번들 표의 `MODEL-GENERATION`, 임시 origin 과 가짜 gh 로 표 PR 과 실패.
- `tests/codex-version.spec.ts`: 가짜 codex 와 `file:` 주소로 낡음, 최신, codex 없음, 읽기 실패.
- `tests/launch-worker.spec.ts` 「모델 세대」: 가짜 orca 와 가짜 codex 로 `worker-start` 인자, `LAUNCH-EFFECTIVE`, 띄우기 기록, 가짜 Claude 세션 기록으로 `modelId`.

## 결정

| 결정 | 고른 안 | 이유 |
| --- | --- | --- |
| 「보드에 알린다」 의 자리 | 루프 알림(Run 메시지)의 `MODEL-NEW`, `MODEL-GENERATION`, `MODEL-TABLE-PR`, `MODEL-TABLE-FAIL` | 보드에 따로 적는 칸이 없고, 코디네이터가 Run 메시지로 깨어나 보드에 반영한다. 멈추는 기능은 PR 3 의 비교 시작에 붙인다 |
| 감지 주기의 기록 자리 | 머신 폴더 하나 | Codex CLI 와 계정이 머신에 하나라 저장소마다 같은 일을 하지 않는다 |
| 표 PR 을 여는 저장소 | 표 문서가 있는 저장소(fos-skills) | 표는 fos-skills 에 있고, 다른 저장소의 루프가 fos-skills 에 PR 을 열 권한과 체크아웃이 없다 |
| Claude 모델 ID 확인 | 세션 기록 읽기 | 별도 호출은 사용량이 들고 띄우기마다 수 초가 늘어난다 |
| 낡은 CLI 의 최신 출처 | GitHub 최신 릴리스 | Codex CLI 의 자체 갱신 확인이 같은 곳을 본다. `~/.codex/version.json` 은 시작 때 갱신 확인을 꺼 두어 2026-09 값에 멈춰 있었다 |
| 대체 후보 안내 | 한도 표 칸을 그대로 | 코드에 모델 이름을 박으면 표를 바꿀 때마다 코드도 고쳐야 한다(스펙 model-table-6-2 REQ3) |
