# Phase 02. TypeScript 구현으로 바꾸기

**Execution profile**: standard

## 목표

열한 개 명령(`.py` 열, `.sh` 하나)을 같은 옵션·stdout·쓰는 파일·종료 코드의 `.ts` 로 옮기고 옛 파일과 Python 테스트를 지운다. 명령 경계 테스트는 `tests/helpers.ts` 의 상수만 바꿔 통과해야 한다.

**범위 외**: 부르는 문서와 정책 파일(phase-03).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ5

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 스킬 폴더 밖을 import 하지 않는다(DECISION1). `kit/py.ts`(`scripts/sync-kit.ts --add`), `cli.ts`(argparse 읽기), `io.ts`, `pylike.ts` 를 스킬 폴더에 둔다. `cli.ts` 와 `pylike.ts` 의 필요한 부분은 harness-cleanup 구현(`skills/harness-cleanup/scripts/`)에서 가져온다. 셋째 복사지만 두 스킬의 복사본이 서로 다른 부분집합이라 `modules/kit` 으로 모으는 일은 이 PR 에서 하지 않는다(PR 본문 「결정」).
- 옛 명령이 import 하던 모듈 관계를 그대로 둔다: `delete_sessions` → `survey_sessions`, `delete_volumes` → `docker_volumes`.
- Python 과 JS 가 다른 곳은 처음부터 맞춘다. 정규식은 사람이 고친다(`\s` 는 `pyre`, `\w` 는 `[\p{L}\p{N}_]`). `.1f` 서식은 정확한 십진 값으로 짝수 반올림하는 helper 를 쓴다. JSON 은 실수 표기(`24.0`)와 들여쓰기, `ensure_ascii=False` 를 맞춘다. 경로는 심볼릭 링크를 따라간 뒤 `..` 를 처리한다. 디렉터리 순회는 판정 오류(ELOOP 등)를 파일로 보고 계속한다. 거듭 준 옵션은 값마다 검사하고, 값 옵션 뒤의 `--` 는 값 누락이다.
- 삭제 동작(`git branch -d/-D`, `docker volume rm`, 폴더 삭제)은 판정 순서와 재확인 조건을 옛 구현 그대로 옮긴다. 폴더 삭제는 `shutil.rmtree` 처럼 링크를 따라가지 않고 폴더 안을 지운다.
- `survey_gradle.sh` 의 `find`, `grep`, `sort`, `du` 조합은 TypeScript 로 옮기되 `du -sh` 는 그대로 부른다(사람이 읽는 크기의 원본이 `du` 다).

## 작업 항목

### 1. 공용 모듈
`cli.ts`, `io.ts`, `pylike.ts`, `kit/py.ts`.

### 2. 조사 명령
`survey_system`, `survey_sessions`, `survey_git`, `survey_gradle`, `docker_images`, `docker_volumes`.

### 3. 확인과 삭제 명령
`check_pr_branches`, `delete_branches`, `delete_sessions`, `delete_volumes`, `colima_trim`.

### 4. 테스트 전환
상수를 `.ts` 로 바꾸고 옛 `.py`, `.sh`, `test_*.py` 를 지운다. 명령으로 관측되지 않는 사례는 `tests/internals.spec.ts` 로 옮긴다. `tsconfig.json` 의 `include` 에 `skills/mac-cleanup/scripts/**/*.ts` 를 더한다.

## 검증

```bash
node --test skills/mac-cleanup/tests/*.spec.ts
node scripts/sync-kit.ts --check
node scripts/run-tests.ts
```

모두 종료 코드 0. 명령 경계 테스트는 phase-01 에서 상수만 바뀌었다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/mac-cleanup/scripts/cli.ts` | 신규 |
| `skills/mac-cleanup/scripts/io.ts` | 신규 |
| `skills/mac-cleanup/scripts/pylike.ts` | 신규 |
| `skills/mac-cleanup/scripts/kit/py.ts` | 신규 |
| `skills/mac-cleanup/scripts/survey_system.ts` | 신규 |
| `skills/mac-cleanup/scripts/survey_sessions.ts` | 신규 |
| `skills/mac-cleanup/scripts/survey_git.ts` | 신규 |
| `skills/mac-cleanup/scripts/survey_gradle.ts` | 신규 |
| `skills/mac-cleanup/scripts/docker_images.ts` | 신규 |
| `skills/mac-cleanup/scripts/docker_volumes.ts` | 신규 |
| `skills/mac-cleanup/scripts/check_pr_branches.ts` | 신규 |
| `skills/mac-cleanup/scripts/delete_branches.ts` | 신규 |
| `skills/mac-cleanup/scripts/delete_sessions.ts` | 신규 |
| `skills/mac-cleanup/scripts/delete_volumes.ts` | 신규 |
| `skills/mac-cleanup/scripts/colima_trim.ts` | 신규 |
| `skills/mac-cleanup/tests/internals.spec.ts` | 신규 |
| `skills/mac-cleanup/tests/helpers.ts` | 수정 |
| `tsconfig.json` | 수정 |
| `skills/mac-cleanup/scripts/check_pr_branches.py` | 삭제 |
| `skills/mac-cleanup/scripts/colima_trim.py` | 삭제 |
| `skills/mac-cleanup/scripts/delete_branches.py` | 삭제 |
| `skills/mac-cleanup/scripts/delete_sessions.py` | 삭제 |
| `skills/mac-cleanup/scripts/delete_volumes.py` | 삭제 |
| `skills/mac-cleanup/scripts/docker_images.py` | 삭제 |
| `skills/mac-cleanup/scripts/docker_volumes.py` | 삭제 |
| `skills/mac-cleanup/scripts/survey_git.py` | 삭제 |
| `skills/mac-cleanup/scripts/survey_sessions.py` | 삭제 |
| `skills/mac-cleanup/scripts/survey_system.py` | 삭제 |
| `skills/mac-cleanup/scripts/survey_gradle.sh` | 삭제 |
| `skills/mac-cleanup/tests/test_check_pr_branches.py` | 삭제 |
| `skills/mac-cleanup/tests/test_colima_trim.py` | 삭제 |
| `skills/mac-cleanup/tests/test_delete_branches.py` | 삭제 |
| `skills/mac-cleanup/tests/test_delete_sessions.py` | 삭제 |
| `skills/mac-cleanup/tests/test_delete_volumes.py` | 삭제 |
| `skills/mac-cleanup/tests/test_docker_volumes.py` | 삭제 |
| `skills/mac-cleanup/tests/test_parsers.py` | 삭제 |
| `skills/mac-cleanup/tests/test_rm_guard.py` | 삭제 |
| `skills/mac-cleanup/tests/test_survey_gradle.py` | 삭제 |
| `skills/mac-cleanup/tests/test_survey_system.py` | 삭제 |
