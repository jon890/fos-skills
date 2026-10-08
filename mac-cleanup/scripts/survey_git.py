#!/usr/bin/env python3
"""저장소별 워크트리와 브랜치의 정리 후보를 분류한다. 읽기 전용이다.

사용법:
  survey_git.py [--roots DIR...] [--fetch] [--json]

--fetch 를 주면 저장소마다 `git fetch --prune origin` 으로 원격 ref 만 갱신한다.
종료 코드: 0 조사 완료, 2 인자 오류.
"""

import argparse
import json
import os
import subprocess
import sys
import time

SKIP_DIRS = {"node_modules", "worktrees", ".orca-worktree-trash", ".git"}
MAX_DEPTH = 3
BASE_CANDIDATES = ("origin/main", "origin/master", "main", "master")


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
            cur = {"path": value, "branch": None, "prunable": False, "detached": False}
        elif cur is not None:
            if key == "branch":
                cur["branch"] = value.removeprefix("refs/heads/")
            elif key == "prunable":
                cur["prunable"] = True
            elif key == "detached":
                cur["detached"] = True
    return items


def classify_worktree(wt):
    """워크트리 하나를 '제거 후보', '기록만 남음', 'PR 확인 필요', '유지' 로 나눈다."""
    if wt["prunable"]:
        return "기록만 남음"
    if wt["merged"]:
        if wt["dirty"] == 0 and wt["stash"] == 0 and not wt["in_use"]:
            return "제거 후보"
        return "유지"
    if wt.get("upstream_gone"):
        return "PR 확인 필요"
    return "유지"


def classify_branch(br, base, checked_out):
    """브랜치 하나를 '삭제 후보(-d)', 'PR 확인 필요(-D)', '유지' 로 나눈다."""
    name = br["name"]
    if name == base or name.startswith("release/"):
        return "유지"
    if name in checked_out:
        return "유지"
    if br["merged"]:
        return "삭제 후보(-d)"
    if br["upstream_gone"]:
        return "PR 확인 필요(-D)"
    return "유지"


def parse_branches(output):
    """for-each-ref 출력(탭 구분: 이름, track, 커밋 시각, worktreepath)을 dict 목록으로 만든다."""
    rows = []
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[0]:
            continue
        rows.append({
            "name": parts[0], "upstream_gone": "[gone]" in parts[1],
            "commit_ts": int(parts[2]) if parts[2].isdigit() else 0, "worktreepath": parts[3],
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


def survey_repo(repo, cwds, orca):
    base = base_ref(repo)
    if not base:
        return None
    wts = parse_worktrees(git(repo, "worktree", "list", "--porcelain").stdout)
    gone = {b["name"] for b in parse_branches(git(
        repo, "for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:track)\t%(committerdate:unix)\t%(worktreepath)").stdout) if b["upstream_gone"]}
    now = time.time()
    worktrees = []
    for wt in wts[1:]:
        entry = {"path": wt["path"], "branch": wt["branch"], "prunable": wt["prunable"],
                 "orca": None if orca is None else os.path.realpath(wt["path"]) in orca}
        if not wt["prunable"]:
            entry["dirty"] = len([l for l in git(wt["path"], "status", "--porcelain").stdout.splitlines() if l])
            entry["stash"] = len(git(repo, "stash", "list").stdout.splitlines())
            entry["in_use"] = in_use(wt["path"], cwds)
            entry["merged"] = bool(wt["branch"]) and git(repo, "merge-base", "--is-ancestor", wt["branch"], base).returncode == 0
            ahead = git(repo, "rev-list", "--count", f"{base}..{wt['branch']}") if wt["branch"] else None
            entry["ahead"] = int(ahead.stdout.strip() or 0) if ahead and ahead.returncode == 0 else None
            ts = git(wt["path"], "log", "-1", "--format=%ct").stdout.strip()
            entry["age_days"] = int((now - int(ts)) / 86400) if ts.isdigit() else None
            entry["upstream_gone"] = wt["branch"] in gone
        else:
            entry.update(dirty=0, stash=0, in_use=False, merged=False, ahead=None, age_days=None, upstream_gone=False)
        entry["class"] = classify_worktree(entry)
        worktrees.append(entry)
    checked_out = {w["branch"] for w in wts if w["branch"]}
    base_name = base.removeprefix("origin/")
    branches = []
    for br in parse_branches(git(
            repo, "for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:track)\t%(committerdate:unix)\t%(worktreepath)").stdout):
        br["merged"] = git(repo, "merge-base", "--is-ancestor", br["name"], base).returncode == 0
        br["class"] = classify_branch(br, base_name, checked_out)
        branches.append(br)
    return {"repo": repo, "base": base, "worktrees": worktrees, "branches": branches}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--roots", nargs="+", default=["~/projects", "~/personal"])
    ap.add_argument("--fetch", action="store_true")
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
    results = [r for r in (survey_repo(repo, cwds, orca) for repo in repos) if r]
    shown = []
    for r in results:
        r["worktrees"] = [w for w in r["worktrees"] if w["class"] != "유지"]
        r["branches"] = [b for b in r["branches"] if b["class"] != "유지"]
        if r["worktrees"] or r["branches"]:
            shown.append(r)

    if args.json:
        json.dump(shown, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    totals = {}
    for r in shown:
        print(f"## {r['repo']}  (기준 {r['base']})")
        for w in r["worktrees"]:
            totals[f"워크트리 {w['class']}"] = totals.get(f"워크트리 {w['class']}", 0) + 1
            orca_mark = "" if w["orca"] is None else (" orca" if w["orca"] else " 비-orca")
            print(f"  [워크트리 {w['class']}]{orca_mark} {w['path']}  브랜치={w['branch']} 변경={w['dirty']} stash={w['stash']} "
                  f"앞섬={w['ahead']} 경과={w['age_days']}일 사용중={w['in_use']}")
        for b in r["branches"]:
            totals[f"브랜치 {b['class']}"] = totals.get(f"브랜치 {b['class']}", 0) + 1
            print(f"  [브랜치 {b['class']}] {b['name']}")
    print(f"\n## 합계 (저장소 {len(repos)}개 조사, 후보가 있는 저장소 {len(shown)}개)")
    for key, count in sorted(totals.items()):
        print(f"{count:>4}  {key}")
    if not totals:
        print("후보 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
