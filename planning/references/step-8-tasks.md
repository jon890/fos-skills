# Step 8 — task 파일 생성 + 커밋

`tasks/plan{N}-<kebab-slug>/` 아래 `index.json` + `phase-*.md` 를 만든다. **상세 규칙·self-review·task 검증 절차는 `task-create.md`** 를 읽고 따른다.

## 필수 산출물

- `index.json`(status·phases·depends_on·related_docs) + phase 파일들.
- 각 phase: 목표·범위 외·작업 항목·Critical Files·검증(cwd 명시)·의도 메모.
- self-review(placeholder·모순·식별자 일관성) + `scripts/verify-task.sh plan{N}-{slug}`(0 줄).

## 캐낼 모호점 (능동 발굴 → 사용자 확정)

- phase 분할이 애매한가 — 순서 의존·병렬 가능 여부.
- 앞 단계 결정과 phase 내용이 어긋나는 곳(식별자·스키마·라우트 이름 일관).
- 다른 plan 이 같은 파일을 건드려 충돌할 phase.

## 번호·동시성

- 번호는 SKILL.md "동시성 안전"대로: `git fetch` → 원격 스캔 → 브랜치 claim.
- 공유 인덱스(README·data-schema)는 append 편집.

## 게이트 통과

verify-task 0 줄 + self-review 통과 + 모호점 **0** → 커밋·push(완료 후 절차).
