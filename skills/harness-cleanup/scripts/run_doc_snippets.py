#!/usr/bin/env python3
"""문서에 적힌 bash 코드 블록을 그대로 추출해 bash 와 zsh 양쪽에서 돌린다.

사용법:
    run_doc_snippets.py <파일> ["<블록 앞에 오는 머리말>"]
    run_doc_snippets.py <파일> --list
    run_doc_snippets.py <파일> --block <번호>

문서대로 실행했을 때 실제로 동작하는지 확인하는 것이 목적이다.

머리말을 생략하면 그 파일의 실행 가능한 블록을 처음부터 끝까지 전부 돈다.
`SKILL.md` 2단계가 요구하는 것이 그것이다. 머리말을 주면 그 뒤 첫 블록 하나만 돈다.

`--list` 는 블록을 실행하지 않고 번호, 시작 줄, 앞 머리말, 첫 줄을 낸다.
저장소나 외부에 닿는 명령(`RISKY` 상수)이 든 블록에는 `[위험]` 과 해당 명령을 붙인다.
표시는 읽을 블록을 고르는 단서이고 안전 보증이 아니다. 표시가 없어도 블록을 읽는다.
`--block N` 은 `--list` 의 번호 N 블록 하나만 돈다.

종료 코드:
    0  블록을 찾아 실행했다
    2  파일이 없거나 인자가 모자란다
    3  돌릴 bash 블록을 찾지 못했다(`--block` 번호가 범위 밖인 경우 포함)

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


BLOCK = re.compile(r"```(?:bash|sh)\n(.*?)```", re.S)

# 저장소나 외부에 닿는 명령. `--list` 가 이 패턴이 든 블록에 위험 표시를 붙인다.
RISKY = (
    r"\bgit\s+(?:-C\s+\S+\s+)?(?:push|commit|reset|clean|checkout|merge|rebase)\b",
    r"\bgh\s",
    r"\borca\s",
    r"\bnhncloud\s+configure\b",
    r"--apply\b",
    r"\brm\s+-\w*[rf]",
    r"\bkill(?:all)?\b",
    r"\bpkill\b",
)


def extract(text, marker):
    """머리말 뒤 첫 bash 블록의 본문."""
    m = re.search(re.escape(marker) + r".*?```(?:bash|sh)\n(.*?)```", text, re.S)
    return m.group(1) if m else None


def extract_all(text):
    """파일에 있는 bash 블록 전부."""
    return BLOCK.findall(text)


def list_blocks(text):
    """블록마다 (번호, 시작 줄, 머리말, 첫 줄, 위험 명령 목록)을 낸다. 실행하지 않는다."""
    rows = []
    for number, m in enumerate(BLOCK.finditer(text), 1):
        line = text.count("\n", 0, m.start()) + 1
        before = [x.strip() for x in text[: m.start()].splitlines() if x.strip()]
        heading = before[-1] if before else ""
        body = m.group(1)
        first = next((x.strip() for x in body.splitlines() if x.strip()), "")
        found = (re.search(p, body) for p in RISKY)
        risky = [hit.group(0).strip() for hit in found if hit]
        rows.append((number, line, heading, first, risky))
    return rows


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


def run_block(block, label):
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as f:
        f.write(block)
        snippet = Path(f.name)
    try:
        print(f"{label} ({len(block.splitlines())}줄)")
        print(RULE)
        for shell in SHELLS:
            run_in(shell, snippet)
        print(RULE)
    finally:
        snippet.unlink(missing_ok=True)


def main(argv):
    args = list(argv[1:])
    list_only = "--list" in args
    args = [a for a in args if a != "--list"]
    block_no = None
    if "--block" in args:
        i = args.index("--block")
        try:
            block_no = int(args[i + 1])
        except (IndexError, ValueError):
            print("--block 에 블록 번호가 필요하다", file=sys.stderr)
            return 2
        del args[i : i + 2]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(args[0])
    marker = args[1] if len(args) > 1 else None
    if not path.is_file():
        print(f"파일이 없다: {path}", file=sys.stderr)
        return 2

    text = path.read_text(encoding="utf-8", errors="replace")
    if list_only:
        rows = list_blocks(text)
        if not rows:
            print("bash 블록을 찾지 못했다", file=sys.stderr)
            return 3
        for number, line, heading, first, risky in rows:
            flag = f"  [위험: {', '.join(risky)}]" if risky else ""
            print(f"{number:>3}  {line}행  {heading[:50]}  |  {first[:70]}{flag}")
        return 0
    if block_no is not None:
        blocks = extract_all(text)
        if not 1 <= block_no <= len(blocks):
            print(f"블록 {block_no} 이 없다 (블록 {len(blocks)}개)", file=sys.stderr)
            return 3
        run_block(blocks[block_no - 1], f"블록 {block_no}/{len(blocks)}")
    elif marker is None:
        blocks = extract_all(text)
        if not blocks:
            print("bash 블록을 찾지 못했다", file=sys.stderr)
            return 3
        print(f"블록 {len(blocks)}개를 돈다")
        for number, block in enumerate(blocks, 1):
            run_block(block, f"블록 {number}/{len(blocks)}")
    else:
        block = extract(text, marker)
        if block is None:
            print(f'"{marker}" 뒤에서 bash 블록을 찾지 못했다', file=sys.stderr)
            return 3
        run_block(block, "추출한 블록")

    print("출력이 0줄이면 음성 대조를 하라 — 검사 대상 경로에 탐지 대상을 심고")
    print("같은 블록이 그것을 잡아내는지 확인한다. 잡지 못하면 검사가 도는 것이 아니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
