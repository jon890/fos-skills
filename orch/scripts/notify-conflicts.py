#!/usr/bin/env python3
"""머지 직후 열린 PR 가운데 base 와 충돌하는 것을 찾고, 그 PR 의 worker 에게 base 를 합치라고 한 번만 알린다.

앞 PR 이 머지되면 같은 파일을 고친 뒤 PR 이 충돌한다. GitHub 의 CONFLICTING 표시는 아무도 보지 않으면
그 PR 의 worker 는 모른 채 끝나고, 머지 큐에 넣은 뒤에야 STOP 으로 드러난다.

사용법:
    notify-conflicts.py [--repo DIR] [--base BRANCH] [--run RUN] [--state FILE] [--dry-run]

    --repo     대상 저장소 체크아웃. 기본은 현재 디렉터리
    --base     열린 PR 의 base. 기본은 origin/HEAD 가 가리키는 브랜치, 없으면 main
    --run      worker 를 찾을 Orca Run. 없으면 코디네이터에 묶인 Run 이다
    --state    이미 알린 (PR, base SHA) 를 적는 파일. 기본 <orch 작업 폴더>/state/notify-conflicts.json
    --dry-run  알리지 않고 충돌만 낸다

PR 마다:
    - 충돌 여부와 파일은 `git merge-tree --write-tree --name-only` 로 origin/<base> 와 PR HEAD 를 합쳐 본다.
      GitHub 의 mergeable 은 머지 직후 한동안 UNKNOWN 이라 기다리지 않는다
    - 충돌하면 `#<PR> CONFLICTING <브랜치>: 파일...` 을 낸다
    - (PR, base SHA) 를 처음 보면 그 브랜치 워크트리의 worker 에게 `send-to-worker.py` 로 「base 를 합쳐라」 를 보낸다.
      base 가 같은데 다시 돌려도 또 보내지 않는다. base 가 움직이면 새 충돌일 수 있어 다시 보낸다
    - worker 를 찾지 못했거나 dispatch 가 끝나 보내지 못하면 그 사실을 내고 기록하지 않는다. 다음 실행이 다시 본다

GH, ORCA, SEND_TO_WORKER 환경 변수로 실행 파일과 스크립트 경로를 바꾼다.

종료 코드: 0 충돌한 PR 이 없다, 1 충돌한 PR 이 있다(알렸든 못 알렸든), 2 사용법 오류나 조회 실패
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import orch_paths  # noqa: E402

HERE = Path(__file__).resolve().parent
GH = os.environ.get("GH", "gh")
ORCA = os.environ.get("ORCA", "orca")
SEND_TO_WORKER = os.environ.get("SEND_TO_WORKER", str(HERE / "send-to-worker.py"))
ACTIVE = {"pending", "dispatched", "running"}
# send-to-worker.py 가 reply 까지 한 종료 코드. 깨우지 못했어도 메시지는 남았다
DELIVERED = {0, 1, 4}


class LookupFailed(RuntimeError):
    pass


def run(cmd, cwd):
    done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr.strip()


def git(repo, *args):
    return run(["git", *args], repo)


def default_base(repo):
    code, out, _ = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    return out.strip().removeprefix("origin/") if code == 0 and out.strip() else "main"


def open_prs(repo, base):
    code, out, err = run([GH, "pr", "list", "--state", "open", "--base", base, "--limit", "200",
                          "--json", "number,headRefName,headRefOid,isCrossRepository"], repo)
    if code != 0:
        raise LookupFailed(f"gh pr list 실패: {err}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise LookupFailed("gh pr list 의 출력이 JSON 이 아니다") from exc


def conflicts(repo, base_sha, pr):
    """충돌 파일 목록. 충돌이 없으면 빈 목록이다. PR HEAD 를 받지 못하면 LookupFailed."""
    head = pr["headRefOid"]
    if git(repo, "cat-file", "-e", f"{head}^{{commit}}")[0] != 0:
        ref = f"refs/pull/{pr['number']}/head" if pr.get("isCrossRepository") else pr["headRefName"]
        git(repo, "fetch", "-q", "origin", ref)
    code, out, err = git(repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", base_sha, head)
    if code == 0:
        return []
    if code == 1:
        return sorted({line for line in out.splitlines()[1:] if line})
    raise LookupFailed(f"#{pr['number']} 를 base 와 합쳐 보지 못했다: {err}")


def worktree_paths(repo):
    """{브랜치: 워크트리 경로}."""
    code, out, _ = git(repo, "worktree", "list", "--porcelain")
    paths, path = {}, None
    for line in out.splitlines() if code == 0 else []:
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line.startswith("branch refs/heads/") and path:
            paths[line[len("branch refs/heads/"):]] = path
    return paths


def orca_workers(run_id):
    args = [ORCA, "orchestration", "worker-list", *(["--run", run_id] if run_id else []), "--json"]
    code, out, err = run(args, None)
    try:
        return (json.loads(out).get("result") or {}).get("workers") or [] if code == 0 else None
    except (json.JSONDecodeError, AttributeError):
        return None


def worker_for(workers, path):
    """그 워크트리의 dispatch id. 살아 있는 것을 먼저 고른다. 없으면 None."""
    here = [w for w in workers or [] if str((w.get("resource") or {}).get("worktreeId", "")).endswith("::" + path)]
    here.sort(key=lambda w: w.get("dispatchStatus") in ACTIVE)
    return here[-1].get("dispatchId") if here else None


def load_state(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def message(number, base, base_sha, files):
    shown = ", ".join(files[:10]) + (f" 외 {len(files) - 10}개" if len(files) > 10 else "")
    return (f"PR #{number} 이 base {base}({base_sha[:8]}) 와 충돌한다. 충돌 파일: {shown}. "
            f"origin/{base} 를 합쳐 충돌을 풀고 검사를 다시 돌린 뒤 push 한다. 끝나면 status 로 알린다.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base")
    parser.add_argument("--run")
    parser.add_argument("--state")
    parser.add_argument("--dry-run", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    repo = Path(args.repo).resolve()
    if not args.state:
        orch_paths.warn_legacy(repo, "notify-conflicts")
    base = (args.base or default_base(repo)).removeprefix("origin/")
    state_path = Path(args.state) if args.state else orch_paths.path("state", repo) / "notify-conflicts.json"

    if git(repo, "fetch", "-q", "origin")[0] != 0:
        print("notify-conflicts: git fetch origin 실패", file=sys.stderr)
        return 2
    code, out, _ = git(repo, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{base}")
    if code != 0:
        print(f"notify-conflicts: origin/{base} 가 없다", file=sys.stderr)
        return 2
    base_sha = out.strip()
    try:
        prs = open_prs(repo, base)
        found = [(pr, conflicts(repo, base_sha, pr)) for pr in prs]
    except LookupFailed as exc:
        print(f"notify-conflicts: {exc}", file=sys.stderr)
        return 2
    found = [(pr, files) for pr, files in found if files]
    if not found:
        print(f"충돌한 열린 PR 이 없다(base {base} {base_sha[:8]})")
        return 0

    state = load_state(state_path)
    paths, workers = worktree_paths(repo), None
    for pr, files in found:
        number, branch = pr["number"], pr["headRefName"]
        print(f"#{number} CONFLICTING {branch}: {' '.join(files)}")
        key = f"{number}@{base_sha}"
        if key in state:
            print(f"  이미 알렸다({state[key]})")
            continue
        path = paths.get(branch)
        if workers is None and path:
            workers = orca_workers(args.run)
        dispatch = worker_for(workers, path) if path else None
        if not dispatch:
            print(f"  worker 를 찾지 못했다({'워크트리 없음' if not path else '그 워크트리의 dispatch 없음'}). 직접 알린다")
            continue
        body = message(number, base, base_sha, files)
        if args.dry_run:
            print(f"  {dispatch} 에 알릴 것: {body}")
            continue
        sent = subprocess.run([sys.executable, SEND_TO_WORKER, "--dispatch", dispatch, "--body", body,
                               *(["--run", args.run] if args.run else [])], capture_output=True, text=True)
        print("  " + (sent.stdout + sent.stderr).strip().replace("\n", "\n  "))
        if sent.returncode in DELIVERED:
            state[key] = dispatch
            orch_paths.make_parent(state_path, repo)
            state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"  {dispatch} 에 알렸다")
        else:
            print(f"  {dispatch} 에 보내지 못했다(send-to-worker.py 종료 코드 {sent.returncode})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
