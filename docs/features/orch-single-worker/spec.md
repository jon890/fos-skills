# orch: 일의 종류마다 정해진 worker 하나로 띄우고, Codex worker 에서도 한국어 표기 검사가 돈다

확인: 2026-11-17

## 목표

코디네이터는 일의 종류(행)만 고르고, 그 행이 정한 worker 하나와 이유로 띄운다. 후보를 비교해 고르지 않는다.
코드 구현과 일반 설계·문서 일은 Codex sol 이 맡아 Codex worker 를 실제로 쓰고, 정말 어려운 일은 Fable 5.2 가 맡는다.
그 전제로 Codex worker 가 쓴 한국어 문서도 Claude worker 와 같은 표기 검사를 받는다.

- 배경: 2026-11-17 띄우기 기록(fos-skills 330건, ai-analysis 485건)을 보면 Codex 는 11/14 이후 거의 쓰이지 않았다. 11/13 이후 ai-analysis 의 계획 있는 구현은 Sonnet 73 대 sol 1, 설계는 Opus 35 대 sol 0 이다.
  규칙은 「코드 구현은 sol 과 Sonnet 을 비교해 고른다」, 「설계는 Opus 와 sol 을 번갈아」 였지만, `worker 선택:` 줄의 「비교:」 칸은 Claude 를 먼저 고른 뒤 다른 후보를 적는 형식으로만 남았다.
- 근거: sol medium 은 첫 리뷰 P1·P2 와 CI 실패 비율이 Opus medium 과 비슷하고 비용 중앙값은 $4.1 대 $10.9 다(`docs/features/orch-routing/evidence.md` 표 2, 「2026-11-09 sol medium 과 Opus medium 비교」).
- 지금 Codex worker 에는 한국어 표기 검사 hook 이 없다. Codex 는 새 hook 마다 신뢰 확인 화면에서 멈춰서 Codex 매니페스트에서 hook 을 뺐다([ADR-007](../../adr/007-codex-manifest-without-hooks.md)). 그래서 「주 산출물이 한국어 문서면 Claude」 기준이 있었다.
- GPT-6.2 Astra 와 6.2 Sol 은 2026-11-17 기준 `codex debug models`(Codex CLI 0.166.0)에 없다. 표에 넣지 않는다.

## 범위

이번 범위:

- Codex worker 가 쓴 한국어 파일에도 Claude worker 와 같은 표기 검사가 돈다
- 선택 표를 행마다 worker 하나로 바꾼다. `worker 선택:` 줄의 「비교:」 칸과 `experiment:` 줄을 없앤다
- 「한국어 문서면 Claude」, 「설계는 Opus 와 sol 을 번갈아」, 「두 모델을 나란히 둔 행」 의 고르는 순서를 없앤다
- Fable 5.2 를 정말 어려운 일의 worker 로 두고, 2주 뒤 대조할 일을 남긴다

범위 밖:

- 사용 한도에 걸렸을 때 바꾸는 표(「사용 한도에 걸렸을 때」). 지금처럼 둔다
- GPT-6.2 모델 도입. 출시되어 `codex debug models` 에 나타나면 따로 정한다
- 이미 떠 있는 worker 의 지시서. 새로 띄우는 지시서부터 적용한다

PR 순서: PR1 은 Codex worker 의 한국어 표기 검사다. PR2 는 행마다 worker 하나인 선택 표, 「비교:」 와 `experiment:` 제거, 한국어 문서 기준 제거, Fable 대조 일이다(DECISION7).

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | Codex worker 가 커밋하는 한국어 파일은 korean-check 의 금지어 표로 검사받는다. 금지어가 있으면 커밋을 거절하고, 금지어가 아닌 경고는 보여 주기만 한다. 검사는 worker 종류를 보지 않고(DECISION22), 저장소가 설정으로 끌 수 있다(DECISION24). 커밋 메시지와 PR 본문은 지금처럼 등록 전에 korean-check 스킬이 본다. Codex 의 hook 신뢰 확인 화면에서 worker 가 멈추지 않는다 | Codex worker 가 금지어가 든 한국어 파일을 커밋하려 하면 금지어와 권장 표현이 보이고 커밋이 거절된다. 경고만 있으면 커밋된다. Codex worker 시작이 신뢰 확인 화면에서 멈추지 않는다 |
| REQ2 | 선택 표의 행마다 worker 는 하나다(에이전트, 모델, effort) | 표의 모든 행에 값이 하나씩 있다. 아래 「행과 worker」 표와 같다 |
| REQ3 | `worker 선택:` 줄은 「worker 선택: `<에이전트>` `<모델>` effort `<effort>`. 행: <id>. 이유: <이유>.」 꼴이다. 「비교:」 칸을 쓰지 않는다. 기본 effort 는 `기본` 이라고 적는다. 에이전트, 모델, effort 중 하나라도 행과 다르면 「행과 다른 worker」 다 | 「비교:」 가 있는 새 지시서는 spec-lint 가 막는다. 행과 다른 worker 를 적고 「후보 밖: <이유>」 가 없으면 막는다 |
| REQ4 | 행과 다르게 띄우려면 「후보 밖: <이유>」 를 적는다. 사용 한도 표로 바꿀 때도 「후보 밖: 한도 <제공자>」 처럼 적는다. 이유가 띄우기 기록에 남는다 | 이유 없는 다른 worker 는 거절된다. 이유를 준 경우 `LAUNCH-EFFECTIVE` 와 띄우기 기록에 행, 띄운 worker, 이유가 남는다 |
| REQ5 | `experiment:` 줄은 없다 | `experiment:` 줄이 있는 새 지시서는 spec-lint 가 막는다 |
| REQ6 | 「한국어 문서면 Claude」, 「설계는 Opus 와 sol 을 번갈아」, 「두 모델을 나란히 둔 행」 의 고르는 순서가 문서와 검사에서 사라진다 | `agent-selection.md` 와 `spec-writing.md` 에 그 규칙이 없다 |
| REQ7 | 리뷰 worker 는 리뷰할 결과를 만든 worker 와 다른 제공자 하나로 정해진다. 문서 일의 리뷰도 같다. 보안 리뷰는 예외로 늘 Claude Sonnet 이다 | 만든 쪽이 Claude 면 Codex `gpt-6.1-sol` medium, Codex 면 Claude Sonnet 5.5 medium 이다(지금 `orch spec review` 규칙 그대로) |
| REQ8 | Fable 5.2 로 띄운 일을 2주 뒤 Opus medium 의 예전 기록과 대조할 일이 보드에 남는다 | PR2 머지 때 코디네이터가 「Fable 5.2 대조(2026-12-01 이후)」 보드 항목을 만든다. 그날 Fable 로 띄운 건수와 상관없이 `evidence.md` 표 1~3 의 항목으로 대조하고 계속 쓸지 사용자에게 묻는다 |
| REQ9 | 행은 코디네이터가 일의 내용으로 고른다. 정해진 문구나 줄만 바꾸는 문서 수정은 `simple-apply`, 문단이나 규칙을 새로 쓰거나 판단이 필요한 문서 일은 `design` 이다. 어려운 일(`hard-design`, `impl-hard`)인지는 코디네이터가 판단하고 그 이유를 「이유:」 에 적는다 | 문서 일의 행이 이 기준과 맞다. 어려운 일 행으로 띄운 지시서의 「이유:」 에 어려운 까닭이 있다 |

### 행과 worker

| 행 | 일 | worker |
| --- | --- | --- |
| `impl-planned` | 계획서가 수정 위치와 검증 명령을 정한 구현 | `codex` `gpt-6.1-sol` `low` |
| `impl-explore` | 저장소를 탐색해야 하는 여러 파일 구현 | `codex` `gpt-6.1-sol` `medium` |
| `small-fix` | 수정 위치가 정해진 작은 코드 수정(분기나 상태가 있는 것) | `codex` `gpt-6.1-sol` `low` |
| `simple-apply` | 정해진 문구나 줄만 바꾸는 문서 수정, 설정 한 줄, 리뷰 지적 단순 반영 | `claude` `claude-haiku-5-5` 기본 effort |
| `design` | 일반 기능의 technical-design, spec 인터뷰, 문단이나 규칙을 새로 쓰는 문서 일 | `codex` `gpt-6.1-sol` `medium` |
| `hard-design` | 어려운 디버깅, 계약 설계, 데이터 마이그레이션 | `claude` `claude-fable-5-2` 기본 effort |
| `impl-hard` | 여러 모듈에 걸친 큰 구조 정리처럼 정말 어려운 구현 | `claude` `claude-fable-5-2` 기본 effort |
| `visual` | 화면이나 이미지를 보고 판정, 브라우저나 앱 조작 | `codex` `gpt-6.1-terra` `low` |
| `review` | 리뷰와 검증 | 구현과 다른 제공자(REQ7) |
| `security-review` | 공격 경로를 재현하는 보안 리뷰 | `claude` `claude-sonnet-5-5` `medium` |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | worker 를 고르는 방식 | 행마다 worker 하나와 이유만 둔다. 「비교:」 칸을 없앤다 | 사용자 2026-11-17 | 비교 칸이 Claude 로 기우는 선택을 정당화하는 형식으로만 쓰였다 |
| DECISION2 | 코드 구현 행의 worker | Codex sol(계획 있는 구현과 작은 수정은 low, 탐색 구현은 medium) | 사용자 2026-11-17 | 품질은 Opus medium 과 비슷하고 비용은 그 40% 다. CI 리뷰(Claude)와 제공자가 갈린다 |
| DECISION3 | 어려운 디버깅과 계약 설계 | Fable 5.2. 2주 뒤 Opus medium 기록과 대조해 계속 쓸지 정한다 | 사용자 2026-11-17 | 사용자가 Fable 을 검토하고 싶어 했다. 자료가 적어 기간을 정해 대조한다 |
| DECISION4 | 정말 어려운 구현 | Fable 5.2 를 쓰는 `impl-hard` 행을 둔다 | 사용자 2026-11-17 | 사용자가 정말 어려운 작업에도 Fable 을 쓰길 원했다 |
| DECISION5 | 한국어 문서 기준 | 「한국어 문서면 Claude」 를 없애고, Codex 에서도 표기 검사가 돌게 한다 | 사용자 2026-11-17 | 검사가 제공자에 묶이지 않으면 문서 일도 Codex 로 보낼 수 있다 |
| DECISION6 | 일반 설계와 문서가 주 산출물인 일 | Codex sol medium | 사용자 2026-11-17 | 비용이 낮고 Codex 를 더 쓰게 된다 |
| DECISION7 | PR 순서 | PR1 Codex 한국어 검사, PR2 선택 표 | 사용자 2026-11-17 | 문서 일을 Codex 로 넘기기 전에 검사가 먼저 있어야 한다 |
| DECISION8 | 분기 없는 작은 문구 수정과 단순 반영 | Claude Haiku | 사용자 2026-11-17 | 가장 싸다. Luna 는 2026-11-16 에 원인만 보고하고 끝내기를 세 번 되풀이했다 |
| DECISION9 | `experiment:` 줄 | 없앤다 | 사용자 2026-11-17 | 815건 가운데 2건만 썼다. 비교는 띄우기 기록으로 대신한다 |
| DECISION10 | 행과 다르게 띄울 때 | 「후보 밖: <이유>」 를 적으면 허용하고 기록에 남긴다 | 사용자 2026-11-17 | 얼마나 자주 벗어났는지 다음 검토에서 본다 |
| DECISION11 | 화면 판정 행 | Codex Terra low | 작성자 | 지금 표의 유일한 후보다 |
| DECISION12 | 보안 리뷰 행 | Claude Sonnet medium | 작성자 | 지금 표가 Codex 에 맡기지 않는다고 정했고, Sonnet 이 그 행의 첫 후보다 |
| DECISION13 | 리뷰 행 | 구현과 다른 제공자 하나(Claude 구현이면 Codex sol medium, Codex 구현이면 Claude Sonnet medium) | 작성자 | 지금 `orch spec review` 가 이미 그렇게 정한다(`spec-writing.md` 131줄) |
| DECISION14 | 6.2 모델 | 표에 넣지 않는다 | 작성자 | 2026-11-17 `codex debug models` 에 없다 |
| DECISION15 | 표기 검사 강도 | 금지어는 커밋 거절, 경고는 보여 주기만. 대상은 커밋하는 한국어 파일 | 사용자 2026-11-17 | 커밋 메시지와 PR 본문은 등록 전에 korean-check 스킬이 이미 본다 |
| DECISION16 | 문서 일의 행 | 정해진 문구만 바꾸면 Haiku, 내용을 새로 쓰면 Codex sol | 사용자 2026-11-17 | 판단이 필요한 문서 일은 작은 모델로 보내지 않는다 |
| DECISION17 | 어려운 일의 기준 | 코디네이터가 판단하고 이유를 적는다 | 사용자 2026-11-17 | 조건 목록으로 묶지 않는다 |
| DECISION18 | Fable 대조 표본 | 건수와 상관없이 12/01 이후 대조한다 | 사용자 2026-11-17 | 정한 날에 판단한다 |
| DECISION19 | 행과 다른 worker 의 뜻과 기본 effort 표기 | 에이전트, 모델, effort 중 하나라도 다르면 다른 worker. 기본 effort 는 `기본` | 작성자 | 행마다 worker 하나라는 원칙(DECISION1)을 그대로 따른다 |
| DECISION20 | 사용 한도로 바꿀 때 | 한도 표를 따르고 「후보 밖: 한도 <제공자>」 로 기록한다. 한도 표에는 Fable 대체(Opus medium, sol medium)도 있다 | 작성자 | 한도 표는 그대로 두고(범위 밖), 벗어남은 모두 기록에 남긴다(DECISION10) |
| DECISION21 | 보안 리뷰와 문서 일 리뷰의 제공자 | 보안 리뷰는 늘 Claude Sonnet, 문서 일 리뷰는 만든 쪽과 다른 제공자 | 작성자 | 지금 표가 보안 리뷰를 Codex 에 맡기지 않는다. 다른 리뷰는 REQ7 과 같다 |
| DECISION22 | 커밋 검사를 받는 worker | orch 가 띄우는 모든 worker. Claude worker 의 커밋도 금지어가 있으면 거절된다 | 사용자 2026-11-17 | git 훅은 에이전트를 구분하지 않고, 검사가 제공자에 묶이지 않아야 한다(DECISION5) |
| DECISION23 | 검사할 파일 | `.md` 만. 이번 커밋에서 더한 줄만 본다 | 사용자 2026-11-17 | 지금 Claude worker 가 받는 검사와 범위가 같다 |
| DECISION24 | 저장소마다 끄는 설정 | 저장소의 orch 설정 한 줄로 그 저장소 worker 에는 걸지 않는다. 기본은 켜짐이다 | 사용자 2026-11-17 | 팀 저장소처럼 표기 기준이 다른 곳에서 끌 수 있어야 한다 |
| DECISION25 | 커밋 훅을 걸지 못했을 때 | 이유를 알리고 worker 는 띄운다 | 사용자 2026-11-17 | 훅 설정 문제 하나로 worker 띄우기가 멈추지 않게 한다 |
| DECISION26 | 한국어 검사기가 고장 났을 때 | `.md` 를 스테이징한 커밋만 거절한다. 거절 안내에 고장 원인과 `worker.commit_check` 로 끄는 방법을 적는다 | 사용자 2026-11-17 | 검사가 조용히 빠지는 것보다 막혀서 드러나는 편이 낫다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: orch 의 운영 규칙이며 `docs/domain/` 의 규칙을 참조하거나 바꾸지 않는다.

## 결정 기록 연결 (필요할 때만)

| 결정 | 종류 | 선택 이유를 남길 ADR | 현재 규칙의 원본 |
| --- | --- | --- | --- |
| DECISION5 | architecture | technical-design 이 Codex 표기 검사 방식을 정하고 [ADR-007](../../adr/007-codex-manifest-without-hooks.md) 과의 관계를 새 ADR 로 남긴다 | 이 스펙의 REQ1 |
