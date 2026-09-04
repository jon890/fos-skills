"""설정 파일과 기본 제한 시간."""

import json
import os
from pathlib import Path

from .errors import UsageError

READY_TIMEOUT_DEFAULT = 30000
WAIT_TIMEOUT_DEFAULT = 10000
WAIT_INTERVAL = 150


CONFIG_PATH = Path(os.environ.get("BROWSER_CONFIG", Path.home() / ".claude" / "browser.config.json"))


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
