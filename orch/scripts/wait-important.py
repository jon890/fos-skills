#!/usr/bin/env python3
"""코디네이터가 처리할 메시지가 올 때까지 기다린다. heartbeat 만 든 묶음은 ack 하고 계속 기다린다.

`check --wait` 는 `--types` 를 깨어나는 조건으로만 쓰고, 돌려주는 delivery 는 그때 쌓인 묶음 전체다.
heartbeat 만 든 묶음으로 깨어나면 코디네이터가 읽을 것 없이 ack 하고 다시 거느라 깨어남마다 한 턴을 쓴다.
이 스크립트가 그 묶음을 대신 ack 하고, 처리할 종류가 든 묶음이 오면 ack 하지 않고 그대로 낸다.
코디네이터는 그 묶음을 `triage-messages.py` 로 읽은 뒤 마지막 줄의 delivery id 를 다음 대기의 `--ack` 로 넘긴다.

**Bash 도구의 `run_in_background` 로만 띄운다.** 셸의 `&` 나 `nohup` 으로 띄우면 끝나도 완료 알림이 오지 않는다.
플러그인 hook(`hooks/block-background-wait.py`)이 그런 호출을 막는다.

사용법:
    wait-important.py --run RUN_ID [--ack DELIVERY_ID] [--types worker_done,question,escalation,status]
                      [--timeout-ms 7000000] [--kill-stale] [--lost-interval-sec 60]

    --run         기다릴 Run
    --ack         앞 대기가 낸 delivery id. 첫 대기처럼 넘길 것이 없으면 뺀다
    --types       깨어날 메시지 종류. 기본 worker_done,question,escalation,status
    --timeout-ms  전체 대기 한도(ms). 기본 7000000. 하네스의 명령 한도(Bash 최대 7200000)보다 짧게 준다
    --lost-interval-sec  대기하는 동안 Run 의 worker 상태를 볼 간격(초). 기본 60. 0 이면 보지 않는다. 아래 「끊긴 worker」
    --kill-stale  대기 자리를 쥔 프로세스 가운데 부모가 init(PID 1)인 것과 그 밑의 대기를 종료한다. 아래 「남은 대기」

출력:
    처리할 묶음이 오면 그 `check --json` 결과를 한 줄 JSON 으로 내고, 마지막 줄에 `LAST_DELIVERY <id>` 를 낸다.
    시간 한도가 지나면 `TIMEOUT LAST_DELIVERY <id>` 를 낸다. id 는 ack 하지 못하고 남은 delivery 이고, 없으면 `-` 다.

끊긴 worker:
    기기가 재시작되어 worker 터미널이 사라져도 메시지는 오지 않아 대기가 끝나지 않는다.
    그래서 대기하는 동안 `--lost-interval-sec` 마다 `orca orchestration worker-list --run <id> --json` 으로 상태를 본다.
    대기를 시작할 때 살아 있던(dispatchStatus 가 pending, dispatched, running) dispatch 가
    workerState 가 abandoned, failed, stopped 이거나 dispatchStatus 가 failed 이거나 단계가 terminal_missing 으로 바뀌면
    메시지를 기다리지 않고 `WORKER_LOST ctx_... stage=terminal_missing` 줄과 `LAST_DELIVERY <id>` 줄을 내고 종료 코드 5 로 끝난다.
    시작할 때 이미 끝나 있던 dispatch 는 보지 않는다. 끝난 worker 가 남은 Run 에서 대기가 바로 끝나지 않게 하려는 것이다.
    worker-list 를 읽지 못하면 그 번의 확인만 건너뛴다.

남은 대기:
    Run 의 대기 자리는 하나다. 앞 세션이 띄운 `check --wait` 가 남아 있으면 새 대기는 매번 `waiter_exists` 로
    바로 끝난다. 다시 걸어도 같은 오류만 받으므로, 이 오류를 받으면 되풀이하지 않고 같은 사용자의 프로세스 가운데
    이 Run 의 `check --wait` 와 `wait-important` 를 찾아 stderr 로 보여 주고 종료 코드 4 로 끝난다.
    부모가 init 인 것과 그 밑에 딸린 것은 세션이 끝나 고아가 된 대기라 그 메시지를 받을 쪽이 없다.
    `--kill-stale` 을 주면 그것만 종료한다.
    부모가 살아 있는 것은 다른 세션이 아직 기다리는 중일 수 있어 종료하지 않는다.

ORCA 환경 변수로 orca 실행 파일을, PS 환경 변수로 ps 실행 파일을 바꾼다.

종료 코드:
    0  처리할 묶음이 왔다
    3  시간 한도가 지났다. 실패가 아니므로 마지막 줄의 id 로 다시 건다
    4  이 Run 에 다른 대기가 있다(waiter_exists). 남은 프로세스를 정리한 뒤 다시 건다
    5  대기를 시작할 때 살아 있던 worker 가 끊겼다(WORKER_LOST). references/launch.md 의 「끊긴 worker 다시 띄우기」 를 따른다
    1  orca 가 그 밖의 오류를 냈다(runtime_unavailable 같은 것). 그 JSON 을 그대로 낸다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time

ORCA = os.environ.get("ORCA", "orca")
PS = os.environ.get("PS", "ps")
DEFAULT_TYPES = "worker_done,question,escalation,status"


LIVE_STATUSES = {"pending", "dispatched", "running"}
LOST_WORKER_STATES = {"abandoned", "failed", "stopped"}


def worker_rows(run_id):
    """worker-list 의 workers. 읽지 못하면 None 이다."""
    done = subprocess.run([ORCA, "orchestration", "worker-list", "--run", run_id, "--json"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    return (data.get("result") or {}).get("workers") or []


def live_dispatches(rows):
    return {w["dispatchId"] for w in rows if w.get("dispatchId") and w.get("dispatchStatus") in LIVE_STATUSES}


def lost_workers(rows, watched):
    """watched 에 든 dispatch 가운데 끊긴 것. [(dispatch id, 단계)]"""
    lost = []
    for w in rows:
        if w.get("dispatchId") not in watched:
            continue
        detail = (((w.get("projection") or {}).get("stage") or {}).get("detail"))
        if w.get("workerState") in LOST_WORKER_STATES or w.get("dispatchStatus") == "failed" or detail == "terminal_missing":
            lost.append((w["dispatchId"], detail or w.get("workerState")))
    return lost


def check(run_id, types, ack, timeout_ms, watched=None, interval=0):
    """`check --wait --json` 한 번. (stdout 의 JSON, 원문). JSON 이 아니면 None 이다.

    watched 가 있으면 interval 초마다 worker 상태를 보고, 끊긴 worker 가 있으면 check 를 멈추고
    ("lost", [(dispatch id, 단계)]) 를 낸다.
    """
    cmd = [ORCA, "orchestration", "check", "--run", run_id, "--wait", "--types", types,
           "--timeout-ms", str(timeout_ms), "--json"]
    if ack:
        cmd[3:3] = ["--ack", ack]
    # keepalive 줄은 stderr 로 나온다. stdout 만 읽는다
    if not watched or interval <= 0:
        done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        stdout = done.stdout
    else:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        while True:
            try:
                stdout, _ = proc.communicate(timeout=interval)
                break
            except subprocess.TimeoutExpired:
                rows = worker_rows(run_id)
                lost = lost_workers(rows, watched) if rows else []
                if lost:
                    proc.kill()
                    proc.communicate()
                    return "lost", lost
    try:
        return json.loads(stdout), stdout
    except json.JSONDecodeError:
        return None, stdout


def is_waiter_exists(data):
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return False
    return error.get("code") == "waiter_exists" or "active actionable waiter" in str(error.get("message", ""))


def waiter_processes(run_id):
    """같은 사용자의 프로세스 가운데 이 Run 을 기다리는 것. [(pid, ppid, 시작 시각, 명령)]"""
    done = subprocess.run([PS, "-U", str(os.getuid()), "-o", "pid=,ppid=,lstart=,command="],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    rows = []
    for line in done.stdout.splitlines():
        # lstart 는 「Tue Oct 20 10:00:00 2026」 처럼 다섯 낱말이다
        parts = line.split(None, 7)
        if len(parts) == 8 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), " ".join(parts[2:7]), parts[7]))
    # 이 스크립트와 이것을 띄운 셸은 명령에 Run id 가 들어 있어도 남은 대기가 아니다
    parent = {pid: ppid for pid, ppid, _, _ in rows}
    mine, pid = set(), os.getpid()
    while pid > 1 and pid not in mine:
        mine.add(pid)
        pid = parent.get(pid, 0)
    found = []
    for pid, ppid, started, command in rows:
        if pid in mine or run_id not in command:
            continue
        waiting = "orchestration check" in command and "--wait" in command
        if waiting or "wait-important" in command:
            found.append((pid, ppid, started, command))
    return found


def stale_pids(procs):
    """부모가 init 인 대기와, 그 밑에 딸린 대기(셸 밑의 스크립트, 스크립트 밑의 check)"""
    parent = {pid: ppid for pid, ppid, _, _ in procs}
    stale = {pid for pid, ppid in parent.items() if ppid == 1}
    grew = True
    while grew:
        more = {pid for pid, ppid in parent.items() if ppid in stale} - stale
        stale |= more
        grew = bool(more)
    return stale


def report_waiters(run_id, kill_stale):
    procs = waiter_processes(run_id)
    err = sys.stderr
    print(f"wait-important: Run {run_id} 에 이미 다른 대기가 있다(waiter_exists). 다시 걸어도 같은 오류만 받는다", file=err)
    if not procs:
        print("  같은 사용자의 프로세스에서 찾지 못했다. 다른 사용자나 다른 머신의 대기일 수 있다", file=err)
        return
    stale = stale_pids(procs)
    for pid, ppid, started, command in procs:
        kind = "고아" if pid in stale else f"부모 {ppid} 살아 있음"
        print(f"  PID {pid}  {kind}  시작 {started}  {command}", file=err)
    live = [pid for pid, _, _, _ in procs if pid not in stale]
    stale = [pid for pid, _, _, _ in procs if pid in stale]
    if stale and kill_stale:
        for pid in stale:
            try:
                os.kill(pid, signal.SIGTERM)
                print(f"  PID {pid} 를 종료했다", file=err)
            except ProcessLookupError:
                pass
            except PermissionError as exc:
                print(f"  PID {pid} 를 종료하지 못했다: {exc}", file=err)
    elif stale:
        print(f"  고아 대기는 받을 쪽이 없다. --kill-stale 을 더해 다시 걸거나 kill {' '.join(map(str, stale))}", file=err)
    if live:
        print("  부모가 살아 있는 대기는 다른 세션이 기다리는 중일 수 있다. 그 세션을 확인한 뒤 직접 종료한다", file=err)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True)
    parser.add_argument("--ack")
    parser.add_argument("--types", default=DEFAULT_TYPES)
    parser.add_argument("--timeout-ms", type=int, default=7000000)
    parser.add_argument("--kill-stale", action="store_true")
    parser.add_argument("--lost-interval-sec", type=float, default=60)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    wanted = {t.strip() for t in args.types.split(",") if t.strip()}
    if not wanted or args.timeout_ms <= 0 or args.lost_interval_sec < 0:
        print("wait-important: --types 와 --timeout-ms 는 비어 있거나 0 일 수 없고 --lost-interval-sec 는 음수일 수 없다", file=sys.stderr)
        return 2
    # 대기를 시작할 때 살아 있던 dispatch 만 지켜본다. 읽지 못하면 지켜보지 않는다
    watched = set()
    if args.lost_interval_sec > 0:
        watched = live_dispatches(worker_rows(args.run) or [])

    deadline = time.monotonic() + args.timeout_ms / 1000
    ack, skipped = args.ack, 0
    while True:
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            print(f"TIMEOUT LAST_DELIVERY {ack or '-'}")
            return 3
        data, raw = check(args.run, args.types, ack, remaining, watched, args.lost_interval_sec)
        if data == "lost":
            for dispatch, stage in raw:
                print(f"WORKER_LOST {dispatch} stage={stage}")
            print(f"LAST_DELIVERY {ack or '-'}")
            return 5
        if not isinstance(data, dict) or not data.get("ok"):
            print(raw.strip() or "wait-important: orca 출력이 JSON 이 아니다")
            print(f"LAST_DELIVERY {ack or '-'}")
            if is_waiter_exists(data):
                report_waiters(args.run, args.kill_stale)
                return 4
            return 1
        result = data.get("result") or {}
        # --ack 를 넘긴 호출이 성공했으면 그 delivery 는 처리됐다
        ack = None
        messages = result.get("messages") or []
        delivery = result.get("deliveryId")
        if any(m.get("type") in wanted for m in messages):
            print(json.dumps(data, ensure_ascii=False))
            print(f"LAST_DELIVERY {delivery or '-'}")
            return 0
        if messages:
            skipped += len(messages)
            print(f"heartbeat 같은 메시지 {skipped} 개를 ack 하고 계속 기다린다", file=sys.stderr)
        # heartbeat 만 든 묶음은 다음 호출에서 ack 한다. 시간 한도로 끝난 호출은 delivery 가 없다
        ack = delivery


if __name__ == "__main__":
    sys.exit(main())
