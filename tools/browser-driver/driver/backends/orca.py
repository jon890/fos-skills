"""orca 백엔드. 워크트리에 탭을 만들고 앱의 로그인 세션을 그대로 쓴다."""

import base64
import json
import os
import sys
from pathlib import Path

from ..config import READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT
from ..errors import DriverError, UsageError
from ..shell import js_value, run
from .base import Backend

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
