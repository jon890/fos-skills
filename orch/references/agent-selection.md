# 1. 에이전트 고르기

**모델과 effort 는 Task 마다 성능과 가격을 비교해 고르고, 고른 이유를 dispatch 보고에 한 줄로 남긴다.**
기본값을 두지 않는다. 사용자가 지정하면 그것을 따른다.
쓰지 않을 모델은 사용자 지침이나 오버레이가 정한다.

## 모델

계획서의 구체성과 필요한 탐색에 따라 고른다.
인증과 권한 작업도 계획서에 수정 위치와 검증 명령이 있으면 첫 행을 따른다.

| Task 성격 | 모델 | effort |
| --- | --- | --- |
| 계획서가 있고 수정 위치와 검증 명령이 정해진 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5 | sol `low`, Sonnet `medium` |
| 단순 반영(리뷰 지적, 문구, 설정 한 줄) | `gpt-6-luna`, Claude Haiku 5.5 | luna `high`(공식 시작점), Haiku `low`(짧은 작업) 또는 `medium` |
| 계획은 있지만 저장소를 탐색해야 하는 여러 파일 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5 | `medium`, 같은 Task 가 실패하면 `high` |
| 어려운 디버깅, 계약 설계, 데이터 마이그레이션 | Claude Opus 5.5, `gpt-6.1-sol` | Opus `medium` 시작, sol `high` |
| 리뷰와 검증 | 구현한 쪽과 다른 제공자의 모델 | `medium` |

비교 근거다(2026-10-01 공식 자료 조사, Claude 행은 2026-10-12 재확인. 값이 바뀌면 아래 출처에서 다시 확인한다).

| 모델 | 공식 권장 용도 | 공식 effort 시작점 | 입력 / 출력 ($/1M 토큰) | 상대 속도 |
| --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | 복잡한 리팩터링, 코드베이스 조사, 장기 에이전트 | `medium`(기본) | 2 / 10 | Fast 2배(사용량 증가) |
| `gpt-6-luna` | 집중된 대량 작업, focused coding | `high` | 0.10 / 0.50 | Fast 1.5배 |
| Claude Sonnet 5.5 | 일상 코딩과 에이전트 | 잘 정의된 Task 는 `medium`, 어렵거나 긴 Task 는 `high`(기본) | 2 / 10 | Fast |
| Claude Opus 5.5 | 장시간 에이전트 코딩과 지식 작업 | `medium`(기본) | 4 / 20 | Moderate |
| Claude Haiku 5.5 | 분류, 추출, 라우팅 같은 대량·저지연 작업 | `medium`(기본). 짧은 도구 작업은 `low`, 긴 에이전트 작업은 `high` | 0.10 / 0.50 (프롬프트 10만 토큰 초과 요청은 0.50 / 2.50) | Fastest |

- worker 가 시작 직후 출력 없이 실패하면 [`launch.md`](launch.md) 의 「시작 직후 실패」 대로 다른 모델로 다시 띄운다
- 확인하지 못한 effort 별 코딩 점수는 선택 근거에서 뺐다. 제공자 사이의 점수도 직접 비교하지 않는다
- effort 별 지연과 비용 배수는 양쪽 공식 문서에 수치가 없다(2026-10-12 확인). 정성 설명만 있으므로 같은 Task 결과로 판단한다
- 출처: [sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex 모델](https://learn.chatgpt.com/docs/models)
- 출처: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Claude 모델 선택](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

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
