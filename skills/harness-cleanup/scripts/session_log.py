"""Claude Code 대화 기록(jsonl)을 읽는 공용 함수. 사용 기록 모드의 스크립트가 함께 쓴다.

대화 기록은 `$CLAUDE_CONFIG_DIR/projects` 에 있다. 설정이 없으면 `~/.claude/projects` 다.
`~/.claude` 는 숨은 폴더라 `rg` 가 기본값으로 건너뛰어 0건이 나온다. 그래서 파이썬으로 직접 순회한다.

한 파일에는 `user`, `assistant` 말고도 여러 레코드가 섞인다.
`api-request-blob` 은 API 에 보낸 메시지를 통째로 다시 담아, 함께 세면 호출 수가 부풀려진다.
`iter_messages` 는 `user`, `assistant` 레코드만 낸다.

대화 기록에는 비밀값이 섞인다. 발췌를 내는 곳은 `redact` 를 거치고, 출력은 세션 임시 폴더에만 둔다.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

MESSAGE_TYPES = ("user", "assistant")
# json.loads 전에 거르는 빠른 검사. 최종 판정은 파싱한 type 으로 한다
MESSAGE_LINE = re.compile(r'"type":\s*"(?:user|assistant)"')

# 흔한 토큰 형식과 `키=값` 꼴의 비밀값. 완전하지 않으므로 발췌는 여전히 세션 임시 폴더에만 둔다
SECRET = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}"
    r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._~+/=-]{16,}"
    r"|(?i:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)"
)


def default_projects_dir() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    return Path(base) / "projects"


def parse_since(value: str | None) -> float | None:
    """YYYY-MM-DD 를 UTC 자정의 epoch 초로 바꾼다."""
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()


def iter_session_files(root: Path, since: float | None = None) -> Iterator[Path]:
    """root 아래 jsonl 을 모두 낸다. since 보다 먼저 마지막으로 고친 파일은 건너뛴다."""
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            path = Path(dirpath) / name
            if since is not None and path.stat().st_mtime < since:
                continue
            yield path


def iter_messages(path: Path) -> Iterator[dict]:
    """user, assistant 레코드만 낸다. 깨진 줄은 건너뛴다."""
    with open(path, errors="replace") as f:
        for line in f:
            if not MESSAGE_LINE.search(line):
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and record.get("type") in MESSAGE_TYPES:
                yield record


def is_subagent(path: Path) -> bool:
    return "subagents" in path.parts


def session_id(path: Path, record: dict | None = None) -> str:
    """하위 에이전트 기록도 주 세션 id 로 묶는다."""
    if record and record.get("sessionId"):
        return record["sessionId"]
    if is_subagent(path):
        return path.parent.parent.name
    return path.stem


def short_id(sid: str) -> str:
    """판정표에 적는 세션 표기. 앞 8자만 쓴다."""
    return sid[:8]


def redact(text: str) -> str:
    return SECRET.sub("[가림]", text)


def inside_git_worktree(path: Path) -> bool:
    """발췌가 커밋될 수 있는 자리인지 본다."""
    probe = path if path.is_dir() else path.parent
    while not probe.exists():
        probe = probe.parent
    done = subprocess.run(
        ["git", "-C", str(probe), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )
    return done.returncode == 0 and done.stdout.strip() == "true"


def find_session_files(root: Path, prefix: str) -> list[Path]:
    """세션 id 앞부분으로 주 세션 파일을 찾는다."""
    return sorted(p for p in iter_session_files(root) if not is_subagent(p) and p.stem.startswith(prefix))
