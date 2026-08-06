# CHANGELOG — review-fix

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 1.2.0

- "대상 파일을 반드시 읽는다" 는 Edit 도구가 강제하므로 판단 근거만 남겼다.
- reply 원칙 3항목 중 자명한 둘을 걷어냈다.

## 1.1.0

계층을 분리하고 중복 지시를 걷었다.
SKILL.md 는 366줄에서 272줄이 됐고, references 가 0개에서 1개, scripts 가 1개 생겼다.

분리:

- conflict 해결 절차를 `references/conflict-resolution.md` 로 옮겼다.
  대부분의 실행에서 conflict 는 없으므로 그때만 읽는다.
- 리뷰 스레드 조회·resolve 의 GraphQL 쿼리를 `scripts/resolve-threads.sh` 로 옮겼다.
  heredoc 을 매 실행 다시 옮겨 적는 구조라 escape 실수가 끼어들 자리였다.

걷어낸 것:

- "반응형 스킬이라 오버레이가 대부분 필요 없다" 류 자기 소개 3줄.
- 핵심 원칙의 최소 변경·레포 컨벤션 준수·봇 무한루프 방지.
  각각 4단계, 5·6단계, 7단계가 구체적으로 소유한다.
- "의도적으로 안 하는 것" 절. 3항목 모두 핵심 원칙과 겹쳤다.
- 엣지 케이스 절. 5항목 중 3개가 본문과 중복이고, 남은 2개는 해당 단계로 흡수했다.

추가:

- `gh api graphql` 은 `--repo` 를 받지 않아 기본 호스트를 본다.
  사내 GHE 저장소에서 `GH_HOST` 를 지정하지 않으면 `NOT_FOUND` 가 난다 (실측).

## 1.0.0

버전 체계를 도입한 시점의 상태다.
지시 내용은 이 항목에서 바뀌지 않았다.

도입 이전 이력은 `git log -- review-fix/` 에서 본다.
