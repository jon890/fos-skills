#!/usr/bin/env python3
"""워크트리 정리 전에 살아 있는 터미널의 사용자 소유 상태를 확인한다."""

import json
import os
from pathlib import Path
import subprocess
import sys


def query(*args):
    env = {k: v for k, v in os.environ.items() if k != "ORCA_TERMINAL_HANDLE"}
    done = subprocess.run([os.environ.get("ORCA", "orca"), *args, "--json"],
                          capture_output=True, text=True, env=env, timeout=30)
    data = json.loads(done.stdout)
    if done.returncode or data.get("ok") is False or not isinstance(data.get("result"), dict):
        raise ValueError("Orca 조회 실패")
    return data["result"]


def blocker(worktree, ignore=frozenset()):
    """안전하면 빈 문자열, 사용자 보유 또는 조회 실패면 남길 이유를 돌려준다.
    ignore 에 든 handle 은 호출자가 닫아도 된다고 판정한 터미널이라 소유 상태를 보지 않는다."""
    try:
        target = Path(worktree).resolve()
        terminals = query("terminal", "list")["terminals"]
        if not isinstance(terminals, list):
            raise ValueError("터미널 목록 형식 오류")
        handles = {t["handle"] for t in terminals if t.get("worktreePath")
                   and Path(t["worktreePath"]).resolve().is_relative_to(target)}
        if not handles:
            return ""
        cursor, seen = None, set()
        while True:
            result = query("orchestration", "worker-list", "--limit", "100",
                           *(["--cursor", cursor] if cursor else []))
            if (result.get("scope") or {}).get("source") != "all":
                raise ValueError("모든 Run 범위가 아니다")
            for row in result["workers"]:
                resource = row.get("resource") or {}
                handle = resource.get("terminalHandle") or row.get("agentTerminalHandle")
                if handle in handles and handle not in ignore:
                    state = resource.get("ownershipState")
                    if state in {"user_owned", "released"}:
                        return "사용자 보유 터미널"
                    if state != "owned":
                        raise ValueError("터미널 소유 상태 누락")
            page = result.get("page") or {}
            cursor = page.get("nextCursor")
            if not cursor and not page.get("hasMore"):
                return ""
            if not cursor or cursor in seen:
                raise ValueError("다음 페이지 확인 실패")
            seen.add(cursor)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return "터미널 소유 상태 조회 실패"


if __name__ == "__main__":
    reason = blocker(sys.argv[1])
    if reason:
        print(f"남김: {reason} ({sys.argv[1]})")
    sys.exit(1 if reason else 0)
