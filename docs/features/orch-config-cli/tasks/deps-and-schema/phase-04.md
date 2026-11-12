# Phase 04. 검사표와 읽는 곳의 대조 테스트

**Execution profile**: standard

## 목표

검사표가 받는 값을 그 키를 읽는 코드도 받는지 테스트로 묶는다. 어긋나면 검사표를 고친다. 읽는 코드는 고치지 않는다.

**범위 외**: 읽는 코드의 동작 변경(스펙 DECISION11 이 막았다), doctor 연결(phase 05).

## 컨텍스트

**요구사항**: REQ6

**근거 문서**: `docs/features/orch-config-cli/design.md` 「키별 검사 기준」, 「검증 전략」 의 대조 테스트 행, `docs/features/orch-config-cli/spec.md` DECISION19

- 기준은 「그 키를 읽는 모든 곳이 오류 없이 뜻대로 쓰는 값」 이다. 그래서 검사표가 받은 값을 읽는 곳 하나라도 거절하면 검사표가 틀린 것이다.
- 읽는 곳(설계 표의 「근거」 열):
  - `queue.required`: `lib/queue-defaults.ts` 의 `queueDefaults`(25행), `queue/steps/options.ts` 의 `parseArgs`·`validate`(19, 96행), `lib/gh.ts` 의 `requiredNames`(157행)
  - `queue.docs_glob`, `shared_paths`, `unit_groups`, `sweep_args`: `queueDefaults` 와 `core/refresh.ts` 의 `refreshSettings`(`pipeline.refresh_slots` 를 1 로 두고 부른다)
  - `pipeline.tick_sec`, `digest_sec`, `stall_ticks`: `loop/steps/context.ts` 의 `context(repo, ...)`
  - `pipeline.ready_slots`: `queue/ci-ready.ts` 189행의 `readySlots`(내보내지 않음). `skills/orch/tests/ci-ready.spec.ts` 378행 근처의 임시 저장소와 가짜 gh 하네스 꼴을 새 테스트 파일 안에 그대로 만들어 명령을 부르고, 설정 오류(종료 코드 2) 없이 끝나는지 본다
  - finish 의 시간 키 넷: `queue/finish-pr.ts` 274행의 `parse`(내보내지 않음). `skills/orch/tests/finish-pr.spec.ts` 200행 근처의 하네스 꼴을 새 테스트 파일 안에 그대로 만들어 명령을 부르고 설정 오류·사용법 오류 없이 끝나는지 본다
  - `queue.required` 등 queue 키의 머지 큐 검사: `queue/steps/options.ts` 의 `validate`(97행)는 PR 항목이 하나 있어야 하므로 `queueDefaults` 결과에 PR 번호 하나를 더해 부른다
- repo 를 받는 함수는 임시 저장소에 `.orch/config.json` 을 써서 부른다. 임시 저장소 꼴은 `skills/orch/tests/lib-config.spec.ts` 를 따른다.

## 의도 메모

- 대조는 「검사표 good → 읽는 곳도 받음」 한 방향만 본다. 읽는 곳이 받는데 검사표가 거절하는 값(0 이하의 대기 시간, 타이머 상한 초과, 조용히 무시되는 값)은 설계가 일부러 막은 것이다.
- 읽는 코드와 기존 테스트 파일을 고치지 않는다. 하네스는 새 테스트 파일 안에 만든다. 대조에서 빠지는 키는 없다.

## 작업 항목

### 1. `skills/orch/tests/config-schema-readers.spec.ts`(신규)

- phase 03 의 표본 표에서 위 키들의 good 값을 가져와(phase 03 이 표를 `skills/orch/tests/fixtures/config-samples.ts` 에 두어 두 테스트가 함께 쓴다) 읽는 곳마다 부른다. 설정 오류나 사용법 오류가 나면 실패하고, 메시지에 키와 값과 읽는 곳을 낸다.
- 글자 `"30"` 인 `finish.merge_timeout` 으로 마무리 명령이 설정 오류·사용법 오류 없이 지금처럼 도는지 본다(스펙 REQ6 인수 조건).

### 2. 어긋남 고치기

대조가 실패하면 `skills/orch/scripts/core/config-schema.ts` 의 그 키 검사를 읽는 곳에 맞게 좁히고, 그 결과를 `docs/features/orch-config-cli/design.md` 「키별 검사 기준」 의 그 행에 반영한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/config-schema-readers.spec.ts skills/orch/tests/core-config-schema.spec.ts
node scripts/run-tests.ts --tsc-only
```

기대값: 모두 통과.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/tests/config-schema-readers.spec.ts` | 신규 |
| `skills/orch/scripts/core/config-schema.ts` | 수정 (어긋난 키만) |
| `docs/features/orch-config-cli/design.md` | 수정 (어긋난 키의 표 행만) |
