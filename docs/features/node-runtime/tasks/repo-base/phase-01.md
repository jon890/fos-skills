# Phase 01. 남은 Python·셸 파일을 추적하는 저장소 검사와 CI 구성

**Execution profile**: standard

## 목표

저장소에 Python·셸 파일과 허용하지 않은 JS 진입이 새로 생기면 파일 이름과 함께 실패하는 검사를 더하고, 영역을 옮길 때 CI 를 고치지 않아도 되게 테스트 선택을 폴더 패턴으로 바꾼다.

**범위 외**: 실제 Python·셸 파일을 옮기는 일(뒤 PR), ADR 과 문서(phase-02), `scripts/kit/`(PR2), orch 의 옛 Python 진입 삭제(orch-cli 의 옛 이름 정리 PR).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ5, REQ9. 이 PR 은 REQ1·REQ2 의 검사 장치만 만든다. 파일이 0개가 되는 것은 PR11 이다.

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md` 의 「인터페이스와 데이터」 와 「CI」

- 이 저장소의 TypeScript 규칙은 `docs/code-architecture.md` 「실행 규칙」 을 따른다. Node 내장 모듈만 쓰고, 상대 import 에 `.ts` 를 적고, 타입만 가져오면 `import type` 이다. `enum`, `namespace` 를 쓰지 않는다.
- 테스트는 `node:test` 의 `*.spec.ts` 다. `*.test.ts` 는 `claude plugin test .` 가 고르므로 쓰지 않는다(ADR-010).
- 명령의 머리 주석이 사용법과 종료 코드를 소유한다. 예: `skills/orch/scripts/heavy-slot.ts` 머리 주석.
- 이 계획은 2026-11-05 main(9af83a3) 기준으로 썼다. 인용한 경로와 줄(`bin/orch` 33줄의 `const MIN_NODE = [24, 0]`, `skills/orch/scripts/orch-doctor.py`, `ts_shim.py`, `lib/guard/gh`, `lib/guard/orca`, `.github/workflows/ci.yml` 의 단계)은 착수 때 다시 읽고 그때의 값을 쓴다.

## Blocked 조건

- 착수 때 `git fetch origin` 뒤 orch 구조 개편의 폴더 이동(orch-cli 스펙 DECISION14 의 PR3)이 `origin/main` 에 없으면(`git ls-tree -d origin/main skills/orch/scripts/` 에 명령 묶음 폴더가 없으면. 묶음 이름은 orch-cli 스펙 「명령 표」 를 본다) → `PHASE_BLOCKED: orch 폴더 이동 전` 을 내고 코디네이터에게 묻는다. 스펙 DECISION5 의 선행 조건이다.
- fos-test-speed 의 TypeScript testkit 이 `origin/main` 에 없으면 → `PHASE_BLOCKED: testkit 머지 전` 을 내고 코디네이터에게 묻는다. 이 PR 은 testkit 을 쓰지 않지만 스펙 DECISION5 가 전환 전체의 시작을 testkit 뒤로 정했다. testkit 의 위치가 문서에 없어 머지 여부를 정할 수 없으면 코디네이터에게 위치를 묻는다.

## 의도 메모

- 허용 목록 항목은 파일이 아니라 경로 접두(`skills/plan/`)다. 영역 PR 이 한 줄만 지우면 되고, 영역 안 파일 수가 바뀌어도 목록을 고치지 않는다. 그 접두 아래 위반 파일이 하나도 없으면 「낡은 항목」 으로 실패해 지우기를 잊지 않게 한다.
- 검사 로직은 명령 `scripts/runtime-policy.ts` 에 두고 테스트는 그 함수를 부른다. worker 가 남은 일을 볼 때도 같은 명령을 쓴다.
- 판정은 순수 함수(파일 경로와 첫 줄 목록 → 위반 목록)로 두고 테스트는 그 함수에 가짜 목록을 넣는다. 저장소 전체 실행은 테스트 하나만 한다(fos-test-speed 스펙 DECISION4 의 함수 주입 원칙).
- 문서 호출 검사(`migrated_docs`)는 이 PR 에서 빈 목록이다. 판정 함수와 테스트만 넣는다.

## 작업 항목

### 1. `scripts/runtime-policy.json` 신규

키 다섯을 둔다. 값의 뜻은 설계 「저장소 정책 파일」 표를 따른다.

- `pending`: `{ "area": "<영역>", "prefix": "<경로 접두>" }` 의 배열이다. 영역은 스펙 「선행 조건과 순서」 의 PR 이름을 쓴다. 착수 때 아래 2의 `classify` 로 위반 파일을 모아, 그 파일들을 덮는 가장 짧은 접두를 영역마다 적는다. 2026-11-05 기준 예상(영역 10개):
  - `scripts-githooks`: `scripts/`, `githooks/`
  - `small-skills`: `skills/pr-review/`, `skills/implementation/`, `skills/docs-audit/`, `skills/report/`, `skills/presentation/`, `skills/browser/`
  - `orch-legacy`: `skills/orch/scripts/orch-doctor.py`, `skills/orch/scripts/ts_shim.py`. orch-cli 의 옛 이름 정리 PR 이 지운다(설계 DECISION10)
  - `review-fix`: `skills/review-fix/`
  - `content-preview`: `export-only-skills/content-preview/`
  - `korean-check`: `export-only-skills/korean-check/`
  - `plan`: `skills/plan/`
  - `harness-cleanup`: `skills/harness-cleanup/`
  - `mac-cleanup`: `skills/mac-cleanup/`
  - `browser-driver`: `tools/browser-driver/`
  - 위 목록에 없는 위반 파일이 나오면 가장 가까운 영역에 넣고 PR 본문에 적는다.
- `legacy`: 빈 배열. 옛 이름 진입(node shebang 의 JS)의 경로를 담는다.
- `entry_js`: 지금 있는 JS 진입. `bin/orch`, `extensions/work-board/hooks/event-tags.js`, `extensions/work-board/hooks/register.js`, `skills/orch/scripts/lib/guard/gh`, `skills/orch/scripts/lib/guard/orca`. 착수 때 2의 분류로 다시 모아 맞춘다.
- `migrated_docs`: 빈 배열. 영역의 경로 접두를 담는다.
- `min_node`: `[24, 0]`. 진입들이 보는 최소 Node 버전의 원본이다(설계 DECISION11).

### 2. `scripts/runtime-policy.ts` 신규

첫 줄 `#!/usr/bin/env node`, 실행 권한. 머리 주석에 사용법, 판정, 출력 줄, 종료 코드를 적는다.

- `classify(path: string, firstLine: string): 'python' | 'shell' | 'js-entry' | null`
  - 확장자가 `.ts` 면 shebang 과 상관없이 `null` 이다.
  - 첫 줄이 `#!` 이면 해석기가 먼저다. 해석기는 `#!` 뒤 첫 낱말이고, 그것이 `env` 로 끝나면 `-S` 와 `-` 로 시작하는 낱말을 건너뛴 다음 낱말이다. 해석기 이름(경로의 마지막 조각)이 `python` 으로 시작하면 `python`, `sh`, `bash`, `zsh` 이면 `shell`, `node` 면 `js-entry` 다. 그 밖의 해석기는 확장자로 넘어간다.
  - shebang 이 없으면 확장자로 정한다: `.py` 는 `python`, `.sh`, `.bash`, `.zsh` 는 `shell`, `.js`, `.mjs`, `.cjs` 는 `js-entry`, 나머지는 `null`.
  - 그래서 node shebang 을 가진 `korean-style-check.py` 는 `js-entry` 이고, python3 shebang 이나 shebang 없는 `.py` 는 `python` 이다.
- `checkPolicy(policy, files: { path: string, firstLine: string }[]): string[]` 가 위반 줄을 낸다.
  - `python`, `shell` 파일이 어느 `pending` 접두로도 시작하지 않으면 `NEW <경로> <종류>`
  - `js-entry` 파일이 `entry_js` 에도 `legacy` 에도 없으면 `NEW <경로> js-entry`
  - `pending` 항목의 접두 아래 `python`, `shell` 파일이 없으면 `STALE pending <영역> <접두>`
  - `entry_js`, `legacy` 의 경로가 파일 목록에 없거나 `js-entry` 로 분류되지 않으면 `STALE <키> <경로>`. 진짜 Python 파일을 `legacy` 에 적으면 이 줄로 걸린다.
- `checkMinNode(min: [number, number], sources: { path: string, text: string }[]): string[]`: 줄 머리에 고정한 `^const MIN_NODE = \[(\d+), (\d+)\]`(m 플래그)를 찾아 값이 `min` 과 다르면 `MIN-NODE <경로>:<줄> <값>` 을 낸다. 명령은 `js-entry` 파일과, `/tests/` 아래가 아닌 `.ts` 만 `sources` 로 넘긴다. 그래야 테스트 안의 사례 문자열이 저장소 검사에 잡히지 않는다.
- `checkDocs(prefixes: string[], docs: { path: string, text: string }[]): string[]`: 접두 아래 `.md`(`CHANGELOG.md` 와 `changes/` 아래는 뺀다)의 각 줄에서, 줄 머리나 공백, 백틱 바로 뒤에 오는 `python3 ` 이나 `bash "$SKILL_DIR/<경로>.sh` 꼴을 찾아 `DOC <경로>:<줄> <줄 내용>` 을 낸다.
- 명령으로 실행하면 저장소 루트(`git rev-parse --show-toplevel`)에서 `git ls-files -z` 로 추적 파일을 읽어 위 세 함수를 돌린다. 추적되지만 작업 트리에 없는 파일(지웠지만 아직 커밋하지 않은 것)은 목록에서 뺀다.
  - 위반이 없으면 `OK pending <영역 수>` 한 줄과 종료 코드 0
  - 위반이 있으면 위반 줄들과 종료 코드 1
  - 정책 파일을 읽지 못하거나 형식이 틀리면 stderr 에 이유와 종료 코드 2
  - `--pending` 을 주면 영역마다 `PENDING <영역> <남은 파일 수>` 줄을 더 낸다.
- 함수는 `export` 하고, 명령 실행은 `import.meta.main` 일 때만 한다(Node 24 와 `@types/node` 24 가 지원한다). 테스트가 import 해도 저장소를 훑지 않게 하려는 것이다.

### 3. `scripts/tests/runtime-policy.spec.ts` 신규

- `classify` 의 분류 사례: shebang 없는 `.py`, python3 shebang 의 확장자 없는 파일, `#!/usr/bin/env -S bash -e` 꼴, `.sh`, `#!/usr/bin/env -S node --x` 의 확장자 없는 파일, node shebang 의 `.py`(js-entry), shebang 이 있는 `.ts`(null), `.md`(null).
- `checkPolicy` 사례:
  - pending 접두 밖의 새 `.py` → `NEW docs/probe.py python`
  - pending 접두 안의 `.py` → 위반 없음
  - 위반 파일이 없는 pending 접두 → `STALE pending ...`
  - `entry_js` 에 없는 `.mjs` → `NEW ... js-entry`
  - `legacy` 에 적은 node shebang `.py` → 위반 없음
  - `legacy` 에 적은 python3 shebang `.py` → `STALE legacy ...`
  - 목록에 없는 경로의 `entry_js` 항목 → `STALE entry_js ...`
- `checkMinNode` 사례: 같은 값이면 위반 없음, `[22, 0]` 이면 `MIN-NODE` 줄, 줄 머리가 아닌 곳(주석 안)의 같은 글자는 잡지 않는다.
- `checkDocs` 사례: 접두 안 `SKILL.md` 의 `python3 "$SKILL_DIR/scripts/x.py"` 줄과, 백틱으로 감싼 `bash "$SKILL_DIR/scripts/x.sh"` 줄이 각각 잡힌다. 같은 접두의 `CHANGELOG.md`, `changes/a.patch.md` 와 접두 밖 파일은 잡히지 않는다.
- 저장소 전체: 자식 프로세스로 `node scripts/runtime-policy.ts` 를 저장소 루트에서 한 번 돌린다. 단언은 종료 코드 0 과 `OK pending` 줄이고, 단언 메시지에 자식의 stdout 과 stderr 를 그대로 넣는다. 그래야 실패할 때 어느 파일이 걸렸는지 테스트 출력에 보인다.

### 4. `skills/orch/tests/legacy-entrypoints.spec.ts` 삭제

orch 의 `.py`, `.sh` 를 따로 막던 테스트다. 같은 사실을 `runtime-policy.spec.ts` 가 저장소 전체로 소유하므로 지운다. 두 사례가 새 검사에 남는다: `skills/orch/scripts` 의 `.py` 는 `orch-legacy` 의 두 파일만 허용되고, `extensions/work-board/bin` 의 `.py`, `.sh` 는 pending 접두가 없어 `NEW` 로 걸린다.

### 5. `scripts/run-node-tests.ts` 수정

파일이 있으면 `DEFAULT_PATTERNS` 를 아래 6 의 다섯 패턴으로 바꾸고, 그 위 주석(「새 묶음을 더하면 여기와 CI 의 node 테스트 명령을 함께 고친다」)을 「CI 와 같은 폴더 패턴이라 영역을 옮겨도 고치지 않는다」 로 바꾼다. fos-test-speed 가 이 파일을 이미 지웠으면 이 항목을 건너뛰고 변경 파일 표에서 뺀다.
`.orch/overlay.md` 7줄은 이 실행기를 인자 없이 부르므로 고치지 않는다.

### 6. `.github/workflows/ci.yml` 수정

- `Plugin tests` job 의 node 테스트 단계: 패턴을 `"scripts/tests/*.spec.ts" "skills/*/tests/*.spec.ts" "export-only-skills/*/tests/*.spec.ts" "tools/*/tests/*.spec.ts" "extensions/*/tests/*.spec.ts"` 다섯으로 바꾼다. 다른 옵션(`--test-concurrency`, `NODE_COMPILE_CACHE`)은 그대로 둔다. 단계 이름과 주석의 「orch, work-board and inbox」 를 저장소 전체를 뜻하는 말로 바꾼다. 맞는 파일이 없는 패턴은 node 가 건너뛴다(2026-11-05 실험, Node 24.22).
- 타입 검사 단계는 그대로 둔다. `tsconfig.json` 의 `scripts/**/*.ts` 가 새 파일을 이미 덮는다.
- `Python tests` job 의 루프: 이름 목록으로 건너뛰던 `if` 를 지우고, 폴더에 `test_*.py` 가 없으면 `skip <폴더> (no test_*.py)` 를 찍고 건너뛰게 바꾼다(`compgen -G "$suite/test_*.py" > /dev/null` 이 실패하면 `echo` 뒤 `continue`). 주석도 그 이유(옮긴 폴더에는 Python 테스트가 없고, 빈 폴더에서 unittest 는 종료 코드 5 로 실패한다)로 고친다. 찍는 줄이 있어야 CI 로그로 새 규칙이 돌았는지 보인다.

## 검증

```bash
node --test scripts/tests/runtime-policy.spec.ts
node scripts/runtime-policy.ts --pending
node scripts/run-node-tests.ts --background
npm install --no-save --no-audit --no-fund --prefix "$TMPDIR/tsc" typescript@5.9.3 @types/node@24 && "$TMPDIR/tsc/node_modules/.bin/tsc" -p tsconfig.json --typeRoots "$TMPDIR/tsc/node_modules/@types"
bash -c 'for suite in scripts/tests skills/*/tests export-only-skills/*/tests tools/*/tests; do compgen -G "$suite/test_*.py" > /dev/null || { echo "skip $suite (no test_*.py)"; continue; }; python3 -m unittest discover -s "$suite" || exit 1; done'
```

- 첫 줄: 위 3 의 사례가 모두 통과한다.
- 둘째 줄: 종료 코드 0, `OK pending 10` 과 영역별 `PENDING` 줄. 영역 수는 1 에서 실제로 적은 수다.
- 셋째 줄: 실행기를 띄우고 출력된 `--wait` 명령을 끝 줄이 나올 때까지 다시 부른다. 요약에 `scripts/tests/runtime-policy.spec.ts` 가 들어 있고 실패가 0 이다. 실행기를 fos-test-speed 가 지웠으면 그 PR 이 정한 로컬 실행 명령을 쓴다. 한 줄 `node --test` 는 신호 테스트가 실행기를 끝낼 수 있어 쓰지 않는다(README 「기여」).
- 넷째 줄: CI 와 같은 타입 검사가 종료 코드 0 이다. 망이 없어 설치가 실패하면 PR 의 CI 결과로 대신하고 PR 본문에 적는다.
- 다섯째 줄: `skills/orch/tests`, `skills/inbox/tests` 가 `skip` 줄로 나오고 나머지 Python 묶음이 통과한다. 이 줄은 CI 루프를 옮겨 적은 것이라 ci.yml 자체의 확인은 인수 검증 계획의 CI 행이 한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/runtime-policy.json` | 신규 |
| `scripts/runtime-policy.ts` | 신규 |
| `scripts/tests/runtime-policy.spec.ts` | 신규 |
| `skills/orch/tests/legacy-entrypoints.spec.ts` | 삭제 |
| `scripts/run-node-tests.ts` | 수정 |
| `.github/workflows/ci.yml` | 수정 |
