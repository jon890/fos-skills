# Phase 04. 잠금을 넘겨 새 설치본으로 다시 뜨기와 두 알림

**Execution profile**: standard

## 목표

phase 03 의 판정이 `go` 를 내면 옛 루프가 새 설치본의 루프를 넘겨받기 모드로 띄우고 잠금을 넘긴 뒤 끝난다. 실패하면 되돌려 계속 돈다. 성공과 실패를 등록된 Run 마다 바로 알린다.

**범위 외**: 참조 문서와 변경 조각(phase 05).

## 컨텍스트

**요구사항**: REQ2, REQ3(프로세스 몫), REQ4, REQ5

**근거 문서**: `docs/features/loop-self-update/spec.md` REQ2-REQ5·DECISION8-11·DECISION18, `docs/features/loop-self-update/design.md` 「다시 뜨는 차례」·「알림」·「실패와 일관성」, 설계 DECISION1-3·DECISION5·DECISION7, `docs/adr/032-loop-bundle-handover.md`

- `--start` 가 자식 루프를 띄우는 꼴은 `skills/orch/scripts/loop/lifecycle.ts` 321-336행(`spawn` 의 `detached`, `stdio: 'ignore'`, `ORCH_LOOP_BOUND`)과 337-368행(시작 대기, 늦은 자식 TERM)이다. 넘기기도 같은 꼴과 같은 한도 `startWaitMs()`(72행)를 쓴다.
- 잠금: `createLock`(113-127행), `lockPid`(130-133행), `takeLock`(150-167행), `releaseLock`(169-175행). 끝날 때 `process.on('exit', () => releaseLock(lock))`(494행)는 자기 pid 가 든 잠금만 지운다.
- 생존 타이머는 `foreground` 544-551행의 `setInterval` 이다. `alive_at` 을 쓴다.
- 앞 루프 등록 지우기는 508-514행, `--run` 등록은 515행, `hadRuns` 는 518행이다.
- 신호 처리는 `onSignal`(618-623행)이 `stopChildren` 으로 추적하는 자식만 끝낸다. `spawn` 으로 띄운 새 루프는 그 목록에 없다.
- 등록된 Run 은 `registeredRuns(repo)`(`lib/loop.ts`)다. 알림은 `sendNotice`(`lib/run-notice.ts` 46행). `LOOP-UPDATED`, `LOOP-UPDATE-FAIL` 은 `DIGEST_KINDS`(`lib/notice-digest.ts` 17행)에 없어 바로 간다.
- 생존 판정 `loopStatus`(`lib/loop.ts` 166행)는 `loop.json` 의 pid 가 살아 있고 `alive_at` 이 최근이면 산다고 본다.
- 프로세스 테스트의 꼴은 `skills/orch/tests/orch-loop.spec.ts` 「틱 자식의 실패」(735-772행)와 「--start, --status, --stop」(833행부터)이다. 캐시 사본 꼴은 `skills/orch/tests/lib-bundle.spec.ts` 13-24행이다. 스크립트가 `zod` 를 import 하므로 사본의 번들 루트에 저장소 `node_modules` 의 심볼릭 링크를 둔다.

## 의도 메모

- 옛 루프는 새 루프가 `loop.json` 에 자기 pid 를 쓴 것을 본 뒤에만 끝난다. 먼저 끝나면 그 사이 생존 판정이 `pid 종료` 를 낸다(ADR-032 의 기각 대안).
- 새 루프를 띄우기 전에 생존 타이머를 멈춘다. 남으면 새 루프가 쓴 `loop.json` 을 옛 pid 로 덮는다.
- 넘겨받기 모드의 새 루프는 `--run` 을 다시 등록하지 않는다. 넘기는 사이 `--stop --run` 으로 뺀 Run 을 되살리지 않으려는 것이다.
- 테스트는 실제 플러그인 설치 기록과 사용자 프로필을 건드리지 않는다. 모든 프로세스에 임시 `CLAUDE_CONFIG_DIR` 을 준다.

## 작업 항목

### 1. `skills/orch/scripts/loop/self-update.ts`

- `export const HANDOVER_ENV = 'ORCH_LOOP_HANDOVER'`.
- `export function updatedText(repoName, oldVersion, newVersion, oldBundle, newBundle): string` 과 `failedText(repoName, oldVersion, newVersion, reason, entry): string` — 설계 「알림」 표의 문구. 버전이 같거나 하나라도 `-` 면 버전 뒤에 `(<경로>)` 를 붙인다.
- `export async function handOver(opts): Promise<'handed' | 'failed' | 'lost'>`. `opts` 는 `{ ctx, state, lock, entry, hadRuns, stopTimer, startTimer, oldVersion, newVersion, oldBundle, newBundle }` 이다. 설계 「다시 뜨는 차례」 의 옛 루프 쪽 1-6 을 그대로 한다.
  - 잠금 바꾸기는 `<lock>.<pid>.tmp` 에 쓰고 `renameSync`.
  - 진행 중인 새 pid 를 모듈 변수로 두고 `export function pendingHeir(): number | null` 로 낸다.
  - 실패 이유: `종료 코드 <n>`, `<초>초 안에 loop.json 을 쓰지 않았다`, `진입점이 없다`, `띄우지 못했다: <오류>`.
  - 성공하면 loop.log 에 `LOOP-HANDOVER <새 pid> <옛 버전> <새 버전>`, 등록된 Run 마다 `sendNotice('LOOP-UPDATED', null, updatedText(...), run, ctx.repo)`. 실패하면 `LOOP-UPDATE-FAIL <이유>` 줄과 Run 마다 `sendNotice('LOOP-UPDATE-FAIL', …)`. 전송 예외는 `NOTICE-FAIL <kind> <이유>` 로그만 남긴다. 잠금에 둘 밖의 살아 있는 루프가 있으면 `LOOP-HANDOVER-LOST <pid>` 를 쓰고 `'lost'`.
  - 파일 맨 위 설명에 차례와 번들 사이 계약(ADR-032)을 적는다.

### 2. `skills/orch/scripts/loop/lifecycle.ts`

- 옛 루프 쪽: phase 03 의 `go` 자리에서 `handOver` 를 부른다. `'handed'` 나 `'lost'` 면 `foreground` 가 0 을 낸다(그 뒤 `writeLoop` 하지 않는다). `'failed'` 면 `update.failed = heirEntry(update.target)` 로 두고 잠을 잔 뒤 다음 틱으로 간다. 생존 타이머는 `stopTimer`·`startTimer` 콜백으로 넘길 수 있게 `setInterval` 부분을 함수로 뺀다.
- 새 루프 쪽: `foreground` 시작에서 `process.env[HANDOVER_ENV]` 를 JSON 으로 읽고 환경에서 지운다. 읽지 못하면 넘겨받기 모드가 아니다.
  - `takeLock(lock, repo, from)`: 설계 「새 루프 쪽」 의 규칙. 잠금 내용이 자기 pid 면 `null`(얻음), `from` pid 이고 `isLoopProcess(from) !== false` 면 `POLL_MS` 마다 다시 읽으며 기다린다. 나머지는 지금 규칙.
  - 넘겨받기 모드면 508-514행과 515행을 건너뛰고 `hadRuns = had_runs || runs.length > 0` 이다.
- `onSignal` 에서 `pendingHeir()` 가 있으면 그 pid 에 TERM 을 보낸 뒤 지금처럼 `stopChildren` 한다.
- 파일 맨 위 설명 「한 저장소에 하나」 에 넘겨받기 예외를, 「스스로 다시 뜨기」 절에 차례와 두 알림을 적는다.

### 3. `skills/orch/tests/orch-loop-self-update.spec.ts`(신규, 프로세스)

준비: 임시 폴더에 설정 폴더 `cfg/` 를 만들고, 저장소의 `skills/orch` 와 `.claude-plugin` 을 `cfg/plugins/cache/fos-skills/fos-skills/1.0.0/` 과 `.../2.0.0/` 에 복사한다. 각 사본의 `plugin.json` 버전을 폴더 이름으로 바꾸고 `node_modules` 링크를 둔다. `installed_plugins.json` 의 user 항목은 처음에 1.0.0 을 가리킨다. 임시 저장소와 `ORCH_DIR`, 가짜 `ORCA`(받은 인자를 파일에 적는다, `orch-loop.spec.ts` 의 `FAKE_ORCA` 꼴), `tick_sec: 0.3`, `ORCH_LOOP_ALIVE_SEC=1` 을 쓴다. 부모는 1.0.0 사본의 `orch-loop.ts` 에 `--repo <저장소> --run r1 --foreground` 인자를 줘서 띄우고 `r2` 를 등록 파일로 더한다.

사례:

- **넘기기**: 두 틱이 돈 뒤 설치 기록을 2.0.0 으로 바꾼다. 기대: loop.log 에 `LOOP-STALE 1.0.0 2.0.0 <2.0.0 사본의 orch-loop.ts>` 한 줄, `LOOP-HANDOVER` 한 줄. `--status` 가 `bundle=2.0.0` 이고 pid 가 옛 pid 와 다르다. 등록 파일 목록이 `r1`, `r2` 그대로다. `ps` 에서 `--foreground` 인 `orch-loop` 프로세스가 하나다. 옛 pid 가 끝났다. 넘기는 동안 다른 비동기 고리가 20ms 마다 `loopStatus` 를 읽은 결과가 한 번도 죽음이 아니다. 가짜 ORCA 기록에 `LOOP-UPDATED` 가 `r1`, `r2` 에 하나씩이고 본문에 저장소 폴더 이름과 `1.0.0 → 2.0.0` 이 있다. 넘긴 뒤 틱의 loop.log 에 `STALE-BUNDLE` 이 없다.
- **기다림**: 넘기기 전에 `ORCH_DIR` 의 `queue/finish-9.pid` 에 따로 띄운 `sleep` 프로세스의 pid 를 쓴다. 기대: `LOOP-STALE-WAIT 마무리 PR 9` 한 줄이 있고 그동안 넘기지 않는다. 그 사이 틱들의 loop.log 에 `LOOP-STALE` 이 더 없고 `STALE-BUNDLE` 도 없다. `sleep` 을 끝내면 다음 틱 뒤 넘기고, 마무리 대역 프로세스에는 신호가 가지 않았다(끝내기 전까지 살아 있었다).
- **설정 오류**: 옛 번들만 새 설정을 모르는 경우를 흉내 낸다. 1.0.0 사본의 `orch-loop.ts` 맨 앞에 「`--tick` 인자가 있고 임시 표지 파일이 있으면 stderr 에 `orch-loop: 모르는 절이 있다: adr` 을 쓰고 2 로 끝난다」 는 줄을 더한다. 2.0.0 사본은 고치지 않는다. 마무리 대역을 살려 둔 채 표지 파일을 만들고 설치 기록을 2.0.0 으로 바꾼다. 기대: 종료 코드 2 인 틱 바로 뒤에 `LOOP-STALE-WAIT` 없이 넘기고, 새 루프의 틱은 성공하며, 마무리 대역은 살아 있다.
- **실패 되돌리기**: 2.0.0 사본의 `orch-loop.ts` 를 곧바로 1 로 끝나는 파일로 바꾼다. 기대: 옛 루프가 계속 틱을 돌고 잠금 파일이 옛 pid 다. `LOOP-UPDATE-FAIL` 이 Run 마다 하나이고 본문에 `종료 코드 1` 이 있다. 그 뒤 세 틱 동안 다시 시도하지 않는다(새 `LOOP-UPDATE-FAIL` 도 새 자식도 없다).
- **넘기는 사이 --stop**: 2.0.0 사본의 `orch-loop.ts` 앞에 2초 잠드는 줄을 더해 넘기는 시간을 늘린 뒤, 넘기기가 시작되면(`LOOP-STALE` 줄 뒤) 1.0.0 사본으로 `--stop --all` 을 부른다. 기대: `LOOP-STOPPED` 이고 `orch-loop` 프로세스가 남지 않는다.

모든 사례는 `after` 에서 남은 프로세스를 KILL 하고 임시 폴더를 지운다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/orch-loop-self-update.spec.ts skills/orch/tests/loop-self-update.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/loop-steps.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/loop/self-update.ts` | 수정 (`handOver`, 알림 문구) |
| `skills/orch/scripts/loop/lifecycle.ts` | 수정 (넘기기 호출, 넘겨받기 모드, 신호) |
| `skills/orch/tests/loop-self-update.spec.ts` | 수정 (알림 문구 단위 사례) |
| `skills/orch/tests/orch-loop-self-update.spec.ts` | 신규 |
