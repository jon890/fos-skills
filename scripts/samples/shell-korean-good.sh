#!/usr/bin/env bash
# 걸리지 않아야 하는 표본. 세 형태 모두 셸이 변수를 올바르게 끊어 읽는다.
set -euo pipefail
removed=3
echo "${removed}개를 정리했다"
echo "$removed 개를 정리했다"
echo "'$removed'개를 정리했다"
