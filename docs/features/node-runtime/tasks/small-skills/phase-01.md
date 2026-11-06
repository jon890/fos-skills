# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

여섯 스킬의 명령이 지키는 옵션, stdout, 쓰는 파일, 종료 코드를 `node:test` 로 먼저 고정한다. 이 phase 의 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1). 스킬마다 커밋 하나다.

**범위 외**: 구현 교체, 옛 Python 테스트 삭제, 내부 함수 테스트 이전(phase-02).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `skills/<스킬>/tests/<명령>.spec.ts` 다. 파일 머리의 「명령 경계」 상수 묶음(실행 argv 앞부분)만 구현을 가린다. phase-02 는 이 묶음만 바꾸고 사례는 고치지 않는다.
- 내보내는 스킬(`implementation`, `docs-audit`, `presentation`)의 테스트는 Node 내장 모듈만 쓴다. 임시 폴더와 가짜 `gh` 는 그 테스트 파일 안에 둔다(설계 DECISION3). 내보내지 않는 스킬(`pr-review`, `report`, `browser`)은 `modules/testkit/` 을 import 한다.
- 옛 Python 테스트(`test_*.py`)는 이 phase 에서 그대로 둔다. 실행기(`scripts/run-tests.ts`)가 둘을 함께 돈다.
- 가짜 `gh`, `git` 은 PATH 앞에 둔 실행 파일이다. 외부 호스트에 닿지 않는다.

## 의도 메모

- `pr-review`, `browser` 는 지금 테스트가 없다. pr-review 는 가짜 `gh` 로 호스트 판별, 검증 거부, DRY_RUN, 등록 모드별 payload 를 본다. browser 는 문서 검사 한 파일(`skill-doc.spec.ts`)이 내용 확인이라 명령이 아니다. 같은 사례를 `.ts` 로 옮기고 옛 `test_skill_doc.py` 는 phase-02 에서 지운다.
- `plan_precheck` 의 옛 Python 테스트 사례 가운데 `patch` 로 내부 함수를 바꾸던 것은 임시 git 저장소와 `origin` 으로 명령 경계에서 본다. 임시 저장소는 `gh` 가 필요한 사례에 가짜 `gh` 를 둔다.
- `presentation` 의 전역 금지어 검사는 korean-check 의 `korean-style-check.py` 를 부른다. 테스트는 그 스킬을 `KOREAN_CHECK_DIR` 로 가리킨다.
- 줄 끝과 공백까지 같은 글자로 비교한다.

## 작업 항목

### 1. `skills/pr-review/tests/gh-review.spec.ts`

- `gh-host`: `GH_HOST` 가 있으면 그것을, 없으면 origin 주소(`git@host:`, `https://host/`, `ssh://`)에서 호스트를 낸다. 주소를 못 읽으면 1과 stderr
- `gh-review-list`: 가짜 `gh api` 응답으로 `댓글 N건` 머리, 루트·답글 구분, `--thread`, `--mine`, 모르는 옵션 1
- `gh-review-post`: 모드 다섯, 본문 검증 거부(등급 줄, `## 코드 리뷰`, 핵심 낱말, 봇 재트리거 토큰), `DRY_RUN=1` 의 출력 줄, 가짜 `gh` 가 받은 인자와 payload 바이트(AI 안내 한 번만 붙임)
- `render-comments`: JSON 파일과 인자로 같은 출력

### 2. `skills/implementation/tests/pr-mergeable.spec.ts`, `plan-precheck.spec.ts`

- `pr_mergeable`: 옛 테스트 여섯 사례와 `--tries`·`--interval` 값 없음, 모르는 옵션 2, PR 번호 없음 2
- `plan_precheck`: 임시 저장소와 bare `origin` 으로 판정 모두. 진행 가능, 완료·취소·실패 상태, 원격 브랜치 없음, 로컬에만 있는 브랜치, 구현 변경, 열린 PR, 지운 계획서, 머지된 PR, `--resume`, `--base origin/main`, 모노레포 `--tasks-dir`·`--docs-dir`, `--json` 바이트, 접두 줄임(`--ta`, `--br=`)과 모호함(`--r` 은 `--repo`, `--resume`)의 2

### 3. `skills/docs-audit/tests/static-check.spec.ts`, `run-static-check.spec.ts`

옛 두 테스트의 모든 사례를 임시 git 저장소의 명령으로 본다. 함수 사례(표 열 수, 제목 단계, 코드 펜스, PLAN_REF, LISTED_ITEMS)는 파일 하나를 쓰고 stdout 줄로 본다.

### 4. `skills/report/tests/check-report.spec.ts`

옛 테스트의 명령 사례 전부. 추가로 `--text` 의 줄 나누기와 이스케이프, 문자 참조(`&amp;`, `&#x41;`), CDATA 모드(`<script>` 안의 `<`), 속성 값 따옴표 없음·대소문자, 줄 번호를 같은 바이트로 본다.

### 5. `skills/presentation/tests/check-deck.spec.ts`

임시 덱 파일로 장 수·주석 번호·active·노트·`<script>` 개수·JS 문법·옛 하드코딩·금지어(DECK_BANNED, 전역)·`--browser`(가짜 드라이버)·사용법 오류 2·파일 없음 2.

### 6. `skills/browser/tests/skill-doc.spec.ts`

`test_skill_doc.py` 의 네 사례. 드라이버 후보 경로 사례는 `tools/browser-driver/browser_driver.py` 를 본다.

## 검증

```bash
node scripts/run-tests.ts 'skills/*/tests/*.spec.ts'
```

종료 코드 0. 옛 Python 테스트와 새 테스트가 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/pr-review/tests/gh-review.spec.ts` | 신규 |
| `skills/implementation/tests/pr-mergeable.spec.ts` | 신규 |
| `skills/implementation/tests/plan-precheck.spec.ts` | 신규 |
| `skills/docs-audit/tests/static-check.spec.ts` | 신규 |
| `skills/docs-audit/tests/run-static-check.spec.ts` | 신규 |
| `skills/report/tests/check-report.spec.ts` | 신규 |
| `skills/presentation/tests/check-deck.spec.ts` | 신규 |
| `skills/browser/tests/skill-doc.spec.ts` | 신규 |
