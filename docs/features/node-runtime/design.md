# 스크립트와 테스트를 TypeScript(Node 24) 하나로 옮긴다: 기술 설계

스펙: [spec.md](spec.md). PR 순서는 스펙 「선행 조건과 순서」(DECISION6)가 정한다.
이 설계는 모든 영역 PR 이 함께 지킬 구조와 규칙을 정한다. 영역마다 다른 점은 「영역별 메모」 에 두고, 그 PR 의 계획이 보강한다.

## 요구사항 연결

| ID | 해결 방법 |
| --- | --- |
| REQ1 | 저장소 테스트 `scripts/tests/runtime-policy.spec.ts` 가 추적 파일에서 `.py` 와 python shebang 을 찾는다. PR1 은 지금 남은 파일을 허용 목록(`scripts/runtime-policy.json` 의 `pending`)에 적고, 영역 PR 마다 그 영역 줄을 지운다. 마지막 PR 에서 `pending` 이 비고 옛 이름 진입 셋만 `legacy` 로 남는다 |
| REQ2 | 같은 테스트가 `.sh`, `.bash`, `.zsh` 와 셸 shebang 을 찾는다. git 훅은 「진입 파일」 절의 확장자 없는 JS 진입으로 바꾸고, 임시 저장소 테스트가 `install-hooks.ts` 로 건 훅이 `git commit` 에서 도는지 본다 |
| REQ3 | 「동등성 확인」 절의 두 커밋 방식과 공통 꼴 모듈(`kit`)로 stdout, 쓰는 파일, 종료 코드를 맞춘다 |
| REQ4 | 영역 PR 이 그 영역 문서의 호출을 「호출 꼴」 절대로 같은 커밋에서 바꾼다. 기존 `scripts/tests/test_doc_script_refs.py`(PR2 에서 `doc-script-refs.spec.ts`)가 문서가 부르는 스크립트의 존재를 본다. `runtime-policy.spec.ts` 가 이행을 마친 영역의 문서에 `python3 `, `bash "$SKILL_DIR` 꼴이 남으면 실패한다 |
| REQ5 | 「CI」 절. 테스트 실행기가 `tests/` 아래 node 테스트를 스스로 찾고, `test_*.py` 가 없는 폴더는 Python 묶음에서 뺀다. PR11 에서 테스트 실행기의 Python 부분을 지운다(스펙 DECISION22) |
| REQ6 | 「옛 이름 진입」 절. 같은 이름의 node shebang JS 가 새 `.ts` 를 import 한다. 훅 모드의 안내는 DECISION18 대로 `additionalContext` 에 붙인다 |
| REQ7 | 영역 PR 의 계획이 스펙 「다른 저장소의 옛 호출」 의 그 영역 행을 머지 조건 뒤의 후속 작업으로 갖는다. 코디네이터가 orch worker 로 고친다 |
| REQ8 | 「팀 저장소」 절. PR11 머지 뒤 팀 PR 하나 |
| REQ9 | PR1 이 새 ADR 과 `docs/code-architecture.md` 의 저장소 전체 「실행 규칙」 을 쓰고, `runtime-policy.spec.ts` 가 허용 목록 밖의 새 파일을 이름과 함께 낸다 |
| REQ10 | PR2 가 `scripts/check-shell-korean.py`, `scripts/samples/`, README 의 두 줄을 지운다 |

## 책임과 경계

### 스킬은 자기 폴더 안만 import 한다

내보내는 스킬은 팀 저장소에서 다른 배치로 놓인다. `korean-check`, `content-preview` 는 팀의 `plugins/nhn-dev/skills/` 안에, `plan` 같은 스킬은 팀 루트 `skills/` 에 있다(AiSdtSkill 2026-11-05 확인).
플러그인 설치 캐시는 플러그인 루트 밖을 갖지 않는다. 그래서 스킬의 `.ts` 가 `../../tools/` 나 다른 스킬을 import 하면 팀 쪽에서 깨진다.
지금 Python 도 스킬 폴더 밖을 import 하지 않는다. 이 경계를 그대로 둔다.

- 스킬(`skills/<이름>`, `export-only-skills/<이름>`)과 도구(`tools/<이름>`)의 `.ts` 는 자기 폴더와 Node 내장 모듈만 import 한다.
- 다른 스킬의 명령이 필요하면 지금처럼 자식 프로세스로 부르고, 경로는 지금의 탐색 순서(환경 변수, 형제 디렉터리, 개인 링크)를 그대로 옮긴다. 예: `content-preview` 가 `korean-check` 를 찾는 순서([code-architecture.md](../../code-architecture.md) 「스킬 사이의 경로 참조」).
- `scripts/` 와 `githooks/` 는 저장소 관리 영역이라 `scripts/` 와 `modules/` 아래를 import 해도 된다. 팀으로 나가지 않는다.
- 저장소 안의 공용 코드는 `modules/` 한 곳에 둔다. 실행용은 `modules/kit/`, 테스트용은 `modules/testkit/` 이다(DECISION2, DECISION3).

### 공통 꼴 모듈 `kit`

옛 Python 과 같은 바이트를 내는 helper 가 영역마다 필요하다. 옵션의 고유 접두 펼치기(DECISION20), `json.dumps` 꼴(DECISION19), `shlex.quote` 가 그것이다.
orch 가 이미 `skills/orch/scripts/lib/args.ts`, `lib/py.ts` 로 같은 일을 한다. 그러나 위 경계 때문에 다른 스킬이 그것을 import 할 수 없다.

- 원본은 `modules/kit/` 한 곳이다. 처음 쓰는 PR2 가 orch 의 두 파일에서 orch 전용 import(`./bundle.ts`)를 뺀 꼴로 만들고, `docs/code-architecture.md` 의 배치 표에 `modules/kit/` 을 더한다.
- `kit` 은 orch `lib/py.ts` 의 상위 집합이다. `pyJson` 에 `json.dumps` 의 `indent`, `ensure_ascii` 선택을 더한다. 옛 명령이 쓰던 꼴(들여쓴 JSON, `\u` 이스케이프)을 내야 하는 영역이 처음 필요할 때 그 PR 이 더한다. 같은 이름의 함수가 orch 와 `kit` 에서 같은 입력에 같은 글자를 내는지 `kit-copies.spec.ts` 가 함께 본다.
- `kit` 은 정규식을 실행 중에 바꾸는 함수를 갖지 않는다. 옮길 때 사람이 정규식을 고치는 기준은 아래 「동등성 확인」 의 표다. orch 의 `pyRegExp`(옵션으로 받은 정규식 글자를 바꾸되 `\w` 같은 글자는 그대로 둔다)는 orch 에만 남는다.
- 스킬과 도구는 원본을 `<단위>/scripts/kit/` 에 복사해 둔다. 복사본은 필요한 파일만 가진다.
- `scripts/tests/kit-copies.spec.ts` 가 모든 복사본이 원본과 바이트까지 같은지 본다. 원본을 고치면 `scripts/sync-kit.ts` 로 복사본을 맞춘다. 다르면 테스트가 파일 이름과 함께 실패한다.
- orch 의 `lib/args.ts`, `lib/py.ts` 는 이번에 바꾸지 않는다. orch 구조 개편이 lib 를 다룰 때 `kit` 로 합칠지 정한다.

복사를 고른 이유와 기각한 안은 「결정」 의 DECISION2 에 있다.

### 공통 testkit

테스트 helper(임시 git 저장소 템플릿, 가짜 실행 파일 재사용, 명령 실행)는 fos-test-speed 가 만드는 testkit 을 쓴다(스펙 DECISION5). 자리는 `modules/testkit/` 이다(사용자 2026-11-05).
같은 경계가 테스트에도 걸린다. 팀 CI 는 내보낸 스킬의 `tests/` 를 팀 저장소 안에서 돈다. 그래서 내보내는 스킬의 테스트는 orch 의 `tests/fixtures/` 도, `modules/testkit/` 도 import 할 수 없다.

- testkit 은 이 저장소의 테스트만 쓰고 팀에 싣지 않는다(사용자 2026-11-05). 복사본도 두지 않는다.
- 내보내지 않는 영역(`scripts/`, `mac-cleanup`, `harness-cleanup`, `report`, `browser`, `pr-review`)의 테스트는 `modules/testkit/` 을 import 한다.
- 팀으로 내보내는 스킬의 테스트는 Node 내장 모듈만 쓴다. 필요한 helper 는 그 테스트 파일 안에 둔다.
- PR1 은 테스트 helper 를 쓰지 않는다. 그래도 시작 시점은 스펙 DECISION5 대로 testkit 머지 뒤다. 이 기능이 testkit 을 따로 만들지 않는다. 같은 helper 가 두 벌 생긴다.
- 복사본 대조에 쓰는 `kit` 원본 위치(`modules/kit/`)는 처음 복사하는 PR 이 `scripts/runtime-policy.json` 의 `kit_sources` 에 적는다.

### browser-driver 를 browser 스킬 안으로 옮긴다

사용자가 2026-11-05 보드 `browser-driver-placement` 에서 정했다(DECISION13). 옮기는 일은 영역 10(PR10)이 한다.

- PR10 이 `tools/browser-driver/` 를 `skills/browser/browser-driver/` 로 옮긴다. 폴더 안의 배치(`browser_driver.py`, `driver/`, `tests/`, README)는 그대로 둔다. 내보내기가 폴더 하나를 팀 경로로 옮기면 되고, 이동 커밋이 경로 앞부분만 바꾼다.
- PR10 의 커밋 순서는 다음과 같다. 이동을 먼저 끝내야 옛 구현과 새 구현을 같은 자리에서 비교할 수 있다(REQ3).
  1. 이름만 바꾸는 이동(`git mv`). 내용을 고치지 않아 git 이 이력을 잇는다. 이 커밋에서는 부르는 쪽이 아직 옛 자리를 가리킨다. 다음 커밋과 함께 머지되므로 PR 머지 기준으로는 깨지지 않는다.
  2. 아래 깨지는 곳을 새 자리로 고친다.
  3. 이후는 「동등성 확인」 의 두 커밋 방식이다. 명령 경계 테스트가 처음에는 새 자리의 옛 `.py` 를 가리킨다.
- 2026-11-05 조사로 찾은 깨지는 곳이다. 앞 영역 PR 이 옮긴 파일은 `.ts` 이름으로 바뀌어 있다. PR10 은 머지 전에 `git grep -n 'tools/browser-driver'` 를 다시 돌려 이 목록을 갱신한다.
  - `driver/config.py` 41~45줄: 플러그인 캐시 안의 경로를 `tools/browser-driver/driver` 깊이로 판정한다. 새 자리는 경로 조각이 하나 더 많다.
  - `skills/browser/SKILL.md` 64줄: 드라이버 후보 `$SKILL_DIR/../../tools/browser-driver/browser_driver.py`
  - `export-only-skills/content-preview/scripts/show-preview.sh` 54줄: 위로 올라가며 `tools/browser-driver/` 를 찾는다
  - `skills/presentation/scripts/check-deck.py` 163줄
  - `scripts/export-to-team.sh` 의 `SHARED_TOOLS` 와 `tools/` 접두
  - `scripts/test-plugin-install.sh` 224줄: 캐시의 `tools/browser-driver/browser_driver.py` 실행 권한
  - `~/.claude/scripts/browser-driver` 링크. README 「링크로 설치」 의 `ln` 줄과 `docs/code-architecture.md` 의 드라이버 찾는 순서·링크 행을 새 자리로 고친다. 사용자의 개인 링크는 REQ7 과 같이 머지 뒤 후속 작업으로 바꾼다
- 팀 사본 자리는 `tools/browser-driver` 로 고정한다. 내보내기가 원본 경로(`skills/browser/browser-driver/`)와 팀 경로(`tools/browser-driver/`)를 나눠 갖는다. `browser` 스킬은 내보내지 않으므로 드라이버 폴더만 팀 경로로 싣는다. 그래서 팀 래퍼와 팀 테스트의 경로는 그대로이고, 본체 이름만 마지막 팀 PR 이 바꾼다(「팀 저장소」 절).
- 옛 이름 진입 `browser_driver.py` 는 옛 자리 `tools/browser-driver/browser_driver.py` 에 둔다. 개인 링크와 저장소 밖 호출이 이 경로를 부른다. 이 진입은 새 자리의 `.ts` 를 import 한다. DECISION1 의 경계 밖이지만 내보내지 않는 진입이고, 플러그인 캐시는 저장소 루트 전체를 가져 경로가 깨지지 않는다. 팀 사본에도 옛 이름 진입이 필요한지는 PR10 의 계획이 팀 저장소를 다시 찾아 정한다.
- `tools/` 폴더는 DECISION17 의 major(이 저장소 다음 major)에 옛 이름 진입과 함께 지운다. 그 PR 이 이 설계의 「도구(`tools/<이름>`)」 경계 문구도 지운다. 테스트 실행기는 `tests/` 아래를 스스로 찾으므로 CI 는 고치지 않는다.
- ADR-021 과의 관계: ADR-021 은 「스킬 전용 코드는 소유 스킬 안에 둔다」 이다. browser-driver 는 `browser`, `content-preview`, `presentation` 이 함께 쓰지만 소유자는 `browser` 스킬 하나다. `browser` 스킬이 드라이버의 사용 절차와 공간 분리·로그인 규칙을 갖고, 드라이버의 변경 이력도 `browser` 스킬의 CHANGELOG 에 적는다(스펙 DECISION17). 나머지 둘은 드라이버를 import 하지 않고 자식 프로세스로 부른다(DECISION1). 그래서 `browser` 스킬 안에 두는 것이 ADR-021 의 소유 스킬 규칙에 맞는다. 다른 단위가 import 해야 하는 공용 코드였다면 `modules/` 의 몫이다.

### 진입 파일

| 종류 | 꼴 | 근거 |
| --- | --- | --- |
| 명령 | `<이름>.ts`. 첫 줄 `#!/usr/bin/env node`, 실행 권한. 이름은 옛 파일의 확장자만 바꾼다(`korean-style-check.ts`, `check_feature.ts`) | 스펙 REQ3 은 옵션과 출력만 지키지만, 이름을 바꾸지 않아야 문서와 다른 저장소 호출의 바꿀 곳이 확장자 하나다 |
| git 훅 | `githooks/<훅 이름>`. 확장자 없는 node shebang JS 가 `fs.realpathSync(__filename)` 기준으로 `githooks/<훅 이름>.ts` 를 `import()` 한다. 타입 문법은 `.ts` 에만 둔다 | git 은 정해진 이름만 실행한다. node 는 확장자 없는 파일의 타입을 지우지 않는다. `.git/hooks` 의 링크로 불려도 realpath 기준이라 원본 옆의 `.ts` 를 찾는다(2026-11-05 실험). orch 가드 shim 과 같은 꼴이다 |
| 옛 이름 진입 | `korean-style-check.py`, `check-readability.py`, `browser_driver.py` 자리에 같은 꼴의 node shebang JS. `browser_driver.py` 는 옮기기 전 자리 `tools/browser-driver/` 에 둔다. 「옛 이름 진입」 절 | 스펙 DECISION3 |
| orch doctor | 새 진입을 두지 않는다. 지금 doctor 는 `orch doctor` 로 불리고, 플러그인 `bin/orch` 실행기가 이미 `NODE-TOO-OLD` 를 낸다(`bin/orch` 33줄, 92줄). 옛 진입 `orch-doctor.py` 와 `ts_shim.py` 는 orch-cli 의 옛 이름 정리 PR(그 스펙의 DECISION13)이 지운다 | 스펙 DECISION14. 옛 이름을 끝내는 때는 orch-cli 스펙이 소유한다. 이 기능이 먼저 지우면 그 결정과 겹친다 |

JS(`.js`, `.mjs`, `.cjs`, 확장자 없는 JS)는 타입 제거가 닿지 않는 진입에만 쓴다. 새 ADR 이 이 예외를 적고 `runtime-policy.spec.ts` 가 목록(`entry_js`) 밖의 `.js`, `.mjs`, `.cjs` 를 막는다. 이미 있는 JS(work-board 의 hooks 모듈, orch 가드 shim, 플러그인 `bin/orch`)는 PR1 이 그 목록에 적는다.

최소 Node 버전은 여러 진입이 각자 본다(`bin/orch` 의 `MIN_NODE`, 옛 이름 진입). 서로 import 할 수 없어(위 경계) 값의 원본은 `scripts/runtime-policy.json` 의 `min_node` 로 두고, `scripts/runtime-policy.ts` 가 `const MIN_NODE = [<major>, <minor>]` 꼴의 줄을 모두 찾아 그 값과 같은지 본다. 지금 `bin/orch` 와 `ts_shim.py` 를 대조하는 `skills/orch/tests/orch-launcher.spec.ts` 의 사례는 `ts_shim.py` 가 지워질 때 이 검사로 넘어간다.

### 호출 꼴

문서와 명령이 새 스크립트를 부르는 꼴은 하나로 둔다.

```bash
node "$SKILL_DIR/scripts/<이름>.ts" <인자>
```

- 실행 권한과 shebang 이 있어 직접 실행도 되지만 문서는 `node` 를 적는다. 실행 권한이 빠진 복사(팀 내보내기 뒤 일부 환경, Windows 체크아웃)에서도 돈다.
- Node 24.22 는 타입 제거에 경고를 내지 않는다(스펙 실측). 그래서 `--disable-warning=ExperimentalWarning` 은 새 호출에 붙이지 않는다. 낮은 node 에서 경고가 섞이는 것은 DECISION15 의 「안내 없이 실패해도 된다」 에 든다. orch 의 기존 호출은 바꾸지 않는다.
- 셸 파이프와 리다이렉트로 하던 일(`check.sh` 가 두 검사기를 합치던 것)은 `.ts` 안에서 한다.

## 인터페이스와 데이터

### 저장소 정책 파일 `scripts/runtime-policy.json`

PR1 이 만든다. 키의 정확한 뜻과 판정은 명령 `scripts/runtime-policy.ts` 의 머리 주석이 소유한다. 이 설계는 뜻만 정한다.

| 키 | 뜻 | 바뀌는 때 |
| --- | --- | --- |
| `pending` | 아직 옮기지 않은 `.py`, `.sh`, 셸·python shebang 파일. 영역 단위로 묶는다 | 영역 PR 이 자기 묶음을 지운다. PR11 에서 빈다 |
| `legacy` | 옛 이름 진입 셋 | 옮긴 영역 PR 이 더하고, DECISION17 의 다음 major PR 이 지운다 |
| `entry_js` | 허용하는 `.js`, `.mjs`, `.cjs`, 확장자 없는 JS | 진입이 생기거나 없어질 때 |
| `migrated_docs` | 문서 호출 검사를 켤 영역 | 영역 PR 이 자기 영역을 더한다 |
| `kit_sources` | `kit` 원본 위치(`modules/kit/`). testkit 은 복사하지 않아 적지 않는다 | 처음 복사하는 PR 이 더한다 |
| `min_node` | 진입들이 보는 최소 Node 버전 | ADR-011 을 바꿀 때 |

### 동등성 확인

스펙 DECISION11 의 두 커밋 방식을 영역 PR 마다 이렇게 한다.

1. 첫 커밋: 명령 경계 테스트를 `<단위>/tests/<명령>.spec.ts` 로 쓴다. 테스트는 명령 경로를 파일 머리의 상수 하나에서 읽고, 그 상수가 옛 `.py`(또는 `.sh`)를 가리킨다. 옛 Python 테스트는 그대로 둔다. 이 커밋에서 새 테스트와 옛 테스트가 모두 통과한다.
2. 둘째 커밋 이후: `.ts` 구현을 쓰고 상수를 `.ts` 로 바꾼다. 같은 명령 경계 테스트가 고치지 않은 채 통과해야 한다. 내부 함수 테스트는 구현과 함께 옮기고, 옮긴 Python 테스트와 옛 구현을 지운다.
3. PR 본문에 두 커밋 SHA 와 각 커밋에서 돌린 명령 경계 테스트의 결과 줄을 적는다.

명령 경계 테스트가 볼 것은 옵션(접두 줄임, `--opt=value`, 사용법 오류 2 포함), stdout 바이트, 명령이 쓰는 파일의 바이트, 종료 코드다. stderr 는 문서나 다른 코드가 읽는 문구만 본다.
옛 Python 테스트가 subprocess 로 보던 사례는 모두 명령 경계 테스트로 옮긴다. 내부 함수만 보던 사례는 명령 경계로 관측되면 거기로, 아니면 내부 함수 테스트로 옮긴다.

정규식 중심 검사기는 하나를 더 한다. 둘째 커밋 뒤 저장소의 실제 입력 묶음을 옛 명령과 새 명령에 하나씩 돌려 stdout 과 종료 코드가 같은지 비교한다. 비교 스크립트는 세션 임시 폴더에 두고 결과 요약(입력 수, 다른 입력 0)을 PR 본문에 적는다.

| 검사기 | 입력 묶음 |
| --- | --- |
| `korean-style-check`, `check-readability` | `git ls-files '*.md'` 의 파일 하나씩, 그리고 `--hook` 모드에 같은 파일의 편집 JSON |
| `check-diff` | 임시 저장소에 이 저장소의 최근 커밋 몇십 개를 하나씩 적용한 각 diff |
| `check_feature` | `docs/features/*/spec.md` 하나씩, `design.md` 가 있으면 `--design` 과 함께 |
| `verify_task` | 저장소와 git 이력에 있는 계획 폴더 하나씩(`--require-verification` 있고 없고) |
| `run_doc_checks` | `check_feature` 와 같은 스펙 묶음 |

두 엔진의 뜻이 다른 글자는 옮길 때 같은 뜻의 명시 문자 클래스로 바꾼다. Python 3 의 `\w`, `\d`, `\b` 는 한글과 유니코드 숫자를 글자로 보고, JS 는 `u` 플래그에서도 ASCII 만 본다. 예: `\w` 는 `[\p{L}\p{N}_]`(`u` 플래그)로 바꾼다. `\s` 는 두 엔진 모두 유니코드 공백이라 그대로 둔다(2026-11-05 실험).

### 옛 이름 진입

- 같은 이름의 node shebang JS 다. 새 `.ts` 가 export 한 함수를 import 해 부른다. `.ts` 는 명령으로 실행될 때만(`import.meta.main`) 스스로 돈다. 그래야 진입이 import 해도 두 번 돌지 않는다. orch 가드 shim 이 `guard.ts` 의 `main()` 을 받아 부르는 꼴과 같다.
- 새 `.ts` 가 내보낼 함수: `main(argv): Promise<number>`(일반 모드, stdout 에 직접 쓰고 종료 코드를 돌려준다)와, 훅이 있는 korean-check 둘은 `runHook(input): object | null`(훅이 낼 JSON 을 돌려주고 쓰지는 않는다. 없으면 `null`).
- 일반 모드: 진입은 `main` 을 그대로 부른다. korean-check 둘의 출력(stdout, stderr, 종료 코드)은 새 명령과 같다(스펙 DECISION18 「일반 명령 모드의 출력은 그대로다」). `browser_driver.py` 는 훅이 없어 stderr 에 `DEPRECATED browser_driver.py → node <새 경로>` 한 줄을 더한다. stdout 과 종료 코드는 같다.
- 훅 모드(`--hook`, korean-check 둘): 진입이 `runHook` 의 결과를 받는다. 발견이 있으면(`null` 이 아니면) `additionalContext` 맨 앞에 「이 훅 경로는 다음 major 에 없어진다. 새 명령: node <새 경로> --hook」 한 줄을 붙여 쓴다. 발견이 없으면 아무것도 쓰지 않는다(새 명령과 같다). 스펙 DECISION18.
- Node 가 `min_node` 보다 낮으면 진입은 `.ts` 를 import 하지 않는다. 훅 모드는 「Node 24 이상이 필요해 한국어 검사를 건너뛰었다」 한 줄을 `additionalContext` 로 내고 0 으로 끝난다. 이것은 발견 유무와 무관하게 매번 낸다. 검사가 실제로 멈춘 상태라 알려야 한다. 일반 모드는 같은 문장을 stderr 에 내고 127 로 끝난다(`bin/orch` 의 꼴).
- 버전 확인은 진입이 직접 `process.versions.node` 로 한다(DECISION14 와 같다).
- 지우는 시점은 스펙 DECISION17 이다. 지우는 PR 이 `legacy` 를 비운다.

### CI

CI 는 `Tests` job 하나가 테스트 실행기 `scripts/run-tests.ts` 를 옵션 없이 부른다(fos-test-speed, #355). 실행기가 git 의 파일 목록에서 `tests/` 아래 `*.spec.ts` 를 모두 찾고, `test_*.py` 를 가진 `tests` 폴더만 Python 묶음으로 돈다. 그래서 PR1 은 `ci.yml` 을 고치지 않는다. 처음 설계는 CI 에 폴더 패턴 다섯을 두고 Python 루프가 빈 폴더를 건너뛰게 바꾸려 했으나, 실행기가 먼저 머지돼 같은 결과를 이미 낸다(2026-11-06 PR1 착수 때 확인).

- 영역을 옮기거나 폴더 자리를 바꿔도(PR10 의 `skills/browser/browser-driver/tests` 포함) 테스트 묶음 때문에 CI 나 실행기를 고치지 않는다. 테스트 묶음의 원본은 실행기 머리 주석이다.
- 타입 검사의 `tsconfig.json` 은 실행 코드를 본다. 영역 PR 이 처음 `.ts` 를 들일 때 `include` 에 `<단위>/scripts/**/*.ts` 와 진입 `.ts`(`githooks/*.ts`)를 더한다. 테스트 폴더는 지금처럼 넣지 않는다. `extensions/work-board/tests/*.test.ts` 가 `claude-code/testing` 을 import 해 검사가 깨진다.
- PR11 이 테스트 실행기의 Python 부분을 지운다(스펙 DECISION22). 머지 조건의 job 이름은 `Tests` 다. `jq` 설치도 함께 없어진다. `zsh` 는 `harness-cleanup` 의 문서 코드 블록 실행(`run_doc_snippets`, bash 와 zsh 양쪽에서 돈다)이 쓴다. PR8 이 그 테스트를 옮길 때 `zsh` 설치가 계속 필요한지 본다.
- `plugin-version.yml` 은 PR2 가 고친다. `python3` 두 줄을 `node` 로 바꾸고(스펙 DECISION16), `actions/setup-node` 의 `node-version: '24'` 단계를 더한다. 지금은 setup-node 가 없어 runner 기본 node 로 돈다. 이 workflow 는 main push 에서만 돌아 PR CI 로 미리 잡히지 않는다.

### 팀 저장소

스펙 DECISION7, DECISION10 을 따른다. 팀 저장소 일은 코디네이터가 orch worker 로 맡긴다.

- `team-export` 브랜치: PR1 을 머지하기 직전 코디네이터가 그때의 `origin/main` 에서 만들어 push 한다. SHA 를 보드 항목에 적는다. 이행 중 급한 수정은 main 과 이 브랜치에 함께 넣고 `export-to-team --apply --source-ref team-export` 로 낸다. PR2 이후의 내보내기 명령은 TypeScript 지만 `--source-ref` 로 고른 커밋의 Python 사본을 그대로 복사하므로 이 경로가 계속 돈다.
- 마지막 팀 PR(PR11 머지 뒤)이 바꾸는 것: 내보내기 결과 전체, `validate.yml` 의 내보낸 스킬 줄(`python3 -m unittest discover -s ...` 를 `node --test` 패턴으로), runner 의 Node 24, `plugins/nhn-dev/bin/browser-driver` 가 부르는 본체 이름과 그 안의 `python3 -c` JSON 읽기, 팀 README 의 「Node.js 20 이상」, 팀 변경 이력. PR 본문이 팀원에게 바뀐 명령과 korean-check 훅 경로를 알린다.
- 팀이 소유한 파일 가운데 옛 이름을 부르는 곳도 그 팀 PR 이 고친다. 2026-11-05 에 찾은 것:
  - `plugins/nhn-dev/bin/browser-driver` 11줄, `plugins/nhn-dev/bin/nhn-dev-doctor` 498줄, `tests/plugin/test_bin_wrappers.py` 105줄: `browser_driver.py`
  - `plugins/nhn-dev/skills/grm/SKILL.md` 109줄, `plugins/nhn-dev/skills/grm/scripts/preview.py` 7줄, `tests/plugin/test_grm_skill.py` 36줄: `show-preview.sh`
  - `tests/plugin/test_ai_sdt_layout.py` 119-132줄, `scripts/test-plugin-install.sh` 218-281줄: `style-check.sh`, `browser_driver.py`
  - `docs/code-architecture.md`, `docs/flow.md` 의 `style-check.sh`, `show-preview.sh`, `browser_driver.py` 설명
  팀 PR 을 띄울 때 팀 저장소 전체에 옛 이름을 `git grep` 해 이 목록을 갱신한다.
- 팀 자체 구현 언어(팀 스킬과 팀 `scripts/` 의 Python, 팀 `create-pr` 의 `pr_mergeable.sh` 사본)는 바꾸지 않는다(스펙 범위 밖). 위 목록처럼 옛 이름을 부르는 줄만 고친다.

## 실패와 일관성

- 한 영역 PR 은 그 영역의 구현, 테스트, 문서 호출, `runtime-policy.json` 의 줄을 함께 바꾼다. 그래서 main 의 어느 커밋을 설치해도 문서가 부르는 파일이 있다. `doc-script-refs` 테스트가 이를 본다.
- 다른 영역이 부르는 명령을 옮기면 부르는 쪽도 같은 PR 에서 고친다. 영역 PR 은 머지 전에 옮긴 옛 이름마다 `git grep -n '<옛 이름>'` 을 코드, 테스트, 문서 전체에 돌려 남은 곳을 고치거나 다음 영역의 몫으로 PR 본문에 적는다. 2026-11-05 에 알려진 곳:
  - `review-fix/scripts/review_threads.py` 를 orch 의 `merge_queue.ts`(610줄 근처), `orch-loop.ts`(2116줄 근처)가 `python3` 로 부른다. PR4 가 `node` 와 `.ts` 로 바꾼다. orch 구조 개편 뒤 줄 번호는 바뀐다.
  - `githooks/commit-msg` 가 korean-check 검사기를, `content-preview/scripts/style-check.sh` 가 `korean-check/scripts/check.sh` 를 부른다. 부르는 쪽(PR2, PR5)이 먼저 옮겨져도 그때는 옛 검사기를 옛 꼴로 부르고, PR6 이 부르는 쪽까지 새 꼴로 바꾼다.
  - `plan` 의 검사기를 spec, technical-design, implementation, review-fix 문서가 부른다. PR7 이 그 문서들의 호출을 함께 바꾼다.
  - `scripts/test-plugin-install.sh`(PR2 에서 `.ts`)가 `style-check.sh --where`, `browser_driver.py` 의 실행 권한, `verify_task.py --help` 를 본다. PR5, PR7, PR10 이 그 줄을 함께 고친다.
  - `scripts/tests/test_export_to_team.py`(PR2 에서 `.spec.ts`) 109줄이 `skills/plan/tests/test_verify_task.py` 의 바이트를 fixture 로 읽는다. PR2 가 옮길 때 fixture 를 테스트 안의 내용으로 바꿔 다른 영역 파일에 기대지 않게 한다.
  - `skills/browser/tests/test_skill_doc.py` 22~23줄이 `browser_driver.py` 경로를 본다. PR3 가 옮기고 PR10 이 경로를 바꾼다.
  - `skills/orch/tests/legacy-entrypoints.spec.ts` 가 orch 의 `.py`, `.sh` 를 따로 막는다. `runtime-policy.spec.ts` 와 같은 사실을 둘이 갖게 되므로 PR1 이 이 파일을 지우고, `orch-doctor.py` 와 `ts_shim.py` 는 `pending` 의 `orch-legacy` 영역으로 둔다. 그 영역은 orch-cli 의 옛 이름 정리 PR 이 지운다.
- 플러그인을 이행 중간에 갱신한 쪽은 그 커밋의 상태를 받는다. 각 커밋에서 호출과 파일이 맞으므로 따로 할 일이 없다.
- 영역 PR 의 `호환성:` 항목은 그 스킬을 major 로 올린다(ADR-023). major 는 조각이 아니라 PR 이 `metadata.version` 과 CHANGELOG 를 직접 올린다. `tools/browser-driver` 는 버전이 없어 `browser` 스킬의 CHANGELOG 에 적는다(스펙 DECISION17).
- 같은 파일을 만지는 다른 기능: orch 구조 개편이 끝난 뒤 시작하므로(스펙 DECISION5) PR4 는 옮겨진 폴더의 경로를 쓴다. testkit 을 실제로 쓰는 것은 PR2 부터지만, 스펙 DECISION5 대로 PR1 도 testkit 과 orch 폴더 이동이 main 에 들어온 뒤 시작한다.

## 검증 전략

| ID | 어디서 확인하나 |
| --- | --- |
| REQ1, REQ2, REQ9 | `runtime-policy.spec.ts`. 허용 목록 밖의 파일을 하나씩 더한 임시 사본에서 그 파일 이름으로 실패하는지 본다. PR11 에서 `pending` 이 빈 채로 통과한다 |
| REQ2 의 훅 | 임시 저장소에 `install-hooks.ts` 로 훅을 걸고 금지어 메시지 커밋이 막히는지, 공용 스킬 파일 커밋에서 알림이 나는지 본다(기존 `test_commit_msg_hook.py`, `test_post_commit_hook.py` 를 명령 경계 테스트로 옮긴다) |
| REQ3 | 영역 PR 마다 두 커밋의 명령 경계 테스트 결과와, 정규식 중심 검사기의 문서 전체 비교 |
| REQ4 | `doc-script-refs.spec.ts` 와 `runtime-policy.spec.ts` 의 `migrated_docs` 검사 |
| REQ5 | 각 PR 의 CI. Python 테스트가 없는 폴더가 생겨도 `Tests` job 이 통과한다 |
| REQ6 | 옛 이름 진입마다 명령 경계 테스트. korean-check 둘의 일반 모드 결과가 새 명령과 바이트까지 같다. `browser_driver.py` 는 stdout 과 종료 코드가 같고 stderr 에 안내가 있다. 훅 모드는 발견이 있을 때 `additionalContext` 첫 줄이 안내이고, 발견이 없으면 출력이 없다. 낮은 node 흉내(`--import` 로 `process.versions.node` 를 `Object.defineProperty` 로 덮은 실행. 단순 대입은 무시된다)에서 건너뛰기 안내가 나온다 |
| REQ7 | 영역 PR 머지 뒤 코디네이터가 그 영역 행의 저장소 커밋을 PR 마무리 근거에 적는다 |
| REQ8 | 마지막 팀 PR 의 팀 CI 결과와 README diff |
| REQ10 | PR2 의 diff 와 `git ls-files scripts/samples` 가 빈 것 |

인수 검증은 영역 PR 마다 그 계획의 `verification-plan.md` 가 정한다. 공통 사례는 위 표다.

## 영역별 메모

뒤 PR 의 계획이 보강한다. 여기에는 지금 알아 둔 함정만 적는다.

| PR | 영역 | 메모 |
| --- | --- | --- |
| 1 | 저장소 기반 | ADR-010, ADR-011 의 적용 범위를 저장소 전체로 넓히는 결정이다. `legacy-entrypoints.spec.ts` 를 지우고 `orch-legacy` 영역을 둔다 |
| 2 | `scripts/`, `githooks/` | `plugin-version.yml` 의 setup-node 24. `export-to-team.sh` 의 Python heredoc 과 `skill_paths.py` 를 함께 옮긴다. `bump-plugin-version.py` 는 main push 에서만 돌아 PR CI 로 실제 동작을 보지 못하므로 명령 경계 테스트를 임시 저장소로 넉넉히 둔다. `test-plugin-install.sh` 는 `claude` CLI 가 필요하다. `kit` 원본을 여기서 만든다 |
| 3 | 작은 스킬 묶음 | orch 의 두 `.py` 는 들지 않는다(`orch-legacy`). `skills/browser/tests/test_skill_doc.py` 의 `browser_driver.py` 경로 확인을 옮긴다 |
| 4 | `review-fix` | `fold_fixup.sh` 는 git 상태를 바꾸는 명령이라 임시 저장소 테스트만 쓴다 |
| 5 | `content-preview` | `show-preview.sh` 는 browser-driver 를 부른다. 드라이버는 아직 Python 이라 옛 꼴로 부른다 |
| 6 | `korean-check` | 옛 이름 진입 둘이 여기 생긴다. 훅 모드 JSON 의 바이트 꼴(`ensure_ascii`)을 맞춘다. README 의 링크와 훅 안내를 새 이름으로 바꾼다(스펙 DECISION21) |
| 7 | `plan` | `plan_number.sh` 는 원격 브랜치를 읽는다. 다른 문서가 가장 많이 부르는 영역이다 |
| 8 | `harness-cleanup` | 다른 저장소의 `.py`, `.sh` 를 감사하는 판정은 그대로 둔다. 감사 대상 확장자 목록을 옮기며 바꾸지 않는다. `run_doc_snippets` 가 zsh 를 쓰므로 `Plugin tests` job 에 zsh 설치를 옮긴다 |
| 9 | `mac-cleanup` | 테스트 대부분이 내부 함수 테스트다. 명령 경계로 관측되는 사례부터 옮긴다. `survey_gradle.sh` 는 읽기 전용이다 |
| 10 | `tools/browser-driver` | 백엔드 넷(ego, orca, cmux, agent_browser)과 `install` 이 거는 링크. 먼저 `skills/browser/browser-driver/` 로 이름만 바꾸는 이동을 하고 옮긴다. 커밋 순서와 깨지는 곳은 「browser-driver 를 browser 스킬 안으로 옮긴다」 |
| 11 | 마무리 | Python job 삭제, `pending` 비우기, README 와 `docs/code-architecture.md` 의 남은 `python3` 줄 정리 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 스킬과 도구의 import 범위 | 자기 폴더와 Node 내장 모듈만 | 작성자 | 팀 저장소 배치와 플러그인 캐시가 폴더 밖을 갖지 않는다. 지금 Python 과 같은 경계다 |
| DECISION2 | 공통 꼴 helper 의 자리 | 원본은 `modules/kit/`, 스킬과 도구는 복사본을 두고 테스트가 같은지 본다 | 사용자 2026-11-05 | 공용 코드는 `modules/` 한 곳에 둔다(실행용 `modules/kit`, 테스트용 `modules/testkit`). 처음 설계의 `scripts/kit/` 을 testkit 인터뷰에서 사용자가 바꿨고, 복사본과 대조 테스트는 그대로 두었다. 기각: `package.json` workspaces 패키지(ADR-010 이 `package.json` 과 npm 의존을 두지 않기로 했다), `tools/kit` 을 import 한다(팀의 nhn-dev 플러그인 안 스킬에서 경로가 깨진다), 영역마다 따로 쓴다(같은 꼴이 여러 벌로 갈라진다. ADR-010 이 고친 문제다), 내보내기가 복사본을 만든다(이 저장소 안 설치본이 원본을 import 해 두 경로가 생긴다) |
| DECISION3 | 테스트 helper | fos-test-speed 의 testkit(`modules/testkit/`). 이 저장소 테스트만 쓰고 팀에 싣지 않는다. 내보내는 스킬의 테스트는 Node 내장 모듈만 쓴다 | 사용자 2026-11-05 | 스펙 DECISION5. 팀 CI 가 팀 저장소 안에서 돈다. 처음 설계의 「내보내는 영역은 복사본」 을 testkit 인터뷰에서 사용자가 바꿨다 |
| DECISION4 | 문서의 호출 꼴 | `node "$SKILL_DIR/scripts/<이름>.ts"` | 작성자 | 실행 권한이 빠진 복사에서도 돈다. Node 24 는 경고를 내지 않는다 |
| DECISION5 | 명령 파일 이름 | 옛 이름에서 확장자만 바꾼다 | 작성자 | 문서와 다른 저장소의 고칠 곳이 확장자 하나다 |
| DECISION6 | 이행 상태의 원본 | `scripts/runtime-policy.json` 하나. 테스트가 그것을 읽는다 | 작성자 | 영역 PR 이 자기 줄만 지워 충돌이 작다. 남은 일이 파일 하나에 보인다 |
| DECISION7 | CI 의 테스트 선택 | 테스트 실행기(`scripts/run-tests.ts`)의 `tests/` 탐색. `test_*.py` 없는 폴더는 Python 묶음에서 빠진다 | 작성자 | 영역 PR 이 CI 를 고치지 않는다. 필수 검사가 없어 job 이름과 무관하다. 처음 답은 「CI 의 폴더 패턴 다섯과 `test_*.py` 없는 폴더 건너뛰기」 였다. 2026-11-06 PR1 착수 때 실행기(#355)가 같은 일을 이미 하는 것을 확인해 바꿨다(「CI」 절) |
| DECISION8 | 허용하는 JS | 타입 제거가 닿지 않는 진입만, `entry_js` 목록으로 | 작성자 | 스펙 REQ9 의 언어 규칙을 지키면서 git 훅과 doctor 진입을 node 로 둔다 |
| DECISION9 | orch 의 `lib/args.ts`, `lib/py.ts` | 이번에 바꾸지 않는다. `kit` 은 그 상위 집합이고 같은 함수의 출력을 테스트가 대조한다 | 작성자 | orch 구조 개편이 lib 를 다룬다. 합치면 그 기능과 같은 파일을 만진다 |
| DECISION10 | orch doctor 의 옛 진입 | 이 기능이 지우지 않는다. orch-cli 의 옛 이름 정리 PR 이 지운다. 버전 안내는 `bin/orch` 가 맡는다 | 작성자 | orch-cli 스펙 DECISION13 이 옛 이름을 끝내는 때를 소유한다. `bin/orch` 가 이미 `NODE-TOO-OLD` 를 낸다 |
| DECISION11 | 최소 Node 버전의 원본 | `scripts/runtime-policy.json` 의 `min_node`. 진입들의 `MIN_NODE` 줄을 저장소 테스트가 대조한다 | 작성자 | 진입끼리 import 할 수 없어 값이 여러 곳에 있다 |
| DECISION12 | 옛 이름 진입과 새 구현의 접점 | 새 `.ts` 가 `main`, `runHook` 을 export 하고 `import.meta.main` 일 때만 스스로 돈다 | 작성자 | 진입이 훅 JSON 에 안내를 끼우려면 결과를 받아야 한다. orch 가드 shim 의 꼴이다 |
| DECISION13 | browser-driver 의 자리 | PR10 이 `skills/browser/browser-driver/` 로 옮긴다. 첫 커밋은 이름만 바꾸는 이동이다. 팀 사본 자리는 `tools/browser-driver` 로 고정하고, `tools/` 폴더는 DECISION17 의 major 에 옛 이름 진입과 함께 지운다 | 사용자 2026-11-05 | 보드 `browser-driver-placement` 의 결정이다. git 이력과 REQ3 의 옛 구현·새 구현 비교를 지킨다. 소유자가 `browser` 스킬 하나라 ADR-021 의 소유 스킬 규칙에 맞는다. 폴더 안 배치를 그대로 두는 것은 작성자가 정했다 |
