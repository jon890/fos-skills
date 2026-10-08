#!/usr/bin/env python3
"""Docker 이미지를 사용 중, 미사용, 최근 생성으로 나눈다. 읽기 전용이다.

사용법:
  docker_images.py [--recent-hours 24]

종료 코드: 0 조사 완료, 1 docker 를 쓸 수 없음.
컨테이너의 Image 값과 repo:tag 를 비교할 때 태그 생략(:latest)을 맞춘다.
"""

import argparse
import json
import subprocess
import sys
import time


def normalize_image(ref):
    """태그가 없으면 :latest 를 붙인다. digest(@sha256) 가 있으면 그대로 둔다. 레지스트리 포트의 ':' 는 태그로 보지 않는다."""
    if "@" in ref:
        return ref
    last = ref.rsplit("/", 1)[-1]
    return ref if ":" in last else f"{ref}:latest"


def classify_image(image, used_refs, used_ids, now, recent_hours):
    """image 는 {'ref', 'id', 'created_ts'}. 사용 중 / 최근 생성 / 미사용 으로 나눈다."""
    if image["id"] in used_ids or normalize_image(image["ref"]) in used_refs:
        return "사용 중"
    if now - image["created_ts"] < recent_hours * 3600:
        return "확인 필요(최근 생성)"
    return "미사용"


def docker(*args):
    done = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=60)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip())
    return done.stdout


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--recent-hours", type=float, default=24)
    args = ap.parse_args(argv)
    try:
        containers = [json.loads(l) for l in docker("ps", "-a", "--no-trunc", "--format", "{{json .}}").splitlines() if l]
        images = [json.loads(l) for l in docker("images", "--no-trunc", "--format", "{{json .}}").splitlines() if l]
        ids = docker("ps", "-aq", "--no-trunc").split()
        inspect = json.loads(docker("inspect", *ids)) if ids else []
    except (RuntimeError, OSError, subprocess.TimeoutExpired, ValueError) as exc:
        print(f"docker 를 쓸 수 없다: {exc}", file=sys.stderr)
        return 1
    used_refs = {normalize_image(c["Image"]) for c in containers}
    used_ids = {c.get("Image") for c in inspect}
    now = time.time()
    for img in images:
        ref = "<none>" if img["Repository"] == "<none>" else f"{img['Repository']}:{img['Tag']}"
        inspected = json.loads(docker("inspect", img["ID"]))[0]
        created = inspected.get("Created", "")[:19]
        created_ts = time.mktime(time.strptime(created, "%Y-%m-%dT%H:%M:%S")) if created else 0
        cls = classify_image({"ref": ref, "id": inspected["Id"], "created_ts": created_ts}, used_refs, used_ids, now, args.recent_hours)
        print(f"{cls:<22} {img['Size']:>9}  {ref}  ({img['CreatedSince']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
