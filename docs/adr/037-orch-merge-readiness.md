# ADR-037: 머지 전 조건은 조건 표 하나가 소유하고 호출부는 범위만 고른다

- **status**: `accepted`
- **decision-type**: `architecture`
- **areas**: `orch`
- **현재 규칙의 원본**: `skills/orch/scripts/core/merge-readiness.ts` 의 조건 표(`CONDITIONS`)와 머리 주석. 요구사항은 [머지 판단 스펙](../features/merge-readiness/spec.md)의 REQ1, REQ2 이고 구조는 [기술 설계](../features/merge-readiness/technical-design.md)가 소유한다.
- **결정**: 「머지해도 되나」 의 조건(체크, 미해결 스레드, 충돌, 리뷰, 통합 테스트 기록, 마이그레이션 번호, 비공개 낱말, draft, 보류)은 `core/merge-readiness.ts` 의 조건 표 하나에 둔다. 조건마다 종류, 단계(`ready`, `merge`), 범위(`light`, `full`), 평가 순서와 출력 순서, 필요한 값, 문구를 둔다.
  관문, 머지 큐, 루프 자동 머지는 `lib/merge-readiness.ts` 의 `checkReadiness` 를 부르고 범위와 `only`, `skip` 만 고른다. 값 읽기는 lib, 판단과 조건 순회는 core 가 맡는다([ADR-028](028-orch-core-layer.md)).
  보류는 `merge` 단계 조건이라 「준비됨을 알려도 되나」 에는 걸리지 않고 「지금 머지해도 되나」 에서만 막는다. 이행 중에 호출부마다 남겼던 동작 차이(`compat` 값)는 구현 PR 일곱 개가 모두 지워 지금 코드에는 없다.
- **맥락**: 같은 질문을 관문(`gateReasons`), 머지 큐, 루프(`judgeTarget`)가 따로 답해, 보드 보류는 루프만 보고 통합 테스트 기록과 비공개 낱말은 관문만 보는 식으로 어긋났다. 조건 하나를 고칠 때마다 세 곳을 함께 고쳐야 했다(커밋 6c2340d2, PR 619 의 지적 3건).
- **대안 기각**:
  - 호출부마다 조건 목록을 두고 공통 함수만 나눠 쓴다. 어느 조건을 어느 순서로 보는지가 다시 세 곳에 흩어져, 지금 어긋남이 그대로 남는다.
  - 단계를 질문으로 나눈다(「준비됨」 질문과 「머지」 질문을 따로 묻는다). 관문은 한 번 물어 `ready` 이유로 실패하고 `merge` 이유를 `HOLD` 로 내야 하는데, 질문을 나누면 두 번 물어 같은 값을 두 번 읽는다. 이유마다 단계를 붙인다.
- **결과**:
  - 얻는 것: 조건을 더하거나 순서를 바꾸는 일이 조건 표 한 곳에서 끝난다. 조건의 판단은 gh 없이 snapshot 값만으로 테스트한다. 범위에 든 조건은 호출부와 관계없이 같은 답을 낸다.
  - 감당할 것: 지금 출력과 gh 호출 순서를 지키려고 lib 가 값 하나를 읽을 때마다 core 에 다시 묻는다. 조건이 늘면 읽는 순서(`READ_ORDER`)도 함께 정해야 한다. 이행 중에 쓰던 `compat` 값은 모두 지워졌다. 되돌리려면 관문, 머지 큐, 루프의 코드와 출력 계약을 함께 바꿔야 한다.
- **확인 방법**: `skills/orch/tests/core-merge-readiness.spec.ts` 가 조건마다 통과, 걸림, 조회 실패, 범위 대조, 두 단계를 본다. `skills/orch/tests/lib-merge-readiness.spec.ts` 가 값 읽기를, `queue-gate.spec.ts` 와 `merge-queue.spec.ts` 가 호출부의 출력을 본다.
