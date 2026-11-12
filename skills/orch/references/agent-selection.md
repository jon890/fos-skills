# 1. 에이전트 고르기

**모델과 effort 는 Task 마다 성능과 가격을 비교해 고르고, 비교한 후보와 고른 이유를 지시서의 `worker 선택:` 줄에 남긴다.**
기본값을 두지 않는다. 사용자가 지정하면 그것을 따른다.
줄의 형식은 [`spec-writing.md`](spec-writing.md) 의 「넣을 것」 이 소유하고, 거부 조건은 `launch-worker.ts` 머리 주석이 소유한다. `행:` 은 이 문서의 표와, `high 근거:` 는 저장소의 띄우기 이력과 대조한다.
문서의 명령 예시는 이 단계에서 고른 값을 `$AGENT`, `$MODEL`, `$EFFORT` 변수로 받는다.
기본으로 뺀 모델은 아래 「기본 후보에서 뺀 모델」 이 정하고, 사용자나 오버레이가 지정하면 그것을 따른다.
사용 한도에 걸렸을 때의 모델 변경은 아래 「사용 한도에 걸렸을 때」 표를 따른다.
선택 근거와 조사 기록은 [evidence.md](../../../docs/features/orch-routing/evidence.md) 에 둔다.

## 제공자

모델 표를 보기 전에 Claude 와 Codex 중 어느 쪽에 맡길지 먼저 정한다.
같은 계열을 기본값으로 두지 않는다.

- 주 산출물이 한국어 문서나 스킬 문서인 작업은 Claude 로 띄운다. Claude Code hook(한국어 표기 검사, orch 안전 hook)을 사용한다. `technical-design` 은 [설계 작업 선택 규칙](#설계-작업-선택-규칙)을 따른다. Codex 매니페스트는 hook 을 넣지 않는다
- 코드 작업에 딸린 ADR, flow 문서 수정은 위 규칙에 들지 않는다. 주 산출물이 코드면 코드 중심 구현으로 본다.
- 코드 중심 구현은 `gpt-6.1-sol` 과 Claude Sonnet 5.5 를 비교해 고르고, 고른 이유를 `worker 선택:` 줄에 남긴다. `gpt-6.1-sol` `medium` 은 Claude Opus 5.5 `medium` 과 같은 등급으로 본다
- Claude 가 만든 PR 의 머지 전 독립 리뷰는 Codex 로 띄운다. 보안 리뷰는 아래 표대로 Claude 다
- 화면과 이미지 판정은 `gpt-6.1-terra` 를 먼저 본다
- Codex worker 를 띄울 때 걸리는 GitHub 게시 승인은 [`spec-writing.md`](spec-writing.md) 가, 준비 설정은 [`launch.md`](launch.md) 의 「codex 준비 판정」 이 다룬다

## 모델

계획서의 구체성과 필요한 탐색에 따라 고른다.
인증과 권한 작업도 계획서에 수정 위치와 검증 명령이 있으면 첫 행을 따른다.

| id | Task 성격 | 모델 | effort |
| --- | --- | --- | --- |
| `impl-planned` | 계획서가 있고 수정 위치와 검증 명령이 정해진 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5 | sol `low`, Sonnet `high`(기본) |
| `small-fix` | 수정 위치와 검증 명령이 정해진 작은 수정(설정, 주석, 문서 동기화. 작은 분기와 단위 테스트는 Sonnet 쪽) | Claude Sonnet 5.5(분기나 상태를 다루는 수정), Claude Haiku 5.5(분기 논리가 없는 문서·문구·설정·정규식 한 줄), `gpt-6-luna` | Sonnet `medium`, Haiku 는 지정하지 않는다(기본값 `medium`), luna `high` |
| `simple-apply` | 단순 반영(리뷰 지적, 문구, 설정 한 줄) | Claude Haiku 5.5, `gpt-6-luna` | Haiku 는 지정하지 않는다(기본값 `medium`), luna `high`. 코디네이터가 diff 를 지적 원문과 한 줄씩 대조한다 |
| `impl-explore` | 계획은 있지만 저장소를 탐색해야 하는 여러 파일 구현 | `gpt-6.1-sol`, Claude Sonnet 5.5, Claude Fable 5.2(큰 구조 정리만) | sol `medium`(넘기지 않는다), Sonnet `high`(기본), Fable `high`(기본). 실패하면 effort 를 올리지 않고 다른 모델로 바꾼다 |
| `hard-design` | 어려운 디버깅, 기술·계약 설계, 데이터 마이그레이션 | Claude Opus 5.5, `gpt-6.1-sol` | Opus `medium`. `high` 이상은 아래 「Opus `high`」 의 근거가 있을 때만. sol `high` |
| `visual` | 화면이나 이미지를 보고 판정하는 일, 브라우저나 앱 조작 | `gpt-6.1-terra` | `low` 에서 시작 |
| `review` | 리뷰와 검증 | 구현한 쪽과 다른 제공자의 모델. 실제로 다른 제공자가 되는지는 아래 「리뷰 제공자」 를 본다 | `medium` |
| `security-review` | 공격 경로를 재현하거나 exploit 형태의 검증이 필요한 보안 리뷰 | Claude Sonnet 5.5, Claude Opus 5.5. Codex 에 맡기지 않는다 | `medium` |

Haiku 는 분기 논리가 없는 고침에만 첫 후보로 둔다.
`visual` 의 「`low` 에서 시작」 은 상한이 아니므로 effort 상한 검사를 하지 않는다.

- `launch-worker` 는 이 표의 행에 있는 모델과 모델별 effort 상한을 검사한다. 후보 밖 모델이나 상한을 넘는 effort 가 필요하면 `worker 선택:` 줄에 `후보 밖: <이유>` 를 덧붙인다. 빈 이유는 거부하고, 실제로 모델이나 effort 가 후보 밖이고 이유가 있으면 `LAUNCH-EFFECTIVE` 의 `candidateOverride` 에 행·모델·이유를 남긴다. effort 를 넘겼으면 `effort` 와 `effortLimit` 도 남긴다.
- effort `기본` 은 표에 적힌 모델 기본값으로 검사한다. 표에 기본값이 없으면 effort 를 명시한다.
- 같은 지시서와 실행 설정으로 이미 띄운 작업을 이어 가면 effort 상한 검사를 생략한다. 재시도에서 설정이나 지시서를 바꾸면 다시 검사한다. 후속 지시서로 새 Task 를 보내는 경우도 검사한다.
- `review` 행은 모델 후보와 effort 상한을 검사하지 않고 아래 「리뷰 제공자」 규칙을 따른다. Terra 는 선택 줄에 `Terra 실험 N/5`(N 은 1~5)가 있고 그 행의 후보에 Sonnet 이 있을 때만 허용한다. 일반 `experiment:` 줄은 행의 후보 검사를 생략하지 않는다.
- `impl-explore` 의 Fable 은 큰 구조 정리에만 고른다. 후보 검사는 모델 이름만 보므로 조건은 고르는 쪽이 지킨다. 아래 「큰 구조 정리의 Fable」 이 조건을 정한다.
- 지시서의 `worker 선택:` 줄에 `행: <id>` 를 적는다. 줄의 꼴은 [`spec-writing.md`](spec-writing.md) 가 소유한다. id 의 원본은 이 표다.

### 설계 작업 선택 규칙

질문이 남은 Task 도 sol 을 쓸 수 있다. 주 산출물이 한국어 문서인 spec 인터뷰는 한국어 표기 검사 hook 이 있는 Claude 로 띄운다. `technical-design` 과 `hard-design` 은 Claude Opus 5.5 `medium` 과 sol 을 번갈아 쓰고 결과를 실측 기록으로 비교한다.

### Opus `high`

Claude Opus 5.5 에 `high`, `xhigh`, `max` 를 고르려면 `worker 선택:` 줄에 「high 근거: medium 실패 <dispatch id>」 나 「high 근거: 사용자 지정 YYYY-MM-DD」 를 적는다.

- 근거로 적는 dispatch 는 그 저장소에서 Opus `medium` 으로 띄운 dispatch 다. 브랜치는 달라도 된다. 실패였는지는 코디네이터가 판단한다.
- `experiment:` 줄로 후보를 비교하는 Opus 는 기존 high 근거 검사와 effort 상한의 예외를 유지한다. 실험 후보 형식과 배정 순서 검사는 그대로 적용한다.
- Sonnet `high` 와 sol `high` 는 이 규칙 밖이다. 위 표의 effort 칸을 따른다.

### 두 모델을 나란히 둔 행

후보가 둘인 행에서 Task 성격으로 갈리지 않으면 아래 순서로 고른다. 익숙한 제공자로 기울지 않게 하려는 규칙이다.

1. **리뷰 다양성.** 저장소의 CI 자동 리뷰 제공자(오버레이에 적는다)와 다른 제공자로 구현을 맡긴다. CI 리뷰가 Claude(`claude-review`)인 저장소에서 구현을 Codex 에 맡기면 리뷰가 자동으로 다른 제공자가 된다
2. **사용 한도 분산.** 지금 떠 있는 worker 가 한 제공자에 몰려 있으면 다른 제공자로 띄운다. 한 제공자에 몰리면 한도에 걸릴 때 모든 worker 가 함께 멈춘다
3. 둘 다 같으면 가격이 낮은 쪽을 고른다

### 리뷰 제공자

「리뷰와 검증은 구현과 다른 제공자」 는 코디네이터가 따로 띄우는 리뷰 worker 에만 지켜진다.

- plan 의 critic 과 verify 의 code-reviewer 는 해당 worker 와 같은 제공자로 돈다. 팀원은 worker 의 하네스가 띄운다([`team-spawn.md`](../../implementation/references/team-spawn.md) 「하네스별 대응」)
- Codex worker 도 자기 하위 에이전트 도구로 critic 과 검토자를 띄운다. Orca 머리말은 task 가 요청하지 않으면 하위 에이전트를 막는데, 공통 지시서 틀의 `review-subagents` 줄이 그 요청이다.
- 저장소 CI 리뷰의 제공자는 저장소마다 다르다. CI 리뷰가 구현과 같은 제공자면 그 PR 에는 다른 제공자의 눈이 없다
- 다른 제공자의 리뷰가 필요하면 구현 worker 와 다른 제공자의 리뷰 worker 를 머지 전에 따로 띄우거나, 위 「리뷰 다양성」 으로 구현 제공자를 CI 리뷰와 다르게 고른다

### 사용 한도에 걸렸을 때

먼저 같은 worker 를 이어 갈 수 있는지 본다. 차례는 아래와 같다.

1. 사용자에게 한도에 걸린 계정을 다른 계정으로 바꿔 달라고 요청한다.
2. 바꾼 뒤 `orch worker resume --dispatch <id>` 를 부른다. 같은 워크트리에서 앞 세션을 `claude --resume` / `codex resume` 으로 열어 같은 Task 에 잇는다. 단계와 실패 대응은 [`launch.md`](launch.md) 의 「한도나 재부팅으로 멈춘 worker 이어 가기」 를 따른다.
3. `RESUME-FAIL` 이 나면 먼저 출력의 `NEXT` 를 따른다. 바꿀 계정이 없거나 `NEXT` 로도 이어 가지 못하면 아래 표대로 제공자나 모델을 바꿔 새로 띄우고 재개 절을 쓴다([`launch.md`](launch.md) 「끊긴 worker 다시 띄우기」).

Claude 는 `projects` 를 공유하는 프로필끼리면 계정을 바꿔도 앞 세션이 이어진다. Codex 는 계정마다 세션 기록이 따로라 같은 계정(재부팅, 한도가 풀린 뒤)에서만 이어진다. 계정을 바꾼 Codex worker 의 resume 은 `RESUME-FAIL find` 로 끝난다.

표는 3번의 길이다. 같은 등급의 다른 제공자로 바꾸거나 한 단계 아래로 내린다. 한도에 걸려도 아래 「기본 후보에서 뺀 모델」 로 올리지 않는다.

| 걸린 모델 | 같은 등급 대응 | 한 단계 아래 |
| --- | --- | --- |
| Claude Opus 5.5 | `gpt-6.1-sol` `high`, `gpt-6.1-sol` `medium` | Claude Sonnet 5.5 |
| `gpt-6.1-sol` `high` | Claude Opus 5.5 | `gpt-6.1-sol` `medium` |
| `gpt-6.1-sol` `medium` | Claude Opus 5.5 `medium` | Claude Sonnet 5.5 |
| Claude Sonnet 5.5 | `gpt-6.1-sol`, `gpt-6.1-terra`(Terra 실험 표시가 있을 때) | Claude Haiku 5.5 |
| `gpt-6.1-sol` | Claude Sonnet 5.5 | `gpt-6-luna` |
| Claude Fable 5.2 | Claude Opus 5.5 `medium`, `gpt-6.1-sol` `medium` | Claude Sonnet 5.5 |
| Claude Haiku 5.5 | `gpt-6-luna` | 없음. 한도가 풀릴 때까지 기다린다 |
| `gpt-6-luna` | Claude Haiku 5.5 | 없음. 한도가 풀릴 때까지 기다린다 |

주 산출물이 한국어 문서인 작업은 Codex 로 바꾸지 않고 한 단계 아래 Claude 로 내린다. `technical-design` 은 [설계 작업 선택 규칙](#설계-작업-선택-규칙)을 따른다. hook 이 없는 쪽으로 옮기면 한국어 표기 검사가 빠진다.
바꾼 모델은 이어 쓰는 지시서의 `worker 선택:` 줄에 반영한다. 줄과 다르면 `launch-worker` 가 거부한다.

### 기본 후보에서 뺀 모델

`gpt-6-astra` 는 worker 와 하위 에이전트의 기본 후보에서 뺀다. 가장 어려운 작업도 Claude Opus 5.5 나 `gpt-6.1-sol` `high` 까지 쓴다.

### 큰 구조 정리의 Fable

Claude Fable 5.2 는 `impl-explore` 가운데 큰 구조 정리에만 후보다. 설계(`technical-design`, `hard-design`)는 Opus 5.5 와 sol 을 쓴다.

- **큰 구조 정리.** 여러 스킬이나 수십 파일에 걸친 리팩터링과 문서 정리로, 크기 C 이상이다. 한 스킬 안의 몇 파일 구현은 아니다.
- **effort.** `high` 다(Anthropic 권장 기본값). 계획을 마친 구현에서 Opus·sol 을 `medium` 까지만 쓰는 규칙(아래 「effort」)은 Fable 에 적용하지 않는다.
- **고르는 쪽.** 지시서 `worker 선택:` 줄의 비교 칸에 Opus 나 sol 을 적고, 이유에 큰 구조 정리인 까닭과 가격(Opus 의 2배)을 감수하는 까닭을 적는다. 한국어 문서가 주 산출물이어도 Claude 라 hook 이 걸린다.
- **근거.** 구조 정리 두 건의 첫 리뷰 차단이 0 이었다([evidence](../../../docs/features/orch-routing/evidence.md) 의 2026-11-12 절).

### Terra 실험

Sonnet 이 후보인 구현 작업에서 `gpt-6.1-terra` 를 다섯 건까지 실험한다. 한국어 문서가 주 산출물인 Task 에는 쓰지 않는다. 선택 줄에 `Terra 실험 N/5` 를 적고, 작업별 시간·비용·첫 리뷰 결과는 아래 「실측 기록」 에 모은다. 다섯 건을 마치면 결과를 사용자에게 보여 Sonnet 의 구현 자리를 Terra 로 옮길지 정한다.

### 실측 기록

PR 마다 실측을 쌓는다. 기록 형식은 스펙 [「기록 항목」](../../../docs/features/orch-routing/spec.md) 을 따른다.

- **기록.** `<orch 루트>/state/routing-log.jsonl` 에 PR 하나당 JSON 한 줄이다. `finish-pr` 와 `cleanup-sweep` 이 쓴다. 토큰만 남기고 금액은 집계 때 계산한다.
- **집계.** `orch routing report --repo "$REPO" --since YYYY-MM-DD --full`. 읽는 법과 비용 추정 규칙은 `routing-report.ts` 와 `lib/routing-report.ts` 머리 주석이 소유한다.
- **다시 보는 주기.** 기록이 한 행에 열 건 쌓이거나 한 달이 지나면 행별로 모아 이 표의 후보와 effort 를 다시 본다. 수치마다 측정일과 표본 수를 함께 적는다

## effort

**모델마다 공식 시작점이 다르다. 계획서가 있으면 위 표의 낮은 쪽에서 시작한다.**

- **계획을 마친 구현**(`impl-planned`, `impl-explore`)은 Opus 5.5 와 sol 이 `medium` 을 넘기지 않고, Sonnet 5.5 와 Fable 5.2 는 `high` 가 기본이다.

| 단계 | 올리거나 내리는 조건 |
| --- | --- |
| `low` | 계획서에 수정 위치와 검증 명령이 정해진 sol 구현. Claude 에서는 속도와 가격이 중요한 단순 Task 와 서브에이전트 |
| `medium` | 지연, 성능, 비용의 균형점. 모델과 Task 에 따라 위 선택 표를 따른다. 계획을 마친 구현에서 sol 과 Opus 의 상한이다 |
| `high` | 어려운 디버깅(`hard-design`)이나 깊은 계획. 계획을 마친 구현은 위 규칙대로 Sonnet 이 기본이다. 같은 Task 가 실패해도 sol 과 Opus 는 올리지 않고 모델을 바꾼다. Opus 는 위 「Opus `high`」 의 근거가 있을 때만 |
| `xhigh`, `max` | 기본으로 쓰지 않는다. 같은 Task 에서 `high` 보다 낫다는 결과가 있을 때만. Opus 는 `high` 와 같은 「Opus `high`」 근거가 필요하다 |
| `ultra` | worker 에 쓰지 않는다. 스스로 subagent 를 띄워 코디네이터가 모르는 작업자가 생긴다 |

## Codex 에 넘기는 방법

`~/.codex/config.toml` 의 `model` 은 대화형 codex 의 기본값이라, 그대로 넘기면 모든 Task 가 같은 모델로 돈다.
`--model` 과 `--effort` 를 함께 넘긴다.
고를 수 있는 모델과 effort 목록은 아래 명령으로 본다.

```bash
codex debug models | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); for (const m of d.models) if (m.visibility==='list') console.log(m.slug, '|', m.description, '|', m.supported_reasoning_levels.map(l=>l.effort).join(','))"
```

`~/.codex/models_cache.json` 은 읽지 않는다. 대화형 codex 를 띄울 때만 갱신돼 새 모델이 빠진다.
기본 service tier 가 `priority`(Fast)일 수 있고, Fast 는 사용량이 늘어난다. 실제 적용 값은 `worker-start` 응답의 `launch.effective` 로 확인한다.
`~/.codex/config.toml` 에 `[shell_environment_policy] inherit = "core"` 가 있으면 Codex 셸에서 `SSH_AUTH_SOCK` 이 빠져 worker 의 `git push` 가 `Permission denied (publickey)` 로 막힌다. `launch-worker` 가 `--agent codex` 일 때 그 워크트리에만 걸리는 `core.sshCommand` 를 둔다(사용자가 정한 값은 덮지 않는다. 판정은 `launch-worker.ts` 머리 주석이 소유한다).

worker 가 시작 직후 출력 없이 실패하면 [`launch.md`](launch.md) 의 「시작 직후 실패」 를 따른다.
