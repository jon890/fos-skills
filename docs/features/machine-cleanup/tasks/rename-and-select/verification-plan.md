# machine-cleanup PR1 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 이름을 바꾼 작업 트리 | `node scripts/run-tests.ts scripts/tests` 와 `git grep -n mac-cleanup` | 매니페스트·README 검사 통과. 남은 줄이 CHANGELOG, 옛 기능 문서의 배경 서술, 옛 오버레이 경로뿐 | 저장소 체크아웃 | worker | 없음 | PR 전 |
| REQ2 | 임시 홈 | `node scripts/run-tests.ts skills/machine-cleanup/tests/overlay-path.spec.ts skills/machine-cleanup/tests/skill-doc.spec.ts` | 옛 자리에만 둔 오버레이가 읽히고, 새 자리가 있으면 새 자리가 먼저다. SKILL.md 가 스크립트를 부른다 | 로컬 node | worker | 없음 | PR 전 |
| REQ3 | 작업 트리 | `node scripts/run-tests.ts skills/machine-cleanup/tests/skill-doc.spec.ts` | 「머신 고르기」 절이 판정 낱말, 「둘 다」 의 머신별 분리, 홈서버 PR2 막기를 갖는다 | 로컬 node | worker | 없음 | PR 전 |
| REQ4 | 바꾸기 전 조사 출력(`$TMPDIR/mc-baseline/`) | `node scripts/run-tests.ts skills/machine-cleanup/tests` 와 같은 조사 스크립트 여섯 개를 새 경로로 다시 돌려 절 제목과 수치 항목 이름을 비교 | 기존 테스트 전부 통과. 절 제목과 항목 이름이 같다(값은 시간에 따라 다를 수 있다) | 이 맥 | worker | 없음 | PR 전 |
| REQ3 | PR2 머지 | 「둘 다」 로 실제 정리를 돌린다 | 승인 질문과 전후 표가 머신별로 나뉜다 | 이 맥과 홈서버 | 코디네이터 | 머지: PR2, PR3 | PR 뒤 |
