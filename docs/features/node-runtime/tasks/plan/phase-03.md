# Phase 03. 부르는 곳과 저장소 정책을 맞춘다

**Execution profile**: standard

## 목표

plan 의 명령을 부르는 스킬 문서와 설치 점검이 새 이름을 부르게 하고, `runtime-policy.json` 에서 `plan` 줄을 지우고 `migrated_docs` 를 넓힌다.

**범위 외**: 다른 저장소의 호출(머지 뒤 후속), 팀 저장소 반영.

## 컨텍스트

**요구사항**: REQ4, REQ7

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 호출 꼴은 `node "$SKILL_DIR/scripts/<이름>.ts"` 다(DECISION4). plan 자신의 문서(`SKILL.md`, `references/*`, `templates/phase.md`, `README.md`)와 부르는 쪽(`spec`, `technical-design`, `implementation`, `docs-audit`, `docs-consolidate`, `review-fix`)을 함께 바꾼다.
- 앞 영역이 이 호출 줄 때문에 `migrated_docs` 에 들지 못한 `implementation`, `docs-audit`, `review-fix` 를 이 PR 이 `migrated_docs` 에 넣는다. `skills/plan/` 도 넣는다.
- `scripts/test-plugin-install.ts` 가 `verify_task.py --help` 를 `python3` 로 본다. `node` 와 `verify_task.ts` 로 바꾼다. 이 점검은 `claude` 가 필요해 PR 전 로컬에서 따로 돌려 결과를 본문에 적는다.
- plan 은 호환성 변경(명령 이름)이라 major 로 올린다. `metadata.version` 과 CHANGELOG 를 PR 이 직접 올린다(ADR-023). 이 영역의 계획서는 구현을 마치면 같은 PR 에서 지운다.

## 작업 항목

### 1. 문서 호출
`python3 "$SKILL_DIR/scripts/....py"`, `bash "$SKILL_DIR/scripts/plan_number.sh"` 를 `node "$SKILL_DIR/scripts/....ts"` 로 바꾼다. `monorepo.md` 의 설명과 `docs-audit` README 의 `python3` 요구 문장도 맞춘다.

### 2. 저장소 정책과 점검
`runtime-policy.json`, `tsconfig.json`, `scripts/test-plugin-install.ts`, `docs/code-architecture.md`.

### 3. 버전과 변경 이력
`skills/plan/SKILL.md` 의 `metadata.version`, `skills/plan/CHANGELOG.md`.

## 검증

```bash
node scripts/runtime-policy.ts --pending
node scripts/run-tests.ts
git grep -nE 'python3 |bash "\$' -- skills/plan skills/spec skills/technical-design skills/implementation skills/docs-audit skills/docs-consolidate skills/review-fix
```

앞 둘은 종료 코드 0 이고 pending 에 `plan` 이 없다. `git grep` 은 일치가 없어 종료 코드 1 이다(`!` 를 붙이지 않고 결과를 눈으로 본다).

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/plan/SKILL.md` | 수정 |
| `skills/plan/README.md` | 수정 |
| `skills/plan/CHANGELOG.md` | 수정 |
| `skills/plan/references/monorepo.md` | 수정 |
| `skills/plan/references/plan-size.md` | 수정 |
| `skills/plan/references/task-create.md` | 수정 |
| `skills/plan/templates/phase.md` | 수정 |
| `skills/spec/SKILL.md` | 수정 |
| `skills/spec/references/interview.md` | 수정 |
| `skills/technical-design/SKILL.md` | 수정 |
| `skills/implementation/SKILL.md` | 수정 |
| `skills/implementation/references/executor-routing.md` | 수정 |
| `skills/implementation/references/legacy-workflow.md` | 수정 |
| `skills/docs-audit/SKILL.md` | 수정 |
| `skills/docs-audit/README.md` | 수정 |
| `skills/docs-consolidate/SKILL.md` | 수정 |
| `skills/review-fix/SKILL.md` | 수정 |
| `scripts/test-plugin-install.ts` | 수정 |
| `scripts/runtime-policy.json` | 수정 |
| `tsconfig.json` | 수정 |
| `docs/code-architecture.md` | 수정 |
