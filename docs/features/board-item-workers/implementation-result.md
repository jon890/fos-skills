# 보드 항목 하위 worker PR1 개발 검증

스펙: [spec.md](spec.md), 설계: [design.md](design.md).
구현은 하위 에이전트 없이 순서대로 진행했다. 독립 리뷰와 인수 검증은 코디네이터가 맡는다.

## 구현한 범위

| 요구사항 | 변경과 개발 검증 |
| --- | --- |
| REQ1 | 보드 잠금 안에서 worker 줄과 대표 칸을 함께 쓴다. `board-workers.spec.ts`에서 추가·재시도·끝남·옛 대표 보존·단계 지문 보존을 확인했다 |
| REQ2 | 리뷰·검증은 대상 PR, 명시한 항목, 브랜치로 찾는다. `board-attach.spec.ts`에서 done 항목 유지, PR 우선순위, head 브랜치 조회, 조회 실패의 새 항목, 현재 리뷰 이력 제외를 확인했다 |
| REQ3 | 후속은 같은 업무·브랜치의 항목에 붙인다. `launch-worker.spec.ts`에서 `BOARD-ATTACH attention follow` 출력과 원래 줄 보존을 확인했다 |
| REQ5 | 지시서 머리의 새 항목 요청과 검증 역할을 읽는다. `lib-spec.spec.ts`, `spec-lint.spec.ts`에서 본문 예시 제외와 새 항목·id 동시 지정 거절을 확인했다 |
| REQ7 | `core-board-workers.spec.ts`에서 보고·dispatch 끝남을, `board-sync.spec.ts`에서 줄 끝내기·대표 교체·리뷰가 구현 항목을 닫지 않기를 확인했다. `board-path-callers.spec.ts`에서 루프 전달을, `lib-movement.spec.ts`에서 살아 있는 리뷰의 멈춤 알림 억제를 확인했다 |
| REQ8 | 데이터 스키마, 보드·지시서 참조, 리뷰·검증 틀과 orch 진입점을 설계와 대조했다. 이번 범위는 worker 데이터와 판정이며 창과 동시 PR 단계는 PR2 계획에 남긴다 |

## 실제 보드 사본 확인

2026-11-13에 저장소의 실제 보드를 세션 임시 폴더로 복사했다. 임시 git 저장소와 별도 `ORCH_DIR`에서 실제 `launch-worker`와 보드 명령을 실행했고 Orca 시작 응답만 가짜로 주었다. 원본 보드는 쓰지 않았다.

- 사본의 기존 구현 항목에 테스트 대상 PR을 지정하고 리뷰를 띄웠다. 항목 수·단계·대표 칸은 그대로였고 `BOARD-ATTACH board-item-workers-attach review`가 나왔다.
- 같은 항목의 브랜치로 후속 워크트리를 준비하고 후속을 띄웠다. 항목 수는 그대로였고 구현·리뷰 줄 뒤에 후속 줄이 남았다. 대표 칸은 후속 워크트리가 됐고 `BOARD-ATTACH board-item-workers-attach follow`가 나왔다.
- 검사 스크립트와 실행 출력은 세션 임시 폴더의 `board-attach-smoke-j287ddiw/`에 있다. 자동 테스트와 같은 가짜 Orca 응답을 썼으므로 실제 Orca dispatch 의 수명 확인은 코디네이터의 인수 검증에 남긴다.

## 개발 검증

계획의 phase별 테스트와 타입 검사는 통과했다. 한국어 표기 검사는 변경 문서 전체에서 발견이 없었고, 의미 점검에서는 제목·본문 관계, 역할 설명, 구현 범위와 PR2 경계를 확인했다.
플러그인 검사는 `claude plugin test .`로 통과했다.

전체 개발 검증은 `orch slot heavy --exclusive -- node scripts/run-tests.ts`로 실행한다. 최종 결과는 PR 본문에 남긴다.

## 문서 대조와 다음 단계

worker 줄의 열쇠, 대표 칸, 역할, 끝남과 새 항목 요청을 스펙·설계·데이터 스키마·참조 문서 사이에서 대조했다. 서로 다른 규칙이나 공통 문서로 옮길 반복 계약은 발견하지 못했다.
계획 폴더는 독립 verify 가 인수 검증 계획을 읽을 수 있도록 남겼다. 계획 정리는 orch 가 맡는다.
스킬 개선 후보와 공부 후보는 없다.

남은 작업은 독립 코드 리뷰, 코디네이터의 실제 Orca 인수 검증, 머지다. PR2의 동시 PR 단계와 창은 별도 계획을 따른다.
