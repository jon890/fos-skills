# Phase 02. 네 스킬 연결과 기존 검사기 정리

**Execution profile**: standard

## 목표

spec, technical-design, review-fix, docs-audit 가 phase 01 의 검사기를 부르고, 같은 규칙을 갖던 `check_adr_layout.py` 를 지우고 `static_check.py` 에서 링크·색인 검사를 뺀다.

**범위 외**: fos-skills 자기 저장소의 위반 수정과 색인 재생성(phase 03).

## 컨텍스트

**요구사항**: REQ4, REQ5

**근거 문서**: `docs/features/docs-check-ownership/spec.md`, `docs/features/docs-check-ownership/design.md`

- 바꿀 자리 목록은 설계 「옛 호출 자리」 표가 소유한다. 시작할 때 아래 명령으로 목록을 다시 맞춘다.
- 스킬마다 부르는 때와 쓰기 여부는 설계 「스킬 연결」 표다. spec·technical-design·review-fix 는 `--changed-since <base>`, docs-audit 는 `--scope <감사 범위>` 로 부른다.
- 인자 값은 루트 plan 오버레이의 「ADR 폴더」, 「ADR 색인 생성」, 「ADR 대체 배치」 다(설계 DECISION8). 새 두 값을 `skills/plan/references/monorepo.md` 「오버레이가 지정하는 경로 값」 표에 더한다.
- 버전: plan 은 major 로 직접 올린다(`metadata.version` 6.0.0, CHANGELOG 의 새 절과 이전 5.x 를 `## 5.x` 한 절로 줄이기, `호환성:` 항목에 지운 `check_adr_layout.py` 와 새 명령). docs-audit, spec, technical-design, review-fix 는 `changes/docs-check-ownership.minor.md` 조각(설계 DECISION6, README 「버전과 변경 이력」).
- 명령의 값:
  - `BASE`: orch 지시서의 base 브랜치(`origin/<base>`). 지시서가 없으면 `origin/HEAD` 가 가리키는 기본 브랜치(`git symbolic-ref --short refs/remotes/origin/HEAD`). `--changed-since` 는 `BASE...HEAD` 와 작업 트리 변경을 본다.
  - ADR 인자: 대상 저장소 **루트**의 `.claude/plan-overlay.md` 표에서 「ADR 폴더」(인라인 코드 하나마다 `--adr-dir`), 「ADR 색인 생성」(「한다」 면 `--index generated`), 「ADR 대체 배치」(「폴더 없음」 이면 `--flat`)를 읽는다. 하위 프로젝트 오버레이에서는 읽지 않는다(설계 DECISION8). 없으면 넘기지 않는다(기본값).
  - 문서에 적을 명령의 꼴: `node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check --changed-since "$BASE" $ADR_ARGS`. `$ADR_ARGS` 는 위 세 값에서 만든 인자다. technical-design 의 쓰기는 `node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" write-index $ADR_DIRS`.
- `static_check.py` 의 첫 인자 `ADR_DIR` 은 받고 쓰지 않으며 stderr 에 한 줄 안내한다(설계 DECISION5). 종료 코드와 남은 검사의 출력은 그대로다.

## 작업 항목

### 1. `skills/plan/scripts/check_adr_layout.py` 와 `skills/plan/tests/test_check_adr_layout.py` 삭제

### 2. `skills/docs-audit/scripts/static_check.py` 와 테스트

- `check_index`, `check_links` 와 그것만 쓰는 `slug`, `anchors_of`, `links_of`, `is_local`, `ADR_*` 정규식을 지운다. 머리 주석의 사용법을 고친다.
- `skills/docs-audit/tests/test_static_check.py` 에서 지운 검사의 사례를 지우고, `ADR_DIR` 을 줘도 종료 코드와 남은 검사 출력이 같고 stderr 에 안내가 나오는 사례를 더한다.

### 3. 스킬 문서

- `skills/spec/SKILL.md` 4·5단계: `run_doc_checks.py` 옆에 `node "$PLAN_SKILL_DIR/scripts/adr-docs.ts" check --changed-since "$BASE" ...`. 통과 조건 표에 종료 코드 0.
- `skills/technical-design/SKILL.md` 6단계와 `references/adr-rules.md` 「대체한 뒤 검사」: ADR 을 바꿨으면 생성 저장소에서 `write-index`, 그다음 `check`. `check_adr_layout.py` 두 명령을 지운다. 「구조」 의 색인 문장과 `references/adr-parallel.md` 「INDEX.md」 에 생성을 켠 저장소는 `write-index` 를 돌리고 행을 직접 고치지 않는다는 줄(설계 DECISION10). `adr-parallel.md` 「색인 일치 테스트」 절은 저장소마다 테스트를 두지 말고 `adr-docs.ts check` 가 대신한다고 고친다(스펙 DECISION5).
- `skills/review-fix/SKILL.md` 5단계: 검사 명령, ADR 을 고친 지적은 `write-index` 결과를 그 커밋에 접는다. `references/finish.md` 결과 보고에 「PR 밖 위반」 자리.
- `skills/docs-audit/README.md`: 정적 검사가 「ADR Index 동기화」, 「깨진 링크와 앵커」 를 한다는 설명을 `adr-docs.ts` 로 옮긴다.
- `skills/docs-audit/SKILL.md` 1·2·3·5단계와 단계 표: ADR 디렉터리를 plan 오버레이에서 읽고, 2단계에 `adr-docs.ts check --scope`, 통과 조건에 그 결과, 3단계 「구조 무결성」 출처.
- `skills/plan/references/monorepo.md`: 경로 값 표의 `ADR 대체 배치` 인자를 `adr-docs.ts --flat` 으로, 새 행 둘.
- `docs/features/node-runtime/tasks/repo-base/phase-02.md` 의 `check_adr_layout.py` 검증 줄, `docs/features/node-runtime/spec.md` 「선행 조건과 순서」 에 영역 3·7 이 지운 검사기를 옮기지 않는다는 한 줄.
- `docs/code-architecture.md`: plan 번들의 `.ts` 와 `tsconfig.json` 범위.
- node-runtime 저장소 기반 PR 이 먼저 머지돼 `scripts/runtime-policy.json` 이 있으면 `pending` 에서 지운 두 파일을 뺀다.

### 4. 문서 계약 테스트

- `skills/plan/tests/test_technical_design_contract.py` 꼴로, 네 스킬 문서가 `adr-docs.ts` 를 부르고 `check_adr_layout` 을 부르는 문서가 없음을 본다. 기존 계약 테스트 파일에 사례를 더하거나 같은 폴더에 새 파일을 둔다.

### 5. 변경 조각과 버전

- `skills/plan/SKILL.md` `metadata.version`, `skills/plan/CHANGELOG.md`.
- `skills/{docs-audit,spec,technical-design,review-fix}/changes/docs-check-ownership.minor.md`.

## 검증

```bash
! git grep -n "check_adr_layout" -- . ':!*CHANGELOG.md' ':!docs/features/docs-check-ownership' ':!skills/docs-audit/tests/test_static_check.py' ':!skills/plan/tests/test_technical_design_contract.py'
python3 -m unittest discover -s skills/plan/tests
python3 -m unittest discover -s skills/docs-audit/tests
python3 -m unittest discover -s scripts/tests
node --test skills/plan/tests/adr-docs.spec.ts
for f in skills/spec/SKILL.md skills/technical-design/SKILL.md skills/technical-design/references/adr-rules.md skills/technical-design/references/adr-parallel.md skills/review-fix/SKILL.md skills/review-fix/references/finish.md skills/docs-audit/SKILL.md skills/docs-audit/README.md skills/plan/references/monorepo.md skills/plan/CHANGELOG.md docs/code-architecture.md skills/*/changes/docs-check-ownership.minor.md; do python3 export-only-skills/korean-check/scripts/korean-style-check.py "$f" || exit 1; done
```

첫 줄은 `git grep` 결과가 없을 때 통과한다.

머지 전 확인(코디네이터 몫): node-runtime 의 `team-export` 브랜치(node-runtime 스펙 DECISION10)가 아직 없으면, 이 PR 머지 직전 main 에서 만들지 정한다. 팀으로 내보내는 plan·spec·docs-audit·review-fix 가 팀에서 돌지 않는 `adr-docs.ts` 를 부르게 되기 때문이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/plan/scripts/check_adr_layout.py` | 삭제 |
| `skills/plan/tests/test_check_adr_layout.py` | 삭제 |
| `skills/docs-audit/scripts/static_check.py` | 수정 |
| `skills/docs-audit/tests/test_static_check.py` | 수정 |
| `skills/docs-audit/SKILL.md` | 수정 |
| `skills/docs-audit/README.md` | 수정 |
| `skills/spec/SKILL.md` | 수정 |
| `skills/technical-design/SKILL.md` | 수정 |
| `skills/technical-design/references/adr-rules.md` | 수정 |
| `skills/technical-design/references/adr-parallel.md` | 수정 |
| `skills/review-fix/SKILL.md` | 수정 |
| `skills/review-fix/references/finish.md` | 수정 |
| `skills/plan/references/monorepo.md` | 수정 |
| `skills/plan/SKILL.md` | 수정 |
| `skills/plan/CHANGELOG.md` | 수정 |
| `skills/plan/tests/test_technical_design_contract.py` | 수정 |
| `skills/docs-audit/changes/docs-check-ownership.minor.md` | 신규 |
| `skills/spec/changes/docs-check-ownership.minor.md` | 신규 |
| `skills/technical-design/changes/docs-check-ownership.minor.md` | 신규 |
| `skills/review-fix/changes/docs-check-ownership.minor.md` | 신규 |
| `docs/features/node-runtime/tasks/repo-base/phase-02.md` | 수정 |
| `docs/features/node-runtime/spec.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
