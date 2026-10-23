#!/usr/bin/env python3
"""macOS 개발 머신의 디스크, 메모리, 스왑, 큰 디렉터리, Docker, 도구 캐시를 조사한다. 읽기 전용이다.

사용법: survey_system.py
걸리는 시간: du 때문에 1분에서 5분. 홈 디렉터리가 클수록 오래 걸린다.
종료 코드: 0 조사 완료. 개별 항목이 없거나 실패해도 건너뛰고 0 으로 끝난다.

큰 디렉터리는 `du -xkd1` 한 번으로 하위 항목을 모두 읽는다. 셸 glob 을 쓰지 않으므로
점으로 시작하는 디렉터리가 없어도 다른 항목이 빠지지 않는다.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict

HOME = os.path.expanduser("~")
DU_TIMEOUT = 600


def run(cmd, timeout=60, merge_stderr=False):
    """명령을 돌려 표준 출력을 문자열로 돌려준다. 없거나 실패하거나 시간이 넘으면 None. merge_stderr 면 표준 오류도 합친다."""
    try:
        done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.PIPE,
                              text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (subprocess.TimeoutExpired, OSError):
        return None
    return done.stdout if done.returncode == 0 else None


def run_ok(cmd, timeout=60):
    """종료 코드 0 이면 True. 출력은 버린다."""
    try:
        done = subprocess.run(cmd, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return done.returncode == 0


def human_kb(kb):
    """KiB 를 `du -h` 처럼 읽기 쉬운 크기로 바꾼다."""
    size = float(kb)
    for unit in ("K", "M", "G", "T"):
        if size < 1024 or unit == "T":
            return f"{size:.0f}{unit}" if size >= 10 or unit == "K" else f"{size:.1f}{unit}"
        size /= 1024


def parse_du_kb(output):
    """`du -k` 출력(크기<탭>경로)을 (KiB, 경로) 목록으로 만든다. 알아볼 수 없는 줄은 건너뛴다."""
    rows = []
    for line in output.splitlines():
        size, _, path = line.partition("\t")
        if size.isdigit() and path:
            rows.append((int(size), path))
    return rows


def top_dirs(rows, limit):
    """du 행에서 큰 순서로 limit 개를 고른다. 크기가 같으면 경로순이다."""
    return sorted(rows, key=lambda r: (-r[0], r[1]))[:limit]


def du_kb(args):
    """`du -k` 를 돌려 (KiB, 경로) 목록을 돌려준다. du 는 읽을 수 없는 하위 항목이 있으면 1 로 끝나도 출력을 내므로 종료 코드를 보지 않는다."""
    try:
        done = subprocess.run(["du", "-xk", *args], capture_output=True, text=True, timeout=DU_TIMEOUT,
                              stdin=subprocess.DEVNULL)
    except (subprocess.TimeoutExpired, OSError):
        return []
    return parse_du_kb(done.stdout)


def du_top(root, limit):
    """`du -xkd1 root` 결과 중 큰 항목을 `크기  경로` 로 출력한다. root 가 없으면 건너뛴다."""
    if not os.path.isdir(root):
        return
    for kb, path in top_dirs(du_kb(["-d1", root]), limit):
        print(f"{human_kb(kb):>6}  {path}")


def size_of(path):
    """경로가 있으면 `크기<탭>경로` 한 줄을 출력한다. 없으면 아무것도 내지 않는다."""
    if not path or not os.path.exists(path):
        return
    rows = du_kb(["-s", path])
    if rows:
        print(f"{human_kb(rows[0][0]):>6}\t{rows[0][1]}")


APP_RE = re.compile(r"/([^/]+)\.app(?:/|$)")


def app_name(command):
    """명령줄에서 앱 이름을 뽑는다. `.app` 번들이 없으면 실행 파일 이름이다."""
    m = APP_RE.search(command)
    if m:
        return m.group(1)
    words = command.split()
    return words[0].rsplit("/", 1)[-1] if words else "?"


def rss_by_app(ps_output):
    """`ps -axo rss=,command=` 출력을 앱별 RSS(KiB) 합계로 만든다."""
    total = defaultdict(int)
    for line in ps_output.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2 or not parts[0].isdigit():
            continue
        total[app_name(parts[1])] += int(parts[0])
    return dict(total)


def parse_vm_stat(output):
    """`vm_stat` 출력에서 (페이지 크기, 압축기가 쓰는 페이지 수)를 뽑는다. 없는 값은 None."""
    page = re.search(r"page size of (\d+)", output)
    comp = re.search(r"occupied by compressor:\s+(\d+)", output)
    return (int(page.group(1)) if page else None, int(comp.group(1)) if comp else None)


# 설치를 기다리는 업데이트가 있다는 표시. Electron 계열 updater 는 내려받은 압축 파일을 `update.zip` 으로,
# 풀어 둔 설치본을 `pending` 디렉터리에 두고 앱이 다음 실행에서 설치한다.
PENDING_NAMES = frozenset({"pending", "update.zip", "update-info.json"})


def is_updater_dir(name):
    """`*-updater` 또는 `*.ShipIt` 이름의 캐시 디렉터리인지."""
    return name.endswith("-updater") or name.endswith(".ShipIt")


def pending_marks(entry_names):
    """디렉터리 직속 항목 이름에서 대기 중인 업데이트 표시를 골라 정렬해 돌려준다. 없으면 빈 목록."""
    return sorted(n for n in entry_names if n in PENDING_NAMES)


def updater_verdict(marks):
    """대기 표시가 없을 때만 안전이고, 하나라도 있으면 유지다. 지우면 아직 설치하지 않은 업데이트가 사라진다."""
    return "유지(설치 대기 업데이트)" if marks else "안전(대기 표시 없음)"

# ~/.cache 하위 디렉터리를 보이는 기준. 이 크기(KiB) 이상이면 나열한다.
CACHE_MIN_KB = 100 * 1024
NEWEST_MTIME_MAX_ENTRIES = 200_000
CODEX_RELEASES = "~/.codex/packages/standalone/releases"
CODEX_CURRENT = "~/.codex/packages/standalone/current"
CURSOR_SNAPSHOTS = "~/Library/Application Support/Cursor/snapshots"
PRUNABLE_RE = re.compile(r"^\s*(?:mise\s+)?(\S+?)@(\S+) is prunable: (.*)$")
CURSOR_APP_RE = re.compile(r"/Cursor\.app/")


def parse_mise_prunable(output):
    """`mise prune --dry-run` 출력에서 지울 수 있다고 본 (도구, 버전, 이유) 목록을 뽑는다. 다른 줄은 건너뛴다."""
    rows = []
    for line in output.splitlines():
        m = PRUNABLE_RE.match(line)
        if m:
            rows.append((m.group(1), m.group(2), m.group(3).strip()))
    return rows


def group_by_tool(rows):
    """(도구, 버전, 이유) 목록을 도구별 버전 목록으로 묶는다. 도구 이름순이다."""
    grouped = {}
    for tool, version, _ in rows:
        grouped.setdefault(tool, []).append(version)
    return dict(sorted(grouped.items()))


def commands_using(ps_output, needle):
    """ps 의 명령줄 중 needle 경로를 포함한 줄의 수."""
    return sum(1 for line in ps_output.splitlines() if needle in line)


def cursor_running(ps_output):
    """Cursor 앱 번들 안에서 도는 프로세스가 있는지."""
    return any(CURSOR_APP_RE.search(line) for line in ps_output.splitlines())


def age_days(newest_ts, now):
    """마지막 수정 시각(epoch)을 경과 일수로 바꾼다. 시각을 모르면 None."""
    return None if newest_ts is None else max(0, int((now - newest_ts) // 86400))


def newest_mtime(root, max_entries=NEWEST_MTIME_MAX_ENTRIES):
    """root 아래에서 가장 늦은 수정 시각. 디렉터리 자신의 mtime 은 직속 항목이 바뀔 때만 변해, 안쪽 파일까지 본다.
    항목이 max_entries 를 넘으면 거기까지 본 값을 쓴다. 비어 있거나 읽지 못하면 root 자신의 mtime 이다."""
    try:
        newest = os.lstat(root).st_mtime
    except OSError:
        return None
    seen = 0
    for cur, dirs, files in os.walk(root, followlinks=False):
        for name in files + dirs:
            seen += 1
            if seen > max_entries:
                return newest
            try:
                newest = max(newest, os.lstat(os.path.join(cur, name)).st_mtime)
            except OSError:
                continue
    return newest


def codex_release_rows(sizes, current, ps_output):
    """Codex 릴리스 디렉터리별 행을 만든다. sizes 는 {경로: KiB}, current 는 `current` 가 가리키는 경로(없으면 None).
    행은 dict(path, kb, current, running) 이고 경로순이다. running 은 그 경로를 명령줄에 가진 프로세스가 있다는 뜻이다."""
    rows = []
    real_current = os.path.realpath(current) if current else None
    for path, kb in sorted(sizes.items()):
        # macOS 의 /var 와 /private/var 처럼 같은 디렉터리의 다른 표기를 같게 본다.
        rows.append({"path": path, "kb": kb, "current": os.path.realpath(path) == real_current, "running": commands_using(ps_output, path) > 0})
    return rows


def section(title):
    print(f"\n## {title}")


def survey_disk():
    section("디스크 (APFS 데이터 볼륨)")
    sys.stdout.write(run(["df", "-h", "/System/Volumes/Data"]) or "df 를 읽지 못했다\n")


def survey_memory():
    section("메모리와 스왑")
    mem = run(["sysctl", "-n", "hw.memsize"])
    if mem and mem.strip().isdigit():
        print(f"실제 메모리: {int(mem) // 1073741824}GB")
    sys.stdout.write(run(["sysctl", "vm.swapusage"]) or "")
    pressure = run(["memory_pressure"])
    if pressure and pressure.strip():
        print(pressure.strip().splitlines()[-1])
    page, comp = parse_vm_stat(run(["vm_stat"]) or "")
    if page and comp is not None:
        print(f"압축 메모리: {comp * page // 1048576}MB")
    sys.stdout.write(run(["uptime"]) or "")


def survey_rss():
    section("앱별 RSS 합계 상위 15")
    totals = rss_by_app(run(["ps", "-axo", "rss=,command="]) or "")
    for name, kb in sorted(totals.items(), key=lambda x: -x[1])[:15]:
        print(f"{kb / 1048576:7.2f}GB  {name}")


def survey_big_dirs():
    section("큰 디렉터리")
    print("-- ~ (상위 15)")
    du_top(HOME, 15)
    print("-- ~/Library/Caches (상위 10)")
    du_top(os.path.join(HOME, "Library/Caches"), 10)
    print("-- ~/Library/Application Support (상위 10)")
    du_top(os.path.join(HOME, "Library/Application Support"), 10)


def survey_docker():
    section("Docker")
    if shutil.which("docker") and run_ok(["docker", "info"]):
        sys.stdout.write(run(["docker", "system", "df"]) or "")
        if shutil.which("colima"):
            sys.stdout.write(run(["colima", "list"]) or "")
        disks = os.path.join(HOME, ".colima/_lima/_disks")
        size_of(disks)
    else:
        print("docker 를 쓸 수 없어 건너뛴다")


def survey_tool_caches():
    section("도구 캐시")
    size_of(os.path.join(HOME, ".npm"))
    size_of(os.path.join(HOME, ".npm/_npx"))
    if shutil.which("pnpm"):
        size_of((run(["pnpm", "store", "path"]) or "").strip())
    size_of(os.path.join(HOME, ".gradle"))
    size_of(os.path.join(HOME, ".m2"))
    size_of(os.path.join(HOME, ".cache/uv"))
    if shutil.which("pip3"):
        size_of((run(["pip3", "cache", "dir"]) or "").strip())
    if shutil.which("brew"):
        size_of((run(["brew", "--cache"]) or "").strip())
    size_of(os.path.join(HOME, ".cache/huggingface"))
    caches = os.path.join(HOME, "Library/Caches")
    if os.path.isdir(caches):
        for name in sorted(os.listdir(caches)):
            if name.startswith("ms-playwright"):
                size_of(os.path.join(caches, name))


def survey_updaters():
    section("업데이트 캐시 (*-updater, *.ShipIt)")
    caches = os.path.join(HOME, "Library/Caches")
    try:
        names = sorted(n for n in os.listdir(caches) if is_updater_dir(n))
    except OSError:
        names = []
    if not names:
        print("해당 디렉터리 없음")
    for name in names:
        path = os.path.join(caches, name)
        try:
            marks = pending_marks(os.listdir(path))
        except OSError:
            marks = []
        rows = du_kb(["-s", path])
        size = human_kb(rows[0][0]) if rows else "?"
        print(f"{size:>6}  {path}  {updater_verdict(marks)}" + (f"  대기={','.join(marks)}" if marks else ""))


def survey_codex_releases():
    section("Codex 이전 버전")
    releases = os.path.expanduser(CODEX_RELEASES)
    if not os.path.isdir(releases):
        print("해당 디렉터리 없음")
        return
    sizes = {p: kb for kb, p in du_kb(["-d1", releases]) if p != releases}
    current = os.path.realpath(os.path.expanduser(CODEX_CURRENT)) if os.path.islink(os.path.expanduser(CODEX_CURRENT)) else None
    rows = codex_release_rows(sizes, current, run(["ps", "-axo", "command="]) or "")
    for row in rows:
        marks = (" current" if row["current"] else "") + (" 실행중" if row["running"] else "")
        print(f"{human_kb(row['kb']):>6}  {os.path.basename(row['path'])}{marks}")
    keep = [r for r in rows if r["current"] or r["running"]]
    print(f"버전 {len(rows)}개, 합계 {human_kb(sum(r['kb'] for r in rows))}, 남길 것(current 또는 실행중) {len(keep)}개")
    if not any(r["running"] for r in rows):
        print("이 경로를 실행 중인 프로세스 없음(실행 중 codex 는 다른 경로를 쓴다)")


def survey_cursor_snapshots():
    section("Cursor snapshots")
    snapshots = os.path.expanduser(CURSOR_SNAPSHOTS)
    if not os.path.isdir(snapshots):
        print("해당 디렉터리 없음")
        return
    size_of(snapshots)
    print("Cursor 실행 중: " + ("예" if cursor_running(run(["ps", "-axo", "command="]) or "") else "아니오"))


def survey_mise_prune():
    section("mise prune --dry-run")
    if not shutil.which("mise"):
        print("mise 가 없어 건너뛴다")
        return
    out = run(["mise", "prune", "--dry-run"], timeout=120, merge_stderr=True)
    if out is None:
        print("mise prune --dry-run 을 읽지 못했다")
        return
    grouped = group_by_tool(parse_mise_prunable(out))
    if not grouped:
        print("지울 수 있다고 본 버전 없음")
    for tool, versions in grouped.items():
        print(f"{tool}  {len(versions)}개  {' '.join(versions)}")
    if grouped:
        print("mise prune 을 그대로 돌리지 않는다. 사용자가 고른 도구만 `mise uninstall 도구@버전` 으로 지운다")


def survey_dot_cache():
    section("~/.cache 하위 (큰 것)")
    root = os.path.join(HOME, ".cache")
    if not os.path.isdir(root):
        print("해당 디렉터리 없음")
        return
    ps_output = run(["ps", "-axo", "command="]) or ""
    now = time.time()
    big = [(kb, p) for kb, p in du_kb(["-d1", root]) if p != root and kb >= CACHE_MIN_KB]
    for kb, path in top_dirs(big, 15):
        days = age_days(newest_mtime(path), now)
        age = "?" if days is None else f"{days}일"
        used = "사용중" if commands_using(ps_output, path) else "프로세스 없음"
        print(f"{human_kb(kb):>6}  마지막 수정 {age:>6} 전  {used}  {path}")
    if not big:
        print(f"{human_kb(CACHE_MIN_KB)} 이상인 하위 디렉터리 없음")


def survey_snapshots():
    section("로컬 스냅샷과 휴지통")
    sys.stdout.write(run(["tmutil", "listlocalsnapshots", "/"]) or "")
    size_of(os.path.join(HOME, ".Trash"))


def main(argv=None):
    argparse.ArgumentParser(description=__doc__.splitlines()[0]).parse_args(argv)
    for step in (survey_disk, survey_memory, survey_rss, survey_big_dirs, survey_docker,
                 survey_tool_caches, survey_updaters, survey_dot_cache,
                 survey_codex_releases, survey_cursor_snapshots, survey_mise_prune, survey_snapshots):
        step()
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
