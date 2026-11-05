# orch: worker 모델 선택 지침을 실측으로 고치고 선택 결과를 기록한다

확인: 2026-11-05

## 목표

코디네이터가 worker 의 모델과 effort 를 실측에 맞게 고르고, 고른 결과가 머지 때마다 기록되어 다음 지침 갱신의 근거가 된다.

- 배경(실측 2026-11-05, [근거](evidence.md)): 결과 품질은 모델과 effort 사이 차이가 작은데, 지시서의 83% 가 지침(「Opus 는 `medium` 시작」)과 달리 Opus `high` 를 골랐다. Opus `high` 는 같은 크기에서 `medium` 보다 준비가 두 배 넘게 늦고 비용이 두 배 넘게 들었으며, 사용 한도에 걸린 PR 은 모두 Opus 였다. Codex `gpt-6.1-sol` 은 CI 실패가 가장 적지만 질문과 코디네이터 지시가 가장 많았다.
- 지침의 「실측 기록」 절은 `routing-log.jsonl` 형식만 정하고 구현을 후속으로 남겼다. 기록이 없어 이번 비교도 다른 세션이 Orca DB 를 거슬러 읽어 만들었다.
- 사용자 승인(2026-11-05, ai-analysis 코디네이터 경유): Opus `high` 제한, Codex 구현 행 조건과 공통 지시서 문구, `routing-log.jsonl` 구현, 비교 실험 줄.

## 범위

이번 범위:

- orch `references/agent-selection.md` 의 모델 표와 effort 표, 실측 기록 절. 실측 근거 표는 [evidence.md](evidence.md) 를 가리킨다.
- orch `references/spec-writing.md` 의 `worker 선택:` 줄 설명과 `experiment:` 줄.
- orch 공통 지시서 틀(`templates/spec-common.md`)의 질문과 status 규칙.
- `spec-lint`, `launch-worker` 의 지시서 검사, 띄운 worker 기록(`state/launched-workers/<dispatch>.json`)의 필드.
- 머지 직후 `routing-log.jsonl` 한 줄 쓰기와 그 기록을 모델과 effort 별로 모아 보는 명령.

범위 밖:

- 기존 13개 저장소의 공통 지시서 사본 갱신. 틀이 바뀌면 `spec-lint` 의 `공통` 경고가 알리고 코디네이터가 옮긴다.
- 과거 dispatch 를 Orca DB 에서 거슬러 읽어 `routing-log.jsonl` 을 채우는 일. 이번 근거는 [evidence.md](evidence.md) 로 남긴다.
- Orca 자체의 기록 형식 변경.
- 스크립트 폴더 이동(orch-cli PR3). 스크립트를 고치는 PR 은 PR3 머지 뒤에 한다(계획이 순서를 정한다).

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 지시서의 `worker 선택:` 이 Claude Opus 5.5 에 effort `high` 를 고르면 DECISION1 의 근거가 있어야 한다. 실험 후보로 띄우면(DECISION7) 근거가 없어도 된다 | 근거가 없거나, 꼴이 틀리거나, 적은 dispatch 가 그 저장소의 띄우기 이력에서 Opus `medium` 이 아니면 `spec-lint` 가 `선택` 발견(종료 코드 1)으로 막고 `launch-worker` 가 워크트리를 만들기 전에 거부한다. 기록에 모델이 없는 옛 dispatch 는 꼴만 맞으면 통과한다. 「사용자 지정 YYYY-MM-DD」 근거, effort `medium` 이하, Opus 가 아닌 모델은 통과한다 |
| REQ2 | 지침의 모델 표와 effort 표가 실측과 맞는다 | `agent-selection.md` 에 Opus `high` 허용 조건(REQ1), Codex 구현 행의 「결정이 닫혀 질문 없이 끝낼 Task」 조건, 실측 근거 링크와 측정일·표본 수가 있다 |
| REQ3 | worker 가 닫힌 결정을 실행 전에 다시 묻지 않고, 머지 대기는 status 로 알린다 | 공통 지시서 틀에 DECISION3 범위의 규칙이 `orch-rule` 표지와 함께 있고, `spec-lint` 가 그 표지가 빠진 저장소 사본에 `공통` 경고를 낸다 |
| REQ4 | 띄운 worker 기록에 에이전트, 모델, effort 가 남는다 | `launch-worker` 로 띄운 뒤 `state/launched-workers/<dispatch>.json` 에 요청한 `agent`, `model`, `effort` 와 `launch.effective` 값, 실험 이름(있으면)이 있다. 옛 기록은 그대로 읽힌다 |
| REQ5 | 머지된 PR 과 머지 없이 닫힌 PR 마다 `<orch 루트>/state/routing-log.jsonl` 에 한 줄이 남는다 | 머지된 PR 은 마무리가 `outcome: merged` 로, 닫힌 PR 은 정리가 `outcome: closed` 로 PR 하나에 한 줄을 쓴다. 아래 「기록 항목」 의 키가 모두 있고 얻지 못한 값은 `null` 이다. 같은 PR 을 두 번 마무리하거나 정리해도 줄이 늘지 않는다 |
| REQ6 | 지시서에 비교 실험 줄을 둘 수 있다 | DECISION7 꼴의 `experiment:` 줄이 있으면 `launch-worker` 가 같은 실험 이름으로 띄운 기록 수가 가장 적은 후보와 `worker 선택:` 을 대조해 다르면 거부하고 그 후보를 알린다(수가 같으면 줄에 적힌 순서가 앞인 후보). `worker 선택:` 이 후보 밖이거나 꼴이 틀리면 `spec-lint` 가 막는다. 실험 이름이 띄운 worker 기록과 `routing-log.jsonl` 에 남는다 |
| REQ7 | 기록을 모아 지침 표를 다시 볼 수 있다 | 집계 명령이 저장소 여럿의 `routing-log.jsonl` 을 모델·effort·지침 행별로 모아(DECISION19) 다시 띄운 PR 비율, 표본 수, 준비 시간 중앙, 첫 리뷰 P1·P2, CI 실패, 질문 수, 토큰과 그때 가격표로 계산한 비용 추정을 낸다. `agent-selection.md` 의 「실측 기록」 절이 그 명령과 다시 보는 조건(지침 행마다 10건 또는 한 달)을 적는다 |
| REQ8 | 지시서가 고른 모델 표 행이 기계로 읽힌다 | `agent-selection.md` 모델 표의 행마다 id 가 있고, 새로 띄우는 지시서의 `worker 선택:` 줄에 「행: <id>」 가 없거나 표에 없는 id 면 `spec-lint` 가 `선택` 발견으로 막는다. 이미 떠 있는 worker 의 지시서(`--active`)는 보지 않는다 |

### 기록 항목

`routing-log.jsonl` 한 줄은 PR 하나다. 사용자 요청(2026-11-05)의 항목을 따른다.

| 키 | 값 |
| --- | --- |
| `pr`, `repo`, `branch`, `merged_at`, `closed_at` | PR 번호, 저장소, 브랜치, 머지 시각, 닫힌 시각(머지 없이 닫힌 PR 만) |
| `dispatches` | 그 PR 을 만든 dispatch 마다 `agent`, `model`, `effort`(요청과 `launch.effective`), `experiment`, 띄운 시각 |
| `task_row` | 지시서 `worker 선택:` 줄의 「행: <id>」 값(DECISION20). 옛 지시서처럼 없으면 `null` |
| `size_grade` | 저장소의 PR 크기 등급. 저장소에 크기 기준이 없으면 `null` |
| `first_review` | 첫 자동 리뷰 판정의 P1~P5 수 |
| `fix_commits_after_review` | 첫 리뷰 뒤 커밋 수 |
| `ci_failures` | 그 PR head 들의 CI 실패 실행 수 |
| `questions`, `escalations`, `coordinator_messages` | worker 질문 수, worker escalation 수, 코디네이터가 그 dispatch 에 보낸 지시 수(여러 worker 에 같이 보낸 공지는 뺀다) |
| `minutes_to_ready`, `minutes_waiting_user` | 띄운 때부터 첫 `준비됨` 까지, 그 가운데 질문이 답을 기다린 시간 |
| `outcome` | `merged` 또는 `closed` |
| `tokens` | 입력, 출력, 캐시 읽기, 캐시 쓰기 토큰. 금액은 남기지 않는다(DECISION4) |

메시지 본문, 질문 글, 지시서 본문은 남기지 않는다. 수와 시각만 남긴다.

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | Opus `high` 를 허용하는 근거와 `spec-lint` 가 보는 꼴 | `worker 선택:` 줄에 「high 근거: medium 실패 <dispatch id>」 를 적는다. `spec-lint` 가 그 dispatch 가 그 저장소의 띄우기 이력(DECISION15)에서 Opus `medium` 인지 대조하고 아니면 막는다. 브랜치는 보지 않는다(사용자 2026-11-05, 독립 검토 뒤 보완). 실패였는지는 코디네이터가 판단한다. 기록에 모델이 없는 옛 dispatch 는 꼴만 본다. 사용자가 지정하면 「high 근거: 사용자 지정 YYYY-MM-DD」 로 넘긴다 | 사용자 2026-11-05 | 지침이 이미 「같은 Task 가 medium 에서 실패하면」 을 조건으로 정했다. 근거 글만 받으면 쏠림(83%)이 그대로 남는다 |
| DECISION2 | `high` 제한을 어느 모델에 거나 | Claude Opus 5.5 만. Sonnet `high` 와 sol `high` 는 지금 지침대로 둔다 | 사용자 2026-11-05 | 사용 한도에 걸린 PR 이 모두 Opus 였고 쏠림도 Opus 에 몰렸다. DECISION8 의 재측정 때 다시 본다 |
| DECISION3 | 「확인 질문 대신 진행」 규칙을 누구에게 적용하나 | 모든 worker. 공통 지시서 틀에 「지시서와 스펙이 정한 결정은 실행 전에 다시 확인하지 않고 진행한다」 를 `orch-rule` 표지와 함께 둔다 | 사용자 2026-11-05 | 규칙 내용이 제공자와 상관없이 맞고 Opus 도 질문이 PR 당 0.8~0.9 다. 제공자별 문장은 worker 가 자기 제공자를 판단해야 해 빠지기 쉽다 |
| DECISION4 | `routing-log.jsonl` 에 남길 비용 정보 | 토큰만(입력, 출력, 캐시 읽기, 캐시 쓰기). 금액은 집계 때 그때의 가격표로 계산한다. 메시지 본문, 질문 글, 지시서 본문은 남기지 않는다 | 사용자 2026-11-05 | 가격이 바뀌거나 캐시 배수 추정을 고쳐도 기록을 고치지 않는다 |
| DECISION5 | `routing-log.jsonl` 에 쓰는 PR | 머지된 PR 과 머지 없이 닫힌 PR. 머지된 것은 마무리(`finish-pr`)가, 닫힌 것은 정리(`cleanup-sweep`)가 `outcome` 을 `closed` 로 쓴다 | 사용자 2026-11-05 | 머지된 것만 세면 실패가 많은 모델이 더 좋아 보인다 |
| DECISION6 | `routing-log.jsonl` 의 자리 | 저장소별 orch 상태 폴더(`<orch 루트>/state/routing-log.jsonl`). 집계 명령이 저장소 여럿을 받아 합친다 | 사용자 2026-11-05 | 지침이 이미 정한 자리다. 저장소 밖에 새 상태 파일을 만들지 않는다 |
| DECISION7 | `experiment:` 줄의 꼴과 배정 | 꼴: 「experiment: <이름>. 후보: `<에이전트>` `<모델>` effort `<effort>` / `<에이전트>` `<모델>` effort `<effort>`.」 `worker 선택:` 줄은 그대로 두고 그 값이 후보 가운데 하나여야 한다. `launch-worker` 가 같은 실험 이름으로 띄운 기록을 세어 가장 적게 띄운 후보와 `worker 선택:` 이 다르면 거부하고 그 후보를 알린다. 실험 후보는 DECISION1 의 근거 없이 Opus `high` 를 띄울 수 있다 | 사용자 2026-11-05 | 지시서 쏠림이 코디네이터 선택에서 생겼다. 스크립트가 배정해야 비교가 공정하다 |
| DECISION8 | 지침 수치를 다시 재는 때와 집계 명령 | 지금 규칙(지침 행마다 10건 또는 한 달)을 유지하고, `routing-log.jsonl` 을 모델·effort·지침 행별로 모아 표본 수와 함께 내는 orch 명령을 더한다. 지침 수치마다 측정일과 표본 수를 적는다 | 사용자 2026-11-05 | 규칙은 있었지만 모아 보는 도구가 없어 지켜지지 않았다 |
| DECISION9 | Codex 구현 행의 조건 문구 | 「계획서가 있고 수정 위치와 검증 명령이 정해진 구현」 행과 「여러 파일 구현」 행의 sol 후보에 「결정이 닫혀 질문 없이 끝낼 Task」 를 더한다. 사용자 결정이 남은 Task 는 Claude 로 띄운다 | 작성자 | 사용자 요청 2. sol high 질문 PR 당 2.17, 코디네이터 지시 3.94(evidence 표 2) |
| DECISION10 | 머지 대기 알림의 통로 | `준비됨` 과 머지 대기는 status 로 보내고 escalation 은 막혔을 때만 쓴다는 문장을 틀의 `ready-status` 항목 옆에 더한다 | 작성자 | 사용자 요청 2. 틀이 이미 `준비됨` 을 status 로 정했고(`ready-status`), escalation 은 머리말이 「막혔을 때」 로 정했다 |
| DECISION11 | 기록을 쓰는 시점 | 마무리(`finish-pr`)가 MERGED 를 확인한 직후, worker 정리 전 | 작성자 | 정리(`cleanup-sweep`)가 띄운 worker 기록을 지운다(`lib/launched.ts` 의 `forgetLaunch`). 머지 직후가 사용자 요청이다 |
| DECISION12 | 띄운 worker 기록의 `branch` | 이미 있다. 이번에는 `agent`, `model`, `effort`, `effective`, `experiment` 만 더한다 | 작성자 | `lib/launched.ts` 의 `Launch` 형에 `branch` 가 있다 |
| DECISION13 | 크기 등급의 출처 | 저장소가 낸 등급을 읽는다. orch 설정에 그 저장소의 첫 CI 리뷰 본문에서 등급을 읽는 꼴을 두고, 없으면 `null` 이다. orch 가 등급을 새로 정의하거나 다시 계산하지 않는다 | 작성자 | 등급 계산 규칙이 저장소마다 다르고, 근거 표의 저장소는 CI 리뷰 본문에 등급을 적는다. 기술 설계에서 고쳤다(design.md DECISION3) |
| DECISION14 | `high` 보다 높은 effort | Opus 의 `xhigh`, `max` 도 `high` 와 같이 DECISION1 의 근거가 있어야 한다 | 작성자 | 독립 검토 발견 1. `agent-selection.md` 「effort」 표가 `xhigh`, `max` 를 `high` 보다 나은 결과가 있을 때만 쓰게 한다. 높은 값으로 우회하는 길을 막는다 |
| DECISION15 | 띄운 기록을 오래 두는 곳 | `launch-worker` 가 띄울 때마다 저장소의 orch 상태 폴더에 지우지 않는 띄우기 이력 한 줄을 더 남긴다. 정리는 `launched-workers` 만 지우고 이 이력은 지우지 않는다. DECISION1 의 대조와 DECISION7 의 수 세기는 이 이력을 본다. 세는 범위는 그 저장소다 | 작성자 | 독립 검토 발견 2, 3. 정리가 `launched-workers` 기록을 지워(`lib/launched.ts` 의 `forgetLaunch`) 실패한 medium 기록과 실험 수가 사라진다. DECISION6 이 저장소별 자리를 정했다 |
| DECISION16 | 기록에 쓰는 PR 의 범위 | 띄우기 이력에 그 PR 브랜치의 dispatch 가 있는 PR 만 쓴다. 사람이 연 PR 은 쓰지 않는다. 닫힌 PR 은 정리가 `--run` 여부와 상관없이 이력의 브랜치로 찾는다 | 작성자 | 독립 검토 발견 6. 이 기록은 worker 모델 선택을 비교하려는 것이다. 닫힌 PR 을 빠뜨리면 DECISION5 의 목적이 깨진다 |
| DECISION17 | 첫 리뷰와 준비 시간의 기준 | 첫 리뷰는 저장소 CI 자동 리뷰(오버레이에 적은 제공자)의 첫 판정이다. CI 자동 리뷰가 없거나 판정을 찾지 못하면 `null` 이다. 준비 시간은 첫 dispatch 를 띄운 때부터 첫 `준비됨` 까지이고, dispatch 마다 띄운 시각도 남겨 다른 기준을 집계 때 계산할 수 있게 한다 | 작성자 | 독립 검토 발견 7. 근거 표(evidence.md)가 CI 리뷰 판정과 첫 띄움 기준을 썼다. 같은 기준이어야 다음 측정과 비교된다 |
| DECISION18 | 같은 PR 을 다시 쓸 때 | PR 번호로 한 줄만 둔다. 같은 `outcome` 이면 건너뛰고, `closed` 로 쓴 PR 이 다시 열려 머지되면 그 줄을 `merged` 로 바꿔 쓴다. 닫힌 PR 은 `merged_at` 이 `null` 이고 `closed_at` 에 닫힌 시각을 둔다 | 작성자 | 독립 검토 발견 8. 마지막 상태가 실제 결과다 |
| DECISION19 | dispatch 가 여럿인 PR 의 집계 묶음 | PR 을 연 dispatch 의 `launch.effective` 모델과 effort 로 묶는다. 첫 dispatch 의 모델 기준으로 「다시 띄운 PR 비율」 을 따로 낸다 | 사용자 2026-11-05 | 독립 검토 발견 4. 품질 열은 결과를 낸 모델에, 실패는 다시 띄움 비율로 첫 모델에 돌아간다 |
| DECISION20 | 지시서가 고른 모델 표 행을 적는 법 | `agent-selection.md` 모델 표에 짧은 행 id 열을 더하고, `worker 선택:` 줄에 「행: <id>」 를 적게 한다. `spec-lint` 가 표의 id 인지 보고 없거나 틀리면 `선택` 발견으로 막는다 | 사용자 2026-11-05 | 독립 검토 발견 5. 자유 글 이유로는 행을 찾지 못해 행별 재측정이 걸리지 않는다. id 는 행 문구를 고쳐도 기록이 이어진다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 지침과 스크립트 동작만 바꾼다. `docs/domain/` 에 이 영역의 규칙이 없다.
