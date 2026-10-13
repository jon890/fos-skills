#!/usr/bin/env python3
"""보드(board.json)의 끝나지 않은 항목을 PR, worktree, worker 의 실제 상태로 다시 맞춘다.

코디네이터가 손으로 고치면 PR 머지, worker 진행, 커밋이 보드에 늦게 반영된다.
항목마다 「자동: 」 으로 시작하는 하위 줄만 다시 쓰고, 사람이 쓴 줄은 그대로 둔다.

    - pr 칸: PR 상태, 머지 가능 여부, CI. MERGED 면 항목을 done 으로 바꾼다
    - worktree 칸: 브랜치, 기준 브랜치 대비 앞뒤 커밋 수, 커밋 안 된 변경, 마지막 커밋
    - worker: 그 worktree 를 맡은 worker 의 상태와 터미널의 마지막 보고 줄.
      Dispatch 가 succeeded 여도 터미널이 살아 있으면 후속 일을 하고 있을 수 있어 터미널 기준으로 본다

사용법:
    board-sync.py [--board PATH] [--repo DIR] [--base origin/main] [--worktree-root DIR]
                  [--run RUN_ID] [--goal GOAL_ID --goal-items FILE] [--dry-run]

    --board          board.json. 기본은 git 루트의 .omc/handoffs/board.json, 없으면 .omc/board.json
    --board-bin      항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 ~/.claude/mods/work-board/bin/board.py
    --repo           gh 를 돌릴 저장소. 기본은 현재 디렉터리
    --base           앞뒤 커밋을 셀 기준. 기본 origin/main
    --worktree-root  worktree 칸이 이름만 적혀 있을 때 붙일 디렉터리. 기본은 --repo
    --run            worker 를 찾을 Orca Run. 없으면 worker 줄을 쓰지 않는다
    --goal, --goal-items
                     주면 끝에 goal-progress.py 로 목표 진행률을 다시 센다
    --dry-run        보드를 고치지 않고 바뀔 하위 줄만 낸다

ORCA, GH 환경 변수로 실행 파일을 바꾼다. 기본 orca, gh.

종료 코드: 0 반영했다(또는 --dry-run), 1 보드를 읽지 못했거나 보드 명령이 실패했다, 2 사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUTO = "자동: "
SKIP_STATUS = {"done", "goal"}
ORCA = os.environ.get("ORCA", "orca")
GH = os.environ.get("GH", "gh")
REPORT_MARKS = ("⏺", "※ recap")
BUSY_MARKS = ("✻", "✶", "✳", "·", "✢")


def sh(*cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def default_board():
    root = Path(sh("git", "rev-parse", "--show-toplevel") or Path.cwd())
    legacy = root / ".omc/handoffs/board.json"
    return legacy if legacy.exists() else root / ".omc/board.json"


def pr_lines(pr, repo):
    """(하위 줄, MERGED 인지). 칸에 PR 이 여럿이면 첫 번째를 본다."""
    num = re.sub(r"\D", "", str(pr).split(",")[0])
    if not num:
        return [], False
    raw = sh(GH, "pr", "view", num, "--json", "state,mergeStateStatus,mergedAt,statusCheckRollup,headRefOid", cwd=repo)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return [f"{AUTO}PR #{num} 조회 실패"], False
    if data.get("state") == "MERGED":
        when = (data.get("mergedAt") or "")[:16].replace("T", " ")
        return [f"{AUTO}✓ PR #{num} 머지됨 {when}Z".rstrip()], True
    checks = data.get("statusCheckRollup") or []
    failed = [c.get("name") or c.get("context") for c in checks
              if (c.get("conclusion") or "") in ("FAILURE", "CANCELLED", "TIMED_OUT") or (c.get("state") or "") in ("FAILURE", "ERROR")]
    running = [c for c in checks if (c.get("status") or "") in ("IN_PROGRESS", "QUEUED", "PENDING") or (c.get("state") or "") == "PENDING"]
    if failed:
        ci = f"실패 {','.join(str(f) for f in failed)}"
    elif running:
        ci = f"진행 {len(running)}"
    else:
        ci = "통과" if checks else "체크 없음"
    head = (data.get("headRefOid") or "")[:8]
    return [f"{AUTO}PR #{num} {data.get('state')} {data.get('mergeStateStatus')} (HEAD {head}), CI {ci}"], False


def worktree_path(name, root):
    if not name:
        return None
    path = Path(name).expanduser()
    return path if path.is_absolute() else root / name


def worktree_lines(name, root, base):
    path = worktree_path(name, root)
    if path is None:
        return []
    if not path.exists():
        return [f"{AUTO}worktree 없음({name})"]
    cwd = str(path)
    branch = sh("git", "branch", "--show-current", cwd=cwd)
    ahead = sh("git", "rev-list", "--count", f"{base}..HEAD", cwd=cwd) or "?"
    behind = sh("git", "rev-list", "--count", f"HEAD..{base}", cwd=cwd) or "?"
    last = sh("git", "log", "-1", "--format=%h %cd %s", "--date=format:%H:%M", cwd=cwd)
    tail = ", 커밋 안 된 변경 있음" if sh("git", "status", "--short", cwd=cwd) else ""
    return [f"{AUTO}{branch} 앞 {ahead}, 뒤 {behind}{tail}", f"{AUTO}마지막 커밋 {last[:110]}"]


def orca_result(*args):
    try:
        return json.loads(sh(ORCA, *args, "--json"))["result"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return {}


def last_report(screen):
    """터미널 화면에서 마지막 보고 줄과 작업 중인지를 낸다."""
    lines = screen.splitlines()
    said = [l.strip() for l in lines if l.lstrip().startswith(REPORT_MARKS)]
    busy = any(l.lstrip().startswith(BUSY_MARKS) and "done" not in l for l in lines[-15:])
    return (said[-1][:120] if said else ""), busy


def worker_lines(name, root, workers, alive):
    path = worktree_path(name, root)
    if path is None:
        return []
    mine = [w for w in workers if str((w.get("resource") or {}).get("worktreeId", "")).endswith("::" + str(path))]
    live = [w for w in mine if w.get("agentTerminalHandle") in alive]
    if not live:
        return [f"{AUTO}살아 있는 worker 없음"] if mine else []
    w = live[-1]
    screen = sh(ORCA, "terminal", "read", "--terminal", w["agentTerminalHandle"], "--screen", "--limit", "60")
    said, busy = last_report(screen)
    return [f"{AUTO}worker {w.get('dispatchId')} {w.get('workerState')}{' (작업 중)' if busy else ''}: {said}".rstrip()]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--board")
    parser.add_argument("--board-bin", default=os.environ.get("BOARD_BIN", str(Path.home() / ".claude/mods/work-board/bin/board.py")))
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--worktree-root")
    parser.add_argument("--run")
    parser.add_argument("--goal")
    parser.add_argument("--goal-items")
    parser.add_argument("--dry-run", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if bool(args.goal) != bool(args.goal_items):
        print("board-sync: --goal 과 --goal-items 는 함께 준다", file=sys.stderr)
        return 2
    board = Path(args.board) if args.board else default_board()
    repo = Path(args.repo).resolve()
    root = Path(args.worktree_root).expanduser().resolve() if args.worktree_root else repo
    try:
        items = json.loads(board.read_text(encoding="utf-8"))["items"]
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"board-sync: 보드를 읽지 못했다: {board}: {exc}", file=sys.stderr)
        return 1
    items = list(items.values()) if isinstance(items, dict) else items

    workers, alive = [], set()
    if args.run:
        workers = orca_result("orchestration", "worker-list", "--run", args.run).get("workers", [])
        alive = {t.get("handle") for t in orca_result("terminal", "list").get("terminals", [])}

    changed = []
    for item in items:
        if item.get("status") in SKIP_STATUS:
            continue
        lines, merged = pr_lines(item["pr"], repo) if item.get("pr") else ([], False)
        lines += worktree_lines(item.get("worktree"), root, args.base)
        lines += worker_lines(item.get("worktree"), root, workers, alive)
        old = item.get("details") or []
        new = [d for d in old if not d.startswith(AUTO)] + lines
        if new == old and not merged:
            continue
        changed.append(item["id"])
        if args.dry_run:
            print(item["id"] + (" -> done" if merged else ""), *new, sep="\n  ")
            continue
        cmd = ["python3", args.board_bin, "set", item["id"]] + (["done"] if merged else []) + ["--file", str(board)]
        for detail in new or [""]:
            cmd += ["--detail", detail]
        if subprocess.run(cmd, stdout=subprocess.DEVNULL).returncode != 0:
            print(f"board-sync: 보드 명령이 실패했다: {item['id']}", file=sys.stderr)
            return 1
    if args.goal and not args.dry_run:
        subprocess.run(["python3", str(HERE / "goal-progress.py"), args.goal, "--items-file", args.goal_items,
                        "--board", str(board), "--board-bin", args.board_bin, "--details"], stdout=subprocess.DEVNULL)
    print("board-sync:", ", ".join(changed) or "바뀐 항목 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
