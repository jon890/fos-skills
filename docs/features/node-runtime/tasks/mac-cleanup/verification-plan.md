# mac-cleanup 영역 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `mac-cleanup` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫을 맡는다. REQ7 은 머지 뒤 후속이다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
|---|---|---|---|---|---|---|
| REQ3 | phase-01 의 테스트 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts 'skills/mac-cleanup/tests/*.spec.ts'` 와 옛 Python 테스트 | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | 같은 테스트 명령과 `git diff <phase-01 커밋> HEAD -- skills/mac-cleanup/tests/helpers.ts` | 테스트가 통과하고 명령 경계 테스트 파일의 diff 는 없다. helpers 는 「명령 경계」 상수 묶음만 바뀐다 | 로컬 | 없음 | PR 전 |
| REQ3 | 이 머신의 실제 상태(읽기 전용 명령만), 임시 `--json-out` 파일 | 옛 명령(phase-01 사본)과 새 명령 `survey_system`, `survey_sessions`, `survey_git --no-fetch --no-check-prs`, `survey_gradle`, `docker_images`, `docker_volumes` 에 같은 인자를 돌려 stdout 과 종료 코드, 쓴 JSON 을 비교하는 스크립트(세션 임시 폴더). 시각과 프로세스에 따라 달라지는 줄은 목록으로 빼고 이유를 적는다 | 입력 수와 다른 입력 0 을 PR 본문에 적는다. 지우는 명령은 돌리지 않는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING mac-cleanup` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `git ls-files skills/mac-cleanup` | `.py` 와 `.sh` 가 없다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -n 'python3 ' -- skills/mac-cleanup` 와 옛 이름 `git grep` | 옛 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
| REQ7 | 머지된 main | 옛 이름으로 `~/personal/*`, `~/projects/*` 의 저장소 지침과 launchd, cron, 셸 별칭을 다시 훑는다 | 지침과 별칭에는 호출이 없고, `ai-analysis` 의 `.claude/settings.local.json` 허용 규칙만 남아 있어 고친다 | 로컬 | 머지 | PR 뒤 |
