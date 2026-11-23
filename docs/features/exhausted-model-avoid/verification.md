# 모델 사용 한도 회피 인수 검증

이 문서는 [스펙](spec.md)의 인수 조건 REQ1~REQ10 을 실제로 실행해 확인한 결과를 적는다.
구현은 PR 594 에서 머지됐다. 아래 결과는 검증일에 확인한 기록이다.

- 검증한 커밋: `92ad5b4f6d42a85688a8f804c97d8f4f88fe6dbb` (main, PR 594 머지 커밋 `f188c644` 다음의 버전 올림 커밋)
- 검증일: 2026-11-23
- 검증 방법: 코드와 문서 대조, 관련 테스트 5개 파일 실행, 이 머신의 실제 사용량 파일 읽기 전용 확인, `orch worker launch --task --preflight` 건조 실행

## 실행한 것

| 실행 | 결과 |
| --- | --- |
| `node scripts/run-tests.ts` 에 `launch-worker.spec.ts`, `lib-model-limits.spec.ts`, `relaunch-worker.spec.ts`, `launch-worker-functions.spec.ts`, `skills/pr-review/tests/gh-review.spec.ts` 를 준 실행 | 통과 5, 실패 0 (249.8초) |
| `launchLimits` 로 이 머신의 선택 계정에서 Claude 와 Codex 한도를 읽기(읽기 전용) | 아래 「실환경 읽기」 |
| `orch worker launch --spec <지시서> --repo <저장소> --task <Task> --preflight -- --agent codex --model gpt-6.2-sol --effort medium` 로 Codex 행 건조 실행(지시서에는 `허락:`, `worker 선택:`, `## 할 일` 의 `루프 없이:` 줄이 필요하다) | `PREFLIGHT-OK`, 종료 코드 0. 경고 한 줄: `routing.usage_boost 는 없어졌다. 저장소 설정에서 이 키를 지운다` |
| 표 읽기(`readSelectionTable`, `limitRowOf`) 로 같은 등급 칸 확인 | 아래 REQ3 |

전체 테스트(인자 없는 `run-tests.ts`)와 `claude plugin test .` 는 돌리지 않았다. PR 594 본문은 구현 쪽에서 둘 다 통과했다고 적었고, 이 검증은 변경된 동작의 테스트 파일만 다시 돌렸다.

### 실환경 읽기

선택 계정의 값을 읽었고, 둘 다 바닥나지 않은 상태였다. 두 제공자 모두 `USAGE-UNKNOWN` 이 나오지 않았다.

| 제공자 | 모델 | 읽힌 창 |
| --- | --- | --- |
| Claude | Opus, Sonnet, Haiku | 주간 13%, 2026-11-28T21:00Z 에 풀림 |
| Claude | Fable | 주간 13%, Fable 주간 0% |
| Codex | `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`, `gpt-6.2-astra` | 주간 10%, 2026-11-29T22:45Z 에 풀림, 걸림 표시 없음 |

Claude 값이 읽혔다는 것은 캐시의 인증 해시가 선택 프로필과 일치했다는 뜻이다. 일치하지 않으면 `USAGE-UNKNOWN claude` 가 난다. 읽는 동안 선택 계정은 바뀌지 않았다(`changed()` 가 false).

## 인수 조건별 결과

| ID | 결과 | 근거 |
| --- | --- | --- |
| REQ1 | 통과 | `launch-worker.spec.ts` 「다른 제공자에 여유가 있어도 고른 Codex 를 유지한다」: Codex 99.9% 이고 Claude 0% 여도 Codex 로 시작하고 `candidateOverride` 가 없으며 Claude 계정 조회도 하지 않았다. 건조 실행에서도 `gpt-6.2-sol` 행이 그대로 통과했다. 이전 규칙(`lib/usage-boost.ts`)은 파일째 없어졌다 |
| REQ2 | 통과 | `lib-model-limits.spec.ts` 「99.9%, 100%, 걸림 표시와 초기화 경계를 구분한다」. `core/model-limits.ts` 의 `exhaustedWindows` 는 풀리는 시각이 지나지 않았고 100% 이상이거나 걸림 표시가 있을 때만 막는다. 시각 없는 창은 읽는 쪽에서 버린다(Codex `observations`) |
| REQ3 | 통과 | 표 읽기 결과가 표와 일치한다. Fable 의 대체는 Opus `medium`, astra `medium`, sol `medium` 순서, sol `medium` 은 Opus `medium`, sol `high` 는 Opus(effort 칸 없음 → 원래 effort), Haiku 는 luna 하나다. `launch-worker.spec.ts` 「소진이면 같은 등급을 실행하고…」에서 Codex sol 소진 → `--agent claude --model opus --effort medium` 로 시작했다. 표에 없는 모델로 올리거나 한 단계 아래로 내리는 코드는 없다(`alternatives` 는 `same` 칸만 본다). 리뷰의 같은 제공자 표시는 `launch-worker.spec.ts` 「한도로 같아진 리뷰 제공자를 표시하고…」와 `gh-review.spec.ts` 가 확인했다 |
| REQ4 | 통과 | 위 소진 테스트가 `LAUNCH-EFFECTIVE`(상세와 `short` 출력 둘 다), 실행 이력, 로컬 기록의 `candidateOverride` 가 같은 값(`row`, 최종 `agent`·`model`·`effort`, `from` 의 처음 요청, `reason` = `한도: gpt-6.2-sol 주간 100%, <ISO 시각>`)임을 비교한다. 지시서 선택과 달라도 거절하지 않았다 |
| REQ5 | 통과 | 「같은 등급이 모두 소진되면 Task 와 워크트리를 만들기 전에 멈춘다」: 종료 코드 1, `REFUSED 같은 등급…`, 바닥난 모델마다 `USAGE-LIMIT` 줄, `USAGE-RESET` 줄이 나오고 worker-start 와 make-worktree 호출이 없다. 명령으로 확인한 것은 표에 있는 후보가 모두 소진된 경우까지다. 칸이 빈 경우는 `lib-model-limits.spec.ts` 가 빈 후보 목록으로 거절 결과를 확인한 단위 테스트까지만 있고, 표에 줄이 없는 경우는 `limitRowOf` 가 줄 없음을 돌려주는 것(`gpt-5.3-codex-spark` 로 확인)과 `alternatives` 가 비어 같은 거절 경로로 가는 코드 대조까지만 했다. 두 경우 모두 가짜 Orca 로 `launch-worker` 를 실행한 테스트는 없다 |
| REQ6 | 통과 | 「한도 미확인과 옛 설정을 한 번씩 알리고 원래 모델로 띄운다」: 한도 자료가 없으면 `USAGE-UNKNOWN codex` 한 줄만 내고 원래 모델로 시작한다. 원격 worker 와 계정 확인 실패도 같은 경로다(`launch-limits.ts`) |
| REQ7 | 통과 | Orca 선택 계정(`orca account list`)으로 홈과 귀속 ID 를 정한다. Claude 는 캐시 인증 해시, Codex 는 세션 첫 줄의 `creator_account_id` 와 대조한다(`claude-limits.ts`, `codex-limits.ts`). 「계정이 바뀌면 예약 전에 새 계정의 한도를 다시 읽는다」, 「워크트리가 준비된 뒤 계정이 바뀌면 시작하지 않는다」, `lib-model-limits.spec.ts` 의 공유 캐시 귀속과 다른 계정 기록 제외 테스트가 통과했다. 실환경에서는 선택 계정의 Claude 해시 일치와 Codex 세션 읽기가 모두 성공했다 |
| REQ8 | 통과 | 소진 테스트의 지시서에 `후보 밖: 사용자 지정.` 이 있고, 같은 대체가 일어나며 `from.outsideReason` 에 원문이 남는다. 코드에서 `pinnedSelection` 은 세대 고정만 하고 한도 검사(`chooseWithinLimits`)는 그대로 거친다 |
| REQ9 | 통과 | 위 테스트가 `routing.usage_boost` 경고를 정확히 한 번 확인한다. 실제 건조 실행에서도 이 저장소 설정에 남은 키 때문에 경고가 나왔고 `PREFLIGHT-OK` 로 끝났다(막지 않음). 설정 스키마는 키를 `z.unknown()` 으로 받아 옛 설정을 열 수 있다 |
| REQ10 | 통과 | 「--task 재시도는 한도를 읽고 터미널 이어 쓰기는 읽지 않는다」: `--task` 재시도는 한도를 읽어 Opus 로 바꿨고 `--terminal` 이어 쓰기는 `orca account list` 를 부르지 않았다. `relaunch-worker.spec.ts` 「두 제공자가 모두 소진되면 preflight 가 abandon 전에 멈춘다」가 relaunch 경로를 확인한다. `resume-worker.ts` 는 `launchLimits` 와 `decideSettings` 를 쓰지 않는다 |

## 문서와 코드 대조

- 스펙의 DECISION10 대로 `agent-selection.md` 에 「Claude 사용량이 남을 때」 절과 옛 `usage_boost` 설명은 없고, `usage_boost` 안내 한 줄만 남았다. `docs/data-schema.md` 의 `routing.usage_boost` 행이 같은 동작(삭제 안내, 읽을 수 있음)을 적는다.
- 설계의 위치 계획(`core/model-limits.ts`, `lib/claude-limits.ts`, `lib/codex-limits.ts`, `lib/launch-limits.ts`, `decideSettings` 호출)이 실제 파일과 맞는다.
- 설계 문서가 말한 대로 첫 턴 이후의 Codex 소진은 시작 전에 알 수 없다. 이 경우는 기존 「사용 한도에 걸렸을 때」 절차가 맡는다.

## 실패한 조건

없다.

## 남은 검증과 결함 후보

- 실제로 소진된 계정에서 대체가 일어나는 것은 이 머신에서 보지 못했다. 선택 계정이 바닥나지 않아서다. 소진과 계정 전환은 고정 입력(테스트의 가짜 Orca 와 가짜 사용량 파일)으로만 확인했고, 이는 설계의 검증 전략과 같다.
- 건조 실행은 `--preflight` 까지만 했다. 지시서 선택과 한도 결정까지만 지나가며 워크트리, Task, worker 를 만들지 않는다. 실제 worker 시작은 하지 않았다.
- 이 저장소의 설정에 `routing.usage_boost` 키가 아직 남아 경고가 난다. 스펙 DECISION11 대로 머지 뒤 코디네이터가 지운다.
- REQ5 의 「칸이 빔」 과 「표에 줄 없음」 은 명령 수준(가짜 Orca 로 `launch-worker` 실행) 테스트가 없다. 지금 결함이 있다는 근거는 없고, 이 두 경로를 고치는 다음 변경에서 명령 테스트를 더할지 정한다.
- 결함 후보: 없다.
