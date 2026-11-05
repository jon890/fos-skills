# ADR 문서 검사기 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 검사 코드마다 위반·통과 표본을 담은 임시 git 저장소(`adr-docs.spec.ts`) | `node --test skills/plan/tests/adr-docs.spec.ts` | 일곱 코드가 위반 표본에서 `경로:줄: 코드` 줄과 종료 코드 1, 통과 표본에서 0 | 로컬 Node 24, CI `Plugin tests` | 없음 | PR 전 |
| REQ1 | verify 단계에서 ai-analysis 최신 develop 체크아웃(읽기만, 파일을 고치지 않는다) | `node <worktree>/skills/plan/scripts/adr-docs.ts check --adr-dir docs/adr --adr-dir 'modules/*/docs/adr' --flat` 를 ai-analysis 루트에서 돌리고, 같은 커밋의 `python3 scripts/check/check-docs.py` 출력과 링크·앵커·식별자·중복 줄을 비교한다 | 옛 검사기가 낸 줄을 새 검사기도 모두 낸다. 새 검사기만 낸 줄은 범위 확대(스펙 DECISION18, 이미지 링크)로 분류된다. 접두 링크 대체 관계 버그는 새 쪽에서 없다. 결과를 PR 본문에 붙인다 | 로컬 | 없음 | PR 전 |
| REQ2 | 모듈 폴더 둘(번호 겹침), `ADR-M01`, 같은 날 날짜 꼴 둘 표본 | 같은 테스트의 해당 사례 | 설정 인자만 바꿔 오탐 없이 돌고, 같은 날 날짜 꼴은 중복이 아니며, 겹치는 번호의 후보가 둘 나온다 | 로컬 Node 24 | 없음 | PR 전 |
| REQ3 | 대체 관계와 일부 대체가 있는 ADR 표본 | `write-index` 뒤 `check --index generated`, 색인 한 줄 직접 수정 뒤 `check` | 처음 0, 수정 뒤 `INDEX_STALE` 와 1. 두 표 분류와 접두 링크 대체 관계가 기대 문자열과 같다 | 로컬 Node 24 | 없음 | PR 전 |
| REQ4 | phase 02 적용한 작업 트리 | 문서 계약 테스트와 `git grep -n check_adr_layout`(변경 이력·이 기능 문서 제외) | 계약 테스트 통과, grep 결과 없음. review-fix 결과 보고 양식에 「PR 밖 위반」 이 있다 | 로컬 | 없음 | PR 전 |
| REQ5 | phase 02 적용 | `skills/plan/CHANGELOG.md` 최상단 절 확인과 다른 저장소 검색 `for d in ~/personal/* ~/projects/*; do git -C "$d" grep -n "check_adr_layout\|static_check" -- .claude .orch AGENTS.md CLAUDE.md; done` | CHANGELOG 에 `호환성:` 항목과 새 명령. 검색 결과(2026-11-05 기준 fos-blog, ai-playground-docu-parser 의 docs-audit 오버레이)가 PR 본문 목록에 있고, 두 인자로 부르는 `static_check.py` 가 종료 코드를 바꾸지 않는다 | 로컬 | 없음 | PR 전 |
| REQ7 | phase 03~05 적용 | `node skills/plan/scripts/adr-docs.ts check --index generated`, `write-index` 두 번째 실행 뒤 `git status --short docs/adr/INDEX.md` | 종료 코드 0, 색인 변화 없음. 색인이 「현행」·「대체됨」 두 표이고 ADR-001·002 가 「대체됨」 에 있다 | 로컬 | 없음 | PR 전 |

REQ6 은 다음 PR(ai-analysis)의 계획이 인수 검증을 정한다.
