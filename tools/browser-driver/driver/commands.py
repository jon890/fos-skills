"""명령 스펙과 도움말. `help` 출력이 명령 목록의 단일 소스다."""

from .config import WAIT_TIMEOUT_DEFAULT

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
