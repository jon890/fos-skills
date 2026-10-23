"""Read unanswered coordinator questions from Orca without consuming deliveries.

Read only this Run's questions, then each sender's replies. Never read the global inbox.
Orca caps check history and peek at 100 rows; report that coverage explicitly.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HISTORY_LIMIT = 100
REPLY_LIMIT = 200


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
    history = messages(orca("check", "--run", run, "--all", "--types", "question,escalation"))
    unread = messages(orca("check", "--run", run, "--peek", "--types", "question,escalation"))
    if len(history) >= HISTORY_LIMIT or len(unread) >= HISTORY_LIMIT:
        print("질문 조회 범위: 최근 질문 100건과 읽지 않은 질문 최대 100건; 더 오래된 미답변은 빠질 수 있다", file=sys.stderr)
    candidates = {m["id"]: m for m in history + unread
                  if m.get("id") and m.get("run_id") == run
                  and m.get("type") in {"question", "escalation"}
                  and m.get("to_handle") == f"run:{run}"}
    replies = []
    for sender in dict.fromkeys(m.get("from_handle") for m in candidates.values()):
        if not sender:
            raise RuntimeError("질문 발신자가 없다")
        rows = messages(orca("inbox", "--terminal", sender, "--limit", str(REPLY_LIMIT)))
        answers = [m for m in rows if m.get("from_handle") == f"run:{run}"]
        pending = unanswered([*candidates.values(), *answers], run)
        if len(rows) >= REPLY_LIMIT and any(m.get("from_handle") == sender for m in pending):
            raise RuntimeError("답변 기록 한도에 닿아 질문의 답변 여부를 확인할 수 없다")
        replies.extend(answers)
    return run, unanswered([*candidates.values(), *replies], run)


def messages(data):
    rows = data.get("messages")
    if not isinstance(rows, list) or not all(isinstance(m, dict) for m in rows):
        raise RuntimeError("질문 기록을 읽지 못했다")
    return rows


def age_seconds(message, now):
    try:
        created = datetime.fromisoformat(message.get("created_at", "").replace("Z", "+00:00"))
        return now - created.replace(tzinfo=created.tzinfo or timezone.utc).timestamp()
    except (ValueError, TypeError):
        return 0
