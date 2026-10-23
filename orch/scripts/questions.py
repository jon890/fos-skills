"""Read unanswered coordinator questions from Orca without consuming deliveries.

inbox includes both directions of a reply thread; check --peek does not.
Fail on a full snapshot instead of treating a potentially missing reply as pending.
"""
import json
import os
import subprocess
from datetime import datetime, timezone

LIMIT = 100000


def orca(*args):
    done = subprocess.run([os.environ.get("ORCA_CLI_COMMAND", "orca"), "orchestration", *args, "--json"],
                          capture_output=True, text=True, timeout=30)
    if done.returncode:
        raise RuntimeError(done.stderr.strip() or done.stdout.strip())
    data = json.loads(done.stdout)
    if not isinstance(data, dict):
        raise RuntimeError("Orca 응답이 객체가 아니다")
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("error", data)))
    result = data.get("result", data)
    if not isinstance(result, dict):
        raise RuntimeError("Orca result 가 객체가 아니다")
    return result


def unanswered(rows, run):
    """Only replies from the question's recipient resolve it; worker follow-ups do not."""
    scoped = [m for m in rows if m.get("run_id") == run]
    answered = {r.get("thread_id") for r in scoped
                if r.get("thread_id") and r.get("id") != r["thread_id"]
                and r.get("from_handle") == f"run:{run}"}
    pending = []
    for m in scoped:
        if m.get("type") not in {"question", "escalation"} or m.get("to_handle") != f"run:{run}":
            continue
        if not m.get("id"):
            continue
        if m["id"] not in answered:
            pending.append(m)
    return pending


def snapshot(run=None):
    if not run:
        current = orca("run-current").get("run") or {}
        run = current.get("id")
    if not run:
        raise RuntimeError("현재 Run 이 없다. --run 으로 지정한다")
    data = orca("inbox", "--limit", str(LIMIT))
    rows = data.get("messages")
    if not isinstance(rows, list) or len(rows) >= LIMIT or not all(isinstance(m, dict) for m in rows):
        raise RuntimeError("질문 기록 전체를 읽지 못했다")
    return run, unanswered(rows, run)


def age_seconds(message, now):
    try:
        created = datetime.fromisoformat(message.get("created_at", "").replace("Z", "+00:00"))
        return now - created.replace(tzinfo=created.tzinfo or timezone.utc).timestamp()
    except (ValueError, TypeError):
        return 0
