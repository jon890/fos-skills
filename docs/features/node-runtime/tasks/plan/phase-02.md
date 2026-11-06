# Phase 02. 구현을 TypeScript 로 바꾼다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 사례는 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다.

**범위 외**: 부르는 문서와 설치 점검(phase-03), 다른 저장소의 호출(머지 뒤 후속).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ5

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 명령은 확장자만 바꾼다: `verify_task.ts`, `check_feature.ts`, `run_doc_checks.ts`, `overlay_paths.ts`, `plan_number.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한, 진입일 때만 돈다(`isMain`). 새 `.ts` 의 직접 실행 판정은 처음부터 `realpathSync` 로 비교한다(korean-check 의 `io.ts` 와 같다).
- `overlay_values.py` 는 `overlay_values.ts` 모듈로, `plan_numbers.py` 는 `plan_numbers.ts` 모듈로 옮긴다. `plan_number.sh` 의 git 호출(`fetch`, `log` 한 번, `ls-tree` 한 번, `gh pr list`)은 `plan_number.ts` 가 같은 순서로 부른다.
- `kit` 복사본은 `scripts/sync-kit.ts --add skills/plan py.ts` 로 둔다. argparse 의 고유 접두와 사용법 오류는 `scripts/cli.ts` 에 모은다. `shlex`, `fnmatch`, `Path.glob` 처럼 표준 라이브러리가 주던 동작은 `verify_task.ts` 가 쓰는 만큼만 `scripts/pylike.ts` 로 옮긴다.
- 정규식은 명시 문자 클래스로 옮긴다(설계 「동등성 확인」). `\w` 는 `[\p{L}\p{N}_]`, `\d` 는 `\p{Nd}`(`u` 플래그), `re.M` 의 `^`·`$` 는 줄바꿈 기준의 lookaround 로 쓴다.
- `verify_task` 가 `check_feature` 를 자식 프로세스로 부르던 곳은 같은 폴더의 함수 호출로 바꾼다. 출력 줄(「기능 계약 검사 실패: ...」)은 같다.
- 동작은 바꾸지 않는다. `node scripts/run-tests.ts` 를 테스트 명령으로 인정하지 않는 오탐은 옮긴 뒤 따로 고친다(`deferred`).

## 작업 항목

### 1. 구현과 테스트 전환
`kit` 복사본, `io.ts`, `cli.ts`, `pylike.ts`, 명령 다섯과 모듈 둘. 상수를 `.ts` 로 바꾼다. 옛 `.py`, `.sh`, `test_*.py` 를 지운다.

### 2. 내부 함수 테스트
`tests/verify-task-internals.spec.ts` 가 명령으로 관측되지 않는 사례(`classify`, `directory_args`, `command_cwds`, `owns_call_name`, `matches`, `is_test`, `runnable_test` 의 반환값)를, `tests/pylike.spec.ts` 가 `shlex`·`fnmatch`·`glob` 옮김을 본다.

## 검증

```bash
node --test skills/plan/tests/*.spec.ts
node scripts/sync-kit.ts --check
node scripts/run-tests.ts
```

모두 종료 코드 0. 명령 경계 테스트는 phase-01 에서 상수만 바뀌었다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/plan/scripts/verify_task.ts` | 신규 |
| `skills/plan/scripts/check_feature.ts` | 신규 |
| `skills/plan/scripts/run_doc_checks.ts` | 신규 |
| `skills/plan/scripts/overlay_paths.ts` | 신규 |
| `skills/plan/scripts/overlay_values.ts` | 신규 |
| `skills/plan/scripts/plan_number.ts` | 신규 |
| `skills/plan/scripts/plan_numbers.ts` | 신규 |
| `skills/plan/scripts/io.ts` | 신규 |
| `skills/plan/scripts/cli.ts` | 신규 |
| `skills/plan/scripts/pylike.ts` | 신규 |
| `skills/plan/scripts/kit/py.ts` | 신규 |
| `skills/plan/tests/verify-task-internals.spec.ts` | 신규 |
| `skills/plan/tests/pylike.spec.ts` | 신규 |
| `skills/plan/tests/helpers.ts` | 수정 |
| `skills/plan/scripts/verify_task.py` | 삭제 |
| `skills/plan/scripts/check_feature.py` | 삭제 |
| `skills/plan/scripts/run_doc_checks.py` | 삭제 |
| `skills/plan/scripts/overlay_paths.py` | 삭제 |
| `skills/plan/scripts/overlay_values.py` | 삭제 |
| `skills/plan/scripts/plan_number.sh` | 삭제 |
| `skills/plan/scripts/plan_numbers.py` | 삭제 |
| `skills/plan/tests/test_verify_task.py` | 삭제 |
| `skills/plan/tests/test_feature_contract.py` | 삭제 |
| `skills/plan/tests/test_technical_design_contract.py` | 삭제 |
| `skills/plan/tests/test_verification_plan.py` | 삭제 |
| `skills/plan/tests/test_overlay_paths.py` | 삭제 |
| `skills/plan/tests/test_run_doc_checks.py` | 삭제 |
| `skills/plan/tests/test_plan_number.py` | 삭제 |
