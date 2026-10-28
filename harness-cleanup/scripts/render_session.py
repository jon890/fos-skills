#!/usr/bin/env python3
"""대화 기록 한 세션을 읽기 쉬운 텍스트로 줄여 파일에 쓴다.

사용법:
    render_session.py SESSION --out FILE [--from TIMESTAMP] [--max-chars N] [--projects DIR]

SESSION 은 jsonl 파일 경로나 세션 id 앞부분이다(`extract_skill_usage.py --samples` 가 내는 8자).
id 로 주면 --projects(기본값은 `session_log.default_projects_dir()`)에서 주 세션 파일을 찾는다.
--from 을 주면 그 timestamp 부터 쓴다. `--samples` 가 낸 시각을 그대로 준다.
--max-chars 는 쓸 최대 글자 수다(기본 60000).

사용자 발화, 어시스턴트 텍스트, 도구 호출(이름과 입력 앞부분), 도구 오류만 남긴다.
`user`, `assistant` 레코드만 읽는다. 다른 레코드는 같은 메시지를 다시 담아 중복된다.

대화 기록에는 비밀값이 섞인다. 출력은 `session_log.redact` 를 거치지만 다 가리지 못한다.
그래서 표준 출력으로 내지 않고 --out 파일에만 쓴다. 세션 임시 폴더를 주고, git 작업 트리 안이면 거부한다.
판정표에는 발췌를 옮기지 않고 세션 id 앞 8자와 시각만 적는다.

종료 코드
    0  썼다. 마지막 줄이 `... (잘림)` 이면 --max-chars 에서 끊었다
    2  인자 오류, 세션을 찾지 못함, id 앞부분에 맞는 세션이 둘 이상, --out 이 git 작업 트리 안
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from session_log import default_projects_dir, find_session_files, inside_git_worktree, iter_messages, redact


def parts(content) -> list[tuple[str, str]]:
    if isinstance(content, str):
        return [("text", content)]
    out = []
    for c in content or []:
        if not isinstance(c, dict):
            continue
        kind = c.get("type")
        if kind == "text":
            out.append(("text", c.get("text", "")))
        elif kind == "tool_use":
            out.append(("tool", f"{c.get('name')} {json.dumps(c.get('input'), ensure_ascii=False)[:400]}"))
        elif kind == "tool_result" and c.get("is_error"):
            body = c.get("content")
            if isinstance(body, list):
                body = " ".join(x.get("text", "") for x in body if isinstance(x, dict))
            out.append(("error", str(body)[:500]))
    return out


def render(path: Path, start: str | None, limit: int) -> list[str]:
    lines: list[str] = []
    size = 0
    for record in iter_messages(path):
        ts = record.get("timestamp") or ""
        if start and ts < start:
            continue
        role = record["type"]
        for kind, text in parts((record.get("message") or {}).get("content")):
            text = text.strip()
            if not text:
                continue
            if role == "user" and kind == "text":
                if text.startswith("<system-reminder>"):
                    continue
                label, text = "USER", text[:1500]
            elif kind == "text":
                label, text = "ASSISTANT", text[:1200]
            elif kind == "tool":
                label = "TOOL"
            else:
                label = "TOOL_ERROR"
            line = redact(f"[{ts[5:19]}] {label}: {text}")
            lines.append(line)
            size += len(line)
            if size > limit:
                lines.append("... (잘림)")
                return lines
    return lines


def resolve(session: str, projects: Path) -> Path | None:
    path = Path(session)
    if path.is_file():
        return path
    found = find_session_files(projects, session) if projects.is_dir() else []
    if len(found) == 1:
        return found[0]
    print(f"세션 {session!r} 에 맞는 파일이 {len(found)}개다. 파일 경로나 더 긴 id 를 준다", file=sys.stderr)
    return None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("session")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--from", dest="start")
    parser.add_argument("--max-chars", type=int, default=60000)
    parser.add_argument("--projects", type=Path, default=default_projects_dir())
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        print("인자 오류. 사용법은 이 파일의 docstring 에 있다", file=sys.stderr)
        return 2
    if inside_git_worktree(args.out):
        print(f"--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: {args.out}", file=sys.stderr)
        return 2
    path = resolve(args.session, args.projects)
    if path is None:
        return 2
    lines = render(path, args.start, args.max_chars)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines) + "\n")
    print(f"{args.out}: {len(lines)}줄")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
