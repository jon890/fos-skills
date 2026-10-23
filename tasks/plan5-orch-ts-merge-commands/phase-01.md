# Phase 01. 단위 겹침 판정, ready 전환, 충돌 알림을 옮기고 충돌 판정을 하나로 합친다

**Execution profile**: deep

## 목표

`overlap_units`, `ci-ready`, `notify-conflicts` 를 TypeScript 로 옮긴다. 충돌 판정을 `lib/git.ts` 의 merge-tree 한 벌로 합치고 `before-ready`, `pr-ready`, `pr-conflict` 를 낸다.

**범위 외**: 담당이 끝난 충돌 PR 에 새 worker 를 자동으로 띄우는 일(`pipeline.conflict.auto_launch`). 상주 루프 plan 이 한다. 이 phase 의 `pr-conflict` 는 `action` 이 `notified` 나 `orphan` 이다.

## 컨텍스트

시작 조건: `plan4-orch-ts-worker-commands` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: plan4 머지 전` 을 내고 멈춘다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/overlap_units.py` | `orch/scripts/lib/overlap.ts` 와 명령 `orch/scripts/overlap_units.ts` | `orch/tests/test_overlap_units.py` → `orch/tests/overlap-units.spec.ts` |
| `orch/scripts/ci-ready.py` | `orch/scripts/ci-ready.ts` | `orch/tests/test_ci_ready.py` → `orch/tests/ci-ready.spec.ts` |
| `orch/scripts/notify-conflicts.py` | `orch/scripts/notify-conflicts.ts` | `orch/tests/test_launch_send.py` 의 `NotifyConflictsTest` → `orch/tests/notify-conflicts.spec.ts`. 전용 테스트가 없던 판정을 더한다 |

`merge_queue.py` 는 아직 Python 이고 `overlap_units` 를 import 하고 명령으로도 부른다. 그래서 `overlap_units.py` 는 phase 02 에서 머지 큐를 옮긴 뒤 shim 으로 바꾼다. 이 phase 에서는 원본을 그대로 둔다.
`ci-ready.py` 는 GitHub 의 `mergeable` 로 충돌을 보고, `notify-conflicts.py` 는 merge-tree 로 본다. 둘 다 `lib/git.ts` 의 `conflicts` 를 쓰게 한다.
「내 PR」 판정은 `lib/gh.ts` 의 `isOwnPr` 이고 작성자 목록은 `config.json` 의 `pipeline.authors`, 없으면 gh 의 현재 사용자다. `ci-ready` 와 `notify-conflicts` 는 내 PR 만 다룬다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `ci-ready.py`, `notify-conflicts.py` 에 둔다.

**근거 문서**: `docs/flow.md` 의 「이벤트 목록」 의 `before-ready`, `pr-ready`, `pr-conflict` 줄, `docs/data-schema.md`, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 의 충돌 판정 줄과 「공통 안전 장치」 의 다른 사람 PR 제외 줄

## 의도 메모

- GitHub `mergeable` 은 계산이 늦어 `UNKNOWN` 이 나오고, 두 명령이 같은 PR 을 다르게 판정하는 일이 생겼다. 로컬 merge-tree 는 원격을 fetch 한 뒤 바로 답한다.
- `before-ready` 가 거부하면 그 PR 은 `보류` 줄로 남고 종료 코드는 원본의 보류와 같다.
- `notify-conflicts` 는 (PR, base SHA) 마다 한 번만 알리는 기록(`state/notify-conflicts.json`)을 그대로 쓴다. `pr-conflict` 도 그 기록으로 한 번만 낸다.

## 작업 항목

### 1. 위 표의 명령과 모듈을 옮긴다

### 2. 이벤트

| 이벤트 | 내는 곳 | 시점 |
| --- | --- | --- |
| `before-ready` | `ci-ready.ts` | 겹침과 충돌 보류를 통과한 PR 을 ready 로 바꾸기 직전 |
| `pr-ready` | `ci-ready.ts` | ready 로 바꾼 뒤 |
| `pr-conflict` | `notify-conflicts.ts` | 새 (PR, base SHA) 를 처음 본 때. 살아 있는 worker 에게 알렸으면 `action: notified`, 담당이 끝났으면 `CONFLICT-ORPHAN <PR>` 줄과 `action: orphan` |

### 3. 테스트를 옮긴다

`orch/tests/overlap-units.spec.ts`, `orch/tests/ci-ready.spec.ts`, `orch/tests/notify-conflicts.spec.ts` 를 만든다.
표의 사례를 모두 옮기고 원본 테스트를 지운다(`test_launch_send.py` 는 앞 plan 에서 다른 클래스를 옮겨 `NotifyConflictsTest` 와 그 바탕 클래스만 남았으므로 파일째 지운다).
더할 사례: 다른 작성자의 PR 은 알리지 않는다. 담당이 끝난 PR 은 `CONFLICT-ORPHAN` 과 `action: orphan`. `before-ready.ts` 가 10 이면 ready 로 바꾸는 gh 호출이 없다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/overlap-units.spec.ts orch/tests/ci-ready.spec.ts orch/tests/notify-conflicts.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/lib/overlap.ts` | 신규 |
| `orch/scripts/overlap_units.ts` | 신규 |
| `orch/scripts/ci-ready.ts` | 신규 |
| `orch/scripts/notify-conflicts.ts` | 신규 |
| `orch/scripts/ci-ready.py` | 수정 |
| `orch/scripts/notify-conflicts.py` | 수정 |
| `orch/tests/overlap-units.spec.ts` | 신규 |
| `orch/tests/ci-ready.spec.ts` | 신규 |
| `orch/tests/notify-conflicts.spec.ts` | 신규 |
| `orch/tests/test_overlap_units.py` | 삭제 |
| `orch/tests/test_ci_ready.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 삭제 |
