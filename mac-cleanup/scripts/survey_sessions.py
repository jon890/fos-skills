#!/usr/bin/env python3
"""에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.

사용법:
  survey_sessions.py [--min-age-hours 24] [--log-age-days 30] [--json]

종료 코드: 0 조사 완료, 2 인자 오류.
현재 세션과 그 조상 PID 는 항상 제외 표시한다.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import time
from collections import defaultdict

AGENT_NAMES = ("claude", "codex")
HELPER_PREFIX_LEN = 150
HELPER_MIN_COUNT = 10
LOG_DIRS = (
    "~/.claude/projects",
    "~/.codex/sessions",
    "~/Library/Application Support/orca/codex-accounts/*/home/sessions",
)


def parse_etime(text):
    """ps 의 etime `[[dd-]hh:]mm:ss` 를 시간(float)으로 바꾼다."""
    text = text.strip()
    days = 0
    if "-" in text:
        d, text = text.split("-", 1)
        days = int(d)
    parts = [int(p) for p in text.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    hours, minutes, seconds = parts
    return days * 24 + hours + minutes / 60 + seconds / 3600


def parse_ps(output):
    """`ps -axo pid=,ppid=,etime=,tty=,rss=,pcpu=,command=` 출력을 dict 목록으로 만든다."""
    rows = []
    for line in output.splitlines():
        fields = line.split(None, 6)
        if len(fields) < 7:
            continue
        try:
            rows.append({
                "pid": int(fields[0]), "ppid": int(fields[1]),
                "hours": round(parse_etime(fields[2]), 2), "tty": fields[3],
                "rss_kb": int(fields[4]), "cpu": float(fields[5]), "command": fields[6],
            })
        except ValueError:
            continue
    return rows


def ancestors(pid, parents):
    """pid 부터 PID 1 까지 올라간 PID 집합. parents 는 {pid: ppid}."""
    chain, seen = set(), set()
    while pid and pid not in seen:
        seen.add(pid)
        chain.add(pid)
        if pid == 1:
            break
        pid = parents.get(pid, 0)
    return chain


def is_agent(command):
    """실행 파일 이름이 claude 또는 codex 인 프로세스인가."""
    exe = os.path.basename(command.split(None, 1)[0]) if command.strip() else ""
    return exe in AGENT_NAMES


def group_helpers(rows, prefix_len=HELPER_PREFIX_LEN, min_count=HELPER_MIN_COUNT):
    """명령줄 앞 prefix_len 자가 같은 프로세스가 min_count 개 이상인 묶음을 RSS 순으로 돌려준다."""
    groups = defaultdict(list)
    for r in rows:
        groups[r["command"][:prefix_len]].append(r)
    out = [
        {"command": key, "count": len(v), "rss_kb": sum(r["rss_kb"] for r in v)}
        for key, v in groups.items() if len(v) >= min_count
    ]
    return sorted(out, key=lambda g: -g["rss_kb"])


def parse_lsof_cwd(output):
    """`lsof -Fpn` 출력을 {pid: cwd} 로 만든다."""
    result, pid = {}, None
    for line in output.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None:
            result[pid] = line[1:]
    return result


def run(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (subprocess.TimeoutExpired, OSError):
        return ""


def dir_sizes(base, age_days):
    """base 아래 전체 바이트와 age_days 보다 오래된 파일 바이트를 센다."""
    cutoff = time.time() - age_days * 86400
    total = old = 0
    for root, _, files in os.walk(base):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            total += st.st_size
            if st.st_mtime < cutoff:
                old += st.st_size
    return total, old


def expand_log_dirs():
    out = []
    for pattern in LOG_DIRS:
        expanded = os.path.expanduser(pattern)
        if "*" in expanded:
            out.extend(sorted(p for p in glob.glob(expanded) if os.path.isdir(p)))
        elif os.path.isdir(expanded):
            out.append(expanded)
    return out


def human(num):
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.1f}{unit}"
        num /= 1024


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--min-age-hours", type=float, default=24)
    ap.add_argument("--log-age-days", type=int, default=30)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    rows = parse_ps(run(["ps", "-axo", "pid=,ppid=,etime=,tty=,rss=,pcpu=,command="]))
    parents = {r["pid"]: r["ppid"] for r in rows}
    protected = ancestors(os.getppid(), parents) | {os.getpid()}
    sessions = [r for r in rows if is_agent(r["command"])]
    cwds = {}
    if sessions:
        cwds = parse_lsof_cwd(run(["lsof", "-a", "-p", ",".join(str(r["pid"]) for r in sessions), "-d", "cwd", "-Fpn"]))
    for r in sessions:
        r["cwd"] = cwds.get(r["pid"], "?")
        r["protected"] = r["pid"] in protected
        r["old"] = r["hours"] >= args.min_age_hours
    helpers = group_helpers(rows)
    logs = []
    for base in expand_log_dirs():
        total, old = dir_sizes(base, args.log_age_days)
        logs.append({"dir": base, "total": total, "older_than_days": old})

    if args.json:
        json.dump({"sessions": sessions, "helpers": helpers, "logs": logs}, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print(f"## 에이전트 세션 {len(sessions)}개 (오래됨 기준 {args.min_age_hours:g}시간)")
    print(f"{'PID':>7} {'시간':>7} {'TTY':<8} {'RSS':>9} {'CPU':>5}  표시   cwd")
    for r in sorted(sessions, key=lambda r: -r["hours"]):
        mark = "현재" if r["protected"] else ("오래됨" if r["old"] else "")
        print(f"{r['pid']:>7} {r['hours']:>6.1f}h {r['tty']:<8} {human(r['rss_kb'] * 1024):>9} {r['cpu']:>5.1f}  {mark:<5}  {r['cwd']}")
    print("현재 세션과 조상은 '현재' 로 표시했다. 종료 대상에 넣지 않는다.")
    print(f"\n## 반복 helper 프로세스 (같은 명령줄 {HELPER_MIN_COUNT}개 이상)")
    for g in helpers or []:
        print(f"{g['count']:>4}개 {human(g['rss_kb'] * 1024):>9}  {g['command']}")
    if not helpers:
        print("없음")
    print(f"\n## 대화 기록 (오래된 기준 {args.log_age_days}일)")
    for item in logs:
        print(f"{human(item['total']):>9} 중 오래된 것 {human(item['older_than_days']):>9}  {item['dir']}")
    if not logs:
        print("없음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
