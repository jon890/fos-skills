# 실행기 하나 인수 검증 계획

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ7 | PR 브랜치 | `node --test scripts/tests/run-tests.spec.ts` | 묶음 찾기, 요약 줄, 끝 줄, 종료 코드 0~3, 보고 없음 대조, 무진행 감시, python3 없음, `NODE_TEST_CONTEXT` 사례가 모두 통과한다 | 로컬 macOS, Node 24 | 없음 | PR 전 |
| REQ7 | PR 브랜치 | 저장소 루트에서 인자 없이 `node scripts/run-tests.ts --background` 와 `--wait` | 요약에 node 파일, Python 묶음 12개, `tsc` 줄이 있고 끝 줄이 `결과: 통과 T, 실패 0, 전체 T, 걸린 시간 Ss` 이며 종료 코드 0 | 로컬 macOS | 없음 | PR 전 |
| REQ10 | PR 브랜치에 타입 오류 한 줄을 넣은 작업 트리 | `node scripts/run-tests.ts` 를 인자 없이 돌린 뒤 되돌린다 | `실패 tsc` 줄과 종료 코드 1. 되돌린 뒤 `통과 tsc` | 로컬 macOS | 없음 | PR 전 |
| REQ8 | PR 브랜치 | `git grep -l run-node-tests -- ':!docs/features/'` 와 `.orch/overlay.md`, README 를 읽는다 | grep 이 비고, 두 문서가 `node scripts/run-tests.ts` 를 적는다 | 로컬 | 없음 | PR 전 |
| REQ8 | PR | GitHub Actions 의 `Tests` job | job 하나(`Tests`)만 돈다 | GitHub Actions ubuntu | push | PR 뒤 |
| REQ10 | PR | GitHub Actions 의 `Tests` job | 로그에 실행기의 `tsc` 줄이 있고 실행기 밖의 `tsc` 단계가 없다 | GitHub Actions ubuntu | push | PR 뒤 |
| REQ1 | PR | GitHub Actions 의 `Tests` job | 통과하고 끝 줄이 실패 0 이다 | GitHub Actions ubuntu | push | PR 뒤 |
| REQ3 | origin/main 과 PR 브랜치 | phase 02 「측정과 PR 본문」 대로 전후 시간을 잰다 | PR 본문에 전후 시간, load average, CI job 시간이 있다 | 로컬 macOS | 없음 | PR 전 |
