# 모델 사용 한도 회피 기술 설계

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 지시서 선택과 실행 인자를 대조한다. 보낼 모델에 소진 근거가 없으면 기존 모델 검사와 세대 규칙을 적용한다 |
| REQ2 | 선택 계정의 한도만 읽고, 모델에 적용되는 한도의 사용률·걸림 표시·초기화 시각을 함께 본다 |
| REQ3 | 한도 표의 같은 등급 후보를 앞에서부터 확인한다. 리뷰는 실제 구현 제공자와 최종 리뷰 제공자가 같아진 경우를 결과에 표시한다 |
| REQ4 | `LAUNCH-EFFECTIVE` 와 실행 이력에 변경 전후 설정과 한도 사유를 기록한다 |
| REQ5 | 쓸 후보가 없으면 기존 거부 경로에서 모델별 한도와 가장 빠른 초기화 시각을 출력한다 |
| REQ6 | 출처 또는 계정 귀속을 확인하지 못하면 제공자별 `USAGE-UNKNOWN` 을 한 줄 내고 그 후보의 사용을 허용한다 |
| REQ7 | Orca 에서 새 worker 가 쓸 계정을 읽는다. 경로가 공유돼 있으면 사용량을 남긴 계정도 확인한다 |
| REQ8 | `후보 밖:` 선택도 실행 인자와 대조한 뒤 같은 한도 규칙을 적용한다 |
| REQ9 | `routing.usage_boost` 가 남아 있으면 값에 상관없이 삭제 안내를 한 줄 낸다 |
| REQ10 | 새 launch 와 `--task` 재시도, relaunch 의 시작 전 검사에서 호출한다. 같은 세션을 잇는 resume 과 `--terminal` 은 건너뛴다 |

## 책임과 경계

- [launch-worker 의 `decideSettings`](../../../skills/orch/scripts/worker/launch-worker.ts) 가 지시서 검사와 실제 시작 사이에서 후보를 고른다. [relaunch-worker](../../../skills/orch/scripts/worker/relaunch-worker.ts) 의 시작 전 검사도 같은 경로를 쓴다.
- 제공자별 파일 읽기와 Orca 호출은 `lib/` 가 맡는다. `core/` 는 파싱된 한도, 후보 순서, 현재 시각을 받아 선택 결과를 낸다. 계정 선택과 사용량 기록의 작성은 Orca 와 각 제공자가 소유한다. [ADR-028](../../adr/028-orch-core-layer.md)
- [한도 표](../../../skills/orch/references/agent-selection.md#사용-한도에-걸렸을-때)가 같은 등급 후보의 원본이다. [기존 표 읽기](../../../skills/orch/scripts/lib/usage-boost.ts)의 `readSelectionTable`, `limitRows`, `limitRowOf` 를 별도 모듈로 옮긴다. [시작 전 모델 검사](../../../skills/orch/scripts/lib/model-check.ts), [모델 알림](../../../skills/orch/scripts/loop/model-watch.ts), [리뷰 지시서 생성](../../../skills/orch/scripts/lib/review-spec.ts)과 공유한다.
- [usage-routing](../usage-routing/design.md)의 사용률과 남은 시간 비교, 행 목록, `sameGradeClaude`, 시간 경과 기준, `ORCH_CLAUDE_USAGE` 우선 경로를 걷어 낸다. 경로와 시각은 테스트에서 직접 주입한다. 구현 PR 에서 [선택 안내](../../../skills/orch/references/agent-selection.md), [오버레이 안내](../../../skills/orch/references/overlay.md), [설정 스키마 문서](../../data-schema.md)를 맞추고, 옛 기능 문서에서 이 설계로 이어지는 링크를 남긴다.

## 인터페이스와 데이터

### 이번 실행에서 사용할 계정

- `orca account list --agent claude --json` 또는 `--agent codex` 의 `result` 는 제공자 객체다. 전체 조회에서는 `result.claude` 와 `result.codex` 에 같은 형태가 있다. 현재 host 의 `activeAccountIdsByRuntime.host` 가 있으면 사용하고, 그 필드가 없는 Orca 에서는 `activeAccountId` 를 읽는다. 명시적으로 `null` 인 경우만 기본 계정으로 본다. 응답 오류, 잘못된 값, 선택 항목 누락은 계정을 읽지 못한 것으로 처리한다.
- Claude 는 관리 계정의 `accounts[].home` 과 [`claude-profile.ts`](../../../skills/orch/scripts/lib/claude-profile.ts)가 읽는 `<claude-profiles>/selected-host` 를 대조한다. 마커는 절대 홈 경로나 프로필 ID 다. ID 면 `<claude-profiles>/<id>/home` 으로 푼다. 기본 계정의 홈은 `systemDefaultHome` 이다. 마커가 있고 Orca 응답과 어긋나면 선택 계정을 확인할 수 없는 것으로 본다.
- Codex 는 [`workerCodexHome`](../../../skills/orch/scripts/lib/model-generation.ts)의 계정 조회와 홈 계산을 재사용한다. 관리 계정은 `<orca>/codex-accounts/<id>/home`(`ORCA_CODEX_ACCOUNTS` 가 있으면 그 폴더 아래의 `<id>/home`), 기본 계정은 `ORCH_SYSTEM_CODEX_HOME` 또는 `~/.codex` 다. 모델 검사와 한도 읽기에 같은 실행의 계정 조회 결과를 넘긴다. 호출한 셸의 `CODEX_HOME` 과 `CLAUDE_CONFIG_DIR` 는 그 셸을 띄운 시점의 계정일 수 있다.
- 원격 배치 또는 사용 계정을 확인할 수 없는 실행 환경에서는 `USAGE-UNKNOWN` 을 내고 기존 선택을 진행한다. 로컬 Orca 의 `account list` 는 원격 환경 인자를 거부하므로 원격 worker 의 계정을 판정하는 데 쓸 수 없다.

### Claude 상태 줄 캐시

선택한 홈의 `plugins/oh-my-claudecode/.usage-cache-anthropic.json` 을 읽는다. 현 머신에서는 관리 프로필의 `plugins` 가 링크이고 기본 홈과 같은 파일에 닿는다. 계정 전환으로 캐시가 다른 계정 값으로 바뀔 수 있으므로 홈 경로만으로 귀속을 확정하지 않는다.

`credentialIdentity` 가 새 worker 에서 사용할 인증의 해시와 일치하는 캐시만 사용한다. Claude 플러그인 설치 기록에서 찾은 oh-my-claudecode 의 `getUsageCredentialIdentity()` 를 별도 프로세스에서 부른다. 캐시를 쓸 때와 같은 기본 인자로 인증 환경 변수를 포함한다. Orca 가 새 worker 에 주는 `CLAUDE_CONFIG_DIR` 문자열을 그대로 전달한다. Keychain 서비스 이름 계산에 원문을 쓰므로 말단 슬래시나 `~` 표기를 바꾸지 않는다. 기본 계정에서 Orca 가 그 변수를 주지 않으면 조회 프로세스에서도 비운다.

`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN` 등 해시에 영향을 주는 환경은 Orca 의 새 실행과 일치한다고 확인할 수 있는 값만 사용한다. 계정의 저장된 인증을 쓰고 관련 변수가 없다는 것을 확인했으면 조회 프로세스에서도 해당 변수를 비운다. 새 실행의 환경을 확인할 수 없거나 모듈·시간 상한·해시 비교에서 실패하면 `USAGE-UNKNOWN claude` 로 그대로 진행한다. 공유 캐시에는 마지막으로 쓴 계정 값만 남으므로 계정을 전환한 직후에는 해시가 다를 수 있다. orch 가 받는 것은 비교용 해시다. 한도 값은 캐시에서만 읽는다. 이번 조사에서는 캐시와 설치 소스를 확인했고, 실계정 해시 일치 여부는 구현 검증에 남긴다. [oh-my-claudecode 캐시 및 인증 식별 구현](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/v5.8.6/src/hud/usage-api.ts)

| 대상 | 캐시의 `data` 필드 |
| --- | --- |
| Claude 공통 주간 | `weeklyPercent`, `weeklyResetsAt` |
| Claude 공통 5시간 | `fiveHourPercent`, `fiveHourResetsAt` |
| Sonnet 또는 Opus 계열 주간 | `sonnetWeeklyPercent`와 `sonnetWeeklyResetsAt`, 또는 `opusWeeklyPercent`와 `opusWeeklyResetsAt` |
| 다른 모델의 주간 | `scopedWeeklyBuckets[]` 의 `id`, `label`, `percent`, `resetsAt`, `isActive` |

공통 창과 해당 모델의 창을 모두 본다. 모델별 묶음은 명시된 모델 ID 또는 확인된 계열 이름에 대응시킨다. 실제 캐시에서 본 `fable` 은 Fable 에만 건다. `isActive` 는 캐시가 여러 묶음 중 현재 적용되는 것을 표시하는 값이다. `false` 도 해당 모델의 사용률은 유효하며, `true` 자체를 소진 표시로 해석하지 않는다. 빠진 선택 필드는 다른 유효한 창의 판정을 막지 않는다. `lastSuccessAt` 은 관측 시각, 초기화 값은 ISO 시각이다. 캐시가 오류 상태라도 같은 계정에 귀속된 마지막 성공 데이터가 함께 있으면 그 유효한 창을 사용한다. [oh-my-claudecode 한도 필드](https://github.com/Yeachan-Heo/oh-my-claudecode/blob/v5.8.6/src/hud/types.ts)

### Codex 세션 기록

선택 홈의 `sessions/YYYY/MM/DD/rollout-*.jsonl` 을 본다. 현 머신에서는 관리 계정의 `sessions` 가 기본 홈으로 연결됐다. 관리 계정의 ID 는 `workspaceAccountId` 를 쓰고 없으면 `providerAccountId` 를 쓴다. 기본 계정은 `systemDefault.providerAccountId` 다. 두 필드가 모두 있는데 서로 다르거나, 같은 ID 를 쓰는 Orca 선택을 구분할 수 없다면 한도를 알 수 없는 것으로 본다.

파일 첫 `session_meta.payload.creator_account_id` 가 선택 계정과 일치해야 한다. `account_scoped` 는 기록 목록의 범위를 구분하는 값이며, 세션을 재개해도 생성 계정은 그대로다. 계정이 명시된 이벤트가 없는 현재 형식에서는 첫 `task_started` 부터 첫 `task_complete`, `turn_aborted` 또는 다음 `task_started` 전까지의 한도만 사용한다. 첫 턴을 찾지 못하거나 일치하는 한도 이벤트가 없으면 미확인으로 처리한다. 기본 계정도 `account_scoped` 가 없는 구형 기록에서 같은 기준을 쓴다. 이 머신에서 기본 계정으로 만든 구형 기록 13개의 첫 턴에서 `codex` 한도 값을 확인했다. [Codex 의 계정별 기록 목록](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#local-history-by-account) · [Codex 세션 생성 계정 필드](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/types.rs)

`type: event_msg`, `payload.type: token_count` 인 줄에서 `payload.rate_limits` 의 `limit_id`, `limit_name`, `primary`, `secondary`, `rate_limit_reached_type` 을 읽는다. 각 창에는 `used_percent`, `window_minutes`, `resets_at` 이 있다. `resets_at` 은 Unix 초이며 내부에서는 밀리초로 맞춘다. 슬롯 순서 대신 `window_minutes` 로 5시간(300)과 주간(10080)을 구분한다. 실제 기록에 `primary` 만 있는 주간 창이 있었다. 사용률이나 초기화 시각이 빠지거나 잘못된 창을 다른 창의 값으로 채우지 않는다. [Codex 한도 파서](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)

| `limit_id` | 적용 모델 |
| --- | --- |
| `codex` 또는 ID 없는 구형 기본 기록 | 선택 계정의 일반 Codex 모델. 현 모델 표의 솔·아스트라·테라·루나 같은 일반 모델은 공통 한도를 적용받는 것으로 본다 |
| `codex_bengalfox` 등 모델 전용 ID | `limit_name` 이 명시하는 전용 모델에만 적용한다. 예를 들어 이름이 `GPT-5.3-Codex-Spark` 면 Spark 에만 건다. ID 만으로 Spark 와 Sonic 등 이름이 바뀐 모델을 구분할 수 없다 |
| `base_model_inference` 와 `gpt-reserve` 이름 | 명시된 Reserve 모델에만 적용한다. 일반 Luna 는 별도 실행 모델이므로 이 한도를 옮겨 붙이지 않는다 |
| 확인할 수 없는 ID 또는 이름 | 모델의 소진 근거로 삼지 않는다. 해당 모델에서 적용할 창을 확인할 수 없으면 `USAGE-UNKNOWN` 이다 |

같은 세션에서 다른 모델의 한도가 기록될 수 있어 `turn_context.model` 로 ID 를 추측하지 않는다. 조사한 선택 계정의 표본에서 확인한 ID 는 `codex` 다. 모델 전용 ID 에 대한 위 규칙은 [Codex 의 ID·이름 처리](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)와 [최근 계정 응답 스키마](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/GetAccountRateLimitsResponse.json)에서 확인한 형식에 근거한다.

최근 수정된 기록부터 읽고 이벤트의 `timestamp` 로 최종 값을 정한다. 같은 `limit_id` 와 창 길이에서 가장 최근의 유효한 관측을 고르므로 다른 창의 갱신은 영향을 주지 않는다. 날짜 폴더는 탐색 순서에만 쓴다. 오래된 세션도 최근에 갱신됐다면 포함한다.

5시간·주간 창을 읽을 때 수정 시각이 최근 7일 이내인 세션을 다 확인하면 탐색을 끝낸다. 각 창은 길이가 7일 이하여서 그보다 앞서 관측한 창은 이미 초기화됐을 시점이다. 초기화 시각을 그대로 쓰고, 사용률에 별도의 신선도 제한은 두지 않는다. 후보 파일은 첫 줄로 계정을 대조하고 일치하는 파일의 첫 턴만 줄 단위로 읽는다. 시작부터 최대 3초와 누적 읽기 64 MiB 를 허용한다. 이번 머신에서 최근 7일간 선택 계정에 귀속된 파일의 전체 크기는 약 19 MiB 였다. 상한에 닿으면 읽다 만 값으로 소진을 확정하지 않고 `USAGE-UNKNOWN codex 세션 기록 탐색 한도 초과` 를 낸다.

`rate_limit_reached_type` 은 해당 묶음의 알려진 걸림 표시다. 같은 이벤트에서 걸린 창의 초기화 시각이 확인될 때만 쓴다. 창이 하나뿐이면 그 창을 쓰고, 창이 여럿이면 어느 창인지 확인된 것 또는 사용률로 이미 소진이 확인된 창만 쓴다. 시각이 없는 크레딧·지출 한도 표시에 다른 창의 시간을 붙이지 않는다. 로컬 표본에서는 이 필드가 `null` 이었다. 표시가 붙은 값과 두 창이 있는 값은 합성 입력으로 검증한다. [Codex 의 한도 오류와 시각 필드](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs)

### 선택과 기록

1. 지시서 선택을 먼저 검사한다. 이후 기존 세대 규칙을 적용해 실제로 보낼 모델을 확정하고 그 모델의 한도를 본다. 같은 등급 후보도 세대와 effort 를 확정한 값으로 검사한다. `후보 밖:` 의 세대 고정·검사 규칙은 원래 선택에 적용한다.
2. 제공자별 읽기는 후보가 처음 필요해질 때 한 번 한다. 스펙의 소진 기준을 후보마다 적용한다. 같은 등급 칸에서 첫 미소진·미확인 후보를 선택하고, 기존 모델·effort 검사를 거쳐 실행한다.
3. 전원이 소진됐거나 같은 등급 목록이 비어 있으면 launch 는 종료 코드 1 과 `REFUSED` 를 반환한다(전체 출력은 `거부:`). relaunch 의 시작 전 검사에서는 기존 `RELAUNCH-REFUSED` 와 종료 코드 3 으로 전달한다. 모델과 한도 종류별 초기화 시각, 가장 이른 초기화 시각을 낸다. 한 모델에 걸린 창이 여럿이면 그 모델의 모든 시각을 남긴다.
4. [실행 기록](../../../skills/orch/scripts/lib/launched.ts)의 `candidateOverride` 에 `row` 는 지시서의 원래 행이다. 최상위 `agent`, `model`, `effort` 는 최종 실행 값이며, 한도로 바꾼 경우에만 `from: {agent, model, effort}` 에 지시서에서 요청한 값을 보존한다. 지시서에 `후보 밖:` 사유가 있으면 `from.outsideReason` 에 원문을 남긴다. `effort` 의 기본값은 양쪽 모두 `null` 이다. `reason` 은 `한도: <모델> <한도 종류> 100%, <풀리는 시각>` 형식이다. 소진된 창이 여럿이면 가장 늦게 풀리는 창을 전환 사유에 쓴다. 세대 승격 정보는 기존 `generation` 에 남긴다. `LAUNCH-EFFECTIVE`, 로컬 기록, 영구 이력에 같은 값을 보존하고, 옛 기록의 `from` 은 생략한다.
5. 리뷰 대상 PR 의 실제 구현 제공자는 [`implementerOf`](../../../skills/orch/scripts/lib/review-spec.ts) 로 구한다. 한도로 후보가 바뀌어 리뷰 제공자가 같아졌다면 실행 기록에 표시한다. 리뷰 워크트리의 `git rev-parse --git-path orch-review-launch.json` 이 가리키는 Git 메타데이터에 시작 전에 `{repo, pr, sameProviderDueToLimit}` 를 원자적으로 쓴다. `repo` 는 리뷰 명령에 주는 `owner/repo` 문자열이다. `--task` 재시도는 새 선택으로 값을 다시 쓴다. 최초 실행과 재시도 모두 [리뷰 등록 명령](../../../skills/pr-review/scripts/gh-review-post.ts)이 워크트리에서 저장소와 PR 번호가 일치하는 값을 읽어 요약 본문에 `같은 제공자 리뷰(한도)` 를 한 번 붙인다. [리뷰 지시서](../../../skills/orch/templates/spec-review.md)에서 다른 제공자를 쓴다는 문장을 계획값으로 바꾸고, 판정 줄과 등급 표의 형식은 유지한다.

## 실패와 일관성

- 초기화 시각이 지났거나 시각이 없으면 그 창으로 소진을 확정하지 않는다. 오래된 관측은 리셋 전까지 쓴다. 읽을 수 있는 창 하나로 소진이 확정되면 다른 창의 파싱 실패로 그 결과를 취소하지 않는다. 실패 이유에는 파일 원문, 인증 정보, 계정 식별자를 넣지 않는다.
- 기본 launch 의 한도 거부는 번호 예약과 워크트리·Task 생성 전에 끝낸다. relaunch 는 기존 `--preflight` 를 abandon 전에 실행하므로 별도로 같은 한도를 읽던 앞 단계를 합친다. 실제 시작 단계에서도 계정을 다시 확인한다. preflight 이후 계정·한도 변경으로 거부하면 기존 `RELAUNCH-FAIL launch` 와 `NEXT` 경로가 Task 와 워크트리를 보존해 재시도를 안내한다.
- Orca 의 계정 선택과 시작 사이에 공용 잠금이 없다. 번호 예약과 워크트리 생성 전에 선택이 달라진 것을 발견하면 새 계정으로 한도를 다시 읽는다. 워크트리 준비 뒤의 최종 확인에서 변경을 발견하면 worker-start 전에 멈추고, 기존 실행 실패 경로에서 남은 워크트리를 재사용하도록 안내한다. 그 상태에서 다시 실행하면 새 계정의 한도를 처음부터 읽는다. 최종 확인과 Orca 시작 사이의 짧은 경합은 남는다.
- 옛 설정 키는 현재 허용 목록에 호환용으로 남기되 bool 검사를 없앤다. `loadConfig` 의 거부형 삭제 목록에 넣으면 다른 기존 명령까지 멈추므로 사용하지 않는다. 새 실행 명령이 키 존재를 보고 한 번 안내한다. 설정 파일 편집과 실제 삭제는 기존 운영 절차로 할 수 있다.

## 검증 전략

| 검증 경계 | 확인할 결과 |
| --- | --- |
| 값만 넘기는 단위 테스트 | 99.9%는 소진으로 계산하지 않는다. 100%, 걸림 표시, 리셋 직전·동일 시각·직후, 오래된 유효 관측, 여러 창, 알 수 없는 필드, 시간 없는 크레딧을 확인한다 |
| 한도 파일과 계정 선택을 바꿔 끼운 테스트 | 선택 계정 전환, 시스템 홈, 공유 경로, Claude 설정 경로의 원문 전달, 인증 환경 누락과 해시 불일치의 미확인 처리, 모델별 주간 묶음, 기본 계정의 구형 기록과 그 기록을 다른 계정으로 재개한 턴, 계정 ID 누락, 다른 계정의 최신 기록, 두 창의 슬롯 교체, 뒤늦게 끝난 옛 세션·파싱 도중 끊긴 줄·탐색 상한을 재현한다 |
| 가짜 Orca 를 붙인 명령 테스트 | 정상 행·직접 선택·동일 등급·비어 있는 칸·없는 줄을 재현한다. 직접 선택이 다시 바뀌면 최초 선택 사유와 한도 사유를 모두 확인한다. 거부 때 worktree 와 worker-start 호출이 없는지, 선택 때 출력과 영구 기록이 같은지, 경고가 명령마다 한 번인지 확인한다 |
| relaunch 와 리뷰 검증 | preflight 가 거부되면 옛 worker 를 abandon 하지 않는다. 재시도는 새 계정과 한도를 읽고 resume 과 `--terminal` 은 읽지 않는다. 최초 실행과 같은 Task 재시도에서 리뷰의 실제 제공자가 한도로 구현 제공자와 같아진 경우에만 PR 리뷰 본문에 표시한다 |
| 실환경 인수 검증 | 선택 계정을 바꾼 뒤 실제 사용량 캐시와 세션 기록의 귀속을 비교한다. Claude 해시 조회는 첫 실환경 검증에서 확인하고 실제 한도 소진에 의존하는 경우는 고정 입력으로 재현한다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION19 | 코드 배치 | 제공자별 읽기는 기존 `lib/`, 한도 판정은 `core/`, 새 실행 전 검사는 `decideSettings` 에 둔다 | 작성자 | 작업 하나의 실행 경로에 모여 있다. 현재 ADR 의 책임 경계를 적용한다 |
| DECISION20 | 공유 경로의 계정 확인 | Claude 캐시의 해시와 Codex 세션의 계정 범위를 확인한다 | 작성자 | 두 제공자 모두 현 머신에서 경로를 공유한다. 계정을 바꿨을 때 혼선이 생기면 스펙의 미확인 처리로 진행한다 |

제품 동작의 원본은 [확인된 스펙](spec.md)이다. 다음 plan 에서는 같은 계정의 실환경 검증과 저장소 계약 문서 갱신을 구현 PR 범위에 넣는다.
