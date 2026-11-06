# korean-check 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `korean-check` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5·REQ6 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ3 | phase-01 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts 'export-only-skills/korean-check/tests/*.spec.ts'` 와 옛 Python 테스트 | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | 같은 테스트 명령과 `git diff <phase-01 커밋> HEAD -- export-only-skills/korean-check/tests` | 테스트가 통과하고 diff 는 「명령 경계」 상수 묶음뿐이다 | 로컬 | 없음 | PR 전 |
| REQ3 | 저장소의 `git ls-files '*.md'` 파일 하나씩과 `--hook` 모드의 같은 파일 편집 JSON, 임시 저장소에 최근 커밋을 하나씩 적용한 diff | 옛 명령(phase-01 사본)과 새 명령에 같은 입력을 돌려 stdout 과 종료 코드를 비교하는 스크립트(세션 임시 폴더) | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ6 | `~/.claude/scripts/korean-style-check.py` 와 `check-readability.py` 링크와 같은 모양의 임시 링크 | 링크로 `--hook` 을 불러 새 명령과 비교 | 일반 모드 바이트가 같고, 훅 모드는 발견이 있을 때 안내 한 줄이 앞에 붙는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING korean-check` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files export-only-skills/korean-check` | `.sh` 가 없고 `.py` 는 옛 이름 진입 둘뿐이다(node shebang) | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -nE 'python3 \|bash "\$SKILL_DIR' -- export-only-skills/korean-check` 와 옛 이름 `git grep` | 옛 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 옛 이름(`korean-style-check`, `check-readability`, `check.sh`)으로 다른 저장소와 사용자 홈을 다시 훑는다 | 찾은 호출이 없거나 새 명령으로 바꾼 커밋이 있다 | 로컬 | 머지 | PR 뒤 |
