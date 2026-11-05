# Phase 02. 구현을 TypeScript 로 바꾸고 부르는 곳을 맞춘다

**Execution profile**: standard

## 목표

phase-01 의 명령 경계 테스트를 고치지 않은 채 TypeScript 구현으로 통과시키고, 옛 Python·셸 파일과 테스트를 지운다. workflow, 문서, 저장소 정책이 새 이름을 부른다.

**범위 외**: 다른 영역의 명령(korean-check 검사기, `style-check.sh`, `verify_task.py`, `browser_driver.py`)을 부르는 줄은 그 영역 PR 이 바꾼다(설계 「실패와 일관성」). orch `lib/args.ts`, `lib/py.ts` 는 바꾸지 않는다(설계 DECISION9).

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ10

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`, `docs/code-architecture.md` 「저장소 실행 규칙」

- 명령 파일 이름은 확장자만 바꾼다(설계 DECISION5): `bump-plugin-version.ts`, `check-skill-docs.ts`, `render-development-loop.ts`, `export-to-team.ts`, `install-hooks.ts`, `test-plugin-install.ts`, 모듈 `skill_changes.ts`, `skill_paths.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한, 머리 주석이 사용법과 종료 코드를 소유한다(`scripts/runtime-policy.ts` 머리 주석의 꼴).
- 명령은 `import.meta.main` 일 때만 돈다. 함수는 export 해 내부 함수 테스트가 import 한다.
- git 훅(설계 「진입 파일」): `githooks/commit-msg`, `githooks/post-commit` 은 확장자 없는 node shebang JS 로 `realpathSync(__filename) + '.ts'` 를 `import()` 해 `main(argv)` 의 돌려준 값을 종료 코드로 쓴다. 꼴은 `skills/orch/scripts/lib/guard/orca`.
- argparse 를 쓰던 명령(`bump-plugin-version`, `render-development-loop`)은 `modules/kit/args.ts` 의 `expandArgs` 로 접두 줄임을 펼치고 `node:util` 의 `parseArgs` 로 읽는다. 사용법 오류는 stderr 와 종료 코드 2 다(스펙 DECISION20).
- Python 과 뜻이 다른 것: `str.splitlines` 는 `\n` 말고도 `\r`, `\v`, `\f`, `\x1c~\x1e`, `\x85`, ` `, ` ` 에서 나눈다. `len`, 슬라이스는 코드 포인트 단위다. `\d` 는 유니코드 숫자다. `Path` 정렬은 경로 조각 단위다. 이 넷을 `modules/kit/py.ts` 의 함수와 `\p{Nd}`(u 플래그)로 맞춘다.

## 의도 메모

- `modules/kit/` 은 orch 의 `lib/args.ts`, `lib/py.ts` 에서 `./bundle.ts` import 와 `pyRegExp` 를 뺀 꼴로 만들고, `py.ts` 에 `pySplitLines`, `pyLen`, `pySlice`, `pyPathCompare` 를 더한다. orch 와 같은 이름의 함수가 같은 글자를 내는지 `scripts/tests/kit-copies.spec.ts` 가 본다. 복사본 대조와 `kit_sources` 는 복사본이 생길 때 더한다.
- `export-to-team.ts` 의 내보내는 목록은 `export const SHARED_SKILLS = [...]`, `SHARED_TOOLS` 한 줄 상수다. post-commit 훅은 옛 훅처럼 커밋한 체크아웃(`git rev-parse --show-toplevel`)의 `scripts/export-to-team.ts` 를 읽고 실행한다. 목록은 그 파일의 글을 훅 옆 저장소의 `sharedLists(text)` 로 읽는다. 커밋한 체크아웃의 파일을 import 하지 않아, 그 파일이 낡거나 깨져도 훅이 목록을 읽다 죽지 않는다.
- `export-to-team`, post-commit 의 stdout 안내 줄 세 곳(「반영: ...」 둘, 「전체는 ... 로 본다」)은 새 이름을 가리킨다. 나머지 바이트는 같다(코디네이터 답 2026-11-06). 명령 경계 테스트는 이 이름을 「명령 경계」 상수에서 읽는다.
- 이행 중 `.git/hooks` 는 원본 체크아웃의 `githooks/` 를 공유한다. 이 PR 전 브랜치의 워크트리에서 커밋하면 그 체크아웃에 `export-to-team.ts` 가 없어 post-commit 알림이 조용히 빠진다. PR 본문에 적는다.
- `expandArgs` 의 옵션 목록에 `help` 를 넣어야 `--he` 가 argparse 처럼 모호함(2)으로 끝난다.
- `install-hooks.ts` 는 `githooks/` 에서 확장자 없는 파일만 건다. `.ts` 본체는 git 이 부르지 않는다.
- `test-plugin-install.ts` 의 매니페스트 테스트는 `node --test scripts/tests/plugin-manifest.spec.ts` 로 바꾼다. 다른 영역 명령(`style-check.sh`, `verify_task.py`)은 옛 꼴로 부른다. 그래서 사전 점검은 `claude git python3 bash` 다.
- `commit-msg.ts` 는 korean-check 검사기를 `python3` 로 부른다. 옛 훅의 `sys.executable` 자리다.
- 기능 문서의 spec·design(version-at-merge, test-speed 등)은 기록이라 옛 이름을 고치지 않는다. 실행 절차인 `tasks/` 의 명령 줄과 현재 원본(README, `docs/code-architecture.md`, ADR-019·023 의 소유 문장)은 고친다.

## 작업 항목

### 1. `modules/kit/args.ts`, `modules/kit/py.ts`, `docs/code-architecture.md` 배치 표

orch 두 파일에서 만든다(위 의도 메모). `modules/kit/tests/py.spec.ts` 가 더한 넷을 Python 의 실측 값으로 본다(예: `pySplitLines('a\r\nb c\x0bd', true)` 는 `['a\r\n', 'b ', 'c\x0b', 'd']`). `scripts/tests/kit-copies.spec.ts` 가 `expandArgs`, `pyStr`, `pyJson`, `shQuote`, `shSplit` 의 orch·kit 출력을 같은 입력 표로 비교한다.

### 2. `scripts/skill_paths.ts`, `scripts/skill_changes.ts`

`skillDirs(root, legacy)`(이름 → 경로 Map, 넣는 순서는 옛 dict 와 같다), `sourcePath`, `SKILL_ROOTS`, `UNIT_ROOTS`, `CHANGES_DIR`, `unitDirs`, `checkFragment`, `checkChanges`, `nextVersion`, `todaySeoul`, `fragments`, `currentVersion`, `prependSection`, `applyFragments`. 동작은 옛 함수와 같다.

### 3. 명령 넷

- `bump-plugin-version.ts`: `run(base, head, day, root)` 와 `main(argv)`. `SystemExit(문구)` 자리는 stderr 문구와 1
- `check-skill-docs.ts`: `splitSections`, `checkReadme`, `checkChangelog`, `checkSkill`, `skillNames`, `main(argv, root)`
- `render-development-loop.ts`: 옛 옵션과 출력
- `export-to-team.ts`: 셸 부분과 Python heredoc 두 개를 하나로 합친다. `sharedLists(text)` 를 export 한다

### 4. 저장소 도구 셋

- `install-hooks.ts`, `githooks/commit-msg` + `commit-msg.ts`, `githooks/post-commit` + `post-commit.ts`
- `test-plugin-install.ts`

### 5. 명령 경계 상수를 바꾸고 옛 파일을 지운다

phase-01 의 8개 테스트 머리 「명령 경계」 묶음만 새 파일로 바꾼다. 내부 함수 테스트를 옮긴다: `test_skill_changes.py` → `skill-changes.spec.ts`, `test_skill_docs.py` 의 함수 사례 → `check-skill-docs.spec.ts` 에 더하기, `test_plugin_manifest.py` → `plugin-manifest.spec.ts`, `test_doc_script_refs.py` → `doc-script-refs.spec.ts`, `test_bump_plugin_version.py` 의 저장소 대조 사례 → `plugin-manifest.spec.ts`. 그 뒤 `scripts/*.py`, `scripts/*.sh`, `scripts/tests/test_*.py`, `scripts/check-shell-korean.py`, `scripts/samples/` 를 지운다(스펙 DECISION8).

### 6. 정책, CI, workflow, 문서

- `scripts/runtime-policy.json`: `pending` 에서 `scripts-githooks` 두 줄을 지우고 `entry_js` 에 두 훅, `migrated_docs` 에 `scripts/`, `githooks/` 를 더한다
- `tsconfig.json` 의 `include` 에 `githooks/*.ts`
- `.github/workflows/plugin-version.yml`: `actions/setup-node@v4` 의 `node-version: '24'` 단계, `node scripts/bump-plugin-version.ts`, version 읽기는 `node -p`(스펙 DECISION16)
- `scripts/tests/exported-imports.spec.ts`: `export-to-team.ts` 에서 `sharedLists` 로 읽는다
- README(59, 177, 290~302, 342, 421줄 근처), `docs/code-architecture.md`(배치 표, 스크립트 표, 검증 표), ADR-019·023 의 소유 문장, `docs/features/*/tasks/*` 의 `node scripts/check-skill-docs.ts` 줄

## 검증

```bash
node scripts/run-tests.ts
node scripts/runtime-policy.ts --pending
git grep -nE 'bump-plugin-version\.py|check-skill-docs\.py|render-development-loop\.py|skill_changes\.py|skill_paths\.py|check-shell-korean|export-to-team\.sh|install-hooks\.sh|test-plugin-install\.sh' -- README.md docs/code-architecture.md docs/adr/019-plugin-version-auto-bump.md docs/adr/023-version-at-merge.md 'docs/features/*/tasks/' .github githooks scripts modules
git ls-files scripts/samples 'scripts/*.py' 'scripts/*.sh' 'scripts/tests/*.py'
```

첫 줄 0, 둘째 줄에 `PENDING scripts-githooks` 가 없고 `OK`, 셋째 줄은 `docs/features/node-runtime/tasks/scripts-githooks/` 의 이 계획서 줄뿐이고, 넷째 줄은 빈 출력이다.
기능 문서의 spec·design(`docs/features/version-at-merge/`, `test-speed/`, `node-runtime/` 등)과 ADR-001·003·005·010·011 의 옛 이름은 결정 당시의 기록이라 대상에서 뺀다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `modules/kit/args.ts` | 신규 |
| `modules/kit/py.ts` | 신규 |
| `modules/kit/tests/py.spec.ts` | 신규 |
| `scripts/skill_paths.ts` | 신규 |
| `scripts/skill_changes.ts` | 신규 |
| `scripts/bump-plugin-version.ts` | 신규 |
| `scripts/check-skill-docs.ts` | 신규 |
| `scripts/render-development-loop.ts` | 신규 |
| `scripts/export-to-team.ts` | 신규 |
| `scripts/install-hooks.ts` | 신규 |
| `scripts/test-plugin-install.ts` | 신규 |
| `githooks/commit-msg` | 수정 |
| `githooks/post-commit` | 수정 |
| `githooks/commit-msg.ts` | 신규 |
| `githooks/post-commit.ts` | 신규 |
| `scripts/tests/kit-copies.spec.ts` | 신규 |
| `scripts/tests/skill-changes.spec.ts` | 신규 |
| `scripts/tests/plugin-manifest.spec.ts` | 신규 |
| `scripts/tests/doc-script-refs.spec.ts` | 신규 |
| `scripts/tests/exported-imports.spec.ts` | 수정 |
| `scripts/bump-plugin-version.py` | 삭제 |
| `scripts/check-skill-docs.py` | 삭제 |
| `scripts/render-development-loop.py` | 삭제 |
| `scripts/skill_changes.py` | 삭제 |
| `scripts/skill_paths.py` | 삭제 |
| `scripts/check-shell-korean.py` | 삭제 |
| `scripts/export-to-team.sh` | 삭제 |
| `scripts/install-hooks.sh` | 삭제 |
| `scripts/test-plugin-install.sh` | 삭제 |
| `scripts/samples/shell-korean-bad.sh` | 삭제 |
| `scripts/samples/shell-korean-good.sh` | 삭제 |
| `scripts/runtime-policy.json` | 수정 |
| `tsconfig.json` | 수정 |
| `.github/workflows/plugin-version.yml` | 수정 |
| `README.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `docs/adr/019-plugin-version-auto-bump.md` | 수정 |
| `docs/adr/023-version-at-merge.md` | 수정 |

phase-01 의 테스트 8개는 「명령 경계」 묶음만 고치고, 옛 `scripts/tests/test_*.py` 9개는 지운다. `docs/features/*/tasks/` 의 옛 명령 줄도 고친다.
