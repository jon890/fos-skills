# 1. 에이전트 고르기

**일의 내용으로 행을 고르고, 그 등급의 두 조합 가운데 하나와 이유를 지시서에 적는다.**
에이전트·모델·effort 가운데 하나라도 행과 다르면 `후보 밖: <이유>` 를 적는다. 사용자가 지정하거나 사용 한도 표로 바꾸는 경우도 같다.
`launch-worker` 는 장비 전체의 등급별 차례로 제공자를 골라 띄운다. 지시서의 조합은 등급을 확인하는 데 쓴다.
줄의 형식은 [`spec-writing.md`](spec-writing.md) 의 「넣을 것」 이 소유한다. 명령 예시는 고른 값을 `$AGENT`, `$MODEL`, `$EFFORT` 변수로 받는다.
선택 근거와 실측은 [evidence.md](../../../docs/features/orch-routing/evidence.md), 사용자 결정은 [단일 worker 스펙](../../../docs/features/orch-single-worker/spec.md) 에 둔다.

<a id="기본-후보에서-뺀-모델"></a>

## 모델

코디네이터가 일의 내용으로 행을 고른다. 정해진 문구나 줄만 바꾸는 문서 수정은 `simple-apply`, 문단이나 규칙을 새로 쓰거나 판단이 필요한 문서 일은 `design` 이다.
어려운 일인지는 코디네이터가 판단하고 `이유:` 에 어려운 까닭을 적는다.

| id | Task 성격 | 등급 | 행의 effort | 등급의 두 모델과 effort |
| --- | --- | --- | --- | --- |
| `impl-planned` | 계획서가 수정 위치와 검증 명령을 정한 구현 | `opus` | `low` | `gpt-6.2-sol` `low` / `claude-opus-5-5` `medium` |
| `impl-explore` | 저장소를 탐색해야 하는 여러 파일 구현 | `opus` | `medium` | `gpt-6.2-sol` `medium` / `claude-opus-5-5` `medium` |
| `small-fix` | 수정 위치가 정해진 작은 코드 수정. 분기나 상태가 있는 것 | `opus` | `low` | `gpt-6.2-sol` `low` / `claude-opus-5-5` `medium` |
| `simple-apply` | 정해진 문구나 줄만 바꾸는 문서 수정, 설정 한 줄, 리뷰 지적 단순 반영 | `haiku` | `기본` | `claude-haiku-5-5` `기본` / `gpt-6-luna` `기본` |
| `design` | 일반 기능의 technical-design, spec 인터뷰, 문단이나 규칙을 새로 쓰는 문서 일 | `opus` | `medium` | `gpt-6.2-sol` `medium` / `claude-opus-5-5` `medium` |
| `hard-design` | 어려운 디버깅, 계약 설계, 데이터 마이그레이션 | `fable` | `기본` | `claude-fable-5-2` `기본` / `gpt-6.2-astra` `medium` |
| `impl-hard` | 여러 모듈에 걸친 큰 구조 정리처럼 정말 어려운 구현 | `fable` | `기본` | `claude-fable-5-2` `기본` / `gpt-6.2-astra` `medium` |
| `visual` | 화면이나 이미지를 보고 판정, 브라우저나 앱 조작 | `sonnet` | `low` | `claude-sonnet-5-5` `low` / `gpt-6.2-sol` `low` |
| `review` | 리뷰와 검증. 구현한 쪽과 다른 제공자를 고른다 | `sonnet` | `medium` | `claude-sonnet-5-5` `medium` / `gpt-6.2-sol` `medium` |
| `security-review` | 공격 경로를 재현하는 보안 리뷰. Claude를 고른다 | `sonnet` | `medium` | `claude-sonnet-5-5` `medium` / `gpt-6.2-sol` `medium` |

- 행의 두 모델은 아래 한도 표에서 등급이 표시된 행의 모델과 첫 반대 제공자다. 그 칸에 effort가 있으면 그 값을, 없으면 행의 값을 쓴다.
- 등급에 반대 제공자 대응이 없으면 한도 표에 적힌 모델로 띄운다.
- `spec-lint`와 `launch-worker`는 두 조합을 모두 허용한다. 보안 리뷰의 시작 조합은 Claude다. 다른 모델이나 effort를 쓰려면 `후보 밖: <이유>`를 적는다. 이 경우 차례를 사용하지 않는다.
- `LAUNCH-EFFECTIVE`와 띄우기 이력의 `effective.alternation`에 교대 이유가 남는다. 같은 등급이면 저장소나 작업 행이 달라도 차례가 이어진다.
- Opus 의 high 이상에 별도 근거를 요구하지 않고 ultra 도 따로 금지하지 않는다. 행과 다르면 모두 후보 밖 이유 하나로 다룬다.
- 기본 effort 는 `기본` 이라고 적고 실행 옵션 `--effort` 는 생략한다. 숫자 단계의 effort 와 같은 값으로 취급하지 않는다.
- 이유가 있는 실제 예외는 `LAUNCH-EFFECTIVE` 와 띄우기 기록의 `effective.candidateOverride` 에 행·에이전트·모델·effort·이유를 남긴다. effort 가 다르면 기존 키 `effortLimit` 에 행의 값을 남긴다.
- 새 지시서에는 `비교:` 항목과 `experiment:` 줄을 쓰지 않는다. `--active` 지시서와 같은 지시서·설정으로 이어 가는 기존 worker 는 옛 형식을 허용한다. 새 지시서나 설정을 바꾼 재시도는 다시 검사한다.
- `send-to-worker` 의 후속 지시서는 같은 worker 를 이어 가므로 행의 worker 대조와 옛 형식 거절을 건너뛴다. 전송 실패 뒤 다른 설정으로 새로 띄우면 launch 가 새 규칙을 검사한다.
- 원격 조회(ssh, 홈서버 조회)가 필요한 일은 행과 관계없이 `claude` 로 고르고 `후보 밖: 원격 조회` 를 적는다. 현재 원격 조회 작업의 결과 해석과 정리를 Claude 에 맡기는 선택 규칙이다. worker 는 명령을 직접 실행하지 않고 명령과 대상을 ask 로 코디네이터에게 보낸다. `spec-lint` 는 허락 줄의 ssh 와 codex 선택이 함께 있으면 「원격」 으로 경고한다.
- 모든 worker 의 한국어 커밋 검사는 git 훅이 맡는다. Codex 시작 설정은 [`launch.md`](launch.md) 의 「codex 준비 판정」 을 따른다.
- Codex worker 는 launch·resume 전에 현재 계정의 `codex debug models` 목록에서 모델과 effort 를 확인하며, 조회에 실패하면 경고하고 계속 띄운다.

### 리뷰 제공자

리뷰 worker 는 결과를 만든 worker 와 다른 제공자 하나로 정한다. 문서 일의 리뷰도 같다. 보안 리뷰는 늘 표의 Sonnet 이다.
`orch spec review <PR>` 가 PR 브랜치의 구현 이력으로 제공자를 찾는다. 일반 선택 검사는 review 행의 두 조합 가운데 하나인지 확인한다.
plan 의 critic 과 verify 의 하위 검토자는 worker 와 같은 제공자로 돈다. 다른 제공자의 독립 리뷰는 코디네이터가 따로 띄운다.

### 사용 한도에 걸렸을 때

먼저 같은 worker 를 이어 갈 수 있는지 본다. 차례는 아래와 같다.

1. 사용자에게 한도에 걸린 계정을 다른 계정으로 바꿔 달라고 요청한다.
2. 바꾼 뒤 `orch worker resume --dispatch <id>` 를 부른다. 같은 워크트리에서 앞 세션을 `claude --resume` / `codex resume` 으로 열어 같은 Task 에 잇는다. 단계와 실패 대응은 [`launch.md`](launch.md) 의 「한도나 재부팅으로 멈춘 worker 이어 가기」 를 따른다.
3. `RESUME-FAIL` 이 나면 먼저 출력의 `NEXT` 를 따른다. 바꿀 계정이 없거나 `NEXT` 로도 이어 가지 못하면 아래 표대로 제공자나 모델을 바꾼다. 지시서에 재개 절을 쓴 뒤 `orch worker relaunch` 로 같은 워크트리에서 다시 띄운다([`launch.md`](launch.md) 「다른 모델로 다시 띄우기」).

Claude 는 `projects` 를 공유하는 프로필끼리면 계정을 바꿔도 앞 세션이 이어진다. Codex 는 계정마다 세션 기록이 따로라 같은 계정(재부팅, 한도가 풀린 뒤)에서만 이어진다. 계정을 바꾼 Codex worker 의 resume 은 `RESUME-FAIL find` 로 끝난다.

루프는 한 시간마다 `LIMIT-CHECK <제공자>`를 보내며, 받으면 한도 해제를 확인해 새 작업부터 모델 표의 후보로 돌아오고 `orch worker limit-clear`로 알림을 끝낸다. 종료 조건과 처리 순서는 [사용 한도 확인 알림](replying.md#사용-한도-확인-알림)을 따른다.

코디네이터가 3번에서 모델을 직접 고를 때는 같은 등급 대응이나 한 단계 아래 후보를 쓴다. 시작 전 자동 대체는 같은 등급 대응 칸만 쓴다. 두 경우 모두 표에 있는 후보에서 고른다. 교대로 띄울 때는 등급을 표시한 행에서 고른 두 모델만 확인한다.

| 걸린 모델 | 같은 등급 대응 | 한 단계 아래 | 교대 등급 |
| --- | --- | --- | --- |
| Claude Opus 5.5 | `gpt-6.2-sol` `high`, `gpt-6.2-sol` `medium` | Claude Sonnet 5.5 |  |
| `gpt-6.2-sol` `high` | Claude Opus 5.5 | `gpt-6.2-sol` `medium` |  |
| `gpt-6.2-sol` `medium` | Claude Opus 5.5 `medium` | Claude Sonnet 5.5 | `opus` |
| Claude Sonnet 5.5 | `gpt-6.2-sol`, `gpt-6.1-terra` | Claude Haiku 5.5 | `sonnet` |
| `gpt-6.2-sol` | Claude Sonnet 5.5 | `gpt-6-luna` |  |
| Claude Fable 5.2 | Claude Opus 5.5 `medium`, `gpt-6.2-astra` `medium`, `gpt-6.2-sol` `medium` | Claude Sonnet 5.5 | `fable` |
| `gpt-6.2-astra` | Claude Fable 5.2 | Claude Opus 5.5 | |
| Claude Haiku 5.5 | `gpt-6-luna` | 없음. 한도가 풀릴 때까지 기다린다 | `haiku` |
| `gpt-6-luna` | Claude Haiku 5.5 | 없음. 한도가 풀릴 때까지 기다린다 |  |

이미 떠 있는 worker 를 다른 모델로 다시 띄울 때 코디네이터가 직접 고른 값은 지시서의 `worker 선택:` 줄에 반영하고 `후보 밖: 한도 <제공자>` 를 적는다. 줄과 띄우는 값이 다르면 시작 전에 거부한다.

새로 띄울 때는 지시서와 대조하고 세대를 정한 뒤, Orca 에서 지금 고른 계정의 한도를 본다. 한도가 풀리는 시각이 남아 있을 때, 사용률이 100% 이상이거나 걸림 표시가 있으면 등급의 짝을 본다. 직접 고른 모델과 리뷰는 위 표의 같은 등급 대응을 순서대로 본다. 후보 칸에 effort 가 없으면 처음 요청한 effort 를 쓴다. 쓸 후보가 없으면 워크트리와 Task 를 만들기 전에 모델과 한도별로 풀리는 시각을 알리고 가장 이른 시각도 보여 준다.

- Claude 는 선택 프로필의 상태 줄 사용량 캐시를, Codex 는 선택 계정의 세션 기록을 읽는다. 자료의 계정을 확인할 수 없거나 모델에 적용할 값이 없으면 `USAGE-UNKNOWN <제공자> <이유>` 한 줄을 내고 그 후보를 이용한다.
- 바꿔 띄울 때는 `LAUNCH-EFFECTIVE` 와 실행 이력의 `candidateOverride` 에 처음 선택, 실제 실행 설정, 한도 사유를 남긴다. 한도로 바뀐 리뷰 제공자가 구현 제공자와 같으면 리뷰 요약에 `같은 제공자 리뷰(한도)` 를 붙인다.
- 직접 고른 모델과 새로 띄우는 `--task` 재시도, `orch worker relaunch` 도 확인한다. `--terminal` 이어 쓰기와 `orch worker resume` 은 같은 세션을 잇는다.
- `routing.usage_boost` 가 설정에 남아 있으면 지우라고 한 줄 안내한다.

같은 등급 표는 시작 전 모델 검사와 시작 뒤 한도 알림에서도 쓴다. 같은 계열이면 세대가 달라도 그 줄을 쓴다. 출처와 계정 확인은 [모델 사용 한도 회피 설계](../../../docs/features/exhausted-model-avoid/design.md)가 설명한다.

### 새 모델과 새 세대

**표의 모델은 계열을 가리킨다. 같은 계열의 새 세대가 나오면 표를 고치기 전부터 `launch-worker` 가 새 세대로 띄운다.**
계열은 Codex 가 `gpt-<세대>-<계열>` 의 계열(`sol`, `terra`, `luna`, `astra`), Claude 가 `opus`, `sonnet`, `haiku`, `fable` 이다. 코디네이터는 지시서에 표의 값을 그대로 적는다. 옛 세대가 적힌 지시서도 거절하지 않는다.

- Codex: 띄울 때 Orca 가 새 worker 에 쓸 계정의 `codex debug models` 에 같은 계열의 더 높은 세대가 그 effort 를 지원하면 그 세대로, 적힌 모델을 받지 못하면 받을 수 있는 같은 계열 최신으로 그 띄우기만 바꾼다. effort 는 행의 값 그대로다.
- `후보 밖:` 으로 모델을 정한 지시서는 세대를 바꾸지 않는다. 다만 고른 Codex 모델에 같은 계열의 새 세대가 있으면 `MODEL-OUTDATED <옛> → <새>` 로 거절한다. 지시서를 새 세대로 고친다. worker 계정이 새 세대를 받지 못할 때만 옛 세대를 고를 수 있고, 그 이유가 `effective.generation` 에 남는다. 모델 목록을 읽지 못해도 감지 기록이 새 세대를 알면 거절한다.
- 원격 worker(`--on`, `--environment`, `--pairing-code`)는 이 머신의 Codex 목록으로 세대를 바꾸거나 모델을 검사하지 않는다.
- Claude: `claude-<계열>-<세대>` 를 계열 이름으로 넘긴다. Claude Code 가 그 계열의 최신 모델로 띄운다. 띄우기 기록의 model 에는 worker 세션이 실제로 쓴 모델 ID 가 남는다.
- 기록: 바꾸면 `LAUNCH-EFFECTIVE` 와 띄우기 기록의 `effective.generation` 에 바꾸기 전, 바꾼 뒤, 이유를 남긴다. 판정은 `scripts/lib/model-generation.ts` 머리 주석이 소유한다.
- 감지: 상주 루프가 하루 한 번 `codex debug models` 를 읽는다. 첫 목록을 기준점으로 두고, 그 뒤에 나타난 현재 세대 모델을 저장소마다 한 번 보드의 decide 항목 「새 모델 <모델>」 과 `MODEL-NEW <모델> <설명>` 으로 알린다. 표의 행이 옛 세대를 가리키면(띄울 때와 같은 기준) 루프가 행마다 `MODEL-TABLE-STALE <행> <옛> → <새>` 를 한 번 보내고, 새 세대마다 보드에 「모델 표를 <새> 로 바꿀 때」 항목을 하나 더한다. 루프는 표를 고치지 않는다. 코디네이터가 작은 worker 로 이 표를 고치는 PR 을 낸다. 기록과 판정은 `scripts/loop/model-watch.ts` 머리 주석이 소유한다.
- 낡은 Codex CLI: CLI 가 낡으면 새 세대가 목록에 나오지 않는다. `orch doctor` 가 `CODEX-OUTDATED <설치> <최신>` 으로 알린다. 갱신은 사용자가 한다.

### 같은 일 두 모델 비교

**같은 계열의 새 세대가 아닌 새 모델은 같은 지시서를 지금 모델과 함께 맡겨 비교한 뒤, 사용자가 승인해야 이 표에 넣는다.**
코디네이터가 [`model-compare.md`](model-compare.md) 의 절차대로 행마다 5건을 맡기고, 숨긴 리뷰와 세 관문으로 판단한다. 기록은 [evidence](../../../docs/features/orch-routing/evidence.md) 의 「같은 일 두 모델 비교」 절에 쌓는다.

### 실측 기록

PR 마다 실측을 쌓는다. 기록 형식은 스펙 [「기록 항목」](../../../docs/features/orch-routing/spec.md) 을 따른다.

- **기록.** `<orch 루트>/state/routing-log.jsonl` 에 PR 하나당 JSON 한 줄이다. `finish-pr` 와 `cleanup-sweep` 이 쓴다. 토큰만 남기고 금액은 집계 때 계산한다.
- **집계.** `orch routing report --repo "$REPO" --since YYYY-MM-DD --full`. 같은 행의 모델을 크기 구간별로 나란히 보려면 `--compare` 를 더한다. 읽는 법과 비용 추정 규칙은 `routing-report.ts` 와 `lib/routing-report.ts` 머리 주석이 소유한다.
- **다시 보는 주기.** 기록이 한 행에 열 건 쌓이거나 한 달이 지나면 행별로 모아 이 표의 후보와 effort 를 다시 본다. 수치마다 측정일과 표본 수를 함께 적는다

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
