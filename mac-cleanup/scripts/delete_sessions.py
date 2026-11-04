#!/usr/bin/env python3
"""`survey_sessions.py --json-out` 결과의 「워크트리가 사라진 대화 기록」 폴더를 지운다. 기본은 dry-run 이다.

사용법:
  delete_sessions.py ORPHAN_JSON --older-than-days N [--apply]

ORPHAN_JSON 은 `survey_sessions.py --json-out FILE` 이 쓴 파일이고, `-` 이면 표준 입력을 읽는다.
--older-than-days N(필수)보다 가장 늦은 수정 시각이 오래된 폴더만 고른다.
지우기 직전에 폴더마다 다시 확인하고, 하나라도 다르면 남기고 이유를 낸다.
  1. 경로가 기록 폴더(`projects`) 바로 아래의 실제 폴더이고 심볼릭 링크가 아니다
  2. 기록 안의 `cwd` 가 조사 때와 같고 지금도 없다
  3. 폴더 안 파일의 가장 늦은 수정 시각이 조사 때와 같다(그사이 세션이 기록을 이었으면 남긴다)
--apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.

종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류.
"""

import argparse
import json
import os
import shutil
import sys
import time

import survey_sessions as ss

MTIME_TOLERANCE = 1e-3


def result(item, status, detail=""):
    return {"path": item["path"], "status": status, "detail": detail, "size_bytes": item.get("size_bytes") or 0}


def recheck(item, base):
    """지우기 직전 재확인. 문제가 있으면 이유 문장, 없으면 None."""
    path = item["path"]
    if os.path.basename(base) != "projects":
        return "기록 폴더가 projects 가 아니다"
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(base):
        return "기록 폴더 바로 아래가 아니다"
    if os.path.islink(path) or not os.path.isdir(path):
        return "실제 폴더가 아니거나 이미 없다"
    cwd = ss.read_cwd(path)
    if cwd is None:
        return "cwd 를 읽을 수 없다"
    if cwd != item["cwd"]:
        return f"cwd 가 조사 때와 다르다: {cwd}"
    if os.path.exists(cwd):
        return f"cwd 가 다시 생겼다: {cwd}"
    _, newest = ss.folder_stats(path)
    if newest is None or abs(newest - item["newest_mtime"]) > MTIME_TOLERANCE:
        return "조사 뒤 수정 시각이 바뀌었다(세션이 기록을 이었다)"
    return None


def process(item, base, older_than_days, apply, now, remove=shutil.rmtree):
    """폴더 하나를 처리한다. status: 삭제, 삭제 예정, 유지, 실패."""
    if item["newest_mtime"] >= now - older_than_days * 86400:
        return result(item, "유지", f"{older_than_days:g}일 이내 수정")
    why = recheck(item, base)
    if why:
        return result(item, "유지", why)
    if not apply:
        return result(item, "삭제 예정", item["cwd"])
    try:
        remove(item["path"])
    except OSError as exc:
        return result(item, "실패", str(exc))
    return result(item, "삭제", item["cwd"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("orphan_json")
    ap.add_argument("--older-than-days", type=float, required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    try:
        text = sys.stdin.read() if args.orphan_json == "-" else open(args.orphan_json, encoding="utf-8").read()
        data = json.loads(text)
        base, items = data["base"], data["orphans"]
        if not isinstance(base, str) or not isinstance(items, list) or any(
                not all(k in i for k in ("path", "cwd", "newest_mtime")) for i in items):
            raise ValueError("survey_sessions.py --json-out 형식이 아니다")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"입력을 읽을 수 없다: {exc}", file=sys.stderr)
        return 2

    now = time.time()
    print("## 실행" if args.apply else "## dry-run (변경 없음, 실제 삭제는 --apply)")
    print(f"기준: {args.older_than_days:g}일 넘은 폴더")
    results = [process(i, base, args.older_than_days, args.apply, now) for i in items]
    for r in results:
        print(f"[{r['status']}] {ss.human(r['size_bytes']):>9}  {r['path']}  {r['detail']}".rstrip())
    counts = {}
    for r in results:
        slot = counts.setdefault(r["status"], [0, 0])
        slot[0] += 1
        slot[1] += r["size_bytes"]
    print("\n## 합계")
    for key, (count, size) in sorted(counts.items()):
        print(f"{count:>4}개 {ss.human(size):>9}  {key}")
    return 1 if counts.get("실패") else 0


if __name__ == "__main__":
    sys.exit(main())
