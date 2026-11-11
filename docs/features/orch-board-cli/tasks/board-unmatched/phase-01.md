# Phase 01. 못 맞춘 머지를 알리고 수동 단계를 보존한다

**Execution profile**: standard

## 목표

REQ12, REQ15 에 따라 머지와 관련된 줄만 끝내고 못 맞춘 머지를 중복 없이 알린다.

**범위 외**: 자동 진행 표시 문법, 승인 창, 마일스톤 완료 규칙 변경.

## 컨텍스트

**요구사항**: REQ12, REQ15

**근거 문서**: `docs/features/orch-board-cli/spec.md`, `docs/features/orch-board-cli/design.md`

`core/board.ts` 의 prSteps, `board/board-sync.ts` 의 머지 반영, `queue/finish-pr.ts` 의 updateBoardRows 를 재사용한다. 기록 파일은 pathOf('state') 아래에 두고 file-lock.ts 로 읽기와 쓰기를 잠근다. 기록 실패는 stderr 에 남기고 기존 마무리 결과는 바꾸지 않는다. 알림은 run-notice.ts 를 재사용하며 알림 전송 비용만 더한다.

## 의도 메모

- 이미 끝난 줄도 PR 을 가리키는 줄로 세어 둘째 마일스톤 PR 의 오알림을 막는다.
- 근거 괄호 `(앞 사건: #N merge)` 는 prSteps 의 번호 판정에서 제외한다. 자동 진행 설계 PR A phase 02 의 해당 고침을 이 PR 에서 먼저 한다.
- 명시한 --board-id 만 강제 완료를 유지한다. --complete 는 단계 강제 완료를 뜻하지 않는다.

## 작업 항목

### 1. core/board.ts 의 prSteps 에 끝난 줄 포함 옵션과 근거 괄호 제외를 더한다. 못 맞춘 머지와 풀림 순수 함수를 더한다.
### 2. lib/board-unmatched.ts 를 만들고 항목·PR 별 at/notified 를 잠금 안에서 읽고 갱신한다. 재기록은 notified 를 보존하고 기록 실패는 경고로 끝낸다.
### 3. board-sync 와 finish-pr 의 성공한 머지 반영 뒤 기록한다. 마지막 PR 도 관련 줄만 끝내고 남으면 doing, pr 은 비우고 merged-pr 에 더한다. 중간 PR 은 끝나도 doing 을 유지한다. --board-id 는 먼저 처리한다. tagged 항목은 finish-pr 에서 판정하고 board-sync 가 기존 사건 처리를 한다.
### 4. board-sync 끝에서 기록을 다시 읽어 사라진 항목·남은 단계 없음·해당 PR 의 끝난 꼬리표를 지운다. 루프 보드 단계는 성공한 전송 뒤에만 notified 를 적고 show 는 풀리지 않은 기록만 보인다.
### 5. `skills/orch/tests/board-unmatched.spec.ts` 회귀 테스트를 보완하고 board.md, waiting.md, data-schema.md 와 설계의 근거 괄호 소유 설명, 변경 조각을 맞춘다. 기존 golden 이 바뀌면 해당 마지막 PR 사례만 갱신한다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-unmatched.spec.ts skills/orch/tests/board-sync.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/core-values.spec.ts
claude plugin test .
```

종료 코드 0 이어야 한다. 전체 테스트는 지시서에 따라 CI 결과로 확인한다.

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ12 | 임시 보드와 가짜 gh/알림 전송 | board-unmatched.spec.ts 와 board-sync.spec.ts 로 없는 PR 줄, 이미 끝난 줄, 둘째 마일스톤 PR 을 반영 | 없는 줄만 기록·출력, 둘째 PR 오알림 없음 | 격리된 CLI 프로세스 | worker | 없음 | PR 전 |
| REQ12 | 같은 기록·실패하는 전송·새 루프 상태 | board-unmatched.spec.ts 로 같은 항목·PR 재기록과 루프 재시작, 실패 뒤 재전송 | 성공한 전송은 한 번, 실패는 재시도 | 임시 파일과 루프 단계 | worker | 없음 | PR 전 |
| REQ12 | 기록에 해당 PR 꼬리표 추가 또는 단계 완료 | board-unmatched.spec.ts 로 show 및 동기화 실행 | 풀린 기록 숨김·삭제, 다른 PR 기록 유지 | 격리된 CLI 프로세스 | worker | 없음 | PR 전 |
| REQ15 | 마지막·중간·판정 불명 PR, next 단계, --complete, --board-id | board-sync.spec.ts 와 finish-pr.spec.ts 로 머지 반영 | 관련 줄만 완료, 남으면 doing, 명시 id 만 강제 완료 | 격리된 CLI 프로세스 | worker | 없음 | PR 전 |
| REQ12 | 근거 괄호만 같은 번호인 줄과 직접 PR 번호가 있는 줄 | core-values.spec.ts 와 board-unmatched.spec.ts 실행 | 근거 번호로 완료·참조되지 않음, 직접 번호는 일치 | 값 및 CLI 테스트 | worker | 없음 | PR 전 |

| REQ12 | finish-pr 의 옛 단계·마일스톤·꼬리표 항목 | finish-pr.spec.ts 에서 머지 후 기록 파일을 읽는다 | 없는 참조만 기록하고 이미 끝난 참조·둘째 PR 은 기록하지 않음 | 격리된 CLI 프로세스 | worker | 없음 | PR 전 |
| REQ12 | 같은 기록 파일을 쓰는 프로세스 | board-unmatched.spec.ts 에서 서로 다른 항목·PR 을 함께 기록하고 전송 중 재기록한다 | 기록과 notified 가 모두 보존됨 | 임시 파일과 자식 프로세스 | worker | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/core/board.ts` | 수정 |
| `skills/orch/scripts/lib/board-unmatched.ts` | 신규 |
| `skills/orch/scripts/board/board-sync.ts` | 수정 |
| `skills/orch/scripts/queue/finish-pr.ts` | 수정 |
| `skills/orch/scripts/loop/steps/board.ts` | 수정 |
| `skills/orch/scripts/board/board-edit.ts` | 수정 |
| `skills/orch/tests/board-unmatched.spec.ts` | 신규 |
| `skills/orch/tests/board-sync.spec.ts` | 수정 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/board-path-callers.spec.ts` | 수정 |
| `skills/orch/tests/core-values.spec.ts` | 수정 |
| `skills/orch/references/board.md` | 수정 |
| `skills/orch/references/waiting.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `docs/features/orch-board-cli/design.md` | 수정 |
| `skills/orch/changes/board-unmatched.minor.md` | 신규 |
