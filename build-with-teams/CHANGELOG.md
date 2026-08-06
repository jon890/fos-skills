# CHANGELOG — build-with-teams

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.4.0

하네스 감사(harness-cleanup)로 드러난 결함을 고치고 지시를 덜어냈다.

- `executor_routing_gate.py` 를 상대경로로 적어 두어 타깃 레포 cwd 에서 실행되지 않았다.
  절대경로로 고쳐 점검이 실제로 돌게 했다.
- korean-style 매핑 표를 어긴 음차 표기 16건을 "점검" 으로 바꿨다.
- 스폰 가드의 소유권을 `references/team-spawn.md` 로 일원화했다.
  split-pane·watchdog 2종이 참조 문서에 없어 개수 표기도 어긋나 있었다.
- 실행 형태 정의와 BOUNDED 선택 규칙이 본문과 참조 문서에 이중으로 있어 참조 문서만 남겼다.
- 실행 모드를 매 호출마다 묻던 강제를 걷고 team-lead 자율 판정으로 바꿨다.
  대신 모드 C 를 "최소 팀" 으로 바꿔 어느 모드에서도 code-reviewer·docs-verifier 를 건너뛰지 않게 했다.
- 반복 지시와 자명한 확인을 걷어냈다.
- `evals/` 를 지웠다. 이 스킬에만 있고 저장소 `evaluation/` 체계와 겹쳐 사용자가 정리를 결정했다.
  `evaluation/` 은 문서 위생과 정성 축만 재므로 실행 형태 판정의 행동 회귀 평가는 대체 없이 사라졌다.
  1.3.0 이 말한 "경계를 고정하는 회귀 평가 세 건" 은 더 이상 존재하지 않는다.

## 1.3.0

실행 등급과 저비용 executor 적합성을 분리했다.

- `standard` 등급을 저비용 모델로 일괄 매핑하지 않도록
  `BOUNDED`, `JUDGMENT_REQUIRED`, `HIGH_RISK` 실행 형태 점검을 추가했다.
- critic이 계획 판정과 별개로 phase별 실행 형태를 회신하게 했다.
- 적합성이 증명되지 않으면 더 엄격한 경로를 선택한다.
  실행 중 새로운 판단이 필요하면 `EXECUTOR_ESCALATE`로 중단·승격하게 했다.
- 상세 계약은 `references/executor-routing.md`로 분리해 critic 평가 전과 executor 스폰 직전에 읽도록 했다.
- `scripts/executor_routing_gate.py`가 누락·불일치·고위험 조건을 결정적으로 승격하거나 스폰을 차단하게 했다.
- 점검의 실패 폐쇄 동작을 단위 테스트로 고정했다.
- `BOUNDED`, `JUDGMENT_REQUIRED`, `HIGH_RISK` 경계를 고정하는 회귀 평가 세 건을 추가했다.

## 1.2.0

pitfalls 대조에서 드러난 결함 두 건을 고쳤다.

- **팀원 이름 규칙이 충돌을 유발하고 있었다.** `name` 을 critic·executor 등으로 통일하라는 지시가
  동시 worktree 환경에서 응답을 엉뚱한 team-lead 로 보내는 원인이었다.
  동시 worktree 가 둘 이상이면 이름에 plan 번호를 붙이도록 바꿨다.
  "이름 충돌 시 suffix 처리는 harness 마다 다르다" 며 오버레이로 넘기던 문장도 지웠다 —
  충돌 조건은 동시 worktree 개수라 harness 와 무관하다.
- **7단계 검사 범위에 diff 범위가 없었다.** 3-dot 을 명시했다.
  2-dot 은 worktree 분기 후 base 에 들어온 외부 커밋까지 끌어와 false positive 를 만든다.

두 건 모두 docu-parser 의 `docs/pitfalls/team/` 에 사고로 기록돼 있었는데
스킬 본문에는 반영되지 않은 상태였다.

## 1.1.0

중복 지시를 걷고 실행 흐름 요약을 절차 앞으로 옮겼다.
SKILL.md 는 464줄에서 452줄이 됐다.

이 스킬은 대부분이 실측 사고에서 나온 가드라 걷어낼 여지가 planning·review-fix 보다 작았다.
확실한 중복만 처리했다.

- "오버레이는 덮어쓰는 게 아니라 채운다" — 오버레이 우선 규칙이 이미 위에 있다.
- `execution_profile` 값 의미와 legacy `model` 매핑 — 스키마 소유자인 `planning/task-create.md` 를 가리키게 바꿨다.
- worktree 절의 정리 시점과 브랜치 보존 — 9단계 7항이 같은 내용을 갖고 있다.
- "의도적으로 안 하는 것" 절 — planning 역할 침범은 2단계, 검증 우회는 9단계 통합 검증이 소유한다.

구조:

- 실행 흐름 요약이 407행에 있어 9단계 절차를 다 읽은 뒤에 나왔다. 절차 첫머리로 옮겼다.

핵심 원칙 4개는 남겼다.
각 절차 섹션과 겹쳐 보이지만 우산 역할이고, "통과 조건은 절차 섹션이 단일 소스" 라는 문장이 이미 중복을 막는다.

## 1.0.0

버전 체계를 도입한 시점의 상태다.
지시 내용은 이 항목에서 바뀌지 않았다.

도입 이전 이력은 `git log -- build-with-teams/` 에서 본다.
