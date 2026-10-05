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

```bash
scripts/gh-review-list.sh <owner/repo> <PR>                      # 전체 댓글
scripts/gh-review-list.sh <owner/repo> <PR> --thread <root댓글id>  # 한 스레드
scripts/gh-review-list.sh <owner/repo> <PR> --mine                # 내가 쓴 것만
scripts/gh-review-post.sh --reply <owner/repo> <PR> <댓글id> <body.md> <핵심낱말>...
```

## 등록은 리뷰 단위로 한다

댓글 하나만 달 때도 `reviews` 로 보낸다. `event` 는 `COMMENT` 를 쓴다.
`APPROVE` 나 `REQUEST_CHANGES` 는 사용자가 명시적으로 요청했을 때만 쓴다.

```json
{"event":"COMMENT","comments":[{"path":"...","line":26,"side":"RIGHT","body":"..."}]}
```

`line` 은 diff 의 **새 파일 기준 줄 번호**다. 그 줄이 diff 에 없으면 등록이 실패하거나
`line: null` 로 붙는다.

## 조회할 때의 함정

`line` 이 `null` 인 댓글은 `pulls/{N}/comments` 목록에서 빠진다.
그래서 등록한 개수보다 적게 보인다. **목록 개수로 등록 성공을 판정하지 않는다.**
등록 응답의 리뷰 id 로 `reviews/{id}/comments` 를 직접 조회한다.

## payload 파일을 다시 쓸 때

zsh 의 `noclobber` 는 기존 파일 덮어쓰기를 거부한다.
오류는 `file exists` 한 줄뿐이고 **뒤이은 `gh api` 는 그대로 성공한다.**
그러면 이전 payload 가 다시 등록된다. 실제로 엉뚱한 댓글이 올라가 삭제한 적이 있다.

세 가지를 같이 지킨다.

- 파일명을 새로 만든다
- `rm -f` 를 먼저 한다
- **등록 직전에 본문을 검증한다.** 등급 접두사와 핵심 낱말이 들어 있는지 본다

`gh-review-post.sh` 가 이 셋을 강제한다. 직접 `gh api` 를 부르지 않는다.

```bash
scripts/gh-review-post.sh <owner/repo> <PR> <path> <line> <body.md> <핵심낱말>...
```

핵심 낱말은 하나 이상 필수다. 없으면 스크립트가 등록하지 않고 종료한다.
등급 접두사만 보는 검증은 접두사가 같은 옛 본문을 그대로 통과시키기 때문이다.
`DRY_RUN=1` 을 앞에 붙이면 검증만 하고 등록하지 않는다.

## 등록 뒤 확인

등록 응답의 id 로 본문 앞부분을 다시 읽어 확인한다.

```bash
GH_HOST=<호스트> gh api repos/<owner>/<repo>/pulls/<N>/reviews/<리뷰id>/comments \
  --jq '.[] | {id, path, head: (.body[0:45])}'
```

붙은 위치와 첫 줄의 등급 표기를 본다. 본문 전문을 채팅에 다시 쓰지 않는다.

## 잘못 등록했을 때

댓글을 지우면 그 리뷰에 댓글이 남지 않아 리뷰도 함께 사라진다.

```bash
GH_HOST=<호스트> gh api repos/<owner>/<repo>/pulls/comments/<댓글id> -X DELETE
```

지운 뒤 올바른 본문으로 다시 등록한다. 사용자에게 무엇을 왜 지웠는지 알린다.

## 재트리거 토큰

본문에 `/review`, `@claude`, `@github-actions` 같은 문자열이 그대로 들어가면
봇 워크플로가 다시 돈다. 봇을 지칭해야 하면 코드 스팬으로 감싼다.

`#숫자` 는 자동으로 다른 이슈나 PR 로 링크된다.
리뷰 항목 번호로 쓸 생각이면 백틱으로 감싼다.
