"""agent-browser 백엔드. 조건 대기 명령이 없어 eval 폴링으로 대신한다."""

import json

from ..config import CONFIG_PATH, READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT, config_value
from ..errors import DriverError, UsageError
from ..shell import js_value, run, wait_expression
from .base import Backend

class AgentBrowserBackend(Backend):
    """agent-browser CLI.

    실패해도 종료 코드가 0 이고 출력 줄머리에 ✗ 를 붙인다 (실측).
    세션 기반이라 page id 가 없으므로 세션 이름을 핸들로 돌려준다.
    cdpPort 를 적어 두면 그 Chrome 에 붙고, 없으면 스스로 브라우저를 띄운다 (실측).
    close 한 뒤에도 핸들이 죽지 않고 다음 명령이 새 브라우저를 띄운다. orca 와 다르다 (실측).
    """

    name = "agent-browser"
    binary = "agent-browser"
    supported = {"open", "nav", "js", "waitjs", "ready", "url", "snap",
                 "shot", "console", "errors", "close"}

    def _ab(self, *args):
        return run([self.binary, *args], check_marker="✗")

    def _connect_if_configured(self):
        port = config_value("cdpPort")
        if port:
            self._ab("connect", str(port))

    def prepare_note(self):
        port = config_value("cdpPort")
        if not port:
            return ("cdpPort 가 없어도 스스로 브라우저를 띄운다 (실측). 다만 그 브라우저에는 "
                    "로그인 세션이 없다. SSO 가 필요한 사내 시스템은 Chrome 을 "
                    f"--remote-debugging-port 로 띄우고 {CONFIG_PATH} 에 cdpPort 를 적는다")
        return ""

    def dispatch(self, cmd, args):
        if cmd == "open":
            self._connect_if_configured()
            self._ab("open", args[0])
            try:
                session = self._ab("session").strip()
            except DriverError:
                session = ""
            return session or "default"

        if cmd == "nav":
            self._ab("open", args[1])
            return None

        if cmd == "js":
            # eval 은 값을 JSON 으로 인코딩해 낸다. 그대로 흘리면 문자열에 따옴표가 붙어
            # orca 와 형식이 갈린다. JSON.stringify 결과를 파싱하는 소비자가 그 따옴표에서
            # 깨지므로 (실측), 한 겹 벗겨 orca 와 같은 형식으로 맞춘다.
            raw = self._ab("eval", args[1]).rstrip("\n")
            try:
                return js_value(json.loads(raw))
            except json.JSONDecodeError:
                # undefined 처럼 JSON 이 아닌 출력은 그대로 넘긴다.
                return raw

        if cmd == "waitjs":
            timeout = int(args[2]) if len(args) > 2 else WAIT_TIMEOUT_DEFAULT
            self._ab("eval", wait_expression(args[1], timeout))
            return None

        if cmd == "ready":
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            self._ab("eval", wait_expression("document.readyState==='complete'", timeout))
            return None

        if cmd == "url":
            return self._ab("get", "url").rstrip("\n")

        if cmd == "snap":
            return self._ab("snapshot").rstrip("\n")

        if cmd == "shot":
            out = args[1] if len(args) > 1 else "/tmp/browser-shot.png"
            self._ab("screenshot", out)
            return out

        if cmd == "console":
            return self._ab("console").rstrip("\n")

        if cmd == "errors":
            return self._ab("errors").rstrip("\n")

        if cmd == "close":
            self._ab("close")
            return None

        raise UsageError(f"agent-browser 백엔드가 '{cmd}' 를 다루지 않는다")
