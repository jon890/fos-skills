"""ego-browser 백엔드. 사용자가 쓰는 Chromium 의 로그인 세션을 그대로 쓴다."""

import json
import os
import sys

from ..config import READY_TIMEOUT_DEFAULT, WAIT_TIMEOUT_DEFAULT, config_value
from ..errors import DriverError, UsageError
from ..shell import js_value, run
from .base import Backend

#: TaskSpace 이름의 앞부분. 뒤에 프로필 id 를 붙여 `browser-driver/Profile 2` 로 쓴다.
#: 여러 번 open 해도 같은 프로필의 호출은 한 공간에 모이고, 프로필이 다르면 공간도 갈린다.
#: 사용자가 그 공간을 가져가면 `browser-driver/Profile 2 #2` 처럼 번호를 붙여 새로 만든다.
SPACE_PREFIX = "browser-driver"

#: 쓸 프로필을 정하는 환경변수. 프로필 id 와 이름을 모두 받는다.
#: 비어 있으면 아래 해석 순서의 다음 자리로 넘어간다.
PROFILE_ENV = "BROWSER_EGO_PROFILE"

#: 용도로 프로필을 고르는 환경변수. 설정의 `egoProfiles` 에서 키를 찾는다.
#: 프로필 id 는 머신마다 다르므로 호출자가 그것을 몰라도 되게 하는 자리다.
PURPOSE_ENV = "BROWSER_EGO_PURPOSE"

#: 용도 이름과 프로필을 잇는 설정 키. `{"work": "Profile 2", "personal": "Default"}` 모양이다.
PROFILES_KEY = "egoProfiles"

#: 용도를 고르지 않았을 때 `egoProfiles` 에서 찾는 키.
DEFAULT_PURPOSE = "default"

#: 아직 아무 곳도 열지 않은 페이지의 주소. 새 공간은 p1 을 이 상태로 들고 시작한다 (실측).
#: open 은 이 주소를 `task.tabs()` 가 실어 주는 url 필드로 본다.
BLANK_URLS = ("about:blank", "chrome://new-tab-page/")

#: 반환값을 다른 출력과 나누는 표식. ego 는 업데이트 알림 같은 줄을 같은 stdout 에 섞는다.
MARKER = "<<<browser-driver-result>>>"


def resolve_profile():
    """쓸 프로필과 그것을 정한 자리를 함께 돌려준다.

    `(프로필, 출처)` 둘을 낸다. 넷을 이 순서로 본다.

    1. `BROWSER_EGO_PROFILE` — 프로필 id 나 이름을 직접 준다
    2. `BROWSER_EGO_PURPOSE` — 설정의 `egoProfiles` 에서 그 키를 찾는다
    3. 설정의 `egoProfiles.default`
    4. 셋 다 없으면 `("", None)`. 이 경우에만 ego 의 `isDefault` 로 떨어진다

    출처가 None 이라는 것은 호출자가 프로필을 정하지 않았다는 뜻이다. 부르는 쪽이
    그때만 경고를 낸다. 이 머신의 `isDefault` 는 회사 계정이라, 정하지 않은 호출이
    개인 작업까지 회사 프로필에서 돌게 된다 (실측).
    """
    direct = os.environ.get(PROFILE_ENV)
    if direct:
        return direct, f"{PROFILE_ENV}={direct}"

    table = config_value(PROFILES_KEY) or {}
    if not isinstance(table, dict):
        raise UsageError(f"설정의 {PROFILES_KEY} 는 용도와 프로필을 잇는 객체여야 한다")

    purpose = os.environ.get(PURPOSE_ENV)
    if purpose:
        value = table.get(purpose)
        if not value:
            known = ", ".join(sorted(table)) or "(설정에 egoProfiles 가 없다)"
            raise UsageError(
                f"{PURPOSE_ENV}={purpose} 에 해당하는 프로필이 설정에 없다. "
                f"쓸 수 있는 용도: {known}")
        return value, f"{PURPOSE_ENV}={purpose} → {PROFILES_KEY}.{purpose}"

    fallback = table.get(DEFAULT_PURPOSE)
    if fallback:
        return fallback, f"{PROFILES_KEY}.{DEFAULT_PURPOSE}"

    return "", None


class EgoBackend(Backend):
    """ego-browser CLI.

    호출마다 Node 프로세스가 새로 뜨고 스크립트의 변수는 남지 않는다. TaskSpace 와
    page label 은 남으므로 그 둘을 `<spaceId>:<pageLabel>` 핸들로 쓴다 (실측).
    실패하면 종료 코드 1 과 오류 메시지를 낸다. orca 나 agent-browser 와 달리
    종료 코드로 실패를 알린다 (실측).
    콘솔 로그와 페이지 오류는 대응 API 가 없어 console 과 errors 를 다루지 않는다.
    `page.events()` 는 버퍼를 비우는 프로토콜 이벤트 배열이라 성격이 다르다.

    로그인 세션의 경계는 TaskSpace 가 아니라 브라우저 프로필이다. 같은 프로필의 다른
    공간에서 쿠키와 localStorage 가 그대로 보이고, 다른 프로필에서는 보이지 않는다 (실측).
    사용자가 손으로 열어 둔 탭도 같은 프로필의 쿠키 저장소를 함께 쓴다.
    그래서 개인 작업과 회사 자동화를 나누는 수단은 프로필이고, `BROWSER_EGO_PROFILE` 이
    그것을 정한다.
    """

    name = "ego"
    binary = "ego-browser"
    supported = {"open", "nav", "js", "waitjs", "ready", "url", "snap",
                 "shot", "close", "pages", "reset"}

    def prepare_note(self):
        head = ("사용자가 로그인해 둔 세션을 그대로 쓴다 (실측). 로그인 세션은 프로필 단위로 "
                f"갈리므로 개인 작업과 회사 자동화를 나눌 때 {PROFILE_ENV} 이나 {PURPOSE_ENV} 로 "
                "프로필을 정한다. 탭은 프로필마다 다른 TaskSpace 에 모이고, 사용자가 그 공간의 "
                "제어권을 가져가면 다음 open 이 번호를 붙여 새로 만든다")
        # 돌리기 전에 어디로 갈지 보이게 한다. 설정과 환경변수를 둘 다 보므로
        # 사람이 머릿속에서 순서를 되짚지 않아도 된다.
        try:
            want, source = resolve_profile()
        except UsageError as e:
            return head + f"\n프로필 해석: 정하지 못했다. {e}"
        if source:
            return head + f"\n프로필 해석: {want} ({source})"
        return head + ("\n프로필 해석: 정해진 것이 없어 ego 의 기본 프로필로 돈다. "
                       f"{PROFILE_ENV} 이나 {PURPOSE_ENV} 로 정하거나 설정에 "
                       f"{PROFILES_KEY}.{DEFAULT_PURPOSE} 를 둔다")

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
            # page 수 한도는 살아 있는 page 수로 센다. 닫으면 회복된다 (실측).
            # 닫지 않으면 open 이 계속 막히므로 회복 방법을 첫 줄에 적는다.
            if "PageBudget" in str(e):
                raise DriverError(
                    "이 공간의 page 수가 한도에 찼다. pages 로 무엇이 열려 있는지 보고 "
                    "close 로 골라 닫거나, reset 으로 에이전트가 연 page 를 한 번에 닫는다.\n"
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

    def _space_js(self, want, create):
        """프로필을 고르고 그 프로필의 browser-driver 공간을 잡는 스크립트 앞부분을 만든다.

        끝나면 `prof` 와 `task` 가 정의돼 있다. `create` 가 거짓이면 공간이 없을 때
        `task` 가 null 로 남는다. 조회와 정리는 공간을 만들 이유가 없기 때문이다.
        """
        make = (
            "if (!task) {\n"
            "  const taken = new Set(spaces.map((s) => s.name));\n"
            "  let name = base;\n"
            "  for (let n = 2; taken.has(name); n += 1) name = base + ' #' + n;\n"
            "  task = await taskSpace(name, { profileId: prof.id });\n"
            "}\n"
        ) if create else ""
        return (
            f"const prefix = {json.dumps(SPACE_PREFIX)};\n"
            f"const want = {json.dumps(want)};\n"
            # 프로필 id 는 이름과 엇갈려 있다. ego 의 'Default' 가 개인 계정이고
            # 'Profile 2' 가 회사 계정인 경우를 실측했다. 그래서 id 와 이름을 모두 받는다.
            "const list = await profiles();\n"
            "let prof;\n"
            "if (want) {\n"
            "  prof = list.find((p) => p.id === want) || list.find((p) => p.name === want);\n"
            "  if (!prof) throw new Error('프로필을 찾지 못했다: ' + want + '. 쓸 수 있는 것: '\n"
            "    + list.map((p) => p.id + ' (' + p.name + ')').join(', '));\n"
            "} else {\n"
            "  prof = list.find((p) => p.isDefault) || list[0];\n"
            "}\n"
            "const base = prefix + '/' + prof.id;\n"
            "const spaces = await listTaskSpaces();\n"
            # 이름만으로 잡으면 사용자가 제어권을 가져간 공간에 걸려 그 뒤로 계속 거절된다
            # (실측). 그래서 에이전트가 가진 공간만 골라 다시 쓰고, 없으면 겹치지 않는
            # 이름으로 새로 만든다.
            #
            # profileId 는 런타임이 알릴 때만 실린다. 실리지 않아도 이름에 프로필 id 가
            # 들어 있어 공간은 프로필별로 갈린다. 그래서 실렸을 때만 대조한다.
            "const mine = spaces.find((s) => s.ownership === 'agent'\n"
            "  && (!s.profileId || s.profileId === prof.id)\n"
            "  && (s.name === base || s.name.startsWith(base + ' #')));\n"
            "let task = mine ? await taskSpace(mine.id) : null;\n"
            + make
        )

    def _want(self, args):
        """명령이 받은 프로필 인자를 해석 순서보다 앞에 둔다."""
        return (args[0] if args else "") or resolve_profile()[0]

    def dispatch(self, cmd, args):
        if cmd == "open":
            url = args[0]
            timeout = int(args[1]) if len(args) > 1 else READY_TIMEOUT_DEFAULT
            # 새 공간은 빈 p1 을 들고 시작하므로, 늘 newPage() 하면 그 p1 이 빈 채로 남는다 (실측).
            # 빈 페이지가 있으면 그것을 쓰고 없을 때만 새로 만든다.
            want, source = resolve_profile()
            body = (
                self._space_js(want, create=True)
                + f"const blank = {json.dumps(list(BLANK_URLS))};\n"
                # p.url() 은 page.evaluate 를 거치므로 멈춘 page 에서 15초 뒤 던지고,
                # 그 예외가 open 전체를 끝낸다 (실측). tabs() 는 url 을 필드로 실어 주므로
                # evaluate 를 거치지 않는다. 빈 page 재사용은 편의이므로, 훑기가 실패하면
                # 새로 만든다.
                "let page = null;\n"
                "try {\n"
                "  for (const t of await task.tabs()) {\n"
                "    if (t.label && blank.includes(t.url)) { page = task.page(t.label); break; }\n"
                "  }\n"
                "} catch (e) { page = null; }\n"
                "if (!page) page = await task.newPage();\n"
                f"await page.goto({json.dumps(url)});\n"
                f"await page.waitForLoadState('load', {{ timeout: {timeout} }});\n"
                "__out(task.spaceId + ':' + page.label + '\\t' + prof.id + '\\t' + prof.name);\n"
            )
            handle, _, profile = self._run(body).strip().partition("\t")
            if not handle:
                raise DriverError("ego 가 핸들을 내지 않았다")
            # 어느 프로필에서 열렸는지 알린다. 정한 호출과 정하지 않은 호출의 문구를 갈라,
            # 지정을 빠뜨린 것이 출력 목록에서 눈에 띄게 한다.
            prof_id, _, prof_name = profile.partition("\t")
            if prof_id and source:
                print(f"프로필: {prof_id} ({prof_name}) — {source}", file=sys.stderr)
            elif prof_id:
                print(f"경고: 프로필을 정하지 않아 ego 의 기본 프로필로 돈다 "
                      f"({prof_id} / {prof_name})", file=sys.stderr)
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

        if cmd == "pages":
            # 핸들은 open 만 냈다. budget 이 차면 open 이 막히므로 그때 닫을 것을
            # 고를 길이 없었다. 여기서 같은 형식의 핸들을 내 close, nav, js 에 그대로 쓴다.
            # url 은 tabs() 가 필드로 실어 주므로 멈춘 page 도 걸리지 않는다.
            # openedBy 를 함께 내, reset 이 무엇을 닫을지 실행 전에 이 목록으로 본다.
            out = self._run(
                self._space_js(self._want(args), create=False)
                + "const out = [];\n"
                "if (task) for (const t of await task.tabs()) {\n"
                "  if (!t.label) continue;\n"
                "  out.push(task.spaceId + ':' + t.label + '\\t' + (t.openedBy || 'unknown')\n"
                "    + '\\t' + (t.url || ''));\n"
                "}\n"
                "__out(out.join('\\n'));\n"
            ).rstrip("\n")
            return out or None

        if cmd == "reset":
            # 사용자가 연 page 는 남긴다. ego 의 API 문서가 openedBy 가 'unknown' 인 것도
            # 사용자 소유로 다루라고 정하고 있으므로 'agent' 인 것만 고른다.
            # 공간째 닫지 않는 것도 같은 이유다. 사용자가 보던 것까지 사라진다.
            out = self._run(
                self._space_js(self._want(args), create=False)
                + "const out = [];\n"
                "if (task) for (const t of await task.tabs()) {\n"
                "  if (!t.label || t.openedBy !== 'agent') continue;\n"
                "  const h = task.spaceId + ':' + t.label + '\\t' + (t.url || '');\n"
                "  try { await task.page(t.label).close(); out.push(h); }\n"
                "  catch (e) { out.push(h + '\\t닫지 못했다: ' + String(e).split('\\n')[0]); }\n"
                "}\n"
                "__out(out.join('\\n'));\n"
            ).rstrip("\n")
            return out or None

        raise UsageError(f"ego 백엔드가 '{cmd}' 를 다루지 않는다")
