#!/usr/bin/env bash
# 사용:
#   make-worktree.sh --repo <저장소> --spec <지시서> --name <워크트리 이름> [--base <기준 브랜치>]
#   make-worktree.sh --check <워크트리> --spec <지시서>
#
# 만들기: 지시서의 줄 머리 `브랜치: `<이름>`` 줄에서 브랜치 이름을 읽어(본문 문장 안의 언급은 읽지 않고, 줄 머리 줄이 둘이면 종료 코드 2)
#   `git worktree add -b <이름> <저장소>/worktrees/<저장소 이름>/<워크트리 이름> origin/<기준 브랜치>` 로 만든다.
#   Orca 의 `--worktree new-top-level` 은 브랜치 이름을 `<git 사용자>/<워크트리 이름>` 으로 정해 지시서와 어긋난다.
#   워크트리를 먼저 만들고 `worker-start --worktree path:<경로>` 로 띄우면 worker 가 이름을 바꾸지 않는다.
#   같은 자리에서 `/worktrees/` 를 `.git/info/exclude` 에 더하고 `.claude/settings.local.json` 을 복사한다.
#   그 설정에 `worktree-deny.py` 로 pkill, killall, browser-driver reset, gh pr merge 의 deny 규칙을 더한다.
#   성공하면 표준 출력에 워크트리 경로 한 줄만 낸다. 거부 이유는 표준 오류로 낸다.
#   --base 를 주지 않으면 origin/HEAD 가 가리키는 브랜치, 그것도 없으면 main 이다. `origin/` 접두는 떼어 읽는다.
#   upstream 은 설정하지 않는다. push 전에 설정하면 원격 브랜치가 없어 upstream 이 gone 으로 보이고,
#   cleanup-sweep.py 가 커밋 0 개인 그 브랜치를 머지된 것으로 읽는다. worker 는 `git push -u origin HEAD` 로 올린다.
#
# 검사(--check): 워크트리의 브랜치, upstream, 원격 브랜치 끝 커밋이 지시서 값과 맞는지 본다. 완료 검증에서 쓴다.
#
# 종료 코드: 0 성공, 1 거부나 불일치(이유를 낸다), 2 사용법 오류나 지시서에 브랜치 줄이 없다
set -u

repo="" spec="" name="" base="" check=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo=${2:?--repo 에 경로가 필요하다}; shift 2 ;;
    --spec) spec=${2:?--spec 에 경로가 필요하다}; shift 2 ;;
    --name) name=${2:?--name 에 이름이 필요하다}; shift 2 ;;
    --base) base=${2:?--base 에 브랜치가 필요하다}; shift 2 ;;
    --check) check=${2:?--check 에 워크트리 경로가 필요하다}; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done

[ -n "$spec" ] || { echo "--spec 이 필요하다" >&2; exit 2; }
[ -f "$spec" ] || { echo "지시서가 없다: $spec" >&2; exit 2; }
# 줄 머리의 `브랜치: `<이름>`` 줄만 읽는다. 앞 공백, `-` 목록 기호, `**` 강조는 허용한다. 본문 문장 안의 언급은 읽지 않는다
branch_lines=$(grep -E '^[[:space:]]*(-[[:space:]]+)?(\*\*)?브랜치(\*\*)?:(\*\*)?[[:space:]]*`[^`]+`' "$spec")
if [ -n "$branch_lines" ] && [ "$(printf '%s\n' "$branch_lines" | wc -l)" -gt 1 ]; then
  echo "지시서에 줄 머리 \`브랜치:\` 줄이 둘 이상이다: $spec" >&2
  printf '%s\n' "$branch_lines" | sed 's/^/  /' >&2
  exit 2
fi
branch=$(printf '%s\n' "$branch_lines" | sed -nE 's/^[[:space:]]*(-[[:space:]]+)?(\*\*)?브랜치(\*\*)?:(\*\*)?[[:space:]]*`([^`]+)`.*/\5/p')
[ -n "$branch" ] || { echo "지시서에 줄 머리 \`브랜치: \`<이름>\`\` 줄이 없다: $spec" >&2; exit 2; }
git check-ref-format --branch "$branch" >/dev/null 2>&1 || { echo "브랜치 이름이 올바르지 않다: $branch" >&2; exit 2; }

if [ -n "$check" ]; then
  fail=0
  current=$(git -C "$check" branch --show-current 2>/dev/null)
  if [ "$current" != "$branch" ]; then echo "불일치: 브랜치 $current, 지시서 $branch"; fail=1; fi
  upstream=$(git -C "$check" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)
  if [ "$upstream" != "origin/$branch" ]; then echo "불일치: upstream ${upstream:-(없음)}, 지시서 origin/$branch"; fail=1; fi
  remote_tip=$(git -C "$check" ls-remote origin "refs/heads/$branch" 2>/dev/null | cut -f1)
  head=$(git -C "$check" rev-parse HEAD 2>/dev/null)
  if [ "$remote_tip" != "$head" ]; then echo "불일치: 원격 origin/$branch 끝 ${remote_tip:-(없음)}, 로컬 HEAD $head"; fail=1; fi
  [ "$fail" = 0 ] && echo "일치: $branch (HEAD $head)"
  exit "$fail"
fi

[ -n "$repo" ] && [ -n "$name" ] || { echo "--repo 와 --name 이 필요하다" >&2; exit 2; }
repo=$(cd "$repo" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || { echo "git 저장소가 아니다: $repo" >&2; exit 2; }
git -C "$repo" fetch -q origin || { echo "git fetch origin 실패" >&2; exit 1; }
if [ -z "$base" ]; then
  base=$(git -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  base=${base:-origin/main}
fi
base=${base#origin/}
git -C "$repo" rev-parse --verify -q "refs/remotes/origin/$base" >/dev/null || { echo "origin/$base 가 없다" >&2; exit 1; }

wt="$repo/worktrees/$(basename "$repo")/$name"
[ -e "$wt" ] && { echo "거부: 경로가 이미 있다: $wt. 이어서 하는 일이면 --worktree path: 로 띄운다" >&2; exit 1; }
git -C "$repo" rev-parse --verify -q "refs/heads/$branch" >/dev/null &&
  { echo "거부: 로컬 브랜치 $branch 가 이미 있다. 이어서 하는 일이면 그 워크트리에 띄운다" >&2; exit 1; }
git -C "$repo" rev-parse --verify -q "refs/remotes/origin/$branch" >/dev/null &&
  { echo "거부: 원격 브랜치 origin/$branch 가 이미 있다. 새 일이면 지시서의 브랜치 이름을 바꾼다" >&2; exit 1; }

git -C "$repo" worktree add -q --no-track -b "$branch" "$wt" "origin/$base" || exit 1

# 워크트리 폴더가 기준 브랜치의 `git add -A` 에 딸려 커밋되지 않게 로컬 전용 exclude 에 더한다
if ! git -C "$repo" check-ignore -q "worktrees/$(basename "$repo")/$name"; then
  exclude="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  printf '/worktrees/\n' >> "$exclude"
fi
# 추적되지 않는 로컬 권한 설정은 워크트리에 따라오지 않는다
if [ -f "$repo/.claude/settings.local.json" ]; then
  mkdir -p "$wt/.claude" && cp "$repo/.claude/settings.local.json" "$wt/.claude/"
fi
# 하위 에이전트의 pkill 과 browser-driver reset 이 다른 worker 의 호스트와 탭을 닫았다. 지시서 문장은 하위 에이전트까지 닿지 않는다
python3 "$(dirname "$0")/worktree-deny.py" "$wt" >&2 || echo "경고: deny 규칙을 더하지 못했다: $wt/.claude/settings.local.json" >&2
echo "$wt"
