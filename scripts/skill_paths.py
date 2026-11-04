"""스킬 원본의 위치. 설치 대상과 내보내기 전용 원본은 분리하고 이름은 유지한다."""
from pathlib import Path

SKILL_ROOTS = ("skills", "export-only-skills")


def skill_dirs(root, legacy=False):
    root = Path(root)
    parents = [root / name for name in SKILL_ROOTS]
    if legacy:
        parents.append(root)
    found = {}
    for parent in parents:
        if not parent.is_dir():
            continue
        for child in sorted(parent.iterdir()):
            if not (child / "SKILL.md").is_file():
                continue
            if child.name in found:
                raise ValueError(f"스킬 원본이 둘이다: {child.name}")
            found[child.name] = child
    return found


def source_path(root, name):
    """내보내기의 옛 커밋·팀 배치도 읽는다. 새 원본은 SKILL_ROOTS 아래에 둔다."""
    root = Path(root)
    for parent in (*SKILL_ROOTS, ""):
        path = root / parent / name
        if path.is_dir():
            return path
    raise ValueError(f"스킬 원본이 없다: {name}")
