# 1. 에이전트 고르기

**모델과 effort 는 Task 마다 성능과 가격을 비교해 고르고, 비교한 후보와 고른 이유를 지시서의 `worker 선택:` 줄에 남긴다.**
기본값을 두지 않는다. 사용자가 지정하면 그것을 따른다.
줄의 형식은 [`spec-writing.md`](spec-writing.md) 의 「넣을 것」 이 소유한다. `spec-lint` 가 줄이 없는 지시서를 막고, `launch-worker` 가 줄과 다른 `--agent`, `--model` 을 거부한다.
문서의 명령 예시는 이 단계에서 고른 값을 `$AGENT`, `$MODEL`, `$EFFORT` 변수로 받는다.
기본으로 뺀 모델은 아래 「기본 후보에서 뺀 모델」 이 정하고, 사용자나 오버레이가 지정하면 그것을 따른다.
사용 한도에 걸렸을 때의 모델 변경은 아래 「사용 한도에 걸렸을 때」 표를 따른다.

## 제공자

모델 표를 보기 전에 Claude 와 Codex 중 어느 쪽에 맡길지 먼저 정한다.
같은 계열을 기본값으로 두지 않는다. 한 세션에서 worker 를 모두 Claude 로 띄우고 「리뷰와 검증」 행을 한 번도 쓰지 않은 일이 있었다.

- 주 산출물이 한국어 문서나 스킬 문서인 작업은 Claude 로 띄운다. Claude Code hook(한국어 표기 검사, orch 안전 hook)에 기대기 때문이다. Codex 매니페스트는 hook 을 싣지 않는다([ADR-007](../../docs/adr/007-codex-manifest-without-hooks.md))
- 코드 작업에 딸린 ADR, flow 문서 수정은 위 규칙에 들지 않는다. 주 산출물이 코드면 코드 중심 구현으로 본다. 문서 수정까지 넓혀 적용하자 코드 작업도 거의 모두 Claude 로 띄운 일이 있었다(2026-10-26~30)
- 코드 중심 구현은 `gpt-6.1-sol` 과 Claude Sonnet 5.5 를 비교해 고르고, 고른 이유를 `worker 선택:` 줄에 남긴다
- Claude 가 만든 PR 의 머지 전 독립 리뷰는 Codex 로 띄운다. 보안 리뷰는 아래 표대로 Claude 다
- 화면과 이미지 판정은 `gpt-6.1-terra` 를 먼저 본다
- Codex worker 를 띄울 때 걸리는 GitHub 게시 승인은 [`spec-writing.md`](spec-writing.md) 가, 준비 설정은 [`launch.md`](launch.md) 의 「codex 준비 판정」 이 다룬다

## 모델

계획서의 구체성과 필요한 탐색에 따라 고른다.
인증과 권한 작업도 계획서에 수정 위치와 검증 명령이 있으면 첫 행을 따른다.

| Task 성격 | 모델 | effort |
| --- | --- | --- |
| 계획서가 있고 수정 위치와 검증 명령이 정해진 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5 | sol `low`, Sonnet `medium` |
| 수정 위치와 검증 명령이 정해진 작은 수정(설정, 주석, 문서 동기화, 작은 분기와 단위 테스트) | Claude Haiku 5.5, `gpt-6-luna` | Haiku 는 지정하지 않는다(기본값 `medium`), luna `high`(공식 시작점) |
| 단순 반영(리뷰 지적, 문구, 설정 한 줄) | Claude Haiku 5.5, `gpt-6-luna` | Haiku 는 지정하지 않는다, luna `high`. 코디네이터가 diff 를 지적 원문과 한 줄씩 대조한다 |
| 계획은 있지만 저장소를 탐색해야 하는 여러 파일 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5 | `medium`, 같은 Task 가 실패하면 `high` |
| 어려운 디버깅, 계약 설계, 데이터 마이그레이션 | Claude Opus 5.5, `gpt-6.1-sol` | Opus `medium` 시작, sol `high` |
| 화면이나 이미지를 보고 판정하는 일, 브라우저나 앱 조작 | `gpt-6.1-terra` | `low` 에서 시작. 실측 전이다. 두세 작업에 써 본 뒤 확정한다 |
| 리뷰와 검증 | 구현한 쪽과 다른 제공자의 모델. 실제로 다른 제공자가 되는지는 아래 「리뷰 제공자」 를 본다 | `medium` |
| 공격 경로를 재현하거나 exploit 형태의 검증이 필요한 보안 리뷰 | Claude Sonnet 5.5, Claude Opus 5.5. Codex 에 맡기지 않는다 | `medium` |

### 두 모델을 나란히 둔 행

후보가 둘인 행에서 Task 성격으로 갈리지 않으면 아래 순서로 고른다. 익숙한 제공자로 기울지 않게 하려는 규칙이다.

1. **리뷰 다양성.** 저장소의 CI 자동 리뷰 제공자(오버레이에 적는다)와 다른 제공자로 구현을 맡긴다. CI 리뷰가 Claude(`claude-review`)인 저장소에서 구현을 Codex 에 맡기면 리뷰가 자동으로 다른 제공자가 된다
2. **사용 한도 분산.** 지금 떠 있는 worker 가 한 제공자에 몰려 있으면 다른 제공자로 띄운다. 한 제공자에 몰리면 한도에 걸릴 때 모든 worker 가 함께 멈춘다
3. 둘 다 같으면 가격이 낮은 쪽을 고른다

### 리뷰 제공자

「리뷰와 검증은 구현과 다른 제공자」 는 코디네이터가 따로 띄우는 리뷰 worker 에만 지켜진다.

- `build-with-teams` 안의 critic, code-reviewer 는 그 worker 와 같은 제공자로 돈다. 팀원은 worker 의 하네스가 띄운다([`team-spawn.md`](../../build-with-teams/references/team-spawn.md) 「하네스별 대응」)
- 저장소 CI 리뷰의 제공자는 저장소마다 다르다. CI 리뷰가 구현과 같은 제공자면 그 PR 에는 다른 제공자의 눈이 없다
- 다른 제공자의 리뷰가 필요하면 구현 worker 와 다른 제공자의 리뷰 worker 를 머지 전에 따로 띄우거나, 위 「리뷰 다양성」 으로 구현 제공자를 CI 리뷰와 다르게 고른다

### 사용 한도에 걸렸을 때

같은 등급의 다른 제공자로 바꾸거나 한 단계 아래로 내린다. 한도에 걸려도 아래 「기본 후보에서 뺀 모델」 로 올리지 않는다.

| 걸린 모델 | 같은 등급 대응 | 한 단계 아래 |
| --- | --- | --- |
| Claude Opus 5.5 | `gpt-6.1-sol` `high` | Claude Sonnet 5.5 |
| `gpt-6.1-sol` `high` | Claude Opus 5.5 | `gpt-6.1-sol` `medium` |
| Claude Sonnet 5.5 | `gpt-6.1-sol` | Claude Haiku 5.5 |
| `gpt-6.1-sol` | Claude Sonnet 5.5 | `gpt-6-luna` |
| Claude Haiku 5.5 | `gpt-6-luna` | 없음. 한도가 풀릴 때까지 기다린다 |
| `gpt-6-luna` | Claude Haiku 5.5 | 없음. 한도가 풀릴 때까지 기다린다 |

주 산출물이 한국어 문서인 작업은 Codex 로 바꾸지 않고 한 단계 아래 Claude 로 내린다. hook 이 없는 쪽으로 옮기면 한국어 표기 검사가 빠진다.
바꾼 모델은 이어 쓰는 지시서의 `worker 선택:` 줄에 반영한다. 줄과 다르면 `launch-worker` 가 거부한다.

### 기본 후보에서 뺀 모델

아래 두 모델은 가격 대비 효과가 낮아 worker 와 하위 에이전트의 후보에 넣지 않는다(사용자 결정 2026-10-30). 가장 어려운 작업도 Claude Opus 5.5 나 `gpt-6.1-sol` `high` 까지 쓴다.

| 모델 | 입력 / 출력 ($/1M 토큰) | 뺀 이유 |
| --- | --- | --- |
| Claude Fable 5.1 | 10 / 50 | Opus 5.5(4 / 20)의 2.5배다. 공식 기본 effort 가 `high` 라 한 Task 의 토큰도 더 든다 |
| `gpt-6-astra` | 10 / 50 | sol(2 / 10)의 5배다. sol 의 공식 설명이 「astra 에 가까운 성능을 낮은 가격에」 다 |

출처는 아래 비교 근거와 같다. Fable 행은 2026-10-30 claude-api 스킬(가격 2026-10-06 기준)로 확인했다.

### 비교 근거

비교 근거다(2026-10-01 공식 자료 조사, Claude 행은 2026-10-30 claude-api 스킬로 재확인, `gpt-6.1-sol` 과 `gpt-6-astra` 행은 2026-10-30 공식 문서와 `codex debug models`(codex-cli 0.166.0)로 확인, `gpt-6.1-terra` 행은 2026-10-28 확인. 값이 바뀌면 아래 출처에서 다시 확인한다).

| 모델 | 공식 권장 용도 | 공식 effort 시작점 | 입력 / 출력 ($/1M 토큰) | 상대 속도 |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | 가장 어려운 작업. 복잡한 추론, 코딩, 컴퓨터 사용, 조사, 문서 작성 | 공식 문서에 기본값 없음. `codex debug models` 기본값은 `medium` | 10 / 50 | 공식 수치 없음 |
| `gpt-6.1-sol` | 복잡한 코딩, 컴퓨터 사용, 전문 작업. 공식 설명은 「astra 에 가까운 성능을 낮은 가격에」 | 공식 문서와 `codex debug models` 모두 `medium`(기본) | 2 / 10 | Fast 2배(사용량 증가) |
| `gpt-6.1-terra` | 시각 추론, 정밀한 컴퓨터 사용, 분명하고 자연스러운 글쓰기 | 기본 `medium`. Codex 안내에 시작점이 없고 `codex debug models` 기본값은 `low` | 1 / 5 | 공식 수치 없음 |
| `gpt-6-luna` | 집중된 대량 작업, focused coding | `high` | 0.10 / 0.50 | Fast 1.5배 |
| Claude Sonnet 5.5 | 일상 코딩과 에이전트 | 잘 정의된 Task 는 `medium`, 어렵거나 긴 Task 는 `high`(기본) | 2 / 10 | Fast |
| Claude Opus 5.5 | 장시간 에이전트 코딩과 지식 작업 | `medium`(기본) | 4 / 20 | Moderate |
| Claude Haiku 5.5 | 분류, 추출, 라우팅 같은 대량·저지연 작업 | `medium`(기본). 짧은 도구 작업은 `low`, 긴 에이전트 작업은 `high` | 0.10 / 0.50 (프롬프트 10만 토큰 초과 요청은 0.50 / 2.50) | Fastest |

- 보안 리뷰 행의 근거: 2026-10-20 인프라 저장소의 PR 리뷰를 Codex worker 에 맡겼더니 symlink 덮어쓰기, 토큰 유출 경로, 컨테이너 권한 같은 공격 경로를 재현하는 내용에서 OpenAI 의 보안 요청 제한(「This content can't be shown」)에 걸려 리뷰가 끝나지 않았다. Claude Sonnet 하위 에이전트로 옮기자 끝났다. 구현한 쪽이 Claude 라서 다른 제공자 리뷰어가 필요하면, 공격 재현이 필요 없는 범위만 Codex 에 맡기고 나머지는 구현에 관여하지 않은 Claude 에이전트가 본다
- worker 가 시작 직후 출력 없이 실패하면 [`launch.md`](launch.md) 의 「시작 직후 실패」 대로 다른 모델로 다시 띄운다
- 확인하지 못한 effort 별 코딩 점수는 선택 근거에서 뺐다. 제공자 사이의 점수도 직접 비교하지 않는다
- effort 별 지연과 비용 배수는 양쪽 공식 문서에 수치가 없다(2026-10-12 확인). 정성 설명만 있으므로 같은 Task 결과로 판단한다. Haiku 는 effort 를 지정하지 않고 공식 기본값 `medium` 을 쓴다
- astra 행은 비교를 위해 두었다. 후보에서 뺀 이유는 위 「기본 후보에서 뺀 모델」 이 갖는다
- terra 는 코딩 성능과 한국어 품질의 근거가 공식 자료에 없어 여러 파일 구현, 어려운 디버깅, 한국어 문서에 넣지 않는다
- 출처: [astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex 모델](https://learn.chatgpt.com/docs/models)
- 출처: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Claude 모델 선택](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

### 실측 기록

공식 자료만으로는 같은 Task 에서 어느 모델이 나은지 알 수 없다. terra 처럼 「실측 전」 인 행을 확정하려면 PR 마다 실측이 쌓여야 한다.

- **형식.** PR 하나에 JSON 한 줄이다. 필드는 `pr`, `repo`, `agent`, `model`, `effort`, `task`(위 모델 표의 행 이름), `additions`, `deletions`, `review_rounds`(리뷰 판정 횟수), `ci_failures`(CI 실패 횟수), `minutes`(띄운 때부터 머지까지), `merged_at` 이다
- **쓰는 자리.** orch 상태 폴더의 `routing-log.jsonl` 이다. 띄운 worker 기록(`state/launched-workers/<dispatch>.json`)에 지금은 에이전트, 모델, effort 가 없어 함께 더한다
- **쓰는 주체.** `finish-pr` 나 머지 큐가 머지 직후 그 기록과 PR 정보를 합쳐 쓴다. 구현은 후속으로 남겼다
- **다시 보는 주기.** 기록이 한 행에 열 건 쌓이거나 한 달이 지나면 행별로 모아 이 표의 후보와 effort 를 다시 본다

## effort

**모델마다 공식 시작점이 다르다. 계획서가 있으면 위 표의 낮은 쪽에서 시작한다.**

| 단계 | 올리거나 내리는 조건 |
| --- | --- |
| `low` | 계획서에 수정 위치와 검증 명령이 정해진 sol 구현. Claude 에서는 속도와 가격이 중요한 단순 Task 와 서브에이전트 |
| `medium` | 지연, 성능, 비용의 균형점. 모델과 Task 에 따라 위 선택 표를 따른다 |
| `high` | 어려운 디버깅이나 깊은 계획. 같은 Task 가 `medium` 에서 실패했을 때 올린다 |
| `xhigh`, `max` | 기본으로 쓰지 않는다. 같은 Task 에서 `high` 보다 낫다는 결과가 있을 때만 |
| `ultra` | worker 에 쓰지 않는다. 스스로 subagent 를 띄워 코디네이터가 모르는 작업자가 생긴다 |

높은 effort 는 추가 작업과 비용을 늘릴 수 있다.

- Claude 의 `xhigh`, `max` 는 스스로 리뷰 라운드를 돌리고 reviewer subagent 를 띄워 비용이 커진다
- `high` 이상은 요청하지 않은 변경과 저장소 관례에 맞지 않는 커밋 제목을 낼 수 있다. 계획서가 충분하면 낮은 effort 로 빠르게 끝낸다
- 출처: [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)

## Codex 에 넘기는 방법

`~/.codex/config.toml` 의 `model` 은 대화형 codex 의 기본값이라, 그대로 넘기면 모든 Task 가 같은 모델로 돈다.
`--model` 과 `--effort` 를 함께 넘긴다.
고를 수 있는 모델과 effort 목록은 아래 명령으로 본다.

```bash
codex debug models | python3 -c "import json,sys; d=json.load(sys.stdin); [print(m['slug'], '|', m['description'], '|', ','.join(l['effort'] for l in m['supported_reasoning_levels'])) for m in d['models'] if m.get('visibility')=='list']"
```

`~/.codex/models_cache.json` 은 읽지 않는다. 대화형 codex 를 띄울 때만 갱신돼 새 모델이 빠진다.
기본 service tier 가 `priority`(Fast)일 수 있고, Fast 는 사용량이 늘어난다. 실제 적용 값은 `worker-start` 응답의 `launch.effective` 로 확인한다.
