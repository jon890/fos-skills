#!/usr/bin/env python3
"""에이전트 세션 프로세스, 반복 helper 프로세스, 대화 기록 크기를 조사한다. 읽기 전용이다.

사용법:
  survey_sessions.py [--min-age-hours 24] [--log-age-days 30] [--json] [--json-out FILE]

종료 코드: 0 조사 완료, 2 인자 오류.
현재 세션과 그 조상 PID 는 항상 제외 표시한다.

「워크트리가 사라진 대화 기록」 절은 Claude 기록 폴더(`~/.claude/projects`, `CLAUDE_CONFIG_DIR` 이 있으면 그 `projects`)의
하위 폴더 가운데, 안의 `.jsonl` 을 이름순으로 열어 앞 50줄에서 처음 나온 `cwd` 경로가 이미 없는 폴더를 센다.
`cwd` 를 읽지 못한 폴더는 후보에 넣지 않는다. 경과일은 폴더 안 파일의 가장 늦은 수정 시각으로 잰다.
--json-out 은 이 후보를 `delete_sessions.py` 입력 형식으로 파일에 쓴다.
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
CWD_SCAN_LINES = 50
ORPHAN_AGE_BUCKETS = (3, 7, 14, 30)
ORPHAN_EXAMPLES = 5
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


def claude_projects_dir(environ=None):
    """Claude 대화 기록 폴더. CLAUDE_CONFIG_DIR 이 있으면 그 아래 projects 다."""
    env = os.environ if environ is None else environ
    base = env.get("CLAUDE_CONFIG_DIR") or "~/.claude"
    return os.path.join(os.path.expanduser(base), "projects")


def read_cwd(folder, max_lines=CWD_SCAN_LINES):
    """폴더의 `.jsonl` 을 이름순으로 열어 앞 max_lines 줄에서 처음 나온 `cwd` 값을 돌려준다. 못 읽으면 None."""
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".jsonl"))
    except OSError:
        return None
    for name in names:
        try:
            with open(os.path.join(folder, name), encoding="utf-8", errors="replace") as fh:
                for _, line in zip(range(max_lines), fh):
                    try:
                        obj = json.loads(line)
                    except ValueError:
                        continue
                    cwd = obj.get("cwd") if isinstance(obj, dict) else None
                    if isinstance(cwd, str) and cwd:
                        return cwd
        except OSError:
            continue
    return None


def folder_stats(folder):
    """폴더 아래 전체 바이트와 파일의 가장 늦은 수정 시각을 돌려준다. 파일이 없으면 시각은 None."""
    total, newest = 0, None
    for root, _, files in os.walk(folder):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            total += st.st_size
            if newest is None or st.st_mtime > newest:
                newest = st.st_mtime
    return total, newest


def find_orphan_sessions(base):
    """base 의 하위 폴더 가운데 기록 안의 cwd 경로가 없는 것을 크기 큰 순으로 돌려준다."""
    out = []
    try:
        names = sorted(os.listdir(base))
    except OSError:
        return out
    for name in names:
        folder = os.path.join(base, name)
        if os.path.islink(folder) or not os.path.isdir(folder):
            continue
        cwd = read_cwd(folder)
        if cwd is None or os.path.exists(cwd):
            continue
        size, newest = folder_stats(folder)
        if newest is None:
            continue
        out.append({"path": folder, "cwd": cwd, "newest_mtime": newest, "size_bytes": size})
    return sorted(out, key=lambda o: -o["size_bytes"])


def orphan_buckets(orphans, now, buckets=ORPHAN_AGE_BUCKETS):
    """N일 넘은 후보의 {일수: (개수, 바이트)}. 큰 일수가 작은 일수 묶음에 포함된다."""
    result = {}
    for days in buckets:
        picked = [o for o in orphans if o["newest_mtime"] < now - days * 86400]
        result[days] = (len(picked), sum(o["size_bytes"] for o in picked))
    return result


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
    ap.add_argument("--json-out", metavar="FILE", help="워크트리가 사라진 대화 기록 후보를 delete_sessions.py 입력으로 쓴다")
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

    projects = claude_projects_dir()
    orphans = find_orphan_sessions(projects) if os.path.isdir(projects) else []
    now = time.time()
    if args.json_out:
        try:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump({"base": projects, "created": now, "orphans": orphans}, fh, ensure_ascii=False, indent=2)
        except OSError as exc:
            print(f"--json-out 을 쓸 수 없다: {exc}", file=sys.stderr)
            return 2

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
    print(f"\n## 워크트리가 사라진 대화 기록 ({projects})")
    if not orphans:
        print("없음")
    else:
        for days, (count, size) in orphan_buckets(orphans, now).items():
            print(f"{days:>3}일 넘은 것 {count:>5}개 {human(size):>9}")
        print(f"전체 {len(orphans)}개 {human(sum(o['size_bytes'] for o in orphans)):>9}. 크기 상위 {min(ORPHAN_EXAMPLES, len(orphans))}개:")
        for o in orphans[:ORPHAN_EXAMPLES]:
            print(f"{human(o['size_bytes']):>9} {(now - o['newest_mtime']) / 86400:>5.0f}일 전  {o['cwd']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
