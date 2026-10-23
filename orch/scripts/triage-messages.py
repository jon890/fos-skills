#!/usr/bin/env python3
"""orca orchestration 메시지를 종류별로 모아 보여 준다. heartbeat 는 보낸 쪽마다 개수만 낸다.

완료 보고(worker_done)가 heartbeat 사이에 묻혀 놓치지 않게 하는 것이 목적이다.

사용법:
    triage-messages.py FILE [FILE ...]          # 백그라운드 `check --wait --json` 출력 파일을 읽는다
    triage-messages.py --live [--run RUN_ID] [--terminal HANDLE]
                                                # `orca orchestration check --all --json` 을 직접 부른다
    공통 옵션:
      --since WHEN     이 시각 이후 메시지만. ISO 시각(2026-10-12T15:00:00Z) 또는 지금부터 거슬러 30m, 2h, 1d
      --width N        본문을 N 자에서 자른다. 기본 3000, 0 이면 자르지 않는다
      --json           사람이 읽는 글 대신 분류 결과를 JSON 으로 낸다

FILE 에는 JSON 객체가 여럿 이어져 있어도 되고, keepalive 줄과 하네스가 붙인 종료 코드 줄이 섞여 있어도 된다.
`-` 를 주면 표준 입력에서 읽는다.
`--live` 의 `--all` 은 읽음 표시를 하지 않는다. 대기 중인 `check --wait` 의 delivery 를 건드리지 않는다.

출력 순서는 완료 근거가 없는 의심스러운 worker_done, worker_done, escalation, question, 그 밖의 종류(status 등), heartbeat 개수다.
같은 메시지 id 는 한 번만 센다.

종료 코드:
    0  읽었다. 메시지가 없어도 0 이다
    1  orca 호출이 실패했거나 읽을 JSON 이 하나도 없다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from completion_evidence import classify

PRIORITY = ("suspicious_worker_done", "worker_done", "escalation", "question")
RELATIVE = re.compile(r"^(\d+)([mhd])$")
UNIT = {"m": "minutes", "h": "hours", "d": "days"}


def parse_objects(text: str) -> list[dict]:
    """문자열에 이어 붙은 JSON 객체를 모두 꺼낸다. 객체가 아닌 줄은 건너뛴다."""
    dec = json.JSONDecoder()
    out, i = [], 0
    while True:
        i = text.find("{", i)
        if i < 0:
            return out
        try:
            obj, end = dec.raw_decode(text, i)
        except ValueError:
            i += 1
            continue
        if isinstance(obj, dict):
            out.append(obj)
        i = end


def parse_time(value: str) -> dt.datetime:
    """시간대가 없는 값은 UTC 로 본다. orca 는 UTC 로 낸다."""
    t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def parse_since(value: str, now: dt.datetime | None = None) -> dt.datetime:
    m = RELATIVE.match(value)
    if m:
        now = now or dt.datetime.now(dt.timezone.utc)
        return now - dt.timedelta(**{UNIT[m.group(2)]: int(m.group(1))})
    t = parse_time(value)
    return t if t.tzinfo else t.astimezone()


def collect(objects: list[dict]) -> tuple[list[str], list[dict]]:
    """delivery id 목록과, id 로 중복을 걸러낸 메시지 목록을 돌려준다."""
    deliveries, messages, seen = [], [], set()
    for obj in objects:
        result = obj.get("result")
        if not isinstance(result, dict):
            continue
        if result.get("deliveryId"):
            deliveries.append(result["deliveryId"])
        for m in result.get("messages") or []:
            key = m.get("id")
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            messages.append(m)
    return deliveries, messages


def triage(messages: list[dict], since: dt.datetime | None = None, completion_contract="ready") -> dict:
    groups: dict[str, list[dict]] = {}
    heartbeats: dict[str, int] = {}
    checked = classify(messages) if completion_contract == "ready" else messages
    for m in checked:
        created = m.get("created_at")
        if since and created:
            try:
                if parse_time(created) < since:
                    continue
            except ValueError:
                pass
        kind = m.get("type", "?")
        if kind == "heartbeat":
            who = m.get("from_handle") or "?"
            heartbeats[who] = heartbeats.get(who, 0) + 1
            continue
        groups.setdefault(kind, []).append(m)
    order = [k for k in PRIORITY if k in groups] + sorted(k for k in groups if k not in PRIORITY)
    return {"groups": {k: groups[k] for k in order}, "heartbeats": heartbeats}


def payload_text(payload) -> str:
    if payload is None:
        return ""
    return payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)


def render(deliveries: list[str], result: dict, width: int) -> str:
    lines = []
    if deliveries:
        lines.append("delivery " + " ".join(deliveries))
    for kind, items in result["groups"].items():
        label = "의심스러운 worker_done" if kind == "suspicious_worker_done" else kind
        lines.append(f"\n== {label} {len(items)}건")
        for m in items:
            body = payload_text(m.get("body"))
            if width and len(body) > width:
                body = body[:width] + " …(잘림)"
            lines.append(f"- {m.get('id')} {m.get('created_at', '')} from={m.get('from_handle', '')}")
            lines.append(f"  제목: {m.get('subject', '')}")
            extra = payload_text(m.get("payload"))
            if extra:
                lines.append(f"  payload: {extra[:200]}")
            lines.extend("  " + b for b in body.splitlines() or [""])
    hb = result["heartbeats"]
    if hb:
        lines.append(f"\n== heartbeat {sum(hb.values())}건 " + ", ".join(f"{k}={v}" for k, v in sorted(hb.items())))
    if not result["groups"] and not hb:
        lines.append("메시지 없음")
    return "\n".join(lines)


def read_live(run: str | None, terminal: str | None) -> str:
    cmd = ["orca", "orchestration", "check", "--all", "--json"]
    if run:
        cmd += ["--run", run]
    if terminal:
        cmd += ["--terminal", terminal]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(1)
    return proc.stdout


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--run")
    ap.add_argument("--terminal")
    ap.add_argument("--since")
    ap.add_argument("--width", type=int, default=3000)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--completion-contract", choices=("ready", "none"), default="ready",
                    help="기본 ready: 앞선 PR 준비 상태 검사. PR 없는 작업만 none 사용")
    a = ap.parse_args(argv)
    if bool(a.files) == a.live:
        ap.error("FILE 과 --live 중 하나만 준다")
    try:
        since = parse_since(a.since) if a.since else None
    except ValueError:
        ap.error(f"--since 를 읽지 못했다: {a.since}")

    if a.live:
        text = read_live(a.run, a.terminal)
    else:
        text = "".join(sys.stdin.read() if f == "-" else Path(f).read_text(encoding="utf-8") for f in a.files)
    objects = parse_objects(text)
    deliveries, messages = collect(objects)
    if not deliveries and not messages and not any("result" in o for o in objects):
        sys.stderr.write("읽을 orca 결과 JSON 이 없다\n")
        return 1
    result = triage(messages, since, a.completion_contract)
    if a.json:
        print(json.dumps({"deliveries": deliveries, **result}, ensure_ascii=False, indent=1))
    else:
        print(render(deliveries, result, a.width))
    return 0


if __name__ == "__main__":
    sys.exit(main())
