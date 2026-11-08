# browser-driver 영역 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `browser-driver` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5·REQ6 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
|---|---|---|---|---|---|---|
| REQ3 | phase-02 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts 'skills/browser/browser-driver/tests/*.spec.ts'` 와 옛 Python 테스트 | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | 같은 테스트 명령과 `git diff <phase-02 커밋> HEAD -- skills/browser/browser-driver/tests/` | 테스트가 통과하고 명령 경계 테스트 파일의 diff 는 없다. helpers 는 「명령 경계」 상수 묶음만 바뀐다 | 로컬 | 없음 | PR 전 |
| REQ3 | 가짜 백엔드 실행 파일과 임시 HOME | 옛 진입(phase-02 사본)과 새 진입에 같은 인자·환경을 주고 stdout, stderr, 종료 코드를 비교하는 스크립트(세션 임시 폴더). 실제 브라우저는 열지 않는다 | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ6 | PR HEAD | 임시 HOME 의 링크로 `tools/browser-driver/browser_driver.py` 를 `help`, `config-path`, `driver` 로 부른다. 낮은 node 흉내(`--import` 로 `process.versions.node` 를 덮는다)로도 부른다 | stdout 과 종료 코드가 새 명령과 같고 stderr 에 새 명령 안내가 있다. 낮은 node 에서는 건너뛴다는 한 줄과 127 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING browser-driver` 줄이 없고 종료 코드 0. `legacy` 에 `tools/browser-driver/browser_driver.py` 가 있다 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files skills/browser tools` | `.py` 는 옛 이름 진입 하나뿐이다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -n 'tools/browser-driver'` 와 `git grep -n 'python3 ' -- skills/browser` | 남은 줄이 옛 이름 진입과 팀 사본을 말하는 것뿐이고 `python3` 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 옛 이름으로 `~/personal/*`, `~/projects/*` 의 저장소 지침, 설정, 셸 별칭을 다시 훑는다 | 개인 링크는 옛 이름 진입이 이어 주고, 팀 저장소 래퍼는 마지막 팀 PR 몫으로 남는다 | 로컬 | 머지 | PR 뒤 |
