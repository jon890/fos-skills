# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

harness-cleanup 의 명령 열둘이 지키는 옵션, stdout, 종료 코드, 쓰는 파일을 `node:test` 로 먼저 고정한다. 이 커밋에서 새 테스트는 옛 Python 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체와 옛 Python 테스트 삭제(phase-02), 부르는 문서와 정책 파일(phase-03).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/harness-cleanup/tests/<명령>.spec.ts` 다. `tests/helpers.ts` 의 「명령 경계」 상수(실행 argv 앞부분) 한 곳만 구현을 가린다. phase-02 는 이 상수만 바꾼다.
- 이 스킬은 내보내지 않으므로 `modules/testkit/` 을 쓸 수 있다.
- 대상 명령: `collect_targets`, `run_checks`, `check_references`, `check_facts`, `check_duplication`, `check_rename_drift`, `check_enforcement`, `find_test_requirements`, `run_doc_snippets`, `extract_skill_usage`, `render_session`, `model_fit_signals`.
- `target_files`, `session_log` 는 명령이 아니다. `target_files.is_target` 은 `collect_targets` 의 대상 목록으로, `session_log` 는 `extract_skill_usage`, `render_session` 의 출력으로 관측한다.

## 의도 메모

- 옛 Python 테스트 사례를 모두 명령 경계로 옮긴다. `is_target` 만 부르던 사례는 임시 저장소의 `collect_targets` 출력으로 관측한다.
- 옛 테스트가 없던 명령(`check_duplication`, `check_rename_drift`, `check_enforcement`, `model_fit_signals` 의 옵션 경계)은 이 phase 에서 사례를 더한다.
- 정규식 중심 검사기라 Python `re` 와 JS 정규식이 다른 글자(`\w`, `\b`, `\d`, `\s`, 한글 식별자, `$`)와, 앞 영역 리뷰가 찾은 차이(NBSP 같은 공백 집합, 심볼릭 링크 뒤 `..` 처리, 거듭 준 옵션)를 경계 사례로 둔다.
- 다른 저장소의 `.py`, `.sh` 를 감사하는 판정(스크립트 수 세기)은 바꾸지 않는다. 확장자 목록(`.py`, `.sh`, `.bash`, `.zsh`)도 그대로다.
- `run_doc_snippets` 는 bash 와 zsh 가 모두 있어야 한쪽 줄의 형식을 본다. zsh 가 없으면 「설치돼 있지 않아 건너뛴다」 줄을 본다.

## 작업 항목

### 1. `tests/helpers.ts`
임시 폴더, 명령 실행(env, cwd), 임시 git 저장소, 「명령 경계」 상수.

### 2. 명령마다 `tests/<명령>.spec.ts`
옛 `test_*.py` 의 사례와 위 경계 사례.

## 검증

```bash
node --test skills/harness-cleanup/tests/*.spec.ts
python3 -m unittest discover -s skills/harness-cleanup/tests
```

종료 코드 0. 새 테스트와 옛 Python 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/harness-cleanup/tests/helpers.ts` | 신규 |
| `skills/harness-cleanup/tests/collect-targets.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/run-checks.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/check-references.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/check-facts.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/check-duplication.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/check-rename-drift.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/check-enforcement.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/find-test-requirements.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/run-doc-snippets.spec.ts` | 신규 |
| `skills/harness-cleanup/tests/usage-audit.spec.ts` | 신규 |
