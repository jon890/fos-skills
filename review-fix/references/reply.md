# 리뷰 회신

「회신」 단계에서 읽는다.

**지적 하나에 회신 하나를 단다.** 통합 댓글 하나로 대신하면 어느 지적에 대한 답인지 사라진다.
리뷰 스레드도 인라인 댓글과 같게 다룬다.

**회신 대상은 처리하기로 한 지적 전부다.** 반영하지 않기로 판단한 것도 그 판단을 회신에 적는다.
적지 않으면 resolve 할 때 이유가 남지 않는다.
이미 반영돼 있던 항목만 회신을 생략한다.

## 경로 분기

봇의 발견사항이 리뷰 스레드로 달렸는지 인라인 댓글로 달렸는지 먼저 본다.
봇은 리뷰 스레드로 다는 경우가 많다.

```bash
scripts/review-threads.sh list <owner> <repo> <N>
```

| 상태 | 회신 경로 |
|---|---|
| 리뷰 스레드가 있다 | `scripts/review-threads.sh reply <THREAD_ID> <본문파일>` |
| 스레드가 없고 인라인 댓글만 있다 | REST `pulls/<N>/comments/<comment_id>/replies` |
| 둘 다 없다 | `gh pr comment <N> --body-file <본문파일>` 로 통합 회신 하나 |

`list` 는 이미 resolve 된 스레드를 빼고 낸다.
목록이 비었는데 인라인 댓글이 있으면 앞선 실행이 resolve 한 것일 수 있으니 `list-all` 로 확인한다.

인라인 댓글 경로는 아래와 같다.

```bash
gh api --hostname "$(scripts/gh-host.sh)" \
  repos/<owner>/<repo>/pulls/<N>/comments/<comment_id>/replies \
  -X POST -F body=@<본문파일>
```

## 본문

**세 경로 모두 본문을 파일로 넘긴다.** 셸에 직접 쓰면 백틱과 달러가 명령 치환으로 사라진다 (실측).

```
✅ **반영 완료** (커밋: <커밋 해시>)

<무엇을 어떻게 수정했는지 한두 줄>
```

**커밋 해시를 넣는다.** 리뷰어가 어느 커밋에서 반영됐는지 찾을 방법이 회신 본문뿐이다.

## 등록 전 검사

```bash
python3 scripts/check_reply_body.py <본문파일>
```

재트리거 토큰과 GitHub auto-link 를 찾는다. 걸리는 것과 대응은 그 스크립트가 소유한다.

의도한 참조인지 사고인지는 자동으로 가릴 수 없다.
걸린 위치를 사용자에게 보여주고 구조화 질문 도구가 있으면 그것으로 확인받는다.

이미 등록한 댓글에서 발견하면 본문을 교체한다.

```bash
gh api --hostname "$(scripts/gh-host.sh)" \
  repos/<owner>/<repo>/issues/comments/<id> -X PATCH -F body=@<본문파일>
```

인라인 댓글은 경로가 `pulls/comments/<id>` 다.
