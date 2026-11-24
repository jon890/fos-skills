# 같은 등급의 두 모델을 번갈아 띄운다 인수 검증

확인: 2026-11-24

## 검증 대상

- 검증한 커밋: `3ef46283`(main, PR 609 머지 `4b14c57b` 뒤 19.30.0 버전 올림).
- 설치본 `fos-skills` 19.30.0 의 `skills/orch/scripts` 와 `agent-selection.md` 는 이 커밋과 `diff -r` 로 같다.
- 스펙은 [spec.md](spec.md), 설계는 [design.md](design.md) 다.
- 구현은 Codex, 검증은 Claude(`claude-sonnet-5-5`)가 맡았다.
- 코드는 고치지 않았다. 실제 worker 도 띄우지 않았다.

## 실행 방법

- 설치본의 `orch worker launch --preflight` 를 임시 폴더 환경에서 불렀다. `ORCH_MACHINE_DIR`(차례 파일)과 `ORCH_DIR`(이력)을 임시 폴더로 바꿔 이 장비의 진짜 차례 파일은 건드리지 않았다.
- 소진 시나리오는 가짜 `orca` 가 계정 목록을 답하고, 저장소 테스트 fixture 로 만든 사용량 기록(Codex 세션 기록, Claude 사용량 캐시)을 읽게 했다.
- 테스트는 `node scripts/run-tests.ts` 로 관련 파일 7개를 돌렸고 모두 통과했다(model-turn, launch-worker, relaunch-worker, review-spec, resume-worker, resume-exec, lib-resume).

## 인수 조건별 결과

| ID | 결과 | 실행 근거 |
| --- | --- | --- |
| REQ1 | 통과 | `impl-explore` 지시서로 연속 4회 호출하니 제공자가 codex, claude, codex, claude 로 나왔다. 연속 두 호출이 같은 제공자인 경우는 없었다 |
| REQ2 | 통과 | 저장소 두 곳이 `opus` 차례를 이어 썼다(저장소1 codex, 저장소2 claude, 저장소1 codex). `visual`(sonnet)과 `hard-design`(fable)은 별도 키로 처음부터 시작했고 차례 파일에 `{"opus":"claude","sonnet":"claude","fable":"codex"}` 로 남았다. 동시 6개 호출은 codex 3, claude 3 으로 나뉘었고 파일은 한 번 돈 상태(`{"opus":"codex"}`)로 깨지지 않았다 |
| REQ3 | 통과 | Codex 소진(100%)이면 차례가 codex 여도 claude `opus` 로 뜨고 `candidateOverride.reason` 이 `한도: gpt-6.2-sol 주간 100%, …` 로 남았다. 차례는 claude 로 넘어갔다. Claude 소진이면 차례가 claude 일 때 codex 로 뜨고 차례는 codex 로 넘어갔다. 둘 다 소진이면 `REFUSED 같은 등급에서 사용 한도가 남은 모델이 없다` 와 가장 이른 해제 시각을 내고 종료 코드 1 이다 |
| REQ4 | 통과 | 지시서에 codex 조합과 claude 조합을 각각 적어도 거절 없이 차례대로 떴다. `LAUNCH-EFFECTIVE` 에 `alternation.reason` 이 `번갈아: opus 차례` 로, `from` 에 요청 조합이 남았다. 띄우기 이력 기록은 launch-worker 테스트(`REQ1, REQ4, REQ5`)가 `effective.alternation` 으로 확인한다 |
| REQ5 | 통과 | `후보 밖:` 줄이 있는 지시서는 차례 파일이 생기지 않았고 `alternation` 도 없었다. Codex 소진 상태에서는 같은 등급의 짝(claude)으로 바뀌었으나 이 경우도 차례를 쓰지 않았다(바닥나면 REQ3 적용). 둘 다 소진이면 거절했다 |
| REQ6 | 통과 | `orch spec review 609` 에 구현 이력을 만들어 실행했다. 구현 codex 면 `review=claude/claude-sonnet-5-5/medium`, 구현 claude 면 `review=codex/gpt-6.2-sol/medium` 이다. 차례가 codex 였으나 실제로는 claude 로 뜬 이력(`effective.agent`)이면 실제 제공자의 반대인 codex 로 골랐다. 리뷰 지시서(`리뷰 PR:` 줄)로 `--preflight` 하면 차례 파일이 생기지 않는다 |
| REQ7 | 통과 | `--terminal` 이어 쓰기는 `decideSettings` 가 차례 없이 빈 결정을 돌려주고 차례 파일도 생기지 않았다. `orch worker resume` 은 차례 코드를 부르지 않고 앞 세션의 모델로 이어 가며(`resume-worker.spec.ts` 통과), `--task` 재시도는 위 호출들처럼 차례를 쓴다. relaunch 는 테스트(`REQ7`)가 사전 검사에서 받은 차례를 실제 시작에 그대로 쓰고 차례를 한 칸만 넘기는 것을 확인한다 |
| REQ8 | 통과 | `agent-selection.md` 의 모델 표는 행마다 `등급` 과 `등급의 두 모델과 effort` 칸을 둔다. `기본 후보에서 뺀 모델` 절의 astra 제한 문구는 없고 `lib-selection.spec.ts` 가 그 문구가 다시 생기지 않음을 막는다. `hard-design`, `impl-hard` 는 `claude-fable-5-2` / `gpt-6.2-astra` 를 보인다 |

## 이 장비의 설치본으로 한 확인

지시서는 설치본 19.30.0 의 `--preflight` 를 이 장비 차례 파일에 두 번 불러 보라고 했다. 코디네이터와 상의해 진짜 차례 파일을 검증 때문에 바꾸지 않기로 했다. 대신 이미 쌓인 기록을 읽기만 한 근거로 확인한다.

- 장비의 차례 파일 `~/.cache/orch/model-turns.json` 은 검증 시작 때 없었고, 검증 중에 `{"opus":"codex"}` 로 생겼다. 이 검증은 그 파일을 쓰지 않았다.
- fos-skills 의 `.orch/state/launch-history.jsonl` 에 `effective.alternation` 이 있는 행이 하나 있다. 2026-11-23T23:27Z 에 `impl-explore` 행의 지시서는 `codex gpt-6.2-sol` 을 적었으나 `{grade: opus, agent: claude, reason: 번갈아: opus 차례}` 로 `claude claude-opus-5-5` 가 떴다.
- 그 앞 차례는 codex 였다. PR 609 worker 의 사전 검사 두 번이 codex sol 다음 claude opus 를 냈다(코디네이터 확인).
- 파일의 최종 값 `opus: codex` 도 이 순서와 맞는다(codex, claude 를 가져간 뒤 다음이 codex).
- 이 근거는 읽기만 한 것이다. 임시 폴더 실행이 같은 설치본 코드로 같은 교대를 재현한 결과와 일치한다.
- 임시 폴더 실행에서 설치본 `--preflight` 를 호출 때마다 차례가 한 칸씩 갔다.
- 진짜 차례 파일에는 검증 호출을 하지 않았으므로 이번 검증이 다음 실제 띄우기에 주는 영향은 없다.

## 결함과 알림 목록

고치지 않고 목록만 낸다. 인수 조건을 깨는 결함은 없었다.

| 번호 | 내용 | 심각도 | 근거 |
| --- | --- | --- | --- |
| 1 | 단독 `--preflight` 도 차례를 가져간다. 사전 검사만 하는 호출이 다음 실제 띄우기의 제공자를 바꾼다. 설계에 적혀 있는 동작이나, 「부작용 없는 확인」 으로 `--preflight` 를 부르는 곳(코디네이터의 사전 검사, 이 검증)이 차례를 흔든다. 장비 차례 파일의 실제 값이 이 영향을 받았을 가능성이 있다 | 낮음 | 임시 폴더 실행에서 호출마다 차례가 이동. design.md 「실패와 일관성」 |
| 2 | 둘 다 소진되어 거절한 호출도 차례를 한 칸 쓴다. 한도가 풀린 뒤 첫 띄우기의 제공자가 거절 횟수에 따라 달라진다. design.md 가 「예약한 차례는 계속 진행한다」 로 정한 동작이다 | 낮음 | F3 실행: 거절 뒤 차례 파일이 `{"opus":"claude"}` |
| 3 | 한쪽만 소진된 동안은 같은 제공자가 연달아 뜬다(예: Claude 소진 중 codex 두 번). DECISION8 대로이며 소진이 풀리면 교대로 돌아온다 | 정보 | F1, F2 실행 |
| 4 | REQ6 의 「같은 등급 모델」은 구현 worker 의 등급이 아니라 `review` 행(sonnet 등급)의 모델이다. 구현이 opus 등급이어도 리뷰는 `claude-sonnet-5-5` / `gpt-6.2-sol` 로 뜬다. 스펙 문구가 모호하나 모델 표와는 일치한다 | 정보 | REQ6 실행 결과 |
| 5 | `docs/features/orch-routing/evidence.md` 197행과 215행이 지워진 `기본 후보에서 뺀 모델` 절을 가리키고 「astra 를 쓰는 가장 어려운 설계와 구현」 이라고 쓴다. `docs/features/model-table-6-2/spec.md` 의 REQ4(astra 는 어려운 행의 기본이 아니다)도 이번 결정과 반대다. 역사 문서이긴 하나 현행으로 읽힌다 | 낮음 | grep 결과 |

## 판정

REQ1~REQ8 모두 실행으로 확인했다. 지시서 2번(이 장비 설치본으로 제공자가 번갈아 나오는지)은 진짜 차례 파일을 쓰지 않고, 같은 설치본 코드의 임시 폴더 실행과 실제 띄우기 이력 읽기로 확인했다.
