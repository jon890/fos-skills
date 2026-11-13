# Phase 02. 틱 실패의 원인 줄과 3번째 틱 바로 알림

**Execution profile**: standard

## 목표

부모가 판정하는 틱 실패의 이유에 원인 줄을 담고, 같은 원인이 연속 3번째 틱이면 모아 보내기를 기다리지 않고 바로 한 번 알린다. 단계 출처의 연속 기준도 3번째로 맞춘다.

**범위 외**: `STALE-BUNDLE` 줄을 뺄지 정하는 판정(phase 03 이 `staleLogged` 를 넘긴다. 이 phase 는 인자만 받아 둔다).

## 컨텍스트

**요구사항**: REQ6

**근거 문서**: `docs/features/loop-self-update/spec.md` REQ6·DECISION3·DECISION12·DECISION13, `docs/features/loop-self-update/design.md` 「틱 실패의 원인 줄」

- 부모의 틱 실패 판정은 `skills/orch/scripts/loop/lifecycle.ts` 의 `tickResult`(457-477행)와 `foreground` 의 588-601행이다. 지금 이유는 `종료 코드 <n>` 이나 `결과 줄 없음` 뿐이다.
- 연속 판정은 `skills/orch/scripts/lib/notice-digest.ts` 의 `watchStreak`(51-63행)와 `markStreakSent`(66-71행)다. 단계 출처는 `skills/orch/scripts/loop/steps/errors.ts` 53-61행이 같은 꼴로 쓴다. 그 꼴을 따른다.
- 바로 보내기는 `sendNotice(kind, pr, text, run, repo, now=true)`(`lib/run-notice.ts` 46행)다.
- 틱 자식은 설정 오류면 `orch-loop: <메시지>` 를 stderr 에 쓰고 2 로 끝난다(`skills/orch/scripts/loop/orch-loop.ts` 의 `executeMain` 끝부분).

## 의도 메모

- `state.errors[tickKey]` 에는 원래 이유를 둔다. 비교만 숫자 묶음을 `#` 로 바꾼 키로 한다. 키를 저장하면 `orch-loop.spec.ts` 「틱 자식의 실패」(737-772행)의 `'종료 코드 3'` 기대값과 `docs/data-schema.md` 의 `errors` 뜻이 바뀐다.
- 원인 줄이 없으면 이유가 지금과 같은 `종료 코드 <n>` 이어야 한다. 기존 테스트가 그대로 통과하는지로 확인한다.

## 작업 항목

### 1. `skills/orch/scripts/lib/notice-digest.ts`

- `watchStreak` 의 판정을 `next.count >= STREAK_LIMIT && !next.sent` 로 바꾼다.
- 파일 맨 위 설명의 「연속 세 틱 넘게」 를 「연속 세 번째 틱에」 로, `watchStreak` 주석도 같게 고친다.

### 2. `skills/orch/scripts/loop/lifecycle.ts`

- `export function tickCause(stdout: string[], stderr: string[]): string | null` — 설계 「틱 실패의 원인 줄」 의 규칙. stderr 에서 `STALE-BUNDLE ` 로 시작하는 줄을 뺀 마지막 빈칸 아닌 줄, 없으면 stdout(결과 줄을 뺀 것)에서 `orch-loop:` 로 시작하거나 `오류`, `실패`, `Error` 가 든 마지막 줄. 200자에서 자른다.
- `export function causeKey(reason: string): string` — `reason.replace(/\d+/g, '#')`.
- `tickResult(done, staleLogged = false)`: 로그로 옮길 때 `staleLogged` 면 `STALE-BUNDLE ` 줄을 뺀다. 이유는 `종료 코드 <n>` 또는 `결과 줄 없음` 뒤에 원인 줄이 있으면 `: <원인 줄>` 을 붙인다.
- `foreground` 588-601행: 「이유가 바뀌었는가」 를 `causeKey(state.errors[tickKey] ?? '') !== causeKey(reason)` 로 본다. 그다음 `state.run` 이 있으면 `watchStreak(ctx.repo, tickKey, reason === null ? null : causeKey(reason))` 를 부르고, 참이면 `sendNotice('WATCH-ERROR', null, \`tick: ${reason}\`, state.run, ctx.repo, true)` 뒤 `markStreakSent(ctx.repo, tickKey)`. 전송이 실패하면 지금처럼 로그만 남긴다(다음 틱이 다시 참을 낸다).
- 파일 맨 위 설명 「틱 자식」 의 이유 문장에 원인 줄과 연속 알림을 더한다.

### 3. `skills/orch/scripts/loop/steps/errors.ts` 와 `orch-loop.ts`

코드는 그대로다. `errors.ts` 53행 주석과 `orch-loop.ts` 머리 주석 「알림 방식」(86-87행)의 「연속 세 틱 넘게」 를 「연속 세 번째 틱에」 로 고친다. `orch-loop.ts` 는 보드 업무 링크 작업(`feat/board-task-link`)이 함께 고치는 파일이라 이 줄만 바꾼다.

### 4. 테스트

- `skills/orch/tests/notice-digest.spec.ts` 39-60행: 기대값을 `[false, false, true]` 꼴로 바꾸고 제목의 「세 틱 넘게」 를 「세 번째 틱에」 로 고친다.
- `skills/orch/tests/orch-loop-conflict.spec.ts`: 같은 충돌 오류의 세 번째 틱에 바로 알림이 추가되고, 네 번째에는 추가되지 않는지 확인한다.
- `skills/orch/tests/loop-tick-failure.spec.ts`(신규): `tickCause` 와 `causeKey` 단위 사례. stderr 마지막 줄, `STALE-BUNDLE` 줄만 있는 stderr 에서 stdout 오류 줄로 넘어가기, 둘 다 없음, 200자 자르기, 시각·pid 만 다른 두 이유의 키가 같은지.
- 같은 파일에 프로세스 사례 하나: `orch-loop.spec.ts` 「틱 자식의 실패」 의 꼴(가짜 ORCA, `tick_sec: 0.2`, `--foreground`)로 부모를 띄운 뒤 설정 파일(`.orch/config.json`)을 모르는 절이 든 내용으로 바꿔 틱 자식이 2 로 끝나게 한다. 3번째 실패 틱 뒤 가짜 ORCA 기록에 `WATCH-ERROR` 본문 `tick: 종료 코드 2: orch-loop: …` 가 바로 보내기로 하나 있고, 4번째·5번째 틱 뒤에도 하나뿐인지 본다. 설정을 되돌려 한 틱이 성공한 뒤 다시 깨 세 번 실패하면 하나 더 오는지 본다. 가짜 ORCA 와 설정 helper 는 `orch-loop.spec.ts` 의 것을 옮기지 말고 `skills/orch/tests/fixtures/` 에 이미 있는 helper(`fake-bin.ts`)를 쓴다. 모자라면 그 사례 파일 안에 둔다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/notice-digest.spec.ts skills/orch/tests/loop-tick-failure.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/loop-steps.spec.ts skills/orch/tests/orch-loop-conflict.spec.ts
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/scripts/lib/notice-digest.ts` | 수정 (3번째 틱 판정) |
| `skills/orch/scripts/loop/lifecycle.ts` | 수정 (`tickCause`, `causeKey`, 틱 연속 알림) |
| `skills/orch/scripts/loop/steps/errors.ts` | 수정 (주석) |
| `skills/orch/scripts/loop/orch-loop.ts` | 수정 (머리 주석 「알림 방식」) |
| `skills/orch/tests/notice-digest.spec.ts` | 수정 |
| `skills/orch/tests/orch-loop-conflict.spec.ts` | 수정 (세 번째 틱 바로 알림) |
| `skills/orch/tests/loop-tick-failure.spec.ts` | 신규 |
