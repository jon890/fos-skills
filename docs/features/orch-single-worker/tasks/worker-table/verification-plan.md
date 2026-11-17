# worker 선택 인수 검증 계획

## 인수 검증 계획
| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ2, REQ9 | 스펙과 모델 표 | lib-selection 테스트와 문서 대조 | 행의 worker 가 스펙과 같고 문서 일·어려운 일 기준이 일치 | 로컬 Node 테스트 | worker | 없음 | PR 전 |
| REQ3, REQ4 | 정상 선택과 값별 불일치 지시서 | lib-selection, spec-lint, launch-worker 테스트 | 불일치에는 이유가 필요하고 이유·worker 전체가 출력과 이력에 남음 | 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ3, REQ5 | 비교 칸·experiment 가 있는 새 지시서와 active 지시서 | spec-lint, launch-worker 테스트 | 새 지시서는 거절하고 active 와 같은 설정 이어하기는 허용 | 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ6 | 변경 문서 | agent-selection 과 spec-writing, SKILL·템플릿 대조 | 한국어 문서 제공자 제한과 번갈아 고르는 규칙 없음 | 로컬 문서 검사 | worker | 없음 | PR 전 |
| REQ7 | Claude·Codex 구현 PR 이력 | review-spec 테스트 | 다른 제공자의 sol medium 또는 Sonnet medium 선택, 보안 리뷰는 고정 행 | 가짜 gh CLI | worker | 없음 | PR 전 |
| REQ8 | PR2 머지 | Fable 대조 보드 항목 생성 | 2026-12-01 이후 대조할 항목과 evidence.md 기준이 남음 | 코디네이터 세션 | 코디네이터 | 머지 | PR 뒤 |
