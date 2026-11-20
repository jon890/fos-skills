# orch: Claude 주간 사용량으로 Codex 행을 바꿔 띄우는 기술 설계

스펙: [spec.md](spec.md)

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | `launch-worker` 의 차례 0(선택 검사)을 통과한 직후 차례 0-0 이 `lib/usage-boost.ts` 의 `decideBoost` 를 부른다. 바꾸기로 하면 WORKER_ARGS 의 `--agent`, `--model`, `--effort` 를 같은 등급의 Claude 로 바꾸고 이후 차례는 바꾼 값으로 돈다 |
| REQ2 | 남은 사용량 비율이 남은 시간 비율 이하면 `keep` 이다. WORKER_ARGS 를 건드리지 않는다 |
| REQ3 | 대상 행은 `BOOST_ROWS`(impl-planned, impl-explore, small-fix, design)의 Codex worker 뿐이다. 리뷰 제공자는 `orch spec review` 가 띄우기 이력의 에이전트로 정하므로, 이력에 Claude 가 남으면 리뷰는 Codex 가 된다 |
| REQ4 | 바꾸면 `candidateOverride` 를 만들어 기존 후보 밖 기록 자리(`LAUNCH-EFFECTIVE`, 띄우기 기록의 `effective.candidateOverride`)에 넣는다. 지시서 대조는 바꾸기 전에 끝나서 거절하지 않는다 |
| REQ5 | 사용량 출처가 없거나, JSON 이 깨졌거나, 값이 빠졌거나, 마지막 조회 성공(`lastSuccessAt`)이 1시간보다 오래됐거나, 초기화 시각이 지났으면 `USAGE-UNKNOWN <이유>` 를 stdout 에 내고 그대로 띄운다. 대문자 판정 줄이라 짧은 출력에도 남는다 |
| REQ6 | `routing.usage_boost` 를 설정 키(`ROUTING_KEYS`)와 설정 검사표(`config-schema.ts`)에 더한다. `false` 면 사용량을 읽지 않는다. 지시서에 `후보 밖:` 이 있으면 대상이 아니다 |

## 책임과 경계

- **`lib/usage-boost.ts`(새 파일)**: 사용량 출처 읽기, 같은 등급 대응 찾기, 바꿀지 판정을 소유한다. Orca 와 git 을 부르지 않는다. 시각과 사용량 읽기를 인자로 받아 단위 테스트가 고정 시각으로 돈다.
  - `readWeekly(file, now)`: oh-my-claudecode 상태 줄 캐시의 `lastSuccessAt`, `data.weeklyPercent`, `data.weeklyResetsAt` 를 읽는다. `error: true` 나 `lastSuccessAt` 이 없으면 값 없음이다. 신선도를 `timestamp` 로 보지 않는 것은 조회가 429 로 막히면 OMC 가 data 와 `lastSuccessAt` 을 두고 `timestamp` 만 지금으로 다시 쓰기 때문이다.
  - `sameGradeClaude(table, worker)`: `agent-selection.md` 「사용 한도에 걸렸을 때」 표에서 걸린 모델 칸이 모델과 effort 까지 맞는 줄을 먼저, 없으면 effort 없는 줄을 고른다. 「같은 등급 대응」 칸의 첫 Claude 모델이 답이다. `Claude Opus 5.5` 는 `claude-opus-5-5` 로 읽는다. 칸에 effort 가 없으면 행의 effort 를 쓴다.
  - `decideBoost`: 대상 행이 아니거나, 꺼졌거나, 대응이 없으면 사용량을 읽지 않고 `keep` 이다.
- **`launch-worker.ts`**: 판정을 부르고 WORKER_ARGS 를 바꾸며, 만든 `candidateOverride` 를 지시서의 후보 밖 기록보다 먼저 쓴다. `--terminal` 이어 쓰기는 부르지 않는다.
- **`resume-worker.ts`** 는 고치지 않는다. 같은 세션을 `claude --resume` / `codex resume` 으로 여는 일이라 제공자를 바꿀 수 없고, 스펙의 범위 밖(이미 떠 있는 worker)이다.

## 출처

oh-my-claudecode 상태 줄이 주기적으로 쓰는 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/plugins/oh-my-claudecode/.usage-cache-anthropic.json` 하나만 읽는다. 사용자가 상태 줄에서 보는 값과 같다(스펙 DECISION4).
Orca 프로필의 `plugins` 는 `~/.claude/plugins` 를 가리키는 링크라 프로필마다 같은 파일이다. 계정이 여럿이면 상태 줄이 마지막으로 받은 계정의 값이다.

세션별 `~/.omc/state/sessions/*/hud-stdin-cache.json` 의 `rate_limits.seven_day` 는 쓰지 않는다. 2026-11-20 이 머신에서 가장 최근 파일이 나흘 전 것이라, 1시간 기준으로는 늘 오래된 값이 된다. 함께 읽으면 코드와 테스트만 늘고 판정은 같다.

`ORCH_CLAUDE_USAGE` 로 파일을 바꾼다. 테스트는 이 변수로 임시 파일을 주고, 기존 `launch-worker` 테스트는 없는 파일로 고정해 실제 캐시를 읽지 않는다.

## 실패와 일관성

- 사용량을 읽지 못해도 띄우기는 막지 않는다. 바꾸지 않는 쪽이 지금 동작이라 안전하다.
- `routing.usage_boost` 가 bool 이 아니면 다른 설정 키처럼 설정 오류(종료 코드 2)로 워크트리를 만들기 전에 멈춘다.
- 「사용 한도에 걸렸을 때」 표의 제목이나 칸 꼴이 바뀌면 대응을 찾지 못해 바꾸지 않는다. 단위 테스트가 실제 `agent-selection.md` 로 대응을 읽어 이 어긋남을 잡는다.
- `--task` 재시도는 매번 다시 판정한다. 앞 띄우기가 Claude 로 바뀌었어도 코디네이터는 지시서 그대로 Codex 값으로 부른다.

## 검증 전략

- `tests/lib-usage-boost.spec.ts`: 고정 시각으로 기준 위·아래·같음, 바꾸지 않는 행, 후보 밖, 꺼짐, 출처 없음·깨짐·값 없음·오래된 값·초기화가 지난 값, 실제 표의 대응을 본다.
- `tests/launch-worker.spec.ts` 「Claude 사용량으로 바꿔 띄우기」: 임시 사용량 파일과 가짜 orca 로 `worker-start` 인자, `LAUNCH-EFFECTIVE`, 띄우기 이력, `USAGE-UNKNOWN`, 설정 끄기와 설정 오류, `--task` 재시도를 본다.

## 결정

| 결정 | 고른 안 | 이유 |
| --- | --- | --- |
| 바꾼 뒤 알림 줄 | 새 줄을 만들지 않고 `LAUNCH-EFFECTIVE` 의 `candidateOverride` 로만 알린다 | 스펙 REQ4 가 정한 자리이고, 출력 계약에 줄을 더 늘리지 않는다 |
| Sonnet 의 effort | 행의 effort(`low`)를 그대로 쓴다 | 표의 Sonnet 칸에 effort 가 없다. 같은 등급을 유지하려면 행의 값이 가장 가깝다 |
| resume | 바꾸지 않는다 | 같은 세션을 잇는 일이라 제공자를 바꿀 수 없다 |
