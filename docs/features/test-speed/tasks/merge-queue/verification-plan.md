# merge-queue 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ2 | 주입 자리만 있는 첫 커밋 | phase-01 명령으로 기존 테스트 실행 | 기존 단언 모두 통과 | 같은 머신의 Node 와 jq, git | 없음 | PR 전 |
| REQ1 | 함수 가짜로 옮긴 테스트 | phase-02 명령으로 판정·CLI·신호·대응 테스트 실행 | 기존 판정과 실제 경계 모두 통과 | 같은 머신의 격리된 임시 저장소 | 없음 | PR 전 |
| REQ6 | 링크 실행 파일과 함수 가짜 | merge-queue-runner.spec.ts 의 대응 테스트 실행 | 상태·출력·종료 코드가 양쪽에서 같음 | 같은 머신 | 없음 | PR 전 |
| REQ3 | 기준과 구현 커밋 | node modules/testkit/measure.ts --before 891c862 --after HEAD --runs 3 skills/orch/tests/merge-queue.spec.ts skills/orch/tests/merge-queue-overlap.spec.ts | 교대 실행 성공, 시간과 기동 수 표 확보 | 같은 머신의 archive 사본 | 없음 | PR 전 |
