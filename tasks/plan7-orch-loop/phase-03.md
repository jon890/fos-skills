# Phase 03. 충돌 PR 처리를 루프에 더한다

**Execution profile**: deep

## 목표

틱마다 내 열린 PR 의 base 충돌을 보고, 그 PR 을 만든 기존 worker 에게 풀게 한다. `notify-conflicts.ts` 와 같은 함수, 같은 기록, 같은 종료 코드 분류를 쓴다.
이어 쓰지 못한 충돌은 알림 파일의 `CONFLICT-ORPHAN` 으로 코디네이터를 깨운다.

**범위 외**: 문서의 사용법(phase 04). 충돌 PR 에 새 worker 를 띄우는 일은 하지 않는다(사용자 결정 2026-10-24). 배포 묶기(`after-queue`)는 이 plan 에서 하지 않는다(`index.json` 의 `deferred`).

## 컨텍스트

시작 조건: `orch/scripts/lib/workers.ts` 가 있다. 없으면 `PHASE_BLOCKED: phase 02 커밋 전` 을 내고 멈춘다.

사용자 결정(2026-10-24): 충돌한 PR 은 그 PR 을 만든 기존 worker 가 푼다. 끝난 dispatch 의 터미널에 후속 지시서로 이어 쓰고, 이어 쓰지 못하면 코디네이터에게 알린다. 새 worker 자동 띄우기 설정은 두지 않는다. 원본은 `docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」 표다.

이미 있는 것:

| 일 | 위치 |
| --- | --- |
| 충돌 찾기 | `lib/conflicts.ts` 의 `findConflicts(repo, base)`. `git fetch origin` 뒤 열린 PR 마다 merge-tree 로 본다. 다른 사람의 PR 도 결과에 든다 |
| 알린 기록 | `lib/conflicts.ts` 의 `notifiedFile(repo)`, `notifiedKey(pr, baseSha)`, `loadNotified(file)`, `recordNotified(file, repo, key, value)`, `ORPHAN`. 파일은 `state/notify-conflicts.json` 이다 |
| worker 찾기 | `lib/workers.ts` 의 `worktreePaths`, `workerRows`, `workerFor`, `LIVE_DISPATCH`(phase 02) |
| 내 PR | `lib/gh.ts` 의 `ownAuthors`, `isOwnPr`, `apiTarget` |
| PR 하나의 처리 | 아직 `notify-conflicts.ts` 안이다. `message(number, base, baseSha, files)`, `followUp(repo, pr, base, baseSha, files, file)`, `prInput(pr)`, `send-to-worker` 호출(`SEND_MS` 65분), `RELAUNCHED`(`/^LAUNCHED \S/m`), 종료 코드 분류, `conclude`(기록 뒤 `pr-conflict`), `orphan` |

`notify-conflicts.ts` 머리 주석의 종료 코드 표가 분류의 원본이다.

| send-to-worker 종료 코드 | 살아 있는 dispatch | 끝난 dispatch | 기록 |
| --- | --- | --- | --- |
| 0 | `notified` | `resumed` | 기록한다 |
| 4 | `notified`(깨우지 못함) | `resumed` | 기록한다 |
| 1 | `notified`(reply 는 남음) | stdout 에 `LAUNCHED <id>` 가 있으면 `resumed`, 없으면 보내지 못함 | 보내지 못함은 기록하지 않는다 |
| 3 | `orphan` | `orphan` | 기록한다. `CONFLICT-ORPHAN` |
| 5 와 그 밖 | 보내지 못함 | 보내지 못함 | 기록하지 않는다 |
| 2 | 사용법 오류 | 사용법 오류 | 그 자리에서 멈춘다 |

워크트리나 dispatch 를 찾지 못한 경우도 `orphan` 이고 기록한다. worker-list 를 읽지 못하면 알리지도 기록하지도 않는다.

환경 변수: `ORCA`, `GH`, `CLEANUP_SWEEP`, `BOARD_SYNC`, `ORCH_LOOP_ALIVE_SEC`, `SEND_TO_WORKER`. `lib/git.ts` 는 실행 파일을 바꾸는 환경 변수가 없고 PATH 의 `git` 을 부르므로 테스트는 실제 git 과 임시 저장소를 쓴다(`orch/tests/notify-conflicts.spec.ts` 와 같다).

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `pr-conflict` 줄과 「갈래」 의 worker 터미널 줄, `docs/data-schema.md` 의 「이벤트별 필드」 의 `pr-conflict`, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 의 충돌한 PR 줄

## 의도 메모

- 같은 (PR, base SHA) 에는 한 번만 보낸다. 기록을 명령과 루프가 함께 쓰므로 머지 큐 뒤 `notify-conflicts` 와 틱이 같은 충돌을 두 번 보내지 않는다.
- 루프도 위 표를 그대로 따른다. 다른 점은 2 다. 명령은 종료 코드 2 로 끝나지만 루프는 그 틱의 충돌 처리만 멈추고 `errors.conflicts` 로 `WATCH-ERROR conflicts: send-to-worker 사용법 오류` 를 쓴다(phase 01 의 「오류 줄 억제」). 루프를 끝내면 질문 확인도 멈춘다.
- `send-to-worker` 이어 쓰기는 65분까지 걸린다. 틱 자식 안에서 `runAsync` 로 부르고, 생존 타이머는 부모에 있으므로 그동안에도 `alive_at` 이 쓰인다.
- 끝난 dispatch 에 이어 쓰는 동안(최대 65분) 그 틱이 끝나지 않아, 다음 틱의 질문 재알림, CI 감시, 정리가 그만큼 밀린다. 이것을 받아들인다. 이어 쓰기를 틱과 떼어 내면 `state/notify-conflicts.json` 을 두 프로세스가 함께 쓰게 되어 잠금 설계가 더 필요하다. 떼어 내는 일은 `index.json` 의 `deferred` 다.
- 충돌 처리는 틱의 마지막 단계다. 같은 틱의 질문 확인, 정리, 보드 동기화, CI 감시, `tick` 이벤트는 그보다 먼저 돈다. 밀리는 것은 다음 틱뿐이다.

## 작업 항목

### 1. `lib/conflicts.ts` 의 `resolveConflict`

`notify-conflicts.ts` 의 PR 하나 처리(워크트리와 worker 찾기를 뺀 것)를 옮긴다. `message`, `followUp`, `prInput`, `RELAUNCHED`, `SEND_MS` 도 함께 옮긴다. `SEND_TO_WORKER` 의 기본은 `lib/` 의 부모 폴더의 `send-to-worker.ts` 다.

```ts
resolveConflict(args: {
  repo: string; base: string; baseSha: string; pr: OpenPr; files: string[]
  found: { path: string; row: WorkerRow } | { orphan: string }   // 찾은 worker 행, 또는 orphan 이유
  run: string | null; dryRun: boolean; out: (line: string) => void
}): Promise<{ kind: 'record'; value: string; action: 'notified' | 'resumed' | 'orphan'; worker: Worker | null }
         | { kind: 'skip' } | { kind: 'usage' }>
```

`out` 으로 지금 명령의 줄(`  <dispatch> 에 알렸다…`, `CONFLICT-ORPHAN <PR> <이유>`, `  <dispatch> 에 보내지 못했다…`)을 같은 문구로 낸다. stderr 줄도 같은 문구다.
`concludeConflict(statePath, repo, ctx, pr, files, baseSha, outcome)` 는 `recordNotified` 뒤 `pr-conflict` 를 낸다. 이벤트를 내지 못한 오류는 stderr 에 한 줄 남긴다. 두 함수를 `notify-conflicts.ts` 와 루프가 같은 순서로 부른다.
`notify-conflicts.ts` 의 출력, 기록, 종료 코드는 바뀌지 않는다. 머리 주석의 「충돌 찾기와 알린 기록은 lib/conflicts.ts 가 맡는다」 에 PR 하나의 처리를 더하고, `lib/conflicts.ts` 머리 주석에 두 함수와 사용처를 적는다.

### 2. 루프의 충돌 처리

틱의 마지막 단계로, `tick` 이벤트 뒤에 넣는다(위 「의도 메모」).

1. `findConflicts(repo, base)`. base 는 `defaultBase(repo)`, 없으면 `main` 이다. 실패하면 `WATCH-ERROR conflicts: …`
2. 내 PR 만 남긴다(`notify-conflicts.ts` 와 같은 `ownAuthors` 판정. 작성자를 정하지 못하면 `WATCH-ERROR conflicts: …` 를 쓰고 그 틱의 충돌 처리를 끝낸다)
3. 기록에 있는 (PR, base SHA) 는 넘어간다. 아니면 워크트리와 worker 행을 찾아 `resolveConflict` 와 `concludeConflict` 를 부른다. 워크트리가 없거나 행이 없으면 `found` 는 orphan 이유다. worker-list 를 읽지 못하면 그 PR 은 기록하지 않고 `WATCH-ERROR conflicts: …` 를 쓴다
4. `action` 이 `orphan` 이면 `appendEvent(repo, 'CONFLICT-ORPHAN', <PR>, <이유>)` 를 한다
5. `kind` 가 `usage` 면 그 틱의 충돌 처리를 멈춘다(위 「의도 메모」)

`out` 은 `log()` 다. 머리 주석에 충돌 처리와 `SEND_TO_WORKER` 의 쓰임을 더한다.

### 3. `docs/code-architecture.md` 「배치」

`orch/scripts/lib/conflicts.ts` 줄을 「열린 PR 의 충돌 찾기, PR 하나의 처리(`resolveConflict`, `concludeConflict`), (PR, base SHA) 마다 한 번 알린 기록 한 벌. 사용처는 머리 주석이 소유한다」 로 고친다.

### 4. 테스트

`orch/tests/orch-loop-conflict.spec.ts` 를 만든다. 임시 bare origin 과 clone 으로 충돌하는 PR 브랜치를 만들고, 가짜 gh 가 그 PR 을 열린 내 PR 로 낸다. `SEND_TO_WORKER` 가짜가 정한 종료 코드와 stdout 으로 끝난다. `notify-conflicts.spec.ts` 의 helper 를 그대로 빌려 쓰지 말고 같은 방식으로 만든다(테스트 파일끼리 import 하지 않는다).

| 사례 | 기대 |
| --- | --- |
| 살아 있는 dispatch 의 충돌 PR, 가짜가 0 | send-to-worker 가 `--dispatch <id> --body <본문>` 으로 불린다. `pr-conflict` 의 `action` 이 `notified`, 기록 값이 dispatch id |
| 끝난 dispatch 의 터미널이 남은 충돌 PR, 가짜가 0 | 후속 지시서 `spec-conflict-<PR>-<8자리>.md` 가 생기고 send-to-worker 가 `--spec` 과 함께 불린다. `action: resumed` |
| 끝난 dispatch, 가짜가 1 이고 stdout 에 `LAUNCHED d2` | `action: resumed` 로 기록한다 |
| 끝난 dispatch, 가짜가 1 이고 `LAUNCHED` 줄이 없다 | 기록하지 않는다. 다음 틱이 다시 보낸다 |
| 가짜가 3 | `CONFLICT-ORPHAN` 이 알림 파일에 한 줄, `action: orphan` 으로 기록 |
| 워크트리가 없는 충돌 PR | `CONFLICT-ORPHAN`, send-to-worker 호출 없음 |
| worker-list 실패 | 기록과 `pr-conflict` 가 없고 `WATCH-ERROR conflicts:` 한 줄 |
| 가짜가 2 | 그 틱의 다음 충돌 PR 을 보내지 않고 `WATCH-ERROR conflicts:` 한 줄. 틱 자식은 결과 JSON 을 내고 0 으로 끝나며 루프는 다음 틱을 돈다 |
| 같은 (PR, base SHA) 를 다음 틱이나 `notify-conflicts.ts` 가 다시 본다 | 다시 보내지 않는다 |
| 가짜가 3초 자고 0, `ORCH_LOOP_ALIVE_SEC=0.2` | 보내는 동안 `alive_at` 이 바뀌고 `lib/loop.ts` 의 `loopStatus` 가 살아 있다고 낸다 |

`orch/tests/notify-conflicts.spec.ts` 의 기존 사례가 옮긴 함수로 통과한다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-conflict.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/orch-loop.spec.ts orch/tests/orch-loop-ci.spec.ts orch/tests/ci-ready.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
! git grep -n "^function followUp\|^function message\|^const RELAUNCHED" -- orch/scripts/notify-conflicts.ts
python3 korean-check/scripts/korean-style-check.py docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/conflicts.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/orch-loop.ts` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/tests/orch-loop-conflict.spec.ts` | 신규 |
