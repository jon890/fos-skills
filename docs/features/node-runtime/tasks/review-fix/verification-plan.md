# review-fix 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `review-fix` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ3 | phase-01 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts skills/review-fix/tests` | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | `node scripts/run-tests.ts skills/review-fix/tests` 와 `git diff <phase-01 커밋> HEAD -- skills/review-fix/tests` | 테스트가 통과하고 diff 는 「명령 경계」 묶음뿐이다 | 로컬 | 없음 | PR 전 |
| REQ3 | `check_reply_body` 입력 표본(한글이 붙은 토큰, 코드 스팬, 펜스, auto-link 꼴) | 옛 명령(phase-01 커밋 사본)과 새 명령을 같은 파일에 돌려 stdout 과 종료 코드를 비교하는 스크립트(세션 임시 폴더) | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING review-fix` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files skills/review-fix` | `.sh`, `.py` 파일이 없다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -nE 'python3 \|bash "\$SKILL_DIR' -- skills/review-fix` 와 `git grep -n 'review_threads.py'` | 옛 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 스펙 「다른 저장소의 옛 호출」 검색을 다시 돌린다 | ai-analysis 의 허용 규칙 한 곳을 새 명령으로 바꾼 커밋이 있다 | 로컬 | 머지 | PR 뒤 |
