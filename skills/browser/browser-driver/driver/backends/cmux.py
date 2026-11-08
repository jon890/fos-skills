"""cmux 백엔드. 실패를 종료 코드로 정확히 알리는 유일한 백엔드다."""

import json
import os
import re
import subprocess

from ..config import READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT
from ..errors import DriverError, UsageError
from ..shell import js_value
from .base import Backend

class CmuxBackend(Backend):
    """cmux 내장 브라우저 (manaflow-ai/cmux).

    실패를 종료 코드 1 로 정확히 알린다 (실측). 다른 두 백엔드와 달리 출력 표식을 볼 필요가 없다.
    출력에 error 라는 낱말이 들어간 정상 결과를 실패로 오판하지 않으려면 문자열 검사를 쓰지 않는다.

    탭을 surface 번호로 가리킨다. open 이 `OK surface=surface:2 pane=... placement=...` 를 낸다 (실측).

    소켓 접근이 기본으로 cmux 안에서 시작된 프로세스에만 허용된다 (`automation.socketControlMode`
    기본값 `cmuxOnly`). 밖에서 부르면 `Access denied` 로 끝나므로, cmux 터미널에서 에이전트를
    돌리거나 `password` 모드로 바꾸고 CMUX_SOCKET_PASSWORD 를 넘긴다 (실측).
    """

    name = "cmux"
    binary = "cmux"
    supported = {"open", "nav", "js", "waitjs", "ready", "url", "snap",
                 "shot", "console", "errors", "close"}

    def _cmux(self, *args):
        proc = subprocess.run([self.binary, *args], capture_output=True, text=True)
        out = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            raise DriverError(out.strip())
        return out

    @staticmethod
    def _surface(handle):
        return handle if handle.startswith("surface:") else f"surface:{handle}"

    def prepare_note(self):
        """소켓에 실제로 붙는지 확인한다. 설치돼 있어도 밖에서는 거부되기 때문이다."""
        try:
            self._cmux("ping")
        except DriverError as e:
            first = str(e).splitlines()[0] if str(e) else "붙지 못했다"
            return (f"소켓에 붙지 못한다 ({first}). cmux 터미널 안에서 에이전트를 돌리거나, "
                    "cmux.json 의 automation.socketControlMode 를 password 로 두고 "
                    "socketPassword 를 적는다")
        return ""

    def _ready(self, surface, timeout):
        self._cmux("browser", surface, "wait", "--load-state", "complete",
                   "--timeout-ms", str(timeout))

    def dispatch(self, cmd, args):
        if cmd == "open":
            out = self._cmux("browser", "open", args[0])
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            m = re.search(r"surface=(surface:\d+)", out)
            if not m:
                # 환경변수로 지정한 surface 를 마지막 수단으로 쓴다. 출력 형식이 바뀌어도 막히지 않는다.
                fixed = os.environ.get("BROWSER_CMUX_SURFACE")
                if not fixed:
                    raise DriverError("open 출력에서 surface 를 찾지 못했다. "
                                      f"BROWSER_CMUX_SURFACE 로 지정한다.\n{out.strip()}")
                surface = self._surface(fixed)
            else:
                surface = m.group(1)
            self._ready(surface, timeout)
            return surface

        surface = self._surface(args[0])

        if cmd == "nav":
            timeout = int(args[2]) if len(args) > 2 else READY_TIMEOUT_DEFAULT
            self._cmux("browser", surface, "goto", args[1])
            self._ready(surface, timeout)
            return None

        if cmd == "js":
            # eval 은 Promise 를 기다린다 (실측). 객체는 여백을 넣어 내므로 파싱해 형식을 맞춘다.
            raw = self._cmux("browser", surface, "eval", args[1]).rstrip("\n")
            try:
                return js_value(json.loads(raw))
            except json.JSONDecodeError:
                return raw

        if cmd == "ready":
            self._ready(surface, int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT)
            return None

        if cmd == "waitjs":
            # 조건 대기 명령이 있으므로 eval 폴링을 쓰지 않는다 (실측).
            timeout = int(args[2]) if len(args) > 2 else WAIT_TIMEOUT_DEFAULT
            self._cmux("browser", surface, "wait", "--function", args[1],
                       "--timeout-ms", str(timeout))
            return None

        if cmd == "url":
            return self._cmux("browser", surface, "url").rstrip("\n")

        if cmd == "snap":
            return self._cmux("browser", surface, "snapshot").rstrip("\n")

        if cmd == "shot":
            # screenshot 은 `OK <경로>` 를 낸다 (실측). 경로만 남겨 다른 백엔드와 형식을 맞춘다.
            out = args[1] if len(args) > 1 else "/tmp/cmux-shot.png"
            self._cmux("browser", surface, "screenshot", "--out", out)
            return out

        if cmd == "console":
            return self._cmux("browser", surface, "console", "list").rstrip("\n")

        if cmd == "errors":
            return self._cmux("browser", surface, "errors", "list").rstrip("\n")

        if cmd == "close":
            self._cmux("browser", surface, "tab", "close")
            return None

        raise UsageError(f"cmux 백엔드가 '{cmd}' 를 다루지 않는다")
