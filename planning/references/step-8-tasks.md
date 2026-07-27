# Step 8 — task 파일 생성 + 커밋

`tasks/plan{N}-<kebab-slug>/` 아래 `index.json` + `phase-*.md` 를 만든다. **상세 규칙·self-review·task 검증 절차는 `task-create.md`** 를 읽고 따른다.

## 필수 산출물

- 7단계에서 필수 관리 문서 다섯 개의 영향 판정·실제 갱신·diff 검증이 끝났다는 근거. 이 선행 조건이 없으면 task 파일을 만들지 않는다.
- `index.json`(status·phases·depends_on·related_docs) + phase 파일들.
- `related_docs`는 task가 직접 수정하거나 구현 중 특별히 참조해야 하는 문서만 선택적으로 연결한다. 7단계 필수 문서 갱신의 증거로 사용하지 않는다.
- 각 phase: 목표·범위 외·작업 항목·Critical Files·검증(cwd 명시)·의도 메모.
- self-review(placeholder·모순·식별자 일관성) + `~/.claude/skills/planning/scripts/verify-task.sh plan{N}-{slug}`(cwd 는 타깃 레포 루트, 0 줄).
- 규모가 큰 요청은 SKILL.md의 규모 분할 게이트를 통과한 여러 plan 디렉터리. 각 plan은 자체 브랜치·PR·검증 단위이며 `depends_on`으로만 연결한다.

## 캐낼 모호점 (능동 발굴 → 사용자 확정)

- phase 분할이 애매한가 — 순서 의존·병렬 가능 여부.
- 앞 단계 결정과 phase 내용이 어긋나는 곳(식별자·스키마·라우트 이름 일관).
- 다른 plan 이 같은 파일을 건드려 충돌할 phase.
- 한 plan의 예상 변경이 너무 커 별도 plan으로 분리해야 하는 기능 경계.

## 번호·동시성

- 번호는 SKILL.md "동시성 안전"대로: `git fetch` → 원격 스캔 → 브랜치 claim.
- 공유 인덱스(README·data-schema)는 append 편집.

## 게이트 통과

7단계 문서 우선 게이트 + 규모 분할 게이트 + plan별 verify-task 0 줄 + self-review 통과 + 모호점 **0** → 각 plan 브랜치에 커밋·push(완료 후 절차).
