# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

content-preview 다섯 명령이 지키는 옵션, stdout, 쓰는 파일, 종료 코드를 `node:test` 로 먼저 고정한다. 이 phase 의 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체, 옛 Python 테스트 삭제(phase-02).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `export-only-skills/content-preview/tests/<명령>.spec.ts` 다. 파일 머리의 「명령 경계」 상수(실행 argv 앞부분)만 구현을 가린다. phase-02 는 이 상수만 바꾸고 사례는 고치지 않는다.
- 내보내는 스킬이라 테스트는 Node 내장 모듈만 쓰고 `modules/testkit/` 을 import 하지 않는다(`exported-imports.spec.ts`). 가짜 드라이버·`osascript`·`open` 과 임시 폴더 helper 는 `tests/helpers.ts` 한 파일에 둔다.
- `show-preview` 의 가짜 실행 파일은 PATH 앞에 둔다. 브라우저나 실제 드라이버에는 닿지 않는다. 가짜 `uname` 으로 macOS 와 그 밖의 분기를 둘 다 본다.

## 의도 메모

- 미리보기 생성기는 Markdown 을 직접 해석하지 않는다. 메신저 모드의 정규식(`unrendered_formats`, 토큰 분할, `dooray://` 링크 검사)만 해석이다. Python `re` 와 JS 정규식이 다른 글자(`\s` 의 `\x1c-\x1f`·`\x85`·U+FEFF, `re.M` 의 줄 경계 U+2028, `re.I` 의 `ſ`)를 경계 테스트로 둔다. phase-02 가 같은 값으로 정규식을 옮긴다.
- 옛 Python 테스트 사례(`test_dooray_preview.py` 열두 개, `test_preview_output.py` 셋)는 모두 새 테스트가 같은 명령 경계로 덮는다. phase-02 가 그것을 지우기 전에 사례 목록을 대조한다.
- argparse 의 옵션 해석(고유 접두 줄임, `--opt=value`, 필수 옵션 빠짐·잘못된 choices·모르는 옵션의 종료 코드 2, `--help`)을 명령마다 본다.
- `github-preview` 의 치환은 연쇄 `replace` 라 앞에서 넣은 제목 안의 `{{REPO}}` 를 뒤에서 다시 바꾼다. 이 동작도 그대로 둔다.

## 작업 항목

### 1. `tests/helpers.ts`

임시 폴더, 명령 실행(stdin 입력 포함), 가짜 실행 파일(받은 인자와 환경 변수 기록, 규칙별 stdout·종료 코드), 임시 git 저장소.

### 2. `tests/dooray-preview.spec.ts`, `tests/github-preview.spec.ts`

- 메신저 모드: 옛 Python 열두 사례와 정규식 경계 사례, 업무·댓글 머리, `--strict` 종료 코드, 템플릿 표기가 본문에 남음, 이스케이프
- 옵션: 접두, `=`, 필수 빠짐, choices, `--help`, stdin, 본문 파일 없음, `</script>` 거부
- GitHub: issue·pr 머리, repo 비어 있음, 연쇄 치환

### 3. `tests/preview-output.spec.ts`

옛 Python `test_preview_output.py` 세 사례(덮어쓰기, 실패 때 이전 산출물 삭제, 본문 파일 없음)를 두 생성기에 대해.

### 4. `tests/style-check.spec.ts`

인자 없음 2, 찾는 순서(`KOREAN_CHECK`, 형제, 개인 스킬 폴더), 실행 권한 없음 2, 못 찾음 2, `--where` 와 인자·종료 코드를 그대로 넘김.

### 5. `tests/show-preview.spec.ts`

인자 없음 1, 파일 없음 2, 드라이버 선택 순서, 새로 열기와 탭 id 파일, 기존 탭 갱신, 다른 워크트리 탭 닫고 기본 브라우저로, `worktree` 를 모르는 백엔드, 설정 파일의 `previewDriver` 와 `PREVIEW_BROWSER_DRIVER`, `config-path`, macOS 의 `osascript`·`open`, 그 밖의 `xdg-open`, 모두 실패하는 종료 코드 2.

## 검증

```bash
node scripts/run-tests.ts 'export-only-skills/content-preview/tests/*.spec.ts'
```

종료 코드 0. 옛 Python 테스트와 새 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `export-only-skills/content-preview/tests/helpers.ts` | 신규 |
| `export-only-skills/content-preview/tests/dooray-preview.spec.ts` | 신규 |
| `export-only-skills/content-preview/tests/github-preview.spec.ts` | 신규 |
| `export-only-skills/content-preview/tests/preview-output.spec.ts` | 신규 |
| `export-only-skills/content-preview/tests/style-check.spec.ts` | 신규 |
| `export-only-skills/content-preview/tests/show-preview.spec.ts` | 신규 |
