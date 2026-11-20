# orch: 모델 표를 gpt-6.2 세대로 바꾸고, Codex 를 쓰는 사람에게만 CLI 갱신을 알린다

확인: 2026-11-20

model-auto-routing PR 1 이 이 스펙을 대신한다([model-auto-routing](../model-auto-routing/spec.md)).

## 목표

orch 가 Codex worker 를 띄울 때 지금 세대 모델(`gpt-6.2-sol`)을 쓴다.
Codex CLI 가 낡아 새 모델을 받지 못하는 일이 다시 생기면, Codex 를 쓰는 사람에게만 알린다.
어려운 일에 Fable 5.2 와 `gpt-6.2-astra` 가운데 무엇이 나은지 실제 작업 3건으로 비교한다.

2026-11-20 까지 Codex CLI 가 0.155.1 에 머물러 `gpt-6.1-sol` 을 받지 못하고 옛 `gpt-6-sol` 로 돌았다.
Orca 와 orch 가 worker 시작을 막지 않으려고 Codex 의 시작 때 갱신 확인을 꺼 두어서, 2026-09-20 뒤로 CLI 가 한 번도 갱신되지 않았다.
CLI 를 0.166.0 으로 올린 뒤 `codex debug models` 에 `gpt-6.2-sol` 과 `gpt-6.2-astra` 가 나온다.

## 범위

이번 범위:

- 모델 표와 「사용 한도에 걸렸을 때」 표의 sol 행을 `gpt-6.2-sol` 로 바꾸고, 표에서 옛 세대 sol(`gpt-6.1-sol`, `gpt-6-sol`)을 뺀다.
- Fable 이 한도에 걸렸을 때의 같은 등급 대응에 `gpt-6.2-astra` 를 넣는다.
- 시작 전 모델 검사가 보여 주는 대체 후보를 새 표에 맞춘다.
- Codex CLI 가 최신보다 낡았으면 `orch doctor` 가 알린다. Codex 를 쓰지 않는 사람에게는 보이지 않는다.
- Fable 과 Astra 의 비교 방법과 결과를 적을 곳을 정한다.

범위 밖:

- Codex CLI 를 자동으로 갱신하는 것. 알리기만 한다.
- 화면 판정 행(`gpt-6.1-terra`)과 `gpt-6-luna`. 6.2 세대가 없다.
- 이미 떠 있는 worker.
- 비교 결과로 어려운 행을 바꾸는 것. 3건이 끝나면 사용자에게 묻는다.

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | sol 행이 6.2 를 쓴다 | 모델 표의 impl-planned, impl-explore, small-fix, design, review(Codex 쪽) 행이 `gpt-6.2-sol` 이고 effort 는 지금 값 그대로다. `spec-lint` 와 `launch-worker` 가 새 값을 행과 같은 것으로 본다 |
| REQ2 | 한도 표에 옛 sol 이 없다 | 「사용 한도에 걸렸을 때」 표에 `gpt-6.1-sol`, `gpt-6-sol` 이 없다. `gpt-6.2-sol` 의 한 단계 아래는 `gpt-6-luna` 다. Claude Fable 5.2 의 같은 등급 대응에 `gpt-6.2-astra` 가 들어간다 |
| REQ3 | 대체 후보 안내가 새 표를 따른다 | 시작 전 모델 검사가 `gpt-6.2-sol` 을 받지 못하면 같은 등급의 Claude 를 안내한다(medium·high → Opus 5.5, low → Sonnet 5.5). 옛 `gpt-6-sol` 을 안내하지 않는다 |
| REQ4 | Astra 는 어려운 행의 기본이 아니다 | hard-design, impl-hard 행은 Fable 5.2 그대로다. `gpt-6.2-astra` 는 한도 대응과 비교 실험에서만 쓰고, 그 밖에 쓰면 지금처럼 `후보 밖` 이유가 있어야 한다. 「기본 후보에서 뺀 모델」 의 `gpt-6-astra` 는 그대로 뺀다 |
| REQ5 | 낡은 Codex CLI 를 알린다 | Codex 를 쓰는 머신에서 설치된 Codex CLI 가 최신 버전보다 낮으면 `orch doctor` 가 `CODEX-OUTDATED <설치> <최신>` 과 갱신 방법 한 줄을 낸다. 최신 버전을 확인하지 못하면 그 줄을 내지 않고 doctor 를 실패시키지 않는다 |
| REQ6 | Codex 를 쓰지 않으면 보이지 않는다 | `codex` 명령이 없는 머신에서는 REQ5 의 확인을 하지 않고 아무 줄도 내지 않는다 |
| REQ7 | 비교 3건을 기록한다 | 어려운 행의 일 3건을 같은 지시서로 Fable 과 Astra worker 에게 따로 맡기고, 건마다 리뷰 P1·P2 수, 첫 CI 결과, 걸린 시간, 사용량을 근거 문서의 한 절에 남긴다. 나은 쪽 PR 만 머지하고 다른 쪽은 닫는다. Astra worker 의 지시서에는 `후보 밖: 비교, Fable 대조(사용자 결정 2026-11-20)` 를 적는다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | sol 행의 모델 | `gpt-6.2-sol` | 사용자 2026-11-20 | 지금 세대의 코딩 기본 모델이다(`codex debug models` 설명 「go-to model for coding」). `gpt-6.1-sol` 은 「Previous generation」 이다 |
| DECISION2 | 어려운 행 | Fable 5.2 유지. Astra 는 Fable 한도 대응에만 넣는다 | 사용자 2026-11-20 | Astra 의 공식 성능·가격 자료가 아직 없다. 비교 3건 뒤 다시 정한다 |
| DECISION3 | 비교 방법 | 어려운 일 3건을 두 모델로 따로 돌려 비교한다. 사용량이 두 배 든다 | 사용자 2026-11-20 | 지난 일을 다시 돌리는 것보다 실제 머지할 일로 보는 것이 정확하다 |
| DECISION4 | Codex CLI 갱신 | 자동으로 올리지 않고 알리기만 한다 | 사용자 2026-11-20 | 갱신 중 worker 시작이 막히거나 Orca 와 맞지 않는 버전이 깔릴 수 있다 |
| DECISION5 | 알림 대상 | Codex 를 쓰는 사람에게만 | 사용자 2026-11-20 | Claude 만 쓰는 사람에게 Codex 갱신 알림은 소음이다 |
| DECISION6 | 「Codex 를 쓴다」 의 기준 | `codex` 명령이 PATH 에 있다 | 사용자 2026-11-20 | Codex worker 를 띄우려면 이 명령이 있어야 한다. 기록을 읽는 방법보다 단순하다 |
| DECISION7 | 최신 버전의 출처 | 설계가 정한다. 확인에 실패하면 조용히 넘어간다 | 작성자 | doctor 는 오프라인에서도 돌아야 한다 |
| DECISION8 | PR 단위 | PR 하나 | 사용자 2026-11-20 | 모델 표, 대체 후보 코드, doctor 한 줄이 함께 바뀐다. 비교 3건의 기록은 일이 생길 때마다 따로 남긴다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 의 worker 선택 표와 doctor 의 확인 한 줄만 바뀐다.
