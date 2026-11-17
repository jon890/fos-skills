# Phase 01. korean-check 에 스테이징 검사 모드를 더한다

**Execution profile**: standard

## 목표

`check.ts --staged` 를 만든다. git 인덱스에 스테이징한 `.md` 에서 이번에 더한 줄의 발견만 내고, 금지어가 있으면 권장 표현과 함께 종료 코드 1 로 끝난다. 커밋 훅이 이 명령 하나로 커밋을 막을지 정한다.

**범위 외**: 훅을 워크트리에 거는 일과 훅 본체는 phase 02 다. 기존 두 검사기의 발견 줄 형식과 `--diff`, `--text`, 파일 모드의 동작은 바꾸지 않는다.

## 컨텍스트

- 스킬 폴더는 `export-only-skills/korean-check/` 다. 팀 저장소로 내보내는 스킬이라 Node 내장 모듈과 자기 폴더만 import 한다.
- `scripts/check.ts` 가 진입이고 `--diff` 를 `scripts/check-diff.ts` 로 넘긴다. `check-diff.ts` 는 작업 트리 파일에 두 검사기(`korean-style-check.ts`, `check-readability.ts`)를 돌린 뒤 발견 줄을 줄 번호로 「이번 변경」 과 「기존 줄」 로 나눈다. 발견 줄은 `경로:줄번호:` 또는 `경로:줄번호  경고` 로 시작한다(`FINDING` 정규식).
- `--diff` 는 작업 트리를 읽는다. 커밋 훅에서는 스테이징한 뒤 고친 내용이 섞이면 안 되고, `git commit -a` 는 git 이 임시 인덱스(`GIT_INDEX_FILE`)를 쓰므로 인덱스의 내용을 읽어야 커밋될 내용과 같다.
- 금지어 검사기는 예외 파일 `.claude/korean-check-allow.txt` 를 대상 파일의 디렉터리에서 위로 올라가며 `.git` 이 있는 디렉터리까지 찾는다(`korean-style-check.ts` 의 `findAllowFile`). 환경 변수 `KOREAN_CHECK_ALLOW` 가 있으면 그 경로만 본다.
- 매핑 표는 `references/korean-style.md` 의 「어색한 말 매핑 표」 이고 열은 `| 금지 | 원어 | 권장 |` 이다. `loadTerms(rules)` 가 첫 열에서 금지어를 뽑는다.
- 테스트는 `tests/*.spec.ts`(node:test)이고 공용 helper 는 `tests/helpers.ts` 다. 임시 git 저장소는 `initRepo`, `git`, `GIT_ENV` 로 만든다.

**요구사항**: REQ1

**근거 문서**: `docs/features/orch-single-worker/spec.md`, `docs/features/orch-single-worker/design.md` 의 「인터페이스와 데이터」 중 「`check.ts --staged`」, `docs/adr/036-worker-commit-korean-check.md`

## 의도 메모

- 기존 발견 줄에 권장 표현을 붙이지 않는다. 그 줄은 `check-diff.ts` 와 편집 훅이 읽는 형식이라 바꾸면 출력 계약 변경이다. 권장 표현은 `--staged` 출력에만 줄을 더한다.
- `check.ts` 의 인자 없음 오류 문구(`검사할 파일이나 --text 나 --diff 가 필요하다`)는 테스트가 고정한 출력이라 바꾸지 않는다.
- `--diff` 는 이름을 바꾼 파일의 모든 줄을 이번 변경으로 본다. `--staged` 는 커밋을 막는 용도라 이름만 바꾼 파일은 바뀐 줄만 본다. 문서를 옮기는 커밋이 기존 줄의 금지어로 막히지 않게 하려는 것이다.
- 발견이 없으면 아무것도 내지 않는다. 훅이 출력을 그대로 내보내도 조용해야 한다.

## 작업 항목

### 1. `export-only-skills/korean-check/scripts/korean-style-check.ts` 에 `loadAdvice` 를 더한다

- `export function loadAdvice(rules: string): Map<string, string>`. 매핑 표의 행마다 첫 열의 금지어(슬래시로 나누고 괄호 안을 뺀 것, `loadTerms` 와 같은 규칙) 각각을 셋째 열(권장)의 앞뒤 공백을 뗀 글에 잇는다. 셋째 열이 비면 그 금지어는 넣지 않는다.
- 표의 행을 읽는 반복(제목 찾기, 다음 `## ` 에서 멈춤, 구분 행과 머리 행 건너뛰기)은 `loadTerms` 와 한 벌로 쓰게 내부 함수로 뺀다. `loadTerms` 의 반환 값은 그대로다.

### 2. `export-only-skills/korean-check/scripts/check-diff.ts` 에 `--staged` 를 더한다

- 인자: `--staged` 는 값 없는 옵션이다. `--base` 나 파일 인자와 함께 주면 사용법 오류(종료 코드 2, stderr 에 `argument --staged: not allowed with --base or files`)다. 긴 옵션 목록(`longs`)에 `staged` 를 더해 고유 접두(`--stag`)도 받는다. `HELP` 와 `USAGE` 에 옵션을 적는다.
- 대상: 저장소 루트에서 `git diff --cached --name-status -z -M --diff-filter=AMR -- '*.md'` 를 돌려 읽는다. `-z` 출력은 `상태\0경로\0` 이고 상태가 `R` 로 시작하면 `상태\0옛 경로\0새 경로\0` 다. `git --literal-pathspecs ls-files -s -- <경로>` 의 모드가 `100644`, `100755` 가 아닌 항목(심볼릭 링크, 서브모듈)은 뺀다. 작업 트리의 같은 경로가 매핑 표 파일(`rulesPath()`)과 같은 파일이면 뺀다.
- 더한 줄: 상태 `A` 는 모든 줄, `M` 은 `git --literal-pathspecs diff --cached -U0 --no-color --no-ext-diff -- <경로>` 의 hunk, `R` 은 `git --literal-pathspecs diff --cached -U0 -M --no-color --no-ext-diff -- <옛 경로> <새 경로>` 의 hunk 다. 파일 하나를 가리키는 명령은 `--literal-pathspecs` 를 붙여 이름의 `[` 나 `*` 가 다른 파일과 맞지 않게 한다. 대상을 모으는 첫 명령만 `*.md` 를 glob 으로 쓴다. hunk 읽기는 기존 `HUNK` 정규식을 쓴다.
- 내용: `git cat-file blob :<경로>` 를 바이트 그대로 받아 임시 폴더(`os.tmpdir()` 아래 `mkdtempSync`, 실체 경로)의 같은 상대 경로에 쓴다. 임시 폴더 루트에 빈 `.git` 디렉터리를 만들어 예외 파일 찾기가 임시 폴더 밖으로 올라가지 않게 한다. 대상 파일마다 그 디렉터리에서 저장소 루트까지 올라가며 작업 트리에 `.claude/korean-check-allow.txt` 가 있으면 임시 폴더의 같은 자리에 복사한다. 임시 폴더는 `finally` 에서 지운다.
- 실행: 두 검사기를 `cwd` 를 임시 폴더로 하고 상대 경로를 인자로 주어 돌린다. 발견 줄의 경로가 저장소 루트 기준이 된다. 검사기가 2 로 끝나면 그 stderr 를 내고 2 다.
- 출력: 더한 줄에 속한 발견 줄만 낸다(금지어 검사기의 줄이 먼저, 가독성 검사기의 줄이 뒤). 그 뒤에 발견 줄에서 `금지어 "<낱말>"` 로 읽은 낱말마다, `loadAdvice` 에 있으면 `권장 표현: "<낱말>" → <권장 열>` 한 줄을 처음 나온 차례로 한 번씩 낸다. 발견이 없으면 아무것도 내지 않는다.
- 종료 코드: 더한 줄의 발견 줄에 `: 금지어 "` 가 있으면 1, 없으면 0, git 저장소 밖이거나 git 명령이 실패하면 2 다. `--diff` 의 판정(`금지어` 낱말 포함)은 바꾸지 않는다. 경로에 그 낱말이 든 파일의 경고가 커밋 거절로 바뀌지 않게 `--staged` 만 좁힌다.
- git 명령은 모두 `cwd` 를 저장소 루트로 부른다. 훅 환경에는 `GIT_DIR` 과 `GIT_INDEX_FILE` 이 들어 있어, 임시 폴더를 `cwd` 로 git 을 부르면 실제 저장소에 닿는다. 임시 폴더에서는 검사기만 돌린다.
- HEAD 가 없는 첫 커밋에서도 돈다. `git diff --cached` 는 HEAD 가 없으면 빈 트리와 비교해 모든 파일을 `A` 로 낸다.
- 머리 주석의 사용법, 출력, 종료 코드에 `--staged` 를 적는다. 저장소 루트 기준 경로로 낸다는 점과 이름 바꾼 파일의 차이도 적는다.

### 3. `export-only-skills/korean-check/scripts/check.ts` 가 `--staged` 를 넘긴다

- `argv[0] === '--staged'` 면 `runScript(DIFF, ['--staged', ...argv.slice(1)])` 의 종료 코드를 돌려준다. 머리 주석의 사용법에 한 줄을 더한다.

### 4. 이 phase 를 검증하는 테스트

`export-only-skills/korean-check/tests/check-diff.spec.ts` 에 `describe('--staged')` 를 더한다. 임시 저장소에 `# 문서\n\n장애를 트리아지한다.\n\n둘째 단락이다.\n` 을 커밋해 두고 본다.

- 더한 줄에 금지어 `스윕` 을 스테이징하면 종료 코드 1 이고, stdout 에 `doc.md:7` 발견 줄과 `권장 표현: "스윕" → ` 로 시작하는 줄이 있고, 기존 줄의 `트리아지` 는 없다.
- 더한 줄에 경고(`배포 + 검증을 쓴다.`)만 있으면 0 이고 경고 줄이 나온다. 권장 표현 줄은 없다.
- 깨끗한 줄만 스테이징하면 0 이고 stdout 이 빈 문자열이다. 스테이징한 `.md` 가 없어도 같다.
- 금지어를 스테이징한 뒤 작업 트리에서 그 줄을 고치면(스테이징하지 않음) 여전히 1 이다. 반대로 깨끗한 내용을 스테이징한 뒤 작업 트리에 금지어를 더하면 0 이다.
- 새 파일은 모든 줄이 대상이다(1). `git mv doc.md moved.md` 만 스테이징하면 0 이다. 옮기면서 금지어 줄을 더하면 1 이고 발견 줄이 `moved.md:` 로 시작한다.
- 코드 블록 안에 더한 금지어는 0 이다.
- 저장소 루트의 `.claude/korean-check-allow.txt` 에 적은 고유명사 안의 금지어는 0 이다. 하위 폴더 `sub/.claude/korean-check-allow.txt` 에만 적은 고유명사는 `sub/` 아래 파일에서 0 이고 루트의 파일에서는 1 이다. 예외 파일은 평소처럼 대상 파일에서 가장 가까운 것 하나만 읽힌다. 환경 변수 `KOREAN_CHECK_ALLOW` 를 주지 않은 채 확인한다. 하위 폴더에서 돌려도 발견 줄의 경로는 저장소 루트 기준이다.
- 커밋이 하나도 없는 저장소에서 금지어가 든 새 `.md` 를 스테이징하면 1 이다.
- 파일 이름에 `금지어` 가 든 `.md`(`금지어-목록.md`)에 경고만 있는 줄을 더하면 0 이다.
- 이름에 glob 글자가 든 `a[1].md` 와 `a1.md` 를 함께 커밋해 두고 `a[1].md` 에만 금지어 줄을 더해 스테이징하면 1 이고 발견 줄이 `a[1].md:` 로 시작한다. `--literal-pathspecs` 를 빼면 `a[1].md` 의 diff 가 `a1.md` 를 가리켜 이 사례가 실패한다.
- DB 문맥 패턴(`korean-style-check.ts` 의 `DB_CONTEXT_PATTERNS`)만 걸린 줄은 1 이고 `권장 표현:` 줄은 없다. 그 발견 줄에는 고칠 말이 이미 있다.
- `GIT_INDEX_FILE` 을 다른 인덱스 파일로 준 채 돌리면 그 인덱스의 내용을 본다(임시 인덱스에 금지어를 `git update-index` 로 넣고 1 을 확인한다).
- `--staged --base main`, `--staged doc.md` 는 2 다. 저장소 밖은 2 다.

`export-only-skills/korean-check/tests/check.spec.ts` 에 `check.ts --staged` 가 같은 종료 코드와 출력을 넘기는 사례 하나(금지어 1, 깨끗하면 0)를 더한다.
`export-only-skills/korean-check/tests/korean-style-check-internals.spec.ts` 에 `loadAdvice` 사례를 더한다. 그 파일은 실제 규칙 파일의 금지어를 쓰지 않으므로(머리 주석), 임시 폴더에 매핑 표 파일을 만들어 그 경로로 부른다. 표에는 슬래시로 나눈 행(`가나 / 다라`), 괄호 설명이 붙은 행(`마바 (용례)`), 권장 열이 빈 행을 둔다. 슬래시 행의 낱말마다 같은 권장 글이 붙고, 괄호 안은 낱말에서 빠지고, 권장이 빈 행의 낱말은 결과에 없다. 실제 표와의 연결은 위 `--staged` 사례가 본다.

### 5. 문서와 변경 조각

- `export-only-skills/korean-check/SKILL.md` 의 「검사기를 돌린다」 에 `--staged` 를 더한다. 커밋 훅에서 스테이징한 내용의 더한 줄만 판정하고, 발견이 없으면 조용하다는 것과 명령 블록 하나다. 세부는 `check-diff.ts` 머리 주석을 가리킨다.
- `export-only-skills/korean-check/README.md` 의 「이럴 때 쓴다」 에 커밋 전에 스테이징한 문서를 막고 싶을 때를 한 줄 더한다.
- `export-only-skills/korean-check/references/markdown-readability.md` 의 「훅이 잡지 못하는 것」 끝에, 커밋 훅에서 `--staged` 로 돌리면 파일을 만든 방법과 상관없이 커밋되는 `.md` 를 본다는 문장을 더한다.
- `export-only-skills/korean-check/changes/codex-korean-check.minor.md` 를 만든다. `- ` 줄 하나로 `check.ts --staged` 를 알린다.

## 검증

```bash
node scripts/run-tests.ts export-only-skills/korean-check/tests
node export-only-skills/korean-check/scripts/check.ts export-only-skills/korean-check/SKILL.md export-only-skills/korean-check/README.md export-only-skills/korean-check/references/markdown-readability.md
node scripts/run-tests.ts scripts/tests/check-skill-docs.spec.ts scripts/tests/doc-script-refs.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 네 명령 모두 종료 코드 0. 파일 인자를 준 실행은 tsc 를 돌리지 않아 `--tsc-only` 를 따로 돈다. 첫 명령에서 `--staged` 사례가 모두 통과한다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `export-only-skills/korean-check/scripts/korean-style-check.ts` | 수정 (`loadAdvice` 추가) |
| `export-only-skills/korean-check/scripts/check-diff.ts` | 수정 (`--staged` 추가) |
| `export-only-skills/korean-check/scripts/check.ts` | 수정 (`--staged` 넘기기) |
| `export-only-skills/korean-check/tests/check-diff.spec.ts` | 수정 |
| `export-only-skills/korean-check/tests/check.spec.ts` | 수정 |
| `export-only-skills/korean-check/tests/korean-style-check-internals.spec.ts` | 수정 |
| `export-only-skills/korean-check/SKILL.md` | 수정 |
| `export-only-skills/korean-check/README.md` | 수정 |
| `export-only-skills/korean-check/references/markdown-readability.md` | 수정 |
| `export-only-skills/korean-check/changes/codex-korean-check.minor.md` | 신규 |
