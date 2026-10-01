# Phase 02. 격리된 설정 폴더에서 설치를 시험하는 스크립트

**Execution profile**: standard

## 목표

`scripts/test-plugin-install.sh` 를 만든다.
작업 트리를 임시 git 마켓플레이스로 등록해 설치하고, 스킬 일곱 개가 인식되는지와 설치 캐시에서 스킬 사이의 경로 참조가 풀리는지를 확인한다.
매니페스트 시험은 파일만 보므로, 실제 설치에서 깨지는 것은 이 스크립트가 잡는다.

**범위 외**: 매니페스트는 phase 01 이 만들었다. 실제 `~/.claude` 에 설치하는 일은 이 phase 가 하지 않는다. README 는 phase 05 가 고친다.

## 컨텍스트

phase 01 이 `.claude-plugin/marketplace.json` 과 `.claude-plugin/plugin.json` 을 추가했다.
마켓플레이스와 플러그인의 이름은 모두 `fos-skills` 이고 플러그인 소스는 저장소 루트다.

설치하면 저장소 루트가 `$CLAUDE_CONFIG_DIR/plugins/cache/fos-skills/fos-skills/<버전>/` 로 복사된다.
`version` 을 쓰지 않으므로 `<버전>` 은 커밋 SHA 앞 12자리다.
스킬 디렉터리는 캐시 루트 바로 아래에 있다. `skills/` 디렉터리는 없다.

실제 `~/.claude` 를 바꾸지 않으려고 `CLAUDE_CONFIG_DIR` 를 임시 디렉터리로 둔다.
git 소스로 등록하려고 가짜 주소를 임시 저장소로 돌린다. `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0` 환경 변수로 `url.file://<임시 저장소>.insteadOf` 를 가짜 주소에 건다.

주 체크아웃에는 git 이 무시하는 `worktrees/` 디렉터리가 있다. 그 안에 저장소 사본이 통째로 들어 있어, 작업 트리를 디렉터리째 복사하면 스킬이 중복으로 잡힌다.

이 저장소의 셸 스크립트는 `scripts/export-to-team.sh` 처럼 `set -euo pipefail` 로 시작하고 사용법을 머리 주석에 적는다.
테스트는 `unittest` 로 쓴다. phase 01 이 만든 `scripts/tests/test_plugin_manifest.py` 와 같은 디렉터리에 둔다.

**근거 문서**: `docs/code-architecture.md` 의 「스킬 사이의 경로 참조」 와 「검증」 절, `docs/flow.md` 의 「설치」 절, `docs/adr/002-plugin-version-is-commit-sha.md`

## 의도 메모

- `claude plugin validate --strict` 는 쓰지 않는다. 버전 경고로 실패한다.
- `HOME` 을 임시 디렉터리로 바꾸지 않는다. `python3` 이 mise shim 인 머신에서는 `HOME` 이 바뀌면 shim 이 인터프리터를 새로 내려받는다.
- 스킬 이름을 스크립트에 상수로 적지 않는다. `plugin.json` 의 `skills` 배열에서 읽는다. 스킬을 더했을 때 고칠 곳이 매니페스트 하나여야 한다.
- directory 소스로 등록하지 않는다. 설치하는 순간의 커밋하지 않은 변경이 캐시에 들어가 git 소스와 받는 내용이 달라진다.

## Blocked 조건

- `claude` 명령이 없다 → `PHASE_BLOCKED: claude CLI 없음` 출력 후 종료

## 작업 항목

### 1. `scripts/test-plugin-install.sh` 신규

사용법은 `scripts/test-plugin-install.sh [--keep]` 이다. 실행 권한을 준다.

| 인자 | 동작 |
| --- | --- |
| 없음 | 시험하고 임시 디렉터리를 지운다 |
| `--keep` | 임시 디렉터리를 지우지 않고 경로를 출력한다 |
| 그 밖의 인자 | 표준 오류에 `알 수 없는 인자: <인자>` 를 쓰고 종료 코드 2 |

종료 코드는 0 통과, 1 시험 실패, 2 실행 불가다.

순서는 다음과 같다.

1. 인자를 해석한다. 그다음 `claude`, `git`, `tar`, `python3` 가 있는지 `command -v` 로 본다. 없는 것이 있으면 표준 오류에 `실행 불가: <이름> 없음` 을 쓰고 종료 코드 2 로 끝난다. 이 두 단계는 다른 외부 명령을 부르기 전에 한다.
2. `mktemp -d` 로 임시 디렉터리 `T` 를 만든다. `--keep` 이 아니면 `trap` 으로 지운다.
3. 작업 트리를 `T/src` 로 복사한다. 작업 트리 루트는 `scripts/export-to-team.sh` 처럼 `$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)` 로 정한다. 실행한 cwd 와 무관해야 한다. 복사할 목록은 `git ls-files -z --cached --others --exclude-standard` 로 얻고, 작업 트리에 없는 경로는 뺀다. 이렇게 하면 무시되는 `worktrees/` 와 `.omc/` 가 빠지고 아직 커밋하지 않은 새 파일은 들어간다.
4. `T/src` 에서 `git init`, `git add -A`, 커밋을 한다. 커밋에는 `-c user.name=tester -c user.email=tester@example.com` 을 준다.
5. `CLAUDE_CONFIG_DIR="$T/config"` 를 export 한다. 가짜 주소 `https://marketplace.test/fos-skills.git` 를 `T/src` 로 돌리는 git 환경 변수 셋을 export 한다. 이 순서 뒤에서 `claude` 를 처음 부르기 직전에 `CLAUDE_CONFIG_DIR` 이 `$T/` 아래인지 확인하고, 아니면 `실행 불가: CLAUDE_CONFIG_DIR 격리 실패` 를 표준 오류에 쓰고 종료 코드 2 로 끝난다. 실제 `~/.claude` 에 가짜 마켓플레이스가 등록되는 것을 막는다.
6. `T/src` 에서 `claude plugin validate . --json` 을 돌려 `success` 가 참이고, `manifest.errors` 가 비었고, `manifest.warnings` 의 `path` 가 `plugins[0] plugin.json → version` 하나뿐인지 본다.
7. `claude plugin marketplace add <가짜 주소>` 와 `claude plugin install fos-skills@fos-skills` 를 실행한다.
8. 아래 표의 검사를 한다. 검사 하나마다 `ok: <설명>` 이나 `FAIL: <설명>` 한 줄을 출력한다.
9. 실패가 하나라도 있으면 `실패 <N> 건` 을 출력하고 종료 코드 1, 없으면 `통과` 를 출력하고 종료 코드 0 이다.

기대하는 스킬 이름은 `T/src/.claude-plugin/plugin.json` 의 `skills` 배열에서 `./` 를 뗀 값이다. 아래에서 `<캐시>` 는 `$CLAUDE_CONFIG_DIR/plugins/cache/fos-skills/fos-skills/` 아래의 디렉터리 하나다.

| 검사 | 통과 조건 |
| --- | --- |
| 설치 상태 | `claude plugin list` 출력에 `fos-skills@fos-skills` 와 `enabled` 가 있다 |
| 스킬 인식 | `claude plugin details fos-skills@fos-skills` 의 `Skills (N)` 줄에서 N 이 배열 길이와 같고, 배열의 이름이 그 줄에 모두 있다 |
| 캐시 디렉터리 | `<캐시>` 가 하나 있고 이름이 16진수 12자리다 |
| 스킬 파일 | 배열의 이름마다 `<캐시>/<이름>/SKILL.md` 가 있다 |
| 형제 참조 | `<캐시>/content-preview/../korean-check/references/review-axes.md` 가 있다 |
| 검사기 탐색 | `KOREAN_CHECK= bash <캐시>/content-preview/scripts/style-check.sh --where` 의 출력이 `<캐시>/korean-check` 와 같은 디렉터리다. 스크립트가 `pwd -P` 로 실체 경로를 내므로 비교하는 쪽도 `cd <캐시>/korean-check && pwd -P` 의 값을 쓴다. macOS 의 임시 디렉터리는 `/private` 아래를 가리키는 링크라 문자열을 그대로 비교하면 어긋난다 |
| 도구 | `<캐시>/tools/browser-driver/browser_driver.py` 가 있고 실행 권한이 있다 |
| 스크립트 실행 | `python3 <캐시>/planning/scripts/verify_task.py --help` 가 종료 코드 0 이다 |
| 링크 없음 | `find <캐시> -type l` 의 결과가 비어 있다 |

`claude` 명령이 실패하면 그 출력을 그대로 보이고 해당 검사를 `FAIL` 로 센다. `set -e` 때문에 검사 도중 스크립트가 죽지 않게 명령의 종료 코드를 받아서 판정한다.

### 2. `scripts/tests/test_plugin_install_script.py` 신규

스크립트의 실행 불가 경로를 확인한다. 설치 자체는 스크립트를 실행하는 것이 시험이라 여기서 다시 하지 않는다.
스크립트는 `subprocess.run(["/bin/bash", <스크립트 경로>, ...])` 로 부른다.

| 테스트 | 입력 | 기대 결과 |
| --- | --- | --- |
| 알 수 없는 인자 | `--nope` | 종료 코드 2, 표준 오류에 `알 수 없는 인자: --nope` |
| `claude` 없음 | 임시 디렉터리에 `git`, `tar`, `python3`, `dirname`, `mktemp` 의 링크만 만들고 `PATH` 를 그 디렉터리 하나로 준다 | 종료 코드 2, 표준 오류에 `claude` |

링크의 대상은 `shutil.which` 로 찾는다. `HOME` 은 바꾸지 않는다.

## 검증

```bash
# cwd: 저장소 루트
python3 -m unittest discover -s scripts/tests -v
bash scripts/test-plugin-install.sh
test -x scripts/test-plugin-install.sh
python3 scripts/check-shell-korean.py scripts/test-plugin-install.sh
```

- `unittest` 는 phase 01 의 일곱 테스트와 이 phase 의 두 테스트가 통과한다.
- `scripts/test-plugin-install.sh` 는 마지막 줄이 `통과` 이고 종료 코드 0 이다. `FAIL:` 로 시작하는 줄이 없다.
- 이 스크립트는 `claude plugin marketplace add` 와 `install` 을 임시 `CLAUDE_CONFIG_DIR` 에서 실행한다. 네트워크는 쓰지 않는다. 실패하면 검사마다 `FAIL:` 줄을 내고 종료 코드 1 로 끝난다.
- `check-shell-korean.py` 는 `$변수` 뒤에 한글이 바로 붙은 자리가 없어 종료 코드 0 이다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `scripts/test-plugin-install.sh` | 신규 |
| `scripts/tests/test_plugin_install_script.py` | 신규 |
