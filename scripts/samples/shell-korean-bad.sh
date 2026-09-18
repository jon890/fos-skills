#!/usr/bin/env bash
# 걸려야 하는 표본. 셸이 그 자리를 확장하므로 이식성 결함이다.
# 이 주석 줄의 $removed개 는 걸리지 않아야 한다. 규칙을 설명하는 자기참조다.
set -euo pipefail
removed=3
echo "$removed개를 정리했다"
echo "$PATH가 비었다"
cat <<EOF
확장되는 heredoc 안이라 주석처럼 보여도 걸려야 한다: # $removed개
EOF
