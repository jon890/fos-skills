#!/usr/bin/env python3
"""스킬 README 와 CHANGELOG 가 저장소 README 의 「스킬 README」, 「버전과 변경 이력」 형식을 따르는지 검사한다.

사용: python3 scripts/check-skill-docs.py [스킬 이름 ...]
인자가 없으면 SKILL.md 가 있는 모든 디렉터리를 본다. 위반을 한 줄씩 내고, 하나라도 있으면 종료 코드 1 이다.

PENDING_README, PENDING_CHANGELOG 는 아직 새 형식으로 옮기지 않은 스킬이다. 옮기면 목록에서 뺀다.
목록에 남은 스킬이 이미 형식을 지키면 그것도 위반으로 낸다. 옮긴 뒤 목록에 남아 검사를 피하지 않게 하려는 것이다.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

README_SECTIONS = ("이럴 때 쓴다", "사용 예시", "받는 것", "함께 쓰는 스킬")
README_FORBIDDEN = ("구성",)
MAX_VERSION_BULLETS = 5
MAX_SUMMARY_BULLETS = 8
MAX_BULLET_CHARS = 160

PENDING_README = {
    "content-preview",
    "docs-check",
    "harness-cleanup",
    "korean-check",
    "orch",
    "planning",
    "pr-review",
    "review-fix",
}
PENDING_CHANGELOG = set(PENDING_README)

VERSION_HEADING = re.compile(r"(\d+)\.(\d+)\.(\d+) \(\d{4}-\d{2}-\d{2}\)")
SUMMARY_HEADING = re.compile(r"(\d+)\.x")
SKILL_VERSION = re.compile(r'^\s+version:\s*"?([0-9][0-9.]*)"?\s*$', re.M)


def split_sections(text):
    """(첫 `## ` 앞의 줄, [(제목, 본문 줄)]) 을 돌려준다. 코드 블록 안의 `## ` 은 제목으로 보지 않는다."""
    intro, sections, fenced = [], [], False
    for line in text.splitlines()[1:]:
        if line.startswith("```"):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            sections.append((line[3:].strip(), []))
        elif sections:
            sections[-1][1].append(line)
        else:
            intro.append(line)
    return intro, sections


def check_readme(name, text):
    problems = []
    if text.splitlines()[:1] != [f"# {name}"]:
        problems.append(f"첫 줄이 `# {name}` 이 아니다")
    intro, sections = split_sections(text)
    if not any(line.strip() for line in intro):
        problems.append("제목 밑에 이 스킬이 덜어 주는 수고를 적은 첫 문단이 없다")
    headings = [heading for heading, _ in sections]
    for heading in README_FORBIDDEN:
        if heading in headings:
            problems.append(f"`## {heading}` 절을 두지 않는다. 파일 구성은 SKILL.md 와 docstring 이 소유한다")
    missing = [heading for heading in README_SECTIONS if heading not in headings]
    if missing:
        problems.append("빠진 절: " + ", ".join(f"`## {heading}`" for heading in missing))
    present = [heading for heading in headings if heading in README_SECTIONS]
    if not missing and present != list(README_SECTIONS):
        problems.append("절 순서가 다르다: " + " > ".join(README_SECTIONS))
    return problems


def check_changelog(name, text, skill_version):
    problems = []
    if text.splitlines()[:1] != [f"# CHANGELOG: {name}"]:
        problems.append(f"첫 줄이 `# CHANGELOG: {name}` 이 아니다")
    _, sections = split_sections(text)
    if not sections:
        return problems + ["버전 절이 없다"]
    first = VERSION_HEADING.fullmatch(sections[0][0])
    if not first:
        return problems + [f"첫 절 `## {sections[0][0]}` 이 `## X.Y.Z (YYYY-MM-DD)` 꼴이 아니다"]
    if sections[0][0].split()[0] != skill_version:
        problems.append(f"첫 절의 버전이 SKILL.md 의 {skill_version} 과 다르다")
    current = int(first.group(1))
    for heading, body in sections:
        version, summary = VERSION_HEADING.fullmatch(heading), SUMMARY_HEADING.fullmatch(heading)
        if version:
            limit = MAX_VERSION_BULLETS
            if int(version.group(1)) != current:
                problems.append(f"`## {heading}`: 이전 major 는 `## {version.group(1)}.x` 한 절로 줄인다")
        elif summary:
            limit = MAX_SUMMARY_BULLETS
            if int(summary.group(1)) >= current:
                problems.append(f"`## {heading}`: 현재 major 는 버전마다 절을 둔다")
        else:
            problems.append(f"`## {heading}`: `X.Y.Z (YYYY-MM-DD)` 나 `N.x` 꼴이 아니다")
            continue
        lines = [line for line in body if line.strip()]
        bullets = [line for line in lines if line.startswith("- ")]
        if len(bullets) != len(lines):
            problems.append(f"`## {heading}`: 목록 항목이 아닌 줄이 있다")
        if not bullets:
            problems.append(f"`## {heading}`: 항목이 없다")
        if len(bullets) > limit:
            problems.append(f"`## {heading}`: 항목이 {len(bullets)}개로 상한 {limit}개를 넘는다")
        for bullet in bullets:
            if len(bullet) - 2 > MAX_BULLET_CHARS:
                problems.append(f"`## {heading}`: {MAX_BULLET_CHARS}자를 넘는 항목이 있다: {bullet[:40]}…")
    return problems


def judge(label, problems, pending, pending_name):
    if not pending:
        return [f"{label}: {problem}" for problem in problems]
    if not problems:
        return [f"{label}: 새 형식을 지킨다. {pending_name} 에서 뺀다"]
    return []


def check_skill(name, root=ROOT):
    skill_dir = root / name
    match = SKILL_VERSION.search((skill_dir / "SKILL.md").read_text(encoding="utf-8"))
    readme = (skill_dir / "README.md").read_text(encoding="utf-8")
    changelog = (skill_dir / "CHANGELOG.md").read_text(encoding="utf-8")
    return judge(
        f"{name}/README.md", check_readme(name, readme), name in PENDING_README, "PENDING_README"
    ) + judge(
        f"{name}/CHANGELOG.md",
        check_changelog(name, changelog, match.group(1) if match else ""),
        name in PENDING_CHANGELOG,
        "PENDING_CHANGELOG",
    )


def skill_names(root=ROOT):
    return sorted(child.name for child in root.iterdir() if (child / "SKILL.md").is_file())


def main(argv):
    problems = [problem for name in (argv or skill_names()) for problem in check_skill(name)]
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
