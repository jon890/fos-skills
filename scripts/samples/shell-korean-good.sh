#!/usr/bin/env bash
# 걸리지 않아야 하는 표본. 셸이 변수를 올바르게 끊어 읽거나 확장하지 않는다.
# 주석 줄의 $removed개 는 평가되지 않는다.
set -euo pipefail
removed=3
echo "${removed}개를 정리했다"
echo "$removed 개를 정리했다"
echo "'$removed'개를 정리했다"
    # 들여쓴 주석의 $removed개 도 평가되지 않는다.
cat <<'EOF'
인용 heredoc 은 확장하지 않는다: $removed개
EOF
