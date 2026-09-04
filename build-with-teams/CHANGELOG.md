# CHANGELOG: build-with-teams

버전은 `SKILL.md` frontmatter 의 `metadata.version` 과 같은 값을 쓴다.
올리는 기준은 저장소 README 의 "버전과 변경 이력" 을 따른다.

## 5.0.0

**목표: planning 이 만든 `tasks/` 를 읽어 구현하고, 검토를 거쳐 PR 을 만든다.**

- 계획에 결함이 있으면 구현 전에 잡는다.
- 구현된 코드가 계획한 것과 같아야 한다.
- 코드가 `docs/` 에 적힌 결정과 어긋나지 않아야 한다.

team-lead 는 조율, phase 단위 커밋, 검토 결과의 분류, PR 생성을 한다.
구현과 검토는 규모와 무관하게 팀원 넷에게 맡긴다.

| 팀원 | 언제 | 무엇을 보나 | 판정 |
| --- | --- | --- | --- |
| critic | 구현 전 한 번 | plan 의 모든 phase | `APPROVE` / `REVISE` |
| executor | phase 마다 | 배정받은 phase 하나 | 완료 보고 |
| code-reviewer | 모든 phase 뒤 한 번 | 누적 diff 와 `tasks/` | `PASS` / `FIX_NEEDED` |
| docs-verifier | 모든 phase 뒤 한 번 | 누적 diff 와 `docs/` | `PASS` / `UPDATE_NEEDED` / `VIOLATION` |

넷의 판정 기준과 회신 형식은 각자의 `references/role-*.md` 가 소유한다.

실행은 6단계다. 단계마다 통과 조건과 읽을 문서가 정해져 있다.

| 단계 | 통과 조건 |
| --- | --- |
| 재실행 확인 | `scripts/plan_precheck.py` 종료 코드 0, 또는 발견 사항에 대한 사용자 확정 |
| 작업 공간 준비 | plan 브랜치 위에 있고, main 과 분리됐고, 팀원에게 줄 절대경로가 있다 |
| 계획 검토 | critic 이 `APPROVE` 와 phase 별 실행 형태를 함께 회신했다 |
| phase 구현 | 모든 phase 가 커밋됐고 살아 있는 executor 가 없다 |
| 코드 리뷰와 문서 정합성 검토 | code-reviewer 와 docs-verifier 가 둘 다 `PASS` 다 |
| 통합 검증과 PR | 통합 검증이 통과했고 PR 이 있고 팀원이 남지 않았다 |

하네스 전용 이름은 `references/team-spawn.md` 하나에 모았다.
Claude Code 와 subagent 방식에서 실제로 갈리는 것은 재투입이다.
