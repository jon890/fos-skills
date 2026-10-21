"""hook 이 Bash 명령을 볼 때 명령이 아닌 글자(heredoc 본문, 따옴표 안)를 지운다.

커밋 메시지나 `python3 - <<'EOF'` 본문에 든 `cd x;`, `git push`, `--wait ... &` 는 실행되는 명령이 아니다.
그런 글자로 거부하면 정상 호출이 막힌다(2026-10-21 heredoc 본문의 `check --wait` 와 `&` 로 거부된 일이 있었다).
"""

from __future__ import annotations

import re

HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")


def strip_heredocs(command: str) -> str:
    """heredoc 을 여는 줄은 남기고 본문과 끝 표지 줄을 지운다."""
    out, end = [], None
    for line in command.split("\n"):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        out.append(line)
        m = HEREDOC.search(line)
        if m:
            end = m.group(2)
    return "\n".join(out)
