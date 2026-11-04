#!/usr/bin/env python3
"""조사 JSON 의 「PR 확인 필요(-D)」 브랜치마다 지워도 잃는 커밋이 없는지 확인한다. 읽기 전용이다.

사용법:
  check_pr_branches.py SURVEY_JSON [--pr-limit 5] [--gh-timeout SEC] [--json]

SURVEY_JSON 은 `survey_git.py --json` 을 저장한 파일이다. 브랜치마다 아래를 낸다.
- 지금 `git rev-parse` 값이 조사 때의 tip 과 같은지
- 그 브랜치의 PR 목록(최근 --pr-limit 건): 번호, 상태, head 가 tip 과 같은지, 머지 시각
- 원격 어디에도 없는 로컬 커밋 수 (`git rev-list --count BR --not --remotes`)
- 위 값으로 낸 판정 한 줄
gh 는 저장소 cwd 에서 부르고, 실패하면 그 브랜치만 표시하고 계속한다. 브랜치를 지우지 않는다.
종료 코드: 0 확인 완료, 2 입력 파일 오류.
"""

import argparse
import json
import subprocess
import sys

CLASS = "PR 확인 필요(-D)"
DEFAULT_GH_TIMEOUT = 20
DEFAULT_PR_LIMIT = 5


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return subprocess.CompletedProcess(args, 124, "", str(exc))


def gh_prs(repo, branch, limit=DEFAULT_PR_LIMIT, timeout=DEFAULT_GH_TIMEOUT):
    """브랜치의 PR 목록(최근 limit 건, 상태 무관). 실패하면 None. 표준 입력을 닫지 않으면 gh 가 셸 반복문의 입력을 읽는다."""
    try:
        done = subprocess.run(
            ["gh", "pr", "list", "--head", branch, "--state", "all", "--limit", str(limit),
             "--json", "number,state,headRefOid,mergedAt"],
            cwd=repo, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        if done.returncode != 0:
            raise ValueError(done.stderr.strip()[:120])
        return json.loads(done.stdout)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None


def verdict(surveyed_tip, current_tip, local_only):
    """판정 한 줄. 지금 tip 이 없거나 조사 때와 다르면 커밋 수를 믿을 수 없으므로 다시 조사하게 한다."""
    if not current_tip:
        return "브랜치 없음, 다시 조사"
    if surveyed_tip and current_tip != surveyed_tip:
        return "tip 바뀜, 다시 조사"
    if local_only is None:
        return "로컬 커밋 수 확인 실패, 사용자 판단"
    if local_only == 0:
        return "잃는 커밋 없음"
    return f"로컬 커밋 {local_only}개, 사용자 판단"


def summarize_prs(prs, current_tip):
    return [{"number": pr.get("number"), "state": pr.get("state"),
             "head_is_tip": bool(current_tip) and pr.get("headRefOid") == current_tip,
             "merged_at": pr.get("mergedAt")} for pr in prs]


def check_branch(repo, br, pr_limit=DEFAULT_PR_LIMIT, gh_timeout=DEFAULT_GH_TIMEOUT, fetch_prs=gh_prs):
    """fetch_prs(repo, branch, limit, timeout) 는 테스트에서 가짜로 바꾼다."""
    name = br["name"]
    done = git(repo, "rev-parse", "--verify", "-q", f"refs/heads/{name}")
    current = done.stdout.strip() if done.returncode == 0 else None
    local_only = None
    if current:
        counted = git(repo, "rev-list", "--count", f"refs/heads/{name}", "--not", "--remotes")
        if counted.returncode == 0 and counted.stdout.strip().isdigit():
            local_only = int(counted.stdout.strip())
    prs = fetch_prs(repo, name, pr_limit, gh_timeout)
    return {
        "repo": repo, "name": name, "surveyed_tip": br.get("tip"), "current_tip": current,
        "tip_same": bool(current) and current == br.get("tip"),
        "local_only_commits": local_only,
        "gh_error": prs is None,
        "prs": [] if prs is None else summarize_prs(prs, current),
        "verdict": verdict(br.get("tip"), current, local_only),
    }


def check_survey(survey, pr_limit=DEFAULT_PR_LIMIT, gh_timeout=DEFAULT_GH_TIMEOUT, fetch_prs=gh_prs):
    return [check_branch(r["repo"], br, pr_limit, gh_timeout, fetch_prs)
            for r in survey for br in r.get("branches", []) if br.get("class") == CLASS]


def short(tip):
    return tip[:8] if tip else "-"


def print_text(results):
    for r in results:
        print(f"{r['repo']}  {r['name']}")
        print(f"  tip: 조사={short(r['surveyed_tip'])} 지금={short(r['current_tip'])} {'같음' if r['tip_same'] else '다름'}")
        count = "?" if r["local_only_commits"] is None else r["local_only_commits"]
        print(f"  원격에 없는 로컬 커밋: {count}")
        if r["gh_error"]:
            print("  PR: gh 확인 실패")
        elif not r["prs"]:
            print("  PR: 없음")
        for pr in r["prs"]:
            print(f"  PR #{pr['number']} {pr['state']} head=tip:{'예' if pr['head_is_tip'] else '아니오'} 머지={pr['merged_at'] or '-'}")
        print(f"  판정: {r['verdict']}")
    print(f"\n{len(results)}개 확인")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("survey")
    ap.add_argument("--pr-limit", type=int, default=DEFAULT_PR_LIMIT)
    ap.add_argument("--gh-timeout", type=int, default=DEFAULT_GH_TIMEOUT, metavar="SEC")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        with open(args.survey, encoding="utf-8") as fh:
            survey = json.load(fh)
        if not isinstance(survey, list):
            raise ValueError("최상위가 목록이 아니다")
    except (OSError, ValueError) as exc:
        print(f"조사 JSON 을 읽을 수 없다: {exc}", file=sys.stderr)
        return 2
    results = check_survey(survey, args.pr_limit, args.gh_timeout)
    if args.json:
        json.dump(results, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print_text(results)
    return 0


if __name__ == "__main__":
    sys.exit(main())
