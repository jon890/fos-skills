# Phase 03. 배포 묶기와 충돌 PR 처리를 루프에 더한다

**Execution profile**: deep

## 목표

`after-queue` 를 정한 간격 안에서 한 번으로 묶는다. 틱마다 내 열린 PR 의 충돌을 보고, 담당이 끝난 충돌 PR 은 알리거나, 저장소가 켰으면 새 worker 를 띄운다.

**범위 외**: 문서(phase 04).

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

설정 키(`pipeline.after_queue_interval_sec`, `pipeline.conflict.auto_launch`, `pipeline.conflict.agent`, `model`, `effort`)는 `docs/data-schema.md` 가 소유한다. `auto_launch` 가 true 인데 셋 가운데 하나라도 없으면 `lib/config.ts` 가 `ConfigError` 를 낸다.
사용자 결정(2026-10-24): 코어 기본은 `pr-conflict` 이벤트와 코디네이터 알림만 낸다. `pipeline.conflict.auto_launch` 를 켠 저장소는 담당이 끝난 충돌 PR 에 새 worker 를 자동으로 띄운다(`docs/code-architecture.md` 의 「사용자 결정 (2026-10-24)」).
충돌 판정과 알림 기록은 `notify-conflicts.ts` 의 판정(`lib/git.ts` 의 `conflicts`, `state/notify-conflicts.json`)을 쓴다. 판정과 기록 함수를 명령에서 `lib/conflicts.ts` 로 옮겨 루프와 명령이 함께 쓴다.
worker 띄우기는 `launch-worker.ts --resume-remote` 다. 원격 PR 브랜치를 이어 받는 절차는 `orch/references/launch.md` 의 「원격 PR 브랜치를 이어 받을 때」 가 소유한다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `pr-conflict`, `after-queue` 줄, `docs/data-schema.md`, `docs/code-architecture.md`

## 의도 메모

- 자동으로 띄우는 worker 의 지시서는 루프가 `<specs>/conflict-<PR>-<base 앞 8자리>.md` 로 쓴다. `브랜치:` 는 그 PR 의 브랜치, `허락:` 은 「push 는 허락됐다. PR 은 이미 있으므로 새로 열지 않는다」 다. 할 일은 base 를 합쳐 충돌을 풀고, 저장소 검증 명령을 돌리고, push 하는 것이다. 공통 지시서를 첫 줄에서 가리킨다.
- 같은 (PR, base SHA) 에는 한 번만 띄운다. 띄운 worker 가 살아 있는 동안은 다시 띄우지 않는다.
- `after-queue` 묶기: `merge_queue.ts` 는 루프가 살아 있고 간격이 0 보다 크면 `after-queue` 를 바로 내지 않고 머지한 PR 을 `loop.json` 의 대기 목록에 더한 뒤 `AFTER-QUEUE-DEFERRED` 줄을 낸다. 루프는 첫 대기가 생긴 뒤 간격이 지나면 모은 PR 로 한 번 낸다. 루프가 없으면 지금처럼 바로 낸다. 루프가 없을 때 미루면 배포가 영영 돌지 않는다.

## 작업 항목

### 1. 충돌 처리

틱마다 내 열린 PR 의 충돌을 본다. 새 (PR, base SHA) 마다:

| 담당 | `auto_launch` | 동작 | `pr-conflict` 의 `action` | 알림 파일 |
| --- | --- | --- | --- | --- |
| 살아 있다 | 무관 | `send-to-worker.ts` 로 base 를 합치라고 보낸다 | `notified` | 없음 |
| 끝났다 | false | 없음 | `orphan` | `CONFLICT-ORPHAN` |
| 끝났다 | true | 지시서를 쓰고 `launch-worker.ts --resume-remote` 로 띄운다 | `launched` | `CONFLICT-LAUNCHED` |

띄우기가 실패하면 `orphan` 처럼 알리고 실패 이유를 `text` 에 담는다.

### 2. `after-queue` 묶기

`merge_queue.ts` 와 루프에 위 「의도 메모」 의 동작을 넣는다.

### 3. 테스트

`orch/tests/orch-loop-conflict.spec.ts` 를 만든다.

| 사례 | 기대 |
| --- | --- |
| 담당이 끝난 충돌 PR, `auto_launch` false | `CONFLICT-ORPHAN`, launch 대역 호출 없음 |
| 같은 PR, `auto_launch` true | 지시서 파일이 생기고 launch 대역이 `--resume-remote` 와 설정의 agent, model, effort 로 불린다 |
| 같은 (PR, base SHA) 를 다음 틱에 다시 본다 | 다시 띄우지 않는다 |
| `auto_launch` true 인데 model 이 없다 | `ConfigError` |
| 루프가 살아 있고 간격이 있다 | `merge_queue.ts` 가 `AFTER-QUEUE-DEFERRED` 를 내고, 루프가 간격 뒤 모은 PR 로 `after-queue` 를 한 번 낸다 |
| 루프가 없다 | `merge_queue.ts` 가 바로 `after-queue` 를 낸다 |

`orch/tests/notify-conflicts.spec.ts` 가 옮긴 판정 함수로도 통과하는지 함께 돌린다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-conflict.spec.ts orch/tests/notify-conflicts.spec.ts orch/tests/merge-queue.spec.ts orch/tests/lib-config.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/scripts/notify-conflicts.ts` | 수정 |
| `orch/scripts/lib/conflicts.ts` | 신규 |
| `orch/scripts/lib/config.ts` | 수정 |
| `orch/tests/orch-loop-conflict.spec.ts` | 신규 |
| `orch/tests/lib-config.spec.ts` | 수정 |
