"""스킬 변경 이력 조각의 규칙. 검사기와 머지 workflow 의 버전 상향이 이 한 곳을 쓴다.

PR 은 `<단위>/changes/<슬러그>.<등급>.md` 조각만 더하고, main 에 머지될 때 workflow 가 조각마다 버전을 올려
CHANGELOG 절을 만든다. 근거는 docs/adr/023-version-at-merge.md 다.

단위는 `skills/<이름>`, `export-only-skills/<이름>`, `extensions/<이름>` 가운데 CHANGELOG.md 가 있는 폴더다.
조각은 `- ` 항목 1~5개이고 등급은 파일 이름 접미(`.patch.md`, `.minor.md`)다. major 는 조각으로 받지 않는다.
"""

import re
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from skill_paths import SKILL_ROOTS

UNIT_ROOTS = (*SKILL_ROOTS, "extensions")
CHANGES_DIR = "changes"
MAX_BULLETS = 5
MAX_BULLET_CHARS = 160
LEVELS = ("patch", "minor")

FRAGMENT_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*\.(patch|minor)\.md$")
VERSION_HEADING = re.compile(r"^## (\d+)\.(\d+)\.(\d+) \(\d{4}-\d{2}-\d{2}\)")
SKILL_VERSION_LINE = re.compile(r'^(\s+version:\s*")(\d+\.\d+\.\d+)(")\s*$', re.M)


def unit_dirs(root):
    """CHANGELOG.md 가 있는 단위 폴더를 이름순으로 돌려준다."""
    root = Path(root)
    found = []
    for parent in UNIT_ROOTS:
        base = root / parent
        if base.is_dir():
            found += [child for child in sorted(base.iterdir()) if (child / "CHANGELOG.md").is_file()]
    return found


def check_fragment(name, text):
    """조각 하나의 문제 목록. 이름은 파일 이름, 내용은 파일 본문이다."""
    problems = []
    if not FRAGMENT_NAME.match(name):
        problems.append("이름이 `<슬러그>.patch.md` 나 `<슬러그>.minor.md` 꼴이 아니다(슬러그는 영문 소문자, 숫자, 하이픈)")
    lines = [line for line in text.splitlines() if line.strip()]
    bullets = [line for line in lines if line.startswith("- ")]
    if len(bullets) != len(lines):
        problems.append("목록 항목(`- `)이 아닌 줄이 있다")
    if not lines:
        problems.append("항목이 없다")
    if len(bullets) > MAX_BULLETS:
        problems.append(f"항목이 {len(bullets)}개로 상한 {MAX_BULLETS}개를 넘는다")
    if any(not bullet[2:].strip() for bullet in bullets):
        # 적용 때 절 끝 공백을 지우면 `-` 만 남아 CHANGELOG 검사에서 실패한다
        problems.append("내용이 빈 항목(`- `)이 있다")
    for bullet in bullets:
        if len(bullet) - 2 > MAX_BULLET_CHARS:
            problems.append(f"{MAX_BULLET_CHARS}자를 넘는 항목이 있다: {bullet[:40]}…")
        if bullet.startswith("- 호환성:"):
            problems.append("`호환성:` 항목은 조각으로 받지 않는다. major 는 PR 이 버전과 CHANGELOG 를 직접 올린다")
    return problems


def check_changes(root):
    """저장소의 모든 조각을 검사해 `<경로>: <이유>` 줄을 돌려준다."""
    root = Path(root)
    problems = []
    for unit in unit_dirs(root):
        folder = unit / CHANGES_DIR
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            rel = path.relative_to(root).as_posix()
            if not path.is_file():
                problems.append(f"{rel}: 파일이 아니다")
                continue
            problems += [f"{rel}: {problem}" for problem in check_fragment(path.name, path.read_text(encoding="utf-8"))]
    return problems


def next_version(version, level):
    major, minor, patch = (int(part) for part in version.split("."))
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def today_seoul():
    return datetime.now(ZoneInfo("Asia/Seoul")).date().isoformat()


def _added_order(root):
    """main 첫째 부모 기준으로 파일이 마지막에 더해진 순서. 머지 커밋은 PR 이 더한 파일을 머지 순서로 낸다."""
    try:
        out = subprocess.run(
            ["git", "log", "--reverse", "--first-parent", "-m", "--diff-filter=A", "--name-only", "--format=", "--", *UNIT_ROOTS],
            cwd=root, check=True, capture_output=True, text=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}
    # 같은 경로를 지웠다 다시 더한 경우(슬러그 재사용)는 마지막에 더한 자리를 쓴다
    return {line: index for index, line in enumerate(out.splitlines()) if line}


def fragments(root, unit):
    """단위의 조각 파일을 머지 순서로 돌려준다. 순서를 모르는 것은 뒤에서 이름순이다."""
    folder = unit / CHANGES_DIR
    if not folder.is_dir():
        return []
    order = _added_order(root)
    files = [path for path in folder.iterdir() if path.is_file()]
    return sorted(files, key=lambda path: (order.get(path.relative_to(root).as_posix(), len(order)), path.name))


def current_version(changelog_text):
    for line in changelog_text.splitlines():
        match = VERSION_HEADING.match(line)
        if match:
            return ".".join(match.groups())
    return None


def prepend_section(changelog_text, version, day, body):
    heading = f"## {version} ({day})\n\n{body.strip()}\n"
    lines = changelog_text.splitlines(keepends=True)
    for index, text in enumerate(lines):
        if text.startswith("## "):
            return "".join(lines[:index]) + heading + "\n" + "".join(lines[index:])
    return changelog_text.rstrip("\n") + "\n\n" + heading


def apply_fragments(root, day=None):
    """조각마다 버전 하나를 올리고 조각을 지운다. ([(단위 이름, 새 버전)], [경고]) 를 돌려준다.

    틀린 조각과 읽을 수 없는 단위는 경고만 내고 건너뛴다. 조각이 없는 단위는 건드리지 않는다.
    """
    root = Path(root)
    day = day or today_seoul()
    applied, warnings = [], []
    for unit in unit_dirs(root):
        pending = fragments(root, unit)
        if not pending:
            continue
        changelog_path = unit / "CHANGELOG.md"
        text = changelog_path.read_text(encoding="utf-8")
        version = current_version(text)
        if not version:
            warnings.append(f"{unit.relative_to(root).as_posix()}/CHANGELOG.md: 첫 버전 절을 읽을 수 없어 조각을 건너뛴다")
            continue
        skill_md = unit / "SKILL.md"
        skill_text = skill_md.read_text(encoding="utf-8") if skill_md.is_file() else None
        if skill_text is not None and not SKILL_VERSION_LINE.search(skill_text):
            warnings.append(f"{unit.relative_to(root).as_posix()}/SKILL.md: metadata.version 줄을 찾지 못해 조각을 건너뛴다")
            continue
        for path in pending:
            body = path.read_text(encoding="utf-8")
            problems = check_fragment(path.name, body)
            if problems:
                warnings.append(f"{path.relative_to(root).as_posix()}: {problems[0]}. 건너뛴다")
                continue
            version = next_version(version, path.name.split(".")[-2])
            text = prepend_section(text, version, day, body)
            if skill_text is not None:
                skill_text = SKILL_VERSION_LINE.sub(lambda m: m.group(1) + version + m.group(3), skill_text, count=1)
            path.unlink()
            applied.append((unit.name, version))
        changelog_path.write_text(text, encoding="utf-8")
        folder = unit / CHANGES_DIR
        if not any(folder.iterdir()):
            folder.rmdir()
        if skill_text is not None:
            skill_md.write_text(skill_text, encoding="utf-8")
    return applied, warnings
