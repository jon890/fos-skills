#!/usr/bin/env python3
"""셸 스크립트에서 `$변수` 바로 뒤에 한글이 붙은 자리를 찾는다.

큰따옴표 안의 `$removed개` 를 어떤 셸은 `${removed개}` 로 읽는다.
`${removed}개` 로 써야 어느 셸에서나 같게 돈다.

**이것은 이식성 결함이다. 어디서나 죽는 것이 아니다.**
변수 이름을 non-ASCII 앞에서 끊는 셸과 이름의 일부로 읽는 셸이 갈린다.

| 셸 | 결과 | 확인한 곳 |
| --- | --- | --- |
| bash 3.2.57 (`/bin/bash`, macOS 기본) | `n?: unbound variable` 로 죽는다 | 작업용 Mac |
| zsh (macOS 기본 로그인 셸) | `n건: parameter not set` 으로 죽는다 | 작업용 Mac |
| `/bin/sh` | 죽는다 | 작업용 Mac |
| dash | 정상 동작한다 | 작업용 Mac |
| bash 5.2.21 | 정상 동작한다 | 다른 세션의 홈서버 |

**bash 5 에서 시험한 결과만 보고 이 검사를 지우지 않는다.**
macOS 기본 `/bin/bash` 가 3.2 이고 기본 로그인 셸인 zsh 도 죽는다.
같은 파일이 홈서버의 bash 5 에서는 통과하다가 Mac 에서 죽은 사례가 있다.

**어느 도구도 이것을 잡지 못한다.**

| 무엇으로 봤나 | 결과 |
| --- | --- |
| `bash -n script.sh` | 종료 코드 0. 문법은 올바르다 |
| `shellcheck script.sh` | 종료 코드 0. 지적이 없다 |

조사가 붙은 `$PATH가` 도 같다. bash 3.2 에서 `PATH가: unbound variable` 로 죽는다.

## 어느 줄을 보는가

셸이 그 자리를 확장하는지로 가른다. 확장하지 않는 자리는 이식성 결함이 아니다.
넷을 bash 3.2 로 돌려 확인했다.

| 자리 | 확장되나 | 이 검사 |
| --- | --- | --- |
| 코드 | 그렇다 | 본다 |
| `#` 으로 시작하는 줄 | 아니다 | 건너뛴다 |
| `<<EOF` 로 연 heredoc 안 | 그렇다 | 본다. `#` 으로 시작해도 주석이 아니다 |
| `<<'EOF'` 로 연 heredoc 안 | 아니다 | 건너뛴다 |

**주석 줄을 건너뛰는 이유는 자기참조다.** 이 규칙을 설명하는 주석이 위반으로 잡혔다.
`harness-cleanup` 의 「죽은 검출」 축이 그 경우를 다루고,
`korean-check/scripts/check-readability.py` 의 docstring 도 같은 경험을 적고 있다.

**줄 끝에 붙은 주석은 잘라내지 않는다.** `echo "안전" # 설명: $n개` 의 위반은 평가되지 않아
무해하지만, 문자열 안의 `#` 과 주석 시작을 가리려면 따옴표를 추적해야 한다.
그 비용을 치르는 대신 오탐으로 남긴다. 사람이 보고 판정하는 편이 미탐보다 안전하다.

사용법:
    check-shell-korean.py <파일 또는 디렉터리>...

`.sh` 와 `.bash` 만 검사한다. 파일을 직접 줘도 확장자를 본다.
그 검사가 없으면 이 파일 자신처럼 규칙을 적어 둔 `.py` 가 위반으로 잡힌다.
디렉터리를 훑을 때는 `.git` 과 `samples` 를 건너뛴다. 표본은 일부러 위반을 담고 있어서다.
표본을 확인할 때는 그 파일을 직접 지목한다.

종료 코드:
    0  위반 없음
    1  위반 있음
    2  잘못된 호출 (대상이 없음)

훅에서 부를 때는 `--hook` 을 준다. 위반이 있어도 0 으로 끝나 편집을 막지 않는다.
"""

import argparse
import re
import sys
from pathlib import Path

#: `$이름` 바로 뒤에 한글이 오는 자리. `${이름}한글` 과 `$이름 한글` 은 걸리지 않는다.
PATTERN = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*(?=[가-힣])")

#: heredoc 을 여는 자리. `<<-` 와 따옴표로 감싼 델리미터를 함께 받는다.
HEREDOC = re.compile(r"<<-?\s*(?P<quote>['\"]?)(?P<word>[A-Za-z_][A-Za-z0-9_]*)\1")

SHELL_SUFFIXES = (".sh", ".bash")

#: 디렉터리를 훑을 때 건너뛰는 이름. samples 는 일부러 위반을 담은 표본이다.
SKIP_DIRS = (".git", "samples")


def collect(targets):
    """인자를 파일 목록으로 펼친다.

    확장자는 파일을 직접 줄 때도 본다. 그 검사가 없으면 규칙을 적어 둔 `.py` 가 걸린다.
    `SKIP_DIRS` 는 디렉터리를 훑을 때만 적용한다. 표본은 지목하면 검사한다.
    """
    files = []
    for raw in targets:
        path = Path(raw)
        if path.is_dir():
            for suffix in SHELL_SUFFIXES:
                files += [p for p in path.rglob(f"*{suffix}")
                          if not any(part in SKIP_DIRS for part in p.parts)]
        elif path.is_file() and path.suffix in SHELL_SUFFIXES:
            files.append(path)
    return sorted(set(files))


def scan(path):
    """한 파일의 위반을 (줄 번호, 줄 내용, 걸린 표기) 목록으로 낸다.

    heredoc 안에서는 주석 판정을 하지 않는다. 그 안의 `#` 은 주석이 아니라 데이터다.
    """
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []

    found = []
    # heredoc 안이면 (델리미터, 확장되는지) 를 담는다. 밖이면 None.
    here = None

    for number, line in enumerate(lines, 1):
        if here is not None:
            if line.strip() == here[0]:
                here = None
                continue
            if not here[1]:
                continue
        else:
            opened = HEREDOC.search(line)
            # 여는 줄 자신도 검사한다. bash 는 heredoc 내용을 그 줄에서 확장한다 (실측).
            if line.lstrip().startswith("#"):
                continue
            if opened:
                here = (opened.group("word"), opened.group("quote") == "")

        for match in PATTERN.finditer(line):
            found.append((number, line.strip(), match.group()))

    return found


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=True, description=__doc__.splitlines()[0])
    parser.add_argument("targets", nargs="*", help="검사할 파일이나 디렉터리")
    parser.add_argument("--hook", action="store_true",
                        help="위반이 있어도 0 으로 끝낸다. 편집을 막지 않고 알리기만 한다")
    args = parser.parse_args(argv)

    if not args.targets:
        print("검사할 대상이 없다. 파일이나 디렉터리를 준다.", file=sys.stderr)
        return 2

    files = collect(args.targets)
    if not files:
        # 훅은 편집 대상을 그대로 넘기므로 셸이 아닌 파일이 들어온다. 그것은 실패가 아니다.
        if args.hook:
            return 0
        print("셸 파일을 찾지 못했다. .sh 와 .bash 만 검사한다.", file=sys.stderr)
        return 2

    total = 0
    for path in files:
        for number, text, token in scan(path):
            total += 1
            fixed = token.replace("$", "${", 1) + "}"
            print(f"{path}:{number}: {token} 뒤에 한글이 붙었다. {fixed} 로 감싼다")
            print(f"  {text}")

    if not total:
        print(f"통과: 셸 파일 {len(files)}개")
        return 0

    print(f"\n위반 {total}건. 이식성 결함이다. "
          "bash 3.2 와 zsh 는 변수 이름의 일부로 읽어 set -u 아래에서 죽고, "
          "bash 5 는 끊어 읽어 통과한다.", file=sys.stderr)
    return 0 if args.hook else 1


if __name__ == "__main__":
    sys.exit(main())
