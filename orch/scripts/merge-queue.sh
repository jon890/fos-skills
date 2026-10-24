#!/bin/sh
# 다음 major 에서 지운다. `merge_queue.py` shim 을 거쳐 `merge_queue.ts` 로 넘긴다
exec python3 "$(dirname "$0")/merge_queue.py" "$@"
