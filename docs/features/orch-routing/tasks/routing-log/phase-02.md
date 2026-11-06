# Phase 02. PR 종료 시 routing 기록을 쓴다

**Execution profile**: standard

## 목표

REQ5의 종료된 worker PR을 개인정보와 금액 없이 한 줄로 남긴다.

**범위 외**: REQ7 집계, 실제 PR 머지, 설정 배포.

## 컨텍스트

**요구사항**: REQ5.

**근거 문서**: `docs/features/orch-routing/spec.md`, `docs/features/orch-routing/design.md`.
`launch-history.ts`에서 영구 이력을 읽고 `events.ts`의 acquireLock/releaseLock을 재사용한다.
`finish-pr.ts`는 worker 종료 대기 뒤 정리 전에 호출한다.
`cleanup-sweep.ts`는 run 여부와 무관하게 최근 이력 브랜치의 종료 PR을 보완한다.
gh/orca 호출 비용은 이 범위에 포함하며 실제 메시지를 소비하지 않는 inbox 조회만 쓴다.

## 의도 메모

- 수집기 실패는 해당 필드만 null로 둔다. 기록 오류가 정리를 막지 않는다.
- 브랜치 재사용은 앞 PR 종료 시각으로 구분한다. 같은 PR·결과는 조회와 쓰기를 반복하지 않는다.
- routing 설정은 새 번들 설치 후 추가한다. 새로운 의존성은 없다.

## 작업 항목

### 1. routing-log 수집·원자적 저장과 routing 설정 키를 구현한다.
### 2. GitHub 리뷰·커밋·각 head의 CI 실행, dispatch별 자기 Run 메시지, 사용량 파일을 수집한다.
### 3. `skills/orch/tests/lib-routing-log.spec.ts`와 finish-pr.spec.ts, cleanup-sweep-routing.spec.ts 테스트

finish와 cleanup에 연결하고 fake gh/orca·임시 사용량 파일로 검증한다.
### 4. overlay/data-schema와 변경 조각을 맞춘다.

## 검증

```bash
node scripts/run-tests.ts skills/orch/tests/lib-routing-log.spec.ts skills/orch/tests/finish-pr.spec.ts skills/orch/tests/cleanup-sweep-routing.spec.ts skills/orch/tests/lib-config.spec.ts
node scripts/run-tests.ts
claude plugin test .
```

## 인수 검증 계획

환경: 임시 git 저장소, fake gh/orca, 임시 ORCA_USAGE_DIR. 실제 브랜치·volume은 삭제하지 않는다.

| 요구사항 | 준비 조건 | 실행 절차 | 기대 결과 | 실행 환경 | 선행 조건 | 시점 |
| --- | --- | --- | --- | --- | --- | --- |
| REQ5 | 머지 기록: 임시 이력과 수집기 응답 | finish 통합 테스트에서 worker 종료 후·cleanup 전 파일을 확인 | 필수 키, outcome merged, 본문과 금액 없음 | 임시 저장소 또는 실제 머지 환경 | 없음 | PR 전 |
| REQ5 | 닫힘과 보완: 임시 이력과 수집기 응답 | run 없는 cleanup에서 최근 이력 브랜치의 CLOSED와 누락 MERGED 조회 | closed 또는 merged 기록, 오래된 이력은 조회하지 않음 | 임시 저장소 또는 실제 머지 환경 | 없음 | PR 전 |
| REQ5 | 멱등·승격·경쟁: 임시 이력과 수집기 응답 | 같은 PR 반복, closed 다음 merged, 동시 다른 PR 쓰기 | PR별 한 줄, merged로 승격, 다른 PR 보존 | 임시 저장소 또는 실제 머지 환경 | 없음 | PR 전 |
| REQ5 | 부분 실패: 임시 이력과 수집기 응답 | 수집기 오류와 조회 한도, 사용량 형식 오류 | 해당 키 null, 나머지 보존 | 임시 저장소 또는 실제 머지 환경 | 없음 | PR 전 |
| REQ5 | 브랜치 재사용: 임시 이력과 수집기 응답 | 앞 PR 종료 전후와 현재 PR 종료 후 이력 혼합 | 현재 PR dispatch만 기록 | 임시 저장소 또는 실제 머지 환경 | 없음 | PR 전 |
| REQ5 | 실제 기록: 코디네이터가 첫 실제 머지를 대조 | PR-C 배포 뒤 첫 머지에서 state/routing-log.jsonl을 gh/orca/이력과 대조 | 한 줄과 관측값 일치 | 임시 저장소 또는 실제 머지 환경 | 배포: PR-C 번들 배포와 첫 머지 | PR 뒤 |

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| `skills/orch/scripts/lib/routing-log.ts` | 신규 |
| `skills/orch/scripts/lib/config.ts` | 수정 |
| `skills/orch/scripts/queue/finish-pr.ts` | 수정 |
| `skills/orch/scripts/cleanup/cleanup-sweep.ts` | 수정 |
| `skills/orch/tests/lib-routing-log.spec.ts` | 신규 |
| `skills/orch/tests/finish-pr.spec.ts` | 수정 |
| `skills/orch/tests/cleanup-sweep-routing.spec.ts` | 신규 |
| `skills/orch/tests/lib-config.spec.ts` | 수정 |
| `skills/orch/references/overlay.md` | 수정 |
| `docs/data-schema.md` | 수정 |
| `skills/orch/changes/orch-routing-pr-c.minor.md` | 신규 |
