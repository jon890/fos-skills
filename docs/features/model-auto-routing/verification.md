# 새 모델 자동 반영 기능의 인수 검증 결과

> 이 문서는 당시 검증 기록이다. 현재 Fable과 astra 선택은 [같은 등급 모델 교대](../model-alternation/spec.md)가 대신한다.

- 판정: 완료(살아 있는 요구사항). 차단 결함은 없고, 경미한 결함 7건과 관찰 1건을 아래 「결함」 에 남겼다. 검증 PR 에서는 고치지 않았고, 뒤의 수정 PR 이 모두 고쳤다(아래 「후속 수정」).
- 스펙: [spec.md](spec.md), 기술 설계: [design.md](design.md). 계획서는 구현 PR 에서 지웠다.
- 대상 PR: #561(새 모델 감지, 같은 계열 자동 전환, 낡은 Codex CLI 알림, 직접 고른 옛 세대 거절), #565(낡은 표 행 알림), #583(PR 2 하지 않음), #585(비교 절차와 기록 틀), #587(이 검증), #588(검증이 남긴 결함 수정). 같은 날 astra 규칙을 바꾼 #566, #584 도 대조했다.
- 검증 커밋: `ff0e4e709d3a292d8d2ec1d5782ca72cc61835e6`(검증 시점 main)
- 환경: macOS, Node v24.22.1, Claude Code 2.1.330, codex-cli 0.166.0. 실제 worker 는 띄우지 않았고 Codex 계정과 Orca 설정은 바꾸지 않았다.
- 검증일: 2026-11-23

## 실행한 명령

| 명령 | 결과 |
| --- | --- |
| 관련 테스트 9개 파일(`lib-model-generation`, `model-watch`, `codex-version`, `launch-worker`, `launch-worker-functions`, `relaunch-worker`, `session-model`, `model-check`, `docs-contract`) | 통과 9, 실패 0 |
| `orch slot heavy --exclusive -- node scripts/run-tests.ts` | 통과 351, 실패 0 (675초) |
| `claude plugin test .` | 117 pass, 0 fail |
| 세대 판정 실측: 실제 `codex debug models` 목록과, 그 목록에 가상의 `gpt-6.3-sol` 을 더한 가짜 목록으로 `model-generation.ts` 의 함수를 직접 부름 | 아래 요구사항별 증거 |
| 직접 고른 옛 세대 실측: 가짜 codex 실행 파일(`CODEX_BIN`), 임시 계정 홈(`ORCH_WORKER_CODEX_HOME`), 이 머신의 감지 기록 사본으로 `pinnedCheck` 를 부름 | 아래 REQ23 |

## 요구사항별 증거

### PR 1. 새 모델 감지와 같은 계열 자동 전환

| 요구사항 | 사례·실행 명령 또는 절차 | 기대 결과 | 실제 결과·증거 위치 | 판정 |
| --- | --- | --- | --- | --- |
| REQ1 | `model-watch.spec.ts`, 이 머신의 `~/.cache/orch/model-watch.json`, 루프 로그 `.orch/state/loop.log`, 보드 | 기준점에 `gpt-6.2-astra` 가 빠지고, 첫 새 모델로 한 번 알린다 | 기준점에 `gpt-6.2-sol` 은 있고 `gpt-6.2-astra` 는 없다. `found` 는 `gpt-6.2-astra` 하나다. 루프 로그에 `MODEL-NEW gpt-6.2-astra ...` 가 한 번(2026-11-20 12:49Z 틱) 있다. 저장소 4곳의 `announced`, `boarded` 에 한 번씩 들었고, 이 저장소 보드에 `model-new-gpt-6-2-astra` 「새 모델 gpt-6.2-astra」 가 있다. 「한 번만」 은 저장소마다 한 번이다(설계 결정과 같다) | 통과 |
| REQ2 | 실제 목록으로 `codexGeneration('gpt-6.1-sol','medium')`, 가짜 목록으로 `codexGeneration('gpt-6.2-sol','medium')`. `launch-worker.spec.ts` 「모델 세대」 | 옛 세대를 같은 계열 최신으로 올리고 effort 는 그대로 | 실제 목록: `gpt-6.1-sol → gpt-6.2-sol`, `gpt-6.2-sol` 은 바꾸지 않음(null). 가짜 목록: `gpt-6.2-sol → gpt-6.3-sol`. 테스트가 `worker-start` 인자, `LAUNCH-EFFECTIVE`, 띄우기 기록의 `effective.generation` 을 본다 | 통과 |
| REQ3 | 실제 목록과 가짜 목록으로 지금 모델 표(`agent-selection.md`)에 `staleRows` | 지금 표는 낡은 행 없음, 새 세대가 있으면 그 행마다 | 실제 목록: `[]`. 표가 `gpt-6.2-sol` 이고 실제 최신과 같다. 가짜 목록: `impl-planned`, `impl-explore`, `small-fix`, `design`, `review` 다섯 행이 `gpt-6.2-sol → gpt-6.3-sol`. 감지 기록의 `tables` 는 비어 있어 이 머신에서 `MODEL-TABLE-STALE` 이 나간 적은 없다. 한 번만 알리기와 보드 항목은 `model-watch.spec.ts` 가 본다 | 통과 |
| REQ4 | `gpt-6.2-sol` 을 뺀 목록으로 `codexGeneration('gpt-6.2-sol','medium')` | 그 띄우기만 옛 세대, 이유를 남김 | `gpt-6.2-sol → gpt-6.1-sol`, 이유 「gpt-6.2-sol 를 이 계정이 받지 못해 이 띄우기만 옛 세대로 띄웠다」. 판정은 띄우기마다 하고 상태를 남기지 않는다 | 통과 |
| REQ5 | `claudeGeneration`, 이 머신의 띄우기 기록 `.orch/state/launched-workers/*.json`, `launch-history.jsonl` | 계열 이름으로 넘기고 실제 모델 ID 를 기록 | `claude-fable-5-2 → fable`, `claude-opus-5-5 → opus`. 실제 띄우기 기록 2건(이 검증 worker 포함)이 `effective.model: opus`, `modelId: claude-opus-5-5` 다. `launch-history.jsonl` 에 `modelId` 4건. 세션 기록을 못 읽으면 `modelId` 는 null 이고 `model` 은 표의 ID 다(설계대로) | 통과 |
| REQ6 | `orch doctor`, `codex --version`, `codex-version.spec.ts` | 낡았으면 `CODEX-OUTDATED <설치> <최신>` 과 갱신 방법, 최신 확인 실패면 줄 없음 | `CODEX-OUTDATED 0.166.0 0.171.0` 과 `  codex update` 가 나왔다. 최신 버전 캐시 `~/.cache/orch/codex-latest.json` 은 0.171.0. codex 없음, 읽기 실패에서 줄이 없는 것은 단위 테스트가 본다. doctor 종료 코드에 이 줄이 들어가지 않는다(`orch-doctor.ts`) | 통과 |
| REQ23 | 가짜 codex 로 `pinnedCheck('codex', <모델>, 'medium')` | 새 세대가 있으면 `MODEL-OUTDATED`, 목록 실패여도 감지 기록이 알면 거절 | 실제 목록, `gpt-6.1-sol`: `MODEL-OUTDATED gpt-6.1-sol → gpt-6.2-sol`. `gpt-6.2-sol`: 거절 없음. 목록 실패와 지금 목록을 담은 감지 기록: `MODEL-OUTDATED gpt-6.1-sol → gpt-6.2-sol (모델 목록을 읽지 못했지만 ...)`. 목록 실패와 이 머신의 실제 감지 기록: 거절하지 않고 `MODEL-CHECK-SKIP` 경고만 낸다(아래 관찰 1). 계정이 새 세대를 못 받을 때의 예외와 relaunch 는 테스트가 본다 | 통과(관찰 1 참고) |

### PR 2. 여러 계정의 남는 사용량(REQ7~REQ16)

하지 않음(사용자 결정 2026-11-23, 스펙 DECISION31). 검증 대상이 아니다.
스펙 「범위 밖」 대로 사용량 판정이 Fable 행을 astra 로 바꾸지 않는지만 봤다. 사용량 판정은 Codex 행을 Claude 로만 바꾼다(`agent-selection.md` 「Claude 사용량이 남을 때」, `launch-worker.ts`).

### PR 3. 같은 일 두 모델 비교의 절차와 기록 틀

| 요구사항 | 사례·실행 명령 또는 절차 | 기대 결과 | 실제 결과·증거 위치 | 판정 |
| --- | --- | --- | --- | --- |
| REQ17 | `skills/orch/references/model-compare.md` 「비교 시작」, `agent-selection.md` 「같은 일 두 모델 비교」 | 대상, 행 고르기, 보드 항목 하나, 첫 대상, 멈춤, 가리킴 | 모두 있다. 첫 대상 `gpt-6.2-astra` 와 보드 항목 id 가 코드(`model-watch.ts`)와 같다 | 통과 |
| REQ18 | `model-compare.md` 「두 worker 띄우기」, 「머지와 건의 결과」 | 지시서 하나를 두 파일로, 두 줄 모두 `후보 밖:`, 후보 줄 문구, 5건, 머지·닫기, 갈림, 실패 | 후보 줄이 스펙과 글자까지 같다. 나머지 항목도 있다. 지금 모델 쪽 줄은 `후보 밖: 비교 기준, ...` 이다 | 통과(결함 2) |
| REQ19 | `skills/orch/templates/spec-compare-review.md`, `model-compare.md` 「숨긴 리뷰」 | 모델 이름, PR 번호, 브랜치 없이 A, B 로 넘기고 머지할 쪽과 이유를 받음. 같은 쪽만 셈 | diff 와 질문, 이유, 같은 쪽만 센다는 규칙은 있다. 다만 비교 id 에 후보 모델 이름이 들어가 리뷰어 지시서에 보인다 | 통과(결함 1) |
| REQ20 | `model-compare.md` 「건마다 기록할 값」, 「5건 뒤 판단」 | 값과 출처, 문제 → 시간 → 비용 순서와 기준값 | 값 7칸과 출처, 순서, 1건 이하, 1.5배, 3건 이상이면 2배, 토큰을 API 가격으로 바꾼 값이 있다. 스펙에 없는 세부 규칙도 있다(결함 5) | 통과 |
| REQ21 | `model-compare.md` 「표 바꾸기」 | 승인 대기, 승인 뒤 표 worker, 거절이면 결과만 | 있다. `orch board approval add` 의 `--preview`, `--then` 은 실제 명령이 받는다 | 통과 |
| REQ22 | `skills/orch/templates/model-compare-record.md`, `docs/features/orch-routing/evidence.md` 「같은 일 두 모델 비교」, `docs-contract.spec.ts` | 기록 틀, 기록 절, 다시 비교하지 않음, 서로 가리키는지 테스트 | 모두 있고 테스트가 통과한다. 테스트는 낱말이 있는지만 본다(결함 6) | 통과 |

## 독립 검토

읽기 전용 검토 하위 에이전트(구현자가 아님)가 스펙과 설계를 코드, 문서, 테스트와 대조했다. 판정은 「차단 결함 없음」 이다.
검토자가 낸 결함 가운데 결함 1, 결함 2 는 이 검증의 실측으로 다시 확인했다. 나머지는 문서를 읽고 확인했다.
코드 리뷰는 구현 PR(#561, #565)의 리뷰를 거쳐 머지됐고, 이 검증은 코드를 바꾸지 않는다.

## 결함

모두 경미하다. 고치지 않았고 코디네이터가 후속 일로 정한다.

| 번호 | 내용 | 근거 | 돌아갈 단계 |
| --- | --- | --- | --- |
| 1 | 숨긴 리뷰에 후보 모델 이름이 보인다. 비교 id 가 `compare-<모델>-<행>` 이라 리뷰어 지시서의 제목, `보드 항목 id:`, `브랜치:`, 리뷰 폴더 경로에 `gpt-6-2-astra` 가 들어간다. A, B 중 어느 쪽인지는 숨겨지지만 스펙 REQ19 의 「모델 이름 없이」 와 틀 자신의 주석에 어긋난다 | `model-compare.md` 13, 38줄, `spec-compare-review.md` 1, 5, 9, 10줄 | implementation(문서 수정) |
| 2 | 모델 표가 아직 옛 세대일 때 비교의 지금 모델 쪽 worker 가 막힌다. 그 줄도 `후보 밖:` 이라 직접 고른 옛 세대 거절 대상이다. 절차에 「표를 먼저 고친다」 같은 대처가 없다 | 실측: 실제 목록에서 `pinnedCheck('codex','gpt-6.1-sol')` 가 `MODEL-OUTDATED` 를 낸다. `model-compare.md` 26줄 | plan(절차 보완) |
| 3 | 숨긴 리뷰의 순서 파일 `base=A` 가 「A.diff 가 지금 모델 PR」 이라는 뜻임을 절차가 적지 않는다. 결과를 거꾸로 풀 수 있다 | `model-compare.md` 37~38줄 | implementation(문서 수정) |
| 4 | 숨긴 리뷰가 갈리고 평소 리뷰의 P1·P2 수도 같을 때 어느 쪽을 머지할지 규칙이 없다. 스펙도 정하지 않았다 | `model-compare.md` 45줄 | spec(사용자 결정) |
| 5 | 스펙 결정 표에 없는 세부 규칙이 절차에 있다. 시간 관문은 「준비까지 분의 중앙값」, 비용 관문은 「후보가 비싸면 숨긴 리뷰 3건 이상일 때만 바꿈」, 「나쁜 건」 에 막힘·재시도를 넣었다. 스펙 DECISION5, DECISION6, DECISION28 과 같은 뜻인지 사용자 확인이 필요하다 | `model-compare.md` 63, 70, 71줄 | spec(사용자 확인) |
| 6 | 테스트가 얕은 곳이 있다. `docs-contract.spec.ts` 는 낱말이 있는지만 보고 후보 줄 전체와 판단 순서를 보지 않는다. `orch doctor` 출력에서 `CODEX-OUTDATED` 와 종료 코드를 보는 통합 테스트가 없다. 루프 부모가 `watchModels` 를 부르는 연결(`lifecycle.ts`)을 보는 테스트가 없다 | `docs-contract.spec.ts` 109~124줄, `orch-doctor.spec.ts`, `lifecycle.ts` 850~866줄 | implementation(테스트 보강) |
| 7 | 감지 기록이 낡은 목록으로 덮여도 막는 장치가 없다. 관찰 1 의 원인과 이어진다 | `model-watch.ts` 133~136줄, `newModels` 가 읽은 목록을 그대로 `models` 에 쓴다 | technical-design(원인 확인 뒤) |

### 관찰 1. 감지 기록의 모델 목록이 지금 목록보다 낡았다 (원인 미확인, 보류)

- 이 머신의 감지 기록이 마지막으로 읽은 목록(2026-11-22 22:29 KST)에 `gpt-6.2-sol`, `gpt-6.2-astra` 가 없다. 대신 `gpt-6.1-sol` 의 설명이 「Latest workhorse model」 이고, 지금 목록에 없는 `gpt-5.5`, `gpt-daybreak-*` 가 있다.
- 같은 기록의 기준점(첫 목록)에는 `gpt-6.2-sol` 이 있어, 그 뒤 하루 한 번 읽은 목록이 더 낡은 목록이었다.
- 지금 `codex debug models` 는 `~/.codex` 와 Orca Codex 계정 홈 두 곳 모두에서 `gpt-6.2-sol`, `gpt-6.2-astra` 를 낸다. 계정 홈의 모델 캐시는 2026-11-23 08:25 KST 에 받은 것이다.
- 추정: 그 시각에 루프의 환경(CODEX_HOME 이나 로그인 상태)에서 Codex CLI 가 서버 목록 대신 실행 파일에 든 옛 목록을 냈다. 감지는 루프 환경 그대로 codex 를 부르고, 띄우기는 worker 계정 홈으로 부른다. 확인하지 못했다.
- 영향: 모델 목록 조회가 실패한 띄우기에서 감지 기록으로 판정할 때 `gpt-6.1-sol` 직접 선택을 거절하지 못하고 경고만 낸다(REQ23 실측). 낡은 표 행 알림도 그 목록으로는 나오지 않는다. 다음 하루 한 번 읽기에서 지금 목록으로 바뀔 수 있다.

## 후속 수정 (2026-11-23)

결함 4, 5 는 사용자가 정했다(스펙 DECISION33, DECISION34). 나머지는 절차 문서, 틀, 감지 코드, 테스트에서 고쳤다.

| 번호 | 고친 내용 | 확인하는 테스트 |
| --- | --- | --- |
| 1 | 비교 id 를 `compare-<행>-<시작 날짜>-<번호>` 로 바꿔 모델 이름을 뺐다. 리뷰어에게는 원래 지시서 대신 모델 이름이 든 두 줄을 뺀 사본(리뷰 폴더의 `spec.md`)을 넘긴다 | `docs-contract.spec.ts` 「모델 비교 절차는 두 worker 줄, ...」 |
| 2 | 모델 표가 옛 세대면 지금 모델 쪽 줄에 `MODEL-TABLE-STALE` 이나 `MODEL-OUTDATED` 가 알린 새 세대를 적게 했다 | 같은 테스트 |
| 3 | `base=A` 는 `A.diff` 가 지금 모델의 PR 이라는 뜻을 적었다 | 같은 테스트 |
| 4 | 숨긴 리뷰가 갈리고 P1·P2 수도 같으면 준비까지 분이 짧은 쪽을 머지한다(DECISION34). 머지 전에는 띄우기 기록과 첫 준비됨 status 의 시각 차로 잰다 | 같은 테스트 |
| 5 | 나쁜 건, 시간, 비용의 정의를 지금 절차대로 결정 표에 올렸다(DECISION33) | 같은 테스트 |
| 6 | 후보 줄 전체, 판단 순서, 숨긴 리뷰 틀의 모델 이름을 보는 문서 계약 테스트, doctor 출력의 `CODEX-OUTDATED` 와 종료 코드를 보는 통합 테스트, 루프 부모가 틱 뒤에 감지를 부르는 연결 테스트를 더했다 | `docs-contract.spec.ts`, `orch-doctor.spec.ts` 「낡은 Codex CLI 는 ...」, `orch-loop.spec.ts` 「--once 가 아닌 루프는 ...」 |
| 7 | 새로 읽은 목록에서 어느 계열의 최신 세대가 이미 본 세대(저장된 목록의 현재 세대, 기준점, `found`)보다 낮으면(현재 세대끼리 비교) 감지 기록을 덮지 않고 `MODEL-LIST-OLDER` 로 한 번 알린다(`olderList`) | `model-watch.spec.ts` 「이미 본 세대보다 낡은 목록은 ...」, 「감지 기록이 이미 낡은 목록이어도 ...」 |

### 관찰 1 의 원인

- 낡은 목록은 codex-cli 0.166.0 실행 파일에 든 기본 목록과 글자까지 같다. 로그인 정보가 없는 빈 `CODEX_HOME` 으로 0.166.0 의 `codex debug models` 를 부르면 같은 12개 모델(`gpt-6.1-sol` 이 「Latest workhorse model」, `gpt-5.5`, `gpt-daybreak-*` 포함)이 나온다. 같은 방법으로 0.171.0 을 부르면 기본 목록에 `gpt-6.2-sol`, `gpt-6.2-astra` 가 있다.
- Codex CLI 는 서버 목록을 받지 못하면 이 기본 목록을 낸다. 감지는 루프 프로세스의 환경 그대로 codex 를 부르고, 상주 루프는 띄운 터미널의 `CODEX_HOME` 을 물려받는다. 지금 이 머신의 상주 루프들은 모두 Orca 의 Codex 관리 계정 하나의 홈을 `CODEX_HOME` 으로 갖는다.
- 그 계정 홈의 로그인 파일(`auth.json`)은 2026-11-23 07:36 KST 에 새로 만들어졌다. 2026-11-22 22:29 KST 에 목록을 읽은 fos-skills 루프(저장소 기록의 시각이 머신 기록과 같다)는 로그인 정보가 없는 그 계정 홈으로 codex 를 불러 기본 목록을 받은 것으로 본다. 그 시각의 루프 환경은 지금 남아 있지 않아, 같은 계정 홈이었다는 것은 지금 루프들의 환경으로 미루어 본 것이다.
- 결함 7 의 고침은 이 경우를 막는다. 기준점에 `gpt-6.2-sol`, `found` 에 `gpt-6.2-astra` 가 있으므로 0.166.0 의 기본 목록은 sol 과 astra 계열이 낮아진 목록이라 덮지 않는다. 테스트가 이 머신의 기록 모양과 그 기본 목록으로 본다.
- 이 머신의 지금 감지 기록은 아직 낡은 목록이다. 다음 하루 한 번 읽기가 0.171.0 으로 지금 목록을 받으면 덮인다. 감지가 worker 계정 홈(`workerCodexHome`)으로 codex 를 부르게 바꾸는 일은 이 수정의 범위 밖이다.

## 이 머신의 실제 상태 (읽기만)

| 항목 | 값 |
| --- | --- |
| `codex debug models` 의 현재 세대(목록에 보임, Legacy·Previous generation 아님) | `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6-luna` |
| 모델 표(`agent-selection.md`)의 Codex 모델 | `gpt-6.2-sol`(구현, 작은 수정, design, review), `gpt-6.1-terra`(visual) |
| `orch doctor` | `CODEX-OUTDATED 0.166.0 0.171.0`, `  codex update` |
| 루프의 감지 기록 | 기준점에 `gpt-6.2-sol` 포함, `found` 는 `gpt-6.2-astra`, 저장소 4곳에 알림과 보드 항목 완료, 낡은 표 행 알림 없음 |
| 보드 | `model-new-gpt-6-2-astra` 「새 모델 gpt-6.2-astra」(대기) |

## 남은 검증과 기능 전체

- PR 전 필수 미검증: 없음.
- 실제 비교(REQ17~REQ22 의 절차를 따른 5건)의 결과는 아직 없다. evidence 의 「같은 일 두 모델 비교」 절에 hard-design 비교가 진행 중으로 열렸고(#589), 5건이 차지 않았다. 절차가 있는지까지가 이번 인수 조건이고, 비교 결과는 기능 범위 밖의 운영 일이다.
- 그 절의 비교 id `compare-gpt-6-2-astra-hard-design` 은 #588 이 바꾼 id 꼴(`compare-<행>-<시작 날짜>-<번호>`) 이전에 열려 모델 이름이 들어 있다. 이미 띄운 worker 의 이름이라 고치지 않고, 다음 비교부터 새 꼴을 쓴다.
- 관찰 1 의 원인 확인은 다음 하루 한 번 읽기 뒤 감지 기록의 `models` 를 다시 보면 된다.

## 문서 대조와 공통 후보 (docs-consolidate, 2026-11-23)

| 문서 | 대조 결과 | 처리 |
| --- | --- | --- |
| spec.md | PR 2 하지 않음(DECISION31), PR 3 가벼운 범위(DECISION32), DECISION33, DECISION34 가 요구사항 표와 `model-compare.md` 절차에 맞다 | 정합 |
| design.md | 낡은 목록 판정(`olderList`), 비교 절차와의 경계가 #588 코드와 맞다 | 정합 |
| verification.md | 대상 PR 에 #587, #588 이 빠졌고 「남은 검증」 이 evidence 절이 비어 있다고 적었다 | 문구 수정 |

공통화 후보 없음: 이 기능의 규칙은 모델 세대 판정(`chooseGeneration`)과 비교 절차뿐이고, 둘 다 `skills/orch` 가 하나씩 소유한다. 다른 기능 스펙에 복제된 곳이 없어(`docs/features` 에서 같은 규칙을 찾지 못했다) 옮길 소유 위치가 없다.
