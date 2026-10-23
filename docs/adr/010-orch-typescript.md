# ADR-010: orch 와 work-board 의 Python 스크립트를 빌드 없는 TypeScript 로 한 번에 옮긴다

- **status**: `accepted`
- **결정**: `orch/scripts/`, `orch/hooks/`, `work-board/bin/` 의 Python 과 sh 스크립트, 그 테스트, `scripts/run-orch-tests.py` 를 TypeScript 로 옮긴다.
  Node 의 타입 제거 실행으로 `.ts` 를 바로 돌린다. 빌드 단계와 npm 의존을 두지 않는다. Node 22.18 이상을 요구한다.
  테스트는 `node:test` 로 옮긴다. 옮기는 동안 Python 과 TypeScript 를 오래 함께 두지 않고, 이어지는 PR 들로 한 차례에 끝낸다.
  명령의 이름과 옵션은 그대로 두고 확장자만 바꾼다. 옛 `.py` 경로는 다음 major 까지 node 로 넘기는 얇은 shim 으로 남긴다.
  사용자 결정 2026-10-24.
- **맥락**: orch 스크립트는 Python 과 sh 로 흩어져 있었고, 공통 코드를 파일마다 복사했다.
  orca 호출 helper, `run()` 래퍼, pid 생존 확인, `브랜치:` 줄 정규식이 여러 벌이고 반환 형태와 예외, timeout 이 제각각이었다.
  복사본 사이의 차이가 사고로 이어졌다. 지시서 삭제 경로 셋 가운데 하나만 살아 있는 dispatch 를 확인하지 않았고, pid 확인 하나는 EPERM 을 죽음으로 읽었다.
  work-board 의 hooks 모듈은 이미 JavaScript 이고, 이벤트 핸들러([ADR-009](009-orch-event-handlers.md))를 저장소가 TypeScript 로 쓰면 코어와 같은 실행기를 쓴다.
- **대안 기각**:
  - 모듈 하나씩 단계적으로 옮긴다. 두 언어의 공통 모듈이 오래 함께 있어 같은 버그를 두 번 고친다. 사용자가 기각했다.
  - Python 에 남기고 공통 모듈만 정리한다. 핸들러와 work-board 가 쓰는 언어와 갈린다. 사용자가 기각했다.
  - `tsc` 나 번들러로 빌드한다. 플러그인은 저장소를 그대로 복사해 설치하므로 빌드 산출물을 커밋해야 하고, 원본과 산출물이 어긋날 수 있다.
  - Bun 이나 Deno 로 돌린다. 설치된 머신이 적고, Claude Code 와 CI 가 이미 Node 를 쓴다.
  - 테스트를 `*.test.ts` 로 둔다. `claude plugin test .` 가 저장소 아래 모든 `*.test.ts` 를 `claude-code/testing` 환경에서 돌리므로 `node:test` 파일과 섞인다. orch 테스트는 `*.spec.ts` 로 둔다.
- **결과**:
  - 얻는 것: 공통 모듈이 한 벌이 된다. 핸들러, 코어, work-board 가 같은 런타임을 쓴다. `node --test` 가 파일마다 프로세스를 나누므로 격리 실행용 러너가 필요 없다.
  - 감당할 것: 타입 제거가 지우는 문법만 쓴다. `enum`, `namespace`, 생성자 매개변수 속성을 쓰지 않고, 상대 import 에 `.ts` 확장자를 적고, 타입만 가져올 때 `import type` 을 쓴다.
  - 감당할 것: Node 22.x 는 타입 제거에 실험 경고를 낸다. 명령과 hook 은 `node --disable-warning=ExperimentalWarning` 으로 부른다.
  - 감당할 것: 다른 저장소의 오버레이와 포장 스크립트가 적은 `python3 .../x.py` 는 shim 이 있는 동안 동작하고 stderr 에 새 명령을 알린다. 다음 major 에서 shim 을 지운다.
- **적용 범위**: 모듈 배치와 실행 규칙은 [`../code-architecture.md`](../code-architecture.md) 의 「orch 코어와 핸들러」 가 소유한다.
