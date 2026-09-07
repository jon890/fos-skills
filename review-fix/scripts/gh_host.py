#!/usr/bin/env python3
"""origin 리모트에서 gh 가 봐야 할 호스트 이름을 낸다.

사용법:
    gh_host.py                                  # 호스트 이름 한 줄
    gh api --hostname "$(gh_host.py)" <경로>    # 한 번만 쓸 때

`gh api` 는 `--repo` 를 받지 않아 기본 호스트를 본다.
사내 GHE 저장소에서 호스트를 넘기지 않으면 `Not Found` 가 난다.
결과가 `github.com` 이어도 그대로 넘긴다. 넘겨도 동작이 달라지지 않는다 (실측).

환경 변수는 호출 사이에 남지 않는다 (실측). 에이전트 하네스는 명령마다 새 셸을 띄운다.
그래서 이 값은 쓰는 쪽과 같은 호출 안에서 구한다.
이 스킬의 다른 스크립트는 스스로 이것을 부르므로 미리 지정할 필요가 없다.

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


def resolve():
    """gh 에 넘길 호스트 이름. 구하지 못하면 UsageError 대신 예외를 던진다."""
    # 호출자가 지정했으면 그것을 존중한다. 오버레이가 호스트를 고정하는 경우가 있다.
    given = os.environ.get("GH_HOST")
    if given:
        return given

    url = (_run(["git", "remote", "get-url", "origin"]) or "").strip()
    host = _from_url(url)
    if not host:
        raise RuntimeError(f"origin 리모트에서 호스트를 읽지 못했다: {url}")
    return _via_ssh_config(host)


def main():
    try:
        print(resolve())
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
