# ADR-025: 저장소의 스크립트와 테스트를 TypeScript(Node 24) 하나로 둔다

- **status**: `accepted`
- **decision-type**: `architecture`
- **areas**: `quality, operations`
- **현재 규칙의 원본**: [저장소 실행 규칙](../code-architecture.md#저장소-실행-규칙), [`scripts/runtime-policy.json`](../../scripts/runtime-policy.json), 이행 순서는 [node-runtime 스펙](../features/node-runtime/spec.md)
- **결정**: 저장소의 스크립트, 검사기, git 훅, 테스트는 TypeScript 로 쓰고 Node 24 의 타입 제거로 바로 실행한다. Python 과 셸 파일을 두지 않는다.
  JS 는 타입 제거가 닿지 않는 진입에만 쓴다. 확장자 없는 git 훅과 실행기, 옛 이름 진입, 이미 있는 work-board hooks 모듈이 여기 해당한다.
  스킬과 도구는 자기 폴더와 Node 내장 모듈만 import 한다. 사용자 결정 2026-11-04, 2026-11-05.
  [ADR-010](010-orch-typescript.md) 과 [ADR-011](011-node-24-minimum.md) 이 orch 와 work-board 에 정한 언어와 Node 버전을 저장소 전체로 넓힌다.
- **대체된 부분**: 「Node 내장 모듈만 import 한다」 와 「npm 의존을 두지 않는다」 는 orch 에 한해 [ADR-030](030-plugin-npm-dependencies.md) 이 바꿨다.
- **맥락**: orch, work-board, inbox 를 옮긴 뒤에도 다른 스킬과 저장소 관리 명령에 Python 124개 파일(약 2만 3천 줄)과 셸 16개가 남았다(2026-11-05 실측).
  두 언어가 같은 꼴의 helper(옵션 줄임 처리, JSON 출력 꼴, 셸 인용)를 따로 두었고, 테스트도 `node --test` 와 `unittest` 두 벌로 돌았다.
  사용자는 한 언어로 유지보수, 테스트와 실행 속도, python3 가 없는 환경 지원을 얻으려 했다(스펙 DECISION1).
  팀 저장소는 스킬 폴더만 복사해 가고, 플러그인 캐시도 스킬 폴더 밖 배치를 보장하지 않는다. 그래서 스킬 밖의 공용 코드를 import 하면 팀 사본에서 경로가 깨진다(설계 「스킬은 자기 폴더 안만 import 한다」).
- **대안 기각**:
  - Python 을 유지한다: 두 언어가 공통 helper 와 테스트 도구를 두 벌 둔다.
  - 셸 한 줄 진입을 허용한다: 사용자가 예외 없이 옮기기로 했다. 확장자 없는 진입도 node shebang 으로 돈다.
  - 빌드 단계나 번들러를 둔다: [ADR-010](010-orch-typescript.md) 과 같은 이유로 npm 의존과 빌드 산출물을 두지 않는다.
  - 저장소 공용 helper 를 import 한다: 팀 플러그인 안 스킬에서 경로가 깨진다. 원본을 한 곳에 두고 복사본을 테스트로 대조한다.
- **결과**:
  - 얻는 것: 스크립트와 테스트가 한 언어로 돌고, python3 가 없는 환경에서도 스킬이 돈다.
  - 얻는 것: 저장소 검사가 허용 목록 밖의 새 Python·셸 파일과 JS 진입을 파일 이름과 함께 막는다. 옮기는 동안 남은 일이 정책 파일 하나에 보인다.
  - 감당할 것: Python `re` 와 JS RegExp 의 뜻이 다른 글자(`\w`, `\d`, `\b`)를 옮길 때마다 명시 문자 클래스로 바꿔야 한다.
  - 감당할 것: 공용 helper 의 복사본을 원본과 맞춰 두어야 한다.
  - 감당할 것: 이행하는 동안 팀 저장소의 사본은 옛 Python 에 머물러 원본과 어긋난다.
  - 감당할 것: Node 24 미만에서는 명령이 안내 없이 실패한다.
- **적용 범위**: 규칙은 [`../code-architecture.md`](../code-architecture.md) 「저장소 실행 규칙」, 남은 파일과 허용 진입은 `scripts/runtime-policy.json`, 이행 순서는 `docs/features/node-runtime/spec.md` 가 소유한다.
