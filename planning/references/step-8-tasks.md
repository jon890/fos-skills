# Step 8. task 파일 생성

**역할**: 실행 프롬프트 작성자. 이 대화를 전혀 보지 못한 구현자가 읽는다고 가정한다.
**통과시키지 않는 것**: 읽는 사람이 되물어야 실행할 수 있는 phase. "여기서 정한 대로" 같은 대화 의존 표현.

`tasks/{접두사}plan{N}-<kebab-slug>/` 아래 `index.json` 과 `phase-*.md` 를 만든다.
접두사와 tasks 경로는 레포 설정이 지정한다. 지정이 없으면 접두사 없이 `tasks/` 다.
스키마와 phase 구조는 `task-create.md` 가 소유한다.

## 정할 것

- 7단계 문서 갱신과 diff 검증이 끝났다는 근거. 없으면 task 파일을 만들지 않는다.
- `index.json` 과 phase 파일.
- push, 배포, 원격 호스트 접속이 있어야 끝나는 검증. phase 의 「검증」 절에 넣지 않고 `remote-verification.md` 에 모은다.
  형식은 `task-create.md` 의 「원격 검증 목록」 이 소유한다.
- 범위가 plan 크기 기준에 들어가는지, 넘으면 어떻게 자르는지는 [`plan-size.md`](plan-size.md) 가 소유한다.

## 물어서 확정할 것

- phase 분할. 순서 의존이 있는가 병렬로 되는가.
- 앞 단계 결정과 phase 내용이 어긋나는 곳. 식별자, 스키마, 경로 이름이 같은가.
- 다른 plan 이 같은 파일을 건드려 충돌할 phase.
- phase 를 쓰기 전에 어디서 자를지([`plan-size.md`](plan-size.md)).

## 번호를 정하는 방법

**스크립트로 훑는다.** `$SKILL_DIR` 은 이 스킬 번들 경로다.
`$TASKS_DIR` 과 `$PLAN_PREFIX` 는 레포 설정의 tasks 경로와 plan 접두사다. 지정이 없으면 비워 둔다.

```bash
# cwd: 타깃 레포 root
bash "$SKILL_DIR/scripts/plan_number.sh" --tasks-dir "${TASKS_DIR:-tasks}" ${PLAN_PREFIX:+--prefix} ${PLAN_PREFIX:+"$PLAN_PREFIX"}
```

`--prefix` 와 값을 따로 펼친다. `${PLAN_PREFIX:+--prefix "$PLAN_PREFIX"}` 로 묶으면 zsh 가 낱말을 나누지 않아 `--prefix plan` 한 낱말로 넘어간다.

마지막 줄이 다음 번호다. 접두사가 있으면 그 접두사의 번호만 센다.
`origin/main 밖에만 있다` 로 나온 번호는 머지되지 않은 브랜치가 쥔 것이고 그 번호도 쓰지 않는다.
로컬 `tasks/` 만 보면 그 번호가 보이지 않는다.
`지워졌고 git 이력에만 있다` 로 나온 번호는 구현이 끝나 지운 계획서다. 그 번호도 다시 쓰지 않는다.
`PR 브랜치 이름에만 있다` 는 계획서를 지운 뒤 squash 머지하고 브랜치까지 지운 번호다.

**plan 브랜치 이름은 `{접두사}plan{N}-{slug}` 나 `plan/{접두사}{N}-{slug}` 로 짓는다.**
squash 머지 뒤에는 git 이력에 계획서가 남지 않아, 스크립트가 `gh pr list` 의 브랜치 이름에서 번호를 읽는다.
다른 형식이면 그 번호를 읽지 못한다. 마지막 줄 앞에 `PR 이력을 보지 못했다` 가 나오면 `gh` 인증을 고치고 다시 돌린다.

- 저장소가 번호 확보 관례를 따로 두면 그것을 따른다. 없으면 이 스크립트의 결과를 쓴다.
- ADR 목록처럼 여러 plan 이 함께 고치는 색인 파일(레포 설정이 지정)은 끝에 덧붙인다. 동시에 도는 다른 planning 과 같은 줄을 고치지 않기 위해서다.
