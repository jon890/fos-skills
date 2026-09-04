# CHANGELOG: planning

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 「버전과 변경 이력」 을 따른다.

## 2.1.0

레포 설정의 폴백에서 `CLAUDE.md` 하나만 보던 것을 `AGENTS.md` 와 함께 보도록 바꿨다.
Codex 를 비롯한 다른 에이전트는 `AGENTS.md` 를 읽는다.
## 2.0.0

목표를 셋으로 세우고, 그 셋을 실제로 강제하는 것만 남겼다.

- 사용자와 합의한 것을 `docs/` 에 남긴다
- 그것만 읽고 구현할 수 있는 `tasks/` 를 만든다
- 구현된 것이 합의한 것과 같다

### 만드는 문서와 담을 내용

- 관리하는 문서 다섯에 「담는 것」 과 「정하는 단계」 를 붙였다.
  `docs/flow.md` 는 mermaid 흐름도나 시퀀스 다이어그램으로 그린다.
- 각 단계가 자기 결정이 어느 문서로 가는지 적는다.
- ADR 형식을 정했다. 상태는 `accepted` 와 `superseded` 두 값이고,
  결과 절에 얻는 것과 감당할 것을 둘 다 적으며, ADR 은 지우지 않는다.
  자격은 되돌리는 비용이 크거나 시스템의 핵심 개념을 정할 때다.
- phase 파일을 프롬프트 순서로 두고 `## 컨텍스트` 와 `**근거 문서**` 를 넣었다.
  마지막 작업 항목은 그 phase 를 검증하는 테스트다.

### 판정 가능한 지시만 남긴다

- 통과 조건이 아홉 곳에 흩어져 있던 것을 한 곳으로 모았다.
  「모호점 0」 은 스스로 판정할 수 없어 「남은 질문이 없다」 와
  「사용자만 답할 결정이 남지 않았다」 로 바꿨다.
- self-check 여덟 항목을 지웠다. 같은 컨텍스트가 짚는 목록은 자기 승인이라
  수행 여부를 알 수 없다. 넷은 `verify_task.py` 로 옮겼다.
- `verify-task.sh` 를 `verify_task.py` 로 바꿨다. 위반 아홉 건에도 종료 코드가 0 이었다.
  검사는 여섯에서 열하나가 됐다.
- step 파일 여덟의 절 구성을 통일하고 재진술 절 열을 지웠다.

### 책임 경계

- git 조작을 이 스킬의 책임에서 뺐다. 브랜치와 커밋과 rebase 는 저장소 관례가 정한다.
- 하네스 전용 도구 이름을 제거했다. 다른 에이전트에서도 돌아야 한다.
- 레포 고유 값을 오버레이, `CLAUDE.md`, 사용자 확인 순으로 찾는다.
- `task-create.md` 를 `references/` 로 옮겼다.

### 실측으로 고친 것

- `index.json` 의 `current_phases` 는 오타였다. 실제 191개 중 65건이 `current_phase` 다.
- `depends_on`, `related_docs`, `prerequisites` 를 스키마에서 뺐다.
- `step-8` 이 `SKILL.md` 의 없는 절을 가리키고 있었다.
- 번들이 627줄에서 432줄로, description 이 493자에서 225자로 줄었다.

### 넘어가는 것

`verify-task.sh` 와 `task-create.md` 경로를 이름으로 참조하는 오버레이가 셋 있다.
`fos-accountbook`, `fos-accountbook-backend`, `nhncloud-cli` 다. 그쪽을 함께 고쳐야 한다.

도입 이전 이력은 `git log -- planning/` 에서 본다.
