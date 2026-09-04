# planning

사용자와 합의한 것을 `docs/` 에 남기고, 그것만 읽고 구현할 수 있는 `tasks/` 를 만든다.

## 산출물

대상 저장소에 아래가 남는다.

| 산출물 | 내용 |
| --- | --- |
| `docs/prd.md`, `docs/flow.md`, `docs/code-architecture.md`, `docs/data-schema.md` | 이번 변경이 영향을 준 부분의 갱신 diff |
| `docs/adr/NNN-<슬러그>.md` | 이번에 내린 기술 결정 하나마다 한 파일 |
| `tasks/plan{N}-<kebab-slug>/index.json` | plan 하나의 phase 목록과 상태 |
| `tasks/plan{N}-<kebab-slug>/phase-*.md` | 이 대화를 보지 못한 구현자가 읽고 실행하는 실행 명세 |
| 커밋 | 문서 갱신과 task 파일을 담은 기획 커밋 |

`docs/` 는 구현이 끝난 뒤에도 읽는 문서이고, `tasks/` 는 구현이 끝나면 역할이 끝난다.

규모가 크면 plan 을 여러 디렉터리로 나눈다.
한 plan 은 한 번에 검토할 수 있는 크기이고 PR 하나에 대응한다.

## 사용 시점

새 기능이나 변경을 구현하기 전에 쓴다.
"계획 세워보자", "설계해보자", "task 파일 만들어줘", "구현 전 검토", "리팩토링 계획" 같은 요청이 여기 해당한다.

| 하려는 일 | 쓰는 스킬 |
| --- | --- |
| 구현 전에 합의를 문서로 남기고 task 를 만든다 | `planning` |
| 만들어진 task 를 읽어 구현하고 PR 까지 만든다 | `build-with-teams` |
| 이미 있는 `docs/` 가 코드와 맞는지 감사한다 | `docs-check` |
| 하네스 지침과 스킬 본문이 실행 환경과 맞는지 감사한다 | `harness-cleanup` |

## 전제

- **대상 저장소의 레포 설정.** `<repo-root>/.claude/planning-overlay.md` 를 먼저 보고,
  없으면 그 저장소의 하네스 지침 파일(`AGENTS.md`, `CLAUDE.md`)을 본다.
  검증 명령, 레이어 구조, 도메인 변형, 필수 다섯 밖의 추가 문서가 여기 들어 있다.
  둘 다 없거나 그 값이 없으면 사용자에게 확인한다.
- **사용자가 답할 수 있는 상태.** 각 단계의 통과 조건에 사용자 확정이 들어 있어
  취향, 범위, 되돌리기 어려운 선택은 물어서 정한다.
- **`python3`.** task 생성 직후 `scripts/verify_task.py` 를 돌린다.
- **반복 함정 목록.** 레포 설정이 지정한 경로를 쓰고, 지정이 없으면 `docs/pitfalls/` 를 읽는다.
  그 디렉터리도 없으면 사전 확인 항목을 건너뛴다.

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 관리 문서 다섯의 책임 분담, 레포 설정 탐색 순서, 8단계 표와 단계별 통과 조건, task 생성 직후 확인 절차 |
| `references/step-1-feasibility.md` | 구현 가능 판단, 재사용 지점을 파일 경로로 짚는 기준, 리스크와 제약 |
| `references/step-2-tech-stack.md` | 기존 스택으로 되는지 판단, 새 의존 도입 심사, ADR 로 남길 조건 |
| `references/step-3-flow.md` | 정상 흐름과 에러·빈 상태·동시 요청의 갈래, `docs/flow.md` 에 mermaid 로 남기는 규칙 |
| `references/step-4-interface.md` | UI·CLI·backend 별로 확정할 표면, 경로와 라벨과 필드명을 유예하지 않는 기준 |
| `references/step-5-api.md` | 엔드포인트와 함수 시그니처, 요청과 응답 스키마, 4단계와 병합할 때의 표기 |
| `references/step-6-data-code.md` | 테이블과 컬럼과 키와 제약, cascade 범위, 새 코드가 앉을 레이어와 디렉터리 |
| `references/step-7-docs.md` | 필수 다섯 전체의 영향 판정, ADR 로 남길 결정을 가르는 두 조건 |
| `references/step-8-tasks.md` | phase 분할 기준, plan 을 나눌 조건, plan 번호를 원격까지 훑어 정하는 방법 |
| `references/task-create.md` | `index.json` 스키마, ADR 템플릿과 supersede 처리, phase 파일 구조와 작성 규칙 |
| `scripts/verify_task.py` | 기계로 판정되는 task 위생 일곱 가지 검출. 종료 코드 0 통과, 1 위반, 2 실행 불가 |
| `CHANGELOG.md` | 버전 이력 |

실행 절차는 `SKILL.md` 가 소유한다.
