# plan 영역 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `plan` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
|---|---|---|---|---|---|---|
| REQ3 | phase-01 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts 'skills/plan/tests/*.spec.ts'` 와 옛 Python 테스트 | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | 같은 테스트 명령과 `git diff <phase-01 커밋> HEAD -- skills/plan/tests/helpers.ts` | 테스트가 통과하고 명령 경계 테스트 파일의 diff 는 없다. helpers 는 「명령 경계」 상수 묶음만 바뀐다 | 로컬 | 없음 | PR 전 |
| REQ3 | 이 저장소의 `docs/features/*/spec.md` 하나씩(`--design` 은 `design.md` 가 있으면 함께), 저장소와 git 이력의 계획 폴더 하나씩(`--require-verification` 있고 없고) | 옛 명령(phase-01 사본)과 새 명령에 같은 입력을 돌려 stdout 과 종료 코드를 비교하는 스크립트(세션 임시 폴더) | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING plan` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files skills/plan` | `.sh` 와 `.py` 가 없다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -nE 'python3 \|bash "\$SKILL_DIR' -- skills` 와 옛 이름(`verify_task.py`, `check_feature.py`, `run_doc_checks.py`, `overlay_paths.py`, `plan_number.sh`) `git grep` | 옛 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `node scripts/runtime-policy.ts` | `migrated_docs` 에 `skills/plan/`, `skills/implementation/`, `skills/docs-audit/`, `skills/review-fix/` 가 들고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 옛 이름으로 `~/personal/*`, `~/projects/*` 의 저장소 지침을 다시 훑는다 | 찾은 호출이 없거나 새 명령으로 바꾼 커밋이 있다 | 로컬 | 머지 | PR 뒤 |
