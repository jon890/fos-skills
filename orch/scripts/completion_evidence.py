"""PR 작업의 완료 신호를 같은 Dispatch 의 앞선 준비 상태와 대조한다.

이 검사는 발신 프로세스를 인증하지 않는다. Orca 의 settlement 를 바꾸지 않고
완료 조건의 근거가 없는 신호를 별도로 분류해 코디네이터의 해제를 막는다.
"""

import json
import re
from datetime import datetime, timezone

READY = re.compile(r"^준비됨[ \t]+#([1-9][0-9]*),[ \t]*head[ \t]+([0-9a-f]{40})[ \t]*$", re.I | re.M)


def payload(message):
    value = message.get("payload") or {}
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = {}
    return value if isinstance(value, dict) else {}


def context(message):
    data = payload(message)
    return tuple(message.get(snake) or message.get(camel) or data.get(camel) or data.get(snake)
                 for snake, camel in (("task_id", "taskId"), ("dispatch_id", "dispatchId")))


def classify(messages, history=()):
    """복사본에 completionVerification 을 붙인다. 실패 보고는 PR 준비를 요구하지 않는다.

    준비 상태는 같은 task, dispatch, 발신자이고 완료보다 먼저 보내진 것이어야 한다.
    시각이 없으면 현재 묶음에서 먼저 온 상태만 인정한다. 이력은 시각 없이는 인정하지 않는다.
    """
    output = []
    previous = list(history)
    for message in messages:
        item = dict(message)
        # wait-important 출력에는 이미 이력과 대조한 결과가 있다. 파일 분류 때 잃지 않는다.
        verified = item.get("completionVerification") or {}
        if item.get("type") == "worker_done" and verified.get("status") not in {"ready", "failure_report"}:
            data = payload(item)
            outcome = item.get("outcome") or data.get("outcome")
            if outcome == "failed":
                item["completionVerification"] = {"status": "failure_report"}
            else:
                task, dispatch = context(item)
                ready = None
                for candidate in previous:
                    if candidate.get("type") != "status" or not task or not dispatch:
                        continue
                    if context(candidate) != (task, dispatch):
                        continue
                    sender = item.get("from_handle") or item.get("fromHandle")
                    if not sender or sender != (candidate.get("from_handle") or candidate.get("fromHandle")):
                        continue
                    before = candidate.get("created_at") or candidate.get("createdAt")
                    after = item.get("created_at") or item.get("createdAt")
                    if before and after:
                        # Orca timestamps are ISO strings; normalize offsets before comparing.
                        try:
                            times = [datetime.fromisoformat(t.replace("Z", "+00:00")) for t in (before, after)]
                            times = [t if t.tzinfo else t.replace(tzinfo=timezone.utc) for t in times]
                            if times[0] >= times[1]:
                                continue
                        except (ValueError, TypeError):
                            continue
                    elif candidate not in messages[:len(output)]:
                        continue
                    match = READY.search(str(candidate.get("subject") or "") + "\n" + str(candidate.get("body") or ""))
                    if match:
                        ready = {"status": "ready", "pr": int(match[1]), "head": match[2].lower(),
                                 "statusMessageId": candidate.get("id")}
                item["completionVerification"] = ready or {
                    "status": "suspicious", "reason": "같은 Task·Dispatch의 앞선 PR 준비 상태가 없다"}
                if not ready:
                    item["originalType"] = "worker_done"
                    item["type"] = "suspicious_worker_done"
        output.append(item)
        previous.append(message)
    return output
