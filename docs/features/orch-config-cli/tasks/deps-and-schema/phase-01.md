# Phase 01. 플러그인 npm 의존 설치 기반

**Execution profile**: standard

## 목표

저장소 루트에 `package.json` 과 `package-lock.json` 을 두어 zod 를 의존으로 들이고, 저장소 검사·테스트 실행기·CI 가 그 의존을 다룰 수 있게 한다. 사용자 머신의 설치는 Claude Code 의 플러그인 의존 설치가 맡는다.

**범위 외**: zod 를 import 하는 코드(phase 03), `.orch/overlay.md` 「로컬 검증」 고침(코디네이터가 따로 반영한다. 사용자가 고치는 중인 줄과 겹친다).

## 컨텍스트

**요구사항**: REQ6

**근거 문서**: `docs/features/orch-config-cli/design.md` 「zod 와 의존 설치」, `docs/adr/030-plugin-npm-dependencies.md`, `docs/code-architecture.md` 「저장소 실행 규칙」

- Claude Code 는 플러그인을 캐시에 복사할 때 루트의 `package.json` 과 `package-lock.json` 으로 의존을 설치한다(`--ignore-scripts`, 정확한 버전만, 60초 제한). `pnpm-lock.yaml` 은 건너뛰므로 npm 을 쓴다.
- 루트 `package.json` 의 `"type": "module"` 은 CommonJS 로 쓴 세 진입을 ES 모듈로 읽게 해 깨뜨린다. `bin/orch`(`require`, `__dirname`), `skills/orch/scripts/lib/guard/gh`, `skills/orch/scripts/lib/guard/orca` 다. `bin/` 에는 `orch` 하나뿐이라 `{"type": "commonjs"}` 만 담은 `bin/package.json` 을 둔다. `skills/orch/scripts/lib/guard/` 에는 ES 모듈 `guard.ts` 가 함께 있어 폴더 단위 `type` 을 쓰면 `guard.ts` 가 깨진다. 그래서 shim `gh`·`orca` 를 `githooks/commit-msg` 처럼 `type` 과 상관없이 도는 꼴로 고친다. `extensions/work-board/hooks/*.js` 넷은 이미 ES 모듈이다. korean-check 의 옛 이름 진입 둘(`korean-style-check.py`, `check-readability.py`)은 확장자 `.py` 라 `type: module` 범위의 ESM 로더가 실행하지 못하고(`ERR_UNKNOWN_FILE_EXTENSION`), 같은 폴더의 `.ts` 때문에 폴더 단위 `type` 도 줄 수 없다. 그래서 작업 항목 9 로 지운다(사용자 2026-11-13).
- `scripts/runtime-policy.ts` 는 저장소 실행 규칙을 지키는 검사기다. 머리 주석이 판정과 출력 줄을 소유한다. 대상 파일은 git 이 추적하거나 무시하지 않는 파일이라 `.gitignore` 의 `/node_modules/` 는 저절로 빠진다.
- 지금 저장소의 bare import(상대 경로도 `node:` 도 아닌 import)는 `extensions/work-board/tests/*.test.ts` 넷의 `claude-code/testing` 뿐이다.
- `scripts/run-tests.ts` 머리 주석 14-17행은 「package.json 과 node_modules 를 두지 않는다」 를 근거로 TypeScript 를 저장소 밖에 설치한다. tsc 는 그대로 저장소 밖에서 받되, 주석의 근거를 고친다. tsc 는 `moduleResolution: bundler` 라 루트 `node_modules/zod` 를 찾는다.
- worker 워크트리는 `<주 checkout>/worktrees/` 아래 있어(`skills/orch/scripts/worker/make-worktree.ts`), 설치가 없으면 Node 가 주 checkout 의 `node_modules` 를 찾는다. 그래서 실행기는 있는지가 아니라 lock 과 맞는지를 본다.

## 의도 메모

- `"type"` 을 빼면 `.ts` 를 돌릴 때마다 `MODULE_TYPELESS_PACKAGE_JSON` 경고가 나와 쓰지 않는다.
- 세 CommonJS 진입을 ES 모듈로 고치지 않는 것은 `bin/orch` 가 낮은 Node 에서 버전 부족을 알리는 동작을 지키려는 것이다.
- `node_modules` 를 커밋하거나 빌드하지 않는다(ADR-030 의 기각 대안).

## 작업 항목

### 1. 루트 `package.json`, `package-lock.json`, `.gitignore`

- `package.json`: `{"name": "fos-skills", "private": true, "type": "module", "dependencies": {"zod": "4.6.7"}}`. 버전 범위 기호(`^`, `~`)를 쓰지 않는다.
- `npm install --package-lock-only --ignore-scripts` 로 `package-lock.json` 을 만들고 `npm ci --ignore-scripts` 로 설치한다.
- `.gitignore` 에 `/node_modules/` 를 더한다.

### 2. CommonJS 진입

- `bin/package.json` 을 `{"type": "commonjs"}` 한 줄로 만든다.
- `skills/orch/scripts/lib/guard/gh` 와 `orca` 의 `require('node:path')`, `require('node:url')`, `__dirname` 을 `process.getBuiltinModule('node:path')`, `process.getBuiltinModule('node:url')`, `dirname(realpathSync(process.argv[1]))`(`node:fs` 도 같은 꼴로 얻는다)로 바꾼다. `'use strict'` 줄은 뺀다. 머리 주석의 「node 가 CommonJS 로 읽고」 를 「위쪽 package.json 의 type 에 따라 CommonJS 로도 ESM 으로도 읽히므로 require, __dirname 대신 process.getBuiltinModule 과 process.argv[1] 을 쓴다」 로 고친다. 꼴은 `githooks/commit-msg` 1-18행이다.
- `scripts/runtime-policy.json` 의 `entry_js` 는 그대로다.

### 3. `scripts/runtime-policy.ts` 와 `scripts/runtime-policy.json` 의 두 규칙

- `package.json` 자리: 대상 파일 가운데 이름이 `package.json` 인 것은 루트 하나만 `dependencies` 를 가질 수 있다. 루트 밖의 것은 키가 `type` 하나뿐이어야 한다. 어기면 `PACKAGE <경로> <이유>` 줄이다.
- bare import: `.ts`·`.mts`·`.cts`·`.js`·`.mjs`·`.cjs` 와 `entry_js` 의 확장자 없는 진입에서 import·export from·부수 효과 import·동적 import·`require` 의 specifier 를 읽는다(`scripts/tests/exported-imports.spec.ts` 의 `SPECIFIER_PATTERNS` 꼴). `.` 이나 `/` 나 `node:` 로 시작하지 않는 specifier 는 정책 파일의 새 키 `bare_imports` 에 맞는 짝이 있어야 한다. 없으면 `IMPORT <경로>:<줄> <specifier>` 줄이다. 테스트 안의 문자열 표본이 걸리지 않게, 줄 머리의 import·export 문과 `import(`·`require(` 호출만 본다.
- `bare_imports` 는 `{ "path": <저장소 상대 경로나 glob>, "name": <specifier> }` 배열이다. 이 phase 는 `{ "path": "extensions/work-board/tests/*.test.ts", "name": "claude-code/testing" }` 하나를 둔다. `name` 이 루트 `package.json` 의 `dependencies` 에도, `claude-code/` 로 시작하는 플러그인 테스트 모듈에도 없으면 형식 오류(종료 코드 2)다.
- 머리 주석의 「정책 파일의 키」 와 「출력 줄」 에 두 규칙을 더한다.

### 4. `scripts/tests/runtime-policy.spec.ts`

- 루트 밖 `package.json` 이 `type` 만 담으면 통과, `dependencies` 를 담으면 `PACKAGE` 줄.
- 허용 목록 밖의 `import { z } from 'zod'` 는 `IMPORT` 줄, 허용 목록의 짝은 통과. 문자열 안의 `'from x'` 는 걸리지 않는다.
- 이 저장소 그대로 `node scripts/runtime-policy.ts` 가 종료 코드 0 이다(이미 있는 「저장소 전체」 테스트가 있으면 그것).

### 5. `scripts/run-tests.ts` 의 설치 확인

- 인자 풀이 뒤, 테스트와 tsc 를 돌기 전에 저장소 루트의 `package-lock.json` 이 있으면 `node_modules/.package-lock.json` 을 읽어 `packages` 의 각 `node_modules/<이름>` 의 `version` 이 `package-lock.json` 의 같은 항목과 같은지 본다. 없거나 다르면 stderr 에 `run-tests: 의존 설치가 lock 과 다르다(<이름>). 저장소 루트에서 npm ci 를 돈다` 를 내고 종료 코드 2 로 끝난다. `--wait` 는 이 확인을 하지 않는다.
- 저장소 루트는 지금 실행기가 쓰는 루트(워크트리면 그 워크트리)다. 주 checkout 을 찾아 올라가지 않는다.
- 머리 주석의 tsc 단락 근거와 종료 코드 2 의 뜻에 이 확인을 더한다.

### 6. `scripts/tests/run-tests.spec.ts`

임시 저장소에 `package-lock.json` 만 있고 `node_modules` 가 없을 때, 버전이 다를 때 종료 코드 2 와 안내가 나오고, 같을 때 다음 단계로 가는지 본다. 지금 테스트가 임시 저장소를 만드는 꼴을 따른다.

### 7. `.github/workflows/ci.yml` 과 `scripts/tests/ci-workflow.spec.ts`

- `Run plugin tests from repository root` 단계 앞에 `- name: Install npm dependencies` / `run: npm ci --ignore-scripts` 단계를 둔다. 테스트 실행기 단계는 `if: ${{ !cancelled() }}` 라 plugin test 가 실패해도 도는데, 설치를 그 뒤에 두면 설치가 건너뛰어져 실행기가 의존 없이 돈다.
- `ci-workflow.spec.ts` 에 그 단계가 있고 두 테스트 단계보다 앞이라는 테스트를 더한다.

### 8. `docs/code-architecture.md` 「저장소 실행 규칙」 의 「의존」 행

「Node 내장 모듈만 쓴다. `package.json` 과 `node_modules` 를 두지 않는다」 를 다음 뜻으로 바꾼다. 의존은 루트 `package.json` 에 정확한 버전으로 두고 `package-lock.json` 을 커밋한다. `node_modules` 는 커밋하지 않는다. 사용자 머신은 Claude Code 가 설치하고 체크아웃·워크트리·CI 는 `npm ci` 로 설치한다. bare import 는 `scripts/runtime-policy.json` 의 `bare_imports` 짝에서만 쓴다. 근거는 ADR-030 링크로 단다. 「import 범위」 행은 「스킬과 도구는 자기 폴더, Node 내장 모듈, `bare_imports` 에 적은 의존만 import 한다」 로 고친다.

### 9. korean-check 옛 이름 진입 삭제(구현 중 드러난 충돌, 사용자 결정 2026-11-13)

- `export-only-skills/korean-check/scripts/korean-style-check.py` 와 `check-readability.py` 를 지운다(node-runtime 스펙 DECISION17). `scripts/runtime-policy.json` 의 `legacy` 를 비운다.
- 두 `.ts` 의 옛 진입 안내(`hookNotice`, `notice`)를 지우고, `tests/legacy-entry.spec.ts` 는 옛 이름이 없는지 보는 테스트로 바꾼다. 링크로 부르기 테스트는 `.ts` 링크로 바꾼다.
- korean-check 를 `scripts/bump-skill-major.ts` 로 3.0.0 으로 올린다(변경 이력 조각을 따로 더하지 않는다). README·`docs/code-architecture.md`·node-runtime 스펙 DECISION17 의 옛 이름 안내를 고친다.
- `scripts/tests/plugin-manifest.spec.ts` 의 bin/ 목록 테스트가 `bin/package.json` 을 허용한다.

## 검증

```bash
npm ci --ignore-scripts
node scripts/run-tests.ts scripts/tests/runtime-policy.spec.ts scripts/tests/run-tests.spec.ts scripts/tests/ci-workflow.spec.ts skills/orch/tests/orch-launcher.spec.ts skills/orch/tests/lib-guard.spec.ts
node scripts/runtime-policy.ts
./bin/orch --help
node scripts/run-tests.ts --tsc-only
```

기대값: 테스트 통과, `runtime-policy.ts` 종료 코드 0 과 끝 줄 `OK pending ...`, `./bin/orch --help` 가 사용법을 낸다(`require is not defined` 가 없다), tsc 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `package.json` | 신규 |
| `package-lock.json` | 신규 |
| `.gitignore` | 수정 (`/node_modules/`) |
| `bin/package.json` | 신규 |
| `skills/orch/scripts/lib/guard/gh` | 수정 (형식 무관 진입) |
| `skills/orch/scripts/lib/guard/orca` | 수정 (형식 무관 진입) |
| `scripts/runtime-policy.ts` | 수정 (`package.json` 자리, bare import 규칙) |
| `scripts/runtime-policy.json` | 수정 (`bare_imports`) |
| `scripts/tests/runtime-policy.spec.ts` | 수정 |
| `scripts/run-tests.ts` | 수정 (설치 확인, 머리 주석) |
| `scripts/tests/run-tests.spec.ts` | 수정 |
| `.github/workflows/ci.yml` | 수정 (`npm ci` 단계) |
| `scripts/tests/ci-workflow.spec.ts` | 수정 |
| `docs/code-architecture.md` | 수정 (「의존」, 「import 범위」 행, 옛 이름 링크 행) |
| `export-only-skills/korean-check/scripts/korean-style-check.py` | 삭제 |
| `export-only-skills/korean-check/scripts/check-readability.py` | 삭제 |
| `export-only-skills/korean-check/scripts/korean-style-check.ts` | 수정 (옛 진입 안내 제거) |
| `export-only-skills/korean-check/scripts/check-readability.ts` | 수정 (옛 진입 안내 제거) |
| `export-only-skills/korean-check/tests/legacy-entry.spec.ts` | 수정 (옛 이름이 없는지 본다) |
| `export-only-skills/korean-check/tests/korean-style-check.spec.ts` | 수정 (`.ts` 링크) |
| `export-only-skills/korean-check/tests/check-readability.spec.ts` | 수정 (`.ts` 링크) |
| `export-only-skills/korean-check/README.md` | 수정 (옛 이름 안내) |
| `export-only-skills/korean-check/SKILL.md` | 수정 (버전 3.0.0) |
| `export-only-skills/korean-check/CHANGELOG.md` | 수정 (3.0.0 절) |
| `scripts/tests/plugin-manifest.spec.ts` | 수정 (`bin/package.json` 허용) |
| `docs/features/node-runtime/spec.md` | 수정 (DECISION17 행) |
| `docs/features/orch-config-cli/design.md` | 수정 (CommonJS 진입 항목) |
| `docs/adr/030-plugin-npm-dependencies.md` | 수정 (결과) |
