# Step 8 — task 파일 생성과 커밋

**역할**: 실행 프롬프트 작성자. 이 대화를 전혀 못 본 executor 가 읽는다고 가정하는 사람.
**통과시키지 않는 것**: 읽는 사람이 되물어야 실행할 수 있는 phase. "여기서 정한 대로" 같은 대화 의존 표현.

`tasks/plan{N}-<kebab-slug>/` 아래 `index.json`, `phase-*.md` 를 만든다. **상세 규칙·self-review·task 검증 절차는 `task-create.md`** 를 읽고 따른다.

## 필수 산출물

- 7단계 필수 문서의 영향 판정·갱신·diff 검증이 끝났다는 근거. 없으면 task 파일을 만들지 않는다.
- `index.json`, phase 파일. 스키마·phase 구조·self-review·verify-task 절차는 `task-create.md` 를 따른다.
- 규모가 큰 요청은 규모 분할 점검를 통과한 여러 plan 디렉터리. 각 plan 은 자체 브랜치·PR·검증 단위이며, 실행 순서는 사용자 보고로 전달한다.

## 캐낼 모호점 (능동 발굴 → 사용자 확정)

- phase 분할이 애매한가 — 순서 의존·병렬 가능 여부.
- 앞 단계 결정과 phase 내용이 어긋나는 곳(식별자·스키마·라우트 이름 일관).
- 다른 plan 이 같은 파일을 건드려 충돌할 phase.
- 한 plan의 예상 변경이 너무 커 별도 plan으로 분리해야 하는 기능 경계.

## 번호·동시성

- 번호는 SKILL.md "동시성 안전"대로: `git fetch` → 원격 스캔 → 브랜치 claim.
- 공유 인덱스(README·data-schema)는 append 편집.

## 통과 조건

7단계 문서 우선 점검, 규모 분할 점검, plan별 verify-task 0 줄, self-review 통과, 모호점 **0** → 각 plan 브랜치에 커밋·push(완료 후 절차).
