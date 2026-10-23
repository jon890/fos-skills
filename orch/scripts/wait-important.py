#!/usr/bin/env python3
"""코디네이터가 처리할 메시지가 올 때까지 기다린다. heartbeat 만 든 묶음은 ack 하고 계속 기다린다.

`check --wait` 는 `--types` 를 깨어나는 조건으로만 쓰고, 돌려주는 delivery 는 그때 쌓인 묶음 전체다.
heartbeat 만 든 묶음으로 깨어나면 코디네이터가 읽을 것 없이 ack 하고 다시 거느라 깨어남마다 한 턴을 쓴다.
이 스크립트가 그 묶음을 대신 ack 하고, 처리할 종류가 든 묶음이 오면 ack 하지 않고 그대로 낸다.
코디네이터는 그 묶음을 `triage-messages.py` 로 읽은 뒤 마지막 줄의 delivery id 를 다음 대기의 `--ack` 로 넘긴다.

**Bash 도구의 `run_in_background` 로만 띄운다.** 셸의 `&` 나 `nohup` 으로 띄우면 끝나도 완료 알림이 오지 않는다.
플러그인 hook(`hooks/block-background-wait.ts`)이 그런 호출을 막는다.

사용법:
    wait-important.py --run RUN_ID [--ack DELIVERY_ID] [--types worker_done,question,escalation,status]
                      [--timeout-ms 7000000] [--kill-stale] [--lost-interval-sec 60] [--ignore-lost ctx_...]
                      [--lost-state FILE] [--ack-lost ctx_...]

    --run         기다릴 Run
    --ack         앞 대기가 낸 delivery id. 첫 대기처럼 넘길 것이 없으면 뺀다
    --types       깨어날 메시지 종류. 기본 worker_done,question,escalation,status
    --timeout-ms  전체 대기 한도(ms). 기본 7000000. 하네스의 명령 한도(Bash 최대 7200000)보다 짧게 준다
    --lost-interval-sec  대기하는 동안 Run 의 worker 상태를 볼 간격(초). 기본 60. 0 이면 보지 않는다. 아래 「끊긴 worker」
    --ignore-lost  끊긴 worker 로 보지 않을 dispatch id. 여러 번 줄 수 있다. 아래 「끊긴 worker」
    --lost-state  이미 알린 끊긴 dispatch 를 적는 파일. 기본 <orch 작업 폴더>/state/wait-important-lost.json. 아래 「끊긴 worker」
    --ack-lost    확인한 끊긴 dispatch 를 처리함으로 기록하고 대기 없이 끝낸다. 여러 번 줄 수 있다.
                  --ignore-lost 는 그 실행에서만 빼지만 이 옵션은 --lost-state 파일에 handled 로 덮어써 다음 실행부터 경고도 생략한다.
                  파일을 쓰지 못하면 종료 코드 1 이고 확인한 것으로 처리하지 않는다. 다른 Run 의 기록과 아직 확인하지 않은 dispatch 는 유지한다
    --completion-contract  ready(기본)는 앞선 PR 준비 상태를 검사한다. PR 없는 작업만 none 으로 끈다
    --kill-stale  대기 자리를 쥔 프로세스 가운데 부모가 init(PID 1)인 것과 그 밑의 대기를 종료한다. 아래 「남은 대기」

완료 계약 (--completion-contract ready):
    worker_done 이 오면 같은 Task·Dispatch·발신자가 앞서 `준비됨 #N, head <전체 40자리 SHA>` 상태를 보냈는지
    `check --all` 로 읽어 대조한다. 이미 ack 한 준비 상태도 읽으며 delivery 는 소비하지 않는다.
    근거가 없거나 이력을 읽지 못하면 `의심스러운 worker_done` 으로 따로 표시하고 자동 ack 하지 않은 채 종료 코드 6 으로 끝난다.
    `worker_done --outcome failed` 같은 명시적인 실패 보고는 준비 상태 없이도 처리할 묶음으로 낸다.

출력:
    처리할 묶음이 오면 그 `check --json` 결과를 한 줄 JSON 으로 내고, 마지막 줄에 `LAST_DELIVERY <id>` 를 낸다.
    시간 한도가 지나면 `TIMEOUT LAST_DELIVERY <id>` 를 낸다. id 는 ack 하지 못하고 남은 delivery 이고, 없으면 `-` 다.

끊긴 worker:
    기기가 재시작되어 worker 터미널이 사라져도 메시지는 오지 않아 대기가 끝나지 않는다.
    그래서 대기하는 동안 `--lost-interval-sec` 마다 `orca orchestration worker-list --run <id> --json` 으로 상태를 본다.
    「끊김」 은 workerState 가 abandoned, failed, stopped 이거나 dispatchStatus 가 failed 이거나 단계가 terminal_missing 인 것이다.
    단, completed/abandoned dispatch 와 성공·취소 결과는 터미널이 사라져도 제외한다.
    끊긴 dispatch 를 찾으면 메시지를 기다리지 않고 `WORKER_LOST ctx_... stage=terminal_missing` 줄과
    `LAST_DELIVERY <id>` 줄을 내고 종료 코드 5 로 끝난다. 지켜보는 대상은 둘이다.
    1) 대기를 시작할 때 살아 있던(dispatchStatus 가 pending, dispatched, running) dispatch 가 대기하는 동안 끊긴 경우
    2) 대기를 시작할 때 이미 끊겨 있는데 아직 처리하지 않은 dispatch. 재시작 뒤 새로 건 대기가 이 경우다.
       이때는 `check` 를 부르지 않고 바로 5 로 끝난다
    「처리했다」 고 보아 뺀다: 같은 task 에 그보다 나중에 만든 dispatch 가 있으면(다시 띄웠으므로),
    task 가 completed 이거나 취소(failed 에 result 가 cancelled)면, `--ignore-lost` 로 준 id 면.
    worker-list 행에는 만든 시각이 없어 나중 dispatch 는 `dispatch-show --task` 의 최신 dispatch id 로 판정한다.
    그것이나 task-list 를 읽지 못하면 그 dispatch 는 시작할 때 지켜보지 않는다(이전 동작).
    worker-list 를 읽지 못하면 그 번의 확인만 건너뛴다.
    두 경우 모두 일부러 끝낸 dispatch 는 끊긴 것으로 보지 않는다. `dispatch-show` 의 termination_reason 이
    operator_close(코디네이터나 정리 스크립트가 터미널을 닫았다)이거나, last_failure 의 provenance 가
    worker_report(worker 가 `worker_done --outcome failed` 로 알렸다)인 것이다.
    camelCase 필드도 읽으며, 실패 이유가 abandoned 인 명시적 포기도 제외한다.
    알린 dispatch 와 일부러 끝냈다고 판정한 dispatch 는 `--lost-state` 파일에 Run 별로 적고 다음 대기부터 다시
    알리거나 조회하지 않는다. worker_done 없이 같은 터미널에 일을 이어 준 옛 dispatch 가 대기를 걸 때마다 다시
    깨우지 않게 하기 위해서다. 앞 대기가 알렸는데 아직 끊긴 채인 dispatch 는 깨우지 않고 stderr 에 한 줄로 남긴다.
    다시 알리게 하려면 그 파일에서 Run 의 항목을 지운다.

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
    5  처리하지 않은 끊긴 worker 가 있다(WORKER_LOST). references/launch.md 의 「끊긴 worker 다시 띄우기」 를 따른다.
       같은 dispatch 는 다음 대기에서 다시 알리지 않는다
    6  의심스러운 worker_done 이 있다. 자동 ack 하지 않으며 완료 검증 전에는 해제하지 않는다
    1  orca 가 그 밖의 오류를 냈다(runtime_unavailable 같은 것). 그 JSON 을 그대로 낸다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from completion_evidence import classify
import orch_paths

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
        # 정리로 터미널이 사라져도 이미 끝난 dispatch 는 끊김이 아니다.
        if w.get("dispatchStatus") in {"completed", "abandoned"}:
            continue
        if (w.get("projection") or {}).get("outcome") in {"succeeded", "cancelled"}:
            continue
        detail = (((w.get("projection") or {}).get("stage") or {}).get("detail"))
        if w.get("workerState") in LOST_WORKER_STATES or w.get("dispatchStatus") == "failed" or detail == "terminal_missing":
            lost.append((w["dispatchId"], detail or w.get("workerState")))
    return lost


def run_json(*cmd, timeout=None):
    """orca 명령 한 번의 result. 읽지 못하면 None 이다."""
    done = subprocess.run([ORCA, "orchestration", *cmd, "--json"],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    return data.get("result") or {}


def deliberate_end(dispatch):
    """일부러 끝낸 dispatch 의 이유. 끊긴 것이면 None 이다. dispatch 는 `dispatch-show` 의 dispatch 다

    operator_close 는 코디네이터나 정리 스크립트가 터미널을 닫은 것이고,
    worker_report 는 worker 가 실패를 메시지로 알린 것이다. 둘 다 코디네이터가 이미 안다.
    """
    termination = dispatch.get("terminationReason") or dispatch.get("termination_reason")
    if termination in {"operator_close", "worker_report"}:
        return termination
    failure = dispatch.get("lastFailure") or dispatch.get("last_failure")
    if failure == "abandoned":
        return "abandoned"
    if isinstance(failure, str):
        try:
            failure = json.loads(failure)
        except json.JSONDecodeError:
            failure = None
    if isinstance(failure, dict) and failure.get("provenance") == "worker_report":
        return "worker_report"
    return None


def latest_dispatch(task_id):
    """task 의 최신 dispatch(`dispatch-show --task`). 읽지 못하면 빈 dict 다"""
    return (run_json("dispatch-show", "--task", task_id) or {}).get("dispatch") or {}


def default_state_path():
    """orch 작업 폴더의 state/wait-important-lost.json. git 밖이면 현재 폴더 기준이다"""
    return orch_paths.path("state") / "wait-important-lost.json"


def load_state(path):
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_reported(path, run_id):
    """이 Run 에서 이미 판정한 dispatch. {dispatch id: 「lost 시각」 이나 「operator_close 시각」}.
    파일이 없거나 읽지 못하면 빈 dict 다"""
    entry = load_state(path).get(run_id)
    return entry if isinstance(entry, dict) else {}


def save_reported(path, run_id, kinds):
    """판정한 dispatch 를 Run 별로 적는다. kinds 는 {dispatch id: lost 나 일부러 끝낸 이유} 다.
    쓰지 못하면 stderr 로 알리고 False 를 돌려준다. --ack-lost 는 이때 실패로 끝낸다."""
    if not kinds:
        return
    path = Path(path)
    data = load_state(path)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = data.get(run_id) if isinstance(data.get(run_id), dict) else {}
    data[run_id] = entry
    for dispatch, kind in kinds.items():
        if kind == "handled" or dispatch not in entry:
            entry[dispatch] = f"{kind} {now}"
    try:
        orch_paths.make_parent(path)
        # 쓰는 도중에 끊겨도 앞 내용이 깨지지 않게 옆 파일에 쓰고 바꾼다
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
        os.replace(tmp, path)
        return True
    except OSError as exc:
        print(f"wait-important: 판정한 dispatch 를 {path} 에 적지 못했다: {exc}", file=sys.stderr)
        return False


def task_closed(task):
    """다시 띄울 일이 없는 task. completed 이거나, 취소(failed 에 result 가 cancelled)한 것"""
    status = task.get("status")
    return status == "completed" or (status == "failed" and "cancel" in str(task.get("result") or "").lower())


def unhandled_lost(run_id, rows, ignore):
    """대기를 시작할 때 이미 끊겨 있고 아직 처리하지 않은 dispatch.
    ([(dispatch id, 단계)], {일부러 끝낸 dispatch id: 이유})

    처리한 것은 뺀다: --ignore-lost(이미 판정한 것 포함), 끝난 task, 같은 task 에 더 나중 dispatch 가 있는 것,
    일부러 끝낸 것. 판정에 필요한 목록을 읽지 못하면 그 dispatch 는 지켜보지 않는다.
    일부러 끝낸 것은 따로 돌려줘 기록하게 한다. 다음 대기가 같은 dispatch 를 다시 조회하지 않게 하기 위해서다.
    """
    candidates = [(d, stage) for d, stage in lost_workers(rows, {w.get("dispatchId") for w in rows}) if d not in ignore]
    if not candidates:
        return [], {}
    tasks = (run_json("task-list", "--run", run_id) or {}).get("tasks")
    if tasks is None:
        return [], {}
    by_task = {t.get("id"): t for t in tasks}
    task_of = {w.get("dispatchId"): w.get("taskId") for w in rows}
    found, deliberate, latest_of = [], {}, {}
    for dispatch, stage in candidates:
        task_id = task_of.get(dispatch)
        if task_id not in by_task or task_closed(by_task[task_id]):
            continue
        if task_id not in latest_of:
            latest_of[task_id] = latest_dispatch(task_id)
        latest = latest_of[task_id]
        if latest.get("id") != dispatch:
            continue
        reason = deliberate_end(latest)
        if reason:
            deliberate[dispatch] = reason
        else:
            found.append((dispatch, stage))
    return found, deliberate


def drop_deliberate(rows, lost, watched):
    """대기하는 동안 끊긴 것 가운데 일부러 끝낸 것을 빼고, 그것은 watched 에서도 지운다"""
    task_of = {w.get("dispatchId"): w.get("taskId") for w in rows}
    kept = []
    for dispatch, stage in lost:
        latest = latest_dispatch(task_of[dispatch]) if task_of.get(dispatch) else {}
        if latest.get("id") == dispatch and deliberate_end(latest):
            watched.discard(dispatch)
            continue
        kept.append((dispatch, stage))
    return kept


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
                lost = drop_deliberate(rows, lost, watched) if lost else []
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


def user_processes():
    """같은 사용자의 프로세스 전체. 대기의 조상인 일반 셸도 포함한다."""
    done = subprocess.run([PS, "-U", str(os.getuid()), "-o", "pid=,ppid=,lstart=,command="],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    rows = []
    for line in done.stdout.splitlines():
        # lstart 는 「Tue Oct 20 10:00:00 2026」 처럼 다섯 낱말이다
        parts = line.split(None, 7)
        if len(parts) == 8 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1]), " ".join(parts[2:7]), parts[7]))
    return rows


def waiter_processes(run_id, rows=None):
    """같은 사용자의 프로세스 가운데 이 Run 을 기다리는 것. [(pid, ppid, 시작 시각, 명령)]"""
    rows = user_processes() if rows is None else rows
    # 이 스크립트와 이것을 띄운 셸은 명령에 Run id 가 들어 있어도 남은 대기가 아니다
    parent = {pid: ppid for pid, ppid, _, _ in rows}
    mine, pid = set(), os.getpid()
    while pid > 1 and pid not in mine:
        mine.add(pid)
        pid = parent.get(pid, 0)
    found = []
    for pid, ppid, started, command in rows:
        if pid in mine or not re.search(r"(?<![\w-])" + re.escape(run_id) + r"(?![\w-])", command):
            continue
        waiting = "orchestration check" in command and "--wait" in command
        if waiting or "wait-important" in command:
            found.append((pid, ppid, started, command))
    return found


def stale_pids(procs, all_procs=None):
    """부모가 init 인 대기와, 그 밑에 딸린 대기(셸 밑의 스크립트, 스크립트 밑의 check)"""
    waiters = {pid for pid, _, _, _ in procs}
    # 앱도 init 의 자식이다. 일반 셸과 해당 Run 의 대기만 따라가 앱의 살아 있는 세션은 보존한다.
    parent = {pid: ppid for pid, ppid, _, command in (procs if all_procs is None else all_procs)
              if pid in waiters or Path(command.split()[0]).name.lstrip("-") in {"sh", "bash", "zsh", "dash", "fish"}}
    stale = {pid for pid, ppid in parent.items() if ppid == 1}
    grew = True
    while grew:
        more = {pid for pid, ppid in parent.items() if ppid in stale} - stale
        stale |= more
        grew = bool(more)
    return stale & waiters


def report_waiters(run_id, kill_stale):
    rows = user_processes()
    procs = waiter_processes(run_id, rows)
    err = sys.stderr
    print(f"wait-important: Run {run_id} 에 이미 다른 대기가 있다(waiter_exists). 다시 걸어도 같은 오류만 받는다", file=err)
    if not procs:
        print("  같은 사용자의 프로세스에서 찾지 못했다. 다른 사용자나 다른 머신의 대기일 수 있다", file=err)
        return
    stale = stale_pids(procs, rows)
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
    parser.add_argument("--ignore-lost", action="append", default=[])
    parser.add_argument("--lost-state")
    parser.add_argument("--ack-lost", action="append", default=[])
    parser.add_argument("--completion-contract", choices=("ready", "none"), default="ready")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    wanted = {t.strip() for t in args.types.split(",") if t.strip()}
    if not wanted or args.timeout_ms <= 0 or args.lost_interval_sec < 0:
        print("wait-important: --types 와 --timeout-ms 는 비어 있거나 0 일 수 없고 --lost-interval-sec 는 음수일 수 없다", file=sys.stderr)
        return 2
    if not args.lost_state:
        orch_paths.warn_legacy(script="wait-important")
    state = args.lost_state or default_state_path()
    if args.ack_lost:
        if not save_reported(state, args.run, {d: "handled" for d in args.ack_lost}):
            return 1
        print("ACK_LOST " + " ".join(args.ack_lost))
        return 0
    # 대기를 시작할 때 살아 있던 dispatch 와 처리하지 않은 끊긴 dispatch 를 지켜본다. 읽지 못하면 지켜보지 않는다
    watched = set()
    if args.lost_interval_sec > 0:
        rows = worker_rows(args.run) or []
        judged = load_reported(state, args.run)
        ignore = set(args.ignore_lost) | set(judged)
        # 앞 대기가 알렸는데 아직 끊긴 채인 dispatch 는 깨우지 않고 stderr 로만 남긴다
        still = sorted(d for d, _ in lost_workers(rows, {d for d, v in judged.items() if str(v).startswith("lost")})
                       if d not in args.ignore_lost)
        if still:
            print(f"wait-important: 앞 대기가 알린 끊긴 dispatch {len(still)}개가 아직 처리되지 않았다: {' '.join(still)}",
                  file=sys.stderr)
        # 이미 끊겨 있는데 처리하지 않은 dispatch 가 있으면 기다리지 않고 알린다
        lost, deliberate = unhandled_lost(args.run, rows, ignore)
        save_reported(state, args.run, deliberate)
        if lost:
            for dispatch, stage in lost:
                print(f"WORKER_LOST {dispatch} stage={stage}")
            print(f"LAST_DELIVERY {args.ack or '-'}")
            save_reported(state, args.run, {d: "lost" for d, _ in lost})
            return 5
        watched = live_dispatches(rows) - ignore

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
            save_reported(state, args.run, {d: "lost" for d, _ in raw})
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
            suspicious = False
            if args.completion_contract == "ready" and any(m.get("type") == "worker_done" for m in messages):
                # 이미 ack 한 준비 상태도 읽는다. --all 은 delivery 를 소비하거나 ack 하지 않는다.
                try:
                    history = run_json("check", "--run", args.run, "--all", timeout=30)
                except (OSError, subprocess.TimeoutExpired):
                    history = None
                earlier = history.get("messages") if isinstance(history, dict) else None
                earlier = earlier if isinstance(earlier, list) else []
                result["messages"] = classify(messages, earlier)
                suspicious = any(m.get("type") == "suspicious_worker_done" for m in result["messages"])
            print(json.dumps(data, ensure_ascii=False))
            if suspicious:
                print("의심스러운 worker_done: 앞선 PR 준비 상태를 확인하지 못했다. 완료 검증 전에 해제하지 않는다")
            print(f"LAST_DELIVERY {delivery or '-'}")
            return 6 if suspicious else 0
        if messages:
            skipped += len(messages)
            print(f"heartbeat 같은 메시지 {skipped} 개를 ack 하고 계속 기다린다", file=sys.stderr)
        # heartbeat 만 든 묶음은 다음 호출에서 ack 한다. 시간 한도로 끝난 호출은 delivery 가 없다
        ack = delivery


if __name__ == "__main__":
    sys.exit(main())
