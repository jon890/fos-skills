# 설계: 머지 관문의 통합 테스트 기록 확인

스펙: [spec.md](spec.md)

## 모듈과 책임

| 자리 | 맡는 일 |
| --- | --- |
| `skills/orch/scripts/core/integration-evidence.ts` | 설정 규칙 읽기(`integrationRules`), 바뀐 파일에서 모듈과 명령 찾기(`integrationNeeds`), PR 본문 판정(`integrationProblems`). 파일과 gh 를 읽지 않는 순수 함수다 |
| `skills/orch/scripts/queue/steps/gate.ts` | 규칙이 있을 때만 바뀐 파일을 REST(`pulls/<n>/files`, 끝까지)로 읽고 판정을 이유(`evidence`)와 생략 줄(notes)로 돌려준다. 관문과 머지 큐가 함께 쓴다 |
| `skills/orch/scripts/queue/gate.ts` | 판정 줄과 이유 줄 뒤에 생략 줄을 낸다 |
| `skills/orch/scripts/queue/steps/merge.ts` | 머지 직전 판정을 통과한 PR 의 생략 줄을 `경고: <PR> 통합 테스트 생략 <모듈>: <이유>` 로 낸다(짧은 출력은 `WARN …`) |
| `skills/orch/templates/spec-common.md` | worker 가 명령을 돌리고 기록 줄을 적는 규칙(`orch-rule: integration-evidence`) |
| `skills/orch/scripts/lib/common-rules.ts` | `integration-evidence` 표지를 조건부로 둔다. 규칙이 없는 저장소의 공통 지시서에 표지가 없어도 spec-lint 가 알리지 않는다 |

## 설정

키는 `queue.integration_tests` 다. 머지 관문만 읽고 머지 큐 옵션으로 바꾸지 않는다(`QUEUE_GATE_KEYS`).
머지 관문이 `queue` 절의 기본값을 이미 읽어, 새 최상위 절을 만들지 않았다.

```json
{
  "queue": {
    "integration_tests": [
      { "paths": "modules/<모듈>/src/main/**", "command": "./gradlew :<모듈>:integrationTest" }
    ]
  }
}
```

- `paths` 는 glob 문자열이나 목록이다. glob 마다 모듈 자리 `<모듈>` 이 꼭 하나 있고, 경로 조각 하나(`[^/]+`)에 맞는다.
- `**` 는 `/` 를 넘는 아무 글자, `*` 는 조각 안의 아무 글자, `?` 는 조각 안의 한 글자다. 경로 전체가 맞아야 한다.
- `command` 의 `<모듈>` 은 모듈 이름으로 바뀐다. 모듈 자리가 없는 명령도 받는다(모듈마다 같은 명령).
- 모듈 자리 표기는 스펙 예시와 같은 `<모듈>` 하나로 정했다. 영문 표기를 함께 받으면 같은 뜻의 표기가 둘이 된다.
- 꼴이 틀리면 `ConfigError` 다. `orch doctor` 는 설정 검사표(`core/config-schema.ts`)로 같은 판정을 `INVALID-CONFIG` 로 알린다.

## 기록 줄

PR 본문의 코드 블록과 HTML 주석 밖만 읽는다. 코드 블록의 닫는 줄은 여는 줄과 같은 글자로 그 길이 이상이고 뒤에 글이 없어야 한다.

| 줄 | 자리 | 꼴 |
| --- | --- | --- |
| 통과 기록 | 「검증」 절(`*`, `_` 를 뺀 제목 글이 `검증` 으로 시작하는 Markdown `#` 제목부터 같거나 높은 단계 제목 앞까지. 밑줄 제목은 받지 않는다) | `통합 테스트 통과: <모듈> \| <명령> \| <40자리 커밋>` |
| 생략 | 본문 어디든 | `통합 테스트 생략: <모듈> <이유>` |

- 두 줄 모두 앞에 목록 표시(`- `, `* `, `+ `, `1. `, `1) `, 체크박스 `[ ] `, `[x] `)를 붙여도 된다. 칸 양끝의 백틱은 벗긴다.
- 명령은 규칙의 명령에 모듈을 넣은 글자와 같아야 한다. 같은 모듈에 규칙이 둘이면 명령마다 기록이 필요하다.
- 커밋은 기능 완료 근거의 검증 커밋처럼 40자리다. 짧은 해시는 받지 않고 `통합 테스트 기록의 커밋이 40자리가 아니다: <모듈>` 로 알린다.
- 이유가 빈 생략 줄은 생략으로 보지 않는다.

## 바뀐 파일

바뀐 파일은 REST(`pulls/<n>/files`)로 페이지 끝까지 읽는다. `gh pr view` 의 `files` 는 100개까지라 쓰지 않는다.
이름을 바꾼 파일은 옛 경로(`previous_filename`)도 본다. 모듈 A 에서 B 로 옮긴 코드는 두 모듈 모두 기록이 필요하다.
REST 도 3000개까지만 돌려주므로 그보다 큰 PR 은 모듈을 놓칠 수 있다. 알려진 한계다.

## 커밋 확인

기록의 커밋이 지금 PR head 와 같으면 통과다.
다르면 기능 완료 근거의 검증 커밋과 같은 예외를 받는다: 그 커밋 뒤에 base 쪽만 들여온 merge 커밋이나 이 PR 계획 폴더만 지운 커밋만 있다(`baseMergesOnly`, `planDeletionOnly`).
머지 큐와 상주 루프가 `update-branch` 로 head 를 바꿀 때마다 worker 가 다시 돌리지 않게 하려는 것이다. 스펙 DECISION2 의 「머지 큐가 다른 검증 기록을 보는 방식과 같다」 를 따른다.

## 출력

| 경우 | 관문 | 머지 큐 |
| --- | --- | --- |
| 기록 없음 | `GATE-FAIL` 아래 `  통합 테스트 기록 없음: <모듈> (<명령>)` | 같은 이유로 worker 에게 보류(`evidence` 종류) |
| 커밋이 40자리가 아님 | `  통합 테스트 기록의 커밋이 40자리가 아니다: <모듈>` | 같음 |
| 커밋이 다름 | `  통합 테스트 기록이 head 가 아니다: <모듈>` | 같음 |
| 생략 | 판정 줄과 이유 줄 뒤에 `통합 테스트 생략 <모듈>: <이유>` | `경고: <PR> 통합 테스트 생략 <모듈>: <이유>` |
| 바뀐 파일 조회 실패 | `  통합 테스트 대상 파일 조회 실패` | 일반 보류(`lookup`) |
| 규칙 없음 | 지금과 같다. 바뀐 파일을 읽지 않는다 | 지금과 같다 |

## 검증

- `skills/orch/tests/core-integration-evidence.spec.ts`: 규칙 꼴, 모듈 찾기, 기록 있음·없음, head 와 다른 커밋, 생략 줄과 빈 이유, 여러 모듈.
- `skills/orch/tests/queue-gate-integration.spec.ts`: 가짜 gh 로 PR 본문과 바뀐 파일을 흉내 내 관문과 머지 큐가 같은 이유로 막고, 생략 줄을 보이고, 규칙이 없으면 바뀐 파일을 읽지 않는지 본다.
