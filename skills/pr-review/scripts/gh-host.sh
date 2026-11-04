#!/usr/bin/env bash
# origin 리모트에서 gh 가 봐야 할 호스트 이름을 출력한다.
#
# 사용법:
#   GH_HOST=$(gh-host.sh)                     # 이후 같은 호출 안의 gh api 에 적용된다
#   gh api --hostname "$(gh-host.sh)" <경로>  # 한 번만 쓸 때
#
# gh api 는 --repo 를 받지 않아 기본 호스트를 본다.
# 사내 GHE 저장소에서 호스트를 넘기지 않으면 Not Found 가 난다.
# 결과가 github.com 이어도 그대로 넘긴다. 넘겨도 동작이 달라지지 않는다 (실측).
#
# 환경 변수는 호출 사이에 남지 않는다 (실측). 에이전트 하네스는 명령마다 새 셸을 띄운다.
# 그래서 이 값은 쓰는 쪽과 같은 호출 안에서 구한다.
# 이 저장소의 다른 스크립트는 스스로 이것을 부르므로 미리 export 할 필요가 없다.
#
# origin 이 SSH config 별칭이면 별칭이 그대로 나오므로 ssh -G 로 실제 호스트를 되찾는다.
# 실측: git@github-personal:... 이 github-personal 로 나왔고, 그대로 쓰면
#       "error connecting to github-personal" 로 실패했다. ssh -G 가 github.com 으로 되돌린다.
set -eu

# 호출자가 GH_HOST 를 지정했으면 그것을 존중한다. 오버레이가 호스트를 고정하는 경우가 있다.
[ -n "${GH_HOST:-}" ] && { printf '%s\n' "$GH_HOST"; exit 0; }

url=$(git remote get-url origin)
host=$(printf '%s' "$url" | sed -E 's#^[^@/]*@([^:/]+)[:/].*#\1#; s#^[a-z]+://([^/]+)/.*#\1#')
[ -n "$host" ] || { echo "origin 리모트에서 호스트를 읽지 못했다: $url" >&2; exit 1; }

resolved=$(ssh -G "$host" 2>/dev/null | awk '/^hostname /{print $2; exit}' || true)
[ -n "$resolved" ] && host="$resolved"

printf '%s\n' "$host"
