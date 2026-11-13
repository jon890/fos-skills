# Phase 03. 옛 번들 판정, 다시 뜨는 때의 판정, loop.log 경고 한 번

**Execution profile**: standard

## 목표

새 파일 `loop/self-update.ts` 에 옛 번들 판정 상태와 「지금 다시 떠도 되는가」 판정을 두고, 부모가 틱마다 불러 처음 알아챈 틱에 `LOOP-STALE` 한 줄을 쓴 뒤로는 틱 출력의 `STALE-BUNDLE` 줄을 loop.log 에 옮기지 않게 한다.

**범위 외**: 실제로 새 루프를 띄우고 잠금을 넘기는 일(phase 04). 이 phase 의 판정이 `go` 를 내도 부모는 아직 아무것도 띄우지 않는다. phase 04 가 그 자리에 `handOver` 를 잇는다.

## 컨텍스트

**요구사항**: REQ1, REQ3(판정 몫)

**근거 문서**: `docs/features/loop-self-update/spec.md` REQ1·REQ3·DECISION2·DECISION4·DECISION7·DECISION11·DECISION17, `docs/features/loop-self-update/design.md` 「옛 번들 판정」·「다시 뜨는 때」, 설계 DECISION4·DECISION6

- 지금 설치본 판정은 phase 01 의 `currentBundle(ownBundle(), configDir)`, 버전은 `bundleVersion` 이다. `configDir` 은 `process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')` 이다(`lib/bundle.ts` 25행과 같다).
- 틱 고리는 `skills/orch/scripts/loop/lifecycle.ts` 의 `foreground` 553-607행이다. `runAsync` 로 틱 자식을 기다린 뒤(571-575행) `tickResult` 를 부른다. phase 02 가 `tickResult(done, staleLogged)` 의 둘째 인자를 만들었다.
- 마무리 pid 파일은 `pathOf('queue', repo)` 아래 `finish-<PR>.pid` 다(`skills/orch/scripts/queue/merge-with-finish.ts` 277행). 살아 있는지는 `pidFileAlive`(`lib/process.ts` 25행)로 본다.
- 머지 큐 프로세스의 명령줄 표지는 `merge_queue.`, `merge-queue.sh`, `merge-with-finish.` 다(`loop/steps/auto-merge.ts` 머리 주석 15행). 프로세스 목록은 `process.env.PS || 'ps'` 에 `-Ao pid=,command=` 이고 `run`(`lib/proc.ts`)으로 부른다. `--repo` 값은 `mainCheckout`(`lib/git.ts`)으로 주 checkout 으로 바꿔 비교한다.
- 로그는 `steps/shared.ts` 의 `log(line)` 이다.
- `skills/orch/tests/loop-steps.spec.ts` 43-51행은 `lifecycle.ts` 의 상대 import 를 `./steps/` 공통 파일로 고정한다. `skills/orch/tests/script-folders.spec.ts` 83-88행은 `loop/` 아래 보조 파일 목록을 고정한다. 새 파일을 만들면 두 테스트를 함께 고친다. 같은 두 테스트를 고치는 보드 업무 링크 작업(`feat/board-task-link`)과 줄이 겹칠 수 있다. 머지 순서에 따라 rebase 로 합친다.

## 의도 메모

- 판정 상태는 파일에 두지 않고 부모 메모리에만 둔다(설계 DECISION4). 사람이 다시 띄우면 기억이 사라지는 것이 스펙 DECISION11 이다.
- `since` 는 처음 알아챈 시각을 지킨다. 설치본 경로가 다시 바뀌어도 늘리지 않는다.
- `decide` 는 값만 받는 순수 함수로 둔다. 시각과 바쁜 이유를 인자로 받아 단위 테스트가 바깥 상태 없이 돈다.

## 작업 항목

### 1. `skills/orch/scripts/loop/self-update.ts`(신규)

- `export const STALE_WAIT_MAX_MS = 60 * 60 * 1000`.
- `export type SelfUpdate = { target: string | null; since: number | null; failed: string | null; waitReason: string | null }` 와 `export function newSelfUpdate(): SelfUpdate`.
- `export function heirEntry(bundle: string): string` — `join(bundle, 'skills', 'orch', 'scripts', 'loop', 'orch-loop.ts')`.
- `export function observe(s: SelfUpdate, target: string | null, now: number, own: string): string | null` — 설계 「옛 번들 판정」. target 이 null 이면 상태를 비우고 null. 경로가 처음이거나 바뀌었으면 `target` 을 바꾸고 `failed` 를 지우고 `since ??= now` 한 뒤 `LOOP-STALE <옛 버전> <새 버전> <새 진입점>` 줄을 낸다(버전은 `bundleVersion`, 없으면 `-`). 같으면 null.
- `export function decide(input: { target: string | null; failed: string | null; since: number | null; now: number; busy: string | null; lastCode: number }): { kind: 'none' } | { kind: 'wait'; reason: string } | { kind: 'go' }` — 설계 「다시 뜨는 때」 의 표 순서 그대로.
- `export function busyReason(repo: string): string | null` — 설계 「다시 뜨는 때」 의 두 판정. 마무리가 먼저다. `--repo` 값은 명령줄에서 `/\s--repo\s+(\S+)/` 로 읽는다.
- 파일 맨 위 설명: 이 파일이 소유하는 것(판정 상태, 다시 뜨는 때, phase 04 에서 더할 넘기기), 메모리에만 두는 이유, 부르는 쪽(`lifecycle.ts` 만).

### 2. `skills/orch/scripts/loop/lifecycle.ts`

- `foreground` 시작에서 `const update = newSelfUpdate()` 와 `configDir` 을 둔다. `--once` 면 이후 판정을 모두 건너뛴다.
- 틱 자식이 끝나고 `tickResult` 를 부르기 전에 `observe(update, currentBundle(ownBundle(), configDir), Date.now(), ownBundle())` 를 불러 줄이 있으면 `log` 한다. `tickResult(done, update.target !== null)` 로 부른다.
- `decide(...)` 의 결과가 `wait` 이고 이유가 `update.waitReason` 과 다르면 `LOOP-STALE-WAIT <이유>` 를 쓰고 `waitReason` 을 바꾼다. `go` 면 이 phase 에서는 아무것도 하지 않는다(phase 04 가 잇는다).
- 파일 맨 위 설명에 「스스로 다시 뜨기」 절을 새로 두고 이 phase 의 판정까지를 적는다. 차례는 phase 04 가 채운다.

### 3. 테스트

- `skills/orch/tests/loop-self-update.spec.ts`(신규, 단위):
  - `decide`: 표의 줄마다 한 사례. target 없음, failed 와 같은 진입점, 종료 코드 2 에 바쁨이 있어도 `go`, since 에서 60분 1초 뒤 바쁨이 있어도 `go`, 59분에 바쁨이면 `wait`, 바쁨 없으면 `go`.
  - `observe`: 처음 줄 하나, 같은 target 두 번째는 null, target 이 바뀌면 줄이 다시 나오고 `failed` 가 지워지며 `since` 는 그대로, null 이면 상태가 빈다. 임시 폴더에 `.claude-plugin/plugin.json` 을 둔 두 번들로 버전 칸을 본다.
  - `busyReason`: 임시 `ORCH_DIR` 의 `queue/finish-7.pid` 에 지금 프로세스 pid 를 쓰면 `마무리 PR 7`, 죽은 pid 면 null. 가짜 `PS`(받은 줄을 내는 스크립트, `skills/orch/tests/fixtures/fake-bin.ts` 꼴)로 `--repo <이 저장소>` 큐는 이유가 있고, `--repo <다른 저장소>` 큐는 null, `--repo` 없는 큐는 이유가 있고, `PS` 가 1 로 끝나면 `프로세스 목록을 읽지 못했다`.
- `skills/orch/tests/loop-steps.spec.ts`: lifecycle 의 상대 import 허용 목록에 `./self-update.ts` 를 더한다. `self-update.ts` 가 `lifecycle.ts` 와 `orch-loop.ts` 를 import 하지 않는지 같은 꼴로 본다.
- `skills/orch/tests/script-folders.spec.ts`: helpers 에 `'loop/self-update.ts': 'orch-loop 의 부모가 옛 번들 판정과 다시 뜨기에 쓰는 모듈이다. 직접 실행하지 않는다'` 를 더한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/loop-self-update.spec.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/script-folders.spec.ts skills/orch/tests/orch-loop.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/loop/self-update.ts` | 신규 |
| `skills/orch/scripts/loop/lifecycle.ts` | 수정 (판정 호출, `LOOP-STALE`, `STALE-BUNDLE` 빼기) |
| `skills/orch/tests/loop-self-update.spec.ts` | 신규 |
| `skills/orch/tests/loop-steps.spec.ts` | 수정 (import 허용 목록) |
| `skills/orch/tests/script-folders.spec.ts` | 수정 (보조 파일 목록) |
