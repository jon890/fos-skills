# content-preview 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `content-preview` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ3 | phase-01 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts 'export-only-skills/content-preview/tests/*.spec.ts'` 와 옛 Python 테스트 | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | 같은 테스트 명령과 `git diff <phase-01 커밋> HEAD -- export-only-skills/content-preview/tests` | 테스트가 통과하고 diff 는 「명령 경계」 묶음뿐이다 | 로컬 | 없음 | PR 전 |
| REQ3 | 정규식 경계 표본(`\x85`, `U+FEFF`, `U+2028`, `ſ`, 한글이 붙은 줄머리, 코드 펜스) 과 `~/personal` 의 실제 Markdown 파일 | 옛 생성기(phase-01 커밋 사본)와 새 생성기를 같은 입력에 돌려 HTML 바이트와 stderr, 종료 코드를 비교하는 스크립트(세션 임시 폴더) | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING content-preview` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files export-only-skills/content-preview` | `.sh`, `.py` 파일이 없다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -nE 'python3 \|bash "\$SKILL_DIR' -- export-only-skills/content-preview` 와 옛 이름 `git grep` | 옛 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 옛 이름 네 개(`show-preview`, `style-check.sh`, `dooray-preview`, `github-preview`)로 다른 저장소와 사용자 홈을 다시 훑는다 | 찾은 호출이 없거나 새 명령으로 바꾼 커밋이 있다 | 로컬 | 머지 | PR 뒤 |
