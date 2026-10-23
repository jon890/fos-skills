# Phase 03. 답하기 명령과 worker 의 질문 명령을 옮긴다

**Execution profile**: deep

## 목표

`send-to-worker`, `nudge-worker`, `worker-ask` 를 TypeScript 로 옮긴다. `ask-json.py` 의 JSON 해석은 `worker-ask.ts` 안으로 합친다.

**범위 외**: 대기와 질문 감시(phase 04). `notify-conflicts.py` 는 아직 Python 이고 `send-to-worker.py` 경로를 부르므로 shim 이 필요하다. shim 의 공통 처리(`orch/scripts/ts_shim.py`)는 고치지 않는다.

## 컨텍스트

시작 조건: 이 plan 의 phase 02 가 커밋됐다.

| 원본 | 새 파일 | 테스트 원본 → 새 테스트 |
| --- | --- | --- |
| `orch/scripts/send-to-worker.py` | `orch/scripts/send-to-worker.ts` | `orch/tests/test_launch_send.py` 의 `SendToWorkerTest` → `orch/tests/send-to-worker.spec.ts` |
| `orch/scripts/nudge-worker.py` | `orch/scripts/nudge-worker.ts` | `orch/tests/test_nudge_worker.py` → `orch/tests/nudge-worker.spec.ts` |
| `orch/scripts/worker-ask.py`, `orch/scripts/ask-json.py` | `orch/scripts/worker-ask.ts` | `orch/tests/test_scripts.py` 의 `WorkerAskTest` → `orch/tests/worker-ask.spec.ts` |

명령 이름, 옵션, 종료 코드, 출력 줄(`worker-ask` 의 첫 줄 `answer:`)은 원본 머리 주석과 같다. `worker-ask` 의 `--decision` 형식 검사(`docs/data-schema.md` 의 「사용자 결정 질문 형식」)도 옮긴다.
`send-to-worker.ts` 는 `launch-worker.ts` 와 `nudge-worker.ts` 를 `lib/proc.ts` 의 `scriptCommand` 로 부른다.

옮긴 명령의 `.py` 는 지우지 않고 shim 으로 바꾼다. shim 파일은 `orch/scripts/ts_shim.py` 의 `exec_ts(__file__)` 를 `if __name__ == "__main__":` 안에서 부르는 꼴이다. `orch/scripts/launch-worker.py` 가 그 꼴의 예다.
`exec_ts` 는 node 가 없거나 22.18 보다 낮으면 exec 하지 않고 종료 코드 127 로 끝난다. 다음 major 에서 shim 을 지운다([ADR-010](../../docs/adr/010-orch-typescript.md)).
shim 은 `send-to-worker.py`, `nudge-worker.py`, `worker-ask.py` 에 둔다. worker 지시서의 공통 틀이 `worker-ask.py` 경로를 부르므로 이 shim 은 특히 지우면 안 된다.
`ask-json.py` 는 `worker-ask.py` 만 불렀으므로 지운다.

**근거 문서**: `docs/code-architecture.md` 의 「배치」 와 「실행 규칙」, `docs/adr/010-orch-typescript.md`

## 의도 메모

- `worker-ask` 는 worker 세션에서 돈다. worker 세션의 PATH 에 node 22.18 이상이 있어야 한다. 없으면 shim 이 127 과 안내 한 줄로 끝난다. 이 phase 는 그 동작을 `worker-ask.py` 경로로 한 번 더 확인한다.
- 모든 worker 가 부르는 경로라 옵션과 출력 줄을 한 글자도 바꾸지 않는다. 종료 코드 3, 4, 5 의 뜻은 `orch/templates/spec-common.md` 가 worker 에게 안내한다.

## 작업 항목

### 1. 위 표의 명령을 옮기고 shim 으로 바꾼다

### 2. `orch/README.md`

`scripts/worker-ask.py` 줄의 「JSON 해석은 `scripts/ask-json.py` 가 맡는다」 를 뺀다. 지운 파일을 가리키지 않게 하기 위해서다.

### 3. 테스트를 옮긴다

표의 사례를 모두 옮기고 원본을 지운다. `test_launch_send.py` 에서는 `SendToWorkerTest` 를 지운다. `test_scripts.py` 에서는 `WorkerAskTest` 를 지운다.
`worker-ask.spec.ts` 에 shim 사례 하나를 더한다: PATH 에 node 가 없는 환경에서 `python3 orch/scripts/worker-ask.py --help` 가 127 이고 stderr 에 `node 22.18 이상이 PATH 에 필요하다` 가 있다. `python3` 은 절대경로로 부른다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/send-to-worker.spec.ts orch/tests/nudge-worker.spec.ts orch/tests/worker-ask.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts"
python3 -m unittest orch/tests/test_launch_send.py
python3 -m unittest orch/tests/test_scripts.py
python3 scripts/run-orch-tests.py --jobs 4
! grep -n "ask-json" orch/README.md
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
| `orch/tests/send-to-worker.spec.ts` | 신규 |
| `orch/tests/nudge-worker.spec.ts` | 신규 |
| `orch/tests/worker-ask.spec.ts` | 신규 |
| `orch/tests/test_nudge_worker.py` | 삭제 |
| `orch/tests/test_launch_send.py` | 수정 |
| `orch/tests/test_scripts.py` | 수정 |
| `orch/README.md` | 수정 |
