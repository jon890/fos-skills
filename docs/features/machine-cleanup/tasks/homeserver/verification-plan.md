# machine-cleanup PR2 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ3 | 작업 트리 | `node scripts/run-tests.ts skills/machine-cleanup/tests/skill-doc.spec.ts` | 「머신 고르기」 가 홈서버 절차를 가리키고 머신별 승인과 보고를 나눈다 | 로컬 node | worker | 없음 | PR 전 |
| REQ5 | 임시 오버레이(커밋하지 않음) | 홈서버 조사를 `remote.ts` 로 돌리고 조사 전후 파일·이미지·Hermes 세션 목록을 비교 | 종료 코드 0, 모든 절이 나오고, 전후 목록이 같다 | 실제 홈서버 | 코디네이터 | push | PR 전 |
| REQ6 | 가짜 조사 JSON | `node scripts/run-tests.ts skills/machine-cleanup/tests/hs-classify.spec.ts` | 유지 항목이 승인 후보에 없고 원인 판정 줄과 「표에 올릴 용도」 가 나온다 | 로컬 node | worker | 없음 | PR 전 |
| REQ7 | 가짜 docker, flock, 임시 백업 루트 | `node scripts/run-tests.ts skills/machine-cleanup/tests/hs-delete.spec.ts skills/machine-cleanup/tests/remote.spec.ts` | dry-run 이 목록만 보이고, 잠금 실패면 지우지 않고 실패, 쓰는 중인 이미지는 남고, sudo 는 명령 문자열로만 나온다 | 로컬 node | worker | 없음 | PR 전 |
| REQ8 | 가짜 /proc 와 docker | `hs-survey.spec.ts`, `hs-classify.spec.ts` | 여유 메모리, 스왑, 컨테이너별 사용량과 한도, 스왑 상위 프로세스가 나오고 제안만 낸다 | 로컬 node | worker | 없음 | PR 전 |
| REQ9 | 임시 저장소, 가짜 /proc | `hs-survey.spec.ts` | 현재 브랜치가 후보에 없고, 안에 프로세스가 있는 워크트리가 빠지며, 조사만 하는 저장소는 승인 후보에 없다 | 로컬 node | worker | 없음 | PR 전 |
| REQ10 | 임시 SQLite | `hs-survey.spec.ts`, `hs-classify.spec.ts`, `hs-delete.spec.ts` | Claude·Codex 기록이 없으면 「없음」, 연결되거나 30일 안의 트리는 후보가 아니고, 조사 뒤 연결되거나 최근 활동한 트리는 지우지 않으며, 지운 뒤 연결된 세션이 남는다 | 로컬 node | worker | 없음 | PR 전 |
| REQ11 | 작업 트리 | `hs-boundary.spec.ts` 와 push 전 실제 값 grep | 스킬 폴더에 홈서버 고유 값의 꼴이 없고, 실제 값 grep 이 0건이다 | 로컬 node | worker | 없음 | PR 전 |
| REQ12 | 가짜 ssh | `remote.spec.ts`, `hs-overlay.spec.ts`, `skill-doc.spec.ts` | 접속 실패, 조사 실패, 오버레이 없음에서 삭제 명령이 나가지 않고 원인 줄이 나온다 | 로컬 node | worker | 없음 | PR 전 |
