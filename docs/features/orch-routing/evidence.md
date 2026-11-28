# orch worker 모델 선택 실측 근거 (2026-11-05)

스펙 [`spec.md`](spec.md) 의 근거다. 원자료가 다른 세션의 임시 폴더에 있어 사라질 수 있으므로 판단에 쓴 표만 옮겨 둔다.

## 자료와 범위

- 대상: ai-analysis 저장소의 orch worker PR 486건, 2026-10-22~11-05. 한 저장소만 본 표다.
- 출처: Orca `orchestration.db`(dispatch, 메시지, 질문 스레드)를 읽기 전용으로 읽고, GitHub PR·리뷰·CI 실행과 Orca 의 Claude·Codex 사용량 파일을 PR 에 이었다. 집계는 그 세션의 `aggregate.py`, `analyze.py` 가 했다.
- 모델과 effort 는 `worker-start` 의 `launch.effective` 값이다. 한 PR 에 dispatch 가 여럿이면 몫을 나눠 셌다.
- 「준비」 는 띄운 때부터 `준비됨` status(또는 merge_ready)까지다. 「첫 리뷰 P1·P2」 는 첫 `claude-review` 판정의 실질 지적 수다. 「크기」 는 저장소의 PR 크기 등급(A 가 작다)이다.
- 비용은 사용량 파일의 토큰에 이 문서 「비교 근거」 의 가격을 곱한 추정이다. Claude 캐시 쓰기 배수는 추정이다.
- PR 제목과 업무 번호는 옮기지 않았다.

## 표 1. 결과 품질과 속도 (표본 20건 이상)

| 모델 effort | PR 수 | 본 코드 줄 중앙 | 준비 중앙/p90(시간) | 머지 중앙(시간) | 첫 리뷰 P1·P2 평균 | P3 평균 | 리뷰 뒤 커밋 평균 |
| --- | --: | --: | --: | --: | --: | --: | --: |
| Opus 5.5 high | 212 | 329 | 1.3 / 7.5 | 2.2 | 0.02 | 0.68 | 3.9 |
| Opus 5.5 medium | 69 | 141 | 0.8 / 1.8 | 1.1 | 0.04 | 0.44 | 2.8 |
| Opus 5.5 기본 | 37 | 289 | 0.6 / 3.1 | 1.6 | 0.03 | 0.74 | 2.5 |
| Sonnet 5.5 high | 51 | 267 | 0.9 / 2.3 | 1.3 | 0.06 | 0.65 | 2.6 |
| Sonnet 5.5 medium | 46 | 84 | 0.3 / 1.2 | 0.7 | 0.04 | 0.57 | 2.6 |
| sol high | 30 | 217 | 0.9 / 2.6 | 2.2 | 0.00 | 1.07 | 5.0 |
| sol medium | 22 | 6 | 0.4 / 1.7 | 1.2 | 0.05 | 0.19 | 2.2 |

## 표 2. 개입, CI, 비용

| 모델 effort | 질문 평균 | worker escalation 평균 | 무보고 종료 평균 | 사용 한도 걸림(합) | 코디네이터 지시 평균 | CI 실패 평균(실패 PR 비율) | 머지 뒤 되돌림 | 비용 추정 중앙($) | 출력 토큰 중앙(천) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Opus 5.5 high | 0.90 | 0.07 | 0.33 | 14 | 2.66 | 0.09 (8%) | 0 | 21.15 | 132 |
| Opus 5.5 medium | 0.80 | 0.04 | 0.16 | 2 | 1.27 | 0.10 (9%) | 0 | 10.89 | 68 |
| Opus 5.5 기본 | 0.27 | 0.03 | 0.05 | 0 | 1.92 | 0.05 (5%) | 1 | 20.18 | 97 |
| Sonnet 5.5 high | 0.24 | 0.04 | 0.00 | 0 | 1.40 | 0.21 (9%) | 0 | 3.98 | 49 |
| Sonnet 5.5 medium | 0.20 | 0.04 | 0.04 | 0 | 1.11 | 0.26 (14%) | 0 | 1.57 | 19 |
| sol high | 2.17 | 0.69 | 0.23 | 0 | 3.94 | 0.03 (3%) | 0 | 7.30 | 74 |
| sol medium | 0.64 | 0.36 | 0.05 | 0 | 2.09 | 0.09 (9%) | 0 | 4.13 | 25 |

사용 한도 걸림은 PR 몫으로 나눠 센 값이다. 걸린 PR 은 모두 Opus 였다(high 8건, medium 1건).

## 표 3. 크기 등급별 (준비 중앙, 첫 리뷰 P1·P2 평균, 리뷰 뒤 커밋 평균, 비용 중앙)

| 모델 effort | A | B | C |
| --- | --- | --- | --- |
| Opus 5.5 high | n=42: 1.1h, 0.00, 1.7, $9.1 | n=46: 1.0h, 0.02, 2.8, $13.5 | n=123: 1.6h, 0.03, 5.1, $31.8 |
| Opus 5.5 medium | n=25: 0.5h, 0.00, 2.1, $7.4 | n=22: 0.8h, 0.00, 2.3, $10.6 | n=22: 0.7h, 0.14, 4.2, $13.9 |
| Sonnet 5.5 high | n=11: 0.3h, 0.00, 1.9, $3.3 | n=15: 0.7h, 0.07, 2.5, $3.9 | n=25: 1.1h, 0.08, 3.0, $11.6 |
| Sonnet 5.5 medium | n=29: 0.3h, 0.00, 1.4, $1.3 | n=7: 0.3h, 0.29, 2.7, $3.4 | n=10: 0.5h, 0.00, 6.1, $2.2 |
| sol high | n=2: 2.6h, 0.00, 3.0, $5.7 | n=15: 0.8h, 0.00, 3.9, $8.6 | n=13: 0.9h, 0.00, 6.5, $7.3 |
| sol medium | n=11: 0.3h, 0.00, 1.4, $3.9 | n=5: 0.3h, 0.00, 1.8, $5.1 | n=6: 0.5h, 0.20, 4.6, $13.8 |

## 지시서의 선택

같은 기간 지시서 가운데 `worker 선택:` 줄이 있는 77건에서 Opus high 가 64건(83%)이다. 다음은 Sonnet medium 8건, Opus medium 3건이다.
지침([agent-selection.md](../../../skills/orch/references/agent-selection.md) 「모델」 표)은 Opus 를 `medium` 에서 시작하라고 적고 있다.

## 읽은 것

- 결과 품질(첫 리뷰 P1·P2, 리뷰 뒤 커밋, CI 실패, 되돌림)은 모델과 effort 사이 차이가 작다. 첫 리뷰 P1·P2 는 어느 행이든 PR 당 0.06 이하다.
- 같은 크기에서 Opus high 는 medium 보다 준비가 늦고 비용이 높다. 크기 C 에서 준비 1.6h 대 0.7h, 비용 $31.8 대 $13.9 다. high 가 결과를 낫게 했다는 신호는 없다.
- 사용 한도에 걸린 PR 은 모두 Opus 였다.
- sol 은 CI 실패가 가장 적지만 질문과 코디네이터 지시가 가장 많다(high 질문 2.17, 지시 3.94). 코디네이터 세션의 정리로는 질문 다수가 실행 전 확인이었고, escalation 다수는 머지 대기 알림(status 로 보낼 내용)이었다.
- 한계: 저장소 하나, 2주, Task 를 무작위로 배정하지 않았다. 코디네이터가 어려운 Task 에 Opus high 를 골랐을 수 있어, 표만으로는 effort 의 효과를 따로 떼어 보지 못한다. 그래서 스펙의 비교 실험 줄과 기록을 둔다.

## 2026-11-09 sol medium 과 Opus medium 비교

사용자 결정(2026-11-09)으로 `gpt-6.1-sol` `medium` 을 Claude Opus 5.5 `medium` 과 같은 등급으로 본다. 이 절은 그 결정의 근거 수치를 모은다. 수치는 위 표 1·2·3 과 코디네이터 정리(2026-11-09)에서 옮겼고, 표본과 한계는 위 「자료와 범위」 와 같다.

| 항목 | sol medium | Opus 5.5 medium | 출처 |
| --- | --: | --: | --- |
| 첫 리뷰 P1·P2 평균(크기 C) | 0.20 | 0.14 | 표 3 과 코디네이터 정리 |
| CI 실패 PR 비율 | 9% | 9% | 표 2 |
| 준비 중앙값(크기별) | 0.3에서 0.5시간 | 0.5에서 0.8시간 | 표 3 과 코디네이터 정리 |
| 비용 중앙값 | $4.1 | $10.9 | 표 2 |
| worker escalation 평균 | 0.36 | 0.04 | 표 2 |
| 코디네이터 지시 평균 | 2.09 | 1.27 | 표 2 |
| 리뷰 뒤 커밋 평균 | 2.2 | 2.8 | 표 1 |

- fos-skills 저장소의 2026-11-05 이후 sol medium `impl-explore` 14건은 첫 리뷰 P1 0.08, P2 0.42, CI 실패 0.07, 질문 0.07 이었다(코디네이터 정리).
- fos-skills 저장소에서 sol medium 의 리뷰 뒤 커밋 평균은 6.4 였다(코디네이터 정리). 리뷰 지적마다 커밋을 따로 만든 결과다. 위 표 1 의 2.2 와는 다른 저장소의 값이다.
- 한계: 두 모델이 맡은 일의 종류가 다르다. Opus 는 설계 일이 많아 엄밀한 비교가 아니다.
- 바뀐 조건: `orch` 구조 정리 PR1(#404)로 `orch worker ask` 가 질문을 보내고 바로 끝난다. 질문 한 번이 worker 를 붙잡지 않으므로, 질문이 많다는 이유만으로 sol 을 뺄 근거가 약해졌다. 그래서 sol 을 막는 조건은 「사용자 결정이나 설계 판단이 남은 Task」 로 좁혔다.

## 2026-11-10 small-fix 의 Haiku 와 Sonnet

사용자 결정(2026-11-10)으로 small-fix 를 두 모델로 나눈다. 분기 논리가 없는 문서·문구·설정·정규식 한 줄 고침은 Claude Haiku 5.5 를 첫 후보로 두고, 분기나 상태를 다루는 small-fix 는 Claude Sonnet 5.5 `medium` 을 첫 후보로 둔다. 이 절은 그 결정의 근거 수치를 모은다. 수치는 `orch routing report --since 2026-11-05` 의 fos-skills 저장소 값이다.

| 모델 effort | PR 수 | 첫 리뷰 P1 | 첫 리뷰 P2 평균 | CI 실패 | 리뷰 뒤 커밋 | 비용 중앙값 |
| --- | --: | --: | --: | --: | --: | --: |
| Haiku 5.5 기본(medium) | 5 | 0 | 0.6 | 0 | 1 | $0.18 |
| Sonnet 5.5 medium | 3 | - | 0 | 0.67 | - | - |

- Haiku 다섯 건 가운데 문서와 정규식만 고친 셋(#400, #402, #408)은 첫 리뷰에서 차단 지적이 없었다. 분기 논리를 고친 둘(#399 의 P2 2건, #407 의 P2 1건)은 차단 버그가 나왔다.
- Haiku 의 준비 중앙값 4.4시간은 2026-11-09 PC 부하(load 180)와 전체 테스트 자리 대기로 오염됐다. 이 값은 판단에 쓰지 않는다.
- Sonnet 3건의 CI 실패 0.67 은 표본이 적어 방향을 정하지 못한다. 표의 「-」 는 그 값이 집계에 없다는 뜻이다.
- 한계: 저장소 하나, 표본 5건과 3건이라 통계적 차이를 말할 수 없다. Task 를 무작위로 배정하지 않았다. 이 표는 첫 후보를 정하는 근거일 뿐이며, 실측이 쌓이면 다시 본다.

## 2026-11-10 제공자 자리 짝과 구현 effort

사용자 결정(2026-11-10)으로 두 가지를 정한다. 제공자 안에서 같은 자리를 짝으로 보고(사용 한도 대체 표에 쓴다), 계획을 마친 구현의 effort 를 Opus 와 sol 은 `medium` 까지, Sonnet 은 `high` 를 기본으로 한다. 아래 수치는 출처와 수집일을 함께 적고, 반대 근거도 같이 적는다.

### 자리 짝

제공자 안의 같은 자리(주력, 중간, 소형)를 짝으로 본다: `gpt-6.1-sol` ↔ Claude Opus 5.5, `gpt-6.1-terra` ↔ Claude Sonnet 5.5, `gpt-6-luna` ↔ Claude Haiku 5.5. 코딩 능력이 같다는 뜻이 아니다. 코딩 점수는 Sonnet, Sol, Terra 순이다.

| 모델 | AA 코딩 에이전트 지수 v2.0(최상위 effort) | Bito 실측(모두 medium) |
| --- | --: | --: |
| Claude Opus 5.5 | 61.7 | 85% |
| Claude Sonnet 5.5 | 59.3 | 77% |
| `gpt-6.1-sol` | 54.1 | 74% |
| `gpt-6.1-terra` | 48.2(xhigh) | 69% |
| Claude Haiku 5.5 | 37.3 | 76% |
| `gpt-6-luna` | 31.2 | 측정 없음 |

- AA 지수는 BenchLM 미러(https://benchlm.ai/benchmarks/aacodingagents, 2026-11-09 수집)다. terra 를 effort 별로 보면 high 46.3, medium 42.0, low 34.9 다.
- Bito 실측(https://bito.ai/blog/gpt-6-1-terra-vs-claude-opus-sonnet-haiku/, 2026-10-28)은 모두 medium 이다. 채점자가 Opus 5.5 라 편향이 있을 수 있다.
- 같은 짝을 쓴 언론(Decrypt, 2026-09-22)이 있으나 근거가 없는 의견이라 수치로 쓰지 않는다.

### 계획을 마친 구현의 effort

- Anthropic effort 문서(https://platform.claude.com/docs/en/build-with-claude/effort): Sonnet 5.5 는 요구가 분명한 에이전트 코딩을 `medium` 에서 시작하고, 어렵거나 긴 일은 `high` 를 쓴다. 기본값은 Opus 와 Haiku 가 `medium`, Sonnet 이 `high` 다.
- Terminal-Bench 4.0(Anthropic 이 Claude Code 로 측정, Harry Smaje 정리 https://smaje.net/blog/reasoning-effort, 2026-10-17): Opus 5.5 는 low 38.5, medium 57.6, high 64.2, xhigh 66.4, max 64.8 이다. Sonnet 5.5 는 low 20.0, medium 28.8, high 43.0, xhigh 61.5, max 70.6 이다. Opus 는 medium 에서 대부분을 얻고, Sonnet 은 effort 에 매우 민감하다.
- 반대 근거: ax0x 실측(https://blog.ax0x.ai/opus-55-medium-vs-high, 2026-09-22)은 Opus 5.5 medium 과 high 가 숨긴 테스트를 모두 통과했고, 블라인드 판정은 high 16승, medium 7승, 무승부 21(p≈0.09)이었다. 저자는 p≈0.09 를 유의하지 않다고 보고 경향(lean)이라고 했다. high 가 이긴 쌍 대부분은 테스트가 잡지 못한 실제 버그를 잡은 것이었다. 저자의 결론은 사람이 diff 를 보지 않는 무인 에이전트는 high, 사람이 diff 를 보는 짝 작업은 medium 이다. high 는 시간 약 1.33배, 비용 약 1.29배다.
- 우리가 그래도 medium 을 상한으로 두는 이유(추정): 지시서 worker 는 뒤에 독립 리뷰와 CI 가 있고, 위 차이가 통계로 확정되지 않았으며, 우리 실측에서 high 의 품질 개선 신호가 없었다.
- 우리 실측: Opus high 는 크기 C 에서 준비 1.6시간, 비용 $31.8 이었고 medium 은 0.7시간, $13.9 였다(표 3). 준비와 비용이 두 배 남짓인데 품질 개선 신호가 없었다.
- 우리 실측 Sonnet medium: fos-skills 저장소의 2026-11-05 이후 Sonnet medium `impl-explore` 13건은 첫 리뷰 P2 평균 1.15 다. 같은 기간 sol medium 14건은 0.42 다(코디네이터 정리). 이 수치는 Sonnet 구현을 `high` 로 올리는 근거 가운데 하나다. 표본이 작아 방향만 본다.
- 한계: 같은 계획을 medium 과 high 로 구현해 비교한 직접 측정은 찾지 못했다. effort 이름은 제공자와 세대마다 뜻이 달라 Opus medium 과 sol medium 은 같은 양이 아니다(OpenAI 모델 안내 https://learn.chatgpt.com/docs/models). 저장소 하나, 표본이 작다.
- 결정: 계획을 마친 구현(`impl-planned`, `impl-explore`)에서 Opus 5.5 와 sol 은 `medium` 을 넘기지 않는다. Sonnet 5.5 는 `high` 가 기본이다. 실패하면 sol 과 Opus 는 effort 를 올리지 않고 모델을 바꾼다. Sonnet 의 medium 과 high 는 실측 기록(`routing-log.jsonl`)이 쌓이면 다시 본다. 집계 방법은 [실측 기록](../../../skills/orch/references/agent-selection.md#실측-기록) 절이다.

## 2026-11-10 Claude Fable 5.2 (실험 전 수치)

사용자 결정(2026-11-10)으로 Fable 5.2 를 바로 후보에 넣지 않고 크고 어려운 일 다섯 건에 실험했다. 이 절은 실험을 시작하기 전에 본 공개 수치를 모은다. 실험 결과는 아래 「2026-11-12 Fable 5.2 실험 결과」 절이다. 수치는 2026-11-10 에 수집했고, 값이 바뀌면 아래 출처에서 다시 확인한다.

- 모델 id 는 `claude-fable-5-2` 다(`--model fable` 도 5.2 로 풀린다). 2026-11-10 코디네이터가 `claude -p --model claude-fable-5-2` 로 응답을 확인했다. 공개는 2026-11-09 다.
- 가격은 입력 8, 출력 40($/1M 토큰)이다. Fable 5.1 은 10 / 50, Opus 5.5 는 4 / 20 이다.
- Artificial Analysis 작업 한 건(최상위 effort): Fable 5.2 26.54달러·46.4분, Opus 5.5 약 10달러다. 코딩 에이전트 지수의 작업 한 건은 Opus 5.5 11.42달러, sol 1.50달러다.
- Anthropic 측정(Fable 5.2 / Opus 5.5): FrontierSWE v2 69.9 / 62.3, FrontierCode 2.0 49.1(xhigh) / 45.5, SWE-bench Pro 93.0 / 89.9, Terminal-Bench 4.0 67.6 / 66.4(오차 안).
- 독립 측정 Vals AI(Fable 5.2 / Opus 5.5): Terminal-Bench 4.0 65.15 / 65.15, ProgramBench 19.0 / 18.5, SWE-bench Multimodal 62.3 / 70.2.
- Artificial Analysis 지능 지수 v5: Fable 5.2 max 65, high 62(출력 토큰 40% 적음), Opus 5.5 max 59, sol max 55. 코딩 에이전트 지수 v2.0 은 Opus 5.5 61.7, Fable 5.1 57.6, sol 54.1 이고 Fable 5.2 는 아직 없다.
- 읽기: 몇 시간짜리 큰 작업(FrontierSWE)에서만 뚜렷이 앞선다. 독립 측정의 터미널 작업은 Opus 와 같다. Anthropic 은 일상 작업에 Opus 5.5 를 권한다. 그래서 큰 일 다섯 건만 실험했다.
- 출처: [llm-stats(Anthropic 수치)](https://llm-stats.com/blog/research/claude-fable-5-2-launch), [Vals AI](https://www.vals.ai/models/anthropic_claude-fable-5-2), [Artificial Analysis](https://artificialanalysis.ai/models/claude-fable-5-2), [Artificial Analysis 발표](https://x.com/ArtificialAnlys/status/2119878995386982508), [The Decoder](https://the-decoder.com/claude-fable-5-2-and-mythos-5-2-cement-anthropics-ai-lead-just-before-its-ipo/), [CNBC](https://www.cnbc.com/2026/11/09/anthropic-claude-fable-5-2-mythos-5-2.html), [Fortune](https://fortune.com/2026/11/09/anthropic-debuts-updated-claude-fable-and-mythos-models-undercutting-price-of-openais-gpt-6-astra-by-up-to-80/)

## 2026-11-12 Fable 5.2 실험 결과

2026-11-12 에는 Fable 5.2 를 큰 구조 정리에만 후보로 두고 설계는 Opus·sol 에 맡기기로 했다. 현재 선택 규칙은 [모델 표](../../../skills/orch/references/agent-selection.md#모델) 가 소유한다.

다섯 건을 코디네이터가 보드와 PR 에서 모았다. 모두 `high` 다. 표본이 작아 방향만 본다.

| 실험 | 작업 | 크기 | 띄운 뒤 PR 까지 | 첫 리뷰 차단 |
| --- | --- | --- | --- | --- |
| 1/5 | 상주 루프를 lifecycle 과 틱 단계로 나눔 | 61파일 +4196/−2888 | 약 1시간 25분 | 0(권장 0) |
| 2/5 | 보드 명령 technical-design | 9파일 +942 | 기록 없음 | 2 |
| 3/5 | 보드 자동 진행 technical-design | 10파일 +1284 | 기록 없음 | 3 |
| 4/5 | 스킬 문서 히스토리 정리와 호환 제거 | 71파일 +279/−607 | 기록 없음 | 0(권장 0) |
| 5/5 | 보드 읽기 명령 technical-design | 8파일 +937 | 약 43분 | 2 |

- 구조 정리 두 건(1/5, 4/5)은 크기가 커도 첫 리뷰 차단과 권장이 0 이었다. 설계 세 건(2/5, 3/5, 5/5)은 차단 2·3·2 로 같은 날 Opus `medium` 의 보드 승인 설계(8파일 +781, 차단 2)와 차이가 없었다. 그래서 구조 정리에만 후보로 둔다.
- 비교: 같은 날 sol `medium` 의 정리·머지 큐 단계 분리(15~22파일)는 차단 0, 권장 3·2 였다. 이 크기는 Fable 건보다 훨씬 작다.
- 비용은 1/5 에서 Fable 주간 한도의 6% 만 실측했다. 나머지 건은 비용 기록이 없다. 가격은 Opus 의 2배다.

## 2026-11-10 질문이 남은 설계 작업의 sol 후보

사용자 결정(2026-11-10)으로 사용자 결정이나 설계 판단이 남은 Task 에도 sol 을 후보로 둔다. `orch worker ask` 가 질문을 보내고 바로 끝나도록 바뀐 뒤(#404), 같은 날 Codex worker 들이 마이그레이션 순서·gate·보드 명령에 관한 판단 질문을 문제없이 보냈다는 코디네이터의 관측을 근거로 삼았다. 질문 처리 사례이며 설계 품질의 우위를 입증한 비교 실험은 아니다. 주 산출물이 한국어 문서인 spec 인터뷰는 한국어 표기 검사 hook 이 있는 Claude 를 유지하고, `technical-design` 과 `hard-design` 은 Claude Opus 5.5 medium 과 sol 을 번갈아 쓴 결과를 실측 기록으로 비교한다.

## 지침에서 옮긴 모델 조사와 제외 근거

기존 모델 선택 지침에 있던 조사 기록을 보존한다. 현재 선택 규칙은 [agent-selection.md](../../../skills/orch/references/agent-selection.md) 가 소유한다.

`gpt-6-astra` 는 worker 와 하위 에이전트의 기본 후보에 넣지 않는다. 가격 대비 효과가 낮아서다(사용자 결정 2026-10-30). Claude Fable 5.2 는 2026-11-10 에 기본 후보에서 뺐다가 실험 뒤 큰 구조 정리에만 후보로 올렸다(사용자 결정 2026-11-12, [현재 Fable 선택](../../../skills/orch/references/agent-selection.md#모델)). 가장 어려운 작업도 Claude Opus 5.5 나 `gpt-6.1-sol` `high` 까지 쓴다.

| 모델 | 입력 / 출력 ($/1M 토큰) | 비고 |
| --- | --- | --- |
| Claude Fable 5.2 | 8 / 40 | Opus 5.5(4 / 20)의 2배다. 작업 한 건 비용은 2.6배다(Artificial Analysis, 2026-11-10). 가격 때문에 큰 구조 정리에만 후보다 |
| `gpt-6-astra` | 10 / 50 | 뺀 이유: sol(2 / 10)의 5배다. sol 의 공식 설명이 「astra 에 가까운 성능을 낮은 가격에」 다 |

출처는 아래 비교 근거와 같다. Fable 5.2 행은 2026-11-10 공개 자료로 확인했다.


### 비교 근거

비교 근거다(2026-10-01 공식 자료 조사, Claude 행은 2026-10-30 claude-api 스킬로 재확인, `gpt-6.1-sol` 과 `gpt-6-astra` 행은 2026-10-30 공식 문서와 `codex debug models`(codex-cli 0.166.0)로 확인, `gpt-6.1-terra` 행은 2026-10-28 확인. 값이 바뀌면 아래 출처에서 다시 확인한다).

| 모델 | 모델 id | 공식 권장 용도 | 공식 effort 시작점 | 입력 / 출력 ($/1M 토큰) | 상대 속도 |
| --- | --- | --- | --- | --- | --- |
| `gpt-6.2-astra` | `gpt-6.2-astra` | 가장 어려운 프로젝트, 여러 서비스에 걸친 버그 추적(2026-11-17 출시, 2026-11-27 확인) | 공식 기본값 못 찾음 | 8 / 40 (캐시 입력 0.40) | Fast 약 2배 |
| `gpt-6.2-sol` | `gpt-6.2-sol` | 일상 작업, 다단계 에이전트, PR 리뷰. codex-cli 0.171.0 부터 카탈로그 기본 선택(2026-11-17 출시, 2026-11-27 확인) | 공식 기본값 못 찾음 | 2 / 10 (캐시 입력 0.10, 272K 넘는 입력은 4 / 15) | Fast 약 2배 |
| `gpt-6-astra` | `gpt-6-astra` | 가장 어려운 작업. 복잡한 추론, 코딩, 컴퓨터 사용, 조사, 문서 작성 | 공식 문서에 기본값 없음. `codex debug models` 기본값은 `medium` | 10 / 50 | 공식 수치 없음 |
| `gpt-6.1-sol` | `gpt-6.1-sol` | 복잡한 코딩, 컴퓨터 사용, 전문 작업. 공식 설명은 「astra 에 가까운 성능을 낮은 가격에」 | 공식 문서와 `codex debug models` 모두 `medium`(기본) | 2 / 10 | Fast 2배(사용량 증가) |
| `gpt-6.1-terra` | `gpt-6.1-terra` | 시각 추론, 정밀한 컴퓨터 사용, 분명하고 자연스러운 글쓰기 | 기본 `medium`. Codex 안내에 시작점이 없고 `codex debug models` 기본값은 `low` | 1 / 5 | 공식 수치 없음 |
| `gpt-6-luna` | `gpt-6-luna` | 집중된 대량 작업, focused coding | `high` | 0.10 / 0.50 | Fast 1.5배 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 일상 코딩과 에이전트 | 잘 정의된 Task 는 `medium`, 어렵거나 긴 Task 는 `high`(기본) | 2 / 10 | Fast |
| Claude Opus 5.5 | `claude-opus-5-5` | 장시간 에이전트 코딩과 지식 작업 | `medium`(기본) | 4 / 20 | Moderate |
| Claude Haiku 5.5 | `claude-haiku-5-5` | 분류, 추출, 라우팅 같은 대량·저지연 작업 | `medium`(기본). 짧은 도구 작업은 `low`, 긴 에이전트 작업은 `high` | 0.10 / 0.50 (프롬프트 10만 토큰 초과 요청은 0.50 / 2.50) | Fastest |
| Claude Fable 5.2 | `claude-fable-5-2` | 가장 어려운 기술 과제 | `high`(Anthropic 권장 기본값) | 8 / 40 | Fable 5.1 보다 최대 30% 빠름 |

- 보안 리뷰 행의 근거: 2026-10-20 인프라 저장소의 PR 리뷰를 Codex worker 에 맡겼더니 symlink 덮어쓰기, 토큰 유출 경로, 컨테이너 권한 같은 공격 경로를 재현하는 내용에서 OpenAI 의 보안 요청 제한(「This content can't be shown」)에 걸려 리뷰가 끝나지 않았다. Claude Sonnet 하위 에이전트로 옮기자 끝났다. 구현한 쪽이 Claude 라서 다른 제공자 리뷰어가 필요하면, 공격 재현이 필요 없는 범위만 Codex 에 맡기고 나머지는 구현에 관여하지 않은 Claude 에이전트가 본다
- worker 가 시작 직후 출력 없이 실패하면 [`launch.md`](../../../skills/orch/references/launch.md) 의 「시작 직후 실패」 대로 다른 모델로 다시 띄운다
- 확인하지 못한 effort 별 코딩 점수는 선택 근거에서 뺐다. 제공자 사이의 점수도 직접 비교하지 않는다
- effort 별 지연과 비용 배수는 양쪽 공식 문서에 수치가 없다(2026-10-12 확인). 정성 설명만 있으므로 같은 Task 결과로 판단한다. Haiku 는 effort 를 지정하지 않고 공식 기본값 `medium` 을 쓴다
- astra 행은 비교를 위해 두었다. 후보에서 뺀 이유는 [기본 후보에서 뺀 모델](../../../skills/orch/references/agent-selection.md#기본-후보에서-뺀-모델) 이 갖는다
- Fable 5.2 행은 2026-11-10 공개 자료다. 공식 권장 용도와 상대 속도는 Anthropic 발표, 가격과 비용 배수는 Artificial Analysis 와 Fortune 보도다. 수치 출처와 독립 측정은 [evidence](evidence.md) 의 2026-11-10 Fable 5.2 절이다.
- terra 는 중간급 코딩 모델이다. 코딩 지수는 sol 보다 낮다([evidence](evidence.md) 의 2026-11-10 절). OpenAI 는 가장 복잡한 코딩에 sol·astra 를 권한다. 범위가 분명한 실행 하위 일에 쓴 사례가 있다([사례](https://github.com/makeitworkcloud/charts/pull/132)). 한국어 품질의 근거는 없으니 한국어 문서에는 넣지 않는다. Sonnet 이 맡던 구현을 terra 로 옮길지는 experiment 다섯 번을 본 뒤 정한다
- 출처: [astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex 모델](https://learn.chatgpt.com/docs/models)
- 출처: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Claude 모델 선택](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

### effort 와 하네스 관측

기존 지침은 높은 effort 가 추가 작업과 비용을 늘릴 수 있다고 설명했다. Claude 의 xhigh·max 는 리뷰 라운드와 reviewer subagent 를 스스로 돌릴 수 있고, high 이상에서 요청하지 않은 변경이나 저장소 관례와 다른 커밋 제목을 낼 수 있다는 관측을 기록했다. 공식 effort 안내는 [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) 다.

Codex 매니페스트에 hook 을 넣지 않는 선택은 [ADR-007](../../adr/007-codex-manifest-without-hooks.md) 에 있다. 기존 지침은 공통 지시서에 review-subagents 요청이 없으면 Codex worker 가 검토를 코디네이터에게 넘기는 사례와, terra 의 시각 작업 effort 는 아직 실측 전이라는 한계도 기록했다.

## 2026-11-28 공개 자료와 번갈아 띄우기 뒤 실측

사용자 결정(2026-11-28)으로 `review` 와 `security-review` 행의 Claude Sonnet 5.5 를 `medium` 대신 `high` 로 띄운다.
이 절은 그 결정과 미룬 결정의 근거를 모은다. 공개 자료는 2026-11-27 에 조회했고, 실측은 번갈아 띄우기(#609, 2026-11-23 머지) 앞뒤의 PR 이다.
원자료는 코디네이터 세션의 임시 폴더에 있어 사라질 수 있으므로 판단에 쓴 수치만 옮긴다. PR 제목과 업무 번호는 옮기지 않았다.

### 자료와 범위

- 신뢰도: 높음은 공식 문서나 독립 기관의 재현 가능한 측정이다. 중간은 실작업 비교지만 표본이나 하네스가 우리와 다른 것이다. 낮음은 경험담, 추정, 벤더 자체 주장이다.
- 실측 대상: `routing-log.jsonl` 이 있는 저장소 12곳에서 PR 이 닫힌 날(UTC)이 2026-11-20 이후인 262건(머지 261)이다. 11-20~23 이 124건, 11-24 이후가 138건이다. 아래 실측 표는 11-24 이후만 쓴다.
- 모델은 PR 을 연 dispatch 의 모델이다. `--model opus` 처럼 짧은 이름으로 띄운 24건은 정식 id 로 합쳤다. 개입 수는 Orca `orchestration.db` 를 읽기 전용으로 셌다.
- 크기 구간: PR 마다 바뀐 줄, 파일 수, 최상위 모듈 수의 백분위 평균으로 셋으로 나눴다. 작음 87건(줄 중앙 68, 파일 3), 중간 87건(194, 9), 큼 88건(652, 24)이다.
- 비용은 토큰에 공식 단가를 곱한 가정 값이다. 지금 `orch routing report` 는 6.2 세대 단가가 없어 sol 비용을 비워 두므로, 이 절의 비용은 분석 스크립트가 아래 가격 표로 따로 계산했다.

### 공개 자료

가격($/1M 토큰, 입력 / 캐시 읽기 / 출력).

| 모델 | 가격 | 측정일 | 출처 | 신뢰도 |
| --- | --- | --- | --- | --- |
| `gpt-6.2-astra` | 8 / 0.40 / 40. GPT-6 Astra(10 / 1 / 50)보다 20% 낮다 | 11-27 조회 | [OpenAI 가격](https://developers.openai.com/api/docs/pricing) | 높음 |
| `gpt-6.2-sol` | 2 / 0.10 / 10. 6.1 sol 과 같다. 272K 넘는 입력은 4 / 15, Fast 는 약 2배 | 11-27 조회 | 위와 같음 | 높음 |
| `gpt-6.1-terra`, `gpt-6-luna` | terra 1 / 0.05 / 5, luna 0.10 / 0.01 / 0.50 | 11-27 조회 | 위와 같음 | 높음 |
| Claude | Fable 5.2 8 / 0.20 / 40, Opus 5.5 4 / 0.20 / 20, Sonnet 5.5 2 / 0.10 / 10, Haiku 5.5 0.10 / - / 0.50 | 11-27 조회 | [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing) | 높음 |

코딩 에이전트 벤치마크와 실작업 비교.

| 근거 | 결과 | effort | 측정일 | 표본 | 신뢰도 |
| --- | --- | --- | --- | --- | --- |
| [FrontierCode 2.0](https://cognition.com/frontiercode)(Cognition) | Fable 50.2% $17.73, Opus 47.3% $12.82, astra 44.2% $5.97, sol 43.8% $1.29, Sonnet 42.2% $19.94, 6.1 sol 39.6% | Fable xhigh, 나머지 max | 11-11 재채점 | 132과제 | 높음 |
| [Terminal-Bench 4.0](https://www.vals.ai/benchmarks/terminal-bench-4)(Vals, 공통 하네스) | Fable 65.15% $14.56, Opus 65.15% $12.04, Sonnet 64.14% $10.75, astra 63.13% $4.69, sol 60.61% $1.13, 6.1 sol 55.05% | sol max | 11-19 | 미공개 | 높음 |
| [AA 코딩 에이전트 지수](https://x.com/ArtificialAnlys/status/2122750637041693183) | Fable 5.2 58, astra 53, sol 49. sol 은 6.1 의 52 에서 3점 내렸고 「핵심 사실을 빠뜨리는 경향」 이 있다 | max | 11-17 | 미공개 | 하락은 높음, 절대값은 중간 |
| [Agent Duel](https://agentduel.com/leaderboard)(사람 투표, 같은 하네스) | Fable 1069 $3.70·4.0분, Opus 1060 $1.64·3.0분, astra 1009 $2.17·2.6분, sol 943 $0.46·1.7분 | 미공개 | 11-27 | 미공개 | 중간 |
| [Bito 실작업](https://bito.ai/blog/gpt-6-2-sol-astra-vs-claude-opus-fable-gpt-6-1-sol/)(어려운 5턴 세션 2종 × 4회) | 종합 점수와 세션당 비용: Opus 85.0 $5.40, Fable 83.1 $8.13, astra 77.5 $8.19, sol 76.5 $2.22, Sonnet 65.7 $1.28 | Claude medium, 6.2 high | 11-18 | 8회 | 중간 |

- 독립 측정 셋(FrontierCode, Terminal-Bench, Agent Duel)에서 Fable 과 Opus 가 맨 위이고 둘의 차이는 오차 안이거나 아주 작다. sol 은 두 모델보다 3-6점 낮고 작업당 비용은 Opus 의 1/4 에서 1/10 정도다.
- 6.2 sol 이 6.1 보다 나아졌는지는 자료끼리 어긋난다. AA 코딩 에이전트 지수는 3점 내렸고, FrontierCode 와 Terminal-Bench 는 4~6점 올랐다.
- Sonnet 은 effort 에 따라 순위가 크게 바뀐다. Terminal-Bench(max)에서는 Opus 와 1점 차인데, Bito(medium)에서는 Haiku 보다 낮다.

effort 별 품질과 비용.

| 근거 | 결과 | 측정일 | 표본 | 신뢰도 |
| --- | --- | --- | --- | --- |
| [AA sol effort 별](https://artificialanalysis.ai/models/gpt-6-2-sol) | 지능 지수 low 41(출력 7.2M), medium 52(14.6M), high 55(22.7M), xhigh 56, max 57(60.9M) | 11-17 이후 | AA 과제 전체 | 높음 |
| Bito sol low 와 high(위 Bito 글) | 어려운 세션 67.3% → 75.8%, $1.22 → $2.22, 12.2분 → 29.5분, 답변당 잘못된 주장 0.62 → 0.23. medium 은 측정하지 않았다 | 11-18 | 8회 | 중간 |
| [Claude 공식 effort](https://platform.claude.com/docs/en/build-with-claude/effort) | Claude Code 기본 effort 는 네 모델 모두 `medium` 이다. API 기본은 Opus·Haiku `medium`, Fable·Sonnet `high` 다. Sonnet 은 「명세가 분명한 에이전트 코딩은 medium, 더 어렵거나 긴 작업은 high」 다 | 11-27 조회 | - | 높음 |
| [Anthropic 출시 차트](https://www.digitalapplied.com/blog/sonnet-5-5-or-opus-5-5-effort-level-cost-per-task) | Terminal-Bench 4.0 Sonnet low 20.0 / medium 28.8 / high 43.0 / xhigh 61.5 / max 70.6, Opus 38.5 / 57.6 / 64.2 / 66.4 / 64.8. CursorBench 4.0 Sonnet medium 39.2 / high 47.8 / max 55.5 | 09-28 | 미공개 | 낮음(벤더) |
| [AI Coding Daily](https://aicodingdaily.com/model/opus-5-5)(Claude Code, 프로젝트 5개) | Opus high 84.95 $0.83, medium 83.15 $0.57, low 78.19 $0.37 | 11-13 | 5 | 중간 |
| [arXiv 2610.34491](https://arxiv.org/abs/2610.34491) | 높은 effort 는 쉬운 과제를 놓치고 비용이 최대 42배다. 낮게 시작해 실패 뒤 올리는 방식이 고정 최고 effort 와 같거나 낫다 | 10-25 | 벤치 4종 | 중간 |

- Codex 와 API 의 6.2 sol·astra 공식 effort 기본값은 찾지 못했다. 「Codex 카탈로그 기본값 low」 는 2차 출처뿐이다(신뢰도 낮음). Codex CLI 0.171.0 부터 sol 이 카탈로그 기본 선택이다([changelog](https://learn.chatgpt.com/docs/changelog)).
- Sonnet 의 Terminal-Bench max 는 벤더 차트가 70.6, Vals 공통 하네스가 64.14 다. 하네스와 측정 주체가 달라 절대값은 맞지 않고, effort 를 올리면 크게 오른다는 방향만 같다.

무인 에이전트 신뢰성.

| 근거 | 결과 | 측정일 | 표본 | 신뢰도 |
| --- | --- | --- | --- | --- |
| [OpenAI 시스템 카드](https://deploymentsafety.openai.com/gpt-6-2-astra-sol)(Codex 배포 시뮬레이션) | 지시 불이행 sol 4.66%(6.1 sol 3.21%), astra 2.87%. 게으름 sol 5.25%(6.1 sol 3.32%). astra 가 알고 있는 장애물을 보고에서 빠뜨림 22.28%(6 Astra 11.09%) | 11-17 | 약 17,000과제 | 중간~높음 |
| openai/codex 이슈 [#62195](https://github.com/openai/codex/issues/62195), [#63434](https://github.com/openai/codex/issues/63434) 등 | 중간에 최종 응답으로 끝나거나, 승인된 계획 일부만 실행하고 계속하라는 요청을 거듭 요구한다. 11-27 기준 모두 열려 있고, CLI 0.171.0·0.172.0 changelog 에 고쳤다는 공지가 없다 | 11-09~23 | 개인 | 낮음(방향은 시스템 카드와 같음) |
| [Opus 5.5 프롬프트 가이드](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) | 진행 보고를 도구 호출 없는 텍스트로 보내 턴이 끝나 무인 루프가 멈춘다. 할 일 목록을 유지하고, 남은 항목을 적어 계속 요청하되 2~3회에서 멈추라고 권한다. 빈도 수치는 없다 | 11-27 조회 | - | 높음 |
| [LiveNerf](https://enjoy.dev/blog/claude-opus-5-5-nerfed/) | Opus 품질 저하 주장을 고정 78문항으로 측정했다. 출시 때 0.584, 11-13~22 0.617 로 떨어지지 않았다. 긴 세션은 측정하지 않았다 | 11-24 | 78 | 중간 |
| Claude 공식 effort(위 표) | Haiku 5.5 `low` 는 긴 에이전트 프롬프트에서 조기 종료와 검사 생략이 늘어난다 | 11-27 조회 | - | 높음 |

Fable 5.2 를 일상 설계와 구현에 쓸 가치.

| 근거 | 결과 | 신뢰도 |
| --- | --- | --- |
| Bito([글](https://bito.ai/blog/claude-fable-5-2-vs-opus-5-5-sonnet-haiku/)) | Fable 종합 83.1% 세션당 $8.13, Opus 85.0% $5.42. 가장 어려운 세션의 답변당 잘못된 주장 Fable 0.88, Opus 0.20 | 중간 |
| [Atomic Agent](https://atomicagent.io/blog/claude-fable-5-2-vs-opus-5-5/), [wmedia](https://wmedia.es/en/tips/claude-code-fable-5-2-vs-opus-5-5-benchmark) 작은 과제 | 모두 통과해 품질 차이가 없다. 비용은 Fable medium 이 Opus medium 의 1.8~1.9배다 | 중간 |
| [FrontierSWE v2](https://www.frontierswe.com/)(34과제 × 5회, 20시간 예산) | Fable 69.9% ±8.6, Opus 62.3%(벤더 발표만), Fable 회당 $168.78·16.5시간 | Fable 높음, Opus 중간 |
| [Claude 플랜 안내](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan) | Max·Ultra 에서 Fable 은 주간 한도의 최대 50% 까지 쓰고 다른 모델보다 빨리 닳는다 | 높음 |

- 일상 작업에서 Fable 이 Opus 보다 낫다는 근거는 없다. 몇 시간짜리 큰 작업에서만 앞선다. 위 「2026-11-12 Fable 5.2 실험 결과」 의 판단과 같다.

### 같은 행과 같은 크기 구간의 Opus 와 sol (11-24 이후)

Opus 는 `claude-opus-5-5` `medium`, sol 은 6.2 세대 sol 을 effort 구분 없이 묶었다(`impl-explore`·`design` 은 `medium`, `small-fix`·`impl-planned` 은 대부분 `low`). 칸은 Opus / sol 이다. 건수가 셋 이하인 칸은 방향만 본다.

| 행 | 크기 | 건수 | 첫 리뷰 P1·P2 평균 | 리뷰 뒤 커밋 평균 | CI 실패 평균 | 출력 토큰 중앙(천) | 비용 가정 중앙($) |
| --- | --- | --: | --: | --: | --: | --: | --: |
| `impl-explore` | 작음 | 7 / 3 | 0.14 / 0.00 | 1.00 / 2.00 | 0.43 / 0.00 | 31 / 121 | 2.96 / 9.84 |
| `impl-explore` | 중간 | 8 / 7 | 0.25 / 0.43 | 1.38 / 3.00 | 0.25 / 0.00 | 40 / 167 | 4.05 / 15.04 |
| `impl-explore` | 큼 | 13 / 16 | 0.67 / 0.25 | 2.50 / 1.38 | 0.23 / 0.25 | 67 / 132 | 7.07 / 9.62 |
| `small-fix` | 작음 | 11 / 8 | 0.00 / 0.00 | 0.78 / 0.29 | 0.00 / 0.12 | 19 / 17 | 1.57 / 1.68 |
| `small-fix` | 중간 | 10 / 9 | 0.20 / 0.22 | 1.80 / 2.44 | 0.10 / 0.22 | 26 / 57 | 2.45 / 6.46 |
| `design` | 작음 | 7 / 6 | 0.00 / 0.17 | 3.43 / 1.83 | 1.00 / 0.67 | 68 / 72 | 7.01 / 5.51 |
| `impl-planned` | 큼 | 4 / 5 | 0.75 / 0.25 | 3.25 / 5.00 | 0.50 / 0.60 | 126 / 134 | 20.16 / 18.02 |

행 전체로 본 11-24 이후 값은 아래와 같다(칸은 Opus / sol).

| 행(sol effort) | 건수 | 준비 중앙(시간) | CI 실패 평균 | 리뷰 뒤 커밋 평균 | 질문 평균 | 출력 토큰 중앙(천) | 비용 가정 중앙($) |
| --- | --: | --: | --: | --: | --: | --: | --: |
| `impl-explore`(`medium`) | 28 / 26 | 0.58 / 0.51 | 0.29 / 0.15 | 1.78 / 1.88 | 0.43 / 0.58 | 45 / 123 | 4.44 / 9.84 |
| `small-fix`(`low`) | 20 / 19 | 0.24 / 0.45 | 0.05 / 0.16 | 1.11 / 1.50 | 0.05 / 0.53 | 19 / 52 | 1.78 / 5.18 |
| `design`(`medium`) | 14 / 8 | 0.60 / 0.29 | 0.79 / 0.62 | 3.00 / 1.62 | 1.57 / 1.00 | 72 / 94 | 9.15 / 7.36 |
| `impl-planned`(`low`) | 8 / 4 | 0.37 / 0.30 | 0.25 / 0.50 | 2.86 / 5.00 | 0.38 / 0.75 | 77 / 179 | 8.66 / 21.03 |

- 같은 행과 같은 크기 구간끼리 품질 지표(첫 리뷰 P1·P2, CI 실패, 리뷰 뒤 커밋)는 차이가 작고 방향도 구간마다 바뀐다. 어느 한쪽이 낫다고 말할 수 없다.
- 출력 토큰과 비용은 `impl-explore` 세 구간과 `small-fix` 중간에서 sol 이 2~4배다. `small-fix` 작음, `design` 작음, `impl-planned` 큼은 비슷하거나 sol 이 조금 낮다.
- 번갈아 표시가 남은 81건에서 크기는 한쪽에 크게 몰리지 않았다. `impl-explore` 줄 중앙은 Opus 15건 257, sol 16건 340 이다. `design` 중간 구간 6건은 모두 Opus 였다.
- `hard-design` 과 `impl-hard` 는 Fable 2건, sol `high` 1건, astra 0건이라 비교하지 못한다.
- `review` 행은 11-24 이후 Sonnet `medium` 3건뿐이라 effort 판단에 쓰지 않는다.

### 비용이 외부 측정과 반대로 나온 이유

외부 측정에서 sol 의 작업당 비용은 Opus 의 1/4 에서 1/10 정도다(Agent Duel $0.46 대 $1.64, Terminal-Bench $1.13 대 $12.04).
우리 실측에서는 sol 이 2~3배 비싸다.
`impl-explore` 의 토큰 중앙값을 나눠 보면 원인이 캐시 읽기다.

| 모델 | 입력(천) | 출력(천) | 캐시 읽기(천) | 캐시 쓰기(천) |
| --- | --: | --: | --: | --: |
| Opus 5.5 `medium` | 0 | 45 | 11,698 | 187 |
| `gpt-6.2-sol` `medium` | 780 | 123 | 65,951 | - |

- sol 은 캐시 읽기 토큰이 Opus 의 약 5.6배이고, sol 비용의 약 70% 가 캐시 읽기다. 위 가격 표에서 캐시 읽기 단가는 sol 이 Opus 의 절반이지만, 읽는 양이 훨씬 많아 단가 차이를 넘는다.
- 외부 측정은 짧은 과제 하나를 공통 하네스에서 돌린 값이다. 우리 worker 는 한 PR 에서 긴 지시서 읽기, 저장소 탐색, 리뷰 반영을 한 세션으로 이어 가므로 턴마다 다시 읽는 문맥이 쌓인다. 왜 Codex 쪽이 더 많이 읽는지는 확인하지 못했다.
- Codex 쪽 토큰은 35건이 낡았거나 없어서 sol 비용의 표본이 적다. 비용 표본은 위 표의 건수보다 작다.

### 개입 (11-24 이후)

dispatch 를 돌린 모델 기준이다.

| 모델 | dispatch | 관여 PR | 보고 없이 멈춤(PR 당) | 오류로 멈춤(PR 당) | 완료 보고를 되돌림 |
| --- | --: | --: | --: | --: | --: |
| Opus 5.5 | 107 | 74 | 0.82 | 0.19 | 31 |
| `gpt-6.2-sol` | 99 | 65 | 0.66 | 0.03 | 32 |

- 머지 전 완료 보고를 되돌린 일은 두 모델 모두 PR 두 건에 한 번꼴이다.
- 외부 자료와 어긋난다. OpenAI 시스템 카드와 Codex 이슈는 6.2 sol 의 지시 불이행과 조기 종료가 늘었다고 하지만, 우리 실측에서 보고 없이 멈춘 횟수는 Opus 가 조금 더 많다. Opus 가이드가 적은 「텍스트로 끝난 턴」 과 같은 모습이다.
- 멈춘 worker 에 남은 일을 다시 보내는 `orch worker continue`(#679, 11-27 머지)는 아직 쓰인 기록이 없다.

### 결정

- `review` 와 `security-review` 행의 Sonnet 5.5 를 `high` 로 띄운다(사용자 결정 2026-11-28). sol 칸은 `medium` 그대로다. 근거는 세 가지다. Anthropic 출시 차트에서 Sonnet 이 medium 에서 high 로 오를 때 Terminal-Bench 가 28.8 → 43.0, CursorBench 가 39.2 → 47.8 로 올랐다. 공식 안내는 「더 어렵거나 긴 작업은 high」 이고 API 기본값도 `high` 다. 독립 측정에서 Sonnet 순위가 effort 에 따라 Opus 와 1점 차부터 Haiku 아래까지 바뀐다. 우리 실측은 3건이라 근거로 쓰지 않았다.
- 측정 도구의 빈틈(6.2 단가와 Fable 캐시 배수 없음, 짧은 모델 이름, 첫 리뷰 척도 변화)은 다른 PR 이 고친다(사용자 결정 2026-11-28).
- 미룸: `small-fix` 와 `impl-planned` 행의 sol `low` 는 2026-12-08 실측 보고 뒤에 정한다. 검토할 근거는 AA 지수의 low 41 대 medium 52, Bito 의 low → high 에서 잘못된 주장 0.62 → 0.23, 우리 `small-fix` sol `low` 19건의 CI 실패 0.16(Opus 0.05)과 질문 0.53(Opus 0.05)이다. 첫 리뷰 P1·P2 는 두 모델 모두 0.11 이었다.

### 한계

- Task 를 무작위로 배정하지 않았다. 번갈아 표시는 첫 dispatch 에만 남아, 이어 맡은 dispatch 가 연 48건은 표시가 빠졌다.
- 첫 리뷰 척도가 섞였다. 한 저장소는 리뷰 설정이 없어 129건 모두 도구 집계에서 첫 리뷰가 비었다. fos-skills 는 11-24 이후 리뷰가 사람 계정의 표 리뷰에서 Codex 봇의 인라인 배지로 바뀌어 69건 가운데 68건이 비었다. 위 표의 첫 리뷰 값은 분석 스크립트가 리뷰 봇 댓글에서 직접 셌고, 두 리뷰의 척도가 다르다.
- 준비 시간은 262건 가운데 104건이 비었다. `small-fix` 작음 구간 sol 의 준비 중앙 39.4시간처럼 사람 확인과 머지 대기가 섞인 이상값이 있어 준비 시간은 판단에 쓰지 않았다.
- 완료 보고를 되돌리면 새 dispatch 가 생기고, 도구는 품질을 PR 을 연 dispatch 에 붙인다. 11-24 이후 「다시 띄움」 비율이 0.45~0.65 로 올라 그 앞과 같은 기준으로 비교하지 못한다.
- 외부 자료는 하네스, effort, 표본이 서로 다르고 미공개인 곳이 많다. Bito 의 앞선 글은 채점자가 Opus 5.5 였고(위 2026-11-10 절), 이번 글의 채점자는 확인하지 못했다. 벤더 수치는 낮음으로 두고 방향만 본다.

## 같은 일 두 모델 비교

같은 계열의 새 세대가 아닌 새 모델을 같은 지시서로 지금 모델과 함께 맡긴 기록을 여기 쌓는다.
절차와 판단 규칙은 [model-compare.md](../../../skills/orch/references/model-compare.md) 가, 비교마다 복사할 표는 [기록 틀](../../../skills/orch/templates/model-compare-record.md) 이 갖는다.
비교를 시작하면 이 절 아래에 `###` 절을 하나 더한다. 같은 모델과 행의 판단이 이미 있으면 다시 비교하지 않는다.

고른 행은 astra 를 쓰는 「가장 어려운 설계와 구현」(agent-selection.md 「기본 후보에서 뺀 모델」)에 맞춘 hard-design 과 impl-hard 다. 지금 두 행은 Fable 이 맡는다.

### 2026-11-23 gpt-6.2-astra 대 claude-fable-5-2, 행 hard-design

비교 id: `compare-gpt-6-2-astra-hard-design`. 상태: 진행 중

| 건 | 일 | PR(지금/후보) | 리뷰 P1·P2 | 첫 CI | 리뷰 뒤 고친 커밋 | 막힘·재시도 | 준비까지 분 | 토큰 비용($) | 숨긴 리뷰 | 머지한 쪽 | 나쁜 건 |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

판단(5건 뒤): 아직 없음.

### 2026-11-23 gpt-6.2-astra 대 claude-fable-5-2, 행 impl-hard

비교 id: `compare-gpt-6-2-astra-impl-hard`. 상태: 진행 중

| 건 | 일 | PR(지금/후보) | 리뷰 P1·P2 | 첫 CI | 리뷰 뒤 고친 커밋 | 막힘·재시도 | 준비까지 분 | 토큰 비용($) | 숨긴 리뷰 | 머지한 쪽 | 나쁜 건 |
| --: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

판단(5건 뒤): 아직 없음.

