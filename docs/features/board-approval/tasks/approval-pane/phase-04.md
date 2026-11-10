# Phase 04. 승인 기록 길의 정적 검사와 문서

**Execution profile**: standard

## 목표

승인 기록을 쓰는 곳이 사람이 누른 이벤트 하나로 이어지는지 정적으로 검사하고, 창의 동작을 문서에 옮긴다. 구현이 설계와 달라진 곳은 같은 커밋에서 설계를 고친다.

**범위 외**: 창 코드와 스크립트의 동작 변경(phase 01~03).

## 컨텍스트

**요구사항**: REQ4(창 코드에서 승인 기록을 쓰는 곳이 사람이 누른 이벤트 처리 하나뿐), REQ5, REQ6

**근거 문서**: `docs/features/board-approval/spec.md`, `docs/features/board-approval/design.md`, `extensions/work-board/references/behavior.md`

- 정적 검사는 `skills/orch/tests/board-approval-static.spec.ts` 가 이미 승인 상태 문자열(`'approved'`, `'revise'`)을 `core/approvals.ts` 밖에서 만들지 못하게 막는다. 창과 스크립트는 동작 이름 `approve`, `revise` 를 쓰므로 `revise` 는 같은 줄에 `state` 가 있을 때만 상태로 센다. `approved` 는 지금처럼 어디서든 센다.

## 작업 항목

### 1. 정적 검사 확장 (`board-approval-static.spec.ts`)

- `stateLiterals` 를 위 규칙으로 좁히고, 기존 사례(`state: action === 'approve' ? 'approved' : 'revise'` 등)가 계속 잡히는 것을 확인한다. 동작 이름으로 쓰는 `'revise'`(같은 줄에 `state` 없음)는 통과하는 사례를 더한다.
- 사슬 검사: (a) `applyPress` 를 부르는 곳은 `lib/approvals.ts` 하나, (b) `recordPress` 를 부르는 곳은 `extensions/work-board/bin/approvals.ts` 하나, (c) `register.js` 에서 `approvals.ts` 의 `press` 동작을 부르는 곳은 한 곳(`approvalArgv`), (d) 그 `approvalArgv` 를 부르는 곳은 `pressApproval` 하나, (e) orch 명령 표(`lib/commands.ts`)에 `press`, `approve`, `revise` 동작이 없다. 테스트가 소스 글을 읽어 센다.

### 2. 문서

- `extensions/work-board/references/behavior.md`: 「승인 대기」 절을 더한다. 상자 위치와 내용, 버튼과 숨기는 조건(worker 터미널, 모를 때), 고쳐 달라 글칸, real 두 번 누르기(10초), `command` 의 명령 채우기와 올린 터미널 조건, 누른 뒤 상자에서 빠지는 것, 실패 때 toast, 미리보기 열기, `origin` 기록, 읽기 주기 5초, 창이 부르는 스크립트 셋. 상태 줄 설명에 「승인 n」 을 더한다.
- `extensions/work-board/README.md`: 「화면 읽기」 표에 「승인 대기」 행, 사용 예시에 승인과 고쳐 달라 한 단락.
- `docs/features/board-approval/design.md`: 구현에서 정한 것과 설계가 달라진 곳을 고친다. 미리보기 링크 → 「미리보기 열기」 버튼, `block-approval-press.ts` 의 자리(`skills/orch/hooks/`), `self` 의 `--live` 가 지금 읽는 상태. 이 PR 로 끝난 「PR2」 표기를 현재형으로 맞춘다.
- `skills/orch/changes/board-approval-pane.minor.md`, `extensions/work-board/changes/board-approval-pane.minor.md` 변경 이력 조각(`- ` 줄).
- orch 의 `references/replying.md` 「보드 승인」 에 창 전용 스크립트를 hook 이 거부한다는 한 줄이 이미 있는지 확인하고 없거나 어긋나면 고친다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/board-approval-static.spec.ts skills/orch/tests/board-approval-docs.spec.ts
node export-only-skills/korean-check/scripts/check.ts extensions/work-board/references/behavior.md extensions/work-board/README.md docs/features/board-approval/design.md
node scripts/run-tests.ts --tsc-only
```

## 변경 파일

| 파일 | 변경 |
|---|---|
| `skills/orch/tests/board-approval-static.spec.ts` | 수정 |
| `extensions/work-board/references/behavior.md` | 수정 |
| `extensions/work-board/README.md` | 수정 |
| `docs/features/board-approval/design.md` | 수정 |
| `skills/orch/changes/board-approval-pane.minor.md` | 신규 |
| `extensions/work-board/changes/board-approval-pane.minor.md` | 신규 |
