#!/usr/bin/env python3
"""대화 기록에서 스킬 호출과 호출 뒤의 마찰 신호를 세어 스킬별 요약을 낸다.

사용법:
    extract_skill_usage.py [--skill NAME ...] [--since YYYY-MM-DD] [--projects DIR] [--out DIR] [--samples N]

--skill    셀 스킬. 여러 번 줄 수 있고 `fos-skills:planning` 처럼 접두사가 붙어도 된다. 없으면 모든 스킬을 센다
--since    그날(UTC) 이후의 호출만 센다
--projects 대화 기록 폴더. 기본값은 `session_log.default_projects_dir()` 이다
--out      호출별 기록을 쓸 폴더. 세션 임시 폴더를 준다. git 작업 트리 안이면 거부한다
--samples  마찰 점수가 높은 호출 N건을 세션 id 앞 8자와 시각으로 표준 출력에 낸다(기본 0)

호출은 Skill 도구 호출과 `/이름` 슬래시 명령을 함께 센다.
호출부터 다음 스킬 호출 전까지의 대화를 그 호출의 구간으로 보고 다음을 센다.
    with_correction  정정으로 보이는 사용자 발화가 있었던 호출 수
    with_interrupt   사용자가 중단한 호출 수
    tool_errors      구간 안의 도구 오류 합
    reinvoked        같은 스킬을 바로 다시 부른 호출 수
    friction         아래 점수의 합

점수는 `정정×3 + 중단×3 + 도구 오류 + 재호출×2` 다.
**점수는 읽을 표본을 고르는 데만 쓴다. 판정 근거로 쓰지 않는다.**
정정 정규식은 「다시」 같은 평범한 말과 critic 회신의 「REVISE」 에 거짓 양성이 많다.
판정은 `render_session.py` 로 실제로 읽은 세션에만 근거를 둔다.

표준 출력에는 집계와 세션 표기만 나가고 발화 발췌는 나가지 않는다.
--out 을 주면 그 폴더에 다음을 쓴다. 발췌는 `session_log.redact` 를 거치지만 비밀값이 남을 수 있다.
    invocations.jsonl  호출 한 건마다 한 줄. 파일 경로, 모델, 마찰 신호, 호출 뒤 사용자 발화 표본
    sessions.jsonl     주 세션마다 첫 사용자 요청과 쓴 스킬. 스킬이 덮지 못한 반복 작업을 찾는 데 쓴다

종료 코드
    0  집계를 마쳤다. 호출이 0건이어도 0 이다. 출력의 `calls` 로 판정한다
    2  인자 오류, 대화 기록 폴더가 없음, --out 이 git 작업 트리 안
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from session_log import (
    default_projects_dir,
    inside_git_worktree,
    is_subagent,
    iter_messages,
    iter_session_files,
    parse_since,
    redact,
    session_id,
    short_id,
)

CORRECTION = re.compile(r"(아니|왜 |왜$|다시|말고|틀렸|잘못|하지 ?마|안 ?돼|안 ?되|그게 아니|이상하|멈춰|stop|wrong|not what)", re.I)
INTERRUPT = "[Request interrupted"
COMMAND = re.compile(r"<command-name>/([^<]+)</command-name>")
NOISE = ("<system-reminder>", "<task-notification>", "<local-command", "Caveat:", "[SYSTEM NOTIFICATION")
COLUMNS = ["calls", "main", "with_correction", "with_interrupt", "tool_errors", "reinvoked", "friction"]


def norm(name: str) -> str:
    """`fos-skills:planning` 처럼 플러그인 접두사가 붙은 이름을 스킬 이름만 남긴다."""
    return name.strip().split(":")[-1]


def user_text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def tool_errors(content) -> int:
    if not isinstance(content, list):
        return 0
    return sum(1 for c in content if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("is_error"))


def has_tool_result(content) -> bool:
    return isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content)


def is_human(text: str) -> bool:
    text = text.strip()
    return bool(text) and not text.startswith(NOISE)


def read_events(path: Path) -> tuple[list[tuple[str, dict]], dict]:
    """파일 하나를 호출, 사용자 발화, 중단, 도구 오류, 어시스턴트 턴의 순서열로 바꾼다."""
    events: list[tuple[str, dict]] = []
    meta = {"cwd": None, "model": None, "first_user": None, "session": None}
    seen_tool_use: set[str] = set()
    for record in iter_messages(path):
        message = record.get("message") or {}
        meta["cwd"] = meta["cwd"] or record.get("cwd")
        meta["session"] = meta["session"] or session_id(path, record)
        ts = record.get("timestamp") or ""
        content = message.get("content")
        if record["type"] == "assistant":
            meta["model"] = message.get("model") or meta["model"]
            for c in content or []:
                if not (isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill"):
                    continue
                # 같은 메시지가 레코드 둘에 다시 실리는 경우가 있어 tool_use id 로 한 번만 센다
                if c.get("id") in seen_tool_use:
                    continue
                seen_tool_use.add(c.get("id"))
                args = c.get("input") or {}
                events.append(("skill", {"skill": norm(args.get("skill", "")), "ts": ts, "model": meta["model"], "via": "tool"}))
            events.append(("assistant", {}))
            continue
        text = user_text(content)
        for name in COMMAND.findall(text):
            events.append(("skill", {"skill": norm(name), "ts": ts, "model": meta["model"], "via": "slash"}))
        errors = tool_errors(content)
        if errors:
            events.append(("err", {"n": errors}))
        if INTERRUPT in text:
            events.append(("interrupt", {}))
        elif is_human(text) and not has_tool_result(content) and not COMMAND.search(text) and not record.get("isMeta"):
            events.append(("human", {"text": text, "ts": ts}))
            if meta["first_user"] is None:
                meta["first_user"] = text
    return events, meta


def invocations(path: Path, events: list[tuple[str, dict]], meta: dict, skills: set[str] | None, since_iso: str | None):
    """대상 스킬 호출마다 마찰 신호를 붙인 기록을 낸다."""
    for i, (kind, payload) in enumerate(events):
        if kind != "skill":
            continue
        if skills and payload["skill"] not in skills:
            continue
        if since_iso and payload["ts"] < since_iso:
            continue
        humans, corrections, interrupts, errors, turns, reinvoked = [], 0, 0, 0, 0, False
        for kind2, payload2 in events[i + 1:]:
            if kind2 == "skill":
                reinvoked = payload2["skill"] == payload["skill"]
                break
            if kind2 == "human":
                humans.append(payload2["text"])
                corrections += 1 if CORRECTION.search(payload2["text"]) else 0
            elif kind2 == "interrupt":
                interrupts += 1
            elif kind2 == "err":
                errors += payload2["n"]
            elif kind2 == "assistant":
                turns += 1
        yield {
            **payload,
            "session": meta["session"],
            "file": str(path),
            "cwd": meta["cwd"],
            "subagent": is_subagent(path),
            "humans": [redact(h[:400]) for h in humans[:15]],
            "n_humans": len(humans),
            "corrections": corrections,
            "interrupts": interrupts,
            "tool_errors": errors,
            "reinvoked": reinvoked,
            "assistant_turns": turns,
            "friction": corrections * 3 + interrupts * 3 + errors + (2 if reinvoked else 0),
        }


def summarize(records: list[dict]) -> dict[str, dict[str, int]]:
    agg: dict[str, dict[str, int]] = defaultdict(lambda: dict.fromkeys(COLUMNS, 0))
    for r in records:
        a = agg[r["skill"]]
        a["calls"] += 1
        a["main"] += 0 if r["subagent"] else 1
        a["with_correction"] += 1 if r["corrections"] else 0
        a["with_interrupt"] += 1 if r["interrupts"] else 0
        a["tool_errors"] += r["tool_errors"]
        a["reinvoked"] += 1 if r["reinvoked"] else 0
        a["friction"] += r["friction"]
    return agg


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--skill", action="append", default=[])
    parser.add_argument("--since")
    parser.add_argument("--projects", type=Path, default=default_projects_dir())
    parser.add_argument("--out", type=Path)
    parser.add_argument("--samples", type=int, default=0)
    try:
        args = parser.parse_args(argv)
        since = parse_since(args.since)
    except (SystemExit, ValueError) as e:
        print(f"인자 오류: {e}. 사용법은 이 파일의 docstring 에 있다", file=sys.stderr)
        return 2
    if not args.projects.is_dir():
        print(f"대화 기록 폴더가 없다: {args.projects}", file=sys.stderr)
        return 2
    if args.out and inside_git_worktree(args.out):
        print(f"--out 이 git 작업 트리 안이다. 발췌가 커밋될 수 있어 거부한다: {args.out}", file=sys.stderr)
        return 2

    skills = {norm(s) for s in args.skill} or None
    records: list[dict] = []
    sessions: list[dict] = []
    files = 0
    for path in iter_session_files(args.projects, since):
        files += 1
        try:
            events, meta = read_events(path)
            records.extend(invocations(path, events, meta, skills, args.since))
            if args.out and not is_subagent(path) and meta["first_user"]:
                sessions.append({"session": meta["session"], "file": str(path), "cwd": meta["cwd"], "model": meta["model"],
                                 "first_user": redact(meta["first_user"][:300]),
                                 "skills": sorted({e["skill"] for kind, e in events if kind == "skill"})})
        except OSError as e:  # 한 파일이 깨져도 나머지는 집계한다
            print(f"건너뜀 {path}: {e}", file=sys.stderr)

    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        with open(args.out / "invocations.jsonl", "w") as f:
            for r in records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        with open(args.out / "sessions.jsonl", "w") as f:
            for s in sessions:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"# 읽은 파일 {files}, 호출 {len(records)}")
    print("skill\t" + "\t".join(COLUMNS))
    for name, a in sorted(summarize(records).items(), key=lambda x: -x[1]["calls"]):
        print(name + "\t" + "\t".join(str(a[c]) for c in COLUMNS))
    if args.samples:
        print("\n# 마찰 점수 상위 호출. 점수는 표본을 고르는 데만 쓴다")
        print("session\ttimestamp\tskill\tfriction")
        for r in sorted(records, key=lambda r: -r["friction"])[: args.samples]:
            print(f"{short_id(r['session'])}\t{r['ts'][:19]}\t{r['skill']}\t{r['friction']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
