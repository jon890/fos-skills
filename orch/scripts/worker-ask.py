#!/usr/bin/env python3
"""옛 경로다. 같은 이름의 .ts 로 넘긴다. 다음 major 에서 지운다.

DEPRECATED 줄을 내지 않는다. worker 는 답을 stdout 과 stderr 를 합쳐 읽기도 해서, 첫 줄 `answer:` 계약 앞에 그 줄이 섞이면 답을 읽지 못한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ts_shim  # noqa: E402

if __name__ == "__main__":
    ts_shim.exec_ts(__file__, deprecated=False)
