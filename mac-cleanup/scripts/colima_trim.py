#!/usr/bin/env python3
"""Colima VM 안에서 fstrim 을 돌리고, 호스트 VM 디스크 파일이 줄었는지 재서 부족하면 다시 돈다.

사용법:
  colima_trim.py [--profile default] [--disk PATH] [--threshold-gib 4]
                 [--max-attempts 4] [--interval 60]

VM 디스크 파일의 실제 점유 크기(`du -sk`)와 VM 안 `/mnt/lima-colima` 의 사용량을 비교한다.
점유 크기가 사용량보다 기준값보다 더 크면 아직 비워지지 않은 블록이 남은 것으로 보고 잠시 기다렸다 다시 trim 한다.
volume 을 지운 직후에는 한 번에 덜 비워지는 경우가 있어(실측: 8GiB 만 trim, 1분 뒤 43.8GiB) 결과를 재서 재시도한다.
`--disk` 가 없으면 `~/.colima/_lima/_disks/colima/datadisk`(default 프로필) 나 `colima-<프로필>/datadisk` 를 쓴다.
fstrim 은 데이터를 지우지 않는다.

종료 코드: 0 차이가 기준값 이하, 1 Colima 가 떠 있지 않거나 측정 실패, 2 재시도 상한까지 차이가 남음.
"""

import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

GIB = 1024**3
MOUNT = "/mnt/lima-colima"
TRIM_RE = re.compile(r"\((\d+) bytes\) trimmed")


def parse_trim_bytes(output):
    """`fstrim -v` 출력에서 trim 한 바이트 수의 합을 낸다. 알아볼 수 없으면 0 이다."""
    return sum(int(n) for n in TRIM_RE.findall(output or ""))


def parse_used_bytes(output):
    """`df -B1 --output=used` 출력의 마지막 숫자 줄을 바이트로 바꾼다. 없으면 None 이다."""
    for line in reversed((output or "").strip().splitlines()):
        if line.strip().isdigit():
            return int(line.strip())
    return None


def parse_du_bytes(output):
    """`du -sk` 출력의 첫 열(KiB)을 바이트로 바꾼다. 알아볼 수 없으면 None 이다."""
    head = (output or "").split()
    return int(head[0]) * 1024 if head and head[0].isdigit() else None


def gap_bytes(disk_file, vm_used):
    """호스트 디스크 파일 점유 크기에서 VM 안 사용량을 뺀 값. 비워지지 않은 블록의 양이다."""
    return disk_file - vm_used


def should_retry(gap, threshold, attempt, max_attempts):
    """차이가 기준값을 넘고 시도 횟수가 남았으면 다시 돈다."""
    return gap > threshold and attempt < max_attempts


def disk_path(profile, override=None):
    if override:
        return Path(override).expanduser()
    name = "colima" if profile == "default" else f"colima-{profile}"
    return Path.home() / ".colima" / "_lima" / "_disks" / name / "datadisk"


def fmt(num):
    return f"{num / GIB:.1f}GiB"


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def colima_running(profile):
    try:
        return run(["colima", "status", "-p", profile]).returncode == 0
    except OSError:
        return False


def measure(profile, disk):
    """(디스크 파일 점유, VM 안 사용량, 호스트 여유)를 바이트로 잰다. 실패하면 RuntimeError 다."""
    du = parse_du_bytes(run(["du", "-sk", str(disk)]).stdout)
    df = run(["colima", "ssh", "-p", profile, "--", "df", "-B1", "--output=used", MOUNT])
    used = parse_used_bytes(df.stdout)
    if du is None or used is None:
        raise RuntimeError(f"측정 실패: du={du} df={df.stderr.strip() or df.stdout.strip()}")
    return du, used, shutil.disk_usage(str(Path.home())).free


def trim(profile):
    """sync 뒤에 fstrim -v 를 돌려 trim 한 바이트 수를 낸다."""
    cmd = f"sync && sudo fstrim -v {MOUNT}"
    done = run(["colima", "ssh", "-p", profile, "--", "sh", "-c", cmd])
    if done.returncode != 0:
        raise RuntimeError(f"fstrim 실패: {done.stderr.strip() or done.stdout.strip()}")
    return parse_trim_bytes(done.stdout + done.stderr)


def line(label, disk_file, used, free):
    return f"{label}: 디스크 파일 {fmt(disk_file)}, VM 사용량 {fmt(used)}, 차이 {fmt(gap_bytes(disk_file, used))}, 호스트 여유 {fmt(free)}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--profile", default="default")
    ap.add_argument("--disk")
    ap.add_argument("--threshold-gib", type=float, default=4.0)
    ap.add_argument("--max-attempts", type=int, default=4)
    ap.add_argument("--interval", type=float, default=60.0, help="재시도 전 대기 초")
    args = ap.parse_args(argv)

    if not colima_running(args.profile):
        print(f"Colima 프로필 {args.profile} 가 떠 있지 않다. 아무것도 하지 않았다.", file=sys.stderr)
        return 1
    disk = disk_path(args.profile, args.disk)
    threshold = int(args.threshold_gib * GIB)
    try:
        before = measure(args.profile, disk)
        print(line("전", *before))
        attempt, after = 0, before
        while True:
            attempt += 1
            trimmed = trim(args.profile)
            after = measure(args.profile, disk)
            print(f"시도 {attempt}: trim {fmt(trimmed)}")
            print("  " + line("측정", *after))
            gap = gap_bytes(after[0], after[1])
            if not should_retry(gap, threshold, attempt, args.max_attempts):
                break
            print(f"  차이가 기준값 {fmt(threshold)} 보다 커 {args.interval:.0f}초 뒤 다시 돈다")
            time.sleep(args.interval)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(line("후", *after))
    print(f"디스크 파일 {fmt(before[0])} -> {fmt(after[0])}, 호스트 확보 {fmt(after[2] - before[2])}")
    gap = gap_bytes(after[0], after[1])
    if gap > threshold:
        print(f"시도 {attempt}회 뒤에도 차이 {fmt(gap)} 가 남았다(기준값 {fmt(threshold)})", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
