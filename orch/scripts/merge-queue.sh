#!/bin/sh
# 한 버전 동안 남기는 옛 경로. 다음 버전에서 지운다. merge_queue.py 를 쓴다
exec python3 "$(dirname "$0")/merge_queue.py" "$@"
