# ADR-011: orch 와 work-board 의 최소 Node 를 24 로 올린다

- **status**: `accepted`
- **결정**: orch 와 work-board 의 `.ts` 명령과 테스트는 Node 24 이상을 요구한다. CI 는 Node 24 로 돌고 `NODE_COMPILE_CACHE` 를 켠다.
  [ADR-010](010-orch-typescript.md) 의 「Node 22.18 이상」 을 대체한다. 사용자 결정 2026-10-25.
- **맥락**: CI 는 최소 지원 버전에서 돌아 그 약속을 확인한다. 그래서 CI 가 Node 22 에 묶여 있었다.
  Node 22 는 2025-10-21 부터 Maintenance LTS 이고 2027-04-30 에 지원이 끝난다. Node 24 는 2028-04-30 까지 지원된다.
  CI 의 node 테스트는 프로세스 기동과 git 으로 CPU 를 다 쓰고, 명령마다 `.ts` 를 다시 파싱하고 컴파일한다.
  Node 의 컴파일 캐시는 Node 24 에서만 타입을 제거한 `.ts` 에 듣는다(실측: 기동이 `merge_queue.ts` 161ms 에서 108ms, `cleanup-sweep.ts` 84ms 에서 38ms). Node 22.23 에서는 차이가 없었다.
- **대안 기각**:
  - Node 22 에 남는다. 컴파일 캐시를 쓰지 못하고, 반년 뒤 지원이 끝나는 버전을 기준으로 삼는다.
  - CI 를 Node 22 와 24 두 벌로 돌린다. 최소 버전 확인은 남지만 작업이 두 배이고, 시간은 느린 Node 22 쪽이 정해 줄지 않는다.
  - Node 26 으로 올린다. 2026-10-28 에 LTS 가 되는 직후라 아직 깔린 머신이 적다.
- **결과**:
  - 얻는 것: CI 에서 명령과 node 로 만든 가짜 실행 파일의 기동이 컴파일 캐시로 빨라진다. 지원이 오래 남은 버전을 기준으로 삼는다.
  - 감당할 것: Node 22 만 있는 머신에서는 스킬을 열 때 `NODE-TOO-OLD` 로 멈춘다. orch 와 work-board 는 팀 저장소로 내보내지 않는 스킬이라 영향은 이 저장소를 쓰는 머신에 그친다.
- **적용 범위**: 버전 판정은 `orch/scripts/ts_shim.py` 가, 실행 규칙은 [`../code-architecture.md`](../code-architecture.md) 의 「실행 규칙」 이 소유한다.
