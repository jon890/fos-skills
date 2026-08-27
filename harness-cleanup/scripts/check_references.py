#!/usr/bin/env python3
"""하네스 지침 파일이 가리키는 대상이 실재하는지 확인한다.

검사 항목
  1. 마크다운 링크 `[텍스트](경로.md)`
  2. 백틱으로 감싼 repo 상대 경로
  3. 다른 문서의 섹션 참조 — `"섹션명" 섹션` / `"섹션명" 표`
  4. 스킬 참조 — `` `이름` skill ``

Usage: python3 check_references.py [repo-root]
종료 코드: 깨진 참조가 있으면 1
"""
import pathlib
import re
import sys

from target_files import iter_targets

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# 경로처럼 보이는 백틱 조각. 디렉터리 구분자를 포함해야 경로로 본다.
PATH_IN_BACKTICK = re.compile(r"`([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+/?)`")
MD_LINK = re.compile(r"\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)")
SECTION_REF = re.compile(r"`([A-Za-z0-9_./-]+\.md)`\s*(?:의|에)?\s*[\"“]([^\"”]{2,60})[\"”]\s*(섹션|표|절)")
SKILL_REF = re.compile(r"`([a-z][a-z0-9-]+)`\s*(?:skill|스킬)")

# 검사에서 제외 — 플레이스홀더, 홈 경로, 와일드카드, URL
#   `../..` 로 시작하는 깊은 상대 경로를 여기서 빼면 안 된다.
#   이 스킬은 조건부 절을 `references/` 로 내리라고 처방하고, 그렇게 옮기면 링크가
#   한 단 깊어져 정확히 그 형태가 된다. 스킬이 시킨 작업이 만드는 링크를
#   스킬의 검사기가 안 보게 된다. 저장소 밖으로 나가는지는 해석 결과로 판정한다.
SKIP = re.compile(r"[<>{}*]|^~|^\$|^https?:")


def targets():
    return [path for path in iter_targets(ROOT) if path.resolve().is_relative_to(ROOT)]


def installed_skills():
    """설치된 스킬 이름 — 홈과 repo 양쪽."""
    names = set()
    for base in [
        pathlib.Path.home() / ".claude/skills",
        pathlib.Path.home() / ".codex/skills",
        ROOT / ".claude/skills",
        ROOT / ".agents/skills",
        ROOT / "skills",
    ]:
        if base.is_dir():
            for d in base.iterdir():
                names.add(d.name)
    for skill_file in iter_targets(ROOT):
        if skill_file.name == "SKILL.md" and skill_file.resolve().is_relative_to(ROOT):
            names.add(skill_file.parent.name)
    # 플러그인 스킬
    plug = pathlib.Path.home() / ".claude/plugins"
    if plug.is_dir():
        for p in plug.rglob("skills/*"):
            if p.is_dir():
                names.add(p.name)
    return names


def bundle_root(path):
    """스킬 번들 안의 파일이면 SKILL.md 를 가진 디렉터리를 돌려준다."""
    for parent in path.parents:
        if (parent / "SKILL.md").exists():
            return parent
        if parent == ROOT:
            break
    return None


def headers(path):
    """파일의 헤더 텍스트 집합."""
    out = set()
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^#{1,6}\s+(.*)$", line)
        if m:
            out.add(m.group(1).strip())
    return out


def main():
    skills = installed_skills()
    broken = []

    for f in targets():
        rel = f.relative_to(ROOT)
        text = f.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()

        for i, line in enumerate(lines, 1):
            # 1) 마크다운 링크
            for link in MD_LINK.findall(line):
                if SKIP.search(link):
                    continue
                target = (f.parent / link.split("#", 1)[0]).resolve()
                # 저장소 밖을 가리키는 경로는 판정 대상이 아니다.
                #   상대 경로가 몇 단을 올라가든 해석한 뒤에 경계를 따진다.
                if not target.is_relative_to(ROOT):
                    continue
                if not target.is_file():
                    broken.append((rel, i, "링크", link))

            # 2) 백틱 경로 — repo 상대 경로로 해석
            for cand in PATH_IN_BACKTICK.findall(line):
                if SKIP.search(cand):
                    continue
                bare = cand.rstrip("/")
                normalized = bare[2:] if bare.startswith("./") else bare
                bases = [ROOT, *[parent for parent in f.parents if parent.is_relative_to(ROOT)]]
                if any((base / bare).exists() for base in bases):
                    continue
                # 스킬 번들 안의 문서는 번들 root 기준 상대 경로를 쓴다 (예: scripts 아래 파일)
                bundle = bundle_root(f)
                if bundle and (bundle / bare).exists():
                    continue
                # 저장소 루트의 배포용 스킬은 대상 프로젝트에 생성할 경로를 계약으로 적는다.
                # 이 경로를 스킬 원본 저장소 안에서 찾으면 정상 지침을 깨진 참조로 오인한다.
                if (
                    bundle
                    and bundle.parent == ROOT
                    and not normalized.startswith(("assets/", "references/", "scripts/"))
                ):
                    continue
                # repo 밖 경로(홈 설정 등)는 판정 대상이 아니다
                if normalized.startswith((
                    ".claude/",
                    ".github/",
                    "assets/",
                    "docs/",
                    "references/",
                    "scripts/",
                    "skills/",
                    "src/",
                    "tasks/",
                )):
                    broken.append((rel, i, "경로", cand))

            # 3) 섹션 참조
            for doc, section, kind in SECTION_REF.findall(line):
                if SKIP.search(doc):
                    continue
                target = ROOT / doc if (ROOT / doc).exists() else (f.parent / doc)
                if not target.is_file():
                    continue  # 경로 자체는 2번에서 잡힌다
                hs = headers(target)
                if not any(section in h for h in hs):
                    broken.append((rel, i, f"{kind}명", f"{doc} → \"{section}\""))

            # 4) 스킬 참조
            for name in SKILL_REF.findall(line):
                if name not in skills:
                    broken.append((rel, i, "스킬", name))

    if not broken:
        print("깨진 참조 0건")
        return 0

    print(f"깨진 참조 {len(broken)}건\n")
    for rel, i, kind, what in broken:
        print(f"  {rel}:{i}  [{kind}] {what}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
