#!/usr/bin/env python3
"""옛 경로다. 같은 이름의 .ts 로 넘긴다. 다음 major 에서 지운다."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ts_shim  # noqa: E402

if __name__ == "__main__":
    ts_shim.exec_ts(__file__)
