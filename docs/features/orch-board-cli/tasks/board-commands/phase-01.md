# Phase 01. 보드 명령과 안내

**Execution profile**: standard

## 목표

코디네이터가 플러그인 경로 없이 보드 상태와 단계를 고치고 짧은 결과를 읽는다.

**범위 외**: REQ10 자동 진행 표시, REQ12 알림, REQ15 머지 규칙. 기존 board.ts 인자와 저장 규칙 변경.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ6, REQ7, REQ8, REQ9, REQ13, REQ14

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md` 의 새 명령(PR3).

`lib/commands.ts` 의 prepend/context 로 동작과 repo 를 채운다. `lib/board-file.ts` 의 boardPath(repo, explicit) 를 쓴다. `lib/proc.ts` 의 run/scriptCommand 로 `BOARD_BIN` 환경 변수 또는 `lib/board.ts` 의 BOARD_BIN 을 호출한다. 이 모듈의 import 는 보드를 쓰지 않는다. `lib/output.ts` 의 fullAsked 는 진입점의 --full 신호만 읽는다. emit 은 숫자 줄을 버리므로 쓰지 않는다.

## 의도 메모

- 규칙을 재구현하지 않고 board.ts 의 set/step --exact, step-edit, step-add, view 결과 JSON 을 쓴다.
- 번호가 숫자인지와 인자 개수만 검사한다. --on 은 --event 로 넘긴다. done/undo 에 --on 은 사용법 오류다.
- 기존 board.spec.ts 를 고치지 않고 호환성을 확인한다. 문서와 창 요청문은 상태·단계만 새 명령으로 바꾸고 mark 와 필드 수정은 남긴다.

## 작업 항목

### 1. 명령과 출력

`skills/orch/scripts/board/board-edit.ts` 를 만들고 명령 표에 set, step, add-step, show 를 등록한다. 설계의 호출·출력 표와 종료 코드를 따른다. show 기본은 미완료 번호 줄만, --full 은 모든 줄과 완료 표시를 낸다. boardPath 설정 오류는 종료 코드 2, board.ts 거절은 그대로 전달한다.

### 2. 실행 검증과 문서

`skills/orch/tests/board-edit.spec.ts` 에 진입점 실행 테스트를 만든다. 임시 저장소와 워크트리에서 기본·설정·명시 보드 경로, 각 명령 정상·거절·사용법, --full, 숫자 id, 누락 보드, progress 와 next, decide 자동 전환, 꼬리표와 경고를 확인한다. 거절·조회 뒤 파일 바이트를 비교한다. 명령 표와 문서 계약 테스트를 더하고 창 요청문 테스트를 바꾼다. prompts.spec.ts 에 START_PROMPT 가 직접 JSON 수정을 시키지 않고 orch board 와 board.ts del 을 안내하는지 단언한다. board.md 와 work-board README 에 새 명령과 직접 수정 금지를 안내한다. orch 변경 조각을 추가한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-edit.spec.ts skills/orch/tests/lib-commands.spec.ts skills/orch/tests/docs-contract.spec.ts extensions/work-board/tests/check.spec.ts extensions/work-board/tests/prompts.spec.ts extensions/work-board/tests/board.spec.ts
claude plugin test .
```

전체 테스트와 타입 검사는 CI 의 `node scripts/run-tests.ts` 로 확인한다. 로컬 전체 실행은 지시서의 전체 테스트 CI 규칙에 따라 중복하지 않는다.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/board/board-edit.ts` | 신규 |
| `skills/orch/scripts/lib/commands.ts` | 수정 |
| `skills/orch/tests/board-edit.spec.ts` | 신규 |
| `skills/orch/tests/lib-commands.spec.ts` | 수정 |
| `skills/orch/tests/docs-contract.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/changes/board-commands.minor.md` | 신규 |
| `extensions/work-board/hooks/register.js` | 수정 |
| `extensions/work-board/README.md` | 수정 |
| `extensions/work-board/tests/check.spec.ts` | 수정 |
| `extensions/work-board/tests/prompts.spec.ts` | 수정 |
