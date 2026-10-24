# Phase 02. 루프에 CI 감시와 알림을 더하고 worker 찾기를 lib 로 옮긴다

**Execution profile**: deep

## 목표

루프가 틱마다 내 열린 ready PR 의 필수 체크를 보고, HEAD 마다 상태가 바뀐 때 한 번씩 `ci-passed` 나 `ci-failed` 를 낸다.
`ci-failed` 는 그 PR 의 살아 있는 worker 에게 실패한 체크를 보내고, 알림 파일의 `CI-FAILED` 로 코디네이터를 깨운다.
worker 찾기는 `notify-conflicts.ts` 안에서 `lib/workers.ts` 로 옮겨 루프와 함께 쓴다.

**범위 외**: 충돌 PR 처리(phase 03). `ci-missing`, ready 전환, 머지는 이 plan 에서 하지 않는다(`index.json` 의 `deferred`). 문서의 사용법(phase 04).

## 컨텍스트

시작 조건: `orch/scripts/lib/loop.ts` 와 `orch/scripts/orch-loop.ts` 가 있다. 없으면 `PHASE_BLOCKED: phase 01 커밋 전` 을 내고 멈춘다.

사용자 결정(2026-10-25): plan7 은 늘 도는 루프와 wait-important 연동까지만 한다. 그래서 `ci-passed` 의 코어 동작(순서 파일에 따른 머지 큐 차례)은 하지 않고 이벤트만 낸다. `pipeline.enabled` 는 읽지 않는다.

필수 체크 이름을 정하는 지금 코드:

| 출처 | 읽는 곳 |
| --- | --- |
| `config.json` 의 `queue.required`(문자열 또는 문자열 목록) | `merge-with-finish.ts` 의 `queueDefaults` 가 `--required` 로 바꿔 머지 큐에 넘긴다. `queue` 절의 아는 키는 같은 파일의 `QUEUE_KEYS`, `QUEUE_FLAGS`, `QUEUE_REPEATED`, `QUEUE_GROUPS` 의 키를 합친 `QUEUE_SECTION_KEYS` 다 |
| 명령줄 `--required` 와 저장소 규칙 | `merge_queue.ts` 의 `requiredChecks()`(973행 근처). `--required` 가 없으면 `repos/<owner>/<repo>/rules/branches/<base>` 를 `RULES_JQ` 로 읽는다. 무료 플랜의 비공개 저장소는 HTTP 403 과 `Upgrade to GitHub Pro` 로 실패하고, 그때는 빈 목록으로 본다 |
| 실패 판정 | `merge_queue.ts` 의 `FAIL_SEL`: 결론이 `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE` 이거나 상태가 `FAILURE`, `ERROR` 다. `queue.skipped_is_missing` 이면 `SKIPPED` 체크를 나타나지 않은 것으로 본다 |

`notify-conflicts.ts` 안의 worker 찾기: `worktreePaths(repo)`(`git worktree list --porcelain` 에서 {브랜치: 경로}), `workerRows(run)`(worker-list 를 모든 페이지에 걸쳐 읽는다), `workerFor(rows, path)`(그 워크트리의 행, 살아 있는 dispatch 먼저), `ACTIVE`(`pending`, `dispatched`, `running`). 새 파일 이름은 `lib/` 의 명사 이름 관례(`questions.ts`, `conflicts.ts`, `ownership.ts`)를 따라 `lib/workers.ts` 다.
「내 PR」 판정은 이미 `lib/gh.ts` 의 `ownAuthors(repo, host)`, `isOwnPr(pr, authors)` 다.

환경 변수: `ORCA`, `GH`, `CLEANUP_SWEEP`, `BOARD_SYNC`, `ORCH_LOOP_ALIVE_SEC`(phase 01), 그리고 worker 에게 보내는 명령 경로 `SEND_TO_WORKER`(`notify-conflicts.ts` 와 같은 이름, 기본은 같은 폴더의 `send-to-worker.ts`)다.

이벤트 입력 `ci-passed`, `ci-failed` 의 필드(`pr`, `checks`, `required`)는 `docs/data-schema.md` 「이벤트별 필드」 가, 시점은 `docs/flow.md` 「이벤트 목록」 이 소유한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `ci-passed`, `ci-failed` 줄, `docs/data-schema.md` 의 「이벤트별 필드」 와 「orch 루트에 더하는 파일」 의 `state/loop.json`, `docs/code-architecture.md` 의 「공통 안전 장치」 의 다른 사람 PR 제외 줄

## 의도 메모

- 같은 상태를 두 번 알리지 않는다. PR 마다 (HEAD SHA, 상태)를 `loop.json` 의 `ci` 에 남기고 `passed` 나 `failed` 로 바뀐 때만 낸다. 같은 HEAD 에서 다시 돌린 체크가 통과로 바뀌면 `ci-passed` 를 낸다. 새 HEAD 는 새로 판정한다.
- 필수 체크 판정은 머지 큐와 한 벌이다. 머지 큐가 통과로 보는 PR 을 루프가 실패로 알리면 코디네이터가 둘 중 어느 쪽을 믿을지 모른다. 그래서 규칙 조회와 실패 판정의 상수를 `lib/gh.ts` 로 옮기고 `merge_queue.ts` 가 import 한다. 판정 흐름(`stop`, 로그 문구)은 바꾸지 않는다.
- 필수 체크 목록이 비면(규칙 없음, 플랜 제한) 롤업에 나타난 체크 전부로 판정한다. 체크가 하나도 없으면 `pending` 이다. 머지 큐의 「지금 있는 체크만 기다린다」 와 같다.
- `ci-failed` 는 살아 있는 dispatch 에만 보낸다. 끝난 dispatch 에 후속 지시서로 이어 쓰는 일은 충돌(phase 03)에만 정한 사용자 결정이라 CI 실패에는 넓히지 않는다. 그때는 `CI-FAILED` 로 코디네이터가 판단한다.
- 다른 사람의 PR 과 draft 는 보지 않는다.

## 작업 항목

### 1. `orch/scripts/lib/workers.ts`

`notify-conflicts.ts` 의 `worktreePaths`, `workerRows`, `workerFor` 와 `ACTIVE`(이름은 `LIVE_DISPATCH` 로 export)를 옮기고 export 한다. 동작과 주석은 그대로다. `notify-conflicts.ts` 는 이것을 import 한다. 출력과 종료 코드는 바뀌지 않는다.
머리 주석에 사용처(notify-conflicts, orch-loop)를 적는다.

### 2. `queue` 절의 아는 키를 `lib/config.ts` 로 옮긴다

`lib/config.ts` 에 `export const QUEUE_KEYS: readonly string[]` 를 두고 `PIPELINE_KEYS` 처럼 `orch/references/overlay.md` 「마무리 설정 파일」 표의 `queue` 행 키를 모두 담는다. `merge-with-finish.ts` 는 `section(config, 'queue', QUEUE_KEYS)` 로 읽고 `QUEUE_SECTION_KEYS` 를 지운다. 옵션으로 바꾸는 네 표(`QUEUE_KEYS` 는 이름이 겹치므로 `QUEUE_VALUES` 로 바꾼다)는 그 파일에 남긴다.
`lib/config.ts` 머리 주석의 「queue 절은 …」 문장에 이 상수를 더한다.

### 3. `lib/gh.ts` 의 필수 체크 판정

- `RULES_JQ`, `FAILED_CONCLUSIONS`, `FAILED_STATES` 를 `merge_queue.ts` 에서 옮겨 export 한다. `merge_queue.ts` 는 이것을 import 하고 `FAIL_SEL` 을 두 목록으로 만든다
- `ruleChecks(host, slug, base): { ok: true; names: string[] } | { ok: false; error: string }`. 플랜 제한(HTTP 403 과 `Upgrade to GitHub Pro`)은 빈 목록이다
- `requiredNames(repo, host, slug, base)`: `queue.required` 가 있으면 그것(목록이면 그대로, 문자열이면 쉼표로 나눈다), 없으면 `ruleChecks` 다
- `ciState(rollup, required, skippedIsMissing): { state: 'passed' | 'failed' | 'pending'; checks: { name, status, conclusion, url }[] }`. 롤업 행의 이름은 `name`, 없으면 `context` 다. URL 은 `detailsUrl`, 없으면 `targetUrl` 이다. 필수 체크 하나라도 실패면 `failed`, 모두 나타나 모두 끝났고 실패가 없으면 `passed`, 그 밖은 `pending` 이다

### 4. 루프의 CI 감시

phase 01 의 틱 3단계(보드 동기화)와 `tick` 이벤트 사이에 넣는다. phase 01 의 열린 PR 조회 필드에 `title,headRefName,headRefOid,isDraft,baseRefName,statusCheckRollup` 을 더해 한 번만 읽는다.

1. 내 PR 가운데 draft 가 아닌 것마다 `requiredNames` 와 `ciState` 로 상태를 정한다. 같은 base 의 규칙은 틱마다 한 번 읽는다. 규칙을 읽지 못하면 그 base 의 PR 은 건너뛰고 `errors.ci` 로 `WATCH-ERROR ci: …` 를 쓴다(phase 01 의 「오류 줄 억제」)
2. 틱 자식은 `loop.json` 의 `ci[<PR>]` 를 읽기만 한다. 같은 HEAD 의 같은 상태면 넘어간다. 아니면 그 PR 의 새 `{ head, state }` 를 결과 JSON 의 `ci` 에 담는다. 결과의 `ci` 는 이번 틱에 본 열린 PR 전부의 값이고, 부모가 그것으로 `loop.json` 의 `ci` 를 바꿔 쓴다(phase 01 의 「틱」). 그래서 열린 목록에 없는 PR 의 항목은 빠진다. 열린 PR 을 읽지 못한 틱은 결과에 `ci` 를 넣지 않고 부모는 이전 값을 둔다
3. `passed` 로 바뀌면 `ci-passed` 를 낸다
4. `failed` 로 바뀌면 그 PR 의 worker 에게 보내고(아래), `appendEvent(repo, 'CI-FAILED', <PR>, <text>)` 를 한 뒤 `ci-failed` 를 낸다

worker 에게 보내기: Run id 가 없으면 보내지 않는다. 있으면 `worktreePaths(repo)` 에서 그 PR 브랜치의 워크트리를, `workerFor(workerRows(run).rows, path)` 로 그 행을 찾는다. 행의 dispatch 가 `LIVE_DISPATCH` 면 `scriptCommand(SEND_TO_WORKER, ['--dispatch', <id>, '--body', <본문>, '--run', run])` 를 `runAsync` 로 부른다(시간 제한 `notify-conflicts.ts` 의 `SEND_MS` 와 같은 65분).
본문은 `PR #<n> 의 필수 체크가 실패했다: <이름> <URL>, …. 실패를 고치고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.` 다.
`CI-FAILED` 의 text 는 실패한 체크 이름 목록과 worker 결과(`보냈다 <dispatch>`, `깨우지 못했다(종료 코드 4)`, `보내지 못했다(종료 코드 <n>)`, `살아 있는 dispatch 없음`, `Run id 없음`, `worker 목록을 읽지 못했다`)다.

머리 주석에 CI 감시 판정과 `SEND_TO_WORKER` 를 더한다.

### 5. 문서

- `docs/data-schema.md` 「orch 루트에 더하는 파일」 의 `state/loop.json` 행에 `ci`(PR 번호에서 `{ head, state }`)를 더한다
- `docs/code-architecture.md` 「배치」 에 `orch/scripts/lib/workers.ts` 줄(브랜치의 워크트리와 그 worker 행 찾기 한 벌. 사용처는 머리 주석이 소유한다)을 더한다

### 6. 테스트

`orch/tests/orch-loop-ci.spec.ts` 를 만든다. `--foreground --once` 를 여러 번 돌린다. 가짜 gh 는 호출마다 테스트가 정한 PR 목록과 롤업, 규칙을 낸다. `SEND_TO_WORKER` 가짜는 받은 인자를 파일에 적고 정한 종료 코드로 끝난다.

| 사례 | 기대 |
| --- | --- |
| 같은 HEAD 의 실패를 두 틱 연속 본다 | `ci-failed` 와 `CI-FAILED` 는 한 번 |
| 실패한 PR 에 새 HEAD 가 오고 다시 실패 | 한 번 더 |
| 필수 체크가 모두 통과 | `ci-passed` 한 번, 알림 파일에 줄 없음 |
| 필수 체크 하나가 아직 나타나지 않았다 | 이벤트 없음 |
| `queue.required` 와 다른 `queue` 키(`method`, `docs_glob`)가 있다 | 규칙 API 를 부르지 않고 그 이름으로 판정한다. 사용법 오류가 아니다 |
| 규칙이 플랜 제한(403)이다 | 나타난 체크 전부로 판정한다 |
| `queue.skipped_is_missing` 이고 필수 체크가 `SKIPPED` | 이벤트 없음 |
| draft PR 과 다른 작성자의 PR 이 실패 | 이벤트도 보내기도 없다 |
| 실패한 PR 의 브랜치 워크트리에 살아 있는 dispatch | send-to-worker 가짜가 `--dispatch <id> --body` 와 함께 불리고 본문에 실패한 체크 이름과 URL 이 있다 |
| 그 dispatch 가 끝났다 | send-to-worker 가 불리지 않고 `CI-FAILED` text 에 `살아 있는 dispatch 없음` |

`orch/tests/lib-gh.spec.ts` 에 `ciState` 사례(실패 결론과 실패 상태 각각, 빈 필수 목록, `name` 없는 커밋 상태의 `context`)와 `requiredNames` 의 문자열과 목록 사례를 더한다.
`orch/tests/lib-config.spec.ts` 에 `QUEUE_KEYS` 가 `orch/references/overlay.md` 「마무리 설정 파일」 표의 `queue` 행 둘째 열에서 뽑은 키 집합과 같은지 보는 사례를 더한다. 개수를 적지 않고 두 집합을 비교한다.
`notify-conflicts.spec.ts`, `merge-with-finish.spec.ts`, `merge-queue.spec.ts` 의 기존 사례가 옮긴 함수와 상수로 통과한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-ci.spec.ts orch/tests/orch-loop.spec.ts orch/tests/lib-gh.spec.ts orch/tests/lib-config.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/merge-with-finish.spec.ts orch/tests/merge-queue.spec.ts orch/tests/merge-queue-overlap.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
! git grep -n "function workerFor\|function workerRows\|function worktreePaths" -- orch/scripts/notify-conflicts.ts
python3 korean-check/scripts/korean-style-check.py docs/data-schema.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/workers.ts` | 신규 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/lib/config.ts` | 수정 |
| `orch/scripts/merge-with-finish.ts` | 수정 |
| `orch/scripts/lib/gh.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/tests/orch-loop-ci.spec.ts` | 신규 |
| `orch/tests/lib-gh.spec.ts` | 수정 |
| `orch/tests/lib-config.spec.ts` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
