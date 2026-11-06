# CHANGELOG: review-fix

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준과 쓰는 형식은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 3.0.2 (2026-11-06)

- plan 의 `overlay_paths.ts` 를 node 로 부른다

## 3.0.1 (2026-11-06)

- 심볼릭 링크로 부른 진입도 import.meta.main 이 없는 Node 24.0·24.1 에서 일을 하도록 직접 실행 판정을 실체 경로로 비교한다

## 3.0.0 (2026-11-06)

- 호환성: 스크립트 여섯(`gh_host`, `review_threads`, `collect_review`, `checkout_pr`, `check_reply_body`, `fold_fixup`)을 Node 24 의 `.ts` 로 바꿨다
- `node "$SKILL_DIR/scripts/review_threads.ts" list --count …` 처럼 이름의 확장자만 바꿔 부른다
- 옵션, 출력, 종료 코드는 그대로다. 이 스킬을 쓰려면 Node 24 이상이 필요하다
- 옛 `python3 …/review_threads.py` 호출(허용 규칙과 오버레이 포함)은 새 이름으로 바꿔야 한다

## 2.x

- 셸 스크립트를 Python 으로 옮겼다. 실행을 8단계로 정리하고 등급 대응, 충돌 해결, 회신, 마무리 절차를 `references/` 로 나눴다
- 지적 하나를 고치면 그 자리에서 커밋하고, 지적과 커밋 해시의 대응 표로 회신과 결과 보고를 쓴다. 검증이 실패하면 원인 커밋을 고친다
- 호스트를 현재 디렉터리가 아닌 저장소 이름으로 정한다. PR URL 과 호스트가 든 저장소 표기를 받고, origin 이 같은 저장소면 다른 로그인 호스트를 조회하지 않는다
- `review_threads` 에 `list --count`, `show`, `reply-batch`, `carried`, `resolve -` 를 더했다. outdated 스레드는 `originalLine` 을 낸다
- 모노레포를 지원한다. PR 의 변경 경로로 하위 프로젝트를 정하고 그 오버레이의 검증 명령을 실행한다
- `fold_fixup.sh` 가 검증 실패의 원인이 앞 커밋일 때 수정을 편집기 없이 그 커밋에 접어 넣는다
- 반복될 지적을 일반화해 결과 보고에 후보로 적는다. 옮기는 일은 docs-consolidate 가 한다
- 5단계 검증에서 plan 의 `adr-docs.ts check --changed-since` 를 돌리고, 결과 보고에 「PR 밖 위반」 자리를 더했다

## 1.x

- 1.0.0 은 리뷰 반영, push, 리뷰 스레드 resolve 까지 하던 상태에서 버전 체계를 도입한 시점이다
- 봇의 심각도 표기를 P1 부터 P5 로 읽고, 표기별 행동 규약을 `severity.md` 로 나눴다
- 리뷰 스레드에 GraphQL 로 회신하고, 회신 본문을 파일로 넘긴다
- GitHub Enterprise 저장소에서 호스트를 판별한다. origin 이 SSH config 별칭이어도 실제 호스트를 찾는다
