# Phase 01. 상주 루프의 뼈대와 코디네이터를 깨우는 알림 경로를 만든다

**Execution profile**: deep

## 목표

`orch-loop.ts` 를 저장소마다 하나 도는 분리된 프로세스로 만든다. 틱마다 질문 확인, 정리, 원격 브랜치 정리, 보드 동기화, `tick` 이벤트를 한다.
코디네이터를 깨워야 하는 일은 알림 파일에 적고 `wait-important` 가 그 파일로 깨어난다. 루프가 죽으면 `LOOP-DEAD` 로 깨어난다.

**범위 외**: CI 감시, ready 슬롯, 순서, 문서 PR 바로 머지(phase 02). 배포 묶기와 충돌 PR 처리(phase 03). 문서(phase 04).

## 컨텍스트

시작 조건: `plan6-orch-ts-cleanup-commands` 의 PR 이 main 에 머지됐다. 아니면 `PHASE_BLOCKED: plan6 머지 전` 을 내고 멈춘다.

지금은 코디네이터가 Monitor 로 `watch-questions.ts` 를 띄우고, 깨어날 때마다와 5분마다 `cleanup-sweep.ts` 와 `board-sync.ts` 를 직접 부른다(`orch/references/waiting.md`). Monitor 는 시간이 지나면 끝나고, 하네스의 백그라운드 명령은 시간 한도(기본 30분, 최대 2시간)가 있어 그 사이에 질문이 쌓였다.
루프는 `child_process.spawn` 의 `detached: true` 로 자기 자신을 띄워 하네스 밖에서 돈다. stdout 과 stderr 는 `state/loop.log` 로 간다.

상태 파일(`state/loop.json`, `state/loop.log`, `state/loop-events.jsonl`, `state/loop-events.cursor`)의 형식은 `docs/data-schema.md` 의 「orch 루트에 더하는 파일」 이, 틱 간격과 켜는 설정(`pipeline.tick_sec`, `pipeline.enabled`)은 같은 문서의 「config.json 에 더하는 절」 이 소유한다.
질문 판정은 `lib/questions.ts`, 알림 기록은 `watch-questions.ts` 가 쓰는 `state/questions-seen.json` 을 같이 쓴다. 정리는 `cleanup-sweep.ts` 를, 보드는 `board-sync.ts` 를 `scriptCommand` 로 부른다. Run id 와 지시서 폴더는 `config.json` 의 `finish.run`, `finish.specs_dir` 이고 명령줄 `--run`, `--specs-dir` 가 우선한다.

**근거 문서**: `docs/flow.md` 의 「운영 공백을 막는 곳」 과 「갈래」 의 루프 두 줄, `docs/data-schema.md`, `docs/code-architecture.md` 의 「코어와 저장소의 경계」 와 「사용자 결정 (2026-10-24)」 의 상주 루프 줄

## 의도 메모

- 질문 확인과 원격 브랜치 정리는 `pipeline.enabled` 와 무관하게 돈다(사용자 결정). 자동 진행만 그 설정을 따른다.
- 루프는 상태로만 판정한다. 루프가 없던 동안 생긴 일은 다음 틱이 다시 본다. 그래서 루프가 죽어도 잃는 것이 없고, 다시 띄우기만 하면 된다.
- 하네스는 백그라운드 명령의 stderr 를 알리지 않는다. 루프의 실패도 알림 파일의 `WATCH-ERROR` 나 `HOOK-FAIL` 로 간다.

## 작업 항목

### 1. `orch/scripts/orch-loop.ts`

```
orch-loop.ts --repo DIR [--run ID] [--specs-dir DIR] (--start | --stop | --status | --foreground) [--once]
```

| 옵션 | 동작 |
| --- | --- |
| `--start` | 살아 있는 루프가 없으면 분리된 자식으로 `--foreground` 를 띄우고 `LOOP-STARTED <pid>` 를 낸다. 있으면 `LOOP-RUNNING <pid>` 와 종료 코드 4 |
| `--stop` | 루프에 TERM 을 보내고 끝날 때까지 기다린다 |
| `--status` | `loop.json` 의 pid, 시작 시각, 마지막 틱, 살아 있는지 |
| `--foreground` | 지금 프로세스에서 틱을 돈다. 테스트와 `--start` 의 자식이 쓴다 |
| `--once` | `--foreground` 와 함께 틱 한 번만 돌고 끝난다 |

틱 하나가 하는 일(순서대로, 하나가 실패해도 다음을 한다):

1. 질문 확인. 새 질문은 `QUESTION`, 재알림은 `REMINDER` 를 `loop.log` 에 쓰고 `REMINDER` 와 조회 실패(`WATCH-ERROR`)는 `loop-events.jsonl` 에도 쓴다. `worker-question` 이벤트를 낸다
2. `cleanup-sweep.ts --repo <repo> --run <run> --specs-dir <dir> --kill-holders --remote-branches --apply`
3. `board-sync.ts --repo <repo>`. 보드가 없으면 건너뛴다
4. `tick` 이벤트. 입력의 `open_prs` 는 `lib/gh.ts` 로 읽은 내 열린 PR 번호다

각 틱 끝에 `loop.json` 의 `last_tick` 을 쓴다. `loop.log` 와 `loop-events.jsonl` 의 크기 제한은 `docs/data-schema.md` 의 값이다.

### 2. `wait-important.ts` 가 알림 파일로 깨어난다

`--loop-repo DIR` 를 받는다(여러 번). 주면 `--lost-interval-sec` 간격의 확인마다 아래를 본다.

| 상황 | 출력과 종료 코드 |
| --- | --- |
| 커서 뒤에 새 알림 줄이 있다 | 그 줄을 `LOOP-EVENT <kind> <pr> <text>` 로 내고 커서를 옮긴 뒤 종료 코드 7. 마지막 줄은 지금처럼 `LAST_DELIVERY` |
| `loop.json` 이 없거나, pid 가 죽었거나, 마지막 틱이 `tick_sec` 의 세 배보다 오래됐다 | `LOOP-DEAD <repo>` 와 종료 코드 8 |

### 3. `orch-doctor.ts` 의 `session-resume`

`--run` 과 함께 `--repo` 를 주면 입력의 `loop_alive` 를 실제 판정으로 채운다. 죽었으면 `LOOP-DEAD` 줄과 다시 띄울 명령을 낸다.

### 4. 테스트

`orch/tests/orch-loop.spec.ts` 를 만든다. `--foreground --once` 로 가짜 orca, gh, 정리와 보드 명령(`ORCH_CLEANUP_BIN`, `BOARD_BIN` 환경 변수로 바꾼다)을 부른다.

| 사례 | 기대 |
| --- | --- |
| 미답변 질문이 재알림 시간을 넘었다 | `loop-events.jsonl` 에 `REMINDER` 한 줄, `worker-question` 핸들러가 `reminder: true` 를 받는다 |
| orca 조회 실패 | `WATCH-ERROR` 한 줄. 정리와 보드는 그래도 불린다 |
| 살아 있는 루프가 있는데 `--start` | 종료 코드 4 |
| 틱 한 번 | 정리 명령이 `--remote-branches --apply` 와 함께 불리고 `last_tick` 이 쓰인다 |

`orch/tests/wait-important.spec.ts` 에 사례를 더한다: 알림 파일의 새 줄로 종료 코드 7 과 커서 이동, 오래된 `last_tick` 으로 종료 코드 8.
`orch/tests/orch-doctor.spec.ts` 에 사례를 더한다: 죽은 pid 의 `loop.json` 이면 `LOOP-DEAD`.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/orch-loop.spec.ts orch/tests/wait-important.spec.ts orch/tests/orch-doctor.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/scripts/orch-loop.ts` | 신규 |
| `orch/scripts/wait-important.ts` | 수정 |
| `orch/scripts/orch-doctor.ts` | 수정 |
| `orch/tests/orch-loop.spec.ts` | 신규 |
| `orch/tests/wait-important.spec.ts` | 수정 |
| `orch/tests/orch-doctor.spec.ts` | 수정 |
