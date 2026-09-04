# pr-review

남의 PR 에 코드 리뷰를 쓰고 등록한다.

## 산출물

- PR 에 등록된 인라인 리뷰 댓글. 첫 줄에 `(P1)` 부터 `(P5)` 까지의 등급 표기가 붙는다
- 기존 스레드에 단 답글
- 등록 전에 사용자가 읽는 렌더링 미리보기
- 이 PR 소관이 아니라고 판정한 것의 후속 업무
- 등록 위치와 등급, 담은 내용의 요약 보고. 본문 전문은 채팅에 다시 쓰지 않는다

## 사용 시점

`/pr-review`, 「PR 리뷰해줘」, 「코드 리뷰 해줘」, 「리뷰 작성」, 「리뷰 등록」,
「리뷰 남겨줘」, 「이 PR 봐줘」, 「리뷰 초안」, 「리뷰 댓글 달아줘」 같은 요청일 때 쓴다.

| 하려는 일 | 쓰는 스킬 |
| --- | --- |
| 남의 PR 에 리뷰를 새로 쓰고 등록한다 | `pr-review` |
| 내 PR 에 달린 리뷰를 코드에 반영한다 | `review-fix` |
| 등록 전 본문을 렌더링해 보여준다 | `content-preview` |
| 문제를 찾는다 | `/code-review` 내장 명령, 직접 읽기, 실행해 보기 중 무엇이든 |

## 전제

- `gh` CLI 가 대상 호스트에 인증돼 있어야 한다. `gh api` 는 `--repo` 를 받지 않아
  사내 GitHub Enterprise 에서는 호스트를 넘기지 않으면 전부 404 가 난다
- `content-preview` 스킬이 설치돼 있어야 한다. 4단계 미리보기를 그 스킬이 소유한다
- 본문을 쓰기 전에 `~/.claude/references/work-writing-persona.md` 를 읽는다.
  본인 명의로 나가는 글이라 문체를 뒤에 고치면 처음부터 다시 쓰게 된다
- `<repo-root>/.claude/pr-review-overlay.md` 는 선택이다. git 호스트,
  이 저장소에서 P2 가 무엇인지, 후속 업무를 등록할 곳, 저장소 고유 점검 항목을 오버레이가 채운다.
  없으면 `CLAUDE.md` 와 `REVIEW.md` 를 보고, 셋 다 없으면 사용자에게 확인한다

## 구성

| 파일 | 소유하는 것 |
| --- | --- |
| `SKILL.md` | 다섯 단계 흐름, 오버레이 로딩, 반드시 지킬 것과 하지 않는 것 |
| `references/evidence.md` | 동작·비용·관례 주장별로 필요한 근거, JFR 같은 실측 방법 |
| `references/grading.md` | P1 부터 P5 까지의 판정표와 등급 표기 위치 |
| `references/scope.md` | 이 PR 이 만든 문제인지로 리뷰와 후속 업무를 가른다 |
| `references/posting.md` | 호스트 판별, REST 경로표, 등록 절차 |
| `scripts/gh-review-post.sh` | 본문을 검증한 뒤 인라인 리뷰나 답글을 등록한다. `DRY_RUN=1` 로 검증만 할 수 있다 |
| `scripts/gh-review-list.sh` | 이미 달린 리뷰 댓글과 스레드를 읽는다 |
| `scripts/render-comments.py` | 받은 댓글 JSON 을 사람이 읽을 형태로 출력한다 |
| `scripts/gh-host.sh` | origin 리모트에서 `gh api` 에 넘길 호스트 이름을 찾는다. SSH config 별칭도 되돌린다 |
| `CHANGELOG.md` | 버전 이력 |
