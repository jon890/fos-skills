# Phase 01. 보드 기본 위치와 이전

**Execution profile**: standard

## 목표

보드를 `.orch/board.json`에 두고, 이전할 때까지 기존 보드를 열 수 있게 한다.

**범위 외**: 실제 저장소에서 이전 적용.

## 컨텍스트

**요구사항**: REQ1, REQ2, REQ3, REQ4, REQ5, REQ6

**근거 문서**: `docs/features/board-orch-dir/spec.md`, `docs/features/board-orch-dir/technical-design.md`

## 의도 메모

세션이 열려 있을 때 경로를 조회해도 파일을 옮기지 않는다. 이전 명령에만 쓰기를 둔다.

## 작업 항목

### 1. 공통 보드 경로와 창의 찾기 순서

같은 경로 목록을 사용한다.

### 2. doctor 안내와 이전

미리보기, 적용, 충돌, 공유 설정 갱신을 추가한다.

### 3. 책임 문서와 변경 이력

보드 기본 경로와 이전 방법을 갱신한다.

### 4. `skills/orch/tests/migrate-orch-dir.spec.ts`와 보드 경로 테스트

기존 보드 읽기, 기본 경로, 미리보기에서 쓰기 없음, 충돌, 공유 저장소 설정, 홈 이전을 확인한다.

## 검증

```bash
node --test skills/orch/tests/lib-board-file.spec.ts skills/orch/tests/lib-paths.spec.ts skills/orch/tests/orch-paths.spec.ts skills/orch/tests/board-edit.spec.ts skills/orch/tests/board-path-callers.spec.ts skills/orch/tests/orch-doctor.spec.ts skills/orch/tests/migrate-orch-dir.spec.ts extensions/work-board/tests/board.spec.ts extensions/work-board/tests/board-file.spec.ts
node --test skills/orch/tests/board-attach.spec.ts skills/orch/tests/board-unmatched.spec.ts skills/orch/tests/decisions.spec.ts skills/orch/tests/lib-step-launches.spec.ts skills/orch/tests/lib-step-ready.spec.ts skills/orch/tests/orch-loop.spec.ts skills/orch/tests/launch-worker.spec.ts skills/orch/tests/send-to-worker.spec.ts
node scripts/run-tests.ts --tsc-only
node scripts/check-skill-docs.ts
```

## 인수 검증 계획

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 실행 담당 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ1, REQ2 | 보드가 없는 저장소와 옛 보드가 있는 저장소 | 보드 경로 CLI와 창을 열고 파일을 확인 | 새 기본 위치를 사용하고, 이미 있는 옛 보드에는 이전 전까지 읽고 쓴다 | 임시 저장소와 창 테스트 | worker | 없음 | PR 전 |
| REQ3 | 옛 보드가 있는 저장소 | `orch doctor` 실행 | 경로와 이전 명령 안내 | 임시 저장소 | worker | 없음 | PR 전 |
| REQ4, REQ5 | 옛 공유 보드, 설정, 겹치는 새 파일 | 미리보기, 충돌 상태에서 적용, 겹침을 치운 뒤 적용하고 재실행 | 미리보기와 충돌에서 파일 보존, 정상 적용에서 보드와 참조 갱신 | 임시 저장소와 가짜 orca CLI | worker | 없음 | PR 전 |
| REQ6 | git 밖에서 연 세션과 임시 홈 | 이전 전후의 보드 경로 확인 | 홈의 옛 보드와 새 보드를 순서대로 읽는다 | 임시 홈 | worker | 없음 | PR 전 |
| REQ4 | 이 저장소의 옛 보드 | 실제 저장소에 이전 명령을 미리보기로 실행 | 옮길 경로가 표시되고 파일이 유지된다 | 작업 저장소 | worker | 없음 | PR 전 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `modules/work-board/locations.ts` | 신규 (공통 경로 목록) |
| `modules/work-board/path.ts` | 수정 (기본 경로와 옛 경로 목록) |
| `extensions/work-board/hooks/register.js` | 수정 (보드 창의 경로 조회) |
| `extensions/work-board/bin/board.ts` | 수정 (CLI 도움말) |
| `skills/orch/scripts/lib/board-file.ts` | 수정 (설정 경로 해석과 doctor 검사) |
| `skills/orch/scripts/lib/config.ts` | 수정 (옛 설정 잠금 읽기와 쓰기) |
| `skills/orch/scripts/lib/paths.ts` | 수정 (보드 경로와 작업 폴더 경계 설명) |
| `skills/orch/scripts/doctor/orch-doctor.ts` | 수정 (옛 경로 이전 안내) |
| `skills/orch/scripts/doctor/migrate-orch-dir.ts` | 수정 (기존 이전 명령과 보드 이전 연결) |
| `skills/orch/scripts/doctor/migrate-board.ts` | 신규 (공유 보드와 설정 이전) |
| `skills/orch/tests/lib-board-file.spec.ts` | 수정 (기본·옛·설정 경로 검증) |
| `skills/orch/tests/lib-paths.spec.ts` | 수정 (보드와 작업 폴더 경계 검증) |
| `skills/orch/tests/orch-paths.spec.ts` | 수정 (경로 CLI 검증) |
| `skills/orch/tests/board-edit.spec.ts` | 수정 (기본 경로와 워크트리 검증) |
| `skills/orch/tests/board-path-callers.spec.ts` | 수정 (호출자 간 경로 검증) |
| `skills/orch/tests/orch-doctor.spec.ts` | 수정 (doctor 안내 검증) |
| `skills/orch/tests/migrate-orch-dir.spec.ts` | 수정 (이전·충돌·공유 설정 검증) |
| `extensions/work-board/tests/board.spec.ts` | 수정 (보드 CLI와 홈 경로 검증) |
| `extensions/work-board/tests/board-file.spec.ts` | 수정 (창이 받는 보드 경로 검증) |
| `extensions/work-board/tests/session-root.test.ts` | 수정 (창의 세션 시작 위치와 홈 검증) |
| `docs/data-schema.md` | 수정 (현재 파일 경로와 설정 설명) |
| `docs/adr/008-orch-own-dir.md` | 수정 (보드 경로 후속 결정 연결) |
| `skills/orch/README.md` | 수정 (설정 예시) |
| `skills/orch/references/overlay.md` | 수정 (설정 키와 이전 안내) |
| `skills/orch/references/board.md` | 수정 (설정 예시) |
| `extensions/work-board/README.md` | 수정 (보드 기본 경로) |
| `extensions/work-board/references/behavior.md` | 수정 (창의 경로 탐색) |
| `skills/orch/changes/board-orch-dir.minor.md` | 신규 (변경 이력) |
| `extensions/work-board/changes/board-orch-dir.minor.md` | 신규 (변경 이력) |
| `skills/orch/tests/board-attach.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/board-unmatched.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/decisions.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/lib-step-launches.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/lib-step-ready.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/orch-loop.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/launch-worker.spec.ts` | 수정 (임시 보드 위치) |
| `skills/orch/tests/send-to-worker.spec.ts` | 수정 (임시 보드 위치) |
