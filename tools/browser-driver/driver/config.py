"""설정 파일과 기본 제한 시간."""

import json
import os
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path

from .errors import UsageError

READY_TIMEOUT_DEFAULT = 30000
WAIT_TIMEOUT_DEFAULT = 10000
WAIT_INTERVAL = 150


LEGACY_CONFIG = Path.home() / ".claude" / "browser.config.json"


def claude_config_dir(env, home=None):
    if env.get("CLAUDE_CONFIG_DIR"):
        return Path(env["CLAUDE_CONFIG_DIR"]).expanduser().resolve()
    return (Path.home() if home is None else Path(home)) / ".claude"


def plugin_data_dir(module_file, env=None, home=None):
    """본체가 플러그인 설치 캐시 안에 있으면 그 플러그인의 데이터 폴더를 낸다. 아니면 None.

    <루트>/plugins/cache/<마켓플레이스>/<플러그인>/<버전>/tools/browser-driver/driver/config.py
    꼴일 때만 데이터 폴더를 돌려준다. 어느 도구의 설치본인지는 <루트>/config.toml 로 가른다.
      - config.toml 이 파일이면 Codex 설치본이다. Codex 에는 데이터 폴더가 없어서
        두 도구를 함께 쓰는 사람의 설정이 하나가 되도록 Claude 설정 폴더의 것을 쓴다.
        <Claude 설정 폴더>/plugins/data/<플러그인>-<마켓플레이스>/
        Claude 설정 폴더는 환경변수 CLAUDE_CONFIG_DIR 가 비어 있지 않으면 그 값, 아니면 ~/.claude 다.
      - 없으면 Claude Code 설치본이다. <루트>/plugins/data/<플러그인>-<마켓플레이스>/
    이름 규칙은 Claude Code 2.1.286 과 Codex 0.159.3 에서 실측했다.
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
        root = claude_config_dir(env, home)
    return root / "plugins" / "data" / f"{plugin}-{marketplace}"


@dataclass(frozen=True)
class ConfigResolution:
    path: Path
    reason: str
    searched: tuple
    legacy: Path
    warning: str = ""


def resolve_config(env=None, module_file=__file__, legacy=None, home=None):
    """설정 경로와 판정 근거를 함께 낸다. 파일이 없어도 경로는 낸다.

    BROWSER_CONFIG, 캐시의 해당 플러그인 데이터, 캐시 밖의 단일 후보, 옛 위치 순이다.
    캐시 밖에서는 Claude 설정 폴더의 plugins/data/*/browser.config.json 을 찾는다.
    후보가 여럿이면 고르지 않고 경고와 함께 옛 위치로 돌아간다.
    읽기만 한다. 폴더를 만들거나 파일을 옮기지 않는다.
    """
    env = os.environ if env is None else env
    if legacy is None:
        legacy = LEGACY_CONFIG if home is None else Path(home) / ".claude/browser.config.json"
    legacy = Path(legacy)
    if env.get("BROWSER_CONFIG"):
        path = Path(env["BROWSER_CONFIG"])
        return ConfigResolution(path, "환경변수 BROWSER_CONFIG", (path,), legacy)
    searched = []
    warning = ""
    data = plugin_data_dir(module_file, env, home)
    if data is not None:
        path = data / "browser.config.json"
        searched.append(path)
        if path.is_file():
            return ConfigResolution(path, "설치 캐시의 해당 플러그인 데이터 폴더", tuple(searched), legacy)
        reason = "해당 플러그인 데이터 폴더에 설정이 없어 옛 위치 사용"
    else:
        data_root = claude_config_dir(env, home) / "plugins/data"
        searched.append(data_root / "*/browser.config.json")
        candidates = sorted(p for p in data_root.glob("*/browser.config.json") if p.is_file())
        searched.extend(candidates)
        if len(candidates) == 1:
            return ConfigResolution(candidates[0], "설치 캐시 밖에서 플러그인 데이터 설정 후보가 하나", tuple(searched), legacy)
        if candidates:
            reason = "설치 캐시 밖에서 플러그인 데이터 설정 후보가 여러 개여서 옛 위치 사용"
            warning = (f"경고: {reason}: {legacy}\n후보 목록:\n"
                       + "\n".join(f"  {p}" for p in candidates)
                       + "\n쓸 파일을 BROWSER_CONFIG 로 지정한다.")
        else:
            reason = "설치 캐시 밖에서 플러그인 데이터 설정 후보가 없어 옛 위치 사용"
    searched.append(legacy)
    return ConfigResolution(legacy, reason, tuple(searched), legacy, warning)


def resolve_config_path(env=None, module_file=__file__, legacy=None, home=None):
    """경로만 돌려준다. 여러 후보에 대한 경고는 stdout 대신 stderr 로 낸다."""
    result = resolve_config(env, module_file, legacy, home)
    if result.warning:
        print(result.warning, file=sys.stderr)
    return result.path


CONFIG_RESOLUTION = resolve_config()
CONFIG_PATH = CONFIG_RESOLUTION.path
if CONFIG_RESOLUTION.warning:
    print(CONFIG_RESOLUTION.warning, file=sys.stderr)


def profile_config_guidance():
    """용도별 프로필 설정이 없을 때 실제 탐색 경로와 복구 명령을 안내한다."""
    paths = "\n".join(f"  {p}" for p in CONFIG_RESOLUTION.searched)
    legacy = shlex.quote(str(CONFIG_RESOLUTION.legacy))
    return (f"\n설정 파일: {CONFIG_PATH}\n설정 판정: {CONFIG_RESOLUTION.reason}"
            f"\n찾아본 경로:\n{paths}"
            "\negoProfiles 가 있는 설정 파일을 BROWSER_CONFIG 로 지정한다."
            '\n  export BROWSER_CONFIG="/실제/설정/browser.config.json"'
            f'\n옛 위치가 없으면 지정한 파일에 링크를 건다:\n  ln -s "$BROWSER_CONFIG" {legacy}')


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
