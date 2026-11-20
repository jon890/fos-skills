# orch: Claude 주간 사용량으로 Codex 행을 바꿔 띄우기 검증

스펙: [spec.md](spec.md), 설계: [design.md](design.md)

검증일: 2026-11-20. 실제 사용량 캐시는 읽지 않고 `ORCH_CLAUDE_USAGE` 로 준 임시 파일로 흉내 냈다.

## 요구사항별 결과

| ID | 결과 | 근거 |
| --- | --- | --- |
| REQ1 | 통과 | 22% 사용, 초기화 37시간 전이면 design 행이 `--agent claude --model claude-opus-5-5 --effort medium` 으로 뜬다. impl-planned 의 sol low 는 Sonnet 5.5 low 로 뜬다. 네 행 모두 단위 테스트로 본다 |
| REQ2 | 통과 | 80% 사용(5일 남음), 50% 사용(3.5일 10분 남음)은 Codex 행 그대로 뜬다. 같은 경우는 고정 시각 단위 테스트가 바꾸지 않음을 본다 |
| REQ3 | 통과 | visual, review, 이미 Claude 인 행은 사용량이 남아도 그대로다. 바꾼 띄우기의 이력 에이전트가 claude 라 `review-spec.ts` 가 Codex 리뷰어를 고른다(코드 읽기) |
| REQ4 | 통과 | `LAUNCH-EFFECTIVE` 와 `launch-history.jsonl` 의 `effective.candidateOverride` 가 `{ row, agent, model, effort, reason: "사용량: 남은 78%, 남은 시간 22%" }` 다. 짧은 출력에서도 같다 |
| REQ5 | 통과 | 출처 없음, 깨진 JSON, 값 없음(`error: true`), 120분 전 값, 초기화가 지난 값에서 `USAGE-UNKNOWN <이유>` 를 내고 행 그대로 뜬다 |
| REQ6 | 통과 | `routing.usage_boost: false` 면 사용량을 읽지 않는다. bool 이 아니면 설정 오류(2)로 띄우기 전에 멈춘다. `후보 밖:` 이 있는 지시서는 사용량보다 먼저다 |

## 실행한 명령

- `node --test skills/orch/tests/lib-usage-boost.spec.ts`: 19개 통과
- `node --test --test-name-pattern="사용량|usage" skills/orch/tests/launch-worker.spec.ts`: 18개 통과
- `orch slot heavy --exclusive -- node scripts/run-tests.ts`: tsc 포함 322개 파일 가운데 3개가 실패했다(변경 조각 항목 길이, 설정 표본 표에 새 키 없음). 고친 뒤 그 세 파일을 다시 돌려 모두 통과했다
- `claude plugin test .`: 115개 통과

## 독립 검토

읽기 전용 검토 하위 에이전트가 REQ1~REQ6 을 코드와 테스트로 대조했다. 차단 결함은 없었다. 비차단으로 남긴 것:

- 바꿔 띄운 Claude worker 가 받는 지시서 사본의 `worker 선택:` 줄은 Codex 값 그대로다. 스펙이 지시서를 고치지 않기로 정한 범위다.
- `send-to-worker` 의 후속 지시는 같은 worker 를 이어 가므로 사용량 이유를 새로 남기지 않는다. 스펙 범위(새로 띄우기) 밖이다.
