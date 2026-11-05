# 저장소 기반 인수 검증 계획

이 PR 은 스펙 REQ1·REQ2 의 검사 장치, REQ5 의 이행 중 CI, REQ9 의 규칙 문서와 저장소 검사를 맡는다. 파일이 실제로 0개가 되는 것은 PR11 의 인수 검증이 본다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | 이 PR 의 HEAD 를 `git worktree add` 로 세션 임시 폴더에 둔 사본 | 사본의 `scripts/` 밖(예: `docs/probe.py`)에 `.py` 하나를 만들어 `git add` 한 뒤 `node scripts/runtime-policy.ts` | `NEW docs/probe.py python` 줄과 종료 코드 1 | 로컬 임시 사본 | 없음 | PR 전 |
| REQ1 | 같은 사본 | `pending` 에서 `skills/plan/` 항목 하나를 지우고 `node scripts/runtime-policy.ts` | `skills/plan/` 아래 Python 파일마다 `NEW` 줄과 종료 코드 1 | 로컬 임시 사본 | 없음 | PR 전 |
| REQ2 | 같은 사본 | 확장자 없는 `githooks/probe` 를 `#!/usr/bin/env bash` 로 만들어 `git add` 한 뒤 `node scripts/runtime-policy.ts` | `githooks/` 가 pending 이라 위반이 없다. 그 파일을 `docs/probe` 로 옮기면 `NEW docs/probe shell` 과 1 | 로컬 임시 사본 | 없음 | PR 전 |
| REQ2 | 같은 사본 | `docs/probe.mjs` 를 만들어 `git add` 한 뒤 실행 | `NEW docs/probe.mjs js-entry` 와 1 | 로컬 임시 사본 | 없음 | PR 전 |
| REQ5 | 이 PR | PR 의 CI 로그를 본다 | `Plugin tests` 의 node 테스트 단계 출력에 `scripts/tests/runtime-policy.spec.ts` 의 테스트가 있고 통과한다. `Python tests` 로그에 `skip skills/orch/tests (no test_*.py)`, `skip skills/inbox/tests (no test_*.py)` 줄이 있고 job 이 통과한다. 이 줄은 새 규칙만 찍으므로 ci.yml 을 되돌리면 사라진다 | GitHub Actions | push | PR 뒤 |
| REQ9 | 첫 행과 같은 사본에 `docs/probe.py` 를 둔 상태 | 사본에서 `node --test scripts/tests/runtime-policy.spec.ts` | 저장소 전체 사례가 실패하고, 실패 메시지에 `NEW docs/probe.py python` 이 보인다 | 로컬 임시 사본 | 없음 | PR 전 |
| REQ9 | 이 PR 의 diff | `docs/code-architecture.md` 「저장소 실행 규칙」 과 새 ADR 을 읽는다 | 규칙(TypeScript, Python·셸 없음, JS 진입 예외, import 범위, 호출 꼴, 테스트, 저장소 검사)이 한 절에 있고 ADR 이 그 절을 원본으로 가리킨다. orch 절의 같은 행이 지워졌다 | 로컬 | 없음 | PR 전 |

원격 검증의 원본은 이 표의 REQ5 행 하나다. 따로 `remote-verification.md` 를 두지 않는다.

## 머지 조건(코디네이터)

- PR 을 머지하기 직전 그때의 `origin/main` 에서 `team-export` 브랜치를 만들어 push 하고 SHA 를 보드 항목에 적는다(스펙 DECISION10). 이 PR 은 내보내는 파일을 바꾸지 않아, 이 PR 을 머지한 뒤 만들어도 내용은 같다.
