#!/usr/bin/env python3
"""문서에 적힌 bash 코드 블록을 그대로 추출해 bash 와 zsh 양쪽에서 돌린다.

사용법:
    run_doc_snippets.py <파일> "<블록 앞에 오는 머리말>"

문서대로 실행했을 때 실제로 동작하는지 확인하는 것이 목적이다.

종료 코드:
    0  블록을 찾아 실행했다
    2  파일이 없거나 인자가 모자란다
    3  머리말 뒤에서 bash 블록을 찾지 못했다

**판정은 출력으로 한다.** 블록에 문법 오류가 있어도 이 스크립트는 0 으로 끝난다.
셸마다 결과가 다르면 배열 확장 같은 셸 차이를 의심한다.
결과가 0건이면 음성 대조까지 해야 한다. 검사를 안 해서 0건일 수 있다.
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

RULE = "─" * 37
SHELLS = ("bash", "zsh")


def extract(text, marker):
    """머리말 뒤 첫 bash 블록의 본문."""
    m = re.search(re.escape(marker) + r".*?```(?:bash|sh)\n(.*?)```", text, re.S)
    return m.group(1) if m else None


def run_in(shell, path):
    """문법 검사를 먼저 하고, 통과하면 실행해 출력을 낸다."""
    if not shutil_which(shell):
        print(f"[{shell}] 설치돼 있지 않아 건너뛴다")
        return
    syntax = subprocess.run([shell, "-n", str(path)], capture_output=True, text=True)
    if syntax.returncode != 0:
        print(f"[{shell}] 문법 오류")
        for line in (syntax.stdout + syntax.stderr).splitlines():
            print(f"    {line}")
        return
    done = subprocess.run([shell, str(path)], capture_output=True, text=True)
    out = (done.stdout or "") + (done.stderr or "")
    lines = [x for x in out.splitlines() if x.strip()]
    print(f"[{shell}] 문법 OK / 출력 {len(lines)}줄")
    for line in out.splitlines()[:10]:
        print(f"    {line}")


def shutil_which(name):
    import shutil
    return shutil.which(name)


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    path, marker = Path(argv[1]), argv[2]
    if not path.is_file():
        print(f"파일이 없다: {path}", file=sys.stderr)
        return 2

    block = extract(path.read_text(encoding="utf-8", errors="replace"), marker)
    if block is None:
        print(f'"{marker}" 뒤에서 bash 블록을 찾지 못했다', file=sys.stderr)
        return 3

    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as f:
        f.write(block)
        snippet = Path(f.name)
    try:
        print(f"추출한 블록 ({len(block.splitlines())}줄)")
        print(RULE)
        for shell in SHELLS:
            run_in(shell, snippet)
        print(RULE)
        print("출력이 0줄이면 음성 대조를 하라 — 검사 대상 경로에 탐지 대상을 심고")
        print("같은 블록이 그것을 잡아내는지 확인한다. 잡지 못하면 검사가 도는 것이 아니다.")
    finally:
        snippet.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
