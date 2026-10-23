# 무거운 검사 대기열

여러 worker 가 같은 PC 에서 빌드나 전체 검사를 돌릴 때 `heavy-slot.py` 로 감싼다.
기본 자리는 3개이며, 먼저 등록한 작업이 먼저 들어간다. 전체 CI 와 브라우저 검사는
모든 자리가 빌 때 혼자 실행한다. 명시적으로 혼자 실행하려면 `--exclusive` 를 준다.

```bash
python3 "$SKILL_DIR/scripts/heavy-slot.py" -- pnpm build
python3 "$SKILL_DIR/scripts/heavy-slot.py" --exclusive -- pnpm verify
```

타입 검사, lint, 파일을 지정한 단위 검사는 대기열을 거치지 않는다. 시나리오 검사와
빌드는 자리를 사용한다. 자동 분류가 맞지 않는 전체 검사는 `--exclusive` 로 지정한다.
명령 인자와 종료 코드는 그대로 전달한다. 자리를 잡은 뒤 형제 `mem-gate.sh` 로
메모리 여유를 기다리므로, 메모리를 기다리는 작업도 자리를 사용한다.

| 설정 | 기본값 | 용도 |
| --- | --- | --- |
| `HEAVY_SLOT_DIR`, `--slot-dir` | `orch_paths.py` 의 `heavy-slot` (`.orch/state/heavy-slot/`) | 같은 PC 의 worker 가 공유할 대기열 폴더 |
| `HEAVY_SLOTS`, `--slots` | `3` | 동시에 실행할 자리 수. 같은 대기열은 같은 수를 쓴다 |
| `HEAVY_EXCLUSIVE` | `0` | `1` 이면 모든 자리를 혼자 사용 |
| `HEAVY_POLL` | `5`초 | 자리 재확인 간격 |
| `MEM_GATE` | 형제 `mem-gate.sh` | 메모리 검사 경로 |

저장소마다 대기열 폴더를 달리하면 서로 제한하지 않는다. PC 전체 사용량을 제한하려면
여러 저장소에서 같은 폴더를 쓴다. 경로를 지정할 때 macOS 의 심볼릭 링크는 실경로로 푼다.
macOS 에서 자식 명령의 `TMPDIR` 도 실경로로 전달한다.

끝난 PID 의 등록은 다음 검사에서 회수한다. 정상 종료와 INT·TERM 때는 자식 명령이
끝난 뒤 자리를 반납한다. 자식이 다시 대기열을 호출하면 `HEAVY_SLOT_HELD` 를 물려받아
바깥 자리를 사용하므로 중첩 호출이 서로 기다리지 않는다. 이 변수는 수동으로 설정하지 않는다.
다른 폴더를 쓰는 옛 대기열이나 대기열 밖에서 실행한 명령은 여기서 제한하지 않는다.

기본 경로는 주 checkout 기준이라 다른 워크트리에서도 같은 대기열을 쓴다. `ORCH_DIR` 로 orch 루트를 바꾼다.
옛 orch 설정과 지시서가 남아 있으면 기본 경로로 실행하지 않고 옮기는 명령을 알린다. 명시한 대기열 폴더는 그대로 받는다.
