# Phase 01. 옛 구현에서 통과하는 명령 경계 테스트

**Execution profile**: standard

## 목표

`scripts/` 의 명령과 `githooks/` 의 두 훅이 지키는 옵션, stdout, 쓰는 파일, 종료 코드를 `node:test` 로 먼저 고정한다. 이 phase 의 커밋에서 새 테스트는 옛 Python·셸 구현을 부르고 통과한다(스펙 DECISION11, 설계 「동등성 확인」 1).

**범위 외**: 구현 교체, 옛 Python 테스트 삭제, 내부 함수 테스트 이전(phase-02).

## 컨텍스트

**요구사항**: REQ3

**근거 문서**: `docs/features/node-runtime/spec.md`, `docs/features/node-runtime/design.md`

- 테스트는 `scripts/tests/<명령>.spec.ts` 다. 임시 폴더는 `modules/testkit/temp.ts` 의 `tempDir`, git 환경은 `modules/testkit/git.ts` 의 `gitEnv`·`git`, 명령 실행은 `modules/testkit/command.ts` 의 `runCommand` 를 쓴다. `scripts/` 는 내보내지 않는 영역이라 testkit 을 import 한다(설계 DECISION3).
- `scripts/` 의 옛 명령은 자기 파일 위치의 상위 폴더를 저장소로 쓴다(`ROOT = Path(__file__).resolve().parents[1]`, `REPO_DIR="$(cd "$(dirname ...)/.." && pwd)"`). 그래서 테스트는 명령 파일을 임시 저장소의 `scripts/` 로 복사해 돌린다. 두 훅은 `git rev-parse --show-toplevel` 로 커밋한 체크아웃을 찾는다. 이 저장소의 파일을 바꾸지 않는다.
- 명령마다 파일 머리의 「명령 경계」 상수 묶음만 구현을 가리킨다: 실행 argv 앞부분(`['python3', ...]`, `['/bin/bash', ...]`), 복사할 파일 목록, 가짜 파일의 꼴. phase-02 는 이 묶음만 바꾸고 사례는 고치지 않는다.
- 옛 Python 테스트(`scripts/tests/test_*.py`)는 이 phase 에서 그대로 둔다. 실행기(`scripts/run-tests.ts`)가 둘을 함께 돈다.

## 의도 메모

- 옛 테스트가 함수를 직접 부르던 사례(`bumper.run`, `docs.check_skill`)는 명령으로 관측되면 명령 경계로 옮긴다. `check_readme`, `check_changelog`, `check_fragment`, `apply_fragments` 의 세부 판정은 phase-02 의 내부 함수 테스트로 옮긴다.
- `test_export_to_team.py` 가 `skills/plan/tests/test_verify_task.py` 의 바이트를 fixture 로 읽던 것은 테스트 안의 문자열로 바꾼다(설계 「실패와 일관성」). 다른 영역 파일에 기대지 않는다.
- post-commit 의 가짜 내보내기 명령은 구현마다 꼴이 다르다(셸 배열 줄 대 TypeScript 상수). 그 꼴은 「명령 경계」 상수 묶음에 둔다.

## 작업 항목

### 1. `scripts/tests/bump-plugin-version.spec.ts`

`test_bump_plugin_version.py` 의 사례를 모두 CLI 로 옮긴다. 임시 저장소(`plugin.json`, 플러그인 CHANGELOG, `skills/orch`)를 만들고 커밋한 뒤 명령 파일을 복사해 `--base --head --date 2026-11-02` 로 부른다.

- 새 스킬 버전 절은 minor 이고 스킬·PR 번호를 적는다. plugin.json 은 version 줄만 바뀐다(바이트 비교)
- CHANGELOG 이동은 옛 버전을 다시 적지 않는다(patch), `호환성:` 은 major, 스킬 버전 없는 변경은 patch 와 「바뀐 곳」
- 직접 올린 version 과 플러그인 이력만 바뀐 것은 stdout 이 `skip:` 으로 시작하고 파일이 그대로다
- `--base` 가 0 40개이거나 빈 문자열이면 head 의 부모를 쓴다
- 조각(patch, minor, 틀린 이름, 이미 처리된 조각, 두 조각, 직접 올린 version 과 섞임, 옛 `호환성:` 과 섞임), 머지 커밋 끝까지
- 틀린 조각의 경고는 stderr 의 `경고: ` 줄이다
- 옵션: `--ba`·`--he`(접두 줄임은 `--he` 가 `--head`, `--help` 둘에 맞아 2), `--base=<sha>`, 모르는 옵션 2, `--date` 값 없음 2
- plugin.json version 이 X.Y.Z 가 아니면 종료 코드 1

### 2. `scripts/tests/check-skill-docs.spec.ts`

- 이 저장소에서 인자 없이 부르면 stdout 이 비고 0
- 임시 root 에 스킬 둘(`skills/demo`, 옛 배치의 루트 `legacy`)과 명령을 두고, README 위반·CHANGELOG 위반·조각 위반이 `<이름>/README.md: ...`, `<이름>/CHANGELOG.md: ...`, `skills/demo/changes/<파일>: ...` 줄로 나오고 1
- 스킬 이름을 주면 그 스킬과 그 스킬의 조각만 본다(다른 스킬 조각 위반이 있어도 0)
- stdout 줄은 바이트까지 같은 문자열로 비교한다

### 3. `scripts/tests/render-development-loop.spec.ts`

임시 root 에 README(Mermaid 원본), `docs/diagrams/development-loop.config.json`, 명령을 둔다. 가짜 `mmdc`(인자와 입력 파일 내용을 기록하고 `-o` 파일을 만든다)를 `--mmdc` 로 준다.

- stdout 이 `docs/images/development-loop.svg` 한 줄이고 0, 가짜가 받은 인자(`-i`, `-c`, `-b white`, `--size 1400`, `-o`)와 입력 내용
- `--preview <경로>`, `--puppeteer-config <경로>`(`-p` 절대 경로)가 두 번째 호출과 인자에 들어간다
- README 에 Mermaid 원본이 없으면 2, 모르는 옵션 2, `--mm` 접두 줄임이 된다

### 4. `scripts/tests/export-to-team.spec.ts`

`test_export_to_team.py` 의 사례를 모두 옮긴다. 「명령 경계」 묶음: 실행 argv(`['/bin/bash', 스크립트]`), 복사할 파일(`export-to-team.sh`, `skill_paths.py`), 내보내는 목록을 읽는 함수.

- 인자 오류(모르는 인자, `--source-ref` 값 없음, 없는 커밋) 2와 stderr 문구, 팀 저장소 없음 0
- `원본:` 줄(작업 트리, 커밋하지 않은 변경, git 저장소 아님, `--source-ref`), `없음`·`다름` 줄, 종료 코드 1
- `--apply` 결과의 바이트(링크 주소 옮기기, 코드·테스트 파일 보존, `changes/` 제외)
- 팀 쪽 버전이 더 높으면 3 이고 파일을 건드리지 않는다(새 사례)
- 팀에만 있는 파일은 `남음` 이고 `--apply` 가 지운다(새 사례)

### 5. `scripts/tests/install-hooks.spec.ts` 와 두 훅 테스트

- `install-hooks.spec.ts`: 임시 저장소와 그 워크트리에서 설치 명령을 부르면 `.git/hooks/<훅>` 이 원본 체크아웃의 `githooks/<훅>` 을 가리키고 stdout 에 `  걸었다: <훅>` 줄이 훅마다 있다. `githooks/` 가 없으면 2
- `commit-msg-hook.spec.ts`: `test_commit_msg_hook.py` 의 사례(금지어 차단, 깨끗한 메시지, 잘라내기 줄 아래 무시, 주석 줄 검사, 검사기 없음)를 설치 명령으로 건 훅과 실제 `git commit` 으로 본다
- `post-commit-hook.spec.ts`: `test_post_commit_hook.py` 의 사례를 옮긴다. 훅은 파일을 직접 실행한다(shebang). 어긋남이 없으면 출력이 없다는 사례를 더하고, 설치 명령으로 건 훅이 원본 체크아웃과 워크트리의 `git commit` 에서 도는 사례를 더한다(REQ2)

### 6. `scripts/tests/test-plugin-install.spec.ts`

`test_plugin_install_script.py` 의 사례(모르는 인자 2, `--keep` 앞뒤, `claude` 없는 PATH 에서 2 와 stderr 의 `claude`)를 옮긴다.

## 검증

```bash
node scripts/run-tests.ts scripts/tests/bump-plugin-version.spec.ts scripts/tests/check-skill-docs.spec.ts scripts/tests/render-development-loop.spec.ts scripts/tests/export-to-team.spec.ts scripts/tests/install-hooks.spec.ts scripts/tests/commit-msg-hook.spec.ts scripts/tests/post-commit-hook.spec.ts scripts/tests/test-plugin-install.spec.ts
node scripts/run-tests.ts scripts/tests 'scripts/tests/*.spec.ts'
```

둘 다 종료 코드 0 이다. 둘째 줄은 옛 Python 테스트와 새 테스트를 함께 돈다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/tests/bump-plugin-version.spec.ts` | 신규 |
| `scripts/tests/check-skill-docs.spec.ts` | 신규 |
| `scripts/tests/render-development-loop.spec.ts` | 신규 |
| `scripts/tests/export-to-team.spec.ts` | 신규 |
| `scripts/tests/install-hooks.spec.ts` | 신규 |
| `scripts/tests/commit-msg-hook.spec.ts` | 신규 |
| `scripts/tests/post-commit-hook.spec.ts` | 신규 |
| `scripts/tests/test-plugin-install.spec.ts` | 신규 |
