# Phase 01. 검사기 adr-docs.ts 와 명령 경계 테스트

**Execution profile**: standard

## 목표

plan 번들에 링크·앵커, 링크 없는 ADR 식별자, 색인, 번호 중복, 대체된 ADR 위치를 판정하고 색인을 만드는 TypeScript 검사기를 둔다. 세 검사기에 흩어진 규칙의 원본을 하나로 만든다.

**범위 외**: 스킬 문서 연결과 기존 Python 검사기 정리(phase 02), fos-skills 자기 저장소 적용(phase 03), ai-analysis 이전(다음 PR).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 설계 「검사 항목」, 「식별자 형식」, 「색인 형식」, 「인터페이스와 데이터」 가 동작을 정한다. 이 phase 는 그대로 구현한다.
- 옮겨 올 규칙의 출처:
  - 코드 블록과 코드 스팬 제거, 참조 정의 링크, URL 판정: `skills/plan/scripts/check_adr_layout.py` 의 `prose`, `LINK`, `REFERENCE`, `check`
  - 앵커 슬러그와 중복 제목 번호: `skills/docs-audit/scripts/static_check.py` 의 `slug`, `anchors_of`
  - 링크 없는 식별자, 색인 생성, 번호 중복: ai-analysis `scripts/check/check-docs.py` 의 `check`, `index_content`(읽기만 한다. 그 저장소 파일은 고치지 않는다)
  - 계획서 폴더 판정: `static_check.py` 의 `PLAN_DIR`
- 실행 규칙은 `docs/code-architecture.md` 「실행 규칙」 을 따른다. 타입 제거가 지우는 문법만 쓰고, 상대 import 에 `.ts` 를 적고, Node 내장 모듈만 쓴다. 머리 주석이 사용법, 옵션, 종료 코드를 소유한다.
- plan 은 팀으로 내보내는 스킬이다. 검사기와 테스트는 자기 폴더와 Node 내장 모듈만 import 한다(설계 DECISION9). orch 의 `tests/fixtures/` 나 testkit 을 import 하지 않는다.
- 테스트 꼴은 `skills/orch/tests/*.spec.ts` 처럼 `node:test` 와 `spawnSync` 로 임시 git 저장소에서 명령을 실행한다.

## Blocked 조건

- orch PR3(orch 스크립트 폴더 이동)이 main 에 머지되지 않았다 → `PHASE_BLOCKED: orch PR3 미머지`(스펙 DECISION7). `git log origin/main --oneline` 과 보드의 `orch-scripts-restructure` 로 확인한다.

## 의도 메모

- 오버레이를 TypeScript 로 읽지 않는다. 값은 인자다(설계 DECISION2).
- `--changed-since` 는 `git diff --name-status <ref>...HEAD` 와 `git status --porcelain -z`(미추적 포함)로 바뀐 파일과 지운·옮긴 파일을 안다. 지운 파일을 가리키는 깨진 링크는 바뀐 파일의 위반으로 친다(설계 DECISION4).
- 색인 대체 관계에는 링크 글이 아니라 대상 파일의 식별자를 적는다. 링크 글과 대상이 어긋나도 위반으로 내지 않는다.
- `write-index` 는 내용이 같으면 쓰지 않는다.
- `--index ids` 의 색인 등재 집합: `INDEX.md` 의 모든 Markdown 링크 가운데 대상이 그 ADR 폴더(하위 폴더 포함)의 ADR 파일인 것을 모아, **대상 파일 이름의 식별자**를 등재로 본다. 목록형(`- [ADR-001](001-x.md): ...`)과 표형, 링크 글이 파일 이름인 꼴(`[001-x.md](001-x.md)`)을 모두 받고 식별자 세 꼴에 같게 동작한다. 링크가 없는 등재 줄은 세지 않는다. `INDEX.md` 가 없는 폴더는 색인 검사를 건너뛴다(`static_check.py` 의 `check_index` 와 같다). 생성 모드에서 `INDEX.md` 가 없으면 `INDEX_STALE` 다.
- `check` 는 어떤 파일도 쓰지 않는다(스펙 REQ4).
- 시작할 때 `scripts/run-node-tests.ts` 의 `DEFAULT_PATTERNS` 와 `.github/workflows/ci.yml` 의 `node --test` 줄을 읽어 지금 대상 묶음을 확인한다.

## 작업 항목

### 1. `skills/plan/scripts/adr-docs.ts`

- 하위 명령 `check`, `write-index`. 옵션 `--adr-dir`(여러 번), `--flat`, `--index generated|ids`(기본 `ids`), `--changed-since <ref>`, `--scope <path>`. 사용법 오류는 stderr 와 종료 코드 2.
- 위반 줄 `경로:줄: 코드 내용`. 코드는 설계 「검사 항목」 표의 일곱 가지. `ADR_UNLINKED` 는 `→ 후보: ...` 또는 `→ 후보 없음` 을 붙인다.
- `--changed-since` 가 있으면 바뀐 파일의 위반을 먼저 내고, 나머지는 `PR 밖 위반:` 줄 뒤에 낸다. 종료 코드는 바뀐 파일의 위반만 센다.
- stderr 마지막 줄 `검사한 Markdown: N개, ADR 폴더: M개`. ADR 폴더가 없으면 그 사실을 한 줄 낸다.
- 순수 함수(슬러그, 식별자 파싱, 색인 문자열 만들기, 위반 분류)는 export 해 테스트가 직접 부를 수 있게 한다.

### 2. `skills/plan/tests/adr-docs.spec.ts`

임시 git 저장소 표본으로 명령을 실행해 stdout 줄과 종료 코드를 본다. 사례:

- `BROKEN_LINK`: 없는 파일 링크, 이미지 링크, 참조 정의. 코드 블록·코드 스팬 안 링크는 통과.
- `BROKEN_ANCHOR`: 한글 제목 앵커 통과, 중복 제목의 `-1` 통과, 퍼센트 인코딩 앵커 통과, 없는 앵커 위반.
- `ADR_UNLINKED`: 링크 글 안은 통과, 본문 맨 식별자는 위반과 후보 경로, `tasks/` 아래와 ADR 제목 줄은 통과. 두 폴더에 같은 번호가 있으면 후보 둘, 같은 폴더 후보가 앞.
- 식별자 세 꼴: `NNN-`, `ADR-M01-`, `ADR-20261007-slug` 와 같은 날 다른 슬러그 둘(중복 아님), 날짜 꼴 제목 `## ADR-20261007 / slug:` 은 제목 줄 예외.
- `ADR_DUPLICATE`: 한 폴더에 같은 번호 둘.
- `ADR_PLACEMENT`: 대체됨이 폴더 밖이면 위반, `--flat` 이면 통과.
- 색인: `write-index` 뒤 `check --index generated` 가 0, 행 하나를 고치면 `INDEX_STALE`, 두 표 분류(`superseded` 와 일부 대체 `accepted`), 빈 절 `없음`, 접두 링크 글(`[analysis-api ADR-057](...)`)의 대체 관계, 같은 내용이면 파일 mtime 이 그대로. `--index ids` 에서 등재 누락은 `INDEX_DESYNC`.
- `--changed-since`: 바뀐 파일의 위반만 종료 코드 1, 다른 파일 위반은 `PR 밖 위반:` 아래로 나오고 0. ADR 파일 이름을 바꾼 커밋 뒤 그 파일을 가리키던 바뀌지 않은 문서의 깨진 링크는 바뀐 쪽으로 센다.
- `--index ids`: 목록형·표형·파일 이름 링크 글 색인에서 누락과 남는 등재가 `INDEX_DESYNC`, `ADR-M01` 과 날짜 꼴 색인, `INDEX.md` 가 없는 폴더는 통과.
- `check` 실행 전후로 표본 저장소의 `git status --porcelain` 이 같다(본문을 고치지 않는다).
- 실패: git 밖에서 2, 모르는 옵션 2.

### 3. `tsconfig.json`, `.github/workflows/ci.yml`, `scripts/run-node-tests.ts`, 테스트 묶음을 적은 문서

- `tsconfig.json` `include` 에 `skills/plan/scripts/**/*.ts` 를 더한다.
- CI 의 `node --test` 줄과 `scripts/run-node-tests.ts` 의 기본 파일 묶음에 `skills/plan/tests/*.spec.ts` 를 더한다. testkit 실행기가 먼저 머지돼 있으면 그 실행기의 대상에 더한다.
- CI Python 루프는 `skills/plan/tests` 에 Python 테스트가 남아 있어 그대로 둔다.
- 테스트 묶음을 적은 곳에 plan 을 더한다: `README.md` 의 「orch, work-board, inbox 의 TypeScript 테스트」 문장, CI 단계 이름(`Run orch, work-board and inbox node tests` 와 그 위 타입 검사 단계 이름), `docs/code-architecture.md` 「실행 규칙」 의 테스트 명령.

## 검증

```bash
node --test skills/plan/tests/adr-docs.spec.ts
node scripts/run-node-tests.ts skills/plan/tests/adr-docs.spec.ts
python3 -m unittest discover -s skills/plan/tests
```

타입 검사는 CI 의 `tsc -p tsconfig.json` 이 본다. 로컬에 `tsc` 가 있으면 같은 명령을 돌린다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/plan/scripts/adr-docs.ts` | 신규 |
| `skills/plan/tests/adr-docs.spec.ts` | 신규 |
| `tsconfig.json` | 수정 |
| `.github/workflows/ci.yml` | 수정 |
| `scripts/run-node-tests.ts` | 수정 |
| `README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
