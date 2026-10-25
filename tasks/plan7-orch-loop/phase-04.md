# Phase 04. 기다리기 문서를 상주 루프 기준으로 바꾸고 개편 문서를 마감한다

**Execution profile**: standard

## 목표

코디네이터가 Monitor 와 5분 주기 정리 대신 상주 루프 하나와 대기 하나로 일하게 문서를 바꾼다.
개편 설계 문서의 「구현 전」 표시를 지우고, 사용법은 `orch/references/` 가, 계약은 `lib/events.ts` 머리 주석이 소유하게 옮긴다.

**범위 외**: 옛 `.py` shim 과 옛 설정 키를 지우는 일. 다음 major 에서 한다.

## 컨텍스트

시작 조건: 이 plan 의 phase 03 이 커밋됐다.

바꿀 문서와 내용:

| 문서 | 바꿀 것 |
| --- | --- |
| `orch/SKILL.md` 4단계 | 통과 조건을 「저장소마다 `orch-loop.ts --start` 가 살아 있고, 백그라운드 `wait-important.ts` 가 `--loop-repo` 와 함께 하나 돈다」 로 바꾼다. Monitor 와 5분 주기 문장을 지운다 |
| `orch/references/waiting.md` | 「질문 감시와 압축 뒤 복구」 와 「깨어날 때마다 정리와 보드 동기화」 를 루프 기준으로 다시 쓴다. 종료 코드 7(`LOOP-EVENT`)과 8(`LOOP-DEAD`)을 받았을 때 할 일을 적는다. Monitor 로 `watch-questions.ts` 를 띄우는 것은 루프를 쓸 수 없는 때의 대안으로 한 줄만 남긴다 |
| `orch/references/hooks.md` | `tick`, `ci-passed`, `ci-failed`, `ci-missing`, `session-resume`, 루프가 `pr-conflict` 를 내는 경우를 더한다 |
| `orch/references/overlay.md` | 「마무리 설정 파일」 에 `pipeline`, `heavy` 절을 더한다. 키 표는 `docs/data-schema.md` 의 표를 옮기고, 그 뒤로는 이 문서가 사용법을 소유한다 |
| `orch/references/cleanup.md` | 머지 큐를 직접 거는 경우와 루프가 순서 파일로 거는 경우를 나눈다. `orch-loop.ts --order` 사용법 |
| `docs/flow.md`, `docs/data-schema.md`, `docs/code-architecture.md` | 「구현 PR 이 모두 머지되기 전…」 문장을 지운다. `docs/data-schema.md` 의 「orch 이벤트 핸들러 입력」 은 계약 표만 남기고 사용법 문장은 `orch/references/hooks.md` 로 옮긴다 |
| `orch/scripts/lib/events.ts` 머리 주석 | 이벤트 목록, 입력 필드, 종료 코드를 적는다. `docs/data-schema.md` 와 같은 값이다 |
| `orch/CHANGELOG.md`, `orch/SKILL.md` `metadata.version` | 이 plan 을 한 항목으로 적고 minor 를 올린다 |

**근거 문서**: `docs/code-architecture.md` 의 「orch 문서가 소유하는 것」, `docs/flow.md` 의 「orch 이벤트」, `docs/adr/009-orch-event-handlers.md`

## 의도 메모

- 같은 값을 두 문서가 가지면 한쪽이 낡는다. 입력 필드 표는 `lib/events.ts` 머리 주석과 `docs/data-schema.md` 둘에만 두고, 테스트로 두 표의 이벤트 이름이 `EVENTS` 와 같은지 본다.

## 작업 항목

### 1. 위 표의 문서를 고친다

### 2. 이벤트 이름 대조 테스트 `orch/tests/events-doc.spec.ts`

`lib/events.ts` 의 `EVENTS` 키 집합이 `docs/flow.md` 「이벤트 목록」 표의 첫 열, `docs/data-schema.md` 「이벤트별 필드」 표의 첫 열(쉼표로 나뉜 이름을 펼친다), `orch/references/hooks.md` 에 나온 이벤트 이름과 같은지 본다.
정상 경로는 지금 문서다. 실패 경로는 임시 문서에서 한 이름을 지웠을 때 빠진 이름을 낸다. 검사 함수는 문서 경로를 인자로 받는다.

## 검증

```bash
node --test --test-concurrency=4 orch/tests/events-doc.spec.ts
node --test --test-concurrency=4 "orch/tests/*.spec.ts" "work-board/tests/*.spec.ts"
python3 -m unittest discover -s scripts/tests
claude plugin test .
python3 korean-check/scripts/korean-style-check.py orch/SKILL.md orch/references/*.md docs/flow.md docs/data-schema.md docs/code-architecture.md
! grep -n "구현 PR 이 모두 머지되기 전" docs/flow.md docs/data-schema.md docs/code-architecture.md
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `orch/SKILL.md` | 수정 |
| `orch/CHANGELOG.md` | 수정 |
| `orch/references/waiting.md` | 수정 |
| `orch/references/hooks.md` | 수정 |
| `orch/references/overlay.md` | 수정 |
| `orch/references/cleanup.md` | 수정 |
| `orch/scripts/lib/events.ts` | 수정 |
| `docs/flow.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/code-architecture.md` | 수정 |
| `orch/tests/events-doc.spec.ts` | 신규 |
