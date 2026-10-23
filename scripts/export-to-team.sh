#!/usr/bin/env bash
# 공용 스킬을 팀 저장소로 내보낸다.
#
# 이 저장소가 원본이다. 팀 저장소의 것은 사본이므로 거기서 고치면 다음 내보내기에 덮인다.
# 팀원이 저장소를 둘 받지 않아도 되게 사본을 두는 대신, 어긋남을 이 스크립트가 잡는다.
#
# 사용법:
#   export-to-team.sh            어긋난 파일만 출력한다. 어긋나면 종료 코드 1
#   export-to-team.sh --apply    이 저장소의 내용을 팀 저장소로 복사한다
#   --source-ref <커밋>          작업 트리 대신 그 커밋의 내용을 원본으로 쓴다. --apply 와 함께 쓸 수 있다
#
# 원본은 기본으로 이 저장소의 작업 트리다. 체크아웃이 다른 브랜치로 바뀌면 내보내는 내용도 바뀌므로,
# 다른 작업 중에 내보낼 때는 --source-ref origin/main 처럼 커밋을 준다.
# 결과 첫 줄에 원본의 커밋 SHA 를 적는다. 팀 저장소의 커밋 메시지에 옮겨 적으면 어느 원본을 냈는지 남는다.
#
# 팀 저장소 위치는 TEAM_SKILLS_DIR 로 바꾼다. 없으면 검사를 건너뛰고 0 으로 끝난다.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEAM_DIR="${TEAM_SKILLS_DIR:-$HOME/projects/AiSdtSkill}"

# 팀 저장소로 내보내는 스킬. 늘어나면 여기에 추가한다.
SHARED_SKILLS=(content-preview planning build-with-teams docs-check review-fix korean-check)

# 스킬이 아닌 공용 도구. 이 저장소의 tools/<이름> 이 팀 저장소의 tools/<이름> 이 된다.
SHARED_TOOLS=(browser-driver)

# 개인 자산이라 내보내지 않는 경로 (스킬 디렉터리 기준 상대 경로)
EXCLUDE=(references/work-writing-persona.md)

APPLY=false
SOURCE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)       APPLY=true; shift ;;
    --source-ref)
      case "${2:-}" in
        ""|-*) echo "--source-ref 뒤에 커밋이나 브랜치를 준다" >&2; exit 2 ;;
      esac
      SOURCE_REF="$2"; shift 2 ;;
    *)             echo "알 수 없는 인자: $1  (쓸 수 있는 것은 --apply, --source-ref 다)" >&2; exit 2 ;;
  esac
done

# 잘못된 ref 는 팀 저장소가 없는 환경에서도 드러나게, 팀 저장소 확인보다 앞에서 푼다.
if [ -n "$SOURCE_REF" ]; then
  SOURCE_SHA="$(git -C "$REPO_DIR" rev-parse --verify --quiet "${SOURCE_REF}^{commit}")" \
    || { echo "커밋을 찾지 못했다: $SOURCE_REF" >&2; exit 2; }
fi

if [ ! -d "$TEAM_DIR/skills" ]; then
  echo "팀 저장소가 없어 건너뛴다: $TEAM_DIR"
  exit 0
fi

# 원본 디렉터리와 결과에 적을 원본 설명을 정한다.
SRC_DIR="$REPO_DIR"
if [ -n "$SOURCE_REF" ]; then
  SRC_DIR="$(mktemp -d)"
  trap 'rm -rf "$SRC_DIR"' EXIT
  # .gitattributes 의 export-ignore 가 붙은 파일은 archive 에서 빠져 팀 쪽 사본이 「남음」 으로 지워진다.
  # 이 경로는 추적하는 파일만 원본으로 본다. 기본 경로는 작업 트리의 추적하지 않는 파일도 본다.
  # 내보내는 디렉터리만 풀어 양을 줄인다.
  # 그 커밋에 내보낼 디렉터리가 없으면 pathspec 오류이므로 기본 경로와 같게 종료 코드 2 로 끝낸다.
  git -C "$REPO_DIR" archive "$SOURCE_SHA" -- "${SHARED_SKILLS[@]}" "${SHARED_TOOLS[@]/#/tools/}" | tar -x -C "$SRC_DIR" \
    || { echo "그 커밋에 내보낼 디렉터리가 없다: $SOURCE_REF" >&2; exit 2; }
  SOURCE_DESC="$SOURCE_REF ($SOURCE_SHA)"
else
  # git archive 로 푼 사본처럼 git 저장소가 아니어도 기본 경로는 돌아야 한다. SHA 와 변경 표시만 생략한다.
  if SOURCE_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"; then
    SOURCE_DESC="작업 트리 (HEAD $SOURCE_SHA)"
    if [ -n "$(git -C "$REPO_DIR" status --porcelain -- "${SHARED_SKILLS[@]}" "${SHARED_TOOLS[@]/#/tools/}")" ]; then
      SOURCE_DESC="$SOURCE_DESC, 커밋하지 않은 변경 있음"
    fi
  else
    SOURCE_DESC="작업 트리 (git 저장소 아님)"
  fi
fi
echo "원본: $SOURCE_DESC"

REPO_DIR="$SRC_DIR" TEAM_DIR="$TEAM_DIR" APPLY="$APPLY" \
SHARED="${SHARED_SKILLS[*]}" TOOLS="${SHARED_TOOLS[*]}" EXCLUDES="${EXCLUDE[*]}" python3 - <<'PYEOF'
import os
import pathlib
import re
import shutil
import sys

repo = pathlib.Path(os.environ["REPO_DIR"])
team = pathlib.Path(os.environ["TEAM_DIR"])
apply = os.environ["APPLY"] == "true"
skills = os.environ["SHARED"].split()
tools = os.environ["TOOLS"].split()
excludes = set(os.environ["EXCLUDES"].split())

# 내보낼 (이 저장소 기준 경로, 팀 저장소 기준 경로) 쌍.
# 스킬은 repo/<이름> 이 team/skills/<이름> 이 되고, 도구는 tools/ 아래에서 이름이 같다.
PAIRS = [(name, f"skills/{name}") for name in skills]
PAIRS += [(f"tools/{name}", f"tools/{name}") for name in tools]


def is_junk(rel: str) -> bool:
    """빌드 부산물, git 내부 파일, 런타임 상태. 어느 스킬에서나 내보내지 않는다."""
    parts = rel.split("/")
    return (
        "__pycache__" in parts
        or ".git" in parts
        or ".omc" in parts
        or ".orch" in parts
        or ".DS_Store" in parts
        or rel.endswith((".pyc", ".pyo"))
    )


VERSION_RE = re.compile(
    r'^(?:metadata:\n\s+version:\s*"?|version:\s*"?)([0-9]+)\.([0-9]+)\.([0-9]+)"?\s*$',
    re.M,
)


def version_of(text: str):
    """SKILL.md frontmatter 의 버전. 두 저장소의 표기가 달라 둘 다 읽는다."""
    m = VERSION_RE.search(text)
    return tuple(int(g) for g in m.groups()) if m else None


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


# 방향 보호. 이 저장소가 원본이라는 전제는 이쪽 버전이 뒤처지지 않았을 때만 성립한다.
# 팀 쪽에서 직접 고친 뒤 버전을 올리면 --apply 가 그것을 옛 내용으로 되돌린다 (실측).
# 한 파일도 건드리기 전에 전부 본다. 복사하면서 검사하면 뒤 스킬에서 막아도 앞 스킬은 이미 덮인다.
regressions = []
for src_rel, dst_rel in PAIRS:
    if not (repo / src_rel).is_dir():
        print(f"이 저장소에 없다: {src_rel}", file=sys.stderr)
        sys.exit(2)
    s_skill = repo / src_rel / "SKILL.md"
    d_skill = team / dst_rel / "SKILL.md"
    if not (s_skill.is_file() and d_skill.is_file()):
        continue
    ours = version_of(s_skill.read_text(encoding="utf-8"))
    theirs = version_of(d_skill.read_text(encoding="utf-8"))
    if ours and theirs and theirs > ours:
        regressions.append(
            f"  {src_rel}: 팀 {'.'.join(map(str, theirs))} > 이 저장소 {'.'.join(map(str, ours))}"
        )

if regressions:
    print("팀 저장소의 버전이 더 높다. 내보내면 팀의 수정을 되돌린다:")
    print("\n".join(regressions))
    print("\n팀 쪽 변경을 이 저장소로 먼저 가져온 뒤 다시 실행한다.")
    sys.exit(3)

drift = []
for src_rel, dst_rel in PAIRS:
    s_dir = repo / src_rel
    d_dir = team / dst_rel

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
            drift.append(f"  없음   {dst_rel}/{rel}")
        elif d.read_bytes() != want:
            drift.append(f"  다름   {dst_rel}/{rel}")
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
            drift.append(f"  남음   {dst_rel}/{rel}")
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
