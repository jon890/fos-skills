#!/usr/bin/env python3
"""`survey_git.py --json` 결과의 로컬 브랜치를 지운다. 기본은 dry-run 이다.

사용법:
  delete_branches.py SURVEY_JSON [--only merged pr-merged ...] [--apply]

SURVEY_JSON 은 `survey_git.py --json` 을 저장한 파일이고, `-` 이면 표준 입력을 읽는다.
--only 로 지울 분류를 고른다. 기본은 merged 다.
  merged     "삭제 후보(-d)". 브랜치가 이미 없으면 `유지` 로 보인다. 있으면 `git branch -d` 를 쓰고, `not fully merged` 로 거절되면
             조사 JSON 의 tip 과 `git rev-parse` 가 같고 `merge-base --is-ancestor <브랜치> <base>` 가 0 일 때만 -D 를 쓴다.
  pr-merged  "PR 머지됨(-D)". 실행 직전 `git rev-parse` 가 조사 JSON 의 tip 과 같을 때만 -D 를 쓴다.
그 밖의 분류와 `gh 확인 실패`(pr_state 가 error) 는 건드리지 않는다. 원격 브랜치는 지우지 않는다.
--apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.

종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류.
"""

import argparse
import json
import subprocess
import sys

CLASS_BY_OPTION = {"merged": "삭제 후보(-d)", "pr-merged": "PR 머지됨(-D)"}


def git(repo, *args):
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return subprocess.CompletedProcess(args, 124, "", str(exc))


def result(repo, name, status, detail=""):
    return {"repo": repo, "branch": name, "status": status, "detail": detail}


def can_force(repo, base, br):
    """`-d` 가 거절된 뒤 -D 로 갈 수 있는지 본다. (가능 여부, 이유) 를 돌려준다."""
    head = git(repo, "rev-parse", f"refs/heads/{br['name']}")
    if head.returncode != 0:
        return False, "브랜치가 없다"
    if head.stdout.strip() != br["tip"]:
        return False, f"tip 불일치(조사 {br['tip'][:8]}, 지금 {head.stdout.strip()[:8]})"
    anc = git(repo, "merge-base", "--is-ancestor", f"refs/heads/{br['name']}", base)
    if anc.returncode != 0:
        return False, f"{base} 에 포함되지 않음"
    return True, ""


def process_branch(repo, base, br, only, apply):
    """브랜치 하나를 처리하고 {repo, branch, status, detail} 을 돌려준다. status: 삭제, 삭제 예정, 유지, 건드리지 않음, 실패."""
    name, cls = br["name"], br.get("class")
    selected = {CLASS_BY_OPTION[o] for o in only}
    if br.get("pr_state") == "error":
        return result(repo, name, "건드리지 않음", "gh 확인 실패")
    if cls not in selected:
        return result(repo, name, "건드리지 않음", f"분류 {cls}")
    if not br.get("tip"):
        return result(repo, name, "유지", "조사 JSON 에 tip 이 없다")

    if cls == "PR 머지됨(-D)":
        head = git(repo, "rev-parse", f"refs/heads/{name}")
        if head.returncode != 0:
            return result(repo, name, "유지", "브랜치가 없다")
        if head.stdout.strip() != br["tip"]:
            return result(repo, name, "유지", f"tip 불일치(조사 {br['tip'][:8]}, 지금 {head.stdout.strip()[:8]})")
        if not apply:
            return result(repo, name, "삭제 예정", "-D (PR 머지됨, tip 일치)")
        done = git(repo, "branch", "-D", name)
        return result(repo, name, "삭제" if done.returncode == 0 else "실패", "-D" if done.returncode == 0 else done.stderr.strip())

    # 삭제 후보(-d)
    if git(repo, "rev-parse", f"refs/heads/{name}").returncode != 0:
        return result(repo, name, "유지", "브랜치가 없다")
    if not apply:
        ok, why = can_force(repo, base, br)
        return result(repo, name, "삭제 예정", "-d" + ("" if ok else f" (거절되면 유지: {why})"))
    done = git(repo, "branch", "-d", name)
    if done.returncode == 0:
        return result(repo, name, "삭제", "-d")
    if "not fully merged" not in done.stderr:
        return result(repo, name, "실패", done.stderr.strip())
    ok, why = can_force(repo, base, br)
    if not ok:
        return result(repo, name, "유지", f"-d 거절, {why}")
    done = git(repo, "branch", "-D", name)
    return result(repo, name, "삭제" if done.returncode == 0 else "실패",
                  "-d 거절 뒤 -D (tip 일치, base 에 포함)" if done.returncode == 0 else done.stderr.strip())


def run(survey, only, apply):
    results = []
    for repo in survey:
        for br in repo["branches"]:
            results.append(process_branch(repo["repo"], repo["base"], br, only, apply))
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("survey_json")
    ap.add_argument("--only", nargs="+", choices=sorted(CLASS_BY_OPTION), default=["merged"])
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    try:
        text = sys.stdin.read() if args.survey_json == "-" else open(args.survey_json, encoding="utf-8").read()
        survey = json.loads(text)
        if not isinstance(survey, list) or any("repo" not in r or "base" not in r or "branches" not in r for r in survey):
            raise ValueError("survey_git.py --json 형식이 아니다")
    except (OSError, ValueError) as exc:
        print(f"입력을 읽을 수 없다: {exc}", file=sys.stderr)
        return 2

    print("## 실행" if args.apply else "## dry-run (변경 없음, 실제 삭제는 --apply)")
    results = run(survey, args.only, args.apply)
    for r in results:
        print(f"[{r['status']}] {r['repo']}  {r['branch']}  {r['detail']}".rstrip())
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print("\n## 합계")
    for key, count in sorted(counts.items()):
        print(f"{count:>4}  {key}")
    return 1 if counts.get("실패") else 0


if __name__ == "__main__":
    sys.exit(main())
