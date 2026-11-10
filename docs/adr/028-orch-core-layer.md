# ADR-028: 값 판정과 외부 실행을 폴더로 나눈다

- **status**: `accepted`
- **decision-type**: `architecture`
- **현재 규칙의 원본**: [기술 설계의 두 층 경계](../features/orch-lib-layers/design.md#두-층-경계pr4), [core 경계 검사](../../skills/orch/tests/core-boundary.spec.ts), [코드 배치](../code-architecture.md#배치).
- **결정**: 입력 값으로 결과를 정하는 코드는 `skills/orch/scripts/core/` 가 소유하고, 파일·프로세스·외부 명령을 읽고 쓰는 코드는 `lib/` 와 명령 파일이 맡는다. 의존은 실행 코드에서 core 로만 향한다. 기존 lib import 경로는 재수출이나 얇은 호출 함수로 유지한다.
- **맥락**: 판정과 외부 실행이 섞이면 작은 규칙을 확인하는 테스트에도 가짜 명령과 임시 저장소가 필요했다. 순수 함수 테스트가 외부 실행에 다시 기대지 않도록 폴더와 소스 검사로 경계를 고정한다.
- **대안 기각**: 파일 맨 위 표지만 두면 새 파일이 표지를 빠뜨렸을 때 잡지 못한다. 별도 lint 의존을 더하는 대신 기존 node 테스트에서 import 와 외부 상태 접근을 검사한다.
- **결과**: 판정은 가짜 실행 파일 없이 값만으로 확인할 수 있고, 명령의 기존 출력·종료 코드·상태 파일은 고정 입력 기록으로 대조한다. 기존 lib 경로를 쓰는 work-board 와 다른 호출자도 계속 동작한다. 재수출 파일을 유지해야 하며, 소스 검사는 언어 분석기보다 단순하므로 금지 사례를 넣어 검사 자체도 확인한다.
- **확인 방법**: [경계 검사](../../skills/orch/tests/core-boundary.spec.ts), [중복 검사](../../skills/orch/tests/core-dedup.spec.ts), [값 입력 테스트](../../skills/orch/tests/core-values.spec.ts), [고정 입력 실행기](../../skills/orch/tests/fixtures/golden-run.ts).
