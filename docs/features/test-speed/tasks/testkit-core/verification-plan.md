# testkit 첫 판 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ5 | PR 브랜치 | `node --test modules/testkit/tests/*.spec.ts` 를 돌린다 | 도우미 다섯(temp, git, fake-bin, command, fake-run)의 테스트가 모두 통과한다 | 로컬 macOS, Node 24 | 없음 | PR 전 |
| REQ5 | PR 브랜치 | `fixtures/fake-bin`, `fixtures/cleanup-sweep` 를 쓰는 orch 테스트 파일을 모두 돌린다 | 모두 통과한다 | 로컬 macOS | 없음 | PR 전 |
| REQ2 | PR 브랜치 | `git diff --stat origin/main -- 'skills/orch/tests/*.spec.ts'` 를 본다 | 비어 있다. fixtures 를 쓰는 테스트를 고치지 않았다 | 로컬 | 없음 | PR 전 |
| REQ6 | PR 브랜치 | `modules/testkit/tests/fake-bin.spec.ts` 의 inode 사례를 돌린다 | 두 폴더의 같은 가짜가 같은 inode 다 | 로컬 macOS | 없음 | PR 전 |
| REQ9 | PR 브랜치 | `node --test scripts/tests/exported-imports.spec.ts` | 저장소 검사가 비어 통과하고, 임시 폴더의 여섯 꼴이 잡힌다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR 브랜치와 origin/main | `node modules/testkit/measure.ts --before origin/main --after HEAD <대상 파일>` | 대상 파일마다 전후 시간과 기동 수가 있는 표가 나오고 PR 본문에 있다 | 로컬 macOS, 부하는 표 머리의 load average 로 남긴다 | 없음 | PR 전 |
| REQ1 | PR | CI 의 `Plugin tests`, `Python tests` | 둘 다 통과한다. 새 node 테스트 줄이 CI 로그에 있다 | GitHub Actions | push | PR 뒤 |
