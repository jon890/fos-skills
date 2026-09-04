# CHANGELOG: review-fix

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 2.0.0

**목표: PR 에 달린 리뷰를 코드에 반영하고, 회신과 resolve 까지 마쳐 머지 가능 상태로 만든다.**

- 리뷰가 지적한 것만 고친다.
- 지적 하나마다 회신이 하나 남는다.
- 처리한 스레드만 resolve 한다.

실행은 8단계다. 단계마다 통과 조건과 읽을 문서가 정해져 있다.

| 단계 | 통과 조건 |
| --- | --- |
| 리뷰 수집 | PR 번호가 정해졌고 네 소스의 리뷰를 모았다 |
| 작업 트리 정렬 | 현재 브랜치가 PR head 브랜치이고 conflict 가 없다 |
| 분류 | 모든 지적에 등급이 붙었고 처리 범위를 사용자가 확정했다 |
| 수정 | 처리하기로 한 지적이 반영됐다 |
| 검증 | 그 저장소의 검증 명령이 통과했다 |
| 커밋과 push | PR head 브랜치에 push 됐고 conflict 가 없다 |
| 회신 | 처리 대상 지적마다 회신이 하나씩 달렸다 |
| 마무리 | 처리한 스레드가 resolve 됐고 결과 보고가 나갔다 |

절차 본문은 reference 가 소유한다.
`severity.md` 가 등급 대응과 행동 규약, `conflict-resolution.md` 가 충돌 해결,
`reply.md` 가 회신, `finish.md` 가 resolve 와 학습 누적과 결과 보고를 소유한다.

반복 실행 코드는 스크립트로 옮겼다.
`checkout-pr.sh` 가 작업 트리 정렬을 종료 코드로 판정하고,
`check_reply_body.py` 가 회신 본문의 재트리거 토큰과 GitHub auto-link 를 찾는다.
