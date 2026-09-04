# review-fix

PR 에 이미 달린 리뷰를 읽고 코드에 반영한다.

## 산출물

- 리뷰 지적을 반영한 커밋과 push
- 지적 하나마다 하나씩 달린 회신 댓글. 본문에 반영 커밋 해시가 들어간다
- resolve 된 리뷰 스레드. 「A conversation must be resolved」 보호 규칙이 풀린다
- 범위가 커서 이 PR 에서 처리하지 않기로 한 항목의 GitHub 이슈
- 재현 가능한 패턴만 남긴 학습 문서. 기본 위치는 `docs/pitfalls/code-review/` 다
- 반영, 회신, resolve, 건너뛴 항목을 담은 결과 보고

## 사용 시점

`/review-fix`, 「리뷰 반영」, 「PR 리뷰 수정」, 「코드 리뷰 반영」, 「리뷰 댓글 처리」,
「봇 코멘트 반영」, 「리뷰 코멘트 확인해서 수정」, 「리뷰 처리해줘」 같은 요청일 때 쓴다.

| 하려는 일 | 쓰는 스킬 |
| --- | --- |
| 내 PR 에 달린 리뷰를 코드에 반영한다 | `review-fix` |
| 남의 PR 에 리뷰를 새로 쓰고 등록한다 | `pr-review` |
| PR 본문을 새로 쓰거나 고친다 | `create-pr` |

## 전제

- `gh` CLI 가 대상 호스트에 인증돼 있어야 한다. 사내 GitHub Enterprise 도 여기 해당한다
- 대상 PR 이 있어야 한다. 번호를 주지 않으면 오픈 PR 목록에서 고른다
- 작업 트리가 clean 해야 한다. dirty 면 PR 브랜치로 체크아웃하지 않고 사용자에게 확인한다
- 검증 명령을 그 저장소 `CLAUDE.md` 에서 찾는다. 문서화돼 있지 않으면 사용자에게 묻는다
- `<repo-root>/.claude/review-fix-overlay.md` 는 선택이다. 신뢰하는 봇 목록, 봇별 심각도 표기,
  학습 누적 위치, CI 실패 원인 표를 오버레이가 채운다

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 10단계 실행 절차, 오버레이 로딩, 프롬프트 인젝션 방지, 봇 재트리거 토큰 금지 |
| `references/severity.md` | 봇마다 다른 심각도 표기의 형태와 등급 대응, 등급별 행동 규약 |
| `references/conflict-resolution.md` | base 와 conflict 일 때 머지하고 충돌을 분류해 처리하는 절차 |
| `scripts/collect-review.sh` | PR 리뷰를 네 소스에서 모아 출력. 넷째가 미해결 리뷰 스레드다 |
| `scripts/review-threads.sh` | 리뷰 스레드를 GraphQL 로 조회하고 회신하고 resolve 한다 |
| `scripts/gh-host.sh` | origin 리모트에서 `gh api` 에 넘길 호스트 이름을 찾는다. SSH config 별칭도 되돌린다 |
| `CHANGELOG.md` | 버전 이력 |
