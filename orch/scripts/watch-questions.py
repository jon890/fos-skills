#!/usr/bin/env python3
"""Monitor event source: new unanswered questions and reminders, one line per event.

Usage: watch-questions.py [--run ID] [--repo DIR] [--interval 60] [--remind-after 600] [--once]
Prints QUESTION for a new unanswered question and REMINDER once --remind-after seconds pass without an answer
(default 600). --interval sets the poll seconds. Questions come from questions.snapshot().
Notification timestamps are stored per Run under orch_paths' state directory.
Read/query failures go to stderr and never erase notification history. --once exits 1
on failure; the monitor loop retries on the next interval. No messages are acknowledged.
"""
import argparse
import json
import math
import subprocess
import sys
import time

import orch_paths
import questions


def poll(run, state, now, remind_after, repo=None):
    run, pending = questions.snapshot(run)
    seen = json.loads(state.read_text()) if state.exists() else {}
    if not isinstance(seen, dict) or not isinstance(seen.get(run, {}), dict):
        raise RuntimeError(f"알림 기록 형식이 잘못됐다: {state}")
    notified = seen.setdefault(run, {})
    events = []
    for message in sorted(pending, key=lambda m: (m.get("created_at", ""), m["id"])):
        mid = message["id"]
        previous = notified.get(mid)
        if previous is not None and now - previous < remind_after:
            continue
        body = " ".join(str(message.get("body") or "").split())[:160]
        kind = "QUESTION" if previous is None else "REMINDER"
        events.append(f"{kind} {mid} {message['type']} from={message.get('from_handle')}: {body}")
        notified[mid] = now
    orch_paths.make_parent(state, repo)
    temporary = state.with_suffix(".tmp")
    temporary.write_text(json.dumps(seen, ensure_ascii=False) + "\n")
    temporary.replace(state)
    return run, events


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run")
    parser.add_argument("--repo")
    parser.add_argument("--interval", type=float, default=60)
    parser.add_argument("--remind-after", type=float, default=600)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if not all(math.isfinite(n) and n > 0 for n in (args.interval, args.remind_after)):
        parser.error("interval 과 remind-after 는 양수여야 한다")
    state = orch_paths.path("state", args.repo) / "questions-seen.json"
    run = args.run
    while True:
        try:
            run, events = poll(run, state, time.time(), args.remind_after, args.repo)
            for event in events:
                print(event, flush=True)
        except (OSError, ValueError, RuntimeError, TypeError, subprocess.TimeoutExpired) as exc:
            print(f"watch-questions: {exc}", file=sys.stderr, flush=True)
            if args.once:
                return 1
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
