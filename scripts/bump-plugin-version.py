#!/usr/bin/env python3
"""main 에 들어온 변경으로 플러그인 version 을 올리고 플러그인 CHANGELOG 에 한 줄을 더한다.

사용: python3 scripts/bump-plugin-version.py --base <push 전 커밋> --head <push 뒤 커밋> [--date YYYY-MM-DD]
`.github/workflows/plugin-version.yml` 이 main push 마다 부른다. 규칙의 근거는 docs/adr/019-plugin-version-auto-bump.md 다.

등급은 base..head 에서 바뀐 스킬 CHANGELOG 의 더한 줄로 정한다.
- `- 호환성:` 으로 시작하는 줄이 있으면 major
- 새 버전 절(`## X.Y.Z (날짜)`)이 있으면 minor
- 그 밖의 변경은 patch

올리지 않고 끝내는 경우(종료 코드 0, stdout 첫 줄이 `skip:`):
- base..head 가 plugin.json 의 version 을 이미 바꿨다(사람이 직접 올림)
- 바뀐 파일이 plugin.json 과 플러그인 CHANGELOG 뿐이다
올렸으면 stdout 첫 줄이 새 version 이다.
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ".claude-plugin/plugin.json"
CHANGELOG = ".claude-plugin/CHANGELOG.md"
OWN_FILES = {MANIFEST, CHANGELOG}
ZERO = "0" * 40

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
VERSION_HEADING = re.compile(r"^## (\d+\.\d+\.\d+) \(\d{4}-\d{2}-\d{2}\)")
COMPAT = re.compile(r"^- 호환성:")
PR_NUMBER = re.compile(r"Merge pull request #(\d+)|\(#(\d+)\)$")


def git(*args, root=ROOT):
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


def manifest_version(text):
    try:
        return json.loads(text).get("version") or ""
    except json.JSONDecodeError:
        return ""


def file_at(ref, path, root=ROOT):
    try:
        return git("show", f"{ref}:{path}", root=root)
    except subprocess.CalledProcessError:
        return ""


def bump(version, level):
    match = SEMVER.match(version or "")
    if not match:
        raise SystemExit(f"bump-plugin-version: {MANIFEST} 의 version 이 X.Y.Z 가 아니에요: {version!r}")
    major, minor, patch = (int(part) for part in match.groups())
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def added_lines(base, head, path, root=ROOT):
    names = git("diff", "--name-status", "--find-renames", base, head, root=root).splitlines()
    old = next((parts[1] for line in names if (parts := line.split("\t"))[0].startswith("R") and len(parts) == 3 and parts[2] == path), None)
    diff = git("diff", "--find-renames", "-U0", base, head, "--", *([old, path] if old else [path]), root=root)
    return [line[1:] for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++")]


def classify(base, head, changed, root=ROOT):
    """(등급, [(스킬, 새 버전)]) 을 돌려준다. 스킬은 CHANGELOG 가 든 폴더 경로다"""
    level = "patch"
    entries = []
    for path in changed:
        if not path.endswith("/CHANGELOG.md") or path in OWN_FILES:
            continue
        skill = Path(path).parent.name
        for line in added_lines(base, head, path, root):
            heading = VERSION_HEADING.match(line)
            if heading:
                entries.append((skill, heading.group(1)))
                if level == "patch":
                    level = "minor"
            elif COMPAT.match(line):
                level = "major"
    return level, entries


def pr_numbers(base, head, root=ROOT):
    numbers = []
    for subject in git("log", "--format=%s", f"{base}..{head}", root=root).splitlines():
        match = PR_NUMBER.search(subject)
        number = match and (match.group(1) or match.group(2))
        if number and number not in numbers:
            numbers.append(number)
    return numbers


def summary(entries, changed, prs):
    if entries:
        body = ", ".join(f"{skill} {version}" for skill, version in entries)
    else:
        places = sorted({path.split("/")[0] for path in changed})
        body = "바뀐 곳: " + ", ".join(places)
    refs = " ".join(f"#{number}" for number in prs)
    return f"- {body}" + (f" ({refs})" if refs else "")


def prepend(changelog, version, day, line):
    heading = f"## {version} ({day})\n\n{line}\n"
    lines = changelog.splitlines(keepends=True)
    for index, text in enumerate(lines):
        if text.startswith("## "):
            return "".join(lines[:index]) + heading + "\n" + "".join(lines[index:])
    return changelog.rstrip("\n") + "\n\n" + heading


def run(base, head, day, root=ROOT):
    if not base or base == ZERO:
        base = git("rev-parse", f"{head}~1", root=root).strip()
    changed = [path for path in git("diff", "--name-only", base, head, root=root).splitlines() if path]
    if manifest_version(file_at(base, MANIFEST, root)) != manifest_version(file_at(head, MANIFEST, root)):
        return "skip: 이번 변경이 version 을 이미 바꿨어요"
    changed = [path for path in changed if path not in OWN_FILES]
    if not changed:
        return "skip: 플러그인 버전 파일 말고 바뀐 것이 없어요"
    level, entries = classify(base, head, changed, root)
    manifest_path = root / MANIFEST
    manifest_text = manifest_path.read_text(encoding="utf-8")
    version = bump(manifest_version(manifest_text), level)
    # 키 순서와 들여쓰기를 지키려고 version 줄만 바꾼다
    updated, count = re.subn(r'("version"\s*:\s*")[^"]*(")', lambda m: m.group(1) + version + m.group(2), manifest_text, count=1)
    if count != 1:
        raise SystemExit(f"bump-plugin-version: {MANIFEST} 에 version 칸이 없어요")
    manifest_path.write_text(updated, encoding="utf-8")
    changelog_path = root / CHANGELOG
    changelog_path.write_text(prepend(changelog_path.read_text(encoding="utf-8"), version, day,
                                      summary(entries, changed, pr_numbers(base, head, root))), encoding="utf-8")
    return version


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="", help="push 전 main 커밋. 비었거나 0 이면 head 의 부모")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--date", default=date.today().isoformat())
    args = parser.parse_args(argv)
    print(run(args.base, args.head, args.date))
    return 0


if __name__ == "__main__":
    sys.exit(main())
