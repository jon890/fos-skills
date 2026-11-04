#!/usr/bin/env python3
"""Docker 이미지를 사용 중, 미사용, 최근 생성으로 나눈다. 읽기 전용이다.

사용법:
  docker_images.py [--recent-hours 24]

종료 코드: 0 조사 완료, 1 docker 를 쓸 수 없음.
각 줄 끝의 rmi= 값을 `docker rmi` 에 그대로 넘긴다. 태그가 있으면 repo:tag, 저장소나 태그가 <none> 이거나 repo:tag 로 조회되지 않으면(repo:tag@digest 로 저장된 이미지) 이미지 ID 다.
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


def short_id(image_id):
    """`sha256:` 접두사를 떼고 12자리로 줄인다. `docker images` 가 보이는 짧은 ID 와 같다."""
    return image_id.removeprefix("sha256:")[:12]


def rmi_target(repository, tag, image_id, resolves=True):
    """`docker rmi` 에 그대로 넘길 값. 저장소나 태그가 <none> 이면 repo:<none> 이 invalid reference format 이라 이미지 ID 를 쓴다.
    태그는 있어도 repo:tag 로 조회되지 않으면(이름이 repo:tag@digest 로 저장된 경우) 이미지 ID 를 쓴다. resolves 는 조회 결과다."""
    if repository == "<none>" or tag == "<none>" or not resolves:
        return short_id(image_id)
    return f"{repository}:{tag}"


def docker_ref_resolves(ref):
    """`docker image inspect <ref>` 가 성공하면 True. 시간 초과나 실행 실패는 확인하지 못한 것이라 True 로 둔다. 확인하지 못했는데 ID 로 바꾸면 태그가 여럿인 이미지가 -f 없이 거절된다."""
    try:
        done = subprocess.run(["docker", "image", "inspect", ref], capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return True
    return done.returncode == 0


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
        resolves = img["Repository"] == "<none>" or img["Tag"] == "<none>" or docker_ref_resolves(ref)
        target = rmi_target(img["Repository"], img["Tag"], img["ID"], resolves=resolves)
        print(f"{cls:<22} {img['Size']:>9}  {ref}  ({img['CreatedSince']})  rmi={target} id={short_id(img['ID'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
