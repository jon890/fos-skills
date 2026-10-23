# 1. 에이전트 고르기

**모델과 effort 는 Task 마다 성능과 가격을 비교해 고르고, 고른 이유를 dispatch 보고에 한 줄로 남긴다.**
기본값을 두지 않는다. 사용자가 지정하면 그것을 따른다.
문서의 명령 예시는 이 단계에서 고른 값을 `$AGENT`, `$MODEL`, `$EFFORT` 변수로 받는다.
쓰지 않을 모델은 사용자 지침이나 오버레이가 정한다.

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
| 리뷰와 검증 | 구현한 쪽과 다른 제공자의 모델 | `medium` |
| 공격 경로를 재현하거나 exploit 형태의 검증이 필요한 보안 리뷰 | Claude Sonnet 5.5, Claude Opus 5.5. Codex 에 맡기지 않는다 | `medium` |

비교 근거다(2026-10-01 공식 자료 조사, Claude 행은 2026-10-12 재확인. 값이 바뀌면 아래 출처에서 다시 확인한다).

| 모델 | 공식 권장 용도 | 공식 effort 시작점 | 입력 / 출력 ($/1M 토큰) | 상대 속도 |
| --- | --- | --- | --- | --- |
| `gpt-6.1-sol` | 복잡한 리팩터링, 코드베이스 조사, 장기 에이전트 | `medium`(기본) | 2 / 10 | Fast 2배(사용량 증가) |
| `gpt-6-luna` | 집중된 대량 작업, focused coding | `high` | 0.10 / 0.50 | Fast 1.5배 |
| Claude Sonnet 5.5 | 일상 코딩과 에이전트 | 잘 정의된 Task 는 `medium`, 어렵거나 긴 Task 는 `high`(기본) | 2 / 10 | Fast |
| Claude Opus 5.5 | 장시간 에이전트 코딩과 지식 작업 | `medium`(기본) | 4 / 20 | Moderate |
| Claude Haiku 5.5 | 분류, 추출, 라우팅 같은 대량·저지연 작업 | `medium`(기본). 짧은 도구 작업은 `low`, 긴 에이전트 작업은 `high` | 0.10 / 0.50 (프롬프트 10만 토큰 초과 요청은 0.50 / 2.50) | Fastest |

- 보안 리뷰 행의 근거: 2026-10-20 인프라 저장소의 PR 리뷰를 Codex worker 에 맡겼더니 symlink 덮어쓰기, 토큰 유출 경로, 컨테이너 권한 같은 공격 경로를 재현하는 내용에서 OpenAI 의 보안 요청 제한(「This content can't be shown」)에 걸려 리뷰가 끝나지 않았다. Claude Sonnet 하위 에이전트로 옮기자 끝났다. 구현한 쪽이 Claude 라서 다른 제공자 리뷰어가 필요하면, 공격 재현이 필요 없는 범위만 Codex 에 맡기고 나머지는 구현에 관여하지 않은 Claude 에이전트가 본다
- worker 가 시작 직후 출력 없이 실패하면 [`launch.md`](launch.md) 의 「시작 직후 실패」 대로 다른 모델로 다시 띄운다
- 확인하지 못한 effort 별 코딩 점수는 선택 근거에서 뺐다. 제공자 사이의 점수도 직접 비교하지 않는다
- effort 별 지연과 비용 배수는 양쪽 공식 문서에 수치가 없다(2026-10-12 확인). 정성 설명만 있으므로 같은 Task 결과로 판단한다. Haiku 5.5 는 아래 실측에서 `low` 와 `medium` 의 품질과 걸린 시간이 같았다(토큰 사용량은 재지 않았다)
- worker 작업에서 Haiku 가 Sonnet 보다 빠르지 않았다. 공식 소개의 「가장 빠름」 은 이 작업에서 나타나지 않았다
- 출처: [sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex 모델](https://learn.chatgpt.com/docs/models)
- 출처: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Claude 모델 선택](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

### Haiku 5.5 실측 (2026-10-20)

작은 작업 3종을 Haiku 5.5 `low`, Haiku 5.5 `medium`, Sonnet 5.5 `medium` 으로 각자 한 번씩 돌렸다.
구현하지 않은 Opus 리뷰어가 모델을 모르는 채 머지된 정답 diff 와 비교해 채점했다.

| 작업 성격 | Haiku `low` | Haiku `medium` | Sonnet `medium` |
| --- | --- | --- | --- |
| 설정 값 한 줄, 주석, 문서 동기화 (8점) | 7 | 6 | 6 |
| 리뷰 지적을 문서 한 줄로 반영 (8점) | 6 | 6 | 8 |
| 작은 분기 수정과 단위 테스트, 수정 위치를 지시서가 줌 (10점) | 8 | 8 | 8 |
| 합계 (26점) | 21 | 20 | 22 |
| 걸린 시간 합계 | 16.7분 | 16.9분 | 12.5분 |

- 품질은 거의 같았고 가격은 Haiku 가 Sonnet 의 1/20 이다
- `low` 와 `medium` 은 품질과 시간 차이가 없어 Haiku effort 는 지정하지 않는다
- 약점: 리뷰 지적이나 요구 문장을 해석해 옮길 때 지적에 없는 조건을 지어내거나 일부를 빠뜨렸다(두 조합 모두 한 번씩). Sonnet 은 정답과 같았다. 그래서 문구 반영 행에는 지적 원문과의 대조를 붙였다
- 한계: 작업마다 한 번씩만 돌려 표본이 작다. PR 생성, 리뷰 회신, 스레드 정리까지 가는 긴 흐름은 재지 않았다

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
