# 무거운 검사 대기열

여러 worker 가 같은 PC 에서 빌드나 전체 검사를 돌릴 때 `heavy-slot.ts` 로 감싼다.
먼저 등록한 작업이 먼저 들어가고, `exclusive` 로 분류한 검사(전체 CI, 브라우저 검사 같은 것)는 모든 자리가 빌 때 혼자 실행한다.
명시적으로 혼자 실행하려면 `--exclusive` 를 준다.

```bash
"$SKILL_DIR/bin/orch.ts" heavy-slot -- ./bin/build.sh
"$SKILL_DIR/bin/orch.ts" heavy-slot --exclusive -- ./bin/ci.sh
```

어떤 명령이 혼자 실행할지(`exclusive`), 자리 하나를 쓸지(`normal`), 대기열을 거치지 않을지(`light`)는 저장소의 `.orch/config.json` 의 `heavy` 절이 정한다.
설정이 없으면 모든 명령이 자리 하나를 쓴다(`normal`). 가벼운 명령도 자리를 기다리지만, 잘못 분류해 전체 검사를 동시에 돌리는 것보다 안전하다.
예시 설정이다. 명령 이름은 저장소에 맞게 바꾼다.

```json
{
  "heavy": {
    "exclusive": ["local-ci", "playwright", "browser"],
    "light": ["^(pnpm( -s)?( exec)? )?(tsc|oxlint)\\b", "^pnpm( -s)? (type-check|lint)\\b", "^(echo|cd|git|ls|cat|true|test)(\\s|$)"]
  }
}
```

`heavy.wait_idle` 은 이미지 빌드처럼 대기열 밖에서 도는 무거운 프로세스가 끝날 때까지 자리를 잡지 않고 기다리게 한다.
분류가 맞지 않는 전체 검사는 `--exclusive` 로 지정한다.
분류 규칙의 차례, `wait_idle` 의 시간 초과, 자리 수, 대기열 폴더, 환경 변수, 메모리 대기와 종료 코드는 `heavy-slot.ts` 머리 주석이 소유한다.

저장소마다 대기열 폴더를 달리하면 서로 제한하지 않는다. PC 전체 사용량을 제한하려면 여러 저장소에서 같은 폴더를 쓴다.
다른 폴더를 쓰는 옛 대기열은 여기서 제한하지 않는다. 대기열 밖에서 실행한 명령은 `wait_idle` 에 적은 것만 기다린다.
기본 폴더는 주 checkout 기준이라 다른 워크트리에서도 같은 대기열을 쓴다.
