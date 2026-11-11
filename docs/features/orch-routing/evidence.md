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
- 결정: 계획을 마친 구현(`impl-planned`, `impl-explore`)에서 Opus 5.5 와 sol 은 `medium` 을 넘기지 않는다. Sonnet 5.5 는 `high` 가 기본이다. 실패하면 sol 과 Opus 는 effort 를 올리지 않고 모델을 바꾼다. Sonnet 의 medium 과 high 는 실측 기록(`routing-log.jsonl`)이 쌓이면 다시 본다. 집계 방법은 [agent-selection.md](../../../skills/orch/references/agent-selection.md) 의 「실측 기록」 절이다.

## 2026-11-10 Claude Fable 5.2 (실험 전 수치)

사용자 결정(2026-11-10)으로 Fable 5.2 를 바로 후보에 넣지 않고 크고 어려운 일 다섯 건에 실험한다. 이 절은 실험을 시작하기 전에 본 공개 수치를 모은다. 실험 결과는 실측 기록으로 따로 남긴다. 수치는 2026-11-10 에 수집했고, 값이 바뀌면 아래 출처에서 다시 확인한다.

- 모델 id 는 `claude-fable-5-2` 다(`--model fable` 도 5.2 로 풀린다). 2026-11-10 코디네이터가 `claude -p --model claude-fable-5-2` 로 응답을 확인했다. 공개는 2026-11-09 다.
- 가격은 입력 8, 출력 40($/1M 토큰)이다. Fable 5.1 은 10 / 50, Opus 5.5 는 4 / 20 이다.
- Artificial Analysis 작업 한 건(최상위 effort): Fable 5.2 26.54달러·46.4분, Opus 5.5 약 10달러다. 코딩 에이전트 지수의 작업 한 건은 Opus 5.5 11.42달러, sol 1.50달러다.
- Anthropic 측정(Fable 5.2 / Opus 5.5): FrontierSWE v2 69.9 / 62.3, FrontierCode 2.0 49.1(xhigh) / 45.5, SWE-bench Pro 93.0 / 89.9, Terminal-Bench 4.0 67.6 / 66.4(오차 안).
- 독립 측정 Vals AI(Fable 5.2 / Opus 5.5): Terminal-Bench 4.0 65.15 / 65.15, ProgramBench 19.0 / 18.5, SWE-bench Multimodal 62.3 / 70.2.
- Artificial Analysis 지능 지수 v5: Fable 5.2 max 65, high 62(출력 토큰 40% 적음), Opus 5.5 max 59, sol max 55. 코딩 에이전트 지수 v2.0 은 Opus 5.5 61.7, Fable 5.1 57.6, sol 54.1 이고 Fable 5.2 는 아직 없다.
- 읽기: 몇 시간짜리 큰 작업(FrontierSWE)에서만 뚜렷이 앞선다. 독립 측정의 터미널 작업은 Opus 와 같다. Anthropic 은 일상 작업에 Opus 5.5 를 권한다. 그래서 큰 일 다섯 건만 실험하고, 가격 기준은 그 결과 뒤에 정한다.
- 출처: [llm-stats(Anthropic 수치)](https://llm-stats.com/blog/research/claude-fable-5-2-launch), [Vals AI](https://www.vals.ai/models/anthropic_claude-fable-5-2), [Artificial Analysis](https://artificialanalysis.ai/models/claude-fable-5-2), [Artificial Analysis 발표](https://x.com/ArtificialAnlys/status/2119878995386982508), [The Decoder](https://the-decoder.com/claude-fable-5-2-and-mythos-5-2-cement-anthropics-ai-lead-just-before-its-ipo/), [CNBC](https://www.cnbc.com/2026/11/09/anthropic-claude-fable-5-2-mythos-5-2.html), [Fortune](https://fortune.com/2026/11/09/anthropic-debuts-updated-claude-fable-and-mythos-models-undercutting-price-of-openais-gpt-6-astra-by-up-to-80/)

## 2026-11-10 질문이 남은 설계 작업의 sol 후보

사용자 결정(2026-11-10)으로 사용자 결정이나 설계 판단이 남은 Task 에도 sol 을 후보로 둔다. `orch worker ask` 가 질문을 보내고 바로 끝나도록 바뀐 뒤(#404), 같은 날 Codex worker 들이 마이그레이션 순서·gate·보드 명령에 관한 판단 질문을 문제없이 보냈다는 코디네이터의 관측을 근거로 삼았다. 질문 처리 사례이며 설계 품질의 우위를 입증한 비교 실험은 아니다. 주 산출물이 한국어 문서인 spec 인터뷰는 한국어 표기 검사 hook 이 있는 Claude 를 유지하고, `technical-design` 과 `hard-design` 은 Claude Opus 5.5 medium 과 sol 을 번갈아 쓴 결과를 실측 기록으로 비교한다.

## 지침에서 옮긴 모델 조사와 제외 근거

기존 모델 선택 지침에 있던 조사 기록을 보존한다. 현재 선택 규칙은 [agent-selection.md](../../../skills/orch/references/agent-selection.md) 가 소유한다.

아래 두 모델은 worker 와 하위 에이전트의 후보에 넣지 않는다. `gpt-6-astra` 는 가격 대비 효과가 낮아서다(사용자 결정 2026-10-30). Claude Fable 5.2 는 실험이 끝날 때까지 뺀다(사용자 결정 2026-11-10, 아래 「Fable 5.2 실험」). 가장 어려운 작업도 Claude Opus 5.5 나 `gpt-6.1-sol` `high` 까지 쓴다.

| 모델 | 입력 / 출력 ($/1M 토큰) | 뺀 이유 |
| --- | --- | --- |
| Claude Fable 5.2 | 8 / 40 | Opus 5.5(4 / 20)의 2배다. 작업 한 건 비용은 2.6배다(Artificial Analysis, 2026-11-10). 실험 다섯 건의 결과를 본 뒤 후보에 넣을지 정한다 |
| `gpt-6-astra` | 10 / 50 | sol(2 / 10)의 5배다. sol 의 공식 설명이 「astra 에 가까운 성능을 낮은 가격에」 다 |

출처는 아래 비교 근거와 같다. Fable 5.2 행은 2026-11-10 공개 자료로 확인했다.


### 비교 근거

비교 근거다(2026-10-01 공식 자료 조사, Claude 행은 2026-10-30 claude-api 스킬로 재확인, `gpt-6.1-sol` 과 `gpt-6-astra` 행은 2026-10-30 공식 문서와 `codex debug models`(codex-cli 0.166.0)로 확인, `gpt-6.1-terra` 행은 2026-10-28 확인. 값이 바뀌면 아래 출처에서 다시 확인한다).

| 모델 | 모델 id | 공식 권장 용도 | 공식 effort 시작점 | 입력 / 출력 ($/1M 토큰) | 상대 속도 |
| --- | --- | --- | --- | --- | --- |
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
- astra 행은 비교를 위해 두었다. 후보에서 뺀 이유는 위 「기본 후보에서 뺀 모델」 이 갖는다
- Fable 5.2 행은 2026-11-10 공개 자료다. 공식 권장 용도와 상대 속도는 Anthropic 발표, 가격과 비용 배수는 Artificial Analysis 와 Fortune 보도다. 수치 출처와 독립 측정은 [evidence](evidence.md) 의 2026-11-10 Fable 5.2 절이다.
- terra 는 중간급 코딩 모델이다. 코딩 지수는 sol 보다 낮다([evidence](evidence.md) 의 2026-11-10 절). OpenAI 는 가장 복잡한 코딩에 sol·astra 를 권한다. 범위가 분명한 실행 하위 일에 쓴 사례가 있다([사례](https://github.com/makeitworkcloud/charts/pull/132)). 한국어 품질의 근거는 없으니 한국어 문서에는 넣지 않는다. Sonnet 이 맡던 구현을 terra 로 옮길지는 experiment 다섯 번을 본 뒤 정한다
- 출처: [astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra), [luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Codex 모델](https://learn.chatgpt.com/docs/models)
- 출처: [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Claude 가격](https://platform.claude.com/docs/en/about-claude/pricing), [Claude 모델 선택](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude 모델 비교](https://platform.claude.com/docs/en/about-claude/models/overview)

### effort 와 하네스 관측

기존 지침은 높은 effort 가 추가 작업과 비용을 늘릴 수 있다고 설명했다. Claude 의 xhigh·max 는 리뷰 라운드와 reviewer subagent 를 스스로 돌릴 수 있고, high 이상에서 요청하지 않은 변경이나 저장소 관례와 다른 커밋 제목을 낼 수 있다는 관측을 기록했다. 공식 effort 안내는 [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) 다.

Codex 매니페스트에 hook 을 싣지 않는 선택은 [ADR-007](../../adr/007-codex-manifest-without-hooks.md) 에 있다. 기존 지침은 공통 지시서에 review-subagents 요청이 없으면 Codex worker 가 검토를 코디네이터에게 넘기는 사례와, terra 의 시각 작업 effort 는 아직 실측 전이라는 한계도 기록했다.
