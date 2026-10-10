#!/usr/bin/env python3
"""저장소별 워크트리와 브랜치의 정리 후보를 분류한다. 읽기 전용이다.

사용법:
  survey_git.py [--roots DIR...] [--fetch] [--check-prs] [--gh-timeout SEC] [--json]

--fetch 를 주면 저장소마다 `git fetch --prune origin` 으로 원격 ref 만 갱신한다.
--check-prs 를 주면 머지 판정이 안 됐고 upstream 이 있는 브랜치마다 `gh pr list` 로 머지된 PR 이 있는지 묻는다.
원격 호출이 브랜치 수만큼 생긴다. squash 머지를 알아보는 용도다.
gh 호출이 실패하면 그 브랜치의 pr_state 가 "error" 가 되고 분류는 gh 없이 낸 결과 그대로다. 실패 수는 합계에 따로 나온다.
--json 은 브랜치와 워크트리마다 끝 커밋 전체 해시(tip)를 담는다. 지우기 직전 `git rev-parse` 값과 대조하는 용도다.
종료 코드: 0 조사 완료, 2 인자 오류.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

SKIP_DIRS = {"node_modules", "worktrees", ".orca-worktree-trash", ".git"}
MAX_DEPTH = 3
BASE_CANDIDATES = ("origin/main", "origin/master", "main", "master")
# 기준 브랜치가 아니어도 기본 브랜치나 배포 브랜치로 쓰는 이름이라 지우면 사람이 헷갈린다.
KEEP_BRANCHES = {"main", "master", "develop"}
DEFAULT_GH_TIMEOUT = 20


def parse_worktrees(porcelain):
    """`git worktree list --porcelain` 출력을 dict 목록으로 만든다. 첫 항목이 메인 워크트리다."""
    items, cur = [], None
    for line in porcelain.splitlines() + [""]:
        if not line.strip():
            if cur:
                items.append(cur)
            cur = None
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            cur = {"path": value, "branch": None, "head": None, "prunable": False, "detached": False}
        elif cur is not None:
            if key == "HEAD":
                cur["head"] = value
            elif key == "branch":
                cur["branch"] = value.removeprefix("refs/heads/")
            elif key == "prunable":
                cur["prunable"] = True
            elif key == "detached":
                cur["detached"] = True
    return items


STASH_RE = re.compile(r"^(?:WIP on|On) (.+?): ")


def parse_stash_branches(text):
    """`git stash list --format=%gs` 출력에서 브랜치별 stash 수를 센다. 알아볼 수 없는 줄은 건너뛴다."""
    counts = {}
    for line in text.splitlines():
        m = STASH_RE.match(line)
        if m and m.group(1) != "(no branch)":
            counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return counts


def judge_pr(tip, prs):
    """로컬 브랜치 끝 커밋 tip 과 머지된 PR 목록(headRefOid 를 가진 dict)을 대조한다.

    'merged': 머지된 PR 의 headRefOid 가 tip 과 같다.
    'diverged': 머지된 PR 은 있으나 tip 이 다르다. PR 이후 로컬 커밋이 있다는 뜻이다.
    'error': prs 가 None 이다. gh 호출이 실패해 확인하지 못했다. 분류에서는 판정 없음(None)과 같게 다룬다.
    None: 머지된 PR 이 없다.
    """
    if prs is None:
        return "error"
    if not prs:
        return None
    return "merged" if any(pr.get("headRefOid") == tip for pr in prs) else "diverged"


def classify_worktree(wt, pr_state=None):
    """워크트리 하나를 '제거 후보', '제거 후보(PR 머지됨)', '기록만 남음', 'PR 확인 필요', '유지' 로 나눈다.

    pr_state 는 --check-prs 의 judge_pr 결과다.
    """
    if wt["prunable"]:
        return "기록만 남음"
    free = wt["dirty"] == 0 and wt["stash"] == 0 and not wt["in_use"]
    if wt["merged"]:
        return "제거 후보" if free else "유지"
    if pr_state == "merged":
        return "제거 후보(PR 머지됨)" if free else "유지"
    if pr_state == "diverged" or wt.get("upstream_gone"):
        return "PR 확인 필요"
    return "유지"


def classify_branch(br, base, checked_out, pr_state=None):
    """브랜치 하나를 '삭제 후보(-d)', 'PR 머지됨(-D)', 'PR 확인 필요(-D)', '유지' 로 나눈다."""
    name = br["name"]
    if name == base or name in KEEP_BRANCHES or name.startswith("release/"):
        return "유지"
    if name in checked_out:
        return "유지"
    if br["merged"]:
        return "삭제 후보(-d)"
    if pr_state == "merged":
        return "PR 머지됨(-D)"
    if pr_state == "diverged" or br["upstream_gone"]:
        return "PR 확인 필요(-D)"
    return "유지"


def parse_branches(output):
    """for-each-ref 출력(탭 구분: 이름, track, 커밋 시각, worktreepath, upstream, 끝 커밋)을 dict 목록으로 만든다."""
    rows = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[0]:
            continue
        rows.append({
            "name": parts[0], "upstream_gone": "[gone]" in parts[1],
            "commit_ts": int(parts[2]) if parts[2].isdigit() else 0, "worktreepath": parts[3],
            "has_upstream": len(parts) > 4 and bool(parts[4]),
            "tip": parts[5] if len(parts) > 5 and parts[5] else None,
        })
    return rows


def git(repo, *args, timeout=30, env=None):
    try:
        return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=timeout, env=env)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return subprocess.CompletedProcess(args, 124, "", str(exc))


def find_repos(roots):
    repos = []
    for root in roots:
        root = os.path.expanduser(root)
        base_depth = root.rstrip("/").count("/")
        for cur, dirs, _ in os.walk(root):
            if os.path.isdir(os.path.join(cur, ".git")):
                repos.append(cur)
                dirs[:] = []
                continue
            if cur.count("/") - base_depth >= MAX_DEPTH:
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    return sorted(set(repos))


def base_ref(repo):
    head = git(repo, "symbolic-ref", "-q", "refs/remotes/origin/HEAD")
    if head.returncode == 0 and head.stdout.strip():
        return head.stdout.strip().removeprefix("refs/remotes/")
    for cand in BASE_CANDIDATES:
        full = f"refs/remotes/{cand}" if cand.startswith("origin/") else f"refs/heads/{cand}"
        if git(repo, "show-ref", "--verify", "-q", full).returncode == 0:
            return cand
    return None


def collect_cwds():
    """실행 중 프로세스의 cwd 목록. lsof 를 한 번만 돌린다."""
    try:
        out = subprocess.run(["lsof", "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=60).stdout
    except (subprocess.TimeoutExpired, OSError):
        return set()
    return {line[1:] for line in out.splitlines() if line.startswith("n")}


def orca_paths():
    try:
        out = subprocess.run(["orca", "worktree", "list", "--json"], capture_output=True, text=True, timeout=30).stdout
        data = json.loads(out)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None
    return {os.path.realpath(w["path"]) for w in data.get("result", {}).get("worktrees", []) if w.get("path")}


def in_use(path, cwds):
    real = os.path.realpath(path)
    return any(c == real or c.startswith(real + "/") for c in cwds)


BRANCH_FORMAT = "%(refname:short)\t%(upstream:track)\t%(committerdate:unix)\t%(worktreepath)\t%(upstream)\t%(objectname)"


def merged_prs(repo, branch, timeout=DEFAULT_GH_TIMEOUT):
    """머지된 PR 목록(number, headRefOid). gh 가 없거나 실패하면 None. 표준 입력을 닫지 않으면 gh 가 셸 반복문의 입력을 읽는다."""
    try:
        done = subprocess.run(
            ["gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid"],
            cwd=repo, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        if done.returncode != 0:
            raise ValueError(done.stderr.strip()[:120])
        return json.loads(done.stdout)
    except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
        print(f"경고: gh 실패 {repo} {branch}: {exc}", file=sys.stderr)
        return None


def survey_repo(repo, cwds, orca, check_prs=False, gh_timeout=DEFAULT_GH_TIMEOUT):
    base = base_ref(repo)
    if not base:
        return None
    wts = parse_worktrees(git(repo, "worktree", "list", "--porcelain").stdout)
    all_branches = parse_branches(git(repo, "for-each-ref", "refs/heads", f"--format={BRANCH_FORMAT}").stdout)
    gone = {b["name"] for b in all_branches if b["upstream_gone"]}
    has_upstream = {b["name"] for b in all_branches if b["has_upstream"]}
    stashes = parse_stash_branches(git(repo, "stash", "list", "--format=%gs").stdout)
    pr_cache = {}

    def pr_state(name, merged):
        """--check-prs 일 때 머지 판정이 안 됐고 upstream 이 있는 브랜치만 gh 로 묻고 끝 커밋을 대조한다. 결과는 저장소 안에서 재사용한다."""
        if not check_prs or merged or not name or name not in has_upstream:
            return None
        if name not in pr_cache:
            prs = merged_prs(repo, name, gh_timeout)
            tip = git(repo, "rev-parse", f"refs/heads/{name}").stdout.strip()
            pr_cache[name] = judge_pr(tip, prs)
        return pr_cache[name]

    now = time.time()
    worktrees = []
    for wt in wts[1:]:
        entry = {"path": wt["path"], "branch": wt["branch"], "tip": wt["head"], "prunable": wt["prunable"],
                 "orca": None if orca is None else os.path.realpath(wt["path"]) in orca}
        if not wt["prunable"]:
            entry["dirty"] = len([l for l in git(wt["path"], "status", "--porcelain").stdout.splitlines() if l])
            entry["stash"] = stashes.get(wt["branch"], 0) if wt["branch"] else 0
            entry["in_use"] = in_use(wt["path"], cwds)
            entry["merged"] = bool(wt["branch"]) and git(repo, "merge-base", "--is-ancestor", wt["branch"], base).returncode == 0
            ahead = git(repo, "rev-list", "--count", f"{base}..{wt['branch']}") if wt["branch"] else None
            entry["ahead"] = int(ahead.stdout.strip() or 0) if ahead and ahead.returncode == 0 else None
            ts = git(wt["path"], "log", "-1", "--format=%ct").stdout.strip()
            entry["age_days"] = int((now - int(ts)) / 86400) if ts.isdigit() else None
            entry["upstream_gone"] = wt["branch"] in gone
        else:
            entry.update(dirty=0, stash=0, in_use=False, merged=False, ahead=None, age_days=None, upstream_gone=False)
        entry["pr_state"] = pr_state(wt["branch"], entry["merged"])
        entry["class"] = classify_worktree(entry, entry["pr_state"])
        worktrees.append(entry)
    checked_out = {w["branch"] for w in wts if w["branch"]}
    base_name = base.removeprefix("origin/")
    branches = []
    for br in all_branches:
        br["merged"] = git(repo, "merge-base", "--is-ancestor", br["name"], base).returncode == 0
        br["pr_state"] = pr_state(br["name"], br["merged"])
        br["class"] = classify_branch(br, base_name, checked_out, br["pr_state"])
        branches.append(br)
    gh_errors = sorted(name for name, state in pr_cache.items() if state == "error")
    return {"repo": repo, "base": base, "gh_errors": gh_errors, "worktrees": worktrees, "branches": branches}


def short(tip):
    return tip[:8] if tip else "-"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--roots", nargs="+", default=["~/projects", "~/personal"])
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--check-prs", action="store_true")
    ap.add_argument("--gh-timeout", type=int, default=DEFAULT_GH_TIMEOUT, metavar="SEC")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    repos = find_repos(args.roots)
    if args.fetch:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        for repo in repos:
            done = git(repo, "fetch", "--prune", "origin", timeout=30, env=env)
            if done.returncode != 0:
                print(f"경고: fetch 실패 {repo}: {done.stderr.strip()[:120]}", file=sys.stderr)
    cwds, orca = collect_cwds(), orca_paths()
    results = [r for r in (survey_repo(repo, cwds, orca, args.check_prs, args.gh_timeout) for repo in repos) if r]
    shown = []
    for r in results:
        # gh 확인에 실패한 항목은 분류가 "유지" 여도 남겨, 확인하지 못했다는 사실이 보고에서 빠지지 않게 한다.
        r["worktrees"] = [w for w in r["worktrees"] if w["class"] != "유지" or w["pr_state"] == "error"]
        r["branches"] = [b for b in r["branches"] if b["class"] != "유지" or b["pr_state"] == "error"]
        if r["worktrees"] or r["branches"]:
            shown.append(r)

    if args.json:
        json.dump(shown, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    totals = {}
    gh_failed = sum(len(r["gh_errors"]) for r in shown)
    for r in shown:
        print(f"## {r['repo']}  (기준 {r['base']})")
        for w in r["worktrees"]:
            if w["class"] != "유지":
                totals[f"워크트리 {w['class']}"] = totals.get(f"워크트리 {w['class']}", 0) + 1
            orca_mark = "" if w["orca"] is None else (" orca" if w["orca"] else " 비-orca")
            print(f"  [워크트리 {w['class']}]{orca_mark} {w['path']}  브랜치={w['branch']} 변경={w['dirty']} stash={w['stash']} "
                  f"앞섬={w['ahead']} 경과={w['age_days']}일 사용중={w['in_use']} 끝={short(w['tip'])}"
                  f"{' gh확인실패' if w['pr_state'] == 'error' else ''}")
        for b in r["branches"]:
            if b["class"] != "유지":
                totals[f"브랜치 {b['class']}"] = totals.get(f"브랜치 {b['class']}", 0) + 1
            print(f"  [브랜치 {b['class']}] {b['name']}  끝={short(b['tip'])}{' gh확인실패' if b['pr_state'] == 'error' else ''}")
    print(f"\n## 합계 (저장소 {len(repos)}개 조사, 후보가 있는 저장소 {len(shown)}개)")
    for key, count in sorted(totals.items()):
        print(f"{count:>4}  {key}")
    if args.check_prs:
        print(f"{gh_failed:>4}  gh 확인 실패")
    if not totals:
        print("후보 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
