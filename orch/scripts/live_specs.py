"""살아 있는 dispatch 가 쓰는 지시서 경로를 모은다. `cleanup-sweep.py` 와 `handoff-cleanup.py` 가 import 한다.

지시서를 지우는 판정은 브랜치와 보드로 「끝난 일」 을 본다. 그런데 한 지시서를 여러 worker 가 함께 쓰거나
브랜치가 모두 머지된 뒤에도 worker 가 그 지시서로 후속 일을 하면, 아직 일하는 worker 의 지시서가 지워진다.
worker 는 `--spec` 첫 지시 줄의 경로로 지시서를 읽으므로, 그 줄이 가리키는 파일은 dispatch 가 끝날 때까지 남긴다.

살아 있는 것:
    - task-list 의 status 가 pending, dispatched, running 인 Task
    - worker-list 의 dispatchStatus 가 pending, dispatched, running 인 dispatch 의 Task
    그 Task 의 spec 줄에서 `/` 로 시작하고 `.md` 로 끝나는 경로를 모두 읽어 실경로로 바꾼다.

조회가 하나라도 실패하면 None 이다. 부르는 쪽은 None 이면 지시서를 지우지 않는다.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

ACTIVE = {"pending", "dispatched", "running"}
SPEC_PATH = re.compile(r"(/[^\s`'\"]+?\.md)(?![\w.])")


def spec_paths(text):
    """spec 줄에서 읽은 .md 절대경로 목록."""
    return SPEC_PATH.findall(text or "")


def _orca(orca, *args):
    try:
        done = subprocess.run([orca, *args, "--json"], capture_output=True, text=True, timeout=60)
        result = json.loads(done.stdout).get("result") if done.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, AttributeError):
        return None
    return result if isinstance(result, dict) else None


def live_spec_paths(orca="orca", run_id=None):
    """살아 있는 dispatch 의 지시서 실경로 집합. 읽지 못하면 None."""
    scope = ["--run", run_id] if run_id else []
    tasks = _orca(orca, "orchestration", "task-list", *scope)
    workers = _orca(orca, "orchestration", "worker-list", *scope)
    if tasks is None or workers is None:
        return None
    active = {w.get("taskId") for w in workers.get("workers") or [] if w.get("dispatchStatus") in ACTIVE}
    paths = set()
    for task in tasks.get("tasks") or []:
        if task.get("status") in ACTIVE or task.get("id") in active:
            paths.update(os.path.realpath(p) for p in spec_paths(task.get("spec")))
    return paths
