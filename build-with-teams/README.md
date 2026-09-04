# build-with-teams

planning 이 만든 `tasks/` 를 읽어 구현하고, 검토를 거쳐 PR 을 만든다.

## 산출물

plan 하나를 브랜치 하나와 PR 하나로 끝낸다.

| 산출물 | 내용 |
| --- | --- |
| plan 브랜치의 커밋 | phase 하나마다 커밋 하나. 다른 plan 의 변경이 섞이지 않는다 |
| `tasks/plan{N}-<slug>/index.json` | 완료 마킹. PR 브랜치 안에서만 한다 |
| PR | base 는 `main`, head 는 plan 브랜치. 기획 커밋과 phase 별 커밋을 구분해 나열하고 「특이사항 및 후속」 절을 담는다 |
| 완료 보고 | PR 번호와 리뷰 반영 명령, pre-existing 과 미검증과 범위 외 발견, code-reviewer 지적 중 고치지 않은 것과 그 이유 |
| 반복 함정 문서 | 승격 조건을 만족한 사건만 저장소의 반복 함정 목록에 추가된다 |

정리된 작업 공간도 결과에 포함된다. PR 생성과 원격 push 가 끝난 뒤에 팀원을 종료하고 작업 공간을 정리한다.

## 사용 시점

planning 이 만들어 둔 task 를 실제로 구현할 때 쓴다.
"task 실행해줘", "phase 실행", "agent team 으로 빌드" 같은 요청이 여기 해당한다.

| 하려는 일 | 쓰는 스킬 |
| --- | --- |
| 만들어진 task 를 구현하고 PR 까지 만든다 | `build-with-teams` |
| 구현할 task 를 먼저 만든다 | `planning` |
| 이미 열린 PR 에 달린 리뷰 댓글을 반영한다 | `review-fix` |
| 남의 PR 에 리뷰를 새로 쓴다 | `pr-review` |

## 전제

- **planning 의 산출물.** `tasks/plan{N}-<slug>/index.json` 과 `phase-*.md`,
  그리고 그 phase 가 인용하는 `docs/` 가 있어야 한다.
- **하위 에이전트를 띄우고 결과를 받는 하네스.** 이것이 없으면 스킬이 돌지 않는다.
  결과 회수와 재투입 수단이 없을 때의 대응은 `references/team-spawn.md` 가 정한다.
- **대상 저장소의 레포 설정.** `<repo-root>/.claude/build-with-teams-overlay.md` 를 먼저 보고,
  없으면 그 저장소의 하네스 지침 파일(`AGENTS.md`, `CLAUDE.md`)을 본다.
  통합 검증 명령, 브랜치 이름 형식, 작업 공간을 만들고 정리하는 방법,
  네 역할에 쓸 전용 에이전트 이름, 커밋과 PR 컨벤션, 의존성 설치 방법이 여기 들어 있다.
  둘 다 없거나 그 값이 없으면 사용자에게 확인한다.
- **`python3` 과 git 원격 접근.** 1단계에서 `scripts/plan_precheck.py` 를 돌리고,
  plan 브랜치를 원격 위에서 만들어 push 한다.

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 팀 구성과 파이프라인, 레포 설정 탐색 순서, 6단계 표와 통과 조건, 단계별 team-lead 행동 |
| `references/team-spawn.md` | 하네스 요구 조건과 하네스별 대응, 팀원 이름, 스폰 프롬프트에 넣을 문구, 무응답과 스폰 실패 처리 |
| `references/role-critic.md` | critic 이 읽는 계약. `REVISE` 판정 기준과 회신 형식 |
| `references/executor-routing.md` | 실행 형태 `BOUNDED` 와 `HIGH_RISK` 의 판정, 실행 등급 선택과 승격 규칙, phase 마다 남길 기록 |
| `references/role-executor.md` | executor 가 읽는 계약. 구현 범위와 품질 기준, 계획이 틀렸을 때의 보고 |
| `references/role-code-reviewer.md` | code-reviewer 가 읽는 계약. 3-dot 으로 잡는 검사 범위와 `PASS` / `FIX_NEEDED` 판정 |
| `references/role-docs-verifier.md` | docs-verifier 가 읽는 계약. `docs/` 대조 축과 `PASS` / `UPDATE_NEEDED` / `VIOLATION` 판정 |
| `references/step-finish.md` | 통합 검증 실패의 책임 구분, 완료 마킹, PR 내용, 팀 종료와 작업 공간 정리, 보고 형식, 반복 함정 승격 조건 |
| `scripts/plan_precheck.py` | 재실행 사고를 막는 사전 검증. 종료 코드 0 진행 가능, 1 사용자 결정 필요, 2 실행 불가 |
| `tests/test_plan_precheck.py` | `plan_precheck.py` 판정 함수의 단위 검사 |
| `CHANGELOG.md` | 버전 이력 |

실행 절차는 `SKILL.md` 가 소유한다.
