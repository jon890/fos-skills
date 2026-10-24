#!/usr/bin/env python3
"""`docker_volumes.py --json-out` 결과의 익명 volume 을 지운다. 기본은 dry-run 이다.

사용법:
  delete_volumes.py VOLUMES_JSON [--kind postgres mysql other ...] [--apply]

VOLUMES_JSON 은 `docker_volumes.py --peek all --json-out FILE` 이 쓴 파일이고, `-` 이면 표준 입력을 읽는다.
지우는 대상은 분류가 `후보` 이고, 내용을 열어 본 결과가 있고(peek_error 없음), kind 가 --kind 에 든 volume 뿐이다.
--kind 는 여러 번 또는 여러 값으로 받는다. 기본은 postgres 와 mysql 이다. 에이전트 홈과 SQLite 파일 같은
`other` 는 기본으로 지우지 않으며, 사용자가 따로 승인한 뒤 `--kind other` 로만 지운다.
열어 보지 않은 volume 과 `최근` volume 은 `유지` 로 보인다.
실행 직전에 dangling 목록을 다시 읽어, 그사이 컨테이너에 붙었거나 이미 없는 volume 은 `유지` 로 보인다.
지우기는 이름마다 `docker volume rm` 을 따로 부른다. `docker volume prune` 은 쓰지 않는다.
ryuk 컨테이너가 떠 있으면 dry-run 은 경고만 내고 `--apply` 는 거부한다.
--apply 가 없으면 아무것도 바꾸지 않고 무엇을 할지만 보인다.

종료 코드: 0 실패 없음, 1 실패가 하나라도 있음, 2 입력 오류, 3 ryuk 가 떠 있어 --apply 거부, 4 docker 를 쓸 수 없음.
"""

import argparse
import json
import subprocess
import sys

import docker_volumes as dv

DEFAULT_KINDS = ["postgres", "mysql"]


def list_dangling():
    """지금 dangling 인 volume 이름 집합. docker 를 쓸 수 없으면 RuntimeError 등이 난다."""
    return set(dv.docker("volume", "ls", "-f", "dangling=true", "-q").split())


def ryuk_running():
    return dv.has_ryuk(dv.docker("ps", "--format", "{{.Image}}").splitlines())


def remove_volume(name):
    """`docker volume rm <이름>` 하나를 부른다. (성공 여부, 오류 문장) 을 돌려준다."""
    try:
        dv.docker("volume", "rm", name)
    except (RuntimeError, subprocess.TimeoutExpired, OSError) as exc:
        return False, str(exc)
    return True, ""


def result(vol, status, detail=""):
    return {"name": vol["name"], "status": status, "detail": detail, "size_bytes": vol.get("size_bytes") or 0}


def process_volume(vol, kinds, apply, dangling, remove):
    """volume 하나를 처리한다. status: 삭제, 삭제 예정, 유지, 실패."""
    name = vol["name"]
    if not dv.is_anonymous(name):
        return result(vol, "유지", "익명 volume 이름이 아니다")
    if vol.get("class") != "후보":
        return result(vol, "유지", f"분류 {vol.get('class')}")
    if vol.get("peek_error"):
        return result(vol, "유지", f"내용을 열지 못했다: {vol['peek_error']}")
    if vol.get("kind") is None:
        return result(vol, "유지", "내용을 열어 보지 않았다")
    if vol["kind"] not in kinds:
        return result(vol, "유지", f"종류 {vol['kind']} 는 --kind 에 없다")
    if name not in dangling:
        return result(vol, "유지", "dangling 목록에 없다(이미 없거나 컨테이너에 붙었다)")
    if not apply:
        return result(vol, "삭제 예정", f"docker volume rm ({vol['kind']})")
    ok, err = remove(name)
    return result(vol, "삭제", f"({vol['kind']})") if ok else result(vol, "실패", err)


def run(volumes, kinds, apply, dangling, remove):
    return [process_volume(v, kinds, apply, dangling, remove) for v in volumes]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("volumes_json")
    ap.add_argument("--kind", nargs="+", action="extend", choices=dv.KINDS)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    kinds = set(args.kind or DEFAULT_KINDS)
    try:
        text = sys.stdin.read() if args.volumes_json == "-" else open(args.volumes_json, encoding="utf-8").read()
        data = json.loads(text)
        volumes = data["volumes"]
        if not isinstance(volumes, list) or any("name" not in v for v in volumes):
            raise ValueError("docker_volumes.py --json-out 형식이 아니다")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"입력을 읽을 수 없다: {exc}", file=sys.stderr)
        return 2

    try:
        ryuk = ryuk_running()
        dangling = list_dangling()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"docker 를 쓸 수 없다: {exc}", file=sys.stderr)
        return 4
    if ryuk:
        if args.apply:
            print("거부: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 를 하지 않는다", file=sys.stderr)
            return 3
        print("경고: testcontainers ryuk 가 떠 있다. 다른 세션이 테스트 중이므로 --apply 전에 사용자에게 알린다")

    print("## 실행" if args.apply else "## dry-run (변경 없음, 실제 삭제는 --apply)")
    print(f"대상 종류: {', '.join(k for k in dv.KINDS if k in kinds)}")
    results = run(volumes, kinds, args.apply, dangling, remove_volume)
    for r in results:
        print(f"[{r['status']}] {dv.format_size(r['size_bytes']):>9}  {r['name']}  {r['detail']}".rstrip())
    counts = {}
    for r in results:
        slot = counts.setdefault(r["status"], [0, 0])
        slot[0] += 1
        slot[1] += r["size_bytes"]
    print("\n## 합계")
    for key, (count, size) in sorted(counts.items()):
        print(f"{count:>4}개 {dv.format_size(size):>9}  {key}")
    return 1 if counts.get("실패") else 0


if __name__ == "__main__":
    sys.exit(main())
