#!/usr/bin/env python3
"""gh 가 봐야 할 호스트 이름을 낸다.

사용법:
    gh_host.py <owner> <repo>                                 # 그 저장소의 호스트
    gh_host.py                                                # 현재 디렉터리의 origin 으로 정한다
    gh api --hostname "$(gh_host.py <owner> <repo>)" <경로>   # 한 번만 쓸 때

`gh api` 는 `--repo` 를 받지 않아 기본 호스트를 본다.
사내 GHE 저장소에서 호스트를 넘기지 않으면 `Not Found` 가 난다.
결과가 `github.com` 이어도 그대로 넘긴다. 넘겨도 동작이 달라지지 않는다 (실측).

환경 변수는 호출 사이에 남지 않는다 (실측). 에이전트 하네스는 명령마다 새 셸을 띄운다.
그래서 이 값은 쓰는 쪽과 같은 호출 안에서 구한다.

## 저장소 이름으로 정한다

**`<owner> <repo>` 를 주면 현재 디렉터리를 보지 않는다.**
어디서 돌리든 같은 결과가 나온다.

현재 디렉터리를 보면 엉뚱한 호스트를 집는다.
실측으로 스킬 디렉터리에서 `collect_review.py` 를 돌렸더니 그 디렉터리가 속한 저장소의
`github.com` 을 집었고, 사내 GHE 저장소를 그 호스트에서 찾아 네 소스가 모두 404 로 끝났다.
저장소를 잘못 짚은 것이 아니라 호스트를 잘못 짚은 것이라 오류 문구에 원인이 드러나지 않는다.

정하는 순서는 셋이다.

1. `GH_HOST` 가 있으면 그것을 쓴다. 오버레이가 호스트를 고정하는 경우가 있다
2. `gh` 에 로그인된 호스트가 하나면 그것을 쓴다. 조회하지 않는다
3. 여럿이면 각 호스트에 그 저장소가 있는지 물어 맞는 것을 고른다

셋 다 실패하면 현재 디렉터리의 origin 으로 되돌아간다.

`<owner> <repo>` 없이 부르면 처음부터 현재 디렉터리의 origin 을 본다.
그 저장소 안에서 돌리는 것이 확실할 때만 이 형태를 쓴다.

origin 이 SSH config 별칭이면 별칭이 그대로 나오므로 `ssh -G` 로 실제 호스트를 되찾는다.
실측: `git@github-personal:...` 이 `github-personal` 로 나왔고, 그대로 쓰면
`error connecting to github-personal` 로 실패했다. `ssh -G` 가 `github.com` 으로 되돌린다.
"""

import os
import re
import subprocess
import sys

SCP_LIKE = re.compile(r"^[^@/]*@([^:/]+)[:/]")
URL_LIKE = re.compile(r"^[a-z]+://([^/]+)/")


def _run(argv):
    try:
        done = subprocess.run(argv, capture_output=True, text=True)
    except OSError:
        return None
    return done.stdout if done.returncode == 0 else None


def _from_url(url):
    for pattern in (SCP_LIKE, URL_LIKE):
        m = pattern.match(url)
        if m:
            return m.group(1)
    return ""


def _via_ssh_config(host):
    """SSH config 별칭이면 실제 호스트로 되돌린다. 못 찾으면 그대로 둔다."""
    out = _run(["ssh", "-G", host])
    if not out:
        return host
    for line in out.splitlines():
        if line.startswith("hostname "):
            return line.split(None, 1)[1].strip() or host
    return host


HOSTNAME_LINE = re.compile(r"^([A-Za-z0-9.-]+\.[A-Za-z]{2,})$")


def logged_in_hosts():
    """`gh` 에 로그인된 호스트. 출력 순서를 그대로 쓴다."""
    out = _run(["gh", "auth", "status"]) or ""
    hosts = []
    for line in out.splitlines():
        m = HOSTNAME_LINE.match(line.strip())
        if m and m.group(1) not in hosts:
            hosts.append(m.group(1))
    return hosts


def _has_repo(host, owner, repo):
    return _run(["gh", "api", "--hostname", host,
                 f"repos/{owner}/{repo}", "--jq", ".id"]) is not None


def _from_origin():
    url = (_run(["git", "remote", "get-url", "origin"]) or "").strip()
    host = _from_url(url)
    if not host:
        raise RuntimeError(f"origin 리모트에서 호스트를 읽지 못했다: {url}")
    return _via_ssh_config(host)


def resolve(owner=None, repo=None):
    """gh 에 넘길 호스트 이름. 구하지 못하면 UsageError 대신 예외를 던진다.

    `owner` 와 `repo` 를 주면 현재 디렉터리를 보지 않는다.
    """
    # 호출자가 지정했으면 그것을 존중한다. 오버레이가 호스트를 고정하는 경우가 있다.
    given = os.environ.get("GH_HOST")
    if given:
        return given

    if owner and repo:
        hosts = logged_in_hosts()
        if len(hosts) == 1:
            return hosts[0]
        for host in hosts:
            if _has_repo(host, owner, repo):
                return host
        # 로그인 정보로 가리지 못하면 현재 디렉터리로 되돌아간다.
        # 맞을 수도 있고 아닐 수도 있으나, 여기서 멈추면 쓸 수 있는 값이 없다.

    return _from_origin()


def main(argv):
    owner, repo = (argv[1], argv[2]) if len(argv) == 3 else (None, None)
    if len(argv) not in (1, 3):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(resolve(owner, repo))
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
