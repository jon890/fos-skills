#!/usr/bin/env bash
# origin 리모트에서 gh 가 봐야 할 호스트를 구해 export 문으로 출력한다.
#
# 사용법:
#   eval "$(~/.claude/skills/review-fix/scripts/gh-host.sh)"
#
# gh api 는 --repo 를 받지 않아 기본 호스트를 본다.
# 사내 GHE 저장소에서 GH_HOST 를 지정하지 않으면 Not Found 가 난다.
# 결과가 github.com 이어도 export 해 둔다. 지정해도 동작이 달라지지 않는다 (실측).
#
# origin 이 SSH config 별칭이면 별칭이 그대로 나오므로 ssh -G 로 실제 호스트를 되찾는다.
# 실측: git@github-personal:... 이 github-personal 로 나왔고, 그대로 쓰면
#       "error connecting to github-personal" 로 실패했다. ssh -G 가 github.com 으로 되돌린다.
set -eu

url=$(git remote get-url origin)
host=$(printf '%s' "$url" | sed -E 's#^[^@/]*@([^:/]+)[:/].*#\1#; s#^[a-z]+://([^/]+)/.*#\1#')

resolved=$(ssh -G "$host" 2>/dev/null | awk '/^hostname /{print $2; exit}' || true)
[ -n "$resolved" ] && host="$resolved"

printf 'export GH_HOST=%s\n' "$host"
