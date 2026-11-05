# Phase 02. 문서의 경로를 새 배치로 맞추고 옛 배치 경로가 남지 않는지 본다

**Execution profile**: standard

## 목표

저장소 안에서 orch 스크립트를 옛 배치(`scripts/<파일>.ts`)로 가리키는 곳을 새 배치로 바꾸고, 다시 생기지 않게 테스트로 막는다.

**범위 외**: 다른 저장소의 직접 경로(스펙 부록, 코디네이터가 고친다), 기록 문서(ADR, 기능 문서, 변경 이력), 판정 규칙.

## 컨텍스트

**요구사항**: REQ9

**근거 문서**: `docs/features/orch-cli/spec.md`(REQ9, DECISION17), `docs/features/orch-cli/design.md`(REQ9 행)

- 이 phase 는 phase-01 커밋 뒤에 한다. 스크립트가 이미 `skills/orch/scripts/<묶음>/` 에 있다.
- 기록 문서는 그때의 배치를 적은 것이라 고치지 않는다. `docs/adr/`, `docs/features/`(다른 기능의 계획은 PR3 뒤 경로 표를 스스로 갖고 있다. 예: `docs/features/limit-resume/tasks/resume-command/phase-01.md` 「스크립트 폴더」), `**/CHANGELOG.md`, `**/changes/`.
- 검색 명령과 결과(2026-11-06, phase-01 전):

```bash
NAMES=$(cd skills/orch/scripts && ls *.ts | sed 's/\.ts$//' | paste -sd'|' -)
git grep -nE "scripts/($NAMES)\.ts" -- '*.md' '*.js' '*.ts' '*.json' ':!docs/adr' ':!docs/features' ':!**/CHANGELOG.md' ':!**/changes/**' ':!**/tests/**'
```

| 파일 | 자리 |
| --- | --- |
| `docs/code-architecture.md` | 「배치」 코드 블록의 `skills/orch/scripts/<명령>.ts`, `skills/orch/scripts/orch-loop.ts` |
| `skills/orch/references/hooks.md` | `scripts/orch-loop.ts`, `scripts/migrate-orch-dir.ts` |
| `skills/orch/references/overlay.md` | `scripts/spec-lint.ts`, `scripts/orch_paths.ts` |
| `skills/orch/references/waiting.md` | `scripts/wait-important.ts`, `scripts/triage-messages.ts` |
| `extensions/work-board/bin/merge-queue.ts`, `extensions/work-board/hooks/register.js` | 주석의 `skills/orch/scripts/orch-loop.ts` |
| 옮긴 스크립트와 lib 의 머리 주석 | 다른 스크립트를 `scripts/<파일>.ts` 로 적은 곳(phase-01 뒤 같은 검색으로 다시 찾는다) |

## 의도 메모

- 파일 이름만 적은 산문(「`cleanup-sweep.ts` 의 …」)은 이름이 그대로라 바꾸지 않는다.
- 검사는 테스트로 둔다. doctor 의 `DIRECT-PATH` 는 다른 저장소의 호출을 보고, 이 검사는 이 저장소의 경로가 실제 파일을 가리키는지 본다. 둘의 대상이 다르다.

## 작업 항목

### 1. 문서와 주석의 경로

위 표의 자리를 `scripts/<묶음>/<파일>.ts` 로 바꾼다. `docs/code-architecture.md` 「배치」 는 `skills/orch/scripts/<묶음>/<명령>.ts` 한 줄과 `orch-doctor.py`·`ts_shim.py` 가 `scripts/` 바로 아래에 남는다는 줄로 쓴다.

### 2. `skills/orch/tests/script-folders.spec.ts`(신규)

- 명령 표의 모든 행이 `<묶음>/<파일>` 이고 그 파일이 있다. 폴더 이름이 행의 `group` 과 같다.
- `skills/orch/scripts` 바로 아래에 `.ts` 파일이 없고, 폴더는 명령 표의 묶음, `lib`, `handlers` 뿐이다.
- `git ls-files` 의 텍스트 파일(기록 문서, `tests/` 아래 파일 제외)에서 `scripts/<옛 파일 이름>.ts` 꼴이 0건이다. 이름 목록은 명령 표의 `script` 에서 파일 이름만 뗀 것이다. `orch-compat` 표지가 그 줄이나 윗줄에 있으면 센다에서 뺀다(doctor 와 같은 표지).
- 옮긴 스크립트가 자기 위치 기준 상대경로로 적은 파일(`${HERE}/…`, `resolve(HERE, '…')`, `new URL('…', import.meta.url)`, `'../../…'` 꼴의 정적 import)이 모두 있다. 묶음이 달라 깨지는 경로와 다른 스킬 파일(`review_threads.py`)은 테스트가 환경 변수로 덮어 실행으로는 드러나지 않기 때문이다.
- 실패하면 `<파일>:<줄>` 목록을 낸다.
- 옛 배치를 설명해야 하는 머리 주석(doctor 의 「루프 번들 판정」 처럼 옛 번들의 경로 꼴을 적은 곳)은 지우지 않고 `orch-compat` 표지를 단다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/script-folders.spec.ts
node scripts/run-tests.ts
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `docs/code-architecture.md` | 수정 |
| `skills/orch/references/hooks.md` | 수정 |
| `skills/orch/references/overlay.md` | 수정 |
| `skills/orch/references/waiting.md` | 수정 |
| `extensions/work-board/bin/merge-queue.ts` | 수정 |
| `extensions/work-board/hooks/register.js` | 수정 |
| `skills/orch/scripts/*/*.ts` | 수정 |
| `skills/orch/tests/script-folders.spec.ts` | 신규 |
| `skills/orch/changes/script-folders.minor.md` | 신규 |
