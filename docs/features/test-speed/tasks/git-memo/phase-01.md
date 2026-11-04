# Phase 01. 같은 git 조회를 프로세스 안에서 기억한다

**Execution profile**: standard

## 목표

`mainCheckout` 과 `ensureIgnored` 가 같은 질문에 git 을 다시 띄우지 않게 해, orch 명령과 그 테스트의 프로세스 기동을 줄인다.

**범위 외**: 테스트 파일의 가짜 실행 파일, 테스트 준비 git, 실행기. 각각 뒤 PR 이 맡는다(index.json 의 deferred). 자식 프로세스에 결과를 넘기는 일(설계 DECISION1), `lib/gh.ts` 와 `lib/gh-budget.ts` 의 기존 캐시 정리, `extensions/work-board/bin/board.ts` 의 `--show-toplevel` 은 하지 않는다.

## 컨텍스트

- `skills/orch/scripts/lib/git.ts` 의 `mainCheckout(repo)` 은 부를 때마다 `git rev-parse --path-format=absolute --git-common-dir` 를 띄우고, 끝이 `.git` 이 아니면 `--show-toplevel` 을 한 번 더 띄운다. 실패하면 `real(repo)` 를 돌려준다.
- `skills/orch/scripts/lib/paths.ts` 의 `ensureIgnored(repo)` 는 `orchDir`(안에서 `mainCheckout`), `mainCheckout`, `rev-parse --git-dir`, `check-ignore -q --no-index`, 필요하면 `rev-parse --git-path info/exclude` 를 부른다. `ensure`, `makeParent` 가 이 함수를 부른다.
- 실측(orch-loop.spec.ts): 같은 git 조회 5,177회의 대부분이 `GIT_CEILING_DIRECTORIES` 를 건 git 밖 임시 폴더에서 실패한 답이다. 실패한 답도 기억해야 시간이 준다. 기억과 다시 확인의 규칙은 설계의 「PR1: 무엇을 기억하나」, 「PR1: 기억을 다시 확인하는 조건」 이 소유한다.
- 실경로는 `lib/fs.ts` 의 `real` 을 쓴다.
- 코드 수정은 orch-cleanup-speed PR 이 main 에 머지된 뒤 시작한다(사용자 결정 2026-11-04 의 순서). 시작 전에 `git merge origin/main` 으로 받는다.

**요구사항**: REQ1, REQ2, REQ3

**근거 문서**: `docs/features/test-speed/spec.md`, `docs/features/test-speed/design.md`

## 의도 메모

- 기억을 지우는 함수를 내보내지 않는다(설계 DECISION3). 기존 테스트가 기억 때문에 실패하면 테스트를 고치지 말고 다시 확인하는 조건을 다시 본다. REQ2 는 기존 케이스를 고치지 않은 채 통과하는 것이다.
- 기각: `ORCH_MAIN_CHECKOUT` 같은 환경 변수로 자식에게 넘기기. 자식이 다른 `--repo` 로 불리면 틀린 값을 쓴다.
- 기각: 실패한 답을 기억하지 않기. 테스트의 반복이 거의 줄지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/git.ts`

- `export function hasGitMarker(dir: string): boolean` 을 더한다. `resolve(dir)` 에서 루트까지 올라가며 `join(d, '.git')` 이 `existsSync` 면 true 다. 없는 폴더도 받는다.
- 열쇠 함수: `JSON.stringify([path, GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE, GIT_CEILING_DIRECTORIES])`(값은 `process.env`). paths.ts 도 같은 환경 변수 묶음을 쓰도록 `export function gitMemoKey(...parts: string[]): string` 으로 내보낸다.
- `const mainCheckoutMemo = new Map<string, { main: string; found: boolean }>()`.
  - 꺼낼 때: found 면 `existsSync(self) && existsSync(main)` 일 때 쓴다. found 가 아니면 `!hasGitMarker(self)` 일 때 쓴다. 아니면 지우고 다시 계산한다.
  - 넣을 때: git 이 찾은 값(`.git` 의 부모, `--show-toplevel` 성공)은 found: true. `self` 를 돌려주는 분기는 `!hasGitMarker(self)` 일 때만 found: false 로 넣는다.
- `mainCheckout` 위 주석에 기억 규칙을 두세 줄로 적는다. 찾은 답은 두 폴더가 있을 때, 못 찾은 답은 폴더와 조상에 `.git` 이 없을 때만 다시 쓴다.

### 2. `skills/orch/scripts/lib/paths.ts`

- `const ignoredMemo = new Map<string, 'ignored' | 'no-git'>()`, 열쇠는 `gitMemoKey(top, root)`.
- 저장소 밖·자기 자신 판정 뒤, `rev-parse --git-dir` 앞에서 꺼낸다. `'ignored'` 는 `existsSync(top)` 이면, `'no-git'` 은 `!hasGitMarker(top)` 이면 null 을 돌려준다. 아니면 지운다.
- `--git-dir` 실패: `!hasGitMarker(top)` 이면 `'no-git'` 을 넣고 null. `check-ignore` 0, exclude 에 같은 줄이 있음, 줄을 더함: `'ignored'` 를 넣는다. `--git-path` 실패는 넣지 않는다.
- 머리 주석의 「git 무시」 절에 기억 규칙 한 줄을 더한다.

### 3. 테스트를 더한다(기존 케이스는 고치지 않는다)

`skills/orch/tests/lib-git.spec.ts` 의 `describe('mainCheckout')` 에 더한다. 새 폴더 이름은 기존 테스트와 겹치지 않게 짓는다(`outside` 는 이미 쓴다).

- 없는 경로 `join(tmp, 'later-wt')` 를 물어 그 경로를 받고, 공유 `repo` 에서 `git worktree add -q -b later-wt <경로>` 한 뒤 다시 물으면 `repo` 다. 못 찾은 답이 `.git` 이 생기면 다시 묻는다는 뜻이다.
- `join(tmp, 'plain-parent/sub')` 를 만들어 물으면 그 하위 폴더다. `git init -q plain-parent` 뒤 다시 물으면 `plain-parent` 다. 조상의 `.git` 도 본다는 뜻이다. 이 두 테스트는 `GIT_CEILING_DIRECTORIES` 를 `tmp` 로 두고 끝에 되돌린다.
- 이 테스트만 쓰는 저장소(`tmp` 아래 `moved-main`, 빈 저장소면 `worktree add -b` 가 실패하므로 빈 커밋을 하나 만든다)와 그 바깥(`tmp` 아래) 워크트리를 만들고 물어 `moved-main` 을 받는다. 주 checkout 을 `renameSync` 로 옮긴 뒤 `assert.equal(mainCheckout(wt), wt)` 다.
- 공유 `repo` 의 워크트리를 `tmp` 아래 만들고 물어 `repo` 를 받는다. `git worktree remove --force` 로 지운 뒤 `assert.equal(mainCheckout(wt), wt)` 다. 열쇠의 폴더가 없으면 다시 묻는다는 뜻이다.
- 워크트리에서 물어 `repo` 를 받은 뒤 `process.env.PATH` 를 빈 임시 폴더로 바꿔 git 을 띄울 수 없게 하고 다시 물으면 여전히 `repo` 다. `finally` 에서 PATH 를 되돌린다. 기억이 실제로 쓰인다는 뜻이다(기억이 없으면 git 이 127 로 실패해 워크트리 경로가 나온다).

`skills/orch/tests/lib-paths.spec.ts` 의 ensure 묶음에 더한다.

- `ensure('queue', repo)` 뒤 `ORCH_DIR` 을 `work/orch` 로 바꾸고 다시 `ensure` 하면 exclude 에 `/work/orch/` 도 있다. 열쇠가 루트를 포함한다는 뜻이다.
- `join(tmp, 'plain')` 폴더(git 밖)에 `ensure('queue', plain)` 하면 `plain/.git` 이 없다. `git init -q plain` 뒤 다시 `ensure` 하면 `plain/.git/info/exclude` 에 `/.orch/` 가 한 줄 있다. 저장소 아님을 기억해도 `.git` 이 생기면 다시 묻는다는 뜻이다.

### 4. 버전과 변경 이력

- `skills/orch/SKILL.md` 의 `metadata.version` 을 patch 로 올린다(동작이 바뀌지 않는다, README 「버전과 변경 이력」). 머지 시점의 main 버전 기준으로 정한다.
- `skills/orch/CHANGELOG.md` 에 그 버전 절과 항목 하나를 더한다. 예: 「orch 명령이 같은 실행 안에서 주 checkout 과 .orch 무시 여부를 다시 묻지 않아 git 호출이 준다」. 실측 수치는 적지 않는다.

## 검증

```bash
node --test skills/orch/tests/lib-git.spec.ts skills/orch/tests/lib-paths.spec.ts
node scripts/run-node-tests.ts
test -z "$(git diff --name-only origin/main...HEAD -- skills/orch/tests extensions/work-board/tests skills/inbox/tests | grep -v -e lib-git.spec.ts -e lib-paths.spec.ts)"
test -z "$(git diff origin/main...HEAD -- skills/orch/tests/lib-git.spec.ts skills/orch/tests/lib-paths.spec.ts | grep '^-[^-]')"
python3 -m unittest discover -s scripts/tests
python3 export-only-skills/korean-check/scripts/korean-style-check.py skills/orch/CHANGELOG.md
```

- 두 번째 줄이 600초를 넘기면 `--background` 로 띄우고 출력된 `--wait` 명령을 끝 줄이 나올 때까지 다시 부른다(`.orch/overlay.md`).
- 세 번째 줄: 테스트 파일 가운데 두 lib 테스트 말고 바뀐 것이 없다. 네 번째 줄: 두 lib 테스트는 줄을 더하기만 했다(REQ2).
- 다섯 번째 줄은 CHANGELOG 형식 검사다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ1 | PR 브랜치 | CI 의 `Plugin tests`(node 테스트 포함)와 `Python tests` | 둘 다 통과 | GitHub Actions ubuntu | push | PR 뒤 |
| REQ2 | 기억을 넣은 커밋 | 위 「검증」 의 둘째~넷째 줄 | 실패 0. 세 번째, 네 번째 줄 종료 코드 0 | 로컬 macOS | 없음 | PR 전 |
| REQ3 | 전 커밋(origin/main)과 후 커밋(PR head) | 설계 「측정 방법」 대로 스펙 표의 10개 파일을 전후 번갈아 시간을 재고, preload 로 전체 기동 수와 같은 git 조회 수, 같은 pid 안의 중복 수를 센다 | PR 본문에 파일별 전후 벽시계, 전체 기동 수, 같은 git 조회 수가 있다. `git -C` 형태 같은 git 조회의 같은 pid 중복은 후가 전의 1% 아래이고, 남은 중복은 다시 물은 이유(폴더가 사라지거나 `.git` 이 생김)를 적는다 | 로컬 macOS, 같은 머신 | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/git.ts` | 수정 |
| `skills/orch/scripts/lib/paths.ts` | 수정 |
| `skills/orch/tests/lib-git.spec.ts` | 수정(케이스 추가) |
| `skills/orch/tests/lib-paths.spec.ts` | 수정(케이스 추가) |
| `skills/orch/SKILL.md` | 수정(metadata.version) |
| `skills/orch/CHANGELOG.md` | 수정 |
| `docs/features/test-speed/tasks/git-memo/` | 삭제(계획서는 구현 PR 에서 지운다) |
