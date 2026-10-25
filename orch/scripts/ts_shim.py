"""옛 `.py` 명령 경로를 같은 폴더의 같은 이름 `.ts` 로 넘기는 shim 의 공통 처리다.

아직 Python 인 명령과 다른 저장소가 옛 `.py` 경로를 부른다. 그 경로가 이름, 옵션, 종료 코드를 그대로 지키도록
node 로 exec 한다. shim 은 다음 major 에서 지운다(docs/adr/010-orch-typescript.md).

shim 파일은 이 모듈을 import 하고 `if __name__ == "__main__":` 안에서만 `exec_ts(__file__)` 를 부른다.
테스트가 importlib 로 shim 을 읽을 때 테스트 프로세스가 node 로 바뀌지 않게 하기 위해서다.

exec_ts 의 차례:
    1. 대상은 shim 과 같은 폴더의 같은 이름 `.ts` 다
    2. `node --version` 을 10초 제한으로 부른다. node 가 없으면 stderr 에 `node 24 이상이 PATH 에 필요하다` 를 내고 127 이다
       5 의 exec 가 OSError 로 실패해도 같은 줄과 127 이다
    3. 버전이 24 보다 낮거나 읽지 못하면 exec 하지 않는다. stdout 에 `NODE-TOO-OLD <버전> 24 이상이 필요하다` 를 내고 127 이다
       최소 버전을 24 로 둔 이유는 docs/adr/011-node-24-minimum.md 가 소유한다
    4. deprecated 면 stderr 에 `DEPRECATED python3 <이름>.py → node --disable-warning=ExperimentalWarning <대상>` 을 낸다
    5. `node --disable-warning=ExperimentalWarning <대상> <받은 인자>` 로 exec 한다. 종료 코드는 node 의 것이다
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
