#!/usr/bin/env python3
"""보드의 목표 항목 진행 표시줄을 추적 항목들의 상태로 다시 계산한다.

보드는 work-board 형식의 board.json 이다. 항목마다 id 와 status(goal, decide, doing, wait, done)가 있다.
추적 항목 중 status 가 done 인 수를 세어 목표 항목에 `--progress 끝낸수/전체수` 로 넣는다.

사용법:
    goal-progress.py GOAL_ID ITEM_ID [ITEM_ID ...]
    goal-progress.py GOAL_ID --items-file FILE      # 한 줄에 id 하나. 빈 줄과 # 줄은 건너뛴다
    옵션:
      --board PATH       board.json 경로. 기본은 git 루트의 .omc/handoffs/board.json, 없으면 .omc/board.json
      --board-bin PATH   항목을 고치는 명령. 기본은 환경 변수 BOARD_BIN, 없으면 ~/.claude/mods/work-board/bin/board.py
      --details          목표 항목의 하위 줄도 추적 항목마다 하나씩 다시 쓴다. 끝난 항목은 「✓ 」 를 앞에 붙인다
      --dry-run          보드를 고치지 않고 계산 결과만 낸다

보드에 없는 추적 항목은 끝나지 않은 것으로 세고 stderr 로 알린다.
머지 뒤 정리에서 항목을 지웠다면 지우지 말고 done 으로 두거나, 추적 목록에서도 뺀다.

종료 코드: 0 반영했다(또는 --dry-run), 1 보드나 명령을 읽지 못했다, 2 사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DONE_MARK = "✓ "


def default_board() -> Path:
    try:
        root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True,
                                            stderr=subprocess.DEVNULL).strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        root = Path.cwd()
    legacy = root / ".omc/handoffs/board.json"
    return legacy if legacy.exists() else root / ".omc/board.json"


def read_items_file(path: str) -> list[str]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [s.strip() for s in lines if s.strip() and not s.strip().startswith("#")]


def board_items(board: dict) -> dict[str, dict]:
    items = board.get("items", [])
    values = items.values() if isinstance(items, dict) else items
    return {i["id"]: i for i in values if "id" in i}


def progress(by_id: dict[str, dict], tracked: list[str]) -> tuple[int, list[str], list[str]]:
    """(끝낸 수, 하위 줄, 보드에 없는 id) 를 돌려준다."""
    done, details, missing = 0, [], []
    for t in tracked:
        item = by_id.get(t)
        if item is None:
            missing.append(t)
            details.append(t)
            continue
        finished = item.get("status") == "done"
        done += finished
        details.append((DONE_MARK if finished else "") + item.get("title", t))
    return done, details, missing


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("goal")
    ap.add_argument("items", nargs="*")
    ap.add_argument("--items-file")
    ap.add_argument("--board")
    ap.add_argument("--board-bin")
    ap.add_argument("--details", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    try:
        tracked = list(a.items) + (read_items_file(a.items_file) if a.items_file else [])
    except OSError as e:
        sys.stderr.write(f"추적 항목 파일을 읽지 못했다: {e}\n")
        return 1
    tracked = list(dict.fromkeys(tracked))
    if not tracked:
        ap.error("추적 항목을 인자나 --items-file 로 준다")
    board_path = Path(a.board) if a.board else default_board()
    try:
        by_id = board_items(json.loads(board_path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as e:
        sys.stderr.write(f"보드를 읽지 못했다: {board_path}: {e}\n")
        return 1
    if a.goal not in by_id:
        sys.stderr.write(f"목표 항목이 보드에 없다: {a.goal}\n")
        return 1

    done, details, missing = progress(by_id, tracked)
    if missing:
        sys.stderr.write("보드에 없는 추적 항목(끝나지 않은 것으로 셈): " + ", ".join(missing) + "\n")
    value = f"{done}/{len(tracked)}"
    print(f"{a.goal} {value}")
    if a.details:
        for d in details:
            print("  " + d)
    if a.dry_run:
        return 0

    bin_path = a.board_bin or os.environ.get("BOARD_BIN") or str(Path.home() / ".claude/mods/work-board/bin/board.py")
    cmd = [sys.executable, bin_path, "set", a.goal, "--progress", value, "--file", str(board_path)]
    if a.details:
        for d in details:
            cmd += ["--detail", d]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
