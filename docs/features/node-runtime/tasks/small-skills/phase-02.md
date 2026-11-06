# Phase 02. 구현을 TypeScript 로 바꾸고 부르는 곳을 맞춘다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다. 스킬 문서와 저장소 정책이 새 이름을 부른다. 스킬마다 커밋 하나다.

**범위 외**: 다른 영역의 명령(`verify_task.py`, `overlay_paths.py`, korean-check 검사기, browser-driver)을 부르는 줄은 그 영역 PR 이 바꾼다(설계 「실패와 일관성」).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 명령 파일 이름은 확장자만 바꾼다(설계 DECISION5): `gh-host.ts`, `gh-review-list.ts`, `gh-review-post.ts`, `render-comments.ts`, `pr_mergeable.ts`, `plan_precheck.ts`, `static_check.ts`, `run_static_check.ts`, `check-report.ts`, `check-deck.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한, 머리 주석이 사용법과 종료 코드를 소유한다.
- 명령은 `import.meta.main` 일 때만 돈다. 함수는 export 해 내부 함수 테스트가 import 한다.
- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(설계 DECISION4).
- 스킬은 자기 폴더 밖을 import 하지 않는다(설계 DECISION1). argparse 접두 줄임이 필요한 `plan_precheck` 만 `modules/kit/args.ts` 의 복사본 `skills/implementation/scripts/kit/args.ts` 를 쓴다. 복사본 대조는 `scripts/tests/kit-copies.spec.ts`, 맞추기는 `scripts/sync-kit.ts`, 원본 위치는 `runtime-policy.json` 의 `kit_sources` 가 맡는다.
- Python `html.parser` 를 쓰던 `check-report` 는 내장 HTML 해석기가 없어 같은 규칙(태그 열기·닫기, CDATA 모드, 문자 참조, 줄 번호)의 작은 해석기를 그 파일 안에 둔다. 문자 참조는 숫자 참조와 자주 쓰는 이름 참조를 푼다.
- 두 엔진의 뜻이 다른 정규식은 명시 문자 클래스로 옮긴다(설계 「동등성 확인」).

## 의도 메모

- `presentation` 은 korean-check 의 매처를 Python 모듈로 불러 쓰던 것을 `korean-style-check.py` 를 자식 프로세스로 부르는 것으로 바꾼다(설계 DECISION1). 덱의 산문을 임시 `.md` 로 써서 넘기고 `금지어 "<낱말>"` 줄에서 낱말을 읽는다. 옛 호출 꼴(`python3 <경로>`)은 영역 6 이 바꾼다. 이 방식은 그 스킬 검사기의 표 행·코드 스팬 제외와 예외 파일을 함께 받는다는 점이 옛 구현과 다르다. PR 본문 「결정」 에 적는다.
- `docs-audit` 의 `static_check` 는 `ADR_DIR` 인자를 받기만 하고 안내를 stderr 로 낸다(docs-check-ownership DECISION5). 그대로 옮긴다.
- `pr-review` 의 `gh-review-list` 가 `render-comments` 를 자식 프로세스로 부르던 것은 같은 폴더의 함수 import 로 바꾼다. 명령 `render-comments.ts` 도 남긴다.
- `report`, `presentation`, `docs-audit`, `implementation` 문서의 `python3 ... verify_task.py`, `overlay_paths.py` 줄은 그대로다. 그래서 `migrated_docs` 에는 `skills/pr-review/`, `skills/report/`, `skills/presentation/`, `skills/browser/` 만 더한다. pr-review 의 `evidence.md` 에 있는 `python3 -` 예시는 `node` 예시로 바꾼다.

## 작업 항목

### 1. `kit` 복사본 도구

`scripts/sync-kit.ts`, `scripts/tests/kit-copies.spec.ts` 의 복사본 대조(`<단위>/scripts/kit/<파일>` 은 `modules/kit/<파일>` 과 바이트가 같다), `runtime-policy.json` 의 `kit_sources`, `docs/code-architecture.md` 배치 표의 한 줄.

### 2. 스킬마다 구현 교체

pr-review, implementation, docs-audit, report, presentation, browser 순으로 커밋한다. 각 커밋은 명령 경계 상수를 새 파일로 바꾸고, 내부 함수 테스트를 옮기고, 옛 `.py`, `.sh`, `test_*.py` 를 지우고, 그 스킬 문서의 호출과 README 의 필요 조건을 바꾸고, `changes/` 조각을 더한다.

### 3. 저장소 정책

`runtime-policy.json` 에서 `small-skills` 줄을 지우고 `migrated_docs` 에 위 네 접두를 더한다.

## 검증

```bash
node scripts/run-tests.ts 'skills/*/tests/*.spec.ts' 'scripts/tests/*.spec.ts'
node scripts/runtime-policy.ts --pending
```

둘 다 종료 코드 0, pending 에 `small-skills` 가 없다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/pr-review/scripts/gh-host.ts` | 신규 |
| `skills/pr-review/scripts/gh-review-list.ts` | 신규 |
| `skills/pr-review/scripts/gh-review-post.ts` | 신규 |
| `skills/pr-review/scripts/render-comments.ts` | 신규 |
| `skills/implementation/scripts/pr_mergeable.ts` | 신규 |
| `skills/implementation/scripts/plan_precheck.ts` | 신규 |
| `skills/docs-audit/scripts/static_check.ts` | 신규 |
| `skills/docs-audit/scripts/run_static_check.ts` | 신규 |
| `skills/report/scripts/check-report.ts` | 신규 |
| `skills/presentation/scripts/check-deck.ts` | 신규 |
| `skills/pr-review/scripts/gh-host.sh` | 삭제 |
| `skills/pr-review/scripts/gh-review-list.sh` | 삭제 |
| `skills/pr-review/scripts/gh-review-post.sh` | 삭제 |
| `skills/pr-review/scripts/render-comments.py` | 삭제 |
| `skills/implementation/scripts/pr_mergeable.sh` | 삭제 |
| `skills/implementation/scripts/plan_precheck.py` | 삭제 |
| `skills/implementation/tests/test_pr_mergeable.py` | 삭제 |
| `skills/implementation/tests/test_plan_precheck.py` | 삭제 |
| `skills/docs-audit/scripts/static_check.py` | 삭제 |
| `skills/docs-audit/scripts/run_static_check.py` | 삭제 |
| `skills/docs-audit/tests/test_static_check.py` | 삭제 |
| `skills/docs-audit/tests/test_run_static_check.py` | 삭제 |
| `skills/report/scripts/check-report.py` | 삭제 |
| `skills/report/tests/test_check_report.py` | 삭제 |
| `skills/presentation/scripts/check-deck.py` | 삭제 |
| `skills/browser/tests/test_skill_doc.py` | 삭제 |
| `skills/implementation/scripts/kit/args.ts` | 신규 |
| `scripts/sync-kit.ts` | 신규 |
| `scripts/tests/kit-copies.spec.ts` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `docs/code-architecture.md` | 수정 |
