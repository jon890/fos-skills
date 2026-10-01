"""설정 파일과 기본 제한 시간."""

import json
import os
from pathlib import Path

from .errors import UsageError

READY_TIMEOUT_DEFAULT = 30000
WAIT_TIMEOUT_DEFAULT = 10000
WAIT_INTERVAL = 150


LEGACY_CONFIG = Path.home() / ".claude" / "browser.config.json"


def plugin_data_dir(module_file, env=None, home=None):
    """본체가 플러그인 설치 캐시 안에 있으면 그 플러그인의 데이터 폴더를 낸다. 아니면 None.

    <루트>/plugins/cache/<마켓플레이스>/<플러그인>/<버전>/tools/browser-driver/driver/config.py
    꼴일 때만 데이터 폴더를 돌려준다. 어느 도구의 설치본인지는 <루트>/config.toml 로 가른다.
      - config.toml 이 파일이면 Codex 설치본이다. Codex 에는 데이터 폴더가 없어서
        두 도구를 함께 쓰는 사람의 설정이 하나가 되도록 Claude 설정 폴더의 것을 쓴다.
        <Claude 설정 폴더>/plugins/data/<플러그인>-<마켓플레이스>/
        Claude 설정 폴더는 환경변수 CLAUDE_CONFIG_DIR 가 비어 있지 않으면 그 값, 아니면 ~/.claude 다.
      - 없으면 Claude Code 설치본이다. <루트>/plugins/data/<플러그인>-<마켓플레이스>/
    이름 규칙은 Claude Code 2.1.286 과 Codex 0.159.3 에서 실측했다 (2026-10-02).
    저장소 체크아웃이나 ~/.claude/scripts/ 링크는 이 꼴이 아니므로 resolve() 로 실체 경로를 본다.
    읽기만 한다. env 와 home 은 시험이 바꿀 수 있게 열어 둔 인자다.
    """
    parts = Path(module_file).resolve().parts
    # ..., plugins, cache, <마켓플레이스>, <플러그인>, <버전>, tools, browser-driver, driver, config.py
    if len(parts) < 10 or parts[-4:-1] != ("tools", "browser-driver", "driver"):
        return None
    plugin, marketplace = parts[-6], parts[-7]
    if parts[-8] != "cache" or parts[-9] != "plugins":
        return None
    root = Path(*parts[:-9])
    if (root / "config.toml").is_file():
        env = os.environ if env is None else env
        if env.get("CLAUDE_CONFIG_DIR"):
            root = Path(env["CLAUDE_CONFIG_DIR"]).expanduser().resolve()
        else:
            root = (Path.home() if home is None else Path(home)) / ".claude"
    return root / "plugins" / "data" / f"{plugin}-{marketplace}"


def resolve_config_path(env=None, module_file=__file__, legacy=None, home=None):
    """설정 파일 경로를 정한다. 파일이 없어도 경로는 낸다.

    순서는 셋이다.
      1. 환경변수 BROWSER_CONFIG
      2. 플러그인 데이터 폴더의 browser.config.json. 그 파일이 있을 때만 쓴다.
         플러그인은 설정을 데이터 폴더에 두는데, 거기에 아직 파일이 없는 사람은 옛 위치를 쓰고 있어서다.
      3. 옛 위치 ~/.claude/browser.config.json
    읽기만 한다. 폴더를 만들거나 파일을 옮기지 않는다.
    """
    env = os.environ if env is None else env
    if env.get("BROWSER_CONFIG"):
        return Path(env["BROWSER_CONFIG"])
    data = plugin_data_dir(module_file, env, home)
    if data is not None and (data / "browser.config.json").is_file():
        return data / "browser.config.json"
    return LEGACY_CONFIG if legacy is None else Path(legacy)


CONFIG_PATH = resolve_config_path()


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
