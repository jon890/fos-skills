# Phase 03. 답하기 명령과 worker 의 질문 명령을 옮긴다

**Execution profile**: standard

## 목표

`send-to-worker`, `nudge-worker`, `worker-ask` 를 TypeScript 로 옮긴다. `ask-json.py` 의 JSON 해석은 `worker-ask.ts` 안으로 합친다.

**범위 외**: 대기와 질문 감시(phase 04). `notify-conflicts.py` 는 아직 Python 이고 `send-to-worker.py` 경로를 부르므로 shim 이 필요하다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/send-to-worker.py` | `orch/scripts/send-to-worker.ts` | `orch/tests/test_launch_send.py` 의 `SendToWorkerTest` → `orch/tests/send-to-worker.spec.ts` |
| `orch/scripts/nudge-worker.py` | `orch/scripts/nudge-worker.ts` | `orch/tests/test_nudge_worker.py` → `orch/tests/nudge-worker.spec.ts` |
| `orch/scripts/worker-ask.py`, `orch/scripts/ask-json.py` | `orch/scripts/worker-ask.ts` | `orch/tests/test_scripts.py` 의 `WorkerAskTest` → `orch/tests/worker-ask.spec.ts` |

명령 이름, 옵션, 종료 코드, 출력 줄(`worker-ask` 의 첫 줄 `answer:`)은 원본 머리 주석과 같다.
`send-to-worker.ts` 는 `launch-worker.ts` 와 `nudge-worker.ts` 를 `scriptCommand` 로 부른다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 은 stderr 에 `DEPRECATED python3 <이름>.py → node <절대경로>/<이름>.ts` 한 줄을 내고 `os.execvp` 로 `node --disable-warning=ExperimentalWarning <같은 폴더의 이름>.ts <인자...>` 를 실행한다. 아직 Python 인 다른 명령이 `script_command` 로 이 경로를 부르므로 shim 이 없으면 그 명령이 깨진다. 다음 major 에서 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `send-to-worker.py`, `nudge-worker.py`, `worker-ask.py` 에 둔다. worker 지시서의 공통 틀이 `worker-ask.py` 경로를 부르므로 이 shim 은 특히 지우면 안 된다.
`ask-json.py` 는 `worker-ask.py` 만 불렀으므로 지운다.

**근거 문서**: `docs/code-architecture.md` 의 「배치」 와 「실행 규칙」, `docs/adr/010-orch-typescript.md`

## 의도 메모

- `worker-ask` 는 worker 세션에서 돈다. worker 세션의 PATH 에 node 가 있어야 한다. 없으면 shim 의 `execvp` 가 실패한다. shim 은 그때 「node 22.18 이상이 PATH 에 필요하다」 를 stderr 에 내고 종료 코드 127 로 끝나게 한다.

## 작업 항목

### 1. 위 표의 명령을 옮긴다

### 2. shim 의 node 부재 처리

`execvp` 의 `FileNotFoundError` 를 잡아 위 문구와 127 을 낸다. 이 처리는 이 plan 의 모든 shim 에 같게 둔다. phase 02 의 shim 도 고친다.

### 3. 테스트를 옮긴다

표의 사례를 모두 옮기고 원본을 지운다. `test_launch_send.py` 에서는 `SendToWorkerTest` 를 지운다. `test_scripts.py` 에서는 `WorkerAskTest` 를 지운다.
shim 사례 하나: PATH 에 node 가 없는 환경에서 `python3 orch/scripts/worker-ask.py --help` 가 127 이다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/send-to-worker.spec.ts orch/tests/nudge-worker.spec.ts orch/tests/worker-ask.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_launch_send.py
python3 -m unittest orch/tests/test_scripts.py
python3 scripts/run-orch-tests.py --jobs 4
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/send-to-worker.ts` | 신규 |
| `orch/scripts/nudge-worker.ts` | 신규 |
| `orch/scripts/worker-ask.ts` | 신규 |
| `orch/scripts/send-to-worker.py` | 수정 |
| `orch/scripts/nudge-worker.py` | 수정 |
| `orch/scripts/worker-ask.py` | 수정 |
| `orch/scripts/ask-json.py` | 삭제 |
| `orch/scripts/spec-line.py` | 수정 |
| `orch/scripts/spec-lint.py` | 수정 |
| `orch/scripts/make-worktree.py` | 수정 |
| `orch/scripts/worktree-deny.py` | 수정 |
| `orch/scripts/launch-worker.py` | 수정 |
| `orch/tests/send-to-worker.spec.ts` | 신규 |
| `orch/tests/nudge-worker.spec.ts` | 신규 |
| `orch/tests/worker-ask.spec.ts` | 신규 |
| `orch/tests/test_nudge_worker.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 수정 |
| `orch/tests/test_scripts.py` | 수정 |
