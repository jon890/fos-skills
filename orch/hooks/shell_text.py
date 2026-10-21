"""hook 이 Bash 명령을 볼 때 명령이 아닌 글자를 가리고, 명령 조각으로 나눈다.

커밋 메시지, heredoc 본문, 주석에 든 `cd x;`, `git push`, `--wait ... &` 는 실행되는 명령이 아니다.
그런 글자로 거부하면 정상 호출이 막힌다(2026-10-21 heredoc 본문의 `check --wait` 와 `&` 로 거부된 일이 있었다).

    strip_heredocs  heredoc 본문과 끝 표지 줄을 지운다. 여는 줄은 남긴다
    mask            따옴표 안, 주석, 리다이렉션(`2>&1`, `&>`)을 같은 길이의 다른 글자로 바꾼다.
                    위치가 그대로라 가린 글에서 찾은 자리로 원문의 값을 읽을 수 있다
    pieces          가린 글을 `&&`, `||`, `;`, `|`, `&`, 줄바꿈으로 나눈 (연결자, 시작, 끝) 목록.
                    연산자 뒤 줄바꿈은 이어 쓰기라 나누지 않는다
"""

from __future__ import annotations

import re

# `<<<` here-string, `$((1<<2))` 같은 시프트는 heredoc 이 아니다
HEREDOC = re.compile(r"(?<![<\w])<<(?!<)-?\s*(['\"]?)([A-Za-z_]\w*)\1")
QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
COMMENT = re.compile(r"(?:(?<=\s)|^)#[^\n]*", re.M)
REDIRECT = re.compile(r"\d*>&\d*-?|&>>?|<&\d*-?")
CONTINUED = re.compile(r"(&&|\|\||\|)([ \t]*\n)+")
OPERATOR = re.compile(r"&&|\|\||\|&|;|\n|\||&")


def strip_heredocs(command: str) -> str:
    out, end = [], None
    for line in command.replace("\\\n", " ").split("\n"):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        out.append(line)
        m = HEREDOC.search(line)
        if m:
            end = m.group(2)
    return "\n".join(out)


def mask(text: str) -> str:
    def blank(m):
        s = m.group(0)
        return s[0] + "_" * (len(s) - 2) + s[-1]

    text = QUOTED.sub(blank, text)
    text = COMMENT.sub(lambda m: " " * len(m.group(0)), text)
    text = REDIRECT.sub(lambda m: " " * len(m.group(0)), text)
    # 연산자 뒤 줄바꿈은 같은 길이의 공백으로 바꿔 한 명령으로 잇는다
    return CONTINUED.sub(lambda m: m.group(1) + " " * (len(m.group(0)) - len(m.group(1))), text)


def pieces(masked: str):
    """[(앞 연결자 또는 None, 시작, 끝)]."""
    out, start, join = [], 0, None
    for m in OPERATOR.finditer(masked):
        out.append((join, start, m.start()))
        join, start = m.group(0), m.end()
    out.append((join, start, len(masked)))
    return out
