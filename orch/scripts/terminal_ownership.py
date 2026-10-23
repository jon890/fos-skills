#!/usr/bin/env python3
"""워크트리 정리 전에 살아 있는 터미널의 사용자 소유 상태를 확인한다.

소유 상태는 모든 Run 의 worker 행(`all_workers`)에서 읽는다. 범위 없는 `worker-list` 는 부른 터미널에 Run 이
묶여 있으면 그 Run 만 준다(scope.source bound). 코디네이터와 그 자식 프로세스에서 부르면 늘 그렇다.
Orca CLI 는 `ORCA_TERMINAL_HANDLE` 이 없으면 작업 디렉터리가 든 워크트리의 활성 터미널로 호출자를 정해,
환경 변수를 빼도 범위가 넓어지지 않는다. 그래서 범위가 all 이 아니면 `run-list` 를 끝까지 따라
Run 마다 `worker-list --run`(scope flag)을 읽어 합친다. 조회 자체가 실패할 때만 실패다.
"""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys

# Run 마다 읽을 때 동시에 띄우는 orca 수. Run 251개 실측: 8 이면 30초, 16 이면 18초
JOBS = 16
LOOKUP_ERRORS = (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired)


def query(*args):
    done = subprocess.run([os.environ.get("ORCA", "orca"), *args, "--json"],
                          capture_output=True, text=True, timeout=30)
    data = json.loads(done.stdout)
    if done.returncode or data.get("ok") is False or not isinstance(data.get("result"), dict):
        raise ValueError("Orca 조회 실패")
    return data["result"]


def worker_pages(*args, scope):
    """worker-list 를 끝까지 읽은 행 목록. 첫 페이지의 scope.source 가 scope 가 아니면 None 이다."""
    rows, cursor, seen = [], None, set()
    while True:
        result = query("orchestration", "worker-list", "--limit", "100", *args,
                       *(["--cursor", cursor] if cursor else []))
        if not cursor and (result.get("scope") or {}).get("source") != scope:
            return None
        if not isinstance(result["workers"], list):
            raise ValueError("worker 목록 형식 오류")
        rows += result["workers"]
        page = result.get("page") or {}
        cursor = page.get("nextCursor")
        if not cursor and not page.get("hasMore"):
            return rows
        if not cursor or cursor in seen:
            raise ValueError("다음 페이지 확인 실패")
        seen.add(cursor)


def run_workers(run):
    """그 Run 의 worker 행 전부."""
    rows = worker_pages("--run", run, scope="flag")
    if rows is None:
        raise ValueError("--run 범위가 아니다")
    return rows


def run_ids():
    ids, cursor, seen = [], None, set()
    while True:
        result = query("orchestration", "run-list", "--limit", "100", *(["--cursor", cursor] if cursor else []))
        ids += [run["id"] for run in result["runs"]]
        cursor = result.get("nextCursor")
        if not cursor:
            return ids
        if cursor in seen:
            raise ValueError("다음 Run 페이지 확인 실패")
        seen.add(cursor)


def all_workers():
    """모든 Run 의 worker 행. 읽지 못하면 LOOKUP_ERRORS 중 하나를 낸다."""
    rows = worker_pages(scope="all")
    if rows is not None:
        return rows
    with ThreadPoolExecutor(JOBS) as pool:
        return [row for rows in pool.map(run_workers, run_ids()) for row in rows]


def once(fn):
    """fn 을 한 번만 부르고 그 결과나 예외를 되풀이한다. 정리 한 번에 모든 Run 을 한 번만 읽는다."""
    box = []

    def call():
        if not box:
            try:
                box.append((fn(), None))
            except LOOKUP_ERRORS as exc:
                box.append((None, exc))
        rows, exc = box[0]
        if exc:
            raise exc
        return rows
    return call


def row_handle(row):
    return (row.get("resource") or {}).get("terminalHandle") or row.get("agentTerminalHandle")


def blocker(worktree, ignore=frozenset(), workers=all_workers):
    """안전하면 빈 문자열, 사용자 보유 또는 조회 실패면 남길 이유를 돌려준다.
    ignore 에 든 handle 은 호출자가 닫아도 된다고 판정한 터미널이라 소유 상태를 보지 않는다.
    workers 는 모든 Run 의 worker 행을 돌려주는 함수다. 여러 경로를 볼 때는 once(all_workers) 를 넘긴다."""
    try:
        target = Path(worktree).resolve()
        terminals = query("terminal", "list")["terminals"]
        if not isinstance(terminals, list):
            raise ValueError("터미널 목록 형식 오류")
        handles = {t["handle"] for t in terminals if t.get("worktreePath")
                   and Path(t["worktreePath"]).resolve().is_relative_to(target)}
        if not handles:
            return ""
        for row in workers():
            handle = row_handle(row)
            if handle in handles and handle not in ignore:
                state = (row.get("resource") or {}).get("ownershipState")
                if state in {"user_owned", "released"}:
                    return "사용자 보유 터미널"
                if state != "owned":
                    raise ValueError("터미널 소유 상태 누락")
        return ""
    except LOOKUP_ERRORS:
        return "터미널 소유 상태 조회 실패"


if __name__ == "__main__":
    reason = blocker(sys.argv[1])
    if reason:
        print(f"남김: {reason} ({sys.argv[1]})")
    sys.exit(1 if reason else 0)
