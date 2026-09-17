"""ego-browser 백엔드. 사용자가 쓰는 Chromium 의 로그인 세션을 그대로 쓴다."""

import json

from ..config import READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT
from ..errors import DriverError, UsageError
from ..shell import js_value, run
from .base import Backend

#: 이 드라이버가 쓰는 TaskSpace 이름. 여러 번 open 해도 한 공간에 모인다.
#: 사용자가 그 공간을 가져가면 `browser-driver #2` 처럼 번호를 붙여 새로 만든다.
SPACE_NAME = "browser-driver"

#: 아직 아무 곳도 열지 않은 페이지의 주소. 새 공간은 p1 을 이 상태로 들고 시작한다 (실측).
BLANK_URLS = ("about:blank", "chrome://new-tab-page/")

#: 반환값을 다른 출력과 나누는 표식. ego 는 업데이트 알림 같은 줄을 같은 stdout 에 섞는다.
MARKER = "<<<browser-driver-result>>>"


class EgoBackend(Backend):
    """ego-browser CLI.

    호출마다 Node 프로세스가 새로 뜨고 스크립트의 변수는 남지 않는다. TaskSpace 와
    page label 은 남으므로 그 둘을 `<spaceId>:<pageLabel>` 핸들로 쓴다 (실측).
    실패하면 종료 코드 1 과 오류 메시지를 낸다. orca 나 agent-browser 와 달리
    종료 코드로 실패를 알린다 (실측).
    콘솔 로그와 페이지 오류는 대응 API 가 없어 console 과 errors 를 다루지 않는다.
    `page.events()` 는 버퍼를 비우는 프로토콜 이벤트 배열이라 성격이 다르다.
    """

    name = "ego"
    binary = "ego-browser"
    supported = {"open", "nav", "js", "waitjs", "ready", "url", "snap",
                 "shot", "close"}

    def prepare_note(self):
        return (f"사용자가 로그인해 둔 세션을 그대로 쓴다 (실측). 탭은 '{SPACE_NAME}' 로 "
                "시작하는 TaskSpace 하나에 모인다. 사용자가 그 공간의 제어권을 가져가면 "
                "다음 open 이 번호를 붙인 새 공간을 만든다")

    def _run(self, body):
        """Node 스크립트를 stdin 으로 넘기고 표식 뒤의 반환값만 돌려준다.

        모든 명령의 스크립트가 끝에서 `__out` 을 부른다. 그래서 표식이 없다는 것은
        스크립트가 끝까지 가지 못했다는 뜻이고, 여기서 실패로 판정한다.
        ego 는 브라우저 서비스에 붙지 못할 때 종료 코드 0 으로 끝내므로 (실측)
        종료 코드만 보면 값을 내지 않는 명령의 실패가 드러나지 않는다.
        """
        script = (
            f"const __mark = {json.dumps(MARKER)};\n"
            "const __out = (v) => process.stdout.write("
            "'\\n' + __mark + '\\n' + (v === undefined || v === null ? '' : String(v)));\n"
            + body
        )
        try:
            out = run([self.binary, "nodejs"], stdin_text=script, check_exit=True)
        except DriverError as e:
            # 사용자가 TaskSpace 의 제어권을 가져가면 그 공간의 모든 호출이 거절된다 (실측).
            # ego 는 여기서 스택 추적까지 내므로, 무엇을 해야 하는지 첫 줄에 적는다.
            if "taken control" in str(e):
                raise DriverError(
                    "사용자가 이 TaskSpace 의 제어권을 가지고 있어 조작이 거절됐다. "
                    "브라우저에서 제어권을 돌려주거나, open 을 다시 불러 새 공간을 만든다.\n"
                    + str(e))
            raise
        if MARKER not in out:
            raise DriverError(
                "ego 스크립트가 끝까지 돌지 않았다. 브라우저 서비스에 붙지 못했을 수 있다.\n"
                + (out.strip() or "(출력이 없다)"))
        return out.rsplit(MARKER + "\n", 1)[-1]

    def _page(self, handle):
        """핸들에서 TaskSpace 를 잡고 page 를 여는 스크립트 앞부분을 만든다."""
        space, _, label = handle.partition(":")
        if not space.isdigit() or not label:
            raise UsageError(
                f"ego 핸들 형식이 아니다: {handle}. open 이 낸 '<spaceId>:<pageLabel>' 을 그대로 넘긴다")
        return (f"const task = await taskSpace({int(space)});\n"
                f"const page = task.page({json.dumps(label)});\n")

    def dispatch(self, cmd, args):
        if cmd == "open":
            url = args[0]
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            # 새 공간은 빈 p1 을 들고 시작하므로, 늘 newPage() 하면 그 p1 이 빈 채로 남는다 (실측).
            # 빈 페이지가 있으면 그것을 쓰고 없을 때만 새로 만든다.
            body = (
                f"const base = {json.dumps(SPACE_NAME)};\n"
                f"const blank = {json.dumps(list(BLANK_URLS))};\n"
                "const spaces = await listTaskSpaces();\n"
                # 이름만으로 잡으면 사용자가 제어권을 가져간 공간에 걸려 그 뒤로 계속 거절된다
                # (실측). 그래서 에이전트가 가진 공간만 골라 다시 쓰고, 없으면 겹치지 않는
                # 이름으로 새로 만든다.
                "const mine = spaces.find((s) => s.ownership === 'agent'"
                " && (s.name === base || s.name.startsWith(base + ' #')));\n"
                "let task;\n"
                "if (mine) { task = await taskSpace(mine.id); } else {\n"
                "  const taken = new Set(spaces.map((s) => s.name));\n"
                "  let name = base;\n"
                "  for (let n = 2; taken.has(name); n += 1) name = base + ' #' + n;\n"
                "  task = await taskSpace(name);\n"
                "}\n"
                "let page = null;\n"
                "for (const p of await task.pages()) {\n"
                "  if (blank.includes(await p.url())) { page = p; break; }\n"
                "}\n"
                "if (!page) page = await task.newPage();\n"
                f"await page.goto({json.dumps(url)});\n"
                f"await page.waitForLoadState('load', {{ timeout: {timeout} }});\n"
                "__out(task.spaceId + ':' + page.label);\n"
            )
            handle = self._run(body).strip()
            if not handle:
                raise DriverError("ego 가 핸들을 내지 않았다")
            return handle

        if cmd == "nav":
            timeout = int(args[2]) if len(args) > 2 else READY_TIMEOUT_DEFAULT
            self._run(self._page(args[0])
                      + f"await page.goto({json.dumps(args[1])});\n"
                      + f"await page.waitForLoadState('load', {{ timeout: {timeout} }});\n"
                      + "__out('');\n")
            return None

        if cmd == "js":
            # 값을 JSON 으로 받아 js_value 로 넘긴다. orca 는 문자열을 따옴표 없이,
            # 객체는 여백 없는 JSON 으로 내므로 그 형식에 맞춘다.
            #
            # evaluate 는 undefined 를 null 로 바꿔 내보내 그 둘을 구분할 수 없다 (실측).
            # orca 는 undefined 에 빈 줄을, null 에 `null` 을 내므로 구분이 필요하다.
            # 그래서 표현식을 페이지 안에서 한 겹 감싸 undefined 인지를 따로 받는다.
            # await 로 감싸므로 Promise 를 내는 표현식도 그대로 값이 온다 (실측).
            wrapped = ("(async () => { const __v = await (" + args[1] + ");"
                       " return __v === undefined ? { u: true } : { u: false, v: __v }; })()")
            raw = self._run(self._page(args[0])
                            + f"const r = await page.evaluate({json.dumps(wrapped)});\n"
                            + "__out(r.u ? '' : JSON.stringify(r.v));\n")
            raw = raw.rstrip("\n")
            if not raw:
                return ""
            try:
                return js_value(json.loads(raw))
            except json.JSONDecodeError:
                return raw

        if cmd == "waitjs":
            timeout = int(args[2]) if len(args) > 2 else WAIT_TIMEOUT_DEFAULT
            # 폴링으로 대신하지 않고 ego 의 대기 API 를 쓴다. 인자 순서는 Playwright 와 같아
            # 페이지 인자가 없으면 undefined 를 먼저 넘긴다.
            self._run(self._page(args[0])
                      + f"await page.waitForFunction({json.dumps(args[1])}, undefined, "
                      + f"{{ timeout: {timeout} }});\n"
                      + "__out('');\n")
            return None

        if cmd == "ready":
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            self._run(self._page(args[0])
                      + f"await page.waitForLoadState('load', {{ timeout: {timeout} }});\n"
                      + "__out('');\n")
            return None

        if cmd == "url":
            return self._run(self._page(args[0]) + "__out(await page.url());\n").strip()

        if cmd == "snap":
            return self._run(self._page(args[0])
                             + "__out(await page.snapshot());\n").rstrip("\n")

        if cmd == "shot":
            out = args[1] if len(args) > 1 else "/tmp/ego-shot.png"
            self._run(self._page(args[0])
                      + f"await page.screenshot({{ path: {json.dumps(out)} }});\n"
                      + "__out('');\n")
            return out

        if cmd == "close":
            self._run(self._page(args[0]) + "await page.close();\n"
                      + "__out('');\n")
            return None

        raise UsageError(f"ego 백엔드가 '{cmd}' 를 다루지 않는다")
