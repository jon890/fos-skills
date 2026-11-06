# Phase 02. TypeScript 구현으로 바꾸기

**Execution profile**: standard

## 목표

열네 개 `.py` 를 같은 옵션·stdout·종료 코드의 `.ts` 로 옮기고 옛 파일과 Python 테스트를 지운다. 명령 경계 테스트는 `tests/helpers.ts` 의 상수만 바꿔 통과해야 한다.

**범위 외**: 부르는 문서와 정책 파일(phase-03).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ5

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 스킬 폴더 밖을 import 하지 않는다(DECISION1). `kit/py.ts`(`scripts/sync-kit.ts --add`), `cli.ts`(argparse 읽기), `io.ts`, `pylike.ts` 를 스킬 폴더에 둔다. `cli.ts` 와 `pylike.ts` 의 필요한 부분은 plan 영역 구현(`skills/plan/scripts/`)에서 가져온다.
- 정규식은 사람이 고친다. Python 의 `\w`, `\b` 는 `[\p{L}\p{N}_]` 로, `\d` 는 `\p{Nd}` 로 바꾸고 `\s` 는 `pyre` 로 Python 공백 집합에 맞춘다.
- 경로: `Path.resolve()` 는 `pyResolve`(심볼릭 링크를 따라간 뒤 `..` 처리), `os.walk(followlinks=False)` 는 디렉터리 링크를 내려가지 않는 순회로 옮긴다.
- 하위 명령을 부르는 `run_checks` 는 `process.execPath` 로 같은 폴더의 `.ts` 를 부른다.

## 작업 항목

### 1. 공용 모듈
`target_files.ts`, `session_log.ts`, `cli.ts`, `io.ts`, `pylike.ts`, `kit/py.ts`.

### 2. 검사기
`collect_targets`, `check_references`, `check_facts`, `check_duplication`, `check_rename_drift`, `check_enforcement`, `find_test_requirements`, `run_checks`.

### 3. 실행기와 사용 기록
`run_doc_snippets`, `extract_skill_usage`, `render_session`, `model_fit_signals`.

### 4. 테스트 전환
상수를 `.ts` 로 바꾸고 옛 `.py`, `test_*.py` 를 지운다. 명령으로 관측되지 않는 사례는 `tests/internals.spec.ts` 로 옮긴다. `tsconfig.json` 의 `include` 에 `skills/harness-cleanup/scripts/**/*.ts` 를 더한다.

## 검증

```bash
node --test skills/harness-cleanup/tests/*.spec.ts
node scripts/sync-kit.ts --check
node scripts/run-tests.ts
```

모두 종료 코드 0. 명령 경계 테스트는 phase-01 에서 상수만 바뀌었다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/harness-cleanup/scripts/target_files.ts` | 신규 |
| `skills/harness-cleanup/scripts/session_log.ts` | 신규 |
| `skills/harness-cleanup/scripts/cli.ts` | 신규 |
| `skills/harness-cleanup/scripts/io.ts` | 신규 |
| `skills/harness-cleanup/scripts/pylike.ts` | 신규 |
| `skills/harness-cleanup/scripts/collect_targets.ts` | 신규 |
| `skills/harness-cleanup/scripts/check_references.ts` | 신규 |
| `skills/harness-cleanup/scripts/check_facts.ts` | 신규 |
| `skills/harness-cleanup/scripts/check_duplication.ts` | 신규 |
| `skills/harness-cleanup/scripts/check_rename_drift.ts` | 신규 |
| `skills/harness-cleanup/scripts/check_enforcement.ts` | 신규 |
| `skills/harness-cleanup/scripts/find_test_requirements.ts` | 신규 |
| `skills/harness-cleanup/scripts/run_checks.ts` | 신규 |
| `skills/harness-cleanup/scripts/run_doc_snippets.ts` | 신규 |
| `skills/harness-cleanup/scripts/extract_skill_usage.ts` | 신규 |
| `skills/harness-cleanup/scripts/render_session.ts` | 신규 |
| `skills/harness-cleanup/scripts/model_fit_signals.ts` | 신규 |
| `skills/harness-cleanup/scripts/kit/py.ts` | 신규 |
| `skills/harness-cleanup/tests/internals.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/helpers.ts` | 수정 |
| `tsconfig.json` | 수정 |
| `skills/harness-cleanup/scripts/check_duplication.py` | 삭제 |
| `skills/harness-cleanup/scripts/check_enforcement.py` | 삭제 |
| `skills/harness-cleanup/scripts/check_facts.py` | 삭제 |
| `skills/harness-cleanup/scripts/check_references.py` | 삭제 |
| `skills/harness-cleanup/scripts/check_rename_drift.py` | 삭제 |
| `skills/harness-cleanup/scripts/collect_targets.py` | 삭제 |
| `skills/harness-cleanup/scripts/extract_skill_usage.py` | 삭제 |
| `skills/harness-cleanup/scripts/find_test_requirements.py` | 삭제 |
| `skills/harness-cleanup/scripts/model_fit_signals.py` | 삭제 |
| `skills/harness-cleanup/scripts/render_session.py` | 삭제 |
| `skills/harness-cleanup/scripts/run_checks.py` | 삭제 |
| `skills/harness-cleanup/scripts/run_doc_snippets.py` | 삭제 |
| `skills/harness-cleanup/scripts/session_log.py` | 삭제 |
| `skills/harness-cleanup/scripts/target_files.py` | 삭제 |
| `skills/harness-cleanup/tests/test_check_facts.py` | 삭제 |
| `skills/harness-cleanup/tests/test_check_references.py` | 삭제 |
| `skills/harness-cleanup/tests/test_collect_and_snippets.py` | 삭제 |
| `skills/harness-cleanup/tests/test_find_test_requirements.py` | 삭제 |
| `skills/harness-cleanup/tests/test_run_checks.py` | 삭제 |
| `skills/harness-cleanup/tests/test_target_files.py` | 삭제 |
| `skills/harness-cleanup/tests/test_usage_audit.py` | 삭제 |
