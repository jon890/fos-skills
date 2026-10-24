#!/usr/bin/env python3
"""Check ADR locations and repository Markdown links to ADR files.

Usage: check_adr_layout.py [ADR_DIR] [--repo-root ROOT]
ADR_DIR defaults to docs/adr. ROOT defaults to the nearest Git root above
ADR_DIR, or cwd outside Git. Exit: 0 pass, 1 violations, 2 invalid arguments.
Checks inline and reference Markdown links, excluding fenced code and inline
code. URL fragments and queries do not affect file existence checks.
"""

import argparse
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


STATUS = re.compile(r"^- \*\*status\*\*: `([^`]+)`")
LINK = re.compile(r'\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)')
REFERENCE = re.compile(r'^ {0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)', re.M)


def prose(text, strip_inline=True):
    """Keep line numbers while removing Markdown code examples."""
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


def check(adr_dir, repo_root):
    violations = []
    for file in sorted(adr_dir.rglob("*.md")):
        status_lines = prose(file.read_text(encoding="utf-8"), strip_inline=False).splitlines()
        status = next((m[1] for line in status_lines if (m := STATUS.match(line))), None)
        archived = file.is_relative_to(adr_dir / "superseded")
        if file.parent == adr_dir and status == "superseded":
            violations.append(f"{file}: superseded ADR must be moved to {adr_dir / 'superseded'}")
        elif archived and status != "superseded":
            violations.append(f"{file}: superseded/ requires status superseded (found {status or 'missing'})")

    for file in sorted(repo_root.rglob("*.md")):
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
                violations.append(f"{file}:{line}: missing ADR link target: {target}")
    return violations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adr_dir", nargs="?", default="docs/adr", type=Path)
    parser.add_argument("--repo-root", type=Path)
    args = parser.parse_args()
    adr_dir = args.adr_dir.resolve()
    repo_root = args.repo_root
    if repo_root is None:
        repo_root = next((p for p in (adr_dir, *adr_dir.parents) if (p / ".git").exists()), Path.cwd())
    repo_root = repo_root.resolve()
    if not adr_dir.is_dir() or not repo_root.is_dir() or not adr_dir.is_relative_to(repo_root):
        parser.error("ADR_DIR must be an existing directory within ROOT")
    try:
        violations = check(adr_dir, repo_root)
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))
    for violation in violations:
        print(violation)
    return int(bool(violations))


if __name__ == "__main__":
    raise SystemExit(main())
