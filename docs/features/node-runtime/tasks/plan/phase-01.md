# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

plan 의 일곱 명령이 지키는 옵션, stdout, 종료 코드, 쓰는 파일을 `node:test` 로 먼저 고정한다. 이 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체, 옛 Python 테스트 삭제(phase-02), 부르는 문서와 점검 스크립트(phase-03).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/plan/tests/<명령>.spec.ts` 다. `tests/helpers.ts` 의 「명령 경계」 상수(실행 argv 앞부분) 한 곳만 구현을 가린다. phase-02 는 이 상수만 바꾼다.
- 내보내는 스킬이라 Node 내장 모듈만 쓴다(`scripts/tests/exported-imports.spec.ts`). helper 는 `tests/helpers.ts` 안에 둔다.
- 대상 명령: `verify_task`(계획 폴더 검사, `--audit`, `--staged`, `--require-verification`, `--tasks-dir`), `check_feature`(스펙, `--plan`, `--design`, `--draft`), `run_doc_checks`(`--skill`), `overlay_paths`(`--skill`, `--sub`, `--plan`, 표준 입력 `-`), `plan_number`(`--tasks-dir`, `--prefix`, `--name-regex`, `--allow-empty`).
- `overlay_values` 와 `plan_numbers` 는 명령이 아니다. `overlay_values` 는 `verify_task`, `run_doc_checks` 가 읽는 값(PR 변경 파일 상한 같은 것)으로, `plan_numbers` 는 `plan_number` 의 출력으로 관측한다.

## 의도 메모

- 옛 Python 테스트 144건 가운데 `verify_task` 의 내부 함수(`check_phase_prompt`, `check_file_state`, `classify` 따위)만 부르던 사례는 임시 저장소에 계획 폴더를 만들고 명령을 돌려 stdout 의 위반·경고 줄로 관측한다. 명령으로 관측되지 않는 사례(`classify` 의 반환 종류, `directory_args`, `command_cwds` 의 목록 같은 내부 값)는 구현과 함께 내부 함수 테스트(phase-02)로 옮긴다.
- 정규식 중심 검사기라 Python `re` 와 JS 정규식이 다른 글자(`\w`, `\d`, `re.M`, 한글 식별자)를 경계 사례로 둔다.
- `plan_number` 는 원격 저장소와 가짜 `gh` 를 임시 폴더에 두고 돌려 실제 GitHub 에 닿지 않는다. `--tasks-dir` 에 값이 없을 때 셸의 `${2:?}` 가 종료 코드 1 로 끝나는 것(문서는 2 라고 적었다)도 지금 동작 그대로 고정한다.
- argparse 의 옵션 해석(긴 옵션의 고유 접두, `--opt=value`, 플래그에 값을 주면 2, 거듭 준 값은 마지막, 위치 인자 덩어리가 둘이면 2)을 본다.

## 작업 항목

### 1. `tests/helpers.ts`
임시 폴더, 명령 실행(stdin, env, cwd), 임시 git 저장소, 계획 폴더 만들기, 「명령 경계」 상수.

### 2. `tests/check-feature.spec.ts`, `tests/overlay-paths.spec.ts`, `tests/run-doc-checks.spec.ts`
옛 `test_feature_contract.py`, `test_technical_design_contract.py`, `test_verification_plan.py`, `test_overlay_paths.py`, `test_run_doc_checks.py` 의 사례를 모두 명령 경계로 옮긴다.

### 3. `tests/plan-number.spec.ts`
옛 `test_plan_number.py` 의 사례 전부와 git 호출 수 확인.

### 4. `tests/verify-task.spec.ts`, `tests/verify-task-files.spec.ts`, `tests/verify-task-plan.spec.ts`
옛 `test_verify_task.py` 의 사례를 위반·경고 줄로 관측한다. 문서 전체 비교(저장소의 실제 계획 폴더)는 PR 전에 세션 임시 폴더의 스크립트로 따로 한다.

## 검증

```bash
node --test skills/plan/tests/*.spec.ts
python3 -m unittest discover -s skills/plan/tests
```

종료 코드 0. 새 테스트와 옛 Python 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/plan/tests/helpers.ts` | 신규 |
| `skills/plan/tests/check-feature.spec.ts` | 신규 |
| `skills/plan/tests/overlay-paths.spec.ts` | 신규 |
| `skills/plan/tests/run-doc-checks.spec.ts` | 신규 |
| `skills/plan/tests/plan-number.spec.ts` | 신규 |
| `skills/plan/tests/verify-task.spec.ts` | 신규 |
| `skills/plan/tests/verify-task-files.spec.ts` | 신규 |
| `skills/plan/tests/verify-task-plan.spec.ts` | 신규 |
