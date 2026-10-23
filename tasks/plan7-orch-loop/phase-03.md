# Phase 03. 배포 묶기와 충돌 PR 처리를 루프에 더한다

**Execution profile**: deep

## 목표

`after-queue` 를 정한 간격 안에서 한 번으로 묶는다. 틱마다 내 열린 PR 의 충돌을 보고, 그 PR 을 만든 기존 worker 에게 풀게 한다.

**범위 외**: 문서(phase 04). 충돌 PR 에 새 worker 를 띄우는 일은 하지 않는다(사용자 결정 2026-10-24).

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

설정 키 `pipeline.after_queue_interval_sec` 는 `docs/data-schema.md` 가 소유한다.
사용자 결정(2026-10-24): 충돌한 PR 은 그 PR 을 만든 기존 worker 가 푼다. 끝난 dispatch 의 터미널에 후속 지시서로 이어 쓰고, 이어 쓰지 못하면 코디네이터에게 알린다. 새 worker 자동 띄우기 설정은 두지 않는다(`docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」).
충돌 판정, 후속 지시서 쓰기, 전달, 알림 기록은 `notify-conflicts.ts` 가 이미 한다(`lib/git.ts` 의 `conflicts`, `send-to-worker.ts --spec`, `state/notify-conflicts.json`). 그 함수를 명령에서 `lib/conflicts.ts` 로 옮겨 루프와 명령이 함께 쓴다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `pr-conflict`, `after-queue` 줄과 「갈래」 의 worker 터미널 줄, `docs/data-schema.md`, `docs/code-architecture.md`

## 의도 메모

- 같은 (PR, base SHA) 에는 한 번만 보낸다. 기록을 명령과 루프가 함께 쓰므로 머지 큐 뒤 `notify-conflicts` 와 틱이 같은 충돌을 두 번 보내지 않는다.
- `after-queue` 묶기: `merge_queue.ts` 는 루프가 살아 있고 간격이 0 보다 크면 `after-queue` 를 바로 내지 않고 머지한 PR 을 `loop.json` 의 대기 목록에 더한 뒤 `AFTER-QUEUE-DEFERRED` 줄을 낸다. 루프는 첫 대기가 생긴 뒤 간격이 지나면 모은 PR 로 한 번 낸다. 루프가 없으면 지금처럼 바로 낸다. 루프가 없을 때 미루면 배포가 영영 돌지 않는다.

## 작업 항목

### 1. 충돌 처리

틱마다 `lib/conflicts.ts` 로 내 열린 PR 의 충돌을 보고, 새 (PR, base SHA) 마다:

| 그 PR 의 worker | 동작 | `pr-conflict` 의 `action` | 알림 파일 |
| --- | --- | --- | --- |
| dispatch 가 살아 있다 | `send-to-worker.ts` 로 base 를 합치라고 보낸다 | `notified` | 없음 |
| dispatch 는 끝났고 터미널이 남았다 | 후속 지시서를 쓰고 `send-to-worker.ts --spec` 로 이어 쓴다 | `resumed` | 없음 |
| 이어 쓰지 못했다(`send-to-worker` 종료 코드 3) | 없음 | `orphan` | `CONFLICT-ORPHAN` |

### 2. `after-queue` 묶기

`merge_queue.ts` 와 루프에 위 「의도 메모」 의 동작을 넣는다.

### 3. 테스트

`orch/tests/orch-loop-conflict.spec.ts` 를 만든다.

| 사례 | 기대 |
| --- | --- |
| 끝난 dispatch 의 터미널이 남은 충돌 PR | 후속 지시서 파일이 생기고 send-to-worker 대역이 `--spec` 과 함께 불린다. `action: resumed` |
| send-to-worker 대역이 3 으로 끝난다 | `CONFLICT-ORPHAN`, launch 대역 호출 없음 |
| 같은 (PR, base SHA) 를 다음 틱이나 `notify-conflicts.ts` 가 다시 본다 | 다시 보내지 않는다 |
| 루프가 살아 있고 간격이 있다 | `merge_queue.ts` 가 `AFTER-QUEUE-DEFERRED` 를 내고, 루프가 간격 뒤 모은 PR 로 `after-queue` 를 한 번 낸다 |
| 루프가 없다 | `merge_queue.ts` 가 바로 `after-queue` 를 낸다 |

`orch/tests/notify-conflicts.spec.ts` 가 옮긴 판정 함수로도 통과하는지 함께 돌린다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-conflict.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/merge-queue.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/lib/conflicts.ts` | 신규 |
| `orch/tests/orch-loop-conflict.spec.ts` | 신규 |
