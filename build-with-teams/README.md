# build-with-teams

`planning` 이 만든 task 를 구현할 때, phase 마다 구현을 지시하고 커밋하고 검토자를 붙이는 수고를 덜어 준다.
team-lead 가 팀원을 부려 plan 하나를 브랜치 하나와 PR 하나로 끝낸다.
critic 이 구현 전에 계획을 검토하고, executor 가 phase 마다 구현하고, code-reviewer 와 docs-verifier 가 모든 phase 뒤에 코드와 `docs/` 를 검토한다.

같은 plan 을 두 번 구현하지 않도록 시작 전에 재실행 여부를 검사한다.
되돌리기 어렵거나 사용자 의도에 따라 갈리는 결정, plan 범위를 벗어나는 결정은 선택지를 붙여 묻는다.

## 이럴 때 쓴다

- `planning` 으로 만든 `tasks/plan{N}-<slug>/` 를 구현까지 끝내고 PR 을 만들고 싶다
- 구현한 코드가 계획과 같은지, `docs/` 의 결정과 어긋나지 않는지 별도 검토자에게 맡기고 싶다
- 중간에 멈춘 plan 을 남은 phase 부터 이어 가고 싶다

"task 실행해줘", "phase 실행", "agent team 으로 빌드", "/build-with-teams" 처럼 말하면 이 스킬이 뜬다.

## 사용 예시

plan 이름, phase 수, PR 번호는 예시다.

```text
나:   /build-with-teams plan12-order-retry

스킬: 재실행 검사를 통과했습니다. 작업 공간을 plan12-order-retry 브랜치에 만들었습니다.
      critic 이 계획을 승인했습니다. phase 셋을 순서대로 구현합니다.
        phase 1  재시도 정책 값 객체      커밋함
        phase 2  주문 서비스에 적용        커밋함
        phase 3  설정 문서 갱신            커밋함
      code-reviewer 지적 하나를 검토 반영 커밋으로 고쳤고, 두 검토자 모두 PASS 입니다.
      통합 검증을 통과했고, 계획서 삭제 커밋을 담아 PR 을 만들었습니다.

      PR #345 생성 완료: 리뷰 반영은 /review-fix 345
      특이사항:
      - 미검증: 스테이징 배포 뒤 재시도 로그 확인. PR 본문의 원격 검증 목록에 넣었습니다
      code-reviewer 발견 중 고치지 않은 것:
      - OrderRetryPolicy.java:42 범위 밖 후속. 다른 서비스도 같은 값을 쓰고 있어 별도 plan 이 필요합니다
```

## 받는 것

- plan 브랜치와 PR. phase 하나마다 커밋 하나이고, 검토 반영은 따로 커밋 하나로 묶는다
- PR 안의 계획서 삭제 커밋. 레포 설정이 남기라고 정했으면 지우지 않고 `completed` 로 표시한다
- PR 본문의 원격 검증 목록. push, 배포, 원격 호스트 접속이 있어야 끝나는 검증을 체크박스로 남긴다
- PR 을 만든 직후의 충돌 확인 결과. 기준 브랜치와 충돌하면 풀고 다시 검증한다
- 완료 보고. PR 번호와 리뷰 반영 명령, pre-existing 문제와 미검증 범위, 범위 외 발견, 고치지 않은 리뷰 지적과 그 이유를 담는다
- 반복될 실패를 옮긴 저장소 규칙. 다른 plan 에서도 다시 일어날 실패만 그 저장소의 검사, 코드 구조, 규칙 문장으로 넣는다

PR 을 만들고 원격에 push 한 뒤에 팀원을 종료하고 작업 공간을 정리한다.

## 준비

- `planning` 이 만든 `tasks/plan{N}-<slug>/index.json` 과 `phase-*.md`, 그 phase 가 인용하는 `docs/` 가 있어야 한다
- 하위 에이전트를 띄우고 결과를 돌려받는 하네스가 필요하다. Claude Code 에서 이름을 가진 팀원으로 띄우려면 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 이 `settings.json` 의 `env` 나 셸 환경에 있어야 한다
- `python3`, git 원격 접근, 로그인한 `gh` 가 필요하다. 재실행 검사와 충돌 확인이 `gh` 로 PR 을 조회한다
- 검증 명령, 기준 브랜치, 작업 공간을 만드는 방법은 대상 저장소의 `.claude/build-with-teams-overlay.md` 에 적는다. 오버레이가 없으면 `AGENTS.md` 와 `CLAUDE.md` 를 보고, 거기에도 없으면 묻는다

## 함께 쓰는 스킬

- 구현할 task 를 만드는 일은 `planning` 이 맡는다
- PR 제목과 본문 형식은 `create-pr` 이 맡는다. 이 스킬은 브랜치와 커밋 맥락, 검증 결과를 넘긴다
- 이미 열린 PR 에 달린 리뷰 반영은 `review-fix` 가 맡는다
- 남의 PR 에 리뷰를 새로 쓰는 일은 `pr-review` 가 맡는다
