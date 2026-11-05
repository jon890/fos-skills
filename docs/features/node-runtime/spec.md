# 스크립트와 테스트를 TypeScript(Node 24) 하나로 옮긴다

확인: 2026-11-05

## 목표

이 저장소의 스크립트, 검사기, git 훅과 그 테스트가 TypeScript(Node 24) 한 언어로 돈다. Python 과 셸 파일은 남지 않는다.
팀 저장소로 내보내는 스킬도 같은 런타임으로 돌고, 팀 문서가 Node 24 요구를 알린다.

- 얻으려는 것(사용자 2026-11-04): 한 언어로 유지보수, 테스트와 실행 속도, python3 없는 환경 지원. 공통 testkit 은 `docs/features/test-speed/` 가 맡는다.

- 배경: 사용자 요청(2026-11-04) 「Python 도 모두 Node 환경으로 옮기고 sh 사용을 최대한 줄인다. 테스트 공통화와 함께 검토한다」.
- orch, work-board, inbox 는 이미 TypeScript 다([ADR-010](../../adr/010-orch-typescript.md), [ADR-011](../../adr/011-node-24-minimum.md)). 이번 기능은 나머지를 옮긴다.

## 실측 (2026-11-05 main, 38d39c2)

| 영역 | Python 소스 줄 | Python 테스트 줄 | 셸 |
| --- | --- | --- | --- |
| `skills/plan` | 2,369 | 2,404 | `plan_number.sh` |
| `skills/mac-cleanup` | 2,091 | 1,541 | `survey_gradle.sh` |
| `skills/harness-cleanup` | 2,190 | 998 | 없음 |
| `tools/browser-driver` | 1,669 | 1,130 | 없음 |
| `export-only-skills/korean-check` | 847 | 1,147 | `check.sh` |
| `scripts/` | 723 | 1,313 | `export-to-team.sh`, `install-hooks.sh`, `test-plugin-install.sh`, 표본 둘 |
| `skills/review-fix` | 864 | 490 | `fold_fixup.sh` |
| 나머지(`docs-audit`, `implementation`, `content-preview`, `report`, `presentation`, `browser`, `pr-review`, `orch`) | 약 1,900 | 약 1,000 | `pr_mergeable.sh`, `show-preview.sh`, `style-check.sh`, `gh-*.sh` 셋 |
| `githooks/` | `commit-msg`(python3) | | `post-commit`(bash) |

- Python 파일 124개, 약 2만 3천 줄. 제3자 패키지는 없다. 테스트 파일 54개 가운데 40개가 명령을 subprocess 로 실행한다.
- 문서 39개가 `python3` 를 94번 부른다(`git grep -c python3 -- '*.md'`). 셸은 `bash "$SKILL_DIR/scripts/<이름>.sh"` 꼴로 부른다.
- TypeScript 가 Python 을 부르는 곳: orch 의 `merge_queue.ts:610` 과 `orch-loop.ts:2116` 이 `review-fix/scripts/review_threads.py` 를 `python3` 로 띄운다. `lib/proc.ts` 의 `scriptCommand` 는 저장소 핸들러처럼 사용자가 준 `.py` 를 띄우는 경로라 이번 대상이 아니다.
- CI(`.github/workflows/ci.yml`)는 `Plugin tests` job 이 node 테스트를 명령 하나로, `Python tests` job 이 폴더마다 `unittest discover` 를 돈다. `Python tests` job 은 `jq`, `zsh` 를 설치한다. main 에 필수 검사(branch protection)는 없다.
- `plugin-version.yml` 이 `python3 scripts/bump-plugin-version.py` 와 `python3 -c` 를 부른다.
- 저장소 밖에서 옛 경로를 부르는 곳:
  - korean-check README 가 팀원에게 `~/.claude/scripts/korean-style-check.py --hook`, `check-readability.py --hook` 을 PostToolUse 훅으로 걸라고 안내한다.
  - 팀 저장소(AiSdtSkill)의 `plugins/nhn-dev/bin/browser-driver` 가 `tools/browser-driver/browser_driver.py` 를 부른다. 팀 CI(`validate.yml`, self-hosted)가 내보낸 `plan`, `implementation`, `review-fix`, `korean-check`, `content-preview`, `browser-driver` 의 Python 테스트를 `unittest` 로 돈다. 팀 README 는 「Node.js 20 이상」 이라고 적는다.
  - 사용자 머신의 `~/.claude/scripts/korean-style-check.py`, `check-readability.py` 링크가 옛 경로를 가리켜 깨져 있었다. 코디네이터가 2026-11-04 에 새 경로로 고쳤다.
- Node 24.22 는 타입 제거 실행에 경고를 내지 않는다(로컬 실측).

## 범위

이번 범위:

- 위 표의 Python 과 셸 전부를 TypeScript 로 옮긴다. 예외는 두지 않는다(DECISION2). 테스트는 `node:test` 의 `*.spec.ts` 로 옮긴다.
- 문서와 CI, workflow 의 `python3`, `bash ...sh` 호출을 새 명령으로 바꾼다.
- 저장소 밖에서 옛 이름을 직접 실행하는 곳을 한 major 동안 지키고, 인터프리터로 부르는 곳을 처리한다(DECISION3, DECISION4).
- 이행이 끝난 뒤 팀 저장소에 한 번 반영한다. 내보낸 스킬, 그에 기대는 팀 파일(래퍼, CI), 팀 README 와 변경 이력의 Node 24 요구를 맞춘다(DECISION7).
- 이 저장소의 스크립트 언어 규칙을 ADR 과 저장소 문서에 적고 저장소 테스트로 지킨다(DECISION9).
- `scripts/check-shell-korean.py` 와 표본 둘을 지운다(DECISION8).

범위 밖:

- 저장소 밖 개인 파일(`~/.claude/scripts/` 의 개인 `.py` 훅). korean-check README 가 팀원에게 안내하는 훅 경로는 범위 안이다.
- 스킬이 다른 저장소의 `.py`, `.sh` 를 감사하는 기능(`harness-cleanup` 의 스크립트 감사 등). 구현 언어만 바뀌고 감사 대상은 그대로다.
- orch 가 저장소 핸들러로 받은 사용자 스크립트를 확장자로 띄우는 경로(`skills/orch/scripts/lib/proc.ts` 의 `scriptCommand`).
- `tools/browser-driver` 의 위치를 정하는 일. 보드 `browser-driver-placement` 에서 사용자가 정했다(2026-11-05). 영역 10 이 `skills/browser/` 안으로 옮기고, 팀 사본 자리는 `tools/browser-driver` 로 둔다. 자세한 것은 설계 DECISION13 이다.
- node 테스트의 속도 개선과 공통 testkit. `docs/features/test-speed/` 가 맡는다. 이 전환은 그 testkit 을 쓴다.
- 팀 저장소 자체의 Python(팀 스킬 `create-pr`, `weekly-report` 등과 팀 `scripts/`).

## 선행 조건과 순서

- 이 전환은 fos-test-speed 의 TypeScript testkit 과 orch 구조 개편(orch-scripts-restructure 의 PR1~3)이 머지된 뒤 시작한다(DECISION5).
- 전환 안에서는 작은 것부터 영역 하나에 PR 하나로 간다(DECISION6).
  1. 저장소 기반: 언어 규칙 ADR, 남은 Python·셸 목록을 줄여 가는 저장소 테스트, CI 구성
  2. `scripts/` 와 `githooks/`, workflow 의 Python 호출
  3. 작은 스킬 묶음: `pr-review`, `implementation`, `docs-audit`, `report`, `presentation`, `browser`. orch doctor 의 옛 Python 진입은 orch-cli 의 옛 이름 정리 PR 이 지운다(DECISION14)
  4. `review-fix` 와 그것을 부르는 orch 호출
  5. `content-preview`
  6. `korean-check`
  7. `plan`
  8. `harness-cleanup`
  9. `mac-cleanup`
  10. `tools/browser-driver`
  11. 마무리: 테스트 실행기의 Python 부분 제거(머지 조건의 job 이름은 testkit 계획이 정한 이름을 따른다), 저장소 테스트의 남은 목록이 빈 것 확인
- 영역 3 의 `docs-audit` `static_check.py` 링크·색인 검사와 영역 7 의 `plan` ADR 위치·링크 검사기는 옮기지 않는다. [docs-check-ownership](../docs-check-ownership/spec.md) 이 지우고 TypeScript 검사기 `skills/plan/scripts/adr-docs.ts` 로 대신했다(그 스펙 DECISION7).
- 팀 저장소 반영은 11 이 머지된 뒤 팀 PR 하나로 한다(DECISION7). 그동안 팀 사본은 옛 Python 에 머물고 `githooks/post-commit` 이 어긋남을 계속 알린다. main 을 그대로 내보낼 수 없으므로 이 기간의 급한 수정은 DECISION10 대로 내보낸다.

## 다른 저장소의 옛 호출

2026-11-05 에 이 머신의 `~/personal/*`, `~/projects/*` 저장소 지침(`.claude/`, `.orch/`, `AGENTS.md`, `CLAUDE.md`)을 훑어 찾은 것이다. 해당 영역 PR 이 머지될 때 그 저장소에서 고친다(DECISION4). 영역 PR 은 머지 전에 같은 검색을 다시 돌려 목록을 갱신한다.

| 저장소 | 위치 | 호출 | 영역 |
| --- | --- | --- | --- |
| dooray-cli | `.claude/planning-overlay.md:65` | `python3 ~/.claude/skills/planning/scripts/verify_task.py` | plan |
| fos-accountbook | `.claude/planning-overlay.md:22` | `bash "$SKILL_DIR/scripts/plan_number.sh"` | plan |
| gersang-lab | `.claude/spec-overlay.md:39`, `.claude/docs-consolidate-overlay.md:17` | `python3 /Users/nhn/personal/fos-skills/korean-check/scripts/korean-style-check.py` | korean-check |
| fos-study | `.claude/references/blog-writing.md:72~73` | `python3 ~/.claude/scripts/korean-style-check.py`, `check-readability.py` | korean-check |
| fos-study | `.claude/skills/blog-post-writer/SKILL.md:78` | `bash ~/personal/fos-skills/korean-check/scripts/check.sh` | korean-check |
| ai-playground-docu-parser | `.claude/skills/release-flow/scripts/_korean_check.sh:7` | `$HOME/.claude/skills/korean-check/scripts/check.sh` | korean-check |

## 요구사항과 인수 조건

| ID | 요구사항 | 관측할 인수 조건 |
| --- | --- | --- |
| REQ1 | 저장소에 Python 파일이 남지 않는다 | 마지막 PR 뒤 python3 shebang 을 가진 파일이 없고, `git ls-files '*.py'` 가 DECISION3 의 옛 이름 진입 셋(node shebang 의 JS)뿐이다. 저장소 테스트가 이를 확인하고 어긴 파일 이름을 낸다. 옛 이름 진입을 지우는 시점은 DECISION17 이다 |
| REQ2 | 셸 파일이 남지 않는다. git 훅처럼 이름이 정해진 진입 파일도 node 로 돈다 | 마지막 PR 뒤 `.sh`, `.bash`, `.zsh` 파일과 셸 shebang 을 가진 파일이 없다(저장소 테스트). 임시 저장소에서 `install-hooks` 로 건 `commit-msg`, `post-commit` 훅이 `git commit` 때 node 로 돌아, 금지어가 든 메시지는 막고 공용 스킬 변경은 알린다 |
| REQ3 | 옮긴 명령의 옵션, stdout, 쓰는 파일, 종료 코드가 옮기기 전과 같다 | 영역 PR 마다 명령 경계 테스트가 옮기기 전 구현(첫 커밋)과 옮긴 구현(다음 커밋) 모두에서 통과하고, 두 실행 결과가 PR 본문에 있다. 정규식이 판정의 중심인 검사기(korean-check, plan 의 문서 검사기)는 저장소 문서 전체를 옛 명령과 새 명령에 돌린 출력이 같다는 비교가 PR 본문에 있다. stderr 는 문서나 테스트가 읽는 문구만 같다. 같음의 정도는 DECISION19, DECISION20 이다 |
| REQ4 | 문서가 새 명령을 부른다 | 영역 PR 뒤 그 영역 문서에 `python3`, `bash ...sh` 호출이 없다(`git grep`). 문서가 부르는 스크립트가 모두 있다(`orch-doctor.ts --skip-version --skill-dir`) |
| REQ5 | 이행 중 CI 가 두 언어의 테스트를 모두 돌고, 끝나면 node 테스트만 돈다 | 이행 중 PR 마다 CI 가 남은 Python 테스트와 옮긴 node 테스트를 함께 돌아 통과한다. Python 테스트가 없어진 폴더 때문에 CI 가 실패하지 않는다. 마지막 PR 에서 테스트 실행기의 Python 부분과 jq, zsh 설치가 없어지고, 머지 조건의 job 이름은 testkit 계획이 정한 이름을 따른다 |
| REQ6 | 저장소 밖에서 옛 이름을 직접 실행하는 곳이 정한 기간 동안 돈다 | `korean-style-check.py --hook`, `check-readability.py --hook`, `browser_driver.py` 를 링크나 직접 실행으로 부르면 새 구현과 같은 결과를 내고, DECISION18 의 자리에 새 명령을 알린다. 이행 뒤 설치 안내(README, `browser_driver install`)는 새 이름만 가리킨다(DECISION21). 셋을 지우는 시점은 DECISION17 이다 |
| REQ7 | 인터프리터로 옛 이름을 부르는 다른 저장소가 깨진 채 남지 않는다 | 영역 PR 이 머지된 뒤 「다른 저장소의 옛 호출」 의 그 영역 행마다 그 저장소에서 새 명령으로 바꾼 커밋이 있다. 바뀐 이름은 스킬 CHANGELOG 의 `호환성:` 항목에 새 명령과 함께 있다 |
| REQ8 | 팀 저장소에서 내보낸 스킬이 새 런타임으로 돈다 | 마지막 팀 PR 에서 팀 CI 가 Node 24 runner 로 내보낸 스킬의 node 테스트를 돌아 통과하고, 팀 README 와 변경 이력이 Node 24 이상을 요구한다. 팀 PR 본문이 팀원에게 바뀐 명령과 훅 경로를 안내한다 |
| REQ9 | 새 스크립트의 언어 규칙이 저장소 문서에 있고 저장소 테스트가 지킨다 | 새 ADR 과 `docs/code-architecture.md` 의 저장소 전체 「실행 규칙」 이 규칙을 적는다. 새 `.py` 나 `.sh` 를 더하면 저장소 테스트가 그 파일 이름을 내며 실패한다 |
| REQ10 | 대상이 없어진 셸 검사기가 지워진다 | `scripts/check-shell-korean.py`, `scripts/samples/shell-korean-*.sh`, README 의 두 줄이 없다 |

## 결정

| ID | 결정 | 답 | 누가 | 근거 |
| --- | --- | --- | --- | --- |
| DECISION1 | 얻으려는 것 | 한 언어로 유지보수, 테스트와 실행 속도, python3 없는 환경 지원 | 사용자 2026-11-04 | 1라운드 답. 공통 testkit 은 test-speed 가 맡는다 |
| DECISION2 | 남길 예외 | 없다. git 훅과 orch doctor 진입도 Node 로 옮긴다. Node 가 없거나 낮을 때 안내 없이 실패해도 된다 | 사용자 2026-11-04 | 1라운드 답 |
| DECISION3 | 저장소 밖에서 이름을 박고 직접 실행하는 곳의 호환 | korean-check 훅 두 파일(`korean-style-check.py`, `check-readability.py`)과 `browser_driver.py` 는 한 major 동안 같은 이름의 node shebang JS 진입으로 둔다. 나머지는 `호환성:` 항목으로 알린다 | 사용자 2026-11-05 | 2026-11-04 에 정하고 2026-11-05 에 직접 실행하는 곳으로 좁혔다. 훅 실패는 작업을 막지 않아 깨져도 눈에 띄지 않는다 |
| DECISION4 | `python3 x.py`, `bash x.sh` 로 부르는 옛 이름 | 얇은 진입을 두지 않는다. 다른 저장소의 호출은 그 영역 PR 이 머지될 때 orch worker 로 그 저장소에서 새 명령으로 고친다. 대상은 「다른 저장소의 옛 호출」 절 | 사용자 2026-11-05 | node 진입은 직접 실행에서만 돈다(2026-11-05 실험: 같은 파일을 `python3` 로 부르면 SyntaxError). 찾은 호출 여럿은 옛 배치 경로라 이미 깨져 있어 같이 바로잡힌다 |
| DECISION5 | 전환 시작 시점 | fos-test-speed 의 testkit, orch 구조 개편 PR1~3 뒤. 기한은 없다 | 사용자 2026-11-04 | 1라운드 답 |
| DECISION6 | 전환 안의 순서와 PR 단위 | 작은 것부터 영역 하나에 PR 하나. 순서는 「선행 조건과 순서」 | 사용자 2026-11-04 | PR 이 작아 리뷰가 되고, browser-driver 위치를 먼저 정할 여지가 남는다 |
| DECISION7 | 팀 저장소 반영 단위 | 이행이 끝난 뒤 팀 PR 하나. 팀 runner 의 Node 24, 팀 README 와 변경 이력도 그 PR 에서 맞춘다. 공지는 그 PR 본문으로 한다 | 사용자 2026-11-04 | 권장안(영역마다)과 다르다. 그 사이 팀 사본이 어긋나는 것을 감수한다 |
| DECISION8 | `check-shell-korean` 검사기 | 지운다 | 사용자 2026-11-04 | 셸 파일이 남지 않아 대상이 없다. 부르는 곳이 없다 |
| DECISION9 | 언어 규칙의 자리와 지키는 법 | 새 ADR 과 저장소 테스트. `docs/code-architecture.md` 의 「실행 규칙」 을 저장소 전체로 넓힌다 | 사용자 2026-11-04 | 개인 지침이 「그 저장소가 쓰는 쪽」 을 따르라고 하므로 저장소 문서가 규칙을 가져야 한다 |
| DECISION10 | 이행 중 팀에 급히 내보낼 수정 | 전환 첫 PR 직전 main 커밋에서 `team-export` 브랜치를 만든다. 급한 수정은 main 과 그 브랜치에 함께 넣고(그 영역을 이미 옮겼으면 브랜치에는 Python 으로 쓴다) `export-to-team.sh --apply --source-ref team-export` 로 내보낸다. 브랜치는 마지막 팀 PR 뒤에 지운다 | 사용자 2026-11-05 | 기존 `--source-ref` 를 그대로 쓰고, 원본이 하나라는 팀 규칙(팀 `CLAUDE.md` 「사본을 여기서 고치지 않는다」)을 지킨다 |
| DECISION11 | 동작이 같다는 것을 보이는 방법 | 명령 경계 테스트를 먼저 `node:test` 로 써서 Python 구현에서 통과시키고, 같은 PR 의 다음 커밋에서 구현만 바꾼다. 옵션, stdout, 종료 코드를 같게 지키고, stderr 는 문서나 테스트가 읽는 문구만 지킨다 | 사용자 2026-11-04 | 같은 테스트가 두 구현에서 통과한다. JS 의 `\w` 는 한글을 잡지 않는 등 정규식 차이가 있어 정규식 중심 검사기는 문서 전체 비교를 더한다 |
| DECISION12 | 테스트 실행기 | `node --test` 와 `node:test`. 의존성 0 을 지킨다 | 작성자 | [ADR-010](../../adr/010-orch-typescript.md), test-speed 스펙 DECISION1 |
| DECISION13 | git 훅 진입의 꼴 | 확장자 없는 node shebang JS 가 같은 이름의 `.ts` 를 `import()` 한다. 타입 문법은 `.ts` 에만 둔다 | 작성자 | git 은 확장자 없는 이름을 실행하고, node 는 확장자 없는 파일의 타입을 지우지 않는다. orch 가드 shim(`skills/orch/scripts/lib/guard/orca`)과 같은 꼴이다(2026-11-05 실험) |
| DECISION14 | orch doctor 의 Node 버전 안내 | 새 진입을 두지 않는다. doctor 는 `orch doctor` 로 불리고 플러그인 `bin/orch` 실행기가 이미 `NODE-TOO-OLD` 를 낸다. 옛 진입 `orch-doctor.py`, `ts_shim.py` 는 orch-cli 의 옛 이름 정리 PR 이 지운다 | 작성자 | 2026-11-05 설계 검토에서 고쳤다(처음 답은 `.mjs` 진입). orch-cli 스펙 DECISION13 이 옛 이름을 끝내는 때를 소유한다. 사용자에게 보이는 출력은 바뀌지 않는다 |
| DECISION15 | 명령마다 Node 버전 검사 | 하지 않는다. README 와 doctor 가 Node 24 요구를 알린다 | 작성자 | DECISION2. 낮은 Node 는 0 이 아닌 종료 코드와 오류로 끝나 조용히 지나가지 않는다 |
| DECISION16 | `python3 -c` 로 JSON 을 읽는 workflow 줄 | `node -e` 로 바꾼다 | 작성자 | DECISION1 의 python3 없는 환경 |
| DECISION17 | 옛 이름 진입 셋을 지우는 시점 | 이 저장소의 다음 major 에서 지운다. korean-check 의 두 파일은 korean-check 스킬이 영역 PR 다음으로 major 를 올릴 때, `browser_driver.py` 는 버전이 없는 도구라 그것을 쓰는 `browser` 스킬이 browser-driver 영역 PR 다음으로 major 를 올릴 때 지운다. 팀원 보호 기간이 0일 수 있음을 감수한다 | 사용자 2026-11-05 | 권장안(팀 반영 한 달 뒤)과 다르다. [ADR-010](../../adr/010-orch-typescript.md) 과 같은 규칙이다. `browser` 스킬로 셈하는 것은 작성자가 정했다 |
| DECISION18 | 옛 이름 진입의 안내 자리와 훅에서 Node 가 낮을 때 | 훅 모드의 옛 이름 진입만 `additionalContext` 에 안내 한 줄을 발견 앞에 붙인다(「이 훅 경로는 다음 major 에 없어진다. 새 명령: ...」). Node 가 24 보다 낮으면 같은 자리에 「Node 24 이상이 필요해 한국어 검사를 건너뛰었다」 를 낸다. 새 이름의 훅과 일반 명령 모드의 출력은 그대로다 | 사용자 2026-11-05 | 훅 모드는 늘 0 으로 끝나 stderr 가 보이지 않는다(`korean-style-check.py` 383~440줄) |
| DECISION19 | 쓰는 파일과 JSON 출력의 같음 | stdout 과 명령이 쓰는 파일(CHANGELOG, SKILL.md, plugin.json, `--json-out`, 기록 파일)은 바이트까지 같다. JSON 의 키 순서, 들여쓰기, 한글을 그대로 두는 표기를 맞춘다. 옛 구현이 쓴 파일을 새 구현이 읽는다 | 작성자 | 출력 계약을 바꾸지 않는 쪽이다. orch 전환이 같은 방식(`skills/orch/scripts/lib/py.ts`)으로 맞췄다 |
| DECISION20 | argparse 가 주던 옵션 동작 | 긴 옵션의 고유 접두 줄임, `--opt=value`, 사용법 오류의 종료 코드 2 를 그대로 둔다. `--help` 문구는 뜻만 같고 글자는 바뀔 수 있다 | 작성자 | 저장소의 argparse 26곳이 `allow_abbrev=False` 없이 줄임을 받는다. orch 전환의 `skills/orch/scripts/lib/args.ts` 를 재사용한다. 도움말은 사람이 읽는 글이라 바이트 대조에서 뺀다 |
| DECISION21 | 이행 뒤 새 설치 안내 | README 와 설치 명령은 새 이름(직접 실행하는 `.ts`)만 안내한다. 옛 이름 진입은 이미 설치한 쪽만 지킨다 | 작성자 | DECISION3 의 진입은 기간을 둔 호환이라, 새 설치자가 거기에 기대면 지울 때 함께 깨진다 |
| DECISION22 | CI 의 마지막 정리 | CI 는 한 job 이 새 테스트 실행기를 옵션 없이 불러 node 와 Python 을 함께 돈다(testkit 인터뷰 결정). 그래서 마지막 PR 은 `Python tests` job 을 지우지 않고 테스트 실행기의 Python 부분을 지운다. 머지 조건의 job 이름은 testkit 계획이 정한 이름을 따른다 | 사용자 2026-11-05 | testkit 인터뷰 결정과 어긋나던 REQ5 를 맞춘다 |

## 도메인 규칙 변경

도메인 규칙 변경 없음: 스크립트의 구현 언어와 실행 환경만 바꾼다. 스킬이 판정하는 규칙은 그대로다.
