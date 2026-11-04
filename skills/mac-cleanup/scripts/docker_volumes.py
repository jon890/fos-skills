#!/usr/bin/env python3
"""이름이 64자리 hex 인 dangling 익명 volume 을 후보와 최근 생성으로 나눈다. 읽기 전용이다.

사용법:
  docker_volumes.py [--recent-hours 24] [--peek N|all] [--peek-image IMAGE] [--json] [--json-out FILE]

--peek N 은 후보 중 큰 순서로 N개의 최상위 항목을 보인다. `all` 이면 후보를 모두 연다. 이미 있는 이미지로 컨테이너를 잠깐 띄워
volume 을 읽기 전용으로 붙여 `ls -A` 만 돌리고, 이미지를 pull 하지 않으며 네트워크를 끊는다.
--peek-image 가 없으면 로컬 이미지 중 alpine, busybox, debian, ubuntu 를 고른다.
기준 시간 안에 생긴 volume 은 "최근" 으로 따로 보이고 후보 합계에 넣지 않는다.
ryuk 컨테이너가 떠 있으면 다른 세션이 테스트 중이라는 경고를 먼저 낸다.
크기는 `docker system df -v` 의 VOLUME 표에서 얻는다. 단위는 Docker 와 같은 10진수다.
열어 본 volume 에는 내용 종류(kind)를 붙인다: postgres, mysql, other. 열지 않은 volume 의 kind 는 JSON 에서 null 이다.
--json-out FILE 은 텍스트를 출력하면서 같은 조사 결과를 JSON 으로 파일에 쓴다. 지우기는 `delete_volumes.py` 가 이 파일을 읽는다.

종료 코드: 0 조사 완료, 1 docker 를 쓸 수 없음.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime

ANON_RE = re.compile(r"^[0-9a-f]{64}$")
UNITS = {"B": 1, "KB": 1000, "MB": 1000**2, "GB": 1000**3, "TB": 1000**4}
SIZE_RE = re.compile(r"^([0-9.]+)\s*([kKMGT]?B)$")
PEEK_PREFERENCE = ("alpine", "busybox", "debian", "ubuntu")
MYSQL_MARKERS = ("ibdata1", "#innodb_redo", "mysql", "auto.cnf")
KINDS = ("postgres", "mysql", "other")


def is_anonymous(name):
    """이름이 소문자 hex 64자리이면 익명 volume 이다."""
    return bool(ANON_RE.match(name))


def parse_size(text):
    """`256.6MB`, `0B`, `12kB` 를 바이트로 바꾼다. 알아볼 수 없으면 None 이다."""
    m = SIZE_RE.match((text or "").strip())
    if not m:
        return None
    return int(float(m.group(1)) * UNITS[m.group(2).upper()])


def format_size(num):
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1000:
            return f"{num:.0f}{unit}" if unit == "B" else f"{num:.1f}{unit}"
        num /= 1000
    return f"{num:.1f}TB"


def parse_created(text):
    """`2026-10-14T22:14:51+09:00` 를 epoch 초로 바꾼다. 알아볼 수 없으면 None 이다."""
    try:
        return datetime.fromisoformat(text).timestamp()
    except (TypeError, ValueError):
        return None


def parse_jsonl(text):
    rows = []
    for line in text.splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def classify_volume(vol, now, recent_hours):
    """vol 은 {'created_ts'}. 생성 시각을 모르거나 기준 시간 안이면 '최근', 아니면 '후보' 다."""
    ts = vol.get("created_ts")
    if ts is None or now - ts < recent_hours * 3600:
        return "최근"
    return "후보"


def build_volumes(names, created, sizes, now, recent_hours):
    """dangling volume 이름 목록과 생성 시각, 크기 표로 익명 volume 항목을 만든다. 큰 순서로 정렬한다."""
    items = []
    for name in names:
        if not is_anonymous(name):
            continue
        vol = {"name": name, "created_ts": created.get(name), "size_bytes": sizes.get(name)}
        vol["class"] = classify_volume(vol, now, recent_hours)
        items.append(vol)
    items.sort(key=lambda v: (-(v["size_bytes"] or 0), v["name"]))
    return items


def classify_kind(entries):
    """최상위 항목 이름 목록으로 내용 종류를 정한다. PG_VERSION 이 있으면 postgres, MySQL 표지가 있으면 mysql, 아니면 other 다."""
    names = set(entries)
    if "PG_VERSION" in names:
        return "postgres"
    if names & set(MYSQL_MARKERS):
        return "mysql"
    return "other"


def summarize_kinds(items):
    """열어 본(kind 가 있는) 후보의 종류별 개수와 크기를 더한다."""
    out = {}
    for vol in items:
        if vol["class"] != "후보" or vol.get("kind") is None:
            continue
        slot = out.setdefault(vol["kind"], {"count": 0, "size_bytes": 0})
        slot["count"] += 1
        slot["size_bytes"] += vol["size_bytes"] or 0
    return out


def peek_count(text):
    """`--peek` 값. 정수 또는 `all` 이다."""
    if text == "all":
        return sys.maxsize
    try:
        return int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("정수 또는 all 이어야 한다")


def summarize(items):
    out = {}
    for cls in ("후보", "최근"):
        picked = [v for v in items if v["class"] == cls]
        out[cls] = {"count": len(picked), "size_bytes": sum(v["size_bytes"] or 0 for v in picked)}
    return out


def has_ryuk(image_lines):
    return any("ryuk" in line for line in image_lines)


def pick_peek_image(refs):
    for pref in PEEK_PREFERENCE:
        for ref in refs:
            if ref.rsplit("/", 1)[-1].split(":")[0] == pref and not ref.endswith(":<none>"):
                return ref
    return None


def docker(*args, timeout=120):
    done = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip())
    return done.stdout


def peek(name, image):
    """volume 의 최상위 항목을 읽기 전용으로 본다. 실패하면 오류 문장을 돌려준다."""
    try:
        out = docker("run", "--rm", "--pull=never", "--network", "none", "-v", f"{name}:/v:ro",
                     "--entrypoint", "ls", image, "-A", "/v", timeout=60)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
        return None, str(exc)[:120]
    return out.split(), None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--recent-hours", type=float, default=24)
    ap.add_argument("--peek", type=peek_count, default=0, metavar="N|all")
    ap.add_argument("--peek-image")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--json-out", metavar="FILE")
    args = ap.parse_args(argv)
    try:
        names = docker("volume", "ls", "-f", "dangling=true", "-q").split()
        anon = [n for n in names if is_anonymous(n)]
        created = {}
        if anon:
            for entry in json.loads(docker("volume", "inspect", *anon)):
                created[entry["Name"]] = parse_created(entry.get("CreatedAt"))
        df = json.loads(docker("system", "df", "-v", "--format", "{{json .Volumes}}", timeout=300) or "[]")
        sizes = {v["Name"]: parse_size(v.get("Size")) for v in df}
        running = docker("ps", "--format", "{{.Image}}").splitlines()
        refs = docker("images", "--format", "{{.Repository}}:{{.Tag}}").splitlines()
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError, KeyError) as exc:
        print(f"docker 를 쓸 수 없다: {exc}", file=sys.stderr)
        return 1

    now = time.time()
    items = build_volumes(names, created, sizes, now, args.recent_hours)
    totals = summarize(items)
    ryuk = has_ryuk(running)
    peeks = {}
    image = args.peek_image or pick_peek_image(refs)
    if args.peek > 0:
        if not image:
            print("경고: 내용을 열 로컬 이미지가 없어 --peek 을 건너뛴다. --peek-image 로 지정한다", file=sys.stderr)
        else:
            for vol in [v for v in items if v["class"] == "후보"][: args.peek]:
                peeks[vol["name"]] = peek(vol["name"], image)

    for vol in items:
        vol["kind"] = None
        if vol["name"] in peeks:
            vol["top_entries"], vol["peek_error"] = peeks[vol["name"]]
            if vol["top_entries"] is not None:
                vol["kind"] = classify_kind(vol["top_entries"])
    payload = {"ryuk_running": ryuk, "recent_hours": args.recent_hours, "peek_image": image if peeks else None,
               "totals": totals, "kind_totals": summarize_kinds(items), "volumes": items}
    if args.json_out:
        try:
            with open(args.json_out, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
        except OSError as exc:
            print(f"--json-out 파일을 쓸 수 없다: {exc}", file=sys.stderr)
            return 1
    if args.json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    if ryuk:
        print("경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 지우기 전에 사용자에게 알린다")
    for cls in ("후보", "최근"):
        title = "후보(하루 넘은 dangling 익명 volume)" if cls == "후보" else f"최근({args.recent_hours:g}시간 안, 후보에서 뺀다)"
        print(f"## {title}")
        for vol in [v for v in items if v["class"] == cls]:
            made = datetime.fromtimestamp(vol["created_ts"]).strftime("%Y-%m-%d %H:%M") if vol["created_ts"] else "-"
            size = format_size(vol["size_bytes"]) if vol["size_bytes"] is not None else "?"
            print(f"{size:>9}  {made}  {vol['name']}")
            if vol["name"] in peeks:
                entries, err = peeks[vol["name"]]
                shown = f"[{vol['kind']}] {' '.join(entries[:12])}" if entries is not None else "열지 못함: " + err
                print(f"           내용: {shown}")
    print("\n## 합계")
    for cls in ("후보", "최근"):
        print(f"{totals[cls]['count']:>4}개 {format_size(totals[cls]['size_bytes']):>9}  {cls}")
    kinds = payload["kind_totals"]
    if kinds:
        print("\n## 열어 본 후보의 종류별 합계")
        for kind in KINDS:
            if kind in kinds:
                print(f"{kinds[kind]['count']:>4}개 {format_size(kinds[kind]['size_bytes']):>9}  {kind}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
