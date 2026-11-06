# scripts·githooks 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 `scripts-githooks` 영역 몫, REQ3 의 두 커밋 비교, REQ4·REQ5 의 이 영역 몫, REQ10 을 맡는다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ3 | phase-01 커밋을 세션 임시 폴더에 `git worktree add` 한 사본 | 사본에서 `node scripts/run-tests.ts scripts/tests 'scripts/tests/*.spec.ts'`(폴더 인자는 Python 묶음만 돈다) | 새 명령 경계 테스트 8개와 옛 Python 테스트가 모두 통과한다. 결과 끝 줄을 PR 본문에 적는다 | 로컬 | 없음 | PR 전 |
| REQ3 | PR HEAD | `node scripts/run-tests.ts 'scripts/tests/*.spec.ts'` 와 `git diff <phase-01 커밋> HEAD -- <명령 경계 테스트 8개>` | 테스트가 통과하고, diff 는 파일 머리의 「명령 경계」 묶음과 내부 함수 사례 추가뿐이다 | 로컬 | 없음 | PR 전 |
| REQ3 | 이 저장소 main 의 실제 push 범위 가운데 조각이 있는 머지, 사람이 version 을 올린 머지, `호환성:` 이 든 머지, 조각 없는 변경을 하나 이상씩 고른다 | 고른 head 마다 같은 head 를 두 번 `git worktree add --detach` 하고, 한쪽에 옛 `.py` 셋, 다른 쪽에 새 `.ts` 와 `modules/kit` 을 PR HEAD 에서 복사한 뒤 같은 `--base --head --date` 로 돌린다 | 사본 둘의 stdout, stderr 의 `경고:` 줄, `git status --porcelain` 과 `git diff` 바이트가 같다 | 로컬 | 없음 | PR 전 |
| REQ3 | 팀 저장소를 세션 임시 폴더에 두 벌 복사한 사본 | 이 저장소 PR HEAD 를 원본으로, 옛 `export-to-team.sh`(phase-01 커밋 사본)와 새 `.ts` 를 각 사본에 `--apply` 없이, 그다음 `--apply` 로, 그리고 `--source-ref team-export` 로 돌린다 | stdout(첫 줄과 안내 줄의 명령 이름 말고)과 종료 코드가 같고, `--apply` 뒤 두 사본의 트리가 `diff -r` 로 같다 | 로컬 | 없음 | PR 전 |
| REQ3 | `claude` CLI 가 있는 로컬 | phase-01 커밋 사본의 `bash scripts/test-plugin-install.sh` 와 PR HEAD 의 `node scripts/test-plugin-install.ts` | `ok:`, `FAIL:` 줄 목록과 종료 코드가 같다 | 로컬 | 없음 | PR 전 |
| REQ1 | PR HEAD | `node scripts/runtime-policy.ts --pending` | `PENDING scripts-githooks` 줄이 없고 `OK` 끝 줄, 종료 코드 0. `scripts/`, `githooks/` 에 python shebang 이나 `.py` 가 없다 | 로컬 | 없음 | PR 전 |
| REQ2 | PR HEAD | 같은 명령 | `scripts/`, `githooks/` 에 셸 파일이 없다 | 로컬 | 없음 | PR 전 |
| REQ2 | 임시 저장소 | `commit-msg-hook.spec.ts` 와 `post-commit-hook.spec.ts` 의 「설치한 post-commit 훅」 사례 | `install-hooks.ts` 로 건 두 훅이 `git commit` 에서 node 로 돌아 금지어를 막고, 원본 체크아웃과 워크트리의 커밋에서 어긋남을 알린다 | 로컬 | 없음 | PR 전 |
| REQ4 | PR HEAD | phase-02 검증의 `git grep` | README, `docs/code-architecture.md`, workflow 에 옛 이름 호출이 없다 | 로컬 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI `Tests` job | 통과하고, 실행기 로그에 `scripts/tests` Python 묶음이 없다 | GitHub Actions | push | PR 뒤 |
| REQ10 | PR HEAD | `git ls-files scripts/samples scripts/check-shell-korean.py` 와 README 의 `check-shell-korean` 검색 | 빈 출력 | 로컬 | 없음 | PR 전 |
| REQ3 | main 머지 | 머지 뒤 `plugin-version.yml` 실행 로그와 main 의 자동 커밋 | workflow 가 node 로 돌아 version 을 올린 커밋을 push 한다. 실패하면 로컬 main 에서 `node scripts/bump-plugin-version.ts --base <머지 전> --head <머지>` 로 올린 커밋을 push 해 복구한다 | GitHub Actions | 머지 | PR 뒤 |
