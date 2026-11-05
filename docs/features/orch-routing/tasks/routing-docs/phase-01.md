# Phase 01. 모델 선택 지침을 실측과 확정한 결정에 맞춘다

**Execution profile**: standard

## 목표

`agent-selection.md` 와 `spec-writing.md` 가 스펙에서 확정한 모델 선택 규칙(Opus `high` 근거, 행 id, Codex 행 조건, 실험 줄)과 실측 근거를 담는다. 코디네이터가 다음 지시서부터 새 꼴로 쓰게 하려는 것이다.

**범위 외**: 스크립트(`skills/orch/scripts/**`)와 테스트 코드. `spec-lint`·`launch-worker` 의 검사, 띄우기 이력, routing 기록, 집계 명령은 뒤 계획(index 의 `deferred`)이 맡는다. 공통 지시서 틀은 phase 02 가 맡는다.

## 컨텍스트

**요구사항**: REQ2, REQ8(문서 쪽)

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`, `docs/features/orch-routing/evidence.md`

- 스펙 결정: DECISION1(근거 꼴), DECISION2(Opus 만), DECISION7(실험 줄), DECISION9(Codex 행 조건), DECISION14(`xhigh`, `max` 포함), DECISION20(행 id). 설계 DECISION1(id 의 원본은 모델 표).
- 이 PR 이 머지돼도 새 요소(`행:`, `high 근거:`)의 검사는 아직 없다. 문서는 「적는다」 규칙만 쓰고 「`spec-lint` 가 막는다」 는 문장은 쓰지 않는다. 지금 검사를 말하는 기존 문장(`spec-writing.md` 의 「요소가 빠지면 `선택` 발견으로 막고」, `agent-selection.md` 머리, `SKILL.md` 1단계)에는 「지금 검사는 에이전트·모델·effort·비교·이유만 본다. `행:` 과 `high 근거:` 는 코디네이터가 확인한다」 를 붙인다. 검사 문장은 검사를 넣는 뒤 PR 이 더한다. 지금 없는 동작을 문서가 말하면 코디네이터가 검사를 믿고 확인을 건너뛴다.
- 행 id 는 영문 소문자와 하이픈이다. 뒤 PR 의 `spec-lint` 가 이 열을 읽으므로 표의 첫 열이어야 하고, 셀은 백틱으로 감싼 id 하나다.

## 의도 메모

- 실측 수치는 `evidence.md` 에만 두고 `agent-selection.md` 에는 요지 두세 줄과 링크, 측정일, 표본 수만 둔다. 수치를 두 곳에 두면 다음 측정 때 한쪽이 낡는다.
- 행 id 를 지금 넣는 이유: 뒤 PR 이 검사를 켜기 전에 코디네이터가 새 꼴로 지시서를 쓰기 시작해야, 검사를 켠 날 막히는 지시서가 적다.
- `experiment:` 줄은 이 PR 에 넣지 않는다. 배정 도구 없이 안내만 두면 실험 후보의 Opus `high` 근거 면제(스펙 DECISION7)만 열려 우회 길이 된다. 안내와 검사를 함께 뒤 PR(routing-check)이 더한다.
- 「사용 한도에 걸렸을 때」 표의 Opus 대응은 그대로 둔다. 한도 때문에 Opus 에서 내리는 쪽이라 이번 제한과 부딪히지 않는다.

## 작업 항목

### 1. `skills/orch/references/agent-selection.md` 「모델」 표

- 첫 열 `id` 를 더한다. 값: `impl-planned`(계획서가 있고 수정 위치와 검증 명령이 정해진 구현), `small-fix`(작은 수정), `simple-apply`(단순 반영), `impl-explore`(여러 파일 구현), `hard-design`(어려운 디버깅, 계약 설계, 데이터 마이그레이션), `visual`(화면·이미지 판정), `review`(리뷰와 검증), `security-review`(보안 리뷰).
- `impl-planned` 와 `impl-explore` 행의 sol 후보에 「결정이 닫혀 질문 없이 끝낼 Task」 조건을 더하고, 사용자 결정이 남은 Task 는 Claude 로 띄운다고 적는다(DECISION9). 근거로 evidence 표 2(sol high 질문 2.17, 지시 3.94)를 한 줄로 링크한다.
- `hard-design` 행의 Opus effort 칸을 「`medium`. `high` 이상은 아래 「Opus `high`」 의 근거가 있을 때만」 으로 고친다.
- 표 아래에 「지시서의 `worker 선택:` 줄에 `행: <id>` 를 적는다」 한 줄을 둔다. 꼴은 `spec-writing.md` 가 소유한다고 가리킨다.

### 2. 같은 파일에 「Opus `high`」 절(「모델」 아래 `###`)

- 규칙: Claude Opus 5.5 에 `high`, `xhigh`, `max` 를 고르려면 `worker 선택:` 줄에 「high 근거: medium 실패 <dispatch id>」 나 「high 근거: 사용자 지정 YYYY-MM-DD」 를 적는다. 근거로 적는 dispatch 는 그 저장소에서 Opus `medium` 으로 띄운 dispatch 다. 브랜치는 달라도 된다. 실패였는지는 코디네이터가 판단한다. 실험 후보 면제는 실험 줄과 함께 뒤 PR 이 더하므로 지금은 쓰지 않는다.
- 이유: evidence 의 요지(같은 크기에서 Opus `high` 가 준비 두 배, 비용 두 배 남짓이고 품질 차이가 없다, 지시서의 83% 가 Opus `high`, 한도에 걸린 PR 은 모두 Opus) 세 줄과 `docs/features/orch-routing/evidence.md` 링크(측정 2026-11-05, ai-analysis PR 486건).
- Sonnet `high`, sol `high` 는 이 규칙 밖이고 표의 effort 칸을 따른다(DECISION2).

### 3. 같은 파일 「effort」 표

- `high` 행에 「Opus 는 「Opus `high`」 절의 근거가 있을 때만」 을 더한다. `xhigh`, `max` 행에도 Opus 는 같은 근거가 필요하다고 더한다(DECISION14).

### 4. 같은 파일 「비교 근거」 표

- `모델 id` 열을 더한다(`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`). 뒤 PR 의 집계 명령이 이 열로 가격을 찾는다(설계 「`orch routing report`」).

### 5. 같은 파일 「실측 기록」 절

- 첫 측정 결과를 적는다: 측정일 2026-11-05, 대상(저장소 하나, PR 486건), 요지 한 줄, `evidence.md` 링크.
- 「형식」 항목: PR 하나에 JSON 한 줄. 키 목록은 스펙 「기록 항목」 을 가리키고 복제하지 않는다. 토큰만 남기고 금액은 집계 때 계산하며 본문은 남기지 않는다(DECISION4).
- 「쓰는 자리」 항목: `<orch 루트>/state/routing-log.jsonl`(DECISION6). 지금 문장의 「launched-workers 에 에이전트, 모델, effort 가 없어 함께 더한다」 는 지운다. 그 내용은 스펙 REQ4 가 갖는다.
- 「쓰는 주체」 항목: 머지된 PR 은 `finish-pr` 가, 머지 없이 닫힌 PR 과 마무리가 빠진 머지 PR 은 `cleanup-sweep` 이 쓴다(DECISION5, 설계 DECISION10).
- 「구현은 후속으로 남겼다」 는 「구현 중이다. 스펙 `docs/features/orch-routing/spec.md`」 로 바꾼다.
- 다시 보는 주기는 그대로(행마다 10건 또는 한 달) 두고, 수치마다 측정일과 표본 수를 적는다고 더한다(DECISION8).

### 6. `skills/orch/references/spec-writing.md` 「넣을 것」 의 `worker 선택:` 항목

- 꼴을 「worker 선택: `<에이전트>` `<모델>` effort `<effort>`. 행: <id>. [high 근거: ….] 비교: <다른 후보>. 이유: <고른 이유>.」 로 바꾸고 예를 하나 고친다. `행:` 은 모든 새 지시서에 적고, `high 근거:` 는 `agent-selection.md` 「Opus `high`」 가 요구할 때만 적는다고 쓴다.
- effort 를 지정하지 않는 행(Haiku)은 effort 를 `기본` 으로 적는다고 쓴다.
- 같은 항목의 「요소가 빠지면 `선택` 발견으로 막고」 문장 뒤에 「지금 검사는 에이전트·모델·effort·비교·이유만 본다. `행:` 과 `high 근거:` 는 코디네이터가 확인한다」 를 붙인다.
- `experiment:` 줄은 쓰지 않는다(의도 메모).

### 7. `skills/orch/SKILL.md` 1단계 문장

- 117줄 근처 「Task 성격으로 모델과 effort 를 고르고」 문장에 「모델 표의 행 id」 를 더하고, 「`spec-lint` 와 `launch-worker` 가 이 줄을 검사한다」 뒤에 「지금은 행 id 와 high 근거를 보지 않는다」 를 붙인다. 개요 표(105줄)의 통과 조건에도 「행 id」 를 더한다.
- `agent-selection.md` 머리(5줄 근처)의 「`spec-lint` 가 줄이 없는 지시서를 막고」 문장에도 같은 한 줄을 붙인다.

### 8. 변경 이력 조각 `skills/orch/changes/routing-guide.minor.md`

- `- ` 줄 1~3개: 모델 표 행 id, Opus `high` 근거 규칙과 실측 근거. 형식은 README 「버전과 변경 이력」 이다.

## 검증

```bash
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/references/agent-selection.md skills/orch/references/spec-writing.md skills/orch/SKILL.md skills/orch/changes/routing-guide.minor.md
node scripts/check-skill-docs.ts orch
python3 -m unittest discover -s scripts/tests
python3 skills/plan/scripts/run_doc_checks.py --skill spec docs/features/orch-routing/spec.md
awk '/^## 모델/,/^### 두 모델/' skills/orch/references/agent-selection.md | grep -c '^| `[a-z-]*` |'
awk '/^## 모델/,/^### 두 모델/' skills/orch/references/agent-selection.md | grep -o '^| `[a-z-]*` |' | sort | uniq -d | wc -l
grep -c '결정이 닫혀 질문 없이 끝낼 Task' skills/orch/references/agent-selection.md
grep -c 'high 근거: medium 실패' skills/orch/references/agent-selection.md skills/orch/references/spec-writing.md
awk '/^## effort/,/^## Codex/' skills/orch/references/agent-selection.md | grep -c 'Opus'
awk '/^### 비교 근거/,/^- 보안 리뷰/' skills/orch/references/agent-selection.md | grep -c 'claude-opus-5-5\|claude-sonnet-5-5\|claude-haiku-5-5'
awk '/^### 실측 기록/,/^## effort/' skills/orch/references/agent-selection.md | grep -c '2026-11-05\|486\|orch-routing/evidence.md'
grep -c '행: <id>\|행: ' skills/orch/references/spec-writing.md
grep -c 'experiment:' skills/orch/references/spec-writing.md
grep -c '지금 검사는\|지금은 행 id' skills/orch/references/spec-writing.md skills/orch/references/agent-selection.md skills/orch/SKILL.md
test -f docs/features/orch-routing/evidence.md
git diff --name-only origin/main -- skills/orch/scripts skills/orch/tests | wc -l
```

기대값:

- 첫 네 명령 종료 코드 0.
- 「모델」 절 id 줄은 8, 중복 0.
- 「결정이 닫혀 질문 없이 끝낼 Task」 는 2 이상(sol 후보가 있는 두 행).
- `high 근거: medium 실패` 는 두 파일 모두 1 이상.
- effort 절의 Opus 언급은 2 이상(`high` 행, `xhigh`·`max` 행).
- 비교 근거 표의 Claude 모델 id 는 3(지금 0. Codex 모델은 이미 id 로 적혀 있어 세지 않는다).
- 실측 기록 절의 측정일·표본·링크는 3 이상.
- `spec-writing.md` 의 `행:` 은 2 이상(꼴과 예), `experiment:` 는 0(뒤 PR 몫).
- 「지금 검사는」, 「지금은 행 id」 는 세 파일 모두 1 이상.
- 마지막 명령은 0(스크립트와 테스트를 고치지 않았다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/references/agent-selection.md` | 수정 |
| `skills/orch/references/spec-writing.md` | 수정 |
| `skills/orch/SKILL.md` | 수정 |
| `skills/orch/changes/routing-guide.minor.md` | 신규 |
