#!/usr/bin/env python3
"""브라우저 자동화 드라이버 중립 계층.

왜 필요한가:
  1. 스킬 본문이 특정 브라우저 도구에 묶이지 않게 한다. 팀원마다 쓰는 도구가 다르다.
  2. orca 와 agent-browser 는 둘 다 실패해도 종료 코드가 0 이다 (실측).
     그대로 쓰면 오류가 조용히 묻힌다. 이 계층이 실패를 종료 코드 1 로 바꾼다.
  3. agent-browser 에는 JS 조건 대기 명령이 없다. eval 안의 async 폴링으로 메운다 (실측).

명령 목록과 백엔드 상태는 `browser-driver help`, 환경 진단은 `browser-driver doctor` 가 낸다.
백엔드별 함정은 README.md 가 소유한다.

종료 코드:
  0 성공
  1 브라우저 조작 실패
  2 잘못된 호출이나 환경 문제 (백엔드 없음, 설정 오류, 미지원 명령)
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

READY_TIMEOUT_DEFAULT = 30000
WAIT_TIMEOUT_DEFAULT = 10000
WAIT_INTERVAL = 150

CONFIG_PATH = Path(os.environ.get("BROWSER_CONFIG", Path.home() / ".claude" / "browser.config.json"))

EXIT_FAIL = 1
EXIT_USAGE = 2


class DriverError(Exception):
    """조작 실패. 종료 코드 1 로 끝난다."""


class UsageError(Exception):
    """잘못된 호출이나 환경 문제. 종료 코드 2 로 끝난다."""


# ---------------------------------------------------------------- 명령 스펙

class Command:
    def __init__(self, name, args, summary, returns="", note=""):
        self.name = name
        self.args = args
        self.summary = summary
        self.returns = returns
        self.note = note

    @property
    def required(self) -> int:
        """대괄호로 감싸지 않은 인자의 개수."""
        return len([a for a in self.args if not a.startswith("[")])

    @property
    def usage(self) -> str:
        return " ".join([self.name] + list(self.args))


COMMANDS = [
    Command("open", ["<url>", "[ready_timeout_ms]"],
            "탭을 열고 로드가 끝날 때까지 기다린다",
            returns="핸들 한 줄. 이후 모든 명령의 첫 인자로 넘긴다"),
    Command("nav", ["<handle>", "<url>", "[ready_timeout_ms]"],
            "이미 열린 탭을 다른 주소로 보낸다"),
    Command("js", ["<handle>", "<expression>"],
            "JS 표현식을 실행한다",
            returns="표현식의 값",
            note="숨은 요소나 겹침 화면은 이 명령으로 조작한다. 인자는 작은따옴표로 감싼다"),
    Command("waitjs", ["<handle>", "<condition>", "[timeout_ms]"],
            "JS 조건이 참이 될 때까지 기다린다",
            note=f"고정 대기 대신 이것을 쓴다. 기본 제한 시간 {WAIT_TIMEOUT_DEFAULT}ms"),
    Command("ready", ["<handle>", "[timeout_ms]"],
            "document.readyState 가 complete 가 될 때까지 기다린다"),
    Command("url", ["<handle>"],
            "지금 보고 있는 주소를 낸다",
            note="조회 결과가 비면 먼저 이것으로 로그인 화면으로 튕겼는지 본다"),
    Command("snap", ["<handle>"],
            "화면의 접근성 트리를 낸다"),
    Command("shot", ["<handle>", "[path]"],
            "화면을 이미지 파일로 저장한다",
            returns="저장한 경로"),
    Command("console", ["<handle>"], "콘솔 로그를 낸다"),
    Command("errors", ["<handle>"], "페이지 오류를 낸다"),
    Command("worktree", ["<handle>"],
            "탭이 붙어 있는 워크트리 경로를 낸다",
            note="orca 백엔드 전용. 사람이 볼 화면을 갱신하기 전에 기대한 곳의 탭인지 확인한다"),
    Command("close", ["<handle>"], "탭을 닫는다"),
]

COMMAND_MAP = {c.name: c for c in COMMANDS}

META_COMMANDS = [
    Command("driver", [], "지금 고른 백엔드 이름을 낸다"),
    Command("doctor", [], "백엔드 감지 결과와 준비 상태를 판정해 낸다"),
    Command("help", [], "이 도움말을 낸다"),
    Command("install", ["[--dst <dir>]"], "~/.claude/scripts/ 에 심볼릭 링크를 만든다"),
]


# ---------------------------------------------------------------- 공통 도구

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


def config_value(key):
    """설정 파일에서 키 하나를 읽는다. 파일이나 키가 없으면 None."""
    if not CONFIG_PATH.exists():
        return None
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise UsageError(f"{CONFIG_PATH} 를 읽지 못했다: {e}")
    value = data.get(key)
    return value or None


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


# ---------------------------------------------------------------- 백엔드

class Backend:
    name = ""
    binary = ""
    #: 이 백엔드가 대응 명령을 확인한 것만 적는다. 나머지는 종료 코드 2 로 거절한다.
    supported = set()
    #: 실제로 돌려 확인했는지. 거짓이면 doctor 가 경고 표시를 붙인다.
    verified = True

    @classmethod
    def available(cls):
        return shutil.which(cls.binary) is not None

    def prepare_note(self):
        """쓰기 전에 사람이 해둬야 하는 것. 없으면 빈 문자열."""
        return ""

    def dispatch(self, cmd, args):
        raise NotImplementedError


class OrcaBackend(Backend):
    """Orca 내장 브라우저.

    orca CLI 는 실패해도 종료 코드가 0 이고 JSON 의 "ok" 필드만 실패를 알린다 (실측).
    """

    name = "orca"
    binary = "orca"
    supported = {"open", "nav", "js", "waitjs", "ready", "url", "snap",
                 "shot", "console", "errors", "worktree", "close"}

    def _call(self, path, *orca_args):
        """orca 를 부르고 result 의 하위 경로를 뽑는다. path 가 빈 문자열이면 result 전체.

        orca wait --load 는 이미 로드된 페이지에서도 항상 시간이 초과되므로 쓰지 않는다 (실측).
        """
        raw = run([self.binary, *orca_args, "--json"])
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            raise DriverError(f"orca 응답이 JSON 이 아니다:\n{raw}")
        if not data.get("ok"):
            err = data.get("error") or {}
            raise DriverError("orca 실패 [%s] %s" % (err.get("code", "unknown"),
                                                    err.get("message", raw)))
        node = data.get("result") or {}
        if not path:
            return node
        for key in path.split("."):
            if not isinstance(node, dict) or key not in node:
                raise DriverError(f"응답에 {path} 가 없다: {json.dumps(node, ensure_ascii=False)}")
            node = node[key]
        return node

    def _ready(self, handle, timeout):
        self._call("", "wait", "--fn", "document.readyState==='complete'",
                   "--timeout", str(timeout), "--page", handle)

    def _worktree(self, handle):
        """탭이 붙은 워크트리를 읽는다.

        tab list 는 현재 워크트리의 탭만 보여주므로 쓸 수 없다.
        tab show 는 워크트리를 넘어 조회된다 (실측).
        """
        tab = self._call("tab", "tab", "show", "--page", handle)
        wt = (tab or {}).get("worktreeId") or ""
        if "::" in wt:
            return wt.split("::", 1)[-1]
        return wt

    def dispatch(self, cmd, args):
        if cmd == "open":
            url = args[0]
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            # orca tab create 는 셸의 작업 디렉토리가 속한 워크트리에 탭을 만든다. 조사하느라 다른
            # 저장소로 옮긴 상태에서 열면 사용자가 보는 워크트리가 아닌 곳에 탭이 생긴다 (실측).
            # --worktree active 로도 막지 못한다. active 역시 작업 디렉토리를 따라간다 (실측).
            worktree = os.environ.get("ORCA_WORKTREE")
            create = ["tab", "create", "--url", url]
            if worktree:
                create += ["--worktree", worktree]
            handle = self._call("browserPageId", *create)
            self._ready(handle, timeout)
            # 어느 워크트리에 열렸는지 알린다. 사용자가 탭을 찾지 못하는 상황을 바로 드러낸다.
            try:
                where = self._worktree(handle) or "(워크트리 없음)"
                print(f"탭 위치: {where}", file=sys.stderr)
            except DriverError:
                pass
            return handle

        if cmd == "nav":
            handle, url = args[0], args[1]
            timeout = int(args[2]) if len(args) > 2 else READY_TIMEOUT_DEFAULT
            self._call("", "goto", "--url", url, "--page", handle)
            self._ready(handle, timeout)
            return None

        if cmd == "js":
            return js_value(self._call("result", "eval", "--expression", args[1], "--page", args[0]))

        if cmd == "waitjs":
            timeout = int(args[2]) if len(args) > 2 else WAIT_TIMEOUT_DEFAULT
            self._call("", "wait", "--fn", args[1], "--timeout", str(timeout), "--page", args[0])
            return None

        if cmd == "ready":
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            self._ready(args[0], timeout)
            return None

        if cmd == "url":
            return self._call("url", "get", "--what", "url", "--page", args[0])

        if cmd == "snap":
            # --json 을 붙이면 접근성 트리가 snapshot 필드로 오고 실패도 ok 로 알려준다 (실측).
            # 붙이지 않으면 없는 탭에도 종료 코드 0 이라 실패가 묻힌다.
            return self._call("snapshot", "snapshot", "--page", args[0])

        if cmd == "shot":
            # orca screenshot 은 파일이 아니라 base64 를 JSON 으로 돌려주므로 직접 디코딩한다.
            out = Path(args[1]) if len(args) > 1 else Path("/tmp/orca-shot.png")
            fmt = "jpeg" if out.suffix.lower() in (".jpg", ".jpeg") else "png"
            data = self._call("data", "screenshot", "--format", fmt, "--page", args[0])
            out.write_bytes(base64.b64decode(data))
            return str(out)

        if cmd == "console":
            return self._call("", "exec", "--command", "console", "--page", args[0])

        if cmd == "errors":
            return self._call("", "exec", "--command", "errors", "--page", args[0])

        if cmd == "worktree":
            return self._worktree(args[0]) or "(워크트리 없음)"

        if cmd == "close":
            self._call("", "tab", "close", "--page", args[0])
            return None

        raise UsageError(f"orca 백엔드가 '{cmd}' 를 다루지 않는다")


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


BACKENDS = {b.name: b for b in (OrcaBackend, AgentBrowserBackend, CmuxBackend)}

#: 자동 감지 순서. 사내 시스템은 SSO 세션이 필요해 orca 를 먼저 본다.
#: cmux 는 마지막이다. 설치돼 있어도 cmux 밖에서는 소켓 접근이 거부되므로 (실측)
#: 자동 감지로 먼저 잡히면 쓸 수 없는 백엔드가 선택된다.
DETECT_ORDER = ("orca", "agent-browser", "cmux")


def resolve_backend_name():
    """환경변수 → 설정 파일 → 자동 감지 순서로 백엔드를 정한다."""
    from_env = os.environ.get("BROWSER_DRIVER")
    if from_env:
        return from_env, "환경변수 BROWSER_DRIVER"
    from_config = config_value("driver")
    if from_config:
        return from_config, f"{CONFIG_PATH} 의 driver"
    for name in DETECT_ORDER:
        if BACKENDS[name].available():
            return name, "자동 감지"
    raise UsageError(
        "쓸 수 있는 브라우저 백엔드가 없다. orca 나 agent-browser 를 설치하거나\n"
        f"{CONFIG_PATH} 에 driver 를 적는다. 자세한 상태는 doctor 로 본다.")


def load_backend():
    name, source = resolve_backend_name()
    if name not in BACKENDS:
        raise UsageError(f"모르는 백엔드: {name} ({source}). 쓸 수 있는 값: "
                         + ", ".join(BACKENDS))
    cls = BACKENDS[name]
    if not cls.available():
        raise UsageError(f"{name} 을 찾지 못했다 ({source}). 설치했는지 doctor 로 본다.")
    return cls()


# ---------------------------------------------------------------- help, doctor

def render_help(backend_name=None, unsupported=frozenset()):
    lines = [
        "브라우저 자동화 드라이버. 백엔드가 달라도 아래 명령은 같다.",
        "",
        "  B=~/.claude/scripts/browser-driver",
        '  PAGE=$($B open "https://example.com")',
        "  $B js \"$PAGE\" 'document.title'",
        "",
        "명령",
    ]
    width = max(len(c.usage) for c in COMMANDS + META_COMMANDS) + 2
    for c in COMMANDS:
        mark = "  (이 백엔드는 못 씀)" if c.name in unsupported else ""
        lines.append(f"  {c.usage:<{width}}{c.summary}{mark}")
    lines.append("")
    for c in META_COMMANDS:
        lines.append(f"  {c.usage:<{width}}{c.summary}")
    lines += [
        "",
        "반환값",
        "  open 은 핸들 한 줄을 낸다. 나머지 명령의 첫 인자로 그 값을 넘긴다.",
        "  shot 은 저장한 경로를, js 와 url 은 값을 낸다. 나머지는 성공하면 아무것도 내지 않는다.",
        "",
        "함정",
        "  고정 대기 대신 waitjs 로 조건을 기다린다.",
        "  js 인자는 작은따옴표로 감싼다. 큰따옴표는 셸이 $( 를 명령 치환으로 먹는다.",
        "  조회 결과가 비면 url 로 로그인 화면으로 튕겼는지 먼저 본다.",
        "  사람이 볼 화면은 ORCA_WORKTREE 로 워크트리를 고정하고 worktree 로 확인한다.",
        "",
        "종료 코드는 0 성공, 1 조작 실패, 2 잘못된 호출이나 환경 문제.",
        "백엔드별 상세는 README.md, 환경 진단은 doctor 를 본다.",
    ]
    if backend_name:
        lines += ["", f"지금 잡힌 백엔드: {backend_name}"]
    return "\n".join(lines)


def cmd_doctor():
    print("=== 브라우저 드라이버 진단 ===")
    print("")
    print(f"설정 파일: {CONFIG_PATH}" + ("" if CONFIG_PATH.exists() else "  (없음, 자동 감지로 돈다)"))

    env = os.environ.get("BROWSER_DRIVER")
    print(f"BROWSER_DRIVER: {env if env else '(비어 있음)'}")

    print("")
    print("백엔드")
    for name, cls in BACKENDS.items():
        path = shutil.which(cls.binary)
        if not path:
            print(f"  ✗ {name:<14} 설치 안 됨")
            continue
        note = cls().prepare_note()
        mark = "✓" if cls.verified else "!"
        print(f"  {mark} {name:<14} {path}")
        if note:
            print(f"      참고: {note}")
        missing = sorted({c.name for c in COMMANDS} - cls.supported)
        if missing:
            print(f"      못 쓰는 명령: {', '.join(missing)}")

    print("")
    try:
        name, source = resolve_backend_name()
    except UsageError as e:
        print("판정: 쓸 수 있는 백엔드가 없다")
        print(f"  {e}")
        return EXIT_USAGE
    print(f"판정: {name} ({source})")
    return 0


def _backup_if_real_file(path):
    """심링크가 아닌 실제 파일이면 `.bak.{pid}` 로 옮기고 백업 경로를 돌려준다.

    사용자가 같은 이름으로 만들어 둔 스크립트를 말없이 지우지 않기 위한 보호다.
    """
    if path.is_symlink() or not path.exists():
        return None
    backup = path.with_suffix(path.suffix + f".bak.{os.getpid()}")
    path.rename(backup)
    return backup


def cmd_install(argv):
    """저장소의 이 파일을 ~/.claude/scripts/ 에 심볼릭 링크로 연결한다.

    심링크라 git pull 만으로 최신이 그대로 반영된다 (스킬 설치 방식과 동일).
    """
    dst = Path.home() / ".claude" / "scripts"
    if len(argv) >= 2 and argv[0] == "--dst":
        dst = Path(argv[1]).expanduser()

    src = Path(__file__).resolve()
    dst.mkdir(parents=True, exist_ok=True)

    print("=== 브라우저 드라이버 설치 ===")
    print("")
    for link_name in ("browser-driver",):
        link = dst / link_name
        backup = _backup_if_real_file(link)
        if backup:
            print(f"  기존 파일을 {backup} 로 백업")
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(src)
        print(f"  ✓ {link} → {src}")

    # 셸 시절에 쓰던 이름들이다. 남아 있으면 낡은 사본을 부르게 되므로 지운다.
    # 심링크만 지우고, 사용자가 같은 이름으로 만든 실제 파일은 백업해 남긴다.
    for stale_name in ("orca-browser.sh", "browser-driver.sh"):
        stale = dst / stale_name
        backup = _backup_if_real_file(stale)
        if backup:
            print(f"  기존 파일을 {backup} 로 백업")
            continue
        if stale.is_symlink() or stale.exists():
            stale.unlink()
            print(f"  ✓ 낡은 {stale} 제거")

    print("")
    print("백엔드 확인")
    try:
        name, source = resolve_backend_name()
        print(f"  ✓ {name} ({source})")
    except UsageError as e:
        print("  ✗ 쓸 수 있는 백엔드가 없다")
        print(f"    {e}")

    print("")
    print("설정을 바꾸려면 예시를 복사해 고친다.")
    print(f"  cp {src.parent / 'browser.config.example.json'} {CONFIG_PATH}")
    return 0


# ---------------------------------------------------------------- 진입점

def main(argv):
    cmd = argv[0] if argv else ""
    args = argv[1:]

    if cmd in ("", "help", "-h", "--help"):
        # 도움말은 백엔드가 없어도 나와야 한다. 무엇을 설치해야 하는지 여기서 읽기 때문이다.
        backend_name, unsupported = None, frozenset()
        try:
            name, _ = resolve_backend_name()
            if name in BACKENDS:
                backend_name = name
                unsupported = {c.name for c in COMMANDS} - BACKENDS[name].supported
        except UsageError:
            pass
        print(render_help(backend_name, unsupported))
        return 0 if cmd else EXIT_USAGE

    if cmd == "doctor":
        return cmd_doctor()

    if cmd == "install":
        return cmd_install(args)

    if cmd == "driver":
        # 설치 여부는 보지 않는다. 어느 백엔드가 잡히는지 묻는 명령이라 설치 전에도 답해야 한다.
        # 다만 모르는 이름은 여기서 막는다. 그대로 흘리면 첫 조작에서야 드러난다.
        name, source = resolve_backend_name()
        if name not in BACKENDS:
            raise UsageError(f"모르는 백엔드: {name} ({source}). 쓸 수 있는 값: "
                             + ", ".join(BACKENDS))
        print(name)
        return 0

    spec = COMMAND_MAP.get(cmd)
    if spec is None:
        known = ", ".join([c.name for c in COMMANDS] + [c.name for c in META_COMMANDS])
        raise UsageError(f"모르는 명령: {cmd}\n쓸 수 있는 명령: {known}\n자세한 사용법은 help 로 본다.")

    if len(args) < spec.required:
        raise UsageError(f"인자가 모자란다.\n사용법: {spec.usage}\n  {spec.summary}")

    backend = load_backend()
    if cmd not in backend.supported:
        raise UsageError(
            f"{backend.name} 백엔드에서 '{cmd}' 의 대응 명령을 확인하지 못했다. "
            "다른 백엔드를 쓰거나 doctor 로 상태를 본다.")

    result = backend.dispatch(cmd, args)
    if result is None:
        return 0
    if isinstance(result, (dict, list)):
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except UsageError as e:
        print(e, file=sys.stderr)
        sys.exit(EXIT_USAGE)
    except DriverError as e:
        print(e, file=sys.stderr)
        sys.exit(EXIT_FAIL)
    except KeyboardInterrupt:
        sys.exit(130)
