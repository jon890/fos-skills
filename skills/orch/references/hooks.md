# 이벤트 핸들러

orch 명령은 정한 시점에 저장소의 `<orch 루트>/hooks/<이벤트>.ts` 를 부른다. orch 루트는 기본 `.orch/` 이고 `ORCH_DIR` 로 옮긴다.
저장소 고유의 검사와 알림을 코어 명령을 고치지 않고 더하는 자리다.
핸들러 찾기, 잠금, 시간 제한, 실행 기록, 종료 코드 해석은 `scripts/lib/events.ts` 머리 주석이 소유한다.

## 이벤트 고르기

이벤트 이름, 내는 명령, 거부할 수 있는지는 아래 표와 이 절의 설명이 소유한다. 이름 목록의 원본은 `scripts/lib/events.ts` 의 `EVENTS` 다.

- **동작을 막아야 하면 거부할 수 있는 이벤트를 고른다.** `before-` 로 시작하는 이벤트와 `verify-merged`, `worker-stalled` 다. 핸들러가 종료 코드 10 으로 끝나면 명령이 그 동작을 하지 않는다. `worker-stalled` 의 10 은 넘김이다. 코어가 코디네이터에게 `WORKER-STALLED` 를 알린다.
- **알리거나 기록만 하면 나머지 이벤트를 고른다.** 핸들러가 실패해도 코어 동작은 이어 간다.
- 파일 이름이 이벤트 이름과 한 글자라도 다르면 불리지 않는다. `orch-doctor` 가 그런 파일을 `UNKNOWN-HOOK <파일>` 로 알린다.
  `hooks/` 바로 아래만 본다. 핸들러가 import 하는 모듈은 `hooks/lib/` 같은 하위 폴더에 둔다.

| 내는 명령 | 이벤트 |
| --- | --- |
| `launch-worker.ts` | `before-launch`, `worker-launched` |
| `orch doctor --run` | `session-resume` |
| `ci-ready.ts` | `before-ready`, `pr-ready` |
| `notify-conflicts.ts` | `pr-conflict` |
| `merge_queue.ts`(`merge-with-finish.ts` 가 건 것 포함) | `before-merge`, `verify-merged`, `after-merge`, `after-queue` |
| `finish-pr.ts` | `after-deploy` |
| `cleanup-sweep.ts` | `before-cleanup`, `after-cleanup` |
| `orch-loop.ts`(상주 루프) | `worker-question`, `decision-pending`, `worker-done`, `worker-lost`, `worker-stalled`, `tick`, `ci-passed`, `ci-failed`, `pr-conflict` |
| 아직 없다. 핸들러를 두어도 불리지 않는다 | `ci-missing` |

핸들러는 stdin 으로 JSON 객체 하나를 받는다. 공통 필드와 이벤트별 필드는 `scripts/lib/events.ts` 머리 주석의 「공통 필드」 와 「이벤트별 필드」 가 소유한다.
환경 변수와 작업 디렉터리는 `scripts/lib/events.ts` 머리 주석의 「핸들러」 와 「환경」 이 소유한다.

## 핸들러 예시

### 사용자 결정 요청 바꾸기

`decision-pending` 은 기본 핸들러(`scripts/handlers/decision-pending.ts`)가 있는 이벤트다. 새 사용자 결정을 현재 코디네이터에게 「정할 것 묻기」 로 넣고, 재시도은 [`waiting.md`](waiting.md) 의 「새 사용자 결정을 놓치지 않기」 가 소유한다. 저장소에 `.orch/hooks/decision-pending.ts` 를 두면 기본 핸들러를 대체한다. 입력 필드는 `events.ts` 머리 주석이 소유한다. 이 핸들러는 묻기를 요청할 뿐 사용자의 답을 대신 정하지 않고, 전달했을 때만 0 으로 끝난다.
사용자 결정은 `decision-pending` 만 코디네이터를 깨우고, `worker-question` 은 기술 질문과 일반 escalation 만 맡는다.

동시에 도는 worker 가 상한에 닿았으면 새 worker 를 띄우지 않는 `before-launch` 핸들러다. `.orch/hooks/before-launch.ts` 에 둔다.

```ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const LIMIT = 4
const input = JSON.parse(readFileSync(0, 'utf8'))
if (!input.run) process.exit(0)

// worker-list 는 한 페이지가 100개다. 첫 페이지만 읽으면 오래된 worker 를 놓친다
type Worker = { dispatchStatus?: string; workerState?: string; terminalState?: string; resource?: { releaseState?: string } }
const workers: Worker[] = []
let cursor = ''
do {
  const args = ['orchestration', 'worker-list', '--run', input.run, '--limit', '100', '--json', ...(cursor ? ['--cursor', cursor] : [])]
  const result = JSON.parse(execFileSync(process.env.ORCA ?? 'orca', args, { encoding: 'utf8' })).result
  workers.push(...(result.workers ?? []))
  cursor = result.page?.nextCursor ?? ''
} while (cursor)
// 끊기거나(abandoned, failed, stopped) 터미널을 반납한(released) worker 는 살아 있지 않다. 판정은 lib/worker-state.ts 의 isLive 와 같다
const isLive = (w: Worker) =>
  ['working', 'ready'].includes(w.workerState ?? '') ||
  (['pending', 'dispatched', 'running'].includes(w.dispatchStatus ?? '') &&
    !['abandoned', 'failed', 'stopped'].includes(w.workerState ?? '') &&
    w.terminalState !== 'released' &&
    w.resource?.releaseState !== 'released')
const live = workers.filter(isLive)
if (live.length >= LIMIT) {
  console.log(`동시 worker ${live.length}개가 상한 ${LIMIT}개에 닿아 ${input.branch} 를 띄우지 않는다`)
  process.exit(10)
}
```

- **거부는 종료 코드 10 이다.** 1 은 node 가 잡지 않은 예외에 내는 값이라 거부로 읽지 않는다.
- **거부 이유는 stdout 의 마지막 줄이다.** 명령이 그 줄을 `HOOK-REJECT before-launch <이유>` 로 옮겨 낸다.
- **타입 제거가 지우는 문법만 쓴다.** 핸들러도 `node --disable-warning=ExperimentalWarning` 으로 뜬다. 문법 규칙은 `docs/code-architecture.md` 「저장소 실행 규칙」 이 소유한다.
- **`orca` 와 `gh` 는 `ORCA`, `GH` 환경 변수로 부른다.** 그 값이 아래 「가드가 막는 호출」 의 shim 이다.

### 멈춘 worker 다시 시도시키기

상주 루프는 멈춘 worker 를 알리기만 하고 입력하지 않는다. 다시 시도시킬지와 몇 번까지 할지는 저장소의 `worker-stalled` 핸들러가 정한다.
판정 기준과 틱 수는 `scripts/loop/orch-loop.ts` 머리 주석의 「멈춤 확인」 이 소유한다.

아래는 모델 오류(`state` 가 `error`)로 멈춘 worker 에게 멈춤마다 세 번까지 「계속 진행해」 메시지를 보내는 핸들러다. `.orch/hooks/worker-stalled.ts` 에 둔다.

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIMIT = 3
const input = JSON.parse(readFileSync(0, 'utf8'))

// 10 은 넘김이다. 마지막 줄이 HOOK-REJECT 줄의 이유가 된다
function handOff(reason: string): never {
  console.log(reason)
  process.exit(10)
}

if (input.state !== 'error') handOff(`${input.state} 멈춤은 코디네이터가 본다`)

// 같은 상태가 이어지는 동안 since 가 그대로다. since 가 바뀌면 새 멈춤이라 처음부터 센다
const file = join(process.env.ORCH_DIR!, 'state', 'stall-retries.json')
const retries: Record<string, { since: string; tries: number }> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const dispatch = input.worker.dispatch
const tries = retries[dispatch]?.since === input.since ? retries[dispatch].tries : 0
if (tries >= LIMIT) handOff(`다시 시도 ${LIMIT}번에 닿았다`)
retries[dispatch] = { since: input.since, tries: tries + 1 }
// 쓰는 도중에 끝나도 앞 내용이 남게 임시 파일에 쓰고 이름을 바꾼다
writeFileSync(`${file}.tmp`, JSON.stringify(retries))
renameSync(`${file}.tmp`, file)

// ORCH_BIN 은 orch 진입점 절대경로다. 핸들러의 PATH 앞에는 가드 폴더가 있어 PATH 의 orch 를 믿지 않는다
execFileSync('node', ['--disable-warning=ExperimentalWarning', process.env.ORCH_BIN!, 'worker', 'send', '--dispatch', input.worker.dispatch, '--body', '계속 진행해'], { stdio: 'inherit' })
```

- **0 으로 끝나면 코디네이터를 깨우지 않는다.** 0 이 아니면 루프가 그 Run 에 `WORKER-STALLED` 메시지를 보내 코디네이터가 깨어난다.
- **넘길 때는 10 으로 끝낸다.** 루프 로그에 `HOOK-REJECT worker-stalled <이유>` 가 남는다. 다른 0 아닌 값도 넘기지만 `HOOK-FAIL worker-stalled <종료 코드>` 로 남아 핸들러의 결함과 구분되지 않는다. 위 예시는 상한에 닿았거나 `error` 가 아닌 멈춤이면 10 으로 넘긴다.
- **횟수는 멈춤마다 센다.** 같은 상태가 이어지는 동안 입력의 `since` 가 그대로이고, 작업 중 화면을 거쳐 다시 멈추면 `since` 가 바뀐다. dispatch 수명 전체로 세면 앞 멈춤에서 쓴 횟수 때문에 다음 멈춤을 다시 시도시키지 못한다.
- **0 으로 끝나면 같은 화면이 기준 틱 수만큼 더 이어질 때 다시 불린다.** 다시 시도한 worker 의 화면이 그대로일 수 있어서다. 화면에 오류 줄이 늘어도 다시 불린다. 0 이 아니면 그 화면에는 다시 불리지 않는다.
- **사람이 Esc 로 끊은 화면(`interrupted`)에는 불리지 않는다.** 사람이 일부러 멈춘 작업을 다시 돌리지 않는다.
- **지시는 `orch worker send` 로 보낸다.** Orca 가 worker 를 깨운다. `orch worker nudge` 를 쓰는 저장소 핸들러는 doctor 의 NUDGE-HANDLER 경고를 따라 바꾼다.
  <!-- orch-compat -->
  `ORCH_SCRIPTS`(스크립트 폴더)도 계속 넘기지만 스크립트는 그 아래 묶음 폴더(`worker/nudge-worker.ts` 꼴)로 옮겼다. `$ORCH_SCRIPTS/<이름>.ts`, `join(ORCH_SCRIPTS, '<이름>.ts')` 꼴은 파일이 없어 깨진다. 핸들러는 `node "$ORCH_BIN" <묶음> <동작>` 으로 부른다. doctor 가 `DIRECT-PATH` 로 알린다.
- 코어가 `error` 로 보는 오류 줄은 에이전트가 오류를 그리는 공통 형식뿐이다. 그 밖의 문구는 입력의 `lines` 로 핸들러가 판정한다. 그 판정을 쓰려면 `config.json` 의 `pipeline.stall_ticks.idle` 을 켠다.

## 실패 줄 읽기

핸들러의 stdout 과 stderr 는 줄마다 `[hook <이벤트>] ` 를 붙여 명령의 stdout 에 섞인다. 결과는 아래 줄 하나로 낸다. 통과면 줄이 없다.

| 줄 | 뜻 | 할 일 |
| --- | --- | --- |
| `HOOK-REJECT <이벤트> <이유>` | 핸들러가 10 으로 거부했다 | 이유를 읽고 조건을 고친 뒤 같은 명령을 다시 부른다 |
| `HOOK-FAIL <이벤트> <종료 코드>` | 핸들러가 10 이 아닌 값으로 끝났다. 시그널로 죽으면 128 더하기 신호 번호다 | 바로 위의 `[hook <이벤트>]` 줄에서 예외를 찾아 핸들러를 고친다 |
| `HOOK-FAIL <이벤트> timeout` | 시간 제한을 넘겼다 | 핸들러를 줄이거나 `config.json` 의 `hooks.timeouts.<이벤트>`(초)를 늘린다 |
| `HOOK-FAIL <이벤트> lock` | 같은 이벤트의 앞 실행이 잠금을 놓지 않았다 | 앞 실행이 끝난 뒤 다시 부른다 |
| `INVALID-CONFIG ... doctor migrate-hooks ... --apply` | `orch doctor` 가 5.2.0에서 지운 설정 칸을 찾았다 | worker와 머지 큐가 끝난 뒤 아래 절차로 핸들러로 옮긴다 |
| `INVALID-CONFIG <설정 칸> ...` (그 밖) | `config.json` 의 값이 틀렸다. 자동 머지 리뷰 조건(`queue.auto_review.require`)이면 루프는 멈추지 않지만 어느 PR 도 걸지 않는다 | 줄에 나온 이름이나 키를 고친다([`overlay.md`](overlay.md) 의 「자동 머지 리뷰 조건」, `inbox` 절) |

거부할 수 있는 이벤트에서는 `HOOK-FAIL` 도 거부처럼 멈춘다. 모르는 실패로 머지하거나 지우지 않기 위해서다.
나머지 이벤트에서 명령의 종료 코드에 반영하는지는 `docs/flow.md` 「갈래」 표가 소유한다.
지난 실행은 `<orch 루트>/state/hooks.jsonl` 에 한 줄씩 남는다.

## 옛 설정 칸 옮기기

orch 5.2.0에서 `queue.before`, `queue.verify_merged`, `queue.after_merged`, `finish.complete_cmd`와 대응 명령줄 옵션을 지웠다(목록은 `scripts/lib/config.ts` 의 `REMOVED_CONFIG_KEYS`). 일반 런타임 명령은 남은 설정을 사용법 오류(종료 코드 2)로 거부하고, `orch-doctor`만 `INVALID-CONFIG`과 종료 코드 1로 알린다.
`orch doctor migrate-hooks --apply` 가 칸마다 같은 일을 하는 핸들러를 만들고 그 칸을 설정에서 지운다.

머지 큐와 worker 가 돌지 않을 때 옮긴다. `$REPO` 는 대상 저장소의 주 checkout 이다.

1. 미리보기로 만들 핸들러와 지울 키를 본다. `옮기지 못함` 이나 `겹침` 줄이 있으면 그 이유를 먼저 푼다

   ```bash
   orch doctor migrate-hooks
   ```

2. 핸들러를 쓰고 설정에서 그 키를 지운다

   ```bash
   orch doctor migrate-hooks --apply
   ```

3. 만든 `.orch/hooks/<이벤트>.ts` 를 열어 옛 명령이 그대로 들었는지 본다. 그 파일은 저장소의 것이라 고쳐 써도 된다.
   `추적 파일` 줄이 나왔으면 공개 저장소에 올리면 안 되는 값이 없는지 본 뒤 그 `git add -f` 명령으로 더해 커밋한다

- 폴더를 옮기기 전이면 `--hooks` 는 아무것도 바꾸지 않고 종료 코드 2 로 멈춘다. 먼저 [`overlay.md`](overlay.md) 의 「옛 구조에서 옮기기」 를 한다
- `PR번호:명령` 은 그 PR 하나에만 붙이는 명령이라 옮기지 않는다
- 판정과 종료 코드는 `scripts/doctor/migrate-orch-dir.ts` 머리 주석의 「--hooks」 가 소유한다

## 가드가 막는 호출

핸들러의 PATH 맨 앞에는 `scripts/lib/guard/` 의 `orca`, `gh` shim 이 있다. 코어 명령만 해야 하는 호출을 핸들러가 모르고 쓰는 실수를 막는다.

- `orca terminal send`. worker 에게 보내는 일은 `send-to-worker` 가 한다
- `gh pr merge`, `gh pr update-branch`, PR 머지와 브랜치 갱신 API, GraphQL 의 머지 mutation. 머지는 머지 큐가, base 합치기는 차례가 온 PR 에만 코어가 한다

막히면 stderr 에 이유를 내고 종료 코드 126 으로 끝난다. 판정의 원본은 `scripts/lib/guard/guard.ts` 머리 주석이다.
worker 에게 보내는 코어 명령은 `orch worker send` 다. 터미널 직접 입력은 사용하지 않는다.
가드는 보안 경계가 아니다. 진짜 실행 파일 경로(`ORCH_REAL_ORCA`, `ORCH_REAL_GH`)가 환경에 보이므로 일부러 부르면 우회된다. 근거는 [ADR-013](../../../docs/adr/013-orch-worker-stalled.md) 이 소유한다.
