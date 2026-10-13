#!/usr/bin/env python3
"""보드(board.json)에서 PR 이 머지된 항목을 done 으로 바꾸고 목표 진행률을 다시 센다.

하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다. 이 스크립트는 상태 줄을 쓰지 않는다.
PR 상태나 커밋 같은 자동 줄은 읽기 어렵고 단계와 섞여 보드를 흐린다(사용자 요청).

    - pr 칸의 PR 이 MERGED 면 항목을 done 으로 바꾸고, 아직 ✓ 가 없는 단계에 「✓ 」 를 붙인다
    - 예전 버전이 남긴 「자동: 」 줄은 지운다
    - --goal 을 주면 끝에 goal-progress.py 로 목표 진행률을 다시 센다

사용법:
    board-sync.py [--board PATH] [--repo DIR] [--goal GOAL_ID --goal-items FILE] [--dry-run]

    --board       board.json. 기본은 git 루트의 .omc/handoffs/board.json, 없으면 .omc/board.json
    --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 ~/.claude/mods/work-board/bin/board.py
    --repo        gh 를 돌릴 저장소. 기본은 현재 디렉터리
    --goal, --goal-items
                  주면 끝에 goal-progress.py 로 목표 진행률을 다시 센다
    --dry-run     보드를 고치지 않고 바뀔 항목만 낸다

GH 환경 변수로 gh 실행 파일을 바꾼다.

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
LEGACY_AUTO = "자동: "
DONE_MARK = "✓ "
SKIP_STATUS = {"done", "goal"}
GH = os.environ.get("GH", "gh")


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


def pr_merged(pr, repo):
    """pr 칸의 첫 PR 이 MERGED 인지. 조회에 실패하면 머지되지 않은 것으로 본다."""
    num = re.sub(r"\D", "", str(pr).split(",")[0])
    if not num:
        return False
    return sh(GH, "pr", "view", num, "--json", "state", "--jq", ".state", cwd=repo) == "MERGED"


def next_details(details, merged):
    steps = [d for d in details if not d.startswith(LEGACY_AUTO)]
    if merged:
        steps = [d if d.startswith(DONE_MARK) else DONE_MARK + d for d in steps]
    return steps


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--board")
    parser.add_argument("--board-bin", default=os.environ.get("BOARD_BIN", str(Path.home() / ".claude/mods/work-board/bin/board.py")))
    parser.add_argument("--repo", default=".")
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
    try:
        items = json.loads(board.read_text(encoding="utf-8"))["items"]
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"board-sync: 보드를 읽지 못했다: {board}: {exc}", file=sys.stderr)
        return 1
    items = list(items.values()) if isinstance(items, dict) else items

    changed = []
    for item in items:
        if item.get("status") in SKIP_STATUS:
            continue
        merged = pr_merged(item["pr"], repo) if item.get("pr") else False
        old = item.get("details") or []
        new = next_details(old, merged)
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
