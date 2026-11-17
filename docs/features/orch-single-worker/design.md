# orch 단일 worker 기술 설계

이 문서는 [스펙](spec.md)의 PR1(REQ1)과 PR2(REQ2~REQ9)를 설계한다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | `launch-worker` 가 worker 를 띄우기 전에 그 워크트리에만 걸리는 git 훅 폴더를 만든다(`lib/commit-check.ts`). 훅 `pre-commit` 이 korean-check 의 새 모드 `check.ts --staged` 로 스테이징한 `.md` 의 더한 줄을 검사한다. 금지어가 있으면 발견 줄과 권장 표현을 내고 커밋을 거절하고, 경고만 있으면 보여 주고 커밋한다. Codex 매니페스트에는 hook 을 더하지 않아 신뢰 확인 화면이 뜨지 않는다([ADR-036](../../adr/036-worker-commit-korean-check.md)) |
| REQ2 | `agent-selection.md` 의 모델 표를 행별 에이전트·모델·effort 원본으로 읽는다. `lib/selection.ts` 가 하나의 worker 와 정확히 대조한다 |
| REQ3 | `lib/spec.ts` 는 비교 칸 없는 줄을 읽고, `selectionVerdict` 가 새 지시서의 비교 칸을 거절한다. spec-lint 와 launch 가 같은 검사를 쓴다 |
| REQ4 | 에이전트·모델·effort 어느 값이 달라도 후보 밖 이유를 요구한다. `candidateOverrideOf` 가 실제 선택 전체와 이유를 내어 기존 LAUNCH-EFFECTIVE 와 launch-history 의 effective.candidateOverride 에 남긴다 |
| REQ5 | 새 지시서의 experiment 줄을 거절한다. 기존 지시서와 옛 이력을 읽는 파서는 남기되 새 실행의 실험 배정은 없앤다 |
| REQ6 | agent-selection 과 spec-writing, SKILL 과 템플릿에서 제공자 우선순위와 번갈아 배정하는 규칙을 없앤다 |
| REQ7 | review-spec 의 다른 제공자 선택을 재사용한다. review 행은 그 결과인 sol medium 또는 Sonnet medium 만 받으며 보안 리뷰는 별도 고정 행을 따른다 |
| REQ8 | PR2 머지 뒤 코디네이터가 스펙에 정한 대조 일을 보드에 만든다. worker 는 보드를 고치지 않는다 |
| REQ9 | 행 선택 기준은 agent-selection 이 소유한다. 작업 난도와 이유의 타당성은 코디네이터가 판단하며 검사기는 문구로 난도를 추측하지 않는다 |

## 책임과 경계

PR2 에서는 `lib/spec.ts` 의 줄 읽기와 `lib/selection.ts` 의 선택 검사를 재사용한다. 모델 표는 `id | Task 성격 | 에이전트 | 모델 | effort` 열을 쓰며 값은 백틱으로 감싼다. 각 행은 에이전트·모델·effort 를 명시하며, review 는 구현 제공자에 따른 두 경우를 명시한다. 기본 effort 는 숫자 단계로 바꾸지 않고 `기본` 그대로 비교한다.

`spec-lint` 는 `--active` 지시서를 선택 검사에서 제외한다. `launch-worker` 가 같은 지시서와 실행 설정의 이어하기를 확인한 경우에도 새 규칙을 적용하지 않는다. 지시서나 실행 설정이 바뀐 재시도는 새 규칙을 따른다. 한도 표는 바꾸지 않으며 그 표로 바꾸는 경우도 후보 밖 이유를 요구한다.

검사는 에이전트 종류를 보지 않는다. git 이 커밋할 때 훅을 부르므로 Codex, Claude, 그 밖의 에이전트가 같은 검사를 받는다.

| 모듈 | 책임 |
| --- | --- |
| `export-only-skills/korean-check/scripts/check-diff.ts` 의 `--staged` | 스테이징한 `.md` 에서 이번에 더한 줄의 발견만 내고 종료 코드로 금지어 유무를 알린다. 금지어마다 매핑 표의 권장 표현 줄을 붙인다. 무엇이 금지어이고 경고인지는 지금처럼 두 검사기가 소유한다 |
| `export-only-skills/korean-check/scripts/check.ts` | `--staged` 를 `check-diff.ts` 로 넘기는 진입 |
| `skills/orch/githooks/dispatch.mjs` | 워크트리 훅 폴더에 복사되는 훅 본체. `pre-commit` 이면 검사기를 부르고, 모든 훅 이름에서 저장소가 원래 쓰던 훅을 이어 부른다 |
| `skills/orch/scripts/lib/commit-check.ts` | 워크트리에 훅 폴더를 만들고 워크트리 단위 설정 `core.hooksPath` 를 그 폴더로 둔다. 이어 부를 훅 이름 목록(`HOOK_NAMES`)을 소유한다 |
| `skills/orch/scripts/lib/worktree-config.ts` | `extensions.worktreeConfig` 를 켜는 판정 한 벌. 지금 `lib/ssh-agent.ts` 안에 있는 것을 꺼내 두 곳이 함께 쓴다 |
| `skills/orch/scripts/worker/launch-worker.ts` | 워크트리를 만들거나 확인한 직후 `installCommitCheck` 를 부르고 결과 줄을 낸다 |

의존 방향은 orch 에서 korean-check 로만 간다. orch 는 korean-check 를 import 하지 않고, 같은 번들의 형제 폴더 `export-only-skills/korean-check` 의 `scripts/` 와 `references/` 를 폴더째 복사한다(`docs/code-architecture.md` 「저장소 실행 규칙」 의 import 범위). 파일을 골라 복사하지 않으므로 검사기가 읽는 파일이 늘어도 orch 를 고치지 않는다.
korean-check 는 orch 를 모른다. `--staged` 는 어느 저장소의 커밋 훅에서도 쓸 수 있는 일반 모드다.

git 훅은 Claude 실행 훅(`skills/orch/hooks/`)과 다른 폴더 `skills/orch/githooks/` 에 둔다. 저장소 루트가 `githooks/` 와 플러그인 훅을 나눈 것과 같은 구분이다([ADR-021](../../adr/021-skill-directory-layout.md)의 「스킬 전용 코드·훅은 소유 스킬 안에 둔다」).
`dispatch.mjs` 는 `scripts/runtime-policy.json` 의 `entry_js` 에 올리고, 줄 머리의 `const MIN_NODE = [24, 0]` 로 저장소의 최소 Node 버전과 맞춘다.

걸리는 범위는 orch 가 이 머신에서 띄우는 worker 의 연결된 워크트리다. 주 checkout 에는 걸지 않는다. 사용자가 직접 하는 커밋의 동작을 바꾸지 않으려는 것이다. 원격 환경 옵션(`--on`, `--environment`, `--pairing-code`)으로 띄우는 worker 에는 걸지 않고 `COMMIT-CHECK-SKIP` 으로 알린다. 그 worker 는 다른 서버의 셸에서 떠서 이 머신의 경로를 박은 훅 폴더를 쓰지 못한다.

## 인터페이스와 데이터

PR2 의 `candidateOverride` 는 기존 `row`, `model`, `reason` 을 유지하고 `agent`, `effort` 를 항상 기록한다. effort 가 다른 경우에는 기존 `effortLimit` 키에 행의 effort 를 남긴다. 이 객체는 출력과 정리용 기록, 영구 이력의 `effective.candidateOverride` 에 같은 값으로 둔다. 타입은 `lib/launched.ts` 의 Effective 에 더하고 `docs/data-schema.md` 에서 이 설계를 연결한다. 키를 더하는 방식이라 옛 이력을 읽는 쪽은 그대로 동작한다. review 의 원래 제공자는 `orch spec review` 가 PR 브랜치의 이력에서 찾으며, 일반 선택 검사에서는 구현 정보를 추측하지 않는다.

### `check.ts --staged`

```
node check.ts --staged        # cwd: 검사할 저장소 안
```

- 대상은 인덱스에 더했거나 바꿨거나 이름을 바꿨거나 종류가 바뀐 `.md` 다. 심볼릭 링크와 서브모듈 항목은 뺀다. 매핑 표를 가진 문서(규칙 파일과 그 사본)도 뺀다. 훅은 검사기 사본의 규칙을 쓰므로 대상 저장소의 규칙 파일을 내용으로 알아본다.
- 작업 트리 파일이 아니라 스테이징된 내용을 읽는다. 스테이징한 뒤 고친 내용이 섞이지 않고, `git commit -a` 처럼 git 이 임시 인덱스(`GIT_INDEX_FILE`)를 쓰는 커밋에서도 커밋될 내용과 검사 내용이 같다.
- 판정하는 줄은 `HEAD` 와 인덱스 사이에서 더하거나 바꾼 줄이다. 새 파일과 첫 커밋(HEAD 없음)은 모든 줄이고, 이름만 바꾼 파일은 바뀐 줄만이다. 기존 줄의 발견은 내지 않는다.
- 코드 블록과 frontmatter 판정은 `--diff` 처럼 파일 전체로 한다. 스테이징된 내용을 임시 폴더에 같은 상대 경로로 풀어 두 검사기를 돌리고, 발견 줄의 경로는 저장소 루트 기준이다.
- git 명령은 모두 저장소 안에서 부른다. 훅 환경에는 `GIT_DIR` 이 들어 있어 임시 폴더에서 git 을 부르면 실제 저장소에 닿는다. 임시 폴더에서는 검사기만 돌린다.
- 예외 파일 `.claude/korean-check-allow.txt` 는 지금과 같은 규칙으로 읽힌다. 스테이징된 내용이 아니라 작업 트리의 것이다. 대상 파일의 폴더에서 저장소 루트까지 있는 예외 파일을 임시 폴더의 같은 자리에 복사하고, 임시 폴더 루트에 `.git` 폴더를 만들어 찾기가 그 밖으로 올라가지 않게 한다.
- 출력은 이번 변경의 발견 줄과, 금지어마다 `권장 표현: "<금지어>" → <매핑 표의 권장 열>` 한 줄이다. `DB 표` 같은 문맥 패턴은 발견 줄에 고칠 말이 이미 있어 권장 표현 줄을 더하지 않는다. 발견이 없으면 아무것도 내지 않는다.
- 종료 코드는 `--diff` 와 같다. 0 은 금지어 없음(경고가 있어도 0), 1 은 더한 줄에 금지어, 2 는 돌지 못함이다. 금지어 발견은 줄의 `: 금지어 "` 꼴로 알아본다. 경로에 그 낱말이 든 파일의 경고가 거절로 바뀌지 않게 하려는 것이다.
- 검사기 자식이 죽은 것을 「발견 없음」 으로 읽지 않는다. 띄우지 못했거나 신호로 끝났거나 금지어 발견 줄 없이 1 로 끝나면 돌지 못한 것(2)이다. 경로가 많으면 나눠 넘긴다.
- `--base` 나 파일 인자와 함께 주면 사용법 오류(2)다.

권장 표현은 `korean-style-check.ts` 에 더하는 `loadAdvice(rules)` 가 매핑 표의 셋째 열에서 읽는다. 기존 검사기의 출력 줄은 바꾸지 않는다.

### 훅 폴더

```
<공통 git 폴더>/worktrees/<워크트리 id>/orch-hooks/
  dispatch.mjs                          훅 본체
  package.json                          {"type":"module"}
  pre-commit -> dispatch.mjs            훅 이름마다 심볼릭 링크
  commit-msg -> dispatch.mjs
  ...
  korean-check/scripts/                 검사기 사본
  korean-check/references/
```

- 워크트리의 git 관리 폴더 안에 둔다. 작업 트리에 추적하지 않는 파일이 생기지 않고, `git worktree remove` 가 폴더째 지운다.
- 검사기는 그 순간의 번들에서 복사한다. 플러그인 설치 경로에는 버전이 들어 있어 갱신하면 바뀌므로, 훅이 번들 경로를 가리키면 갱신 뒤 검사가 조용히 꺼진다. 사본은 워크트리를 다시 띄울 때(`--worktree`) 새로 만든다.
- `package.json` 은 검사기 사본(`.ts`)이 대상 저장소 `package.json` 의 `type` 을 따라가지 않게 한다. 없으면 CommonJS 저장소에서 검사기가 문법 오류로 죽고, `type` 이 없는 저장소에서는 커밋마다 Node 경고가 섞인다. 이 저장소의 `bin/package.json` 이 같은 용도다.
- 이어 부를 훅 이름은 `applypatch-msg`, `pre-applypatch`, `post-applypatch`, `pre-commit`, `pre-merge-commit`, `prepare-commit-msg`, `commit-msg`, `post-commit`, `pre-rebase`, `post-checkout`, `post-merge`, `pre-push`, `post-rewrite`, `pre-auto-gc` 다. `reference-transaction`, `post-index-change`, `fsmonitor-watchman` 은 넣지 않는다. ref 나 인덱스가 바뀔 때마다 불려 그때마다 node 가 뜬다.
- `core.hooksPath` 는 `git config --worktree` 로 그 워크트리에만 둔다. `extensions.worktreeConfig` 가 꺼져 있으면 공유 설정에서 켠다. `lib/ssh-agent.ts` 가 Codex worker 의 `core.sshCommand` 에 이미 쓰는 방식이다.

### `dispatch.mjs`

1. 훅 이름은 불린 경로(`process.argv[1]`)의 파일 이름이다. 심볼릭 링크로 불려도 이 값은 링크 이름이다.
2. `pre-commit` 이면 옆의 `korean-check/scripts/check.ts --staged` 를 부른다. 자식 환경에서 `KOREAN_STYLE_RULES` 와 `KOREAN_CHECK_ALLOW` 는 지운다. 사본의 규칙과 저장소의 예외 파일을 읽게 하려는 것이다.
   - 종료 코드가 1 이고 출력에 금지어 발견 줄이 있다: 출력과 「금지어가 있어 커밋하지 않았다. 권장 표현으로 고쳐 다시 스테이징한 뒤 커밋한다. `--no-verify` 로 넘기지 않는다」 를 stderr 에 내고 1 로 끝난다.
   - 종료 코드 0: 출력(경고)이 있으면 stderr 에 내고 이어 간다.
   - 그 밖(2, 신호, 발견 줄 없는 1, 검사기 사본 없음, 낮은 node): 검사기가 돌지 못한 것이다. `.md` 를 스테이징한 커밋이면 원인과 끄는 방법(`worker.commit_check`)을 내고 1 로 거절한다. 스테이징한 `.md` 가 없으면 한 줄로 알리고 이어 간다. node 는 잡지 않은 예외에도 1 을 내므로 금지어와 고장은 종료 코드가 아니라 발견 줄로 구분한다.
   - 머지, 리베이스, cherry-pick, revert 가 진행 중이면 검사하지 않는다. 그때 스테이징된 줄은 다른 브랜치에서 온 것이다.
3. 저장소가 원래 쓰던 훅을 같은 인자와 표준 입출력으로 부르고 그 종료 코드로 끝난다.
   - 원래 훅 폴더는 워크트리 단위 설정을 뺀 `core.hooksPath`(local, global, system 순으로 가까운 것)이고, 없으면 `<공통 git 폴더>/hooks` 다. 상대 경로는 워크트리 최상위 기준으로 푼다.
   - 실행할 때마다 다시 읽으므로 워크트리를 만든 뒤 설치된 훅(husky 의 `prepare`)도 불린다.
   - 그 폴더가 이 훅 폴더 자신이거나, 훅 파일이 없거나 실행 권한이 없으면 부르지 않는다. git 도 실행 권한 없는 훅은 무시한다.
   - 원래 훅이 이 훅을 다시 부르면(`git rev-parse --git-path hooks` 로 다음 훅을 찾는 훅) 환경 변수 표시로 알아보고 아무것도 하지 않는다.

타입 문법 없는 ESM 한 파일이고 Node 내장 모듈만 쓴다. 확장자가 `.mjs` 라 대상 저장소 `package.json` 의 `type` 과 상관없이 ESM 으로 읽힌다.

### `installCommitCheck(worktree)`

돌려주는 값은 `set`(훅 폴더 경로), `skipped`(이유), `failed`(이유) 다. `launch-worker` 는 아래처럼 낸다.

| 결과 | 출력 |
| --- | --- |
| 걸었다 | 진행 줄 한 줄. 짧은 출력에서는 내지 않는다 |
| git 작업 트리가 아니다 | 내지 않는다 |
| 주 checkout 이다, 원격 환경의 worker 다, 검사기 번들이 없다, 워크트리에 사용자가 둔 `core.hooksPath` 가 있다, 공유 설정에 `core.worktree` 가 있거나 `core.bare` 가 true 다 | stdout 에 `COMMIT-CHECK-SKIP <이유>` |
| 폴더나 설정을 쓰지 못했다 | stdout 에 `COMMIT-CHECK-FAIL <이유>` |

어느 결과든 worker 는 띄운다. 상태 파일은 더하지 않는다.

### 설정 `worker.commit_check`

저장소의 `.orch/config.json` 에 `worker` 절을 더한다. `commit_check` 는 bool 이고 없으면 true 다.
false 면 `launch-worker` 가 그 저장소의 worker 워크트리에 훅을 걸지 않고 진행 줄만 낸다. 앞서 건 훅이 있으면 `removeCommitCheck` 로 푼다. true 나 false 가 아니면 설정 오류로 멈춘다.
값의 타입과 기본값은 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이, 검사는 `core/config-schema.ts` 가 소유한다.

## 실패와 일관성

- PR2 의 새 지시서에 비교 칸이나 experiment 줄이 있으면 lint 와 launch 에서 거절한다. 후보 밖 이유로 이 두 형식을 허용하지 않는다.
- 표의 worker 를 읽지 못하면 새 실행을 막는다. 후보 밖 이유가 있어도 알 수 없는 행을 통과시키지 않는다.
- 배포 순서: PR1 의 커밋 검사가 먼저 머지된 뒤 PR2 로 문서 일을 Codex 에 맡긴다. 기존 실행과 이력은 변경하지 않는다.

- **검사기가 돌지 못하면 `.md` 를 스테이징한 커밋을 거절한다.** 검사기 사본이 없거나, node 가 최소 버전보다 낮거나, 검사기가 발견 줄 없이 끝난 경우다. 검사 없이 한국어 문서가 커밋되지 않게 하고, 거절 안내에 원인과 끄는 방법을 적어 고장이 드러나게 한다. `.md` 가 없는 커밋과 머지 중인 커밋은 막지 않는다. 고장이 길어지면 저장소 설정 `worker.commit_check` 로 끈다.
- **저장소의 기존 훅은 그대로 돈다.** 훅 폴더를 바꾸면 git 은 원래 폴더를 보지 않으므로 `dispatch.mjs` 가 이어 부른다. 한국어 검사가 거절하면 원래 `pre-commit` 은 부르지 않는다.
- **다시 걸어도 결과가 같다.** 훅 폴더는 옆 임시 폴더에 만든 뒤 바꿔 넣고, 바꿔 넣지 못하면 옛 폴더를 되돌린다. 워크트리 설정에 사용자가 둔 다른 `core.hooksPath` 가 있으면 덮지 않는다. 값이 훅 폴더 이름으로 끝나면 앞서 둔 값으로 보고 지금 경로로 바꾼다(저장소를 옮긴 경우).
- **주 checkout 과 다른 워크트리에는 번지지 않는다.** 공유 설정에 쓰는 것은 `extensions.worktreeConfig` 하나다. 공유 설정에 `core.worktree` 가 있거나 `core.bare` 가 true 면 켜지 않고 건너뛴다. worker 여럿을 함께 띄워 git 설정 파일의 잠금이 겹치면 쓰기를 몇 번 다시 한다.
- **우회는 막지 않는다.** `git commit --no-verify` 는 훅을 건너뛴다. 이 검사는 실수를 막는 장치이고 보안 경계가 아니다. 거절 메시지가 `--no-verify` 를 쓰지 말라고 알린다.
- **PATH 에 node 가 없는 프로세스의 git 조작은 실패한다.** 훅이 `#!/usr/bin/env node` 라서다. worker 의 셸에는 orch 가 쓰는 node 가 있다. 그 워크트리에서 git 을 부르는 다른 도구(화면에서 하는 커밋)가 걸릴 수 있다.
- **훅 폴더에 직접 쓰는 설치 도구와는 맞지 않는다.** `git rev-parse --git-path hooks` 가 이 훅 폴더를 가리키므로, 그 값으로 훅을 설치하는 도구(lefthook)가 worker 워크트리에서 설치를 돌리면 링크를 덮어 검사가 꺼질 수 있다. `core.hooksPath` 가 있으면 설치를 거부하는 도구(pre-commit)는 그 워크트리에서 설치하지 못한다. 주 checkout 에 이미 설치된 훅은 이어 불린다. 다시 띄우면 훅 폴더를 새로 만든다.
- **리베이스 중 고친 내용은 검사하지 않는다.** 진행 중인 리베이스의 커밋은 건너뛰므로 `edit` 단계에서 더한 줄도 지나간다.
- **이미 떠 있는 worker** 의 워크트리에는 걸리지 않는다. `launch-worker --worktree` 로 다시 띄울 때 걸린다.
- 배포 순서는 없다. 한 PR 안에서 korean-check 의 `--staged` 와 orch 의 설치가 함께 들어가고, 사본을 쓰므로 두 스킬의 버전이 어긋날 일이 없다.

## 검증 전략

| 대상 | 경계 | 확인하는 것 |
| --- | --- | --- |
| PR2 선택 검사 | 임시 저장소의 lib-selection 테스트 | 표와 스펙 일치, 각 값 하나만 다른 경우와 낮은 effort 도 거절, 기본 effort, 이유가 있는 예외, 비교·experiment 거절, 이어하기 허용 |
| PR2 launch·lint·review | 가짜 Orca 와 gh 로 실제 CLI 실행 | 새 지시서 거절, active 허용, 예외 이유와 worker 의 출력·영구 기록, 리뷰 제공자와 새 템플릿 |
| `check.ts --staged` | 임시 git 저장소에서 명령을 실행 | 더한 줄의 금지어는 1 과 권장 표현, 경고만이면 0, 기존 줄의 금지어는 내지 않음, 스테이징 뒤 고친 작업 트리 내용은 보지 않음, 이름만 바꾼 파일, 첫 커밋, 하위 폴더의 예외 파일 |
| `installCommitCheck`, `dispatch.mjs` | 임시 저장소의 연결된 워크트리에서 실제 `git commit` | 금지어 커밋 거절과 메시지, 경고만 있는 커밋 통과, 원래 훅(공유 `hooks/` 와 local `core.hooksPath`) 이어 부르기와 인자 전달, 대상 저장소 `package.json` 의 `type` 이 `commonjs` 이거나 없을 때, 검사기가 죽었을 때 `.md` 커밋은 거절되고 다른 커밋은 됨, 머지 중 건너뜀, 주 checkout 과 다른 워크트리에 번지지 않음, 다시 걸기, 워크트리 삭제 뒤 폴더 없음 |
| `launch-worker` | 가짜 orca 로 실행 | 연결된 워크트리면 에이전트와 상관없이 걸림, 건너뜀 줄 |
| REQ1 인수 조건 | 실제 Codex worker 하나 | 이 브랜치의 설치 코드로 훅을 건 워크트리에서 Codex worker 가 신뢰 확인 화면 없이 시작하는지, 금지어가 든 `.md` 커밋이 거절되고 권장 표현이 보이는지, 경고만 있는 커밋이 되는지 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 검사를 거는 자리 | git 의 `pre-commit` 훅. Codex hook 은 쓰지 않는다 | 작성자 | [ADR-036](../../adr/036-worker-commit-korean-check.md). Codex 는 플러그인 hook 의 스크립트가 바뀔 때마다 신뢰 확인을 다시 받는다 |
| DECISION2 | 훅을 거는 범위와 방법 | orch 가 띄우는 worker 의 연결된 워크트리마다 `git config --worktree core.hooksPath`. 에이전트 종류는 보지 않는다 | 작성자 | 범위는 스펙 DECISION22 가 정했다. 워크트리 단위 설정은 `lib/ssh-agent.ts` 의 선례가 있고, 주 checkout 의 커밋은 바꾸지 않는다 |
| DECISION3 | 판정하는 줄 | 스테이징한 `.md` 의 더한 줄만. 스테이징된 내용을 읽는다 | 작성자 | 다른 저장소의 기존 문서에는 금지어가 남아 있어 파일 전체로 보면 손대지 않은 줄 때문에 커밋이 막힌다. korean-check 의 `--diff` 가 같은 기준이다. `.md` 한정은 스펙 DECISION23 이 정했다 |
| DECISION4 | 검사기의 자리 | 워크트리 훅 폴더에 사본을 둔다 | 작성자 | 플러그인 설치 경로가 갱신마다 바뀐다. 실행할 때 번들을 다시 찾으려면 설치 기록 해석을 훅에 한 벌 더 둬야 한다 |
| DECISION5 | 기존 훅과의 관계 | `dispatch.mjs` 가 원래 훅을 이어 부른다 | 작성자 | 이 저장소의 `commit-msg`, `pre-commit` 과 다른 저장소의 husky 훅이 worker 워크트리에서 꺼지면 안 된다 |
| DECISION6 | 검사기가 돌지 못한 것을 알아보는 법 | 종료 코드가 아니라 금지어 발견 줄의 유무로 금지어와 고장을 구분한다 | 작성자 | 고장이면 `.md` 커밋을 거절한다는 것은 스펙 DECISION26 이 정했다. node 는 잡지 않은 예외에도 1 을 내서 종료 코드만으로는 둘을 구분하지 못한다 |
| DECISION7 | 권장 표현을 보이는 자리 | `--staged` 의 출력에 줄을 더한다. 기존 발견 줄 형식은 그대로 둔다 | 작성자 | 발견 줄은 `check-diff.ts` 와 편집 훅이 읽는 형식이라 바꾸면 출력 계약 변경이다 |
| DECISION8 | 끄는 설정의 자리 | 새 `worker` 절의 `commit_check`(bool, 기본 true) | 작성자 | 끄는 설정을 둔다는 것은 스펙 DECISION24 가 정했다. worker 를 띄울 때 읽는 값이고 기존 절(`review`, `pipeline`)의 뜻과 맞지 않아 새 절을 둔다 |
| DECISION9 | 훅을 걸지 못했을 때 알리는 방법 | stdout 의 판정 줄 `COMMIT-CHECK-SKIP`, `COMMIT-CHECK-FAIL` | 작성자 | 알리고 띄운다는 것은 스펙 DECISION25 가 정했다. 짧은 출력에도 남는 줄이어야 코디네이터가 본다 |
| DECISION10 | ADR | [ADR-036](../../adr/036-worker-commit-korean-check.md) 을 남긴다 | 작성자 | 스펙의 「결정 기록 연결」. [ADR-007](../../adr/007-codex-manifest-without-hooks.md) 은 그대로 유효하다 |

| 결정 | 종류 | ADR 또는 필요 없음의 이유 | 현재 규칙의 원본 |
| --- | --- | --- | --- |
| 스펙 DECISION5, 이 설계 DECISION1·DECISION2 | architecture | [ADR-036](../../adr/036-worker-commit-korean-check.md) | `skills/orch/scripts/lib/commit-check.ts`, `skills/orch/githooks/dispatch.mjs`, `export-only-skills/korean-check/scripts/check-diff.ts` 의 머리 주석 |
