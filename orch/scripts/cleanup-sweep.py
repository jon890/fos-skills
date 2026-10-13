#!/usr/bin/env python3
"""머지가 끝난 worktree 와 로컬 브랜치, 그 worker 터미널과 지시서를 찾아 정리한다.

머지마다 손으로 정리하면 잊히고, 프로세스가 worktree 를 잡고 있어 그 자리에서 실패한 것은 다시 돌아보지 않는다.
이 스크립트는 상태로만 판정하므로 몇 번을 돌려도 같다. 건너뛴 항목은 다음 실행에서 다시 판정된다.

사용법 (기본은 dry-run. 무엇을 할지만 낸다):
    cleanup-sweep.py --repo DIR [--base main] [--run RUN_ID] [--specs-dir DIR] [--apply]

    --repo        대상 저장소의 기본 체크아웃. 여기서 git worktree 목록과 gh 를 읽는다
    --base        기준 브랜치. 기본 main
    --run         worker 를 찾을 Orca Run. 없으면 worker 확인과 release 를 건너뛰고 터미널만 경로로 찾는다
    --specs-dir   지시서 폴더(저장소 기준 상대경로 또는 절대경로). worktree 이름과 같은
                  `<이름>.md` 와 `spec-<이름>.md` 를 지운다. 없으면 지시서는 건드리지 않는다
    --apply       실제로 정리한다

정리 대상 (브랜치마다):
    - 그 브랜치의 PR 이 MERGED 다
    - PR 이 없거나 MERGED 가 아니면, upstream 이 gone 이고 `git cherry` 로 base 에 없는 커밋이 0 개다

건너뜀 (이유를 낸다):
    - 커밋 안 된 변경이 있다
    - 원격에도 머지된 PR HEAD 에도 없는 커밋이 있다
    - 살아 있는 worker 가 그 worktree 를 맡고 있다. workerState 가 working 이나 ready 이거나,
      Dispatch 상태와 상관없이 그 worker 의 터미널이 `orca terminal list` 에 살아 있으면 살아 있다고 본다.
      Dispatch 가 succeeded 여도 같은 터미널에서 후속 일을 하는 worker 가 있고,
      그 브랜치가 막 만든 상태(base 와 같고 커밋 0)면 머지 판정을 통과해 일하는 worker 를 지우게 된다
    - 터미널을 닫은 뒤에도 그 경로를 작업 디렉터리로 쓰는 프로세스가 있다. 다음 실행에서 다시 시도한다

실행 순서 (worktree 마다):
    그 경로의 Orca 터미널 close(PR 이 MERGED 일 때만), 끝난 Dispatch release, `remove-worktree.sh --delete-branch --merged-head`,
    원격 브랜치 삭제(이미 없으면 통과), 지시서 삭제.
    기준 브랜치, `release/*`, 다른 열린 PR 의 base 인 브랜치는 지우지 않는다.
    worktree 없이 남은 로컬 브랜치도 같은 조건으로 판정해 지운다.

ORCA, GH 환경 변수로 실행 파일을 바꾼다. 기본 orca, gh.

종료 코드:
    0  돌았다. 건너뛴 항목이 있어도 0 이다
    2  사용법 오류, 또는 저장소를 읽지 못했다
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REMOVE = HERE / "remove-worktree.sh"
LIVE_STATES = {"working", "ready"}
BY_PR = "PR MERGED"
ORCA = os.environ.get("ORCA", "orca")
GH = os.environ.get("GH", "gh")


def run(cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def git(repo, *args):
    return run(["git", "-C", str(repo), *args])


def worktrees(repo):
    """기본 체크아웃을 뺀 (경로, 브랜치) 목록. 브랜치가 없으면 빈 문자열이다."""
    code, out, _ = git(repo, "worktree", "list", "--porcelain")
    if code != 0:
        raise RuntimeError(f"git worktree list 실패: {repo}")
    items, path, branch = [], None, ""
    for line in out.splitlines() + [""]:
        if line.startswith("worktree "):
            path, branch = line[len("worktree "):], ""
        elif line.startswith("branch "):
            branch = line[len("branch "):].removeprefix("refs/heads/")
        elif not line and path:
            items.append((path, branch))
            path = None
    return items[1:]


def pr_of(repo, branch):
    """그 브랜치의 가장 최근 PR. (state, headRefOid) 이고 없으면 (None, None) 이다."""
    code, out, _ = run([GH, "pr", "list", "--head", branch, "--state", "all", "--limit", "1",
                        "--json", "number,state,headRefOid"], cwd=repo)
    if code != 0:
        return None, None
    try:
        prs = json.loads(out or "[]")
    except json.JSONDecodeError:
        return None, None
    return (prs[0]["state"], prs[0].get("headRefOid")) if prs else (None, None)


def merged(repo, branch, base):
    """(머지됐는지, 머지된 PR HEAD, 판정 근거)."""
    state, head = pr_of(repo, branch)
    if state == "MERGED":
        return True, head, BY_PR
    _, track, _ = git(repo, "for-each-ref", "--format=%(upstream:track)", f"refs/heads/{branch}")
    if track != "[gone]":
        return False, None, f"PR {state or '없음'}, upstream 이 남아 있다"
    code, out, _ = git(repo, "cherry", f"origin/{base}", branch)
    if code != 0:
        return False, None, "git cherry 실패"
    plus = sum(1 for line in out.splitlines() if line.startswith("+"))
    if plus:
        return False, None, f"upstream gone 이지만 base 에 없는 커밋 {plus} 개"
    return True, None, "upstream gone, base 에 없는 커밋 0 개"


def unpushed(repo, ref, merged_head, by_cherry):
    """원격에도 머지된 PR HEAD 에도 없는 커밋 수. cherry 로 판정했으면 이미 base 에 있으므로 0 이다."""
    if by_cherry:
        return 0
    args = ["rev-list", ref, "--not", "--remotes"]
    if merged_head and git(repo, "cat-file", "-e", f"{merged_head}^{{commit}}")[0] == 0:
        args.append(merged_head)
    code, out, _ = git(repo, *args)
    return len(out.splitlines()) if code == 0 else -1


def dirty(path):
    code, out, _ = git(path, "status", "--porcelain")
    return code != 0 or bool(out)


def holders(path):
    """그 경로나 하위를 작업 디렉터리로 쓰는 프로세스 수."""
    _, out, _ = run(["lsof", "-d", "cwd", "-Fn"])
    return sum(1 for line in out.splitlines()
               if line.startswith("n") and (line[1:] == path or line[1:].startswith(path + "/")))


def orca_json(*args):
    code, out, _ = run([ORCA, *args, "--json"])
    if code != 0:
        return None
    try:
        return json.loads(out)["result"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def workers_at(workers, path):
    return [w for w in workers if str((w.get("resource") or {}).get("worktreeId", "")).endswith("::" + path)]


def live_terminals():
    """살아 있는 터미널 목록. 조회에 실패하면 None 이다."""
    result = orca_json("terminal", "list")
    return None if result is None else result.get("terminals", [])


def terminals_at(terminals, path):
    return [t["handle"] for t in terminals or [] if t.get("worktreePath") == path and t.get("handle")]


def protected(repo, branch, base):
    if branch == base or branch.startswith("release/"):
        return "기준 브랜치나 release 브랜치"
    code, out, _ = run([GH, "pr", "list", "--state", "open", "--base", branch, "--json", "number", "--jq", "length"], cwd=repo)
    if code != 0 or out not in ("", "0"):
        return "다른 열린 PR 의 base 이거나 조회 실패"
    return None


def delete_remote(repo, branch, apply, log):
    code, out, _ = git(repo, "ls-remote", "--heads", "origin", branch)
    if code != 0:
        log(f"  원격 브랜치 확인 실패 {branch}")
        return
    if not out:
        log(f"  원격 브랜치 이미 없음 {branch}")
        return
    if apply:
        code, _, err = git(repo, "push", "-q", "origin", "--delete", branch)
        log(f"  원격 브랜치 삭제 {branch}" if code == 0 else f"  원격 브랜치 삭제 실패 {branch}: {err}")
    else:
        log(f"  원격 브랜치를 지울 것 {branch}")


def delete_specs(specs_dir, name, apply, log):
    if not specs_dir:
        return
    for candidate in (specs_dir / f"{name}.md", specs_dir / f"spec-{name}.md"):
        if candidate.is_file():
            if apply:
                candidate.unlink()
                log(f"  지시서 삭제 {candidate}")
            else:
                log(f"  지시서를 지울 것 {candidate}")


def sweep_worktree(repo, path, branch, args, workers, terminals, specs_dir, log):
    name = Path(path).name
    if not branch:
        log(f"건너뜀 {path}: 브랜치가 없다(detached)")
        return
    reason = protected(repo, branch, args.base)
    if reason:
        log(f"건너뜀 {path}: {reason} ({branch})")
        return
    ok, merged_head, why = merged(repo, branch, args.base)
    if not ok:
        log(f"남김 {path}: {why}")
        return
    if dirty(path):
        log(f"건너뜀 {path}: 커밋 안 된 변경")
        return
    lost = unpushed(path, "HEAD", merged_head, merged_head is None)
    if lost:
        log(f"건너뜀 {path}: 원격에 없는 커밋 {lost if lost > 0 else '확인 실패'}")
        return
    mine = workers_at(workers, path)
    alive = {t.get("handle") for t in terminals or []}
    live = [w for w in mine if w.get("workerState") in LIVE_STATES or w.get("agentTerminalHandle") in alive]
    if live:
        log(f"건너뜀 {path}: 살아 있는 worker {', '.join(w.get('dispatchId', '?') for w in live)}")
        return
    by_pr = why == BY_PR
    if not by_pr and terminals_at(terminals, path):
        log(f"건너뜀 {path}: 살아 있는 터미널이 있다. PR 이 MERGED 가 아니면 터미널을 닫지 않는다")
        return

    log(f"정리 {path} ({branch}, {why})")
    # 터미널은 PR 이 MERGED 일 때만 닫는다. cherry 로만 판정한 브랜치는 막 만든 브랜치일 수 있다
    for handle in terminals_at(terminals, path) if by_pr else []:
        if args.apply:
            code, _, _ = run([ORCA, "terminal", "close", "--terminal", handle, "--json"])
            log(f"  터미널 닫음 {handle}" if code == 0 else f"  터미널 닫기 실패 {handle}")
        else:
            log(f"  터미널을 닫을 것 {handle}")
    for w in mine:
        dispatch = w.get("dispatchId")
        if not dispatch or (w.get("resource") or {}).get("releaseState") == "released":
            continue
        if args.apply:
            code, _, _ = run([ORCA, "orchestration", "worker-release", "--dispatch", dispatch, "--json"])
            log(f"  dispatch release {dispatch}" if code == 0 else f"  dispatch release 실패 {dispatch}")
        else:
            log(f"  dispatch 를 release 할 것 {dispatch}")
    if not args.apply:
        busy = holders(path)
        if busy:
            log(f"  터미널을 닫은 뒤에도 프로세스 {busy} 개가 남으면 다음 실행으로 미룬다")
        log(f"  worktree 와 로컬 브랜치를 지울 것 {branch}")
        delete_remote(repo, branch, False, log)
        delete_specs(specs_dir, name, False, log)
        return

    busy = 0
    for _ in range(args.wait):
        busy = holders(path)
        if not busy:
            break
        time.sleep(1)
    if busy:
        log(f"  건너뜀: 그 경로를 쓰는 프로세스 {busy} 개. 다음 실행에서 다시 시도한다")
        return
    cmd = ["zsh", str(REMOVE), path, "--delete-branch"]
    if merged_head:
        cmd += ["--merged-head", merged_head]
    code, out, err = run(cmd)
    log("  " + (out or err).replace("\n", "\n  "))
    if code != 0:
        return
    delete_remote(repo, branch, True, log)
    delete_specs(specs_dir, name, True, log)


def sweep_branches(repo, args, checked_out, log):
    code, out, _ = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    if code != 0:
        return
    for branch in out.splitlines():
        if branch in checked_out or protected(repo, branch, args.base):
            continue
        ok, merged_head, why = merged(repo, branch, args.base)
        if not ok:
            continue
        lost = unpushed(repo, branch, merged_head, merged_head is None)
        if lost:
            log(f"건너뜀 브랜치 {branch}: 원격에 없는 커밋 {lost if lost > 0 else '확인 실패'}")
            continue
        if args.apply:
            code, _, err = git(repo, "branch", "-D", branch)
            log(f"브랜치 삭제 {branch} ({why})" if code == 0 else f"브랜치 삭제 실패 {branch}: {err}")
        else:
            log(f"브랜치를 지울 것 {branch} ({why})")
        delete_remote(repo, branch, args.apply, log)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base", default="main")
    parser.add_argument("--run")
    parser.add_argument("--specs-dir")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wait", type=int, default=5, help="터미널을 닫은 뒤 프로세스가 빠지기를 기다리는 초. 기본 5")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    repo = Path(args.repo).resolve()
    specs_dir = None
    if args.specs_dir:
        specs_dir = Path(args.specs_dir)
        specs_dir = specs_dir if specs_dir.is_absolute() else repo / specs_dir

    def log(line):
        print(line, flush=True)

    try:
        git(repo, "fetch", "-q", "--prune", "origin")
        items = worktrees(repo)
    except RuntimeError as exc:
        print(f"cleanup-sweep: {exc}", file=sys.stderr)
        return 2
    workers = []
    terminals = live_terminals()
    if terminals is None:
        print("cleanup-sweep: orca terminal list 를 읽지 못해 살아 있는 worker 를 판정할 수 없다", file=sys.stderr)
        return 2
    if args.run:
        workers = (orca_json("orchestration", "worker-list", "--run", args.run) or {}).get("workers", [])
    log(f"cleanup-sweep {'apply' if args.apply else 'dry-run'}: {repo} (base {args.base})")
    for path, branch in items:
        sweep_worktree(repo, path, branch, args, workers, terminals, specs_dir, log)
    remaining = {branch for _, branch in worktrees(repo)}
    _, main_branch, _ = git(repo, "branch", "--show-current")
    sweep_branches(repo, args, remaining | {main_branch}, log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
