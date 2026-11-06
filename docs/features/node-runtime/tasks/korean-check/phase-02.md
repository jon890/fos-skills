# Phase 02. 구현을 TypeScript 로 바꾸고 부르는 곳을 맞춘다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 사례는 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다. 옛 이름 진입 둘을 두고, 문서와 부르는 쪽이 새 이름을 부른다.

**범위 외**: 다른 저장소의 호출(머지 뒤 후속), 팀 저장소 반영, 옛 이름 진입 삭제(다음 major).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ6, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 명령은 확장자만 바꾼다: `korean-style-check.ts`, `check-readability.ts`, `check-diff.ts`, `check.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한, 진입일 때만 돈다(`isMain`). `kit` 복사본(`py.ts`, `args.ts`)과 `io.ts` 를 `scripts/` 에 둔다.
- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다. `check.sh` 의 `python3`·`bash` 파이프는 `.ts` 안에서 한다.
- 옛 이름 진입 `scripts/korean-style-check.py`, `scripts/check-readability.py`(node shebang JS, 실행 권한)는 새 `.ts` 의 `main(argv)`, `runHook(input)` 을 import 한다(설계 「옛 이름 진입」). 훅 모드는 발견이 있을 때 `additionalContext` 맨 앞에 안내 한 줄을 붙이고 발견이 없으면 출력이 없다. Node 가 `min_node` 보다 낮으면 훅은 건너뛰기 안내를 내고 0, 일반 모드는 stderr 와 127 이다. `MIN_NODE` 선언은 `scripts/runtime-policy.json` 의 값과 같다.
- 훅 모드 JSON 은 Python `json.dumps(ensure_ascii=False)` 의 바이트와 같게 쓴다(`pyJson` 의 `ensure_ascii` 선택).
- 정규식은 명시 문자 클래스로 옮긴다(설계 「동등성 확인」).

## 작업 항목

### 1. 구현과 테스트 전환
`kit` 복사본(`scripts/sync-kit.ts --add`), 네 명령, 옛 이름 진입 둘. 상수를 `.ts` 로 바꾼다. 옛 `.py`, `.sh`, `test_*.py` 를 지운다. 옛 이름 진입 테스트(`legacy-entry.spec.ts`)를 더한다.

### 2. 부르는 쪽
`githooks/commit-msg.ts`, `content-preview/scripts/style-check.ts`, `presentation/scripts/check-deck.ts`, `report/scripts/check-report.ts`, 설치 점검 스크립트(`test-plugin-install`)의 머리 주석(bash 요구)과 부르는 쪽의 테스트. 설치 점검은 `claude` 가 필요해 PR 전 로컬에서 따로 돌려 결과를 본문에 적는다.

### 3. 문서
`SKILL.md`, `README.md`(링크와 훅 안내), `references/*`, CHANGELOG, `metadata.version`(major), `docs/code-architecture.md`.

### 4. 저장소 정책
`runtime-policy.json` 에서 `korean-check` 줄을 지우고 `legacy` 에 옛 이름 진입 둘을, `migrated_docs` 에 `export-only-skills/korean-check/` 를 더한다. `tsconfig.json` 의 include 에 추가.

## 검증

```bash
node --test export-only-skills/korean-check/tests/*.spec.ts
node scripts/runtime-policy.ts --pending
node scripts/sync-kit.ts --check
node scripts/run-tests.ts
```

모두 종료 코드 0, pending 에 `korean-check` 가 없다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `export-only-skills/korean-check/scripts/korean-style-check.ts` | 신규 |
| `export-only-skills/korean-check/scripts/check-readability.ts` | 신규 |
| `export-only-skills/korean-check/scripts/check-diff.ts` | 신규 |
| `export-only-skills/korean-check/scripts/check.ts` | 신규 |
| `export-only-skills/korean-check/scripts/io.ts` | 신규 |
| `export-only-skills/korean-check/scripts/kit/args.ts` | 신규 |
| `export-only-skills/korean-check/scripts/kit/py.ts` | 신규 |
| `export-only-skills/korean-check/tests/legacy-entry.spec.ts` | 신규 |
| `export-only-skills/korean-check/scripts/korean-style-check.py` | 수정 |
| `export-only-skills/korean-check/scripts/check-readability.py` | 수정 |
| `export-only-skills/korean-check/scripts/check-diff.py` | 삭제 |
| `export-only-skills/korean-check/scripts/check.sh` | 삭제 |
| `export-only-skills/korean-check/tests/test_korean_style_check.py` | 삭제 |
| `export-only-skills/korean-check/tests/test_check_readability.py` | 삭제 |
| `export-only-skills/korean-check/tests/test_check_diff.py` | 삭제 |
| `export-only-skills/korean-check/SKILL.md` | 수정 |
| `export-only-skills/korean-check/README.md` | 수정 |
| `export-only-skills/korean-check/CHANGELOG.md` | 수정 |
| `githooks/commit-msg.ts` | 수정 |
| `export-only-skills/content-preview/scripts/style-check.ts` | 수정 |
| `skills/presentation/scripts/check-deck.ts` | 수정 |
| `skills/report/scripts/check-report.ts` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `tsconfig.json` | 수정 |
