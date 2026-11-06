# small-skills 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `small-skills` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫을 맡는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ3 | phase-01 의 스킬별 테스트 커밋을 각각 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts skills/<스킬>/tests` | 새 명령 경계 테스트와 옛 Python 테스트가 모두 통과한다. 결과 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | `node scripts/run-tests.ts 'skills/*/tests/*.spec.ts'` 와 `git diff <phase-01 커밋> HEAD -- <명령 경계 테스트>` | 테스트가 통과하고 diff 는 「명령 경계」 묶음과 옛 Python 내부 함수 사례의 이전뿐이다 | 로컬 | 없음 | PR 전 |
| REQ3 | 이 저장소의 `.md`(report), `docs/`(docs-audit), 공통 틀(`skills/report/assets/template.html`, `skills/presentation/assets/deck-template.html`) | 옛 명령(phase-01 커밋 사본)과 새 명령을 같은 입력에 돌려 stdout 과 종료 코드를 비교하는 스크립트(세션 임시 폴더) | 입력 수와 다른 입력 0 을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING small-skills` 줄이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | `node scripts/runtime-policy.ts --pending` 와 `git ls-files 'skills/pr-review/scripts' 'skills/implementation/scripts'` | `.sh` 파일이 없고 종료 코드 0 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | `git grep -nE 'python3 \|bash "\$SKILL_DIR' -- skills/pr-review skills/report skills/presentation skills/browser` 와 `doc-script-refs` 테스트 | 옛 호출이 없고 테스트가 통과한다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과한다 | GitHub Actions | push | PR 뒤 |
