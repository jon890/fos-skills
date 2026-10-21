#!/usr/bin/env python3
"""draft PR 을 ready 로 바꿔 CI 를 시작한다. 이미 ready 인 다른 PR 과 파일이 겹치거나 base 와 충돌하면 보류한다.

draft PR 에서는 CI 가 돌지 않게 해 둔 저장소용이다. 오버레이가 켠 저장소에서만 쓴다.
겹친 PR 둘을 함께 ready 로 바꾸면, 앞 PR 이 머지된 뒤 뒤 PR 을 base 와 합쳐 CI 를 다시 돌려야 한다.
겹친 PR 이 먼저 머지되기를 기다렸다가 바꾸면 CI 가 한 번만 돈다.
base 와 충돌하는 PR 은 worker 가 base 를 합친 뒤에 바꾼다. 충돌한 채로 돈 CI 는 버려진다.

사용법:
    ci-ready.py [--repo DIR] [--dry-run] PR [PR ...]

    --repo     대상 저장소 체크아웃. 기본은 현재 디렉터리. gh 는 이 저장소의 origin 으로 호스트를 찾는다
    --dry-run  ready 로 바꾸지 않고 판정만 낸다

PR 마다 (받은 순서대로):
    - OPEN 이 아니면 보류, 이미 ready 면 건너뛴다
    - mergeable 이 CONFLICTING 이면 보류한다. UNKNOWN 이면 몇 번 다시 묻고, 그래도 모르면 보류한다
    - 같은 base 로 가는 열린 ready PR 과 바뀐 파일이 겹치면 보류하고 겹친 PR 과 파일을 낸다.
      이번 실행에서 앞서 ready 로 바꾼 PR 도 ready 로 센다. draft PR 끼리의 겹침은 세지 않는다
    - 바뀐 파일이 300 개를 넘으면 직접 확인하라고 보류한다
    - 나머지는 `gh pr ready` 로 바꾼다

바뀐 파일은 REST(`gh api repos/{owner}/{repo}/pulls/{n}/files --paginate`)로 읽는다.
`gh pr view --json files` 같은 GraphQL 조회는 PR 이 많으면 2차 한도에 걸리고 100 개에서 잘린다.
호스트와 저장소는 PR URL 에서 읽는다. `gh api` 는 origin 을 보지 않고 기본 호스트로 가기 때문이다.

GH 환경 변수로 gh 실행 파일을 바꾼다. ORCH_READY_RETRY_SECONDS 로 UNKNOWN 재시도 간격(기본 15초)을 바꾼다.

종료 코드: 0 모두 ready(이미 ready 포함), 1 보류한 PR 이 있다, 2 사용법 오류나 조회 실패
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

GH = os.environ.get("GH", "gh")
RETRY_SECONDS = float(os.environ.get("ORCH_READY_RETRY_SECONDS", "15"))
RETRIES = 4
FILES_LIMIT = 300


class LookupFailed(RuntimeError):
    pass


def gh(repo, *args):
    done = subprocess.run([GH, *args], cwd=repo, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr.strip()


def gh_json(repo, *args):
    code, out, err = gh(repo, *args)
    if code != 0:
        raise LookupFailed(f"gh {' '.join(args[:3])} 실패: {err}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise LookupFailed(f"gh {' '.join(args[:3])} 의 출력이 JSON 이 아니다") from exc


def api_target(url):
    """PR URL 에서 (호스트, owner/repo). 읽지 못하면 LookupFailed."""
    parts = (url or "").split("://", 1)[-1].split("/")
    if len(parts) < 3 or not all(parts[:3]):
        raise LookupFailed(f"PR URL 을 읽지 못했다: {url!r}")
    return parts[0], f"{parts[1]}/{parts[2]}"


def files_of(repo, pr):
    """REST 로 읽은 PR 의 바뀐 파일 집합."""
    host, slug = api_target(pr.get("url"))
    code, out, err = gh(repo, "api", "--hostname", host, f"repos/{slug}/pulls/{pr['number']}/files?per_page=100",
                        "--paginate", "--jq", ".[].filename")
    if code != 0:
        raise LookupFailed(f"gh api 로 PR {pr['number']} 의 파일을 읽지 못했다: {err}")
    return {line for line in out.splitlines() if line}


def view(repo, number):
    return gh_json(repo, "pr", "view", str(number), "--json", "number,state,isDraft,mergeable,baseRefName,url")


def ready_prs(repo, base):
    """같은 base 로 가는 열린 ready PR 의 {번호: 파일 집합}."""
    prs = gh_json(repo, "pr", "list", "--state", "open", "--base", base, "--limit", "200",
                  "--json", "number,isDraft,url")
    return {pr["number"]: files_of(repo, pr) for pr in prs if not pr.get("isDraft")}


def mergeable(repo, number, state):
    for _ in range(RETRIES):
        if state != "UNKNOWN":
            break
        time.sleep(RETRY_SECONDS)
        state = view(repo, number).get("mergeable")
    return state


def judge(repo, number, readied):
    """(판정, 설명). 판정은 ready, already, hold 중 하나다."""
    pr = view(repo, number)
    if pr.get("state") != "OPEN":
        return "hold", f"state={pr.get('state')}"
    if not pr.get("isDraft"):
        return "already", "이미 ready"
    state = mergeable(repo, number, pr.get("mergeable"))
    if state == "CONFLICTING":
        return "hold", "base 와 충돌한다. worker 가 base 를 합친 뒤 다시 돌린다"
    if state != "MERGEABLE":
        return "hold", f"충돌 여부를 아직 모른다(mergeable={state})"
    mine = files_of(repo, pr)
    if len(mine) > FILES_LIMIT:
        return "hold", f"바뀐 파일이 {len(mine)} 개로 {FILES_LIMIT} 개를 넘는다. 직접 확인한다"
    others = ready_prs(repo, pr.get("baseRefName") or "")
    others.update({n: f for n, (base, f) in readied.items() if base == pr.get("baseRefName")})
    busy = []
    for other, files in sorted(others.items()):
        if other == number:
            continue
        same = sorted(mine & files)
        if same:
            busy.append(f"#{other}({', '.join(same[:3])}{' 외' if len(same) > 3 else ''})")
    if busy:
        return "hold", "ready PR 과 겹친다 " + " ".join(busy)
    readied[number] = (pr.get("baseRefName"), mine)
    return "ready", "ready 로 바꾼다"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("prs", nargs="+", type=int)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2

    readied, held = {}, False
    for number in args.prs:
        try:
            verdict, why = judge(args.repo, number, readied)
        except LookupFailed as exc:
            print(f"{number} 조회 실패: {exc}", file=sys.stderr)
            return 2
        if verdict == "hold":
            held = True
            print(f"{number} 보류: {why}")
        elif verdict == "already":
            print(f"{number} {why}")
        elif args.dry_run:
            print(f"{number} ready 로 바꿀 것")
        else:
            code, _, err = gh(args.repo, "pr", "ready", str(number))
            if code != 0:
                print(f"{number} ready 로 바꾸지 못했다: {err}", file=sys.stderr)
                return 2
            print(f"{number} ready 로 바꿈(CI 시작)")
    return 1 if held else 0


if __name__ == "__main__":
    sys.exit(main())
