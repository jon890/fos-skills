#!/usr/bin/env bash
# 걸려야 하는 표본. 셸이 변수 이름으로 읽어 set -u 아래에서 죽는다.
set -euo pipefail
removed=3
echo "$removed개를 정리했다"
echo "$PATH가 비었다"
