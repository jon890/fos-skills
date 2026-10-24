#!/usr/bin/env python3
"""doctor 의 진입점이다. 같은 이름의 .ts 로 넘긴다.

SKILL.md 가 doctor 를 이 경로로 부른다. 넘기기 전에 ts_shim 이 node 버전을 보고 22.18 보다 낮으면
NODE-TOO-OLD 줄과 종료 코드 127 로 멈춘다. 낮은 node 는 .ts 를 읽지 못해 .ts 안에서는 판정할 수 없다.
공식 진입점이라 DEPRECATED 줄을 내지 않는다. 다음 major 에서 shim 을 지울 때 이 진입점을 어떻게 둘지 따로 정한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ts_shim  # noqa: E402

if __name__ == "__main__":
    ts_shim.exec_ts(__file__, deprecated=False)
