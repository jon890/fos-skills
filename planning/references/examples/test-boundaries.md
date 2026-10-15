# 예시: 테스트와 검증 경계

6단계에서 새 코드와 함께 검사가 앉을 자리를 정할 때, 그리고 8단계에서 phase 의 검증 명령을 적을 때 이 구조를 참고한다.
데이터와 도구가 섞인 저장소를 기준으로 한다. 코드 옆에 `*.test.ts` 를 두는 저장소는 `tests/` 구조를 만들지 않아도 된다.

## 디렉터리는 목적, 파일 이름은 모드

`tests/` 아래 디렉터리가 **무엇을 지키는지**를, 파일 이름이 **언제 도는지**를 정한다.
사람은 목적으로 파일을 찾고 실행기는 이름으로 고른다.

```
tests/
  unit/          함수를 직접 부른다
  boundary/      넘지 않아야 하는 선. 비밀값과 공개 범위
  convention/    저장소 표기 규칙. 파일을 읽어 판정한다
  service/       서비스별 계약
  support/       공통 도구. 직접 돌지 않는다
  manual/        비용이 크거나 운영을 바꾸는 검사. 어느 모드에도 들지 않는다
```

| 이름 | 모드 | 도는 곳 |
| --- | --- | --- |
| `<이름>.test.ts` | static. 파일과 격리된 환경만 본다 | 로컬과 CI |
| `<이름>.live.test.ts` | live. 실제 운영 상태를 읽기만 한다 | 운영 머신. 다른 곳에서는 스스로 건너뛰고 0 으로 끝난다 |

새 목적이 생기면 디렉터리를 더하면 된다. 실행기를 고칠 일이 없어야 한다.

## 이름 규칙으로 찾는다

실행 스크립트에 검사 파일 목록을 들지 않는다. 목록이 있으면 새 검사 파일이 조용히 빠진다.
사용자 저장소 한 곳에서 검사 셋이 실제로 그렇게 빠져 있었다.

```bash
collect_checks() {
  find tests -type f \( -name '*.test.ts' -not -name '*.live.test.ts' \) \
    | grep -v '^tests/manual/' \
    | sort
}
```

- 필요한 실행기가 없으면 그 검사를 건너뛰지 말고 실패로 센다. 건너뛰면 통과로 보고된다.
- 결과를 한 번에 돌리는 진입점은 하나다(`verify` 스크립트나 `pnpm verify`). CI 와 로컬이 같은 진입점을 부른다.

## boundary 테스트

커밋하면 안 되는 파일이 추적되지 않는지를 `git ls-files` 로 검사한다.
작업 트리를 훑으면 `.gitignore` 로 가려진 파일을 놓치고, 추적 대상만 보면 실제로 저장소에 들어가는 것만 검사한다.

```typescript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

describe('추적하면 안 되는 파일', () => {
  it('평문 비밀값 파일이 없다', () => {
    const leaked = tracked.filter((file) => /(^|\/)\.env$/.test(file));
    assert.deepEqual(leaked, []);
  });
});
```

**새 파일을 만들었으면 `git add` 한 뒤에 검사를 돌린다.**
`git ls-files` 는 추적하는 파일만 보므로 add 전의 새 파일은 검사 대상이 아니다. 통과한 결과가 그 파일을 보지 않은 것일 수 있다.
phase 의 검증 절에 이 순서를 명령으로 적는다.

## CI 순서와 concurrency

CI 단계 순서는 로컬 진입점의 순서와 같다. 로컬에서 통과한 것이 CI 에서 다른 순서로 실패하지 않아야 한다.

```
lint → type-check → test → build
```

```yaml
concurrency:
  group: ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      # 액션은 태그가 아니라 커밋 SHA 로 고정하고 뒤에 버전을 주석으로 둔다
      - uses: actions/checkout@<커밋 SHA> # v5
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm type-check
      - run: pnpm test
      - run: pnpm build
```

| 설정 | 이유 |
| --- | --- |
| `concurrency` + `cancel-in-progress` | 같은 PR 에 push 를 여러 번 하면 앞선 실행을 끊어 러너 시간을 아낀다. main 의 실행은 끊지 않는다 |
| `timeout-minutes` | 멈춘 작업이 기본 6시간을 쓰지 않게 한다 |
| 액션을 SHA 로 고정 | 태그는 옮겨질 수 있어, 모르는 사이 다른 코드가 CI 에서 돈다 |
| `--frozen-lockfile` | lockfile 과 다른 버전이 설치되면 실패하게 한다 |

## 새 lint 를 도입할 때

기존 위반은 기준 파일에 두고 새 위반만 실패로 센다.
전체를 한 번에 포맷하는 PR 은 병렬로 열린 모든 PR 과 충돌하므로 하지 않는다.

## 근거

`boundary`, `convention`, `service`, `unit` 의 목적별 디렉터리와 이름 규칙으로 찾는 진입점, `git ls-files` 기반 boundary 검사는 사용자 저장소 한 곳의 구조다.
`test/` 를 목적별 하위 폴더로 나누는 관례는 두 곳에서 확인했다.
CI 의 `lint → type-check → test → build` 순서와 로컬 일치, `concurrency` 와 `timeout-minutes`, 액션의 SHA 고정은 각각 사용자 저장소 한 곳씩의 관례다.
새 lint 의 기준 파일 방식은 사용자 저장소 한 곳의 ADR 이 정했다.
