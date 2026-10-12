# 등록

실행해 보기 전에는 알 수 없는 것만 적는다.

## 호스트

`gh pr` 은 git remote 를 보고 호스트를 찾지만 **`gh api` 는 기본 호스트를 본다.**
사내 GitHub Enterprise 에서 `gh api` 를 그냥 부르면 전부 404 가 난다.
메시지가 `Not Found` 뿐이라 권한 문제로 오인하기 쉽다.

```bash
git remote -v                                   # 호스트 확인
GH_HOST=<호스트> gh api repos/<owner>/<repo>/pulls/<N>/comments
```

`gh api graphql` 도 같다. `--repo` 를 받지 않으므로 `GH_HOST` 가 없으면 `NOT_FOUND` 다.

## 경로

| 하려는 일 | 경로 |
| --- | --- |
| 인라인 리뷰 등록 | `POST repos/{owner}/{repo}/pulls/{N}/reviews` |
| 스레드 답글 | `POST repos/{owner}/{repo}/pulls/{N}/comments/{id}/replies` |
| 리뷰 댓글 목록 | `GET repos/{owner}/{repo}/pulls/{N}/comments` |
| 한 리뷰의 댓글 | `GET repos/{owner}/{repo}/pulls/{N}/reviews/{리뷰id}/comments` |
| 댓글 삭제 | `DELETE repos/{owner}/{repo}/pulls/comments/{id}` |

답글 경로에 **PR 번호가 들어간다.** `pulls/comments/{id}/replies` 는 404 다.
삭제 경로에는 PR 번호가 없다. 둘이 달라서 헷갈린다.

조회와 답글도 스크립트를 쓴다. 경로와 호스트를 매번 손으로 맞추지 않는다.
인자는 `scripts/gh-review-list.sh` 와 `scripts/gh-review-post.sh` 의 머리 주석이 소유한다.

## 등록은 리뷰 단위로 한다

댓글 하나만 달 때도 `reviews` 로 보낸다. `event` 는 `COMMENT` 를 쓴다.
`APPROVE` 나 `REQUEST_CHANGES` 는 사용자가 명시적으로 요청했을 때만 쓴다.

```json
{"event":"COMMENT","comments":[{"path":"...","line":26,"side":"RIGHT","body":"..."}]}
```

`line` 은 diff 의 **새 파일 기준 줄 번호**다. 그 줄이 diff 에 없으면 등록이 실패하거나
`line: null` 로 붙는다.

## 조회할 때의 함정

`reviews/{id}/comments` 는 줄에 정상으로 붙은 댓글도 `line: null`, `position: 216` 으로 준다(실측).
`pulls/{N}/comments` 는 같은 댓글을 `line: 216`, `subject_type: "line"` 으로 준다.
그래서 `reviews/{id}/comments` 의 `line: null` 만 보고 줄에 못 붙었다고 판단하지 않는다.

줄이 diff 에 없어 실제로 `line: null` 로 붙은 댓글은 `pulls/{N}/comments` 목록에서 빠진다.
**등록한 개수와 `pulls/{N}/comments` 에서 리뷰 id 로 고른 개수를 비교한다.** 모자라면 그것이 신호다.

## 등록은 스크립트로 한다

**`gh api` 를 직접 부르지 않고 `gh-review-post.sh` 로 등록한다.**
zsh 의 `noclobber` 는 기존 payload 파일 덮어쓰기를 `file exists` 한 줄로 거부하고,
뒤이은 `gh api` 는 그대로 성공해 이전 payload 를 다시 등록한다.
스크립트는 매번 새 임시 파일을 쓰고 등록 직전에 본문을 검증한다.

## 등록 뒤 확인

`gh-review-post.sh` 가 등록 뒤에 붙은 위치와 첫 줄을 조회해 출력한다.
**종료 코드 1 은 등록한 인라인 일부가 줄에 붙지 않았다는 뜻이다.** 그 줄이 diff 에 있는지 확인한다.

본문 전문을 채팅에 다시 쓰지 않는다.

## 잘못 등록했을 때

댓글을 지우면 그 리뷰에 댓글이 남지 않아 리뷰도 함께 사라진다.

```bash
GH_HOST=<호스트> gh api repos/<owner>/<repo>/pulls/comments/<댓글id> -X DELETE
```

지운 뒤 올바른 본문으로 다시 등록한다. 사용자에게 무엇을 왜 지웠는지 알린다.

## 자동 링크

`#숫자` 는 자동으로 다른 이슈나 PR 로 링크된다.

다른 PR 이나 이슈를 가리킬 때는 백틱 없이 링크 표기로 쓴다.
같은 저장소면 `#102`, 다른 저장소면 `owner/repo#102` 다.
`PR 102` 나 백틱으로 감싼 `` `#102` `` 는 링크가 걸리지 않아 작성자가 번호로 다시 찾아야 한다.

리뷰 항목 번호처럼 PR 이 아닌 번호에는 `#` 을 붙이지 않는다. 붙여야 하면 백틱으로 감싼다.
