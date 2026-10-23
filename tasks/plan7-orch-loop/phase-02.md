# Phase 02. 루프에 CI 감시, ready 슬롯, 머지 순서, 문서 PR 바로 머지를 더한다

**Execution profile**: deep

## 목표

루프가 틱마다 내 열린 PR 의 필수 체크를 보고 `ci-passed`, `ci-failed`, `ci-missing` 을 한 번씩 낸다.
`pipeline.enabled` 인 저장소에서는 runner 수만큼 draft 를 ready 로 바꾸고, 순서 파일대로 통과한 PR 을 머지 큐에 넣고, 문서 PR 을 바로 머지하고, 뒤처진 draft 에 base 를 합친다.

**범위 외**: 배포 묶기와 충돌 PR 처리(phase 03).

## 컨텍스트

시작 조건: 이 plan 의 phase 01 이 커밋됐다.

설정 키(`pipeline.enabled`, `ready_slots`, `docs_merge`, `ci_missing_after_sec`, `update_behind_drafts`, `authors`)의 뜻과 기본값은 `docs/data-schema.md` 의 「config.json 에 더하는 절」 이, `state/order.json` 과 `state/loop.json` 의 형식은 「orch 루트에 더하는 파일」 이 소유한다.
이벤트의 시점은 `docs/flow.md` 의 「이벤트 목록」 이 소유한다.

쓰는 것:

| 일 | 부르는 것 |
| --- | --- |
| 필수 체크 이름 | `merge_queue.ts` 가 쓰는 판정(`--required`, `queue.required`, 저장소 규칙). 그 함수를 `lib/gh.ts` 로 옮겨 함께 쓴다 |
| draft 를 ready 로 | `ci-ready.ts`. 겹침, 충돌 보류, `before-ready` 를 그 명령이 이미 한다 |
| 머지 | `merge-with-finish.ts` 를 PR 번호 순서대로. 업무의 마지막 PR 표시(`!`)는 순서 파일의 항목이 정한다 |
| 뒤처진 draft 에 base 합치기 | `lib/gh.ts` 의 `updateBranch(…, 'behind-draft')`. ready PR 에는 이 함수가 거부한다 |

`orch-loop.ts --order 101 102! 103` 이 순서 파일을 덮어쓴다. 머지되거나 닫힌 PR 은 틱마다 뺀다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `ci-passed`, `ci-failed`, `ci-missing` 줄과 「운영 공백을 막는 곳」 의 CI 재시작 줄, `docs/data-schema.md`, `docs/code-architecture.md` 의 「코어와 저장소의 경계」

## 의도 메모

- 같은 상태를 두 번 알리지 않는다. PR 마다 (HEAD SHA, 체크 상태)를 `loop.json` 에 남기고 바뀐 때만 이벤트를 낸다.
- ready 슬롯은 ready 이고 아직 머지되지 않은 내 PR 수로 센다. 다른 사람의 PR 은 세지도 바꾸지도 않는다.
- 순서 파일에 없는 PR 은 머지하지 않는다. 자동 머지는 사람이 순서를 정한 PR 과 `docs_merge` 의 문서 PR 만이다.
- 머지는 틱 안에서 기다리지 않는다. `merge-with-finish.ts` 를 분리해 띄우고, 같은 저장소에 돌고 있는 머지 큐가 있으면 다음 틱으로 미룬다.

## 작업 항목

### 1. CI 감시

틱마다 내 열린 ready PR 의 필수 체크를 읽어 아래를 낸다.

| 이벤트 | 조건 | 알림 파일 |
| --- | --- | --- |
| `ci-passed` | 필수 체크가 모두 나타났고 모두 통과 | 없음 |
| `ci-failed` | 필수 체크 하나라도 실패 | `CI-FAILED` |
| `ci-missing` | ready 로 바뀐 뒤 `ci_missing_after_sec` 가 지났는데 필수 체크 하나라도 없다 | `CI-MISSING` |

`ci-failed` 의 코어 동작으로 그 PR 의 worker 가 살아 있으면 `send-to-worker.ts` 로 실패한 체크 이름과 URL 을 보낸다.

### 2. 자동 진행 (`pipeline.enabled` 일 때만)

1. ready 슬롯이 비면 순서 파일 앞쪽의 draft 부터 `ci-ready.ts` 로 ready 로 바꾼다
2. `update_behind_drafts` 면 base 에 뒤처진 내 draft 에 base 를 합친다
3. 순서 파일 맨 앞의 PR 이 `ci-passed` 상태면 `merge-with-finish.ts` 를 띄운다
4. `docs_merge` 면 바꾼 파일이 모두 `queue.docs_glob` 에 맞고 `ci-passed` 인 내 PR 을 순서와 무관하게 머지한다

### 3. `--order`

### 4. 테스트

`orch/tests/orch-loop-ci.spec.ts` 를 만든다. 가짜 gh 가 틱마다 다른 체크 상태를 낸다.

| 사례 | 기대 |
| --- | --- |
| 같은 HEAD 의 실패를 두 틱 연속 본다 | `ci-failed` 와 `CI-FAILED` 는 한 번 |
| ready 뒤 시간이 지나도 체크가 없다 | `ci-missing` |
| `pipeline.enabled` 가 false | ready 전환과 머지 호출이 없다. CI 이벤트는 낸다 |
| 슬롯 1, ready PR 하나 | 다른 draft 를 ready 로 바꾸지 않는다 |
| 다른 작성자의 draft | 바꾸지도 합치지도 않는다 |
| 순서 파일 앞 PR 이 통과 | `merge-with-finish.ts` 대역이 그 번호로 불린다 |
| ready PR 이 base 에 뒤처졌다 | update-branch 호출이 없다 |

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop-ci.spec.ts orch/tests/orch-loop.spec.ts orch/tests/lib-gh.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 수정 |
| `orch/scripts/lib/gh.ts` | 수정 |
| `orch/scripts/merge_queue.ts` | 수정 |
| `orch/tests/orch-loop-ci.spec.ts` | 신규 |
| `orch/tests/lib-gh.spec.ts` | 수정 |
