#!/usr/bin/env python3
"""worker 에게 답이나 후속 지시를 보낸다. dispatch 의 상태에 따라 전달 경로를 고른다.

코디네이터가 worker 터미널에 `orca terminal send` 로 직접 쓰면, 그 worker 가 작업 중일 때 입력이 섞이고
끝난 dispatch 의 터미널에 쓴 지시는 Task 기록 없이 사라진다. 닫힌 dispatch 에 `reply` 해도 전달되지 않는다.
이 스크립트가 경로를 고른다.

    dispatch 가 살아 있다   그 worker 의 마지막 메시지(없으면 --reply-to)에 `reply` 하고 `nudge-worker.py` 로 깨운다.
                            이미 답이 달린 question 은 건너뛴다. orca 가 「already has a different answer」 로 거부하면
                            다음 후보 메시지로 한 번 더 시도한다
    끝났고 터미널이 남았다  `--spec` 의 지시서로 `launch-worker.sh --worktree <그 워크트리> -- --terminal <그 터미널>` 을 부른다.
                            새 Task 로 같은 터미널을 이어 쓴다
    끝났는데 아직 일한다    `--spec` 이 없고 그 터미널 화면이 작업 중이면 `nudge-worker.py --text` 로 본문을 넣고,
                            Task 기록에 묶이지 않는다고 경고한다. worker 가 중간에 worker_done 을 보내 dispatch 가
                            닫혔는데 계속 일하는 일이 있었다. 작업 중이 아니면 종료 코드 3 으로 --spec 을 요구한다
    터미널도 없다           새로 띄우라고 안내하고 종료 코드 3 이다

사용법:
    send-to-worker.py --dispatch ID (--body TEXT | --body-file FILE) [--reply-to MSG_ID] [--spec FILE] [--run RUN]

    --dispatch   worker 의 dispatch id
    --body       보낼 글. --body-file 로 파일에서 읽을 수 있다
    --reply-to   답을 달 메시지 id. 없으면 inbox 에서 그 worker 가 보낸 마지막 메시지(heartbeat 는 뒤로 미룬다)를 쓴다
    --spec       dispatch 가 끝났을 때 이어 쓸 후속 지시서. `허락:` 줄이 있어야 한다.
                 끝난 dispatch 에는 --body 가 가지 않는다. 후속 지시는 이 지시서에 적는다
    --run        reply 와 다시 띄우기에 줄 Run id

ORCA, NUDGE_WORKER, LAUNCH_WORKER 환경 변수로 실행 파일과 스크립트 경로를 바꾼다.

종료 코드:
    0  보냈다. 살아 있는 worker 면 깨웠거나 작업 중이다. 닫힌 dispatch 의 일하는 터미널이면 입력을 넣었다
    1  보냈지만 턴 시작을 보지 못했거나, 다시 띄우기가 실패했다
    3  dispatch 가 끝나 보낼 수 없다. 표준 출력이 다음에 할 일을 말한다
    4  보냈지만 입력란에 글이 있거나 권한 확인 창이라 깨우지 않았다(nudge-worker.py 의 4)
    5  orca 가 오류를 냈다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORCA = os.environ.get("ORCA", "orca")
NUDGE_WORKER = os.environ.get("NUDGE_WORKER", str(HERE / "nudge-worker.py"))
LAUNCH_WORKER = os.environ.get("LAUNCH_WORKER", str(HERE / "launch-worker.sh"))
# 이 상태의 dispatch 는 reply 를 받는다. 나머지(completed, failed 같은 것)는 끝난 것이다
ACTIVE = {"pending", "dispatched", "running"}
# 이미 답한 question 에 다시 reply 하면 orca 가 이 문구로 거부한다
ANSWERED = "already has a different answer"


class OrcaFailed(RuntimeError):
    pass


def orca_json(*args):
    done = subprocess.run([ORCA, *args, "--json"], capture_output=True, text=True)
    try:
        data = json.loads(done.stdout)
    except json.JSONDecodeError:
        data = None
    if done.returncode != 0 or not isinstance(data, dict) or not data.get("ok"):
        raise OrcaFailed(f"orca {' '.join(args[:2])} 실패: {(done.stdout + done.stderr).strip()[:300]}")
    return data.get("result") or {}


def describe(dispatch_id):
    """(상태, 터미널 handle, 워크트리 경로, Run id)."""
    shown = orca_json("orchestration", "worker-show", "--dispatch", dispatch_id)
    dispatch, worker = shown.get("dispatch") or {}, shown.get("worker") or {}
    worktree = str(worker.get("worktreeId") or "").split("::", 1)[-1] or None
    handle = worker.get("agentTerminalHandle") or dispatch.get("assigneeHandle")
    return dispatch.get("status"), handle, worktree, dispatch.get("runId")


def candidates(dispatch_id, handle):
    """reply 할 후보 메시지 id. 앞이 우선이다. heartbeat 는 뒤로 미루고, 답이 보이는 question 은 뺀다."""
    rows = orca_json("orchestration", "inbox", "--limit", "200").get("messages") or []
    senders = {f"dispatch:{dispatch_id}", handle}
    # 같은 thread 에 worker 가 아닌 쪽이 쓴 글이 있으면 그 question 은 이미 답했다
    answered = {r.get("thread_id") for r in rows if r.get("thread_id") and r.get("from_handle") not in senders
                and r.get("thread_id") != r.get("id")}
    mine = []
    for row in rows:
        try:
            payload = json.loads(row.get("payload") or "{}")
        except (json.JSONDecodeError, TypeError):
            payload = {}
        if row.get("from_handle") in senders or (isinstance(payload, dict) and payload.get("dispatchId") == dispatch_id):
            if str(row.get("from_handle", "")).startswith("run:"):
                continue
            if row.get("type") == "question" and row.get("id") in answered:
                continue
            mine.append(row)
    mine.sort(key=lambda r: (r.get("type") != "heartbeat", r.get("sequence") or 0))
    return [r["id"] for r in reversed(mine)]


def live_handles():
    rows = orca_json("terminal", "list").get("terminals") or []
    return {t.get("handle") for t in rows if t.get("handle")}


def screen_state(handle):
    done = subprocess.run([sys.executable, NUDGE_WORKER, "--terminal", handle, "--state"],
                          capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else "unknown"


def reply(msg_id, body, run):
    result = orca_json("orchestration", "reply", "--id", msg_id, "--body", body, *(["--run", run] if run else []))
    message = result.get("message") or {}
    return message.get("id") or result.get("messageId") or result.get("id")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dispatch", required=True)
    parser.add_argument("--body")
    parser.add_argument("--body-file")
    parser.add_argument("--reply-to")
    parser.add_argument("--spec")
    parser.add_argument("--run")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if bool(args.body) == bool(args.body_file):
        print("send-to-worker: --body 와 --body-file 중 하나를 준다", file=sys.stderr)
        return 2
    try:
        body = args.body or Path(args.body_file).read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(f"send-to-worker: 본문 파일을 읽지 못했다: {exc}", file=sys.stderr)
        return 2

    try:
        status, handle, worktree, run_id = describe(args.dispatch)
        run = args.run or run_id
        if status in ACTIVE:
            targets = [args.reply_to] if args.reply_to else []
            targets += [t for t in candidates(args.dispatch, handle) if t not in targets]
            if not targets:
                print(f"send-to-worker: {args.dispatch} 가 보낸 메시지가 없어 reply 할 곳이 없다. --reply-to 로 준다")
                return 3
            # 이미 답한 question 이면 다음 후보로 한 번만 더 시도한다
            for attempt, target in enumerate(targets[:2]):
                try:
                    sent = reply(target, body, run)
                    break
                except OrcaFailed as exc:
                    if ANSWERED not in str(exc) or attempt == 1 or len(targets) < 2:
                        raise
                    print(f"skipped: {target} 는 이미 답한 question 이라 다음 메시지에 답한다")
            print(f"replied: {target} 에 답했다 ({sent})")
            if not handle:
                print("send-to-worker: 터미널 handle 을 몰라 깨우지 못했다")
                return 1
            done = subprocess.run([sys.executable, NUDGE_WORKER, "--terminal", handle, "--msg-id", sent or target])
            return done.returncode
        alive = handle in live_handles() if handle else False
    except OrcaFailed as exc:
        print(f"send-to-worker: {exc}")
        return 5

    if not alive:
        print(f"ended: {args.dispatch} 가 끝났고({status}) 터미널도 없다. "
              f"후속 지시서를 써서 launch-worker.sh --spec <지시서> --worktree {worktree or '<워크트리>'} 로 새로 띄운다")
        return 3
    if not args.spec:
        if screen_state(handle) == "working":
            print(f"warning: {args.dispatch} 가 닫혀({status}) 이 지시는 Task 기록에 묶이지 않는다. "
                  f"작업 중인 터미널 {handle} 에 직접 넣는다", flush=True)
            text = f"코디네이터(닫힌 dispatch {args.dispatch}): {body}"
            done = subprocess.run([sys.executable, NUDGE_WORKER, "--terminal", handle, "--text", text])
            return done.returncode
        print(f"ended: {args.dispatch} 가 끝났다({status}). 닫힌 dispatch 에는 reply 가 가지 않는다. "
              f"후속 지시를 지시서로 써서 --spec 으로 다시 부르면 터미널 {handle} 을 이어 쓴다")
        return 3
    if not worktree:
        print(f"send-to-worker: {args.dispatch} 의 워크트리를 몰라 이어 띄우지 못한다")
        return 1
    cmd = ["bash", LAUNCH_WORKER, "--spec", args.spec, "--worktree", worktree, *(["--run", run] if run else []),
           "--", "--terminal", handle]
    print(f"relaunch: 끝난 {args.dispatch} 의 터미널 {handle} 에 새 Task 로 띄운다", flush=True)
    return 0 if subprocess.run(cmd).returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
