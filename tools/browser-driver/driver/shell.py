"""백엔드 프로세스를 부르고 반환값을 정규화하는 공통 도구."""

import json
import subprocess

from .config import WAIT_INTERVAL
from .errors import DriverError

def run(argv, check_marker=None):
    """외부 명령을 돌리고 stdout+stderr 를 한 덩어리로 돌려준다.

    check_marker 가 있으면 출력 줄머리에서 그 표식을 찾아 실패로 판정한다.
    백엔드가 실패를 종료 코드로 알리지 않기 때문이다 (실측).
    """
    proc = subprocess.run(argv, capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    if check_marker:
        for line in out.splitlines():
            if line.startswith(check_marker):
                raise DriverError(out.strip())
    return out


def js_value(value):
    """js 명령의 반환값을 백엔드와 무관한 한 가지 형식으로 맞춘다.

    문자열은 따옴표 없이 그대로, 나머지는 JSON 표기로 낸다.
    `null` 과 `true` 를 파이썬 표기(`None`, `True`)로 내면 소비자가 파싱하지 못한다.
    """
    if isinstance(value, str):
        return value
    # 구분자에 여백을 두지 않는다. orca 는 객체를 여백 없는 JSON 문자열로 돌려주므로 (실측)
    # 기본 구분자를 쓰면 같은 표현식이 백엔드마다 다른 바이트로 나온다.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def wait_expression(condition, timeout):
    """조건이 참이 될 때까지 기다리는 JS 표현식을 만든다.

    조건 대기 명령이 없는 백엔드에서 eval 안의 폴링으로 대신한다.
    """
    return f"""(async () => {{
  const t0 = Date.now();
  while (true) {{
    let ok = false;
    try {{ ok = !!({condition}); }} catch (e) {{ ok = false; }}
    if (ok) return 'ok in ' + (Date.now() - t0) + 'ms';
    if (Date.now() - t0 > {timeout}) throw new Error('waitjs timeout after {timeout}ms');
    await new Promise(r => setTimeout(r, {WAIT_INTERVAL}));
  }}
}})()"""
