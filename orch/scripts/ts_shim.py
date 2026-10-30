"""doctor 의 Python 진입점에서 Node 버전을 검사하고 같은 이름의 .ts 로 넘긴다.

Node 24 미만은 .ts 를 읽지 못하므로 Python 에서 먼저 판정한다(ADR-011).
Node 가 없거나 실행할 수 없으면 stderr 안내와 127, 낮거나 읽지 못한 버전이면
stdout 의 NODE-TOO-OLD 와 127 로 끝낸다. 버전 조회 제한은 10초다.
통과하면 인자와 종료 코드를 보존하며 node 로 exec 한다.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

MIN_NODE = (24, 0)
VERSION = re.compile(r"^v(\d+)\.(\d+)\.\d+")
NO_NODE = "node 24 이상이 PATH 에 필요하다"
# 실행 규칙(docs/code-architecture.md 「실행 규칙」)과 같은 플래그다. 타입 제거 실험 경고가 명령 출력에 섞이지 않게 한다
NODE_FLAG = "--disable-warning=ExperimentalWarning"


def node_too_old(text: str) -> bool:
    """`node --version` 출력의 (major, minor) 가 24.0 보다 작으면 True. 읽지 못하는 문자열도 True."""
    m = VERSION.match(text.strip())
    if not m:
        return True
    return (int(m.group(1)), int(m.group(2))) < MIN_NODE


def _no_node(detail: str = "") -> None:
    print(f"{NO_NODE}{f': {detail}' if detail else ''}", file=sys.stderr)
    sys.exit(127)


def exec_ts(shim_file: str, deprecated: bool = True) -> None:
    shim = Path(shim_file).resolve()
    target = shim.with_suffix(".ts")
    try:
        done = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10)
        version = done.stdout.strip()
    except FileNotFoundError:
        _no_node()
    except subprocess.TimeoutExpired:
        # 10초 안에 버전을 내지 못하는 node 로는 명령이 돌지 않는다. 읽지 못한 버전으로 본다
        version = ""
    except OSError as exc:
        _no_node(str(exc))
    if node_too_old(version):
        print(f"NODE-TOO-OLD {version or '(읽지 못함)'} 24 이상이 필요하다")
        sys.stdout.flush()
        sys.exit(127)
    if deprecated:
        print(f"DEPRECATED python3 {shim.name} → node {NODE_FLAG} {target}", file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        os.execvp("node", ["node", NODE_FLAG, str(target), *sys.argv[1:]])
    except FileNotFoundError:
        _no_node()
    except OSError as exc:
        # 실행 권한이 없거나 형식이 틀린 node 도 exec 하지 못한다. 띄우지 못한 것은 node 가 없을 때와 같이 127 로 끝낸다
        _no_node(str(exc))
