# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

korean-check 네 명령이 지키는 옵션, stdout, 종료 코드, 훅 모드 JSON 을 `node:test` 로 먼저 고정한다. 이 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체, 옛 Python 테스트 삭제, 옛 이름 진입(phase-02).

## 컨텍스트

**요구사항**: REQ3, REQ6

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `export-only-skills/korean-check/tests/<명령>.spec.ts` 다. `tests/helpers.ts` 의 「명령 경계」 상수(실행 argv 앞부분) 한 곳만 구현을 가린다. phase-02 는 이 상수만 바꾼다.
- 내보내는 스킬이라 Node 내장 모듈만 쓴다(`exported-imports.spec.ts`).
- 대상 명령: `korean-style-check`(파일 검사, `--hook`), `check-readability`(파일, `--text`, `--hook`), `check-diff`(임시 git 저장소), `check`(`<파일>`, `--text`, `--diff`, `--where`).
- 이 머신의 사용자 훅이 `~/.claude/scripts/korean-style-check.py` 링크로 `--hook` 을 부른다. 링크로 부르는 사례를 명령 경계 테스트에 넣는다(REQ6).

## 의도 메모

- 정규식 중심 검사기라 Python `re` 와 JS 정규식이 다른 글자(`\w`, `\b` 의 한글, `\S` 의 `\x1c-\x1f`·`\x85`, `re.M`, 한글 범위 `가-힣`)를 경계 사례로 둔다. phase-02 가 같은 값으로 정규식을 옮긴다.
- 옛 Python 테스트 사례(스타일 검사기, 가독성, diff)는 모두 명령 경계로 관측되므로 새 테스트가 같은 입력으로 덮는다. 내부 함수만 보던 `WORD_START_PREFIXES` 사례는 명령 경계로 관측할 수 없어 구현과 함께 내부 함수 테스트로 옮긴다.
- 저장소 전체 문서가 규칙을 지키는지 보던 `TestRepository` 와 제외 목록(`.claude/korean-check-exclude.txt`) 사례는 새 테스트로 옮긴다.
- argparse 의 옵션 해석(`check-diff` 의 `--base`, `--bas`, `--base=x`, 거듭 준 `--base` 는 마지막 값, 모르는 옵션 2)을 본다.

## 작업 항목

### 1. `tests/helpers.ts`
임시 폴더, 명령 실행(stdin, env), 임시 git 저장소, 「명령 경계」 상수.

### 2. `tests/korean-style-check.spec.ts`, `tests/check-readability.spec.ts`
옛 Python 사례 전부와 훅 모드 JSON 바이트, 링크 호출, 한글 `\u` 가 아닌 원문 출력.

### 3. `tests/check-diff.spec.ts`, `tests/check.spec.ts`
옛 `test_check_diff.py` 사례와 `check.sh` 의 인자·종료 코드·`--text` 임시 경로 치환·`--where`.

## 검증

```bash
node --test export-only-skills/korean-check/tests/*.spec.ts
python3 -m unittest discover -s export-only-skills/korean-check/tests
```

종료 코드 0. 새 테스트와 옛 Python 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `export-only-skills/korean-check/tests/helpers.ts` | 신규 |
| `export-only-skills/korean-check/tests/korean-style-check.spec.ts` | 신규 |
| `export-only-skills/korean-check/tests/check-readability.spec.ts` | 신규 |
| `export-only-skills/korean-check/tests/check-diff.spec.ts` | 신규 |
| `export-only-skills/korean-check/tests/check.spec.ts` | 신규 |
