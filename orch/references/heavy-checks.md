# 무거운 검사 대기열

여러 worker 가 같은 PC 에서 빌드나 전체 검사를 돌릴 때 `heavy-slot.py` 로 감싼다.
먼저 등록한 작업이 먼저 들어가고, 전체 CI 와 브라우저 검사는 모든 자리가 빌 때 혼자 실행한다.
명시적으로 혼자 실행하려면 `--exclusive` 를 준다.

```bash
python3 "$SKILL_DIR/scripts/heavy-slot.py" -- ./bin/build.sh
python3 "$SKILL_DIR/scripts/heavy-slot.py" --exclusive -- ./bin/ci.sh
```

타입 검사, lint, 파일을 지정한 단위 검사는 대기열을 거치지 않는다. 시나리오 검사와 빌드는 자리를 사용한다.
자동 분류가 맞지 않는 전체 검사는 `--exclusive` 로 지정한다.
자리 수, 대기열 폴더, 환경 변수, 메모리 대기와 종료 코드는 `heavy-slot.py` 머리 주석이 소유한다.

저장소마다 대기열 폴더를 달리하면 서로 제한하지 않는다. PC 전체 사용량을 제한하려면 여러 저장소에서 같은 폴더를 쓴다.
다른 폴더를 쓰는 옛 대기열이나 대기열 밖에서 실행한 명령은 여기서 제한하지 않는다.
기본 폴더는 주 checkout 기준이라 다른 워크트리에서도 같은 대기열을 쓴다.
