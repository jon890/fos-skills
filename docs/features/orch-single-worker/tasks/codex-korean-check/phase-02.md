# Phase 02. worker 워크트리에 한국어 커밋 검사 훅을 건다

**Execution profile**: deep

## 목표

`launch-worker` 가 worker 를 띄우기 전에 그 워크트리에만 걸리는 git 훅 폴더를 만든다. 훅 `pre-commit` 이 phase 01 의 `check.ts --staged` 로 금지어가 든 커밋을 거절하고, 저장소가 원래 쓰던 훅은 그대로 이어 부른다. 에이전트 종류와 대상 저장소를 보지 않는다.

**범위 외**: 선택 표와 「한국어 문서면 Claude」 기준(`skills/orch/references/agent-selection.md`)은 고치지 않는다. 다음 PR 의 일이다. Codex 매니페스트(`.codex-plugin/plugin.json`)와 Claude 훅(`skills/orch/hooks/`)도 고치지 않는다.

## 컨텍스트

- `skills/orch/scripts/worker/launch-worker.ts` 는 워크트리를 만들거나 확인한 직후 `--agent codex` 일 때 `configureSshAgent(worktree, process.env.SSH_AUTH_SOCK)` 를 부른다. 같은 자리에서 에이전트와 상관없이 이번 설치를 부른다.
- `skills/orch/scripts/lib/ssh-agent.ts` 가 워크트리 단위 git 설정의 선례다. `extensions.worktreeConfig` 가 꺼져 있으면 공유 설정(`git config --local`)에서 켜고 `git config --worktree` 로 쓴다. 공유 설정에 `core.worktree` 가 있거나 `core.bare` 가 true 면 켜지 않는다.
- git 은 `core.hooksPath` 가 있으면 그 폴더의 훅만 부르고 `<공통 git 폴더>/hooks` 는 보지 않는다. 이 저장소의 `commit-msg`, `pre-commit`, `post-commit`(`githooks/`, `scripts/install-hooks.ts` 가 공통 git 폴더의 `hooks/` 에 링크)이 worker 워크트리에서 계속 돌려면 새 훅이 이어 불러야 한다.
- 연결된 워크트리의 git 관리 폴더는 `git rev-parse --path-format=absolute --git-dir` 이고(`<공통 git 폴더>/worktrees/<id>`), `git worktree remove` 가 폴더째 지운다. 주 checkout 은 이 값이 `--git-common-dir` 과 같다.
- 훅은 워크트리 최상위를 작업 디렉터리로 불린다. git 은 `git commit -a` 같은 커밋에서 `GIT_INDEX_FILE` 을 임시 인덱스로 넘긴다.
- 짧은 출력(`ORCH_OUTPUT=short`)은 대문자 낱말로 시작하는 판정 줄만 남긴다(`skills/orch/scripts/lib/output.ts`). `launch-worker.ts` 의 `out()` 이 이 규칙을 탄다.
- orch 는 다른 스킬을 import 하지 않는다. korean-check 는 같은 번들의 형제 폴더 `export-only-skills/korean-check` 에서 파일로 복사한다. `lib/commit-check.ts` 에서 번들 루트는 `import.meta.dirname` 기준 `../../../..` 이다.
- 저장소의 JS 파일은 `scripts/runtime-policy.json` 의 `entry_js` 에 적은 것만 허용된다. 줄 머리의 `const MIN_NODE = [a, b]` 는 `min_node`(`[24, 0]`)와 같아야 한다.

**요구사항**: REQ1

**근거 문서**: `docs/features/orch-single-worker/spec.md`, `docs/features/orch-single-worker/design.md` 의 「인터페이스와 데이터」 와 「실패와 일관성」, `docs/adr/036-worker-commit-korean-check.md`, `docs/code-architecture.md` 의 「저장소 실행 규칙」

## 의도 메모

- 훅 본체를 플러그인 번들에 두고 링크하지 않는다. 설치 경로에 버전이 들어 있어 갱신 뒤 링크가 끊기면 git 은 훅이 없는 것으로 보고 조용히 지나간다. 본체와 검사기를 워크트리 git 관리 폴더에 복사한다.
- 훅 본체는 타입 문법 없는 `.mjs` 한 파일이다. 확장자 없는 파일이나 `.ts` 는 대상 저장소 `package.json` 의 `type` 에 따라 CommonJS 로 읽힐 수 있다.
- 훅 이름마다 파일을 복사하지 않고 `dispatch.mjs` 를 가리키는 심볼릭 링크를 둔다. 본체는 불린 경로의 파일 이름으로 훅 이름을 안다.
- 검사기가 돌지 못하면 커밋을 막지 않는다(`githooks/commit-msg.ts` 와 같은 규칙). node 는 잡지 않은 예외에도 종료 코드 1 을 내므로, 종료 코드 1 만으로 거절하지 않고 출력에 금지어 발견 줄이 있을 때만 거절한다.
- 검사기 사본(`.ts`)은 가장 가까운 `package.json` 의 `type` 을 따라간다. 사본이 대상 저장소 안(`.git` 아래)에 있어 그대로 두면 대상 저장소의 `package.json` 을 읽는다. `type` 이 `commonjs` 면 문법 오류로 죽고, 없으면 커밋마다 Node 경고가 나온다. 훅 폴더에 `{"type":"module"}` 인 `package.json` 을 둔다(이 저장소의 `bin/package.json` 과 같은 용도).
- 주 checkout 에는 걸지 않는다. 사용자가 직접 하는 커밋을 바꾸지 않는다.
- 끄는 설정 키는 만들지 않는다.

## 작업 항목

### 1. `skills/orch/scripts/lib/worktree-config.ts` 를 만들고 `lib/ssh-agent.ts` 가 쓰게 한다

- `export type WorktreeConfigResult = { ok: true } | { ok: false; status: 'skipped' | 'failed'; reason: string }`
- `export function setGitConfig(worktree: string, args: string[]): RunResult`. `git -C <worktree> config <args>` 를 부르고, 실패했는데 stderr 에 `could not lock config file` 이 있으면 100ms 쉬고 다시 해 모두 세 번까지 한다. 마지막 결과를 돌려준다. worker 여럿을 함께 띄우면 공유 설정 파일의 잠금이 겹친다. 쉬는 것은 `Atomics.wait` 로 한다(동기 함수다).
- `export function enableWorktreeConfig(worktree: string): WorktreeConfigResult`. `lib/ssh-agent.ts` 의 `configureSshAgent` 안에 있는 판정을 그대로 옮긴다. `git config --local --type=bool --get extensions.worktreeConfig` 가 `true` 면 `{ ok: true }`. 아니면 공유 설정에 `core.worktree` 가 있을 때 `skipped`(`공유 설정에 core.worktree 가 있어 worktreeConfig 를 켜지 않는다`), `core.bare` 가 true 일 때 `skipped`(`공유 설정의 core.bare 가 true 라 worktreeConfig 를 켜지 않는다`), 켜기에 실패하면 `failed`(`extensions.worktreeConfig 를 켜지 못했다: <stderr>`)다. 켜는 쓰기는 `setGitConfig` 로 한다. 잠금이 겹칠 때 다시 하는 것 말고는 지금 동작과 같다.
- `configureSshAgent` 는 그 자리에서 `enableWorktreeConfig` 를 부르고 `ok` 가 아니면 같은 `status` 와 `reason` 을 돌려준다. 반환 값과 문구는 지금과 같아야 한다(`skills/orch/tests/lib-ssh-agent.spec.ts` 가 그대로 통과한다).
- 머리 주석에 이 모듈이 판정 한 벌을 소유하고 `lib/ssh-agent.ts`, `lib/commit-check.ts` 가 쓴다고 적는다. `lib/ssh-agent.ts` 머리 주석의 해당 문장은 이 모듈을 가리키게 고친다.

### 2. `skills/orch/githooks/dispatch.mjs` 를 만든다

타입 문법 없는 ESM 이고 Node 내장 모듈만 쓴다. 첫 줄은 `#!/usr/bin/env node`, 줄 머리에 `const MIN_NODE = [24, 0]` 를 둔다. 머리 주석이 동작과 종료 코드를 소유한다.

- 훅 이름은 `basename(process.argv[1])`, 훅 폴더는 `dirname(realpathSync(process.argv[1]))` 이다.
- 훅 이름이 `pre-commit` 이면 한국어 검사를 한다.
  - `git rev-parse --absolute-git-dir` 로 얻은 폴더에 `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply` 가운데 하나라도 있으면 검사하지 않는다.
  - 훅 폴더의 `korean-check/scripts/check.ts` 가 없으면 stderr 에 `orch 커밋 검사: 한국어 검사기 사본이 없어 점검을 건너뛴다` 를 내고 이어 간다.
  - `process.versions.node` 가 `MIN_NODE` 보다 낮으면 `orch 커밋 검사: Node <버전> 은 한국어 검사기를 돌리지 못해 점검을 건너뛴다` 를 내고 이어 간다.
  - `spawnSync(process.execPath, [check.ts, '--staged'], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024 })` 로 부르고 stdout 과 stderr 를 이어 앞뒤 공백을 뗀 글을 보고로 쓴다. `env` 는 `process.env` 에서 `KOREAN_STYLE_RULES` 와 `KOREAN_CHECK_ALLOW` 를 지운 것이다. 사본의 규칙과 저장소의 예외 파일을 읽게 한다.
  - 종료 코드가 1 이고 보고에 `: 금지어 "` 가 있다: 보고와 아래 두 줄을 stderr 에 내고 1 로 끝난다. 원래 훅은 부르지 않는다.
    `한국어 문서에 금지어가 있어 커밋하지 않았다. 권장 표현으로 고쳐 다시 스테이징한 뒤 커밋한다.`
    `--no-verify 로 넘기지 않는다. 고유명사라 그대로 써야 하면 .claude/korean-check-allow.txt 에 적는다.`
  - 종료 코드 0: 보고가 있으면 stderr 에 내고 `위 경고는 커밋을 막지 않는다. 문맥을 보고 고칠지 판단한다.` 를 붙인다.
  - 그 밖(2, 신호, 실행 실패, 발견 줄 없는 1): `orch 커밋 검사: 한국어 검사기가 돌지 못해 점검을 건너뛴다` 와 보고를 내고 이어 간다.
- 그다음 원래 훅을 이어 부른다. 모든 훅 이름에서 한다.
  - 원래 훅 폴더: `git config --show-scope --type=path --get-all core.hooksPath` 의 줄(`범위<TAB>값`) 가운데 범위가 `system`, `global`, `local` 인 마지막 줄의 값이다. 상대 경로면 `process.cwd()` 기준으로 푼다. 그런 줄이 없으면 `git rev-parse --path-format=absolute --git-common-dir` 의 `hooks` 폴더다.
  - 그 폴더의 실체 경로가 훅 폴더와 같거나, 그 안에 훅 이름의 파일이 없거나 실행 권한이 없으면 0 으로 끝난다.
  - 있으면 `spawnSync(<그 파일>, process.argv.slice(2), { stdio: 'inherit' })` 로 부르고 그 종료 코드로 끝난다. 신호로 끝나면 128 더하기 신호 번호다. 실행 오류가 `ENOEXEC`(shebang 없는 훅)면 git 처럼 `/bin/sh <그 파일> <인자>` 로 한 번 더 부른다. 그 밖의 실행 오류는 이유를 stderr 에 내고 1 이다.

### 3. `skills/orch/scripts/lib/commit-check.ts` 를 만든다

- `export const HOOK_NAMES`: `applypatch-msg`, `pre-applypatch`, `post-applypatch`, `pre-commit`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-rebase`, `post-checkout`, `post-merge`, `pre-push`, `post-rewrite`, `pre-auto-gc`.
- `export type CommitCheckResult = { status: 'set'; hooks: string } | { status: 'skipped'; reason: string; quiet: boolean } | { status: 'failed'; reason: string }`
- `export function installCommitCheck(worktree: string, source: { checker?: string; dispatch?: string } = {}): CommitCheckResult`. `source.checker` 의 기본값은 번들의 `export-only-skills/korean-check`, `source.dispatch` 의 기본값은 `skills/orch/githooks/dispatch.mjs` 다. 테스트가 없는 경로를 넣어 건너뜀을 본다.
  1. `git rev-parse --is-inside-work-tree` 가 `true` 가 아니면 `skipped`(quiet, `git 작업 트리가 아니다`).
  2. `--git-dir` 과 `--git-common-dir`(둘 다 `--path-format=absolute`)의 실체 경로가 같으면 `skipped`(quiet 아님, `주 checkout 이라 걸지 않는다`).
  3. `<checker>/scripts/check.ts`, `<checker>/references/korean-style.md`, `<dispatch>` 가운데 없는 파일이 있으면 `skipped`(`한국어 검사기 번들이 없다: <없는 경로>`).
  4. 훅 폴더는 `<git-dir>/orch-hooks` 다. `git config --worktree --get core.hooksPath` 가 성공했고 값이 있고 그 값이 훅 폴더와 다르면 `skipped`(`워크트리에 core.hooksPath 가 이미 있다: <값>`).
  5. `enableWorktreeConfig(worktree)` 가 `ok` 가 아니면 그 `status` 와 `reason` 을 돌려준다(`skipped` 면 quiet 는 false).
  6. `<git-dir>/orch-hooks.tmp-<pid>` 를 비우고 만든다. `dispatch.mjs` 를 복사해 모드를 `0o755` 로 하고, `{"type":"module"}` 한 줄인 `package.json` 을 쓰고, `<checker>/scripts` 와 `<checker>/references` 를 `korean-check/scripts`, `korean-check/references` 로 폴더째(`cpSync` recursive) 복사한다. 파일을 골라 복사하지 않는다. 검사기가 읽는 파일이 늘어도 이 목록을 고치지 않게 하려는 것이다. `HOOK_NAMES` 마다 `dispatch.mjs` 를 가리키는 상대 심볼릭 링크를 만든다. 기존 훅 폴더가 있으면 `<git-dir>/orch-hooks.old-<pid>` 로 이름을 바꾼 뒤 임시 폴더를 훅 폴더 이름으로 바꾸고, 옛 폴더를 지운다. 지우고 나서 바꾸면 그 사이에 훅 폴더가 없어 git 이 훅을 부르지 않는다.
  7. `setGitConfig(worktree, ['--worktree', 'core.hooksPath', <훅 폴더 절대경로>])` 로 쓴다.
  8. 6, 7 에서 예외나 git 실패가 나면 임시 폴더를 지우고 `failed`(이유)다. 성공하면 `{ status: 'set', hooks }`.
- 머리 주석에 훅 폴더의 구성, 걸지 않는 경우, 이어 부르지 않는 훅(`HOOK_NAMES` 밖)과 푸는 법(`git config --worktree --unset core.hooksPath`)을 적는다.

### 4. `skills/orch/scripts/worker/launch-worker.ts` 가 설치를 부른다

- `configureSshAgent` 블록 바로 앞에서 `const check = installCommitCheck(worktree)` 를 부른다. 에이전트를 보지 않는다. 원격 환경 옵션이 있으면(`remoteSelectorOf(passthru)` 가 값을 내면) 부르지 않고 `out('COMMIT-CHECK-SKIP 원격 환경의 worker 라 걸지 않는다')` 를 낸다. 그 worker 는 다른 서버의 셸에서 떠서 이 머신의 경로를 박은 훅 폴더를 쓰지 못한다. `remoteSelectorOf` 호출은 지금 이 자리보다 앞(인자 검사 부분)에 있으니 그 값을 다시 쓴다.
  - `set`: `out('한국어 커밋 검사를 걸었다: ' + check.hooks)`. 판정 줄이 아니라 짧은 출력에서는 나오지 않는다.
  - `skipped` 이고 quiet 가 아니면 `out('COMMIT-CHECK-SKIP ' + check.reason)`. 주 checkout 에 띄운 경우도 여기다. 그 worker 의 커밋은 검사받지 않으므로 코디네이터가 알아야 한다.
  - `failed`: `out('COMMIT-CHECK-FAIL ' + check.reason)`.
  - 어느 결과든 띄우기를 이어 간다.
- 머리 주석의 「2-0」 앞에 이 단계를 적는다. 짧은 출력에 남는 판정 줄 목록(지금 `REVIEW-*, SSH-AGENT` 를 적은 문장)에 `COMMIT-CHECK-*` 를 더한다.

### 5. `scripts/runtime-policy.json` 의 `entry_js` 에 `skills/orch/githooks/dispatch.mjs` 를 더한다

### 6. 이 phase 를 검증하는 테스트

`skills/orch/tests/lib-commit-check.spec.ts` 를 만든다. `skills/orch/tests/lib-ssh-agent.spec.ts` 처럼 임시 폴더에 `git init` 한 저장소와 `git worktree add` 한 워크트리를 만들고, 전역 git 설정을 끊는 환경 변수(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, 작성자 네 변수)를 프로세스 환경에 두었다가 되돌린다. 커밋은 실제 `git commit` 으로 한다.

- 걸기: `installCommitCheck(wt)` 가 `set` 이고 `git -C wt config --worktree --get core.hooksPath` 가 `<git-dir>/orch-hooks` 다. 주 checkout 의 `git config --get core.hooksPath` 는 없다(종료 코드 1). 다른 워크트리에도 없다. 훅 폴더에 `dispatch.mjs`, `pre-commit` 링크, `korean-check/scripts/check.ts`, `korean-check/references/korean-style.md` 가 있다.
- 거절: 워크트리에 `결과를 스윕한다.` 가 든 `doc.md` 를 스테이징하고 커밋하면 종료 코드가 0 이 아니고, stderr 에 `doc.md:1`, `권장 표현: "스윕"`, `커밋하지 않았다` 가 있고, `git log` 에 그 커밋이 없다.
- 통과: 경고만 있는 줄(`배포 + 검증을 쓴다.`)은 커밋되고 stderr 에 경고 줄과 `커밋을 막지 않는다` 가 있다. 깨끗한 `.md` 와 `.md` 가 아닌 파일(금지어가 든 `a.txt`)은 훅 출력 없이 커밋된다.
- 기존 줄: 주 checkout 에서 금지어가 든 `doc.md` 를 먼저 커밋해 두고 만든 워크트리에서 그 파일에 깨끗한 줄을 더해 커밋하면 된다.
- 이어 부르기: 공통 git 폴더의 `hooks/pre-commit` 과 `hooks/commit-msg` 에 표지 파일을 쓰는 실행 파일(`#!/bin/sh`, 받은 인자를 표지 파일에 기록)을 두면 워크트리 커밋에서 둘 다 불리고 `commit-msg` 는 메시지 파일 경로를 인자로 받는다. 원래 `pre-commit` 이 1 로 끝나면 커밋이 거절된다. 공유 설정에 `core.hooksPath` 를 상대 경로(`.hooks`)로 두고 워크트리의 `.hooks/pre-commit` 을 두면 그 훅이 불린다. 설치한 뒤에 만든 원래 훅도 불린다.
- 순서: 금지어로 거절될 때 원래 `pre-commit` 의 표지 파일은 생기지 않는다.
- 머지 중: 워크트리에서 충돌 없는 `git merge --no-ff --no-commit <금지어가 든 .md 를 더한 브랜치>` 뒤 `git commit --no-edit` 이 된다.
- 다시 걸기: 두 번 불러도 `set` 이고 커밋 거절이 그대로 동작한다. 훅 폴더의 `korean-check/references/korean-style.md` 를 지운 뒤 다시 걸면 복구된다.
- 건너뜀: 주 checkout 은 `skipped` 이고 quiet 가 아니며 설정이 생기지 않는다. git 저장소가 아닌 폴더는 `skipped` quiet 다. `source.checker` 에 없는 경로를 주면 `skipped` 이고 quiet 가 아니다. 워크트리에 미리 `git config --worktree core.hooksPath /elsewhere` 를 두면 `skipped` 이고 값이 그대로다.
- 고장: 훅 폴더의 `korean-check` 를 지운 뒤 금지어가 든 `.md` 를 커밋하면 커밋되고 stderr 에 `점검을 건너뛴다` 가 있다. 훅 폴더의 `korean-check/scripts/check.ts` 를 `throw new Error("x")` 한 줄로 바꾼 뒤(종료 코드 1, 발견 줄 없음) 커밋해도 커밋되고 같은 안내가 나온다.
- 대상 저장소의 `type`: 저장소 루트에 `{"type":"commonjs"}` 인 `package.json` 을 커밋해 둔 저장소의 워크트리에서 금지어 커밋은 발견 줄과 함께 거절되고 깨끗한 `.md` 커밋은 된다. `{"name":"x"}` 만 있는 저장소에서 깨끗한 `.md` 를 커밋하면 stderr 에 `MODULE_TYPELESS_PACKAGE_JSON` 이 없다.
- 환경 변수: `KOREAN_STYLE_RULES` 를 없는 경로로 준 채 금지어를 커밋해도 사본의 규칙으로 거절된다.
- 자기 자신: 공유 설정의 `core.hooksPath` 를 그 워크트리의 훅 폴더로 둔 채 커밋해도 끝난다(자신을 다시 부르지 않는다).
- 정리: `git worktree remove` 뒤 `<공통 git 폴더>/worktrees/<id>` 가 없다.
- 잠금: 공통 git 폴더에 `config.lock` 파일을 미리 만들어 두고 부르면 `failed` 이고 이유에 `could not lock config file` 이 있다. 잠금 파일을 지우고 다시 부르면 `set` 이다.
- shebang 없는 원래 훅: 공통 git 폴더의 `hooks/pre-commit` 을 shebang 없이 `echo ran > <표지 파일>` 한 줄로 두고 실행 권한을 주면 커밋할 때 표지 파일이 생긴다.

`skills/orch/tests/launch-worker.spec.ts` 를 고친다.

- `describe` 가 `git worktree add` 로 만든 워크트리를 쓰는 SSH 묶음의 「claude 면 설정하지 않는다」 사례에서 `extensions.worktreeConfig` 가 없다는 단언을 뺀다. 이제 에이전트와 상관없이 커밋 검사가 그 확장을 켠다. `core.sshCommand` 가 없다는 단언은 남긴다.
- 같은 묶음에 사례를 더한다. claude 로 띄워도 `git -C wt config --worktree --get core.hooksPath` 가 `orch-hooks` 로 끝나고 stdout 에 `한국어 커밋 검사를 걸었다` 가 있다. `ORCH_OUTPUT=short` 로 띄우면 그 줄이 없다. 워크트리에 사용자가 둔 `core.hooksPath` 가 있으면 stdout 에 `COMMIT-CHECK-SKIP` 이 있고 종료 코드는 0 이다.
- 원격 환경 옵션을 주는 기존 묶음(`--on` 을 쓰는 사례)에 `assert.match(r.stdout, /COMMIT-CHECK-SKIP 원격/)` 를 더한다. 그 묶음은 stdout 을 단언하지 않아 이 분기를 빠뜨려도 통과한다.
- `git init` 한 주 checkout 을 `--worktree` 로 주는 기존 사례는 stdout 에 `COMMIT-CHECK-SKIP 주 checkout 이라 걸지 않는다` 한 줄이 더 나온다. 줄 수나 전체 출력을 고정한 단언이 이 줄로 깨지면 그 단언에 이 줄을 더한다. 사례의 뜻은 바꾸지 않는다.

### 7. 문서와 변경 조각

- `skills/orch/references/launch.md` 의 「띄운 직후 확인」 에 문단을 더한다. worker 워크트리에 한국어 커밋 검사가 걸리고 금지어가 든 `.md` 커밋이 거절된다는 것, `COMMIT-CHECK-SKIP`, `COMMIT-CHECK-FAIL` 이 나오면 그 워크트리의 커밋은 검사받지 않으니 이유를 보고 조치한다는 것, 이미 떠 있는 worker 는 `--worktree` 로 다시 띄울 때 걸린다는 것이다. 판정과 훅 폴더 구성은 `lib/commit-check.ts` 머리 주석을 가리킨다.
- `docs/code-architecture.md` 의 「모듈 책임」 표에 `skills/orch/githooks/` 행을 더하고, 「orch 코어와 핸들러」 의 「배치」 코드 블록에 `lib/commit-check.ts`, `lib/worktree-config.ts`, `githooks/dispatch.mjs` 줄을 더한다.
- `skills/orch/README.md` 첫 문단의 「worker 의 워크트리에는 `gh pr merge` 를 막는 권한 규칙이 들어간다」 뒤에 한국어 문서의 금지어를 커밋 전에 막는 git 훅도 걸린다는 문장을 더한다.
- `skills/orch/changes/codex-korean-check.minor.md` 를 만든다. 내용은 `- ` 줄 둘이다. 「worker 워크트리에 한국어 커밋 검사가 걸려, 금지어가 든 `.md` 를 커밋하면 권장 표현과 함께 거절된다. Codex worker 도 같다」 와 「검사를 걸지 못하면 `orch worker launch` 가 `COMMIT-CHECK-SKIP`, `COMMIT-CHECK-FAIL` 줄로 알린다」.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-commit-check.spec.ts skills/orch/tests/lib-ssh-agent.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/script-folders.spec.ts
node scripts/run-tests.ts --tsc-only
node scripts/runtime-policy.ts
node scripts/run-tests.ts scripts/tests
node export-only-skills/korean-check/scripts/check.ts --diff origin/main
```

기대값: 다섯 명령 모두 종료 코드 0. `script-folders.spec.ts` 는 문서와 주석이 가리키는 「파일 맨 위 설명의 절」 이 실제로 있는지 본다. 파일 인자를 준 실행은 tsc 를 돌리지 않아 `--tsc-only` 를 따로 돈다. `runtime-policy.ts` 는 `NEW`, `STALE`, `MIN-NODE` 줄을 내지 않는다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/worktree-config.ts` | 신규 |
| `skills/orch/scripts/lib/ssh-agent.ts` | 수정 (판정을 `worktree-config.ts` 로 옮김) |
| `skills/orch/githooks/dispatch.mjs` | 신규 |
| `skills/orch/scripts/lib/commit-check.ts` | 신규 |
| `skills/orch/scripts/worker/launch-worker.ts` | 수정 (설치 호출과 머리 주석) |
| `scripts/runtime-policy.json` | 수정 (`entry_js`) |
| `skills/orch/tests/lib-commit-check.spec.ts` | 신규 |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 |
| `skills/orch/references/launch.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `skills/orch/README.md` | 수정 |
| `skills/orch/changes/codex-korean-check.minor.md` | 신규 |
