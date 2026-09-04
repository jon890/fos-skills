"""백엔드 목록과 선택 규칙."""

import os

from ..config import CONFIG_PATH, config_value
from ..errors import UsageError

from .agent_browser import AgentBrowserBackend
from .base import Backend  # noqa: F401  새 백엔드를 만드는 쪽이 여기서 가져간다
from .cmux import CmuxBackend
from .orca import OrcaBackend

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
