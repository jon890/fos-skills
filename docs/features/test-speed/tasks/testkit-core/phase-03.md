# Phase 03. 측정 명령과 내보내기 경계 검사

**Execution profile**: standard

## 목표

PR 마다 같은 방법으로 전후 시간과 기동 수를 재는 `modules/testkit/measure.ts` 와, 팀으로 내보내는 폴더가 그 폴더 밖을 상대 경로로 import 하지 못하게 막는 `scripts/tests/exported-imports.spec.ts` 를 둔다. 이 PR 의 측정 표를 만든다.

**범위 외**: 새 실행기(계획 test-runner), 다른 PR 의 측정.

## 컨텍스트

- 측정 방법의 원본은 설계 「측정 방법」 과 「측정 명령」 이다. PR1(#336)은 같은 방법을 세션 임시 폴더의 일회용 스크립트로 쟀다. 사용자가 측정 명령을 testkit 에 두기로 했다(스펙 DECISION12).
- orch-loop 계열 테스트는 자식 환경에서 `NODE_OPTIONS` 를 지운다(`delete env.NODE_OPTIONS` 꼴). 그래서 preload 로 기동 수를 세려면 측정용 사본에서 그 줄을 지운다.
- 팀 내보내기 목록은 `scripts/export-to-team.sh` 의 `SHARED_SKILLS=(...)`, `SHARED_TOOLS=(...)` 두 줄이다. 스킬의 실제 폴더는 `skills/<이름>` 또는 `export-only-skills/<이름>` 이다(`scripts/skill_paths.py` 의 `SKILL_ROOTS` 순서). 도구는 `tools/<이름>` 이다. 팀 저장소에서는 korean-check, content-preview 가 심볼릭 링크라 폴더 밖 상대 import 가 다른 곳을 가리킨다(스펙 「테스트 배포 경로」).
- 지금 내보내는 폴더에는 TS·JS 파일이 없어 검사가 비어 있다. 그래서 검사 함수를 임시 폴더에 돌려 잡는지를 본다.

**요구사항**: REQ3, REQ9

**근거 문서**: `docs/features/test-speed/spec.md`(DECISION7, DECISION12, DECISION19), `docs/features/test-speed/design.md` 「측정 명령」, 「측정 방법」, 「내보내기 경계 검사」

## 의도 메모

- `measure.ts` 는 명령이라 `temp.ts`(`node:test` 를 import)를 쓰지 않는다. 쓰면 stdout 끝에 node:test 요약이 붙어 PR 본문에 붙일 표가 더러워진다. 자기 임시 폴더를 `finally` 에서 지운다.
- 측정 명령과 검사 테스트가 띄우는 자식 환경에서 `NODE_TEST_CONTEXT` 를 지운다(`command.ts` 의 `runCommand` 를 쓰면 된다. 그 파일은 `node:test` 를 import 하지 않는다).
- 내보내기 검사가 목록의 폴더를 찾지 못하면 실패한다. 조용히 넘어가면 폴더가 옮겨 간 뒤(browser-driver 가 node-runtime 영역 10 에서 `skills/browser` 로) 검사가 비어도 모른다.

## 작업 항목

### 1. `modules/testkit/measure.ts`

- 사용법: `node modules/testkit/measure.ts --before <커밋> --after <커밋> [--runs N] <테스트 파일...>`. cwd 는 저장소 루트. 머리 주석이 사용법, 옵션, 종료 코드(0 측정 끝, 1 측정 중 테스트 실패가 있음, 2 인자·실행 오류)를 소유한다.
- 두 커밋을 `git archive <커밋> | tar -x -C <임시>/before`(after 도 같게)로 푼다.
- 시간: 파일마다 before, after 를 번갈아 N 번(기본 3) `node --test <파일>` 로 돌려 실제 걸린 시간의 가운데 값을 초로 낸다. 실패한 실행은 실패 칸에 센다.
- 기동 수: 각 사본을 한 벌 더 풀어 `.ts` 파일에서 `/^\s*delete\s+[\w.]+\.NODE_OPTIONS\s*;?\s*$/m` 줄을 지운다. preload 파일(임시 폴더에 쓴 `.mjs`)을 `NODE_OPTIONS=--import=<preload>` 로 건다. preload 는 `node:child_process` 의 `spawn`, `spawnSync`, `execFile`, `execFileSync`, `exec`, `execSync` 를 감싸 호출마다 한 줄을 기록 파일에 덧붙이고 `syncBuiltinESMExports()` 를 부른다. 파일마다 한 번 돌려 줄 수를 센다.
- 출력: 첫 줄에 두 커밋의 짧은 SHA 와 `os.loadavg()`, 다음에 markdown 표 `| 파일 | 전 시간(s) | 후 시간(s) | 전 기동 수 | 후 기동 수 | 실패 |`.

### 2. `scripts/tests/exported-imports.spec.ts`

- `export function outsideImports(root: string, folders: string[]): string[]` 를 같은 파일에 두고 테스트한다. 폴더마다 `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` 파일을 재귀로 읽어, `import ... from '<p>'`, `export ... from '<p>'`, `import '<p>'`, `import('<p>')`, `require('<p>')`, `new URL('<p>', import.meta.url)` 의 `<p>` 가운데 `.` 로 시작하는 것을 그 파일 기준으로 풀고, 폴더 밖이면 `<저장소 상대 파일>: <p>` 를 모은다.
- `export function exportedFolders(root: string): string[]`: `scripts/export-to-team.sh` 에서 `SHARED_SKILLS=(...)`, `SHARED_TOOLS=(...)` 를 정규식으로 읽어 폴더로 바꾼다. 찾지 못한 이름이 있으면 throw 한다.
- 테스트: 저장소 루트로 `outsideImports(root, exportedFolders(root))` 가 빈 배열이다. 임시 폴더에 가짜 내보내는 폴더를 만들어 여섯 꼴 각각이 밖을 가리키면 잡히고, 안을 가리키면 잡히지 않는다. 목록에 없는 폴더 이름이면 `exportedFolders` 가 throw 한다(임시 폴더에 가짜 `export-to-team.sh` 를 둔다).

### 3. 이 PR 의 측정

- 대상: phase 02 가 바꾼 fixtures 를 쓰는 테스트 가운데 `cleanup-sweep-merge.spec.ts`, `cleanup-sweep-holders.spec.ts`, 그리고 `fixtures/fake-bin` 을 쓰는 파일 가운데 가장 느린 셋(직접 재서 고른다).
- `node modules/testkit/measure.ts --before origin/main --after HEAD <파일...>` 의 출력을 PR 본문에 붙인다(REQ3). 측정 명령 자체가 before 커밋에 없어도 된다. 명령은 작업 트리에서 돌고 사본만 두 커밋에서 푼다.

## 검증

```bash
node --test scripts/tests/exported-imports.spec.ts
node modules/testkit/measure.ts --before HEAD --after HEAD --runs 1 modules/testkit/tests/git.spec.ts
node modules/testkit/measure.ts --bogus; test $? -eq 2
```

두 번째 줄은 표 한 줄을 내고 0 으로 끝난다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `modules/testkit/measure.ts` | 신규 |
| `scripts/tests/exported-imports.spec.ts` | 신규 |
