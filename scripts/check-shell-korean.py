#!/usr/bin/env python3
"""셸 스크립트에서 `$변수` 바로 뒤에 한글이 붙은 자리를 찾는다.

큰따옴표 안의 `$removed개` 는 셸이 `${removed개}` 로 읽는다.
`set -u` 아래에서는 `unbound variable` 로 죽고, 없으면 빈 문자열이 된다.
`${removed}개` 로 써야 한다.

**어느 도구도 이것을 잡지 못한다 (실측).**

| 무엇으로 봤나 | 결과 |
| --- | --- |
| `bash script.sh` | `removed?: unbound variable` 로 죽는다 |
| `bash -n script.sh` | 종료 코드 0. 문법은 올바르다 |
| `shellcheck script.sh` | 종료 코드 0. 지적이 없다 |

조사가 붙은 `$PATH가` 도 같다. `PATH가: unbound variable` 로 죽는 것을 확인했다.

이 검사가 `korean-check` 가 아니라 이 저장소의 공용 층에 있는 이유는,
그 스킬이 마크다운 전용으로 경계를 선언해 두었기 때문이다.
`korean-check/scripts/check.sh` 는 확장자가 `.md` 가 아니면 종료 코드 2 를 낸다.

사용법:
    check-shell-korean.py <파일 또는 디렉터리>...

디렉터리를 주면 `.sh` 와 `.bash` 를 찾아 내려간다. `.git` 은 건너뛴다.

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

SHELL_SUFFIXES = (".sh", ".bash")


def collect(targets):
    """인자를 파일 목록으로 펼친다. 디렉터리는 셸 확장자만 골라 내려간다."""
    files = []
    for raw in targets:
        path = Path(raw)
        if path.is_dir():
            for suffix in SHELL_SUFFIXES:
                files += [p for p in path.rglob(f"*{suffix}") if ".git" not in p.parts]
        elif path.is_file():
            files.append(path)
    return sorted(set(files))


def scan(path):
    """한 파일의 위반을 (줄 번호, 줄 내용, 걸린 표기) 목록으로 낸다."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    found = []
    for number, line in enumerate(lines, 1):
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
        print("셸 파일을 찾지 못했다. 확장자는 .sh 와 .bash 를 본다.", file=sys.stderr)
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

    print(f"\n위반 {total}건. 셸이 변수 이름으로 읽어 set -u 아래에서 죽는다.", file=sys.stderr)
    return 0 if args.hook else 1


if __name__ == "__main__":
    sys.exit(main())
