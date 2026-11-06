# Phase 02. 구현을 TypeScript 로 바꾸고 부르는 곳을 맞춘다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 사례는 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다. 스킬 문서와 저장소 문서, 설치 점검, 저장소 정책이 새 이름을 부른다.

**범위 외**: korean-check 의 `check.sh`·browser-driver 의 `browser_driver.py` 를 새 꼴로 부르는 일, 다른 저장소의 호출(머지 뒤 후속), 팀 저장소 반영.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 명령 파일 이름은 확장자만 바꾼다: `scripts/dooray-preview/generate.ts`, `scripts/github-preview/generate.ts`, `scripts/preview_output.ts`, `scripts/show-preview.ts`, `scripts/style-check.ts`. 명령은 첫 줄 `#!/usr/bin/env node`, 실행 권한, 머리 주석이 사용법과 종료 코드를 소유한다. 명령은 진입일 때만 돈다(`isMain`).
- 스킬은 자기 폴더 밖을 import 하지 않는다. `args.ts`(옵션 접두 펼치기), `py.ts`(옛 Python 과 같은 변환)의 복사본을 `scripts/kit/` 에 둔다(`scripts/sync-kit.ts --add`). 생성기 둘이 `preview_output.ts`, `io.ts` 를 함께 쓴다.
- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(설계 「호출 꼴」).
- 정규식은 명시 문자 클래스로 옮긴다(설계 「동등성 확인」): `\s` 는 `PY_SPACE`, `re.M` 의 `^`·`$` 는 `(?<![^\n])`·`(?![^\n])`, `\w` 는 `[\p{L}\p{N}_]`, `re.I` 는 `iu`.
- `show-preview` 는 설정 파일의 `previewDriver` 를 `python3 -c` 대신 JSON 읽기로 읽는다. 드라이버(`browser_driver.py`)와 `korean-check/scripts/check.sh` 는 옛 꼴 그대로 실행 파일로 부른다.

## 의도 메모

- 호환성 항목이라 스킬 버전을 4.0.0 으로 직접 올리고 CHANGELOG 에 `호환성:` 항목을 둔다(README 「버전과 변경 이력」). 변경 조각은 쓰지 않는다.
- `docs/code-architecture.md` 의 두 행(검사기·드라이버 찾는 순서)과 배치 표가 옛 이름을 적고 있어 같은 커밋에서 새 이름으로 바꾼다. 순서는 그대로다.
- `scripts/test-plugin-install.ts` 의 `style-check.sh --where` 호출은 `node …/style-check.ts --where` 로 바꾼다.

## 작업 항목

### 1. `kit` 복사본과 구현

`node scripts/sync-kit.ts --add export-only-skills/content-preview args.ts py.ts`, `tsconfig.json` 의 include 에 `export-only-skills/content-preview/scripts/**/*.ts`. 다섯 명령을 구현하고 `*.spec.ts` 의 명령 경계 상수를 새 파일로 바꾼다. 옛 `.py`, `.sh`, `test_*.py` 를 지운다.

### 2. 문서

`SKILL.md`·`README.md` 의 호출과 필요 조건(`python3` 대신 Node 24), CHANGELOG, `metadata.version`, 각 생성기의 사용 예 주석.

### 3. 저장소 문서와 점검

`docs/code-architecture.md`, `scripts/test-plugin-install.ts`, `docs/features/node-runtime/design.md` 의 알려진 호출 줄.

### 4. 저장소 정책

`runtime-policy.json` 에서 `content-preview` 줄을 지우고 `migrated_docs` 에 `export-only-skills/content-preview/` 를 더한다.

## 검증

```bash
node scripts/run-tests.ts 'export-only-skills/content-preview/tests/*.spec.ts'
node scripts/runtime-policy.ts --pending
node scripts/sync-kit.ts --check
node scripts/run-tests.ts
```

모두 종료 코드 0, pending 에 `content-preview` 가 없다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `export-only-skills/content-preview/scripts/dooray-preview/generate.ts` | 신규 |
| `export-only-skills/content-preview/scripts/github-preview/generate.ts` | 신규 |
| `export-only-skills/content-preview/scripts/preview_output.ts` | 신규 |
| `export-only-skills/content-preview/scripts/show-preview.ts` | 신규 |
| `export-only-skills/content-preview/scripts/style-check.ts` | 신규 |
| `export-only-skills/content-preview/scripts/io.ts` | 신규 |
| `export-only-skills/content-preview/scripts/kit/args.ts` | 신규 |
| `export-only-skills/content-preview/scripts/kit/py.ts` | 신규 |
| `export-only-skills/content-preview/scripts/dooray-preview/generate.py` | 삭제 |
| `export-only-skills/content-preview/scripts/github-preview/generate.py` | 삭제 |
| `export-only-skills/content-preview/scripts/preview_output.py` | 삭제 |
| `export-only-skills/content-preview/scripts/show-preview.sh` | 삭제 |
| `export-only-skills/content-preview/scripts/style-check.sh` | 삭제 |
| `export-only-skills/content-preview/tests/test_dooray_preview.py` | 삭제 |
| `export-only-skills/content-preview/tests/test_preview_output.py` | 삭제 |
| `export-only-skills/content-preview/tests/*.spec.ts` | 수정(명령 경계 상수) |
| `export-only-skills/content-preview/SKILL.md` | 수정 |
| `export-only-skills/content-preview/README.md` | 수정 |
| `export-only-skills/content-preview/CHANGELOG.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `scripts/test-plugin-install.ts` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `tsconfig.json` | 수정 |
| `docs/features/node-runtime/design.md` | 수정 |
