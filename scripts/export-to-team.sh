#!/usr/bin/env bash
# 공용 스킬을 팀 저장소로 내보낸다.
#
# 이 저장소가 원본이다. 팀 저장소의 것은 사본이므로 거기서 고치면 다음 내보내기에 덮인다.
# 팀원이 저장소를 둘 받지 않아도 되게 사본을 두는 대신, 어긋남을 이 스크립트가 잡는다.
#
# 사용법:
#   export-to-team.sh            어긋난 파일만 출력한다. 어긋나면 종료 코드 1
#   export-to-team.sh --apply    이 저장소의 내용을 팀 저장소로 복사한다
#
# 팀 저장소 위치는 TEAM_SKILLS_DIR 로 바꾼다. 없으면 검사를 건너뛰고 0 으로 끝난다.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_DIR="${TEAM_SKILLS_DIR:-$HOME/projects/AiSdtSkill}"

# 팀 저장소로 내보내는 스킬. 늘어나면 여기에 추가한다.
SHARED_SKILLS=(content-preview planning build-with-teams docs-check review-fix)

# 개인 자산이라 내보내지 않는 경로 (스킬 디렉터리 기준 상대 경로)
EXCLUDE=(references/work-writing-persona.md)

if [ ! -d "$TEAM_DIR/skills" ]; then
  echo "팀 저장소가 없어 건너뛴다: $TEAM_DIR"
  exit 0
fi

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

REPO_DIR="$REPO_DIR" TEAM_DIR="$TEAM_DIR" APPLY="$APPLY" \
SHARED="${SHARED_SKILLS[*]}" EXCLUDES="${EXCLUDE[*]}" python3 - <<'PYEOF'
import os
import pathlib
import re
import shutil
import sys

repo = pathlib.Path(os.environ["REPO_DIR"])
team = pathlib.Path(os.environ["TEAM_DIR"])
apply = os.environ["APPLY"] == "true"
skills = os.environ["SHARED"].split()
excludes = set(os.environ["EXCLUDES"].split())


def is_junk(rel: str) -> bool:
    """빌드 부산물과 git 내부 파일. 어느 스킬에서나 내보내지 않는다."""
    parts = rel.split("/")
    return (
        "__pycache__" in parts
        or ".git" in parts
        or ".DS_Store" in parts
        or rel.endswith((".pyc", ".pyo"))
    )


def to_team_frontmatter(text: str) -> str:
    """이 저장소의 metadata.version 을 팀 저장소가 검사하는 최상위 version 으로 바꾼다.

    두 저장소의 frontmatter 규약이 달라, 그대로 복사하면 팀 쪽 validate.sh 가 막는다.
    """
    return re.sub(
        r'^metadata:\n\s+version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\n',
        r"version: \1\n",
        text,
        count=1,
        flags=re.M,
    )


def rendered(src: pathlib.Path, rel: str) -> bytes:
    raw = src.read_bytes()
    if rel == "SKILL.md":
        return to_team_frontmatter(raw.decode("utf-8")).encode("utf-8")
    return raw


drift = []
for name in skills:
    s_dir = repo / name
    d_dir = team / "skills" / name
    if not s_dir.is_dir():
        print(f"이 저장소에 없는 스킬: {name}", file=sys.stderr)
        sys.exit(2)

    seen = set()
    for s in sorted(s_dir.rglob("*")):
        if not s.is_file():
            continue
        rel = s.relative_to(s_dir).as_posix()
        if rel in excludes or is_junk(rel):
            continue
        seen.add(rel)
        d = d_dir / rel
        want = rendered(s, rel)
        if not d.exists():
            drift.append(f"  없음   {name}/{rel}")
        elif d.read_bytes() != want:
            drift.append(f"  다름   {name}/{rel}")
        else:
            continue
        if apply:
            d.parent.mkdir(parents=True, exist_ok=True)
            d.write_bytes(want)
            shutil.copymode(s, d)

    # 이 저장소에서 지운 파일이 사본에만 남는 것도 어긋남이다.
    if d_dir.is_dir():
        for d in sorted(d_dir.rglob("*")):
            if not d.is_file():
                continue
            rel = d.relative_to(d_dir).as_posix()
            if rel in excludes or is_junk(rel) or rel in seen:
                continue
            drift.append(f"  남음   {name}/{rel}")
            if apply:
                d.unlink()

if not drift:
    print("팀 저장소의 사본이 원본과 같다.")
    sys.exit(0)

if apply:
    print("팀 저장소에 내보냈다:")
    print("\n".join(drift))
    print(f"\n{team} 에서 커밋해야 팀에 전파된다.")
    sys.exit(0)

print("팀 저장소의 사본이 원본과 어긋난다:")
print("\n".join(drift))
print(f"\n팀 저장소: {team}")
print("반영: scripts/export-to-team.sh --apply")
sys.exit(1)
PYEOF
