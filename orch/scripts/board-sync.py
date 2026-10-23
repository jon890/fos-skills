#!/usr/bin/env python3
"""보드(board.json)에서 PR 이 머지된 항목을 done 으로 바꾸고 목표 진행률을 다시 센다.

하위 줄은 코디네이터가 쓰는 번호 붙은 단계만 둔다. 이 스크립트는 상태 줄을 쓰지 않는다.
PR 상태나 커밋 같은 자동 줄은 읽기 어렵고 단계와 섞여 보드를 흐린다(사용자 요청).

    - pr 칸의 PR 이 MERGED 이고 끝나지 않은 단계가 1개 이하면 남은 단계를 끝내고 항목을 done 으로 바꾼다
    - MERGED 여도 끝나지 않은 단계가 2개 이상이면 done 으로 바꾸지 않는다. 그 PR 번호(#N)가 적힌 단계만
      끝내고 pr 칸을 비운다. 머지 뒤 검증이나 후속 PR 이 남은 항목을 끝난 것으로 보지 않기 위해서다
    - 단계 줄 판정과 끝내기는 보드 명령에 맡긴다. `steps` 로 단계 목록을 받고 `step <id> <n>` 으로 끝낸다.
      이 스크립트는 단계 줄 형식(번호 점, ✓, [x], [ ])을 알지 못한다
    - 예전 버전이 남긴 「자동: 」 줄은 지운다
    - --goal 을 주면 끝에 goal-progress.py 로 목표 진행률을 다시 센다

사용법:
    board-sync.py [--board PATH] [--repo DIR] [--goal GOAL_ID --goal-items FILE] [--dry-run]

    --board       board.json. 기본은 work-board 의 board.py 가 정한 위치
    --board-bin   항목을 고치는 명령. 기본은 BOARD_BIN 환경 변수, 없으면 이 저장소의 work-board/bin/board.py
    --repo        gh 를 돌릴 저장소. 기본은 현재 디렉터리
    --goal, --goal-items
                  --goal 을 주면 끝에 goal-progress.py 로 목표 진행률을 다시 센다.
                  --goal-items 가 없으면 목표 항목의 단계 줄을 센다
    --dry-run     보드를 고치지 않고 바뀔 항목과 부를 보드 명령만 낸다. 단계 목록은 읽는다

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import orch_paths  # noqa: E402

HERE = Path(__file__).resolve().parent
BOARD_BIN = HERE.parents[1] / "work-board/bin/board.py"
LEGACY_AUTO = "자동: "
SKIP_STATUS = {"done", "goal"}
GH = os.environ.get("GH", "gh")


def sh(*cmd, cwd=None):
    try:
        done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def default_board():
    return orch_paths.board_path()


def pr_merged(pr, repo):
    """pr 칸의 첫 PR 이 MERGED 인지. 조회에 실패하면 머지되지 않은 것으로 본다."""
    num = re.sub(r"\D", "", str(pr).split(",")[0])
    if not num:
        return False
    return sh(GH, "pr", "view", num, "--json", "state", "--jq", ".state", cwd=repo) == "MERGED"


def pr_number(pr):
    return re.sub(r"\D", "", str(pr or "").split(",")[0])


def board_steps(board_bin, item_id, board):
    """보드 명령이 판정한 단계 목록 [{number, done, text}]. 읽지 못하면 None."""
    done = subprocess.run(["python3", board_bin, "steps", item_id, "--file", str(board)], capture_output=True, text=True)
    if done.returncode != 0:
        return None
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        return None


def finish_plan(steps, pr=""):
    """(끝낼 단계 번호 목록, 항목을 끝내는지) 를 돌려준다."""
    left = [step for step in steps if not step["done"]]
    if len(left) > 1:
        num = pr_number(pr)
        pattern = re.compile(rf"#{num}(?!\d)") if num else None
        return [step["number"] for step in left if pattern and pattern.search(step["text"])], False
    return [step["number"] for step in left], True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--board")
    parser.add_argument("--board-bin", default=os.environ.get("BOARD_BIN", str(BOARD_BIN)))
    parser.add_argument("--repo", default=".")
    parser.add_argument("--goal")
    parser.add_argument("--goal-items")
    parser.add_argument("--dry-run", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if args.goal_items and not args.goal:
        print("board-sync: --goal-items 는 --goal 과 함께 준다", file=sys.stderr)
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
        kept = [d for d in old if not d.startswith(LEGACY_AUTO)]
        if kept == old and not merged:
            continue
        cmds = []
        if kept != old:
            cmds.append(["set", item["id"]] + [arg for d in kept or [""] for arg in ("--detail", d)])
        finish = False
        if merged:
            steps = board_steps(args.board_bin, item["id"], board)
            if steps is None:
                print(f"board-sync: 단계 목록을 읽지 못했다: {item['id']}", file=sys.stderr)
                return 1
            numbers, finish = finish_plan(steps, item.get("pr"))
            cmds += [["step", item["id"], str(n)] for n in numbers]
            cmds.append(["set", item["id"], "done"] if finish else ["set", item["id"], "--pr", ""])
        changed.append(item["id"])
        if args.dry_run:
            print(item["id"] + (" -> done" if finish else ""), *(" ".join(c) for c in cmds), sep="\n  ")
            continue
        for cmd in cmds:
            if subprocess.run(["python3", args.board_bin, *cmd, "--file", str(board)], stdout=subprocess.DEVNULL).returncode != 0:
                print(f"board-sync: 보드 명령이 실패했다: {item['id']}", file=sys.stderr)
                return 1
    if args.goal and not args.dry_run:
        cmd = ["python3", str(HERE / "goal-progress.py"), args.goal, "--board", str(board), "--board-bin", args.board_bin]
        if args.goal_items:
            cmd += ["--items-file", args.goal_items, "--details"]
        subprocess.run(cmd, stdout=subprocess.DEVNULL)
    print("board-sync:", ", ".join(changed) or "바뀐 항목 없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
