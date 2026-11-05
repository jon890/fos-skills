# Phase 01. 세션 찾기와 실행기

**Execution profile**: standard

## 목표

새 터미널 안에서 그 터미널의 계정 환경으로 이전 worker 의 Claude·Codex 세션을 찾고, 출발 신호 뒤 셸이 `exec` 로 resume 할 한 줄을 쓰는 순수 모듈과 실행기를 만든다.

**범위 외**: 코디네이터 쪽 명령(`resume-worker.ts`), Orca 호출, 명령 표, 문서. phase-02 와 phase-03 이 맡는다.

## 컨텍스트

**요구사항**: REQ1, REQ2

**근거 문서**: `docs/features/limit-resume/spec.md`, `docs/features/limit-resume/design.md`(「책임과 경계」 의 `lib/resume.ts`, 실행기, 「요청 폴더」)

- 스크립트 폴더(orch-cli PR3): 이 계획은 PR3(스크립트를 `skills/orch/scripts/<묶음>/` 으로 옮김, orch-cli 스펙 DECISION6) 머지 뒤에 구현한다. 아래 표와 변경 파일 표의 경로는 PR3 전 배치다. PR3 머지 뒤 `origin/main` 으로 rebase 하고, 이 계획 전체에서 아래 표의 왼쪽 경로를 오른쪽으로 바꾼 뒤 `verify_task.py` 를 다시 돌린다. 표 밖의 경로가 바뀌어 있거나 PR3 의 실제 배치가 표와 다르면 구현하지 말고 계획을 고쳐 critic 재검토를 받는다.

  | PR3 전 | PR3 뒤 |
  | --- | --- |
  | `skills/orch/scripts/resume-worker.ts` | `skills/orch/scripts/worker/resume-worker.ts` |
  | `skills/orch/scripts/resume-exec.ts` | `skills/orch/scripts/worker/resume-exec.ts` |
  | `skills/orch/scripts/adopt-sessions.ts` | `skills/orch/scripts/worker/adopt-sessions.ts` |
  | `skills/orch/scripts/orch-loop.ts` | `skills/orch/scripts/loop/orch-loop.ts` |
  | 명령 표 `script: 'resume-worker.ts'` | `script: 'worker/resume-worker.ts'` |
  | 새 진입 스크립트의 `./lib/…` import | `../lib/…` |

  `skills/orch/scripts/lib/` 과 `skills/orch/tests/` 는 PR3 에서도 그대로다.
- 기존 패턴: 순수 모듈과 단위 테스트는 `skills/orch/scripts/lib/launched.ts` 와 `skills/orch/tests/` 의 `lib-*.spec.ts` 를 따른다(`node:test`, 임시 폴더). 테스트 실행기는 `scripts/run-node-tests.ts` 다.
- Claude 세션 기록: `<CLAUDE_CONFIG_DIR>/projects/<워크트리 실경로의 영숫자 밖 글자를 - 로 바꾼 이름>/<세션 id>.jsonl`. 기록 안에 dispatch 머리말의 dispatch id(`ctx_` 와 16진 12자리)가 들어 있다.
- Codex 세션 기록: `<CODEX_HOME>/state_5.sqlite` 의 `threads`(`id`, `cwd`, `rollout_path`, `updated_at`), rollout 파일 `sessions/YYYY/MM/DD/rollout-*.jsonl` 의 첫 줄은 `{"type":"session_meta","payload":{"id":…,"cwd":…}}` 꼴이다.
- Orca 의 실행 줄(2026-11-05 `ps` 실측):
  - Claude `claude --plugin-dir <orca>/claude-agent-view/<해시>/orca-agent-view --permission-mode auto --model <m> --effort <e>`
  - Codex `codex --no-daemon -c shell_environment_policy.set.ORCA_USER_DATA_PATH='…' -c …ORCA_WORKSPACE_ID … -c …ORCA_WORKTREE_ID … -c …ORCA_PANE_KEY … -c …ORCA_TERMINAL_HANDLE … -c check_for_update_on_startup=false -c disable_paste_burst=true --dangerously-bypass-approvals-and-sandbox -m <m> -c model_reasoning_effort=<e>`

## 의도 메모

- 실행기가 에이전트를 자식으로 띄우지 않는다. node 래퍼가 worker 수명 내내 남고 Ctrl-C 가 래퍼를 먼저 끝낼 수 있다(설계 DECISION6).
- `lib/resume.ts` 는 다른 orch lib 를 import 하지 않는다. 실행기가 `lib/bundle.ts` 의 경고나 orca 조회 없이 뜨게 한다.
- `--plugin-dir` 을 최근 폴더로 짐작하지 않는다. 해시가 여럿이면 틀릴 수 있다(설계 DECISION7).

## Blocked 조건

- orch-cli PR3 가 `origin/main` 에 머지되지 않았다 → `PHASE_BLOCKED: orch-cli PR3 머지 전` 출력 후 종료

## 작업 항목

### 1. `skills/orch/scripts/lib/resume.ts`(신규)

머리 주석에 모듈의 책임과 요청 폴더 형식을 적는다. 내보낼 것:

- `type ResumeRequest = { dispatch: string; worktree: string; agent: 'claude' | 'codex'; model: string; effort: string | null; pluginDir: string | null; goDeadline: number }`
- `type Found = { ok: true; session: string; home: string; terminal: string | null } | { ok: false; reason: string }`
- `claudeProjectDir(home: string, worktree: string): string`: `realpathSync` 한 경로의 `[^A-Za-z0-9]` 를 `-` 로 바꾼다.
- `findClaudeSession(home, worktree, dispatch): string | null`: 위 폴더의 `*.jsonl` 을 고친 시각 내림차순으로 읽어 dispatch id 가 든 첫 파일의 이름(확장자 뺌)을 낸다.
- `findCodexSession(home, worktree, dispatch): string | null`: `node:sqlite` 의 `DatabaseSync(path, { readOnly: true })` 로 `select id, rollout_path from threads where cwd = ? order by updated_at desc` 를 읽어 rollout 에 dispatch id 가 든 첫 `id`. DB 가 없거나 열기에 실패하거나 맞는 행이 없으면 `sessions/` 아래 최근 14일 날짜 폴더의 rollout 첫 줄로 `cwd` 가 같은 파일을 찾아 같은 판정을 한다.
- `pickPluginDir(fromEnv: string | undefined, requested: string | null): string | null`: `fromEnv`(`ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR`)가 있고 폴더가 있으면 그것, 아니면 `requested` 가 있고 폴더가 있으면 그것, 아니면 null. 폴더 목록에서 고르지 않는다(이 기계의 `claude-agent-view` 아래 해시 폴더가 다섯 개다).
- `claudeResumeArgv(session, req, pluginDir): string[]`, `codexResumeArgv(session, req, env: NodeJS.ProcessEnv): string[] | null`: 설계 「책임과 경계」 의 꼴. `effort` 가 null 이면 effort 인자를 뺀다. Codex 의 `-c` 값은 `shell_environment_policy.set.<이름>=<값>` 한 낱말로 두고 따옴표는 `shellLine` 이 붙인다. 다섯 ORCA_* 가운데 하나라도 없으면 null 이다.
- `shellLine(argv: string[]): string`: `exec ` 뒤에 낱말마다 작은따옴표로 감싼 한 줄(작은따옴표는 `'\''`).
- 요청 폴더 파일 이름 상수(`REQUEST`, `FOUND`, `GO`, `LAUNCH`, `LOCK`)와 `readRequest(dir)`, `writeFound(dir, found)`(임시 파일 뒤 rename).

### 2. `skills/orch/scripts/resume-exec.ts`(신규)

`lib/resume.ts` 만 import 한다. 사용법 `resume-exec.ts <요청 폴더>`. 설계 「실행기」 의 1~5 를 한다.

- 기록 폴더: Claude 는 `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`, Codex 는 `process.env.CODEX_HOME ?? ~/.codex`.
- `found.json` 의 `terminal` 은 `process.env.ORCA_TERMINAL_HANDLE ?? null`.
- 찾지 못하거나, Claude 의 `--plugin-dir` 을 정하지 못하거나, Codex 의 ORCA_* 가 빠졌으면 `found.json` 에 `{ ok: false, reason }` 을 쓰고 stderr 에 이유를 내고 종료 코드 3.
- `go` 는 200ms 간격으로 확인하고 `goDeadline` 이 지나면 종료 코드 4(`launch.sh` 를 쓰지 않는다).
- `go` 를 보면 `launch.sh` 에 `shellLine(argv)` 와 줄바꿈을 쓰고 0 으로 끝난다.

### 3. `skills/orch/tests/lib-resume.spec.ts`(신규)

- 임시 홈에 `projects/<이름>/a.jsonl`(다른 dispatch), `b.jsonl`(대상 dispatch)을 두고 `findClaudeSession` 이 `b` 를 낸다. 대상이 없으면 null.
- `claudeProjectDir` 이 `_`, `.` 를 `-` 로 바꾼다.
- `node:sqlite` 로 `threads` 두 행과 rollout 둘을 만들고 `findCodexSession` 이 dispatch 가 든 쪽 id 를 낸다. DB 파일이 없을 때 rollout 첫 줄로 찾는다.
- `pickPluginDir`: 환경 값 우선, 없으면 요청 값, 둘 다 없거나 폴더가 없으면 null.
- `claudeResumeArgv` 가 `['claude', '--plugin-dir', <dir>, '--permission-mode', 'auto', '--model', <m>, '--effort', <e>, '--resume', <id>]` 와 같고, effort 가 null 이면 `--effort` 가 없다.
- `codexResumeArgv` 가 `codex resume <id> --no-daemon` 뒤에 다섯 ORCA_* 의 `-c`, 고정 `-c` 둘, `--dangerously-bypass-approvals-and-sandbox`, `-m <m>`, `-c model_reasoning_effort=<e>` 를 낸다. ORCA_* 하나가 빠지면 null.
- `shellLine` 이 공백·작은따옴표가 든 낱말을 셸이 그대로 받게 쓴다(`/bin/sh -c` 로 `printf '%s\n'` 에 넘겨 대조).

### 4. `skills/orch/tests/resume-exec.spec.ts`(신규)

`process.execPath` 로 `resume-exec.ts <폴더>` 를 자식으로 돌린다. 환경은 `process.env` 에서 `ORCA_` 로 시작하는 변수와 `CLAUDE_CONFIG_DIR`, `CODEX_HOME` 을 지운 뒤 사례마다 필요한 것만 준다(호스트가 Orca 터미널이어도 결과가 같게).

- Claude: `CLAUDE_CONFIG_DIR` 과 `ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR`(임시 폴더)을 주고 세션이 있으면 `found.json` 이 `ok: true` 이고, `go` 를 쓰면 `launch.sh` 가 `exec 'claude' '--plugin-dir' …` 로 시작하고 `'--resume' '<세션 id>'` 를 담는다. 종료 코드 0. `go` 전에는 `launch.sh` 가 없다.
- Codex: `CODEX_HOME` 과 다섯 ORCA_* 를 주고 같은 흐름에서 `launch.sh` 가 `exec 'codex' 'resume' '<세션 id>'` 로 시작한다. ORCA_* 하나를 빼면 종료 코드 3.
- 세션이 없으면 종료 코드 3, `found.json` 이 `ok: false`, `launch.sh` 없음.
- `goDeadline` 을 지나게 두면 종료 코드 4, `launch.sh` 없음.
- `--plugin-dir` 을 정하지 못하면 종료 코드 3.

### 5. `skills/orch/tests/lib-bundle.spec.ts` 의 예외

「모든 직접 실행 스크립트가 공용 경고 모듈에 닿는다」 테스트는 `scripts/` 바로 아래(PR3 뒤에는 묶음 폴더 아래)의 모든 `.ts` 가 `lib/bundle.ts` 에 닿는지 본다. `resume-exec.ts` 는 일부러 닿지 않으므로 이름과 이유(새 터미널에서 다른 lib 없이 뜨는 실행기)를 적은 예외 목록을 더한다.

## 검증

```bash
node scripts/run-node-tests.ts skills/orch/tests/lib-resume.spec.ts skills/orch/tests/resume-exec.spec.ts skills/orch/tests/lib-bundle.spec.ts
python3 export-only-skills/korean-check/scripts/korean-style-check.py docs/features/limit-resume/tasks/resume-command/phase-01.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/resume.ts` | 신규 |
| `skills/orch/scripts/resume-exec.ts` | 신규 |
| `skills/orch/tests/lib-resume.spec.ts` | 신규 |
| `skills/orch/tests/resume-exec.spec.ts` | 신규 |
| `skills/orch/tests/lib-bundle.spec.ts` | 수정 |
