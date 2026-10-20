#!/usr/bin/env python3
"""코디네이터가 처리할 메시지가 올 때까지 기다린다. heartbeat 만 든 묶음은 ack 하고 계속 기다린다.

`check --wait` 는 `--types` 를 깨어나는 조건으로만 쓰고, 돌려주는 delivery 는 그때 쌓인 묶음 전체다.
heartbeat 만 든 묶음으로 깨어나면 코디네이터가 읽을 것 없이 ack 하고 다시 거느라 깨어남마다 한 턴을 쓴다.
이 스크립트가 그 묶음을 대신 ack 하고, 처리할 종류가 든 묶음이 오면 ack 하지 않고 그대로 낸다.
코디네이터는 그 묶음을 `triage-messages.py` 로 읽은 뒤 마지막 줄의 delivery id 를 다음 대기의 `--ack` 로 넘긴다.

**Bash 도구의 `run_in_background` 로만 띄운다.** 셸의 `&` 나 `nohup` 으로 띄우면 끝나도 완료 알림이 오지 않는다.
플러그인 hook(`hooks/block-background-wait.py`)이 그런 호출을 막는다.

사용법:
    wait-important.py --run RUN_ID [--ack DELIVERY_ID] [--types worker_done,question,escalation,status]
                      [--timeout-ms 7000000]

    --run         기다릴 Run
    --ack         앞 대기가 낸 delivery id. 첫 대기처럼 넘길 것이 없으면 뺀다
    --types       깨어날 메시지 종류. 기본 worker_done,question,escalation,status
    --timeout-ms  전체 대기 한도(ms). 기본 7000000. 하네스의 명령 한도(Bash 최대 7200000)보다 짧게 준다

출력:
    처리할 묶음이 오면 그 `check --json` 결과를 한 줄 JSON 으로 내고, 마지막 줄에 `LAST_DELIVERY <id>` 를 낸다.
    시간 한도가 지나면 `TIMEOUT LAST_DELIVERY <id>` 를 낸다. id 는 ack 하지 못하고 남은 delivery 이고, 없으면 `-` 다.

ORCA 환경 변수로 orca 실행 파일을 바꾼다.

종료 코드:
    0  처리할 묶음이 왔다
    3  시간 한도가 지났다. 실패가 아니므로 마지막 줄의 id 로 다시 건다
    1  orca 가 오류를 냈다(waiter_exists, runtime_unavailable 같은 것). 그 JSON 을 그대로 낸다
    2  사용법 오류
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

ORCA = os.environ.get("ORCA", "orca")
DEFAULT_TYPES = "worker_done,question,escalation,status"


def check(run_id, types, ack, timeout_ms):
    """`check --wait --json` 한 번. (stdout 의 JSON, 원문). JSON 이 아니면 None 이다."""
    cmd = [ORCA, "orchestration", "check", "--run", run_id, "--wait", "--types", types,
           "--timeout-ms", str(timeout_ms), "--json"]
    if ack:
        cmd[3:3] = ["--ack", ack]
    # keepalive 줄은 stderr 로 나온다. stdout 만 읽는다
    done = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        return json.loads(done.stdout), done.stdout
    except json.JSONDecodeError:
        return None, done.stdout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True)
    parser.add_argument("--ack")
    parser.add_argument("--types", default=DEFAULT_TYPES)
    parser.add_argument("--timeout-ms", type=int, default=7000000)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    wanted = {t.strip() for t in args.types.split(",") if t.strip()}
    if not wanted or args.timeout_ms <= 0:
        print("wait-important: --types 와 --timeout-ms 는 비어 있거나 0 일 수 없다", file=sys.stderr)
        return 2

    deadline = time.monotonic() + args.timeout_ms / 1000
    ack, skipped = args.ack, 0
    while True:
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            print(f"TIMEOUT LAST_DELIVERY {ack or '-'}")
            return 3
        data, raw = check(args.run, args.types, ack, remaining)
        if not isinstance(data, dict) or not data.get("ok"):
            print(raw.strip() or "wait-important: orca 출력이 JSON 이 아니다")
            print(f"LAST_DELIVERY {ack or '-'}")
            return 1
        result = data.get("result") or {}
        # --ack 를 넘긴 호출이 성공했으면 그 delivery 는 처리됐다
        ack = None
        messages = result.get("messages") or []
        delivery = result.get("deliveryId")
        if any(m.get("type") in wanted for m in messages):
            print(json.dumps(data, ensure_ascii=False))
            print(f"LAST_DELIVERY {delivery or '-'}")
            return 0
        if messages:
            skipped += len(messages)
            print(f"heartbeat 같은 메시지 {skipped} 개를 ack 하고 계속 기다린다", file=sys.stderr)
        # heartbeat 만 든 묶음은 다음 호출에서 ack 한다. 시간 한도로 끝난 호출은 delivery 가 없다
        ack = delivery


if __name__ == "__main__":
    sys.exit(main())
