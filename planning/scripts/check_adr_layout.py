#!/usr/bin/env python3
"""ADR 위치와 저장소 Markdown의 ADR 상대 링크를 검사한다.

사용법: check_adr_layout.py [ADR_DIR] [--repo-root ROOT]
ADR_DIR의 기본값은 docs/adr이다. ROOT는 ADR_DIR에서 가장 가까운 Git 루트이며,
Git 밖에서는 현재 디렉터리다. 종료 코드: 0 통과, 1 위반, 2 인자 오류.
Git 저장소는 추적 파일과 무시되지 않은 미추적 파일만 읽는다.
Git 밖에서는 모든 Markdown을 읽는다. 인라인 링크와 참조 링크를 검사하며,
코드 블록과 코드 스팬은 제외한다. URL 조각과 쿼리는 파일 존재 검사에서 제외한다.
"""

import argparse
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


STATUS = re.compile(r"^- \*\*status\*\*: `([^`]+)`")
LINK = re.compile(r'\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)')
REFERENCE = re.compile(r'^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)', re.M)


def prose(text, strip_inline=True):
    """Markdown 코드 예시를 지우되 줄 번호는 유지한다."""
    result = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker[1]
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            result.append("")
        elif fence is None:
            result.append(re.sub(r"(`+).*?\1", "", line) if strip_inline else line)
        else:
            result.append("")
    return "\n".join(result)


def markdown_files(repo_root):
    """Git이 관리 대상으로 보는 Markdown을 고르고, Git 밖이면 전체를 찾는다."""
    try:
        probe = subprocess.run(["git", "-C", str(repo_root), "rev-parse", "--is-inside-work-tree"],
                               capture_output=True, text=True)
    except FileNotFoundError:
        probe = None
    if probe is not None and probe.returncode == 0 and probe.stdout.strip() == "true":
        result = subprocess.run(["git", "-C", str(repo_root), "ls-files", "--cached", "--others",
                                 "--exclude-standard", "-z"], capture_output=True, text=True, check=True)
        return sorted({repo_root / name for name in result.stdout.split("\0")
                       if name.endswith(".md") and (repo_root / name).is_file()})
    return sorted(repo_root.rglob("*.md"))


def check(adr_dir, repo_root):
    violations = []
    for file in sorted(adr_dir.rglob("*.md")):
        status_lines = prose(file.read_text(encoding="utf-8"), strip_inline=False).splitlines()
        status = next((m[1] for line in status_lines if (m := STATUS.match(line))), None)
        archived = file.is_relative_to(adr_dir / "superseded")
        if file.parent == adr_dir and status == "superseded":
            violations.append(f"{file}: 대체된 ADR 은 {adr_dir / 'superseded'} 로 옮긴다")
        elif archived and status != "superseded":
            violations.append(f"{file}: superseded/ 아래 ADR 의 status 는 superseded 여야 한다 (현재: {status or '없음'})")

    for file in markdown_files(repo_root):
        if ".git" in file.relative_to(repo_root).parts:
            continue
        text = prose(file.read_text(encoding="utf-8"))
        for match in sorted([*LINK.finditer(text), *REFERENCE.finditer(text)], key=lambda m: m.start()):
            target = match[1].strip("<>")
            url = urlsplit(target)
            if url.scheme or url.netloc or not url.path or url.path.startswith("/"):
                continue
            destination = (file.parent / unquote(url.path)).resolve()
            if destination.is_relative_to(adr_dir) and not destination.is_file():
                line = text.count("\n", 0, match.start()) + 1
                violations.append(f"{file}:{line}: ADR 링크 대상이 없다: {target}")
    return violations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adr_dir", nargs="?", default="docs/adr", type=Path,
                        help="ADR 폴더 경로 (기본값: docs/adr)")
    parser.add_argument("--repo-root", type=Path, help="Markdown을 검사할 저장소 루트")
    args = parser.parse_args()
    adr_dir = args.adr_dir.resolve()
    repo_root = args.repo_root
    if repo_root is None:
        repo_root = next((p for p in (adr_dir, *adr_dir.parents) if (p / ".git").exists()), Path.cwd())
    repo_root = repo_root.resolve()
    if not adr_dir.is_dir() or not repo_root.is_dir() or not adr_dir.is_relative_to(repo_root):
        parser.error("ADR_DIR 은 ROOT 아래에 있는 디렉터리여야 한다")
    try:
        violations = check(adr_dir, repo_root)
    except (OSError, UnicodeError, ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    for violation in violations:
        print(violation)
    return int(bool(violations))


if __name__ == "__main__":
    raise SystemExit(main())
