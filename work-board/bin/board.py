#!/usr/bin/env python3
"""옛 경로다. 같은 이름의 .ts 로 넘긴다. 다음 major 에서 지운다."""
import os
import sys

# symlink 로 불러도 플러그인 안의 orch/scripts 를 찾도록 실경로 기준으로 올라간다
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "orch", "scripts"))
import ts_shim  # noqa: E402

if __name__ == "__main__":
    ts_shim.exec_ts(__file__)
